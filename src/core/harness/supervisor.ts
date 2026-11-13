import { spawn } from 'node:child_process';
import {
  appendFileSync, copyFileSync, existsSync, lstatSync, mkdirSync, readlinkSync, renameSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { dirname, join, resolve as resolvePath } from 'node:path';
import { createInterface } from 'node:readline';
import type { BifConfig } from '../config/schema.js';
import { AbortError, type EventBus } from '../events.js';
import type { Store } from '../store/db.js';
import { newId } from '../store/repos.js';
import type { AgentRun, AgentRunAttempt, Role, TaskType } from '../types.js';
import { recordUsage, resolveRunScope } from '../metrics/usage.js';
import { recordRunPrompt } from '../prompts/store.js';
import { usageRepos } from '../store/usageRepos.js';
import { enforceBudget } from './budget.js';
import { isRateLimitText, type FakeScript, type RunEvent, type ToolClient } from './adapter.js';
import { getAdapter } from './adapters/index.js';
import { browserServersFor, effectiveMaxBrowserRuns, SharedBrowser } from './browser.js';
import { runCwdOf, runDirOf } from './paths.js';
import { priorAttemptSection } from './priorAttempt.js';
import { processStartTime } from './procinfo.js';
import { Semaphore } from './semaphore.js';
import type { RunContext, TokenRegistry } from './tokens.js';
import type { HandleTool } from './tools/handlers.js';
import type { ToolName } from './tools/registry.js';

/** Roles that count against `limits.maxParallelWorkers`. */
const LIMITED_ROLES: ReadonlySet<Role> = new Set(['worker', 'reviewer', 'persona', 'synthesizer']);

export type Backoff = { baseMs: number; maxMs: number; maxAttempts: number };
/** Global Constraints: base 30 s, max 15 min, max 6 attempts. */
export const DEFAULT_BACKOFF: Backoff = { baseMs: 30_000, maxMs: 15 * 60_000, maxAttempts: 6 };

export type SupervisorDeps = {
  store: Store;
  config: BifConfig;
  tokens: TokenRegistry;
  events: EventBus;
  /** Base URL of the API server; runs get `<mcpBaseUrl>/mcp/<token>`. */
  mcpBaseUrl: string;
  dataDir: string;
  /** Tool dispatcher, required for `fake` runs. */
  handle?: HandleTool;
  backoff?: Backoff;
  /** Delay between SIGTERM and SIGKILL. Default 5000 ms. */
  killGraceMs?: number;
  /** Shared browser server (`browser.mode: 'shared'`); default: one owned by this supervisor. */
  browser?: SharedBrowser;
};

export type RunOptions = {
  ctx: Omit<RunContext, 'agentRunId'>;
  prompt: string;
  systemPrompt: string;
  needsBrowser: boolean;
  /** Run in-process with this script instead of spawning the provider CLI. */
  fake?: FakeScript;
  /**
   * Aborting kills a started run (status `failed`). If it aborts before the run starts (e.g.
   * while queued on a semaphore), the run never starts and `run()` rejects with `AbortError`.
   */
  signal?: AbortSignal;
  /**
   * Learning loop WP-B: what the run is for, recorded on the AgentRun (`round`, `taskType`) and used
   * to attribute usage to a research run / pipeline (`researchRunId`, else the task's research run).
   */
  meta?: RunMeta;
};

/** Learning loop WP-B: run metadata (see `RunOptions.meta`). */
export type RunMeta = { round?: number; taskType?: TaskType; researchRunId?: string };

export type RunOutcome = {
  agentRunId: string;
  exitCode: number;
  events: RunEvent[];
  status: AgentRun['status'];
  /** Why the run failed (idle timeout, aborted, spawn error, ...). */
  reason?: string;
  /** Attempts made (> 1 after rate-limit retries). */
  attempts: number;
};

/** Thrown by a fake run's `ToolClient.call` when the tool returns an error result. */
export class ToolCallError extends Error {
  constructor(readonly tool: string, message: string) {
    super(message);
    this.name = 'ToolCallError';
  }
}

type AttemptResult = { exitCode: number; rateLimited: boolean; reason?: string };

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(done, ms);
    function done() {
      clearTimeout(t);
      signal?.removeEventListener('abort', done);
      resolve();
    }
    signal?.addEventListener('abort', done, { once: true });
  });

/**
 * Runs agents: one CLI subprocess (or in-process fake script) per run, with concurrency limits,
 * an idle watchdog, rate-limit back-off, and every normalized event persisted to
 * `<dataDir>/<ws>/runs/<agentRunId>/events.jsonl` and emitted as a `run_event`.
 * Raw stdout/stderr are kept beside it (`stdout.log`, `stderr.log`).
 *
 * `run()` never throws for agent failures; it resolves with `status: 'failed'`.
 */
export class Supervisor {
  private readonly workers: Semaphore;
  private readonly browsers: Semaphore | null;
  private readonly backoff: Backoff;
  private readonly killGraceMs: number;
  /** `deps.dataDir` made absolute: CLIs run in their own cwd, so every path we hand them must be absolute. */
  private readonly dataDir: string;
  /** The shared browser MCP server browser-using runs connect to (started on first use). */
  readonly browser: SharedBrowser;

  constructor(private readonly deps: SupervisorDeps) {
    this.dataDir = resolvePath(deps.dataDir);
    this.workers = new Semaphore(deps.config.limits.maxParallelWorkers);
    this.browser = deps.browser ?? new SharedBrowser({ config: deps.config, dataDir: this.dataDir });
    const maxBrowser = effectiveMaxBrowserRuns(deps.config);
    this.browsers = maxBrowser > 0 ? new Semaphore(maxBrowser) : null;
    this.backoff = deps.backoff ?? DEFAULT_BACKOFF;
    this.killGraceMs = deps.killGraceMs ?? 5000;
  }

  /** Stops the shared browser server, if one was started. */
  async close(): Promise<void> {
    await this.browser.close();
  }

  /**
   * Runs one agent. Resolves (never rejects) once a run has started, with `failed` on any error.
   * Rejects only before start: `AbortError` when cancelled while queued, or a config error.
   */
  async run(opts: RunOptions): Promise<RunOutcome> {
    if (opts.needsBrowser && !this.browsers) {
      throw new Error('this run needs a browser but limits.maxBrowserRuns is 0');
    }
    // Learning loop WP-B: no new run past a configured budget cap (waits for the user to extend).
    const { pipelineId } = this.scopeOf(opts);
    await enforceBudget(this.deps, pipelineId ? { workspaceId: opts.ctx.workspaceId, pipelineId } : { workspaceId: opts.ctx.workspaceId }, opts.signal);
    const releases: Array<() => void> = [];
    try {
      if (LIMITED_ROLES.has(opts.ctx.role)) releases.push(await this.workers.acquire(opts.signal));
      if (opts.needsBrowser) releases.push(await this.browsers!.acquire(opts.signal));
      if (opts.signal?.aborted) throw new AbortError('run cancelled before start');
      return await this.execute(opts);
    } finally {
      for (const r of releases.reverse()) r();
    }
  }

  private async execute(opts: RunOptions): Promise<RunOutcome> {
    const { store, events, tokens } = this.deps;
    const dataDir = this.dataDir;
    const ctx: RunContext = { ...opts.ctx, agentRunId: newId('arun') };
    const token = tokens.issue(ctx);
    const all: RunEvent[] = [];
    let attempt = 0;
    try {
      return await this.executeIssued(ctx, token, opts, all, (n) => (attempt = n));
    } catch (err) {
      // Never leave a zombie run: record the failure and close the run out.
      const message = `supervisor error: ${(err as Error).message}`;
      const closing: RunEvent[] = [
        { t: 'error', message, rateLimited: false },
        { t: 'done', exitCode: 1 },
      ];
      for (const e of closing) {
        all.push(e);
        try {
          const path = join(runDirOf(dataDir, ctx.workspaceId, ctx.agentRunId), 'events.jsonl');
          mkdirSync(dirname(path), { recursive: true });
          appendFileSync(path, JSON.stringify(e) + '\n');
        } catch {
          // best effort
        }
        const bus: Parameters<EventBus['emit']>[0] = {
          type: 'run_event', workspaceId: ctx.workspaceId, agentRunId: ctx.agentRunId, event: e,
        };
        if (ctx.taskId !== undefined) bus.taskId = ctx.taskId;
        events.emit(bus);
      }
      tokens.revoke(token);
      try {
        store.agentRuns.update(ctx.agentRunId, {
          status: 'failed', exitCode: 1, endedAt: new Date().toISOString(), attempts: Math.max(attempt, 1), failureReason: message,
        });
      } catch {
        // store unavailable; the bus event below still reports the failure
      }
      this.emitStatus(ctx, 'failed', 1, message);
      return { agentRunId: ctx.agentRunId, exitCode: 1, events: all, status: 'failed', reason: message, attempts: Math.max(attempt, 1) };
    }
  }

  private async executeIssued(
    ctx: RunContext,
    token: string,
    opts: RunOptions,
    all: RunEvent[],
    setAttempt: (n: number) => void,
  ): Promise<RunOutcome> {
    const { store, events, tokens } = this.deps;
    const dataDir = this.dataDir;
    const runDir = runDirOf(dataDir, ctx.workspaceId, ctx.agentRunId);
    const cwd = runCwdOf(dataDir, ctx.workspaceId, ctx.agentRunId);
    mkdirSync(cwd, { recursive: true });
    const eventsPath = join(runDir, 'events.jsonl');
    writeFileSync(eventsPath, '');
    // Learning loop WP-B: run metadata, prompt store, prompt.md, usage attribution.
    const meta = opts.meta ?? {};
    const runPatch: Partial<AgentRun> = {};
    if (meta.round !== undefined) runPatch.round = meta.round;
    if (meta.taskType !== undefined) runPatch.taskType = meta.taskType;
    if (Object.keys(runPatch).length) store.agentRuns.update(ctx.agentRunId, runPatch);
    recordRunPrompt(store, ctx.role, ctx.promptVersion, opts.systemPrompt);
    writeFileSync(join(runDir, 'prompt.md'), promptMarkdown(ctx, opts.systemPrompt, opts.prompt, 1));
    const scope = this.scopeOf(opts);
    const usageRun = { ...ctx, ...scope };
    let attempt = 0;

    const record = (e: RunEvent) => {
      all.push(e);
      appendFileSync(eventsPath, JSON.stringify(e) + '\n');
      if (e.t === 'usage') {
        try {
          recordUsage(store, usageRun, Math.max(attempt, 1), e);
        } catch (err) {
          console.warn(`[bif] could not record usage of run ${ctx.agentRunId}: ${(err as Error).message}`);
        }
      }
      const bus: Parameters<EventBus['emit']>[0] = {
        type: 'run_event',
        workspaceId: ctx.workspaceId,
        agentRunId: ctx.agentRunId,
        event: e,
      };
      if (ctx.taskId !== undefined) bus.taskId = ctx.taskId;
      events.emit(bus);
    };
    this.emitStatus(ctx, 'running');

    let result: AttemptResult;
    for (;;) {
      attempt++;
      setAttempt(attempt);
      const attemptStarted = new Date().toISOString();
      const eventsBefore = all.length;
      // A rate-limit retry restarts the agent on the same run: tell it what the run already did.
      const prior = attempt > 1 ? priorAttemptSection(store, ctx.agentRunId) : '';
      const prompt = prior ? `${opts.prompt}\n\n${prior}` : opts.prompt;
      if (attempt > 1) writeFileSync(join(runDir, `prompt.attempt${attempt}.md`), promptMarkdown(ctx, opts.systemPrompt, prompt, attempt));
      result = opts.fake
        ? await this.attemptFake(ctx, opts, record)
        : await this.attemptCli(ctx, token, cwd, runDir, { ...opts, prompt }, record);
      const attemptRow: AgentRunAttempt = {
        id: newId('att'), workspaceId: ctx.workspaceId, runId: ctx.agentRunId, attempt, startedAt: attemptStarted,
        endedAt: new Date().toISOString(), exitCode: result.exitCode, rateLimited: result.rateLimited,
      };
      const attemptFailure = result.exitCode === 0 ? undefined : failureOf(result, all.slice(eventsBefore));
      if (attemptFailure !== undefined) attemptRow.failureReason = attemptFailure;
      const recordAttempt = (backoffMs?: number) => {
        if (backoffMs !== undefined) attemptRow.backoffMs = backoffMs;
        try {
          usageRepos(store).agentRunAttempts.insert(attemptRow);
        } catch (err) {
          console.warn(`[bif] could not record attempt of run ${ctx.agentRunId}: ${(err as Error).message}`);
        }
      };
      // Runs killed by the watchdog or an abort (result.reason set) are never retried.
      if (!result.rateLimited || result.exitCode === 0 || result.reason || opts.signal?.aborted) {
        recordAttempt();
        break;
      }
      if (attempt >= this.backoff.maxAttempts) {
        result.reason = `rate limited; gave up after ${attempt} attempts`;
        recordAttempt();
        break;
      }
      const delay = Math.min(this.backoff.baseMs * 2 ** (attempt - 1), this.backoff.maxMs);
      recordAttempt(delay);
      await sleep(delay, opts.signal);
      if (opts.signal?.aborted) break;
    }

    const status: AgentRun['status'] = result.exitCode === 0 ? 'done' : 'failed';
    tokens.revoke(token);
    const endPatch: Partial<AgentRun> = { status, exitCode: result.exitCode, endedAt: new Date().toISOString(), attempts: attempt };
    if (status === 'failed') endPatch.failureReason = failureOf(result, all);
    store.agentRuns.update(ctx.agentRunId, endPatch);
    this.emitStatus(ctx, status, result.exitCode, result.reason);
    const outcome: RunOutcome = { agentRunId: ctx.agentRunId, exitCode: result.exitCode, events: all, status, attempts: attempt };
    if (result.reason !== undefined) outcome.reason = result.reason;
    return outcome;
  }

  /** Learning loop WP-B: research run / pipeline a run counts against (usage rows, budgets). */
  private scopeOf(opts: RunOptions): { researchRunId?: string; pipelineId?: string } {
    const c = opts.ctx;
    const input: Parameters<typeof resolveRunScope>[1] = { workspaceId: c.workspaceId, role: c.role };
    if (c.taskId !== undefined) input.taskId = c.taskId;
    if (opts.meta?.researchRunId !== undefined) input.researchRunId = opts.meta.researchRunId;
    try {
      return resolveRunScope(this.deps.store, input);
    } catch {
      return {};
    }
  }

  private emitStatus(ctx: RunContext, status: AgentRun['status'], exitCode?: number, reason?: string) {
    const e: Parameters<EventBus['emit']>[0] = {
      type: 'run_status',
      workspaceId: ctx.workspaceId,
      agentRunId: ctx.agentRunId,
      status,
    };
    if (ctx.taskId !== undefined) e.taskId = ctx.taskId;
    if (exitCode !== undefined) e.exitCode = exitCode;
    if (reason !== undefined) e.reason = reason;
    this.deps.events.emit(e);
  }

  /**
   * Idle watchdog: fires `onIdle` after `idleTimeoutMs` without `touch()`. Paused while the run
   * has pending user requests (tracked from bus events, seeded from the store).
   */
  private watchdog(ctx: RunContext, onIdle: () => void) {
    const { events, store, config } = this.deps;
    const pending = new Set(
      store.userRequests.list({ agentRunId: ctx.agentRunId, status: 'pending' }).map((r) => r.id),
    );
    let timer: NodeJS.Timeout | undefined;
    let stopped = false;
    const arm = () => {
      if (timer) clearTimeout(timer);
      timer = undefined;
      if (stopped || pending.size > 0) return;
      timer = setTimeout(onIdle, config.limits.idleTimeoutMs);
    };
    const off = events.on((e) => {
      if (e.type === 'user_request' && e.request.agentRunId === ctx.agentRunId) {
        pending.add(e.request.id);
        arm();
      } else if (e.type === 'user_request_resolved' && pending.delete(e.request.id)) {
        arm();
      }
    });
    arm();
    return {
      touch: arm,
      stop: () => {
        stopped = true;
        if (timer) clearTimeout(timer);
        off();
      },
    };
  }

  private async attemptFake(
    ctx: RunContext,
    opts: RunOptions,
    record: (e: RunEvent) => void,
  ): Promise<AttemptResult> {
    const handle = this.deps.handle;
    if (!handle) throw new Error('Supervisor: fake runs need deps.handle');
    const ac = new AbortController();
    let finished = false;
    let reason: string | undefined;
    let interrupt: (() => void) | undefined;
    const interrupted = new Promise<void>((r) => (interrupt = r));
    const stop = (why: string) => {
      if (finished || reason) return;
      reason = why;
      ac.abort();
      interrupt?.();
    };
    const dog = this.watchdog(ctx, () => stop(`idle timeout: no activity for ${this.deps.config.limits.idleTimeoutMs} ms`));
    const onAbort = () => stop('aborted');
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    if (opts.signal?.aborted) onAbort();

    const client: ToolClient = {
      call: async (name, input) => {
        if (finished || reason) throw new ToolCallError(name, 'run is no longer active');
        dog.touch();
        record({ t: 'tool_call', name, input });
        const r = await handle(ctx, name as ToolName, input, { signal: ac.signal });
        dog.touch();
        if (!finished && !reason) record({ t: 'tool_result', name, ok: r.ok });
        if (!r.ok) throw new ToolCallError(name, r.error);
        return r.data;
      },
    };

    let exitCode = 0;
    try {
      const outcome = await Promise.race([
        opts.fake!(client).then(
          () => 'ok' as const,
          (err: unknown) => err,
        ),
        interrupted.then(() => 'interrupted' as const),
      ]);
      if (outcome === 'interrupted') {
        exitCode = 1;
        record({ t: 'error', message: reason ?? 'interrupted', rateLimited: false });
      } else if (outcome !== 'ok') {
        exitCode = 1;
        const message = outcome instanceof Error ? outcome.message : String(outcome);
        record({ t: 'error', message, rateLimited: false });
      }
    } finally {
      finished = true;
      dog.stop();
      opts.signal?.removeEventListener('abort', onAbort);
    }
    record({ t: 'done', exitCode });
    const res: AttemptResult = { exitCode, rateLimited: false };
    if (reason !== undefined) res.reason = reason;
    return res;
  }

  private async attemptCli(
    ctx: RunContext,
    token: string,
    cwd: string,
    runDir: string,
    opts: RunOptions,
    record: (e: RunEvent) => void,
  ): Promise<AttemptResult> {
    const { config, mcpBaseUrl } = this.deps;
    const provider = ctx.model.provider;
    const adapter = getAdapter(provider, config.providers[provider].command);
    const base = mcpBaseUrl.replace(/\/+$/, '');
    const spec = {
      prompt: opts.prompt,
      systemPrompt: opts.systemPrompt,
      model: ctx.model.model,
      mcpUrl: `${base}/mcp/${token}`,
      mcpBearer: { url: `${base}/mcp`, token },
      extraMcpServers: opts.needsBrowser ? await browserServersFor(config, this.browser) : {},
      cwd,
      stateDir: join(this.dataDir, 'cli-state'),
    };
    const built = adapter.buildCommand(spec);
    for (const f of built.files) {
      mkdirSync(dirname(f.path), { recursive: true });
      writeFileSync(f.path, f.content);
    }
    for (const l of built.links ?? []) linkFile(l.path, l.target);
    const stdoutLog = join(runDir, 'stdout.log');
    const stderrLog = join(runDir, 'stderr.log');

    return new Promise<AttemptResult>((resolve) => {
      let rateLimited = false;
      let lastDone: number | undefined;
      let reason: string | undefined;
      let settled = false;
      let killTimer: NodeJS.Timeout | undefined;

      const emit = (e: RunEvent) => {
        if (e.t === 'error' && e.rateLimited) rateLimited = true;
        if (e.t === 'done') lastDone = e.exitCode;
        record(e);
      };

      const child = spawn(built.cmd, built.args, {
        cwd,
        env: { ...process.env, ...built.env },
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
      });
      const pid = child.pid;
      if (pid !== undefined) {
        // Persisted so crash recovery (Task 9) can kill an orphaned process group.
        // Start time identifies this process later (crash recovery verifies it before SIGKILL).
        this.deps.store.agentRuns.update(ctx.agentRunId, { pid, pidStartedAt: processStartTime(pid) });
      }

      // Kill the CLI if it ignores SIGTERM; descendants are reaped after it exits (reapGroup).
      const kill = (why: string) => {
        if (reason || settled) return;
        reason = why;
        signalGroup(pid, 'SIGTERM', child);
        killTimer = setTimeout(() => signalGroup(pid, 'SIGKILL', child), this.killGraceMs);
        killTimer.unref();
      };

      const dog = this.watchdog(ctx, () => kill(`idle timeout: no output for ${config.limits.idleTimeoutMs} ms`));
      const onAbort = () => kill('aborted');
      opts.signal?.addEventListener('abort', onAbort, { once: true });
      if (opts.signal?.aborted) onAbort();

      const out = createInterface({ input: child.stdout! });
      const err = createInterface({ input: child.stderr! });

      /** Synchronous tail: closes the stream, emits the final events, resolves. Idempotent. */
      const finish = (exitCode: number) => {
        if (settled) return;
        settled = true;
        dog.stop();
        if (killTimer) clearTimeout(killTimer);
        opts.signal?.removeEventListener('abort', onAbort);
        out.close();
        err.close();
        if (reason) emit({ t: 'error', message: reason, rateLimited: false });
        // Process exit code wins when non-zero; otherwise trust the stream (OpenCode exits 0 on error).
        let code = exitCode !== 0 ? exitCode : (lastDone ?? 0);
        // A rate-limit error without a successful terminal event is a failed (retryable) attempt,
        // even when the CLI exits 0.
        if (rateLimited && lastDone !== 0 && code === 0) code = 1;
        if (reason && code === 0) code = 1;
        if (lastDone !== code) emit({ t: 'done', exitCode: code });
        const res: AttemptResult = { exitCode: code, rateLimited };
        if (reason !== undefined) res.reason = reason;
        resolve(res);
      };

      child.on('error', (e) => {
        if (exitInfo) return;
        reason ??= `spawn failed: ${e.message}`;
        finish(127);
      });

      out.on('line', (line) => {
        if (settled) return;
        dog.touch();
        appendFileSync(stdoutLog, line + '\n');
        for (const e of adapter.parseLine(line)) emit(e);
      });
      err.on('line', (line) => {
        if (settled) return;
        dog.touch();
        appendFileSync(stderrLog, line + '\n');
        // stderr is never JSON events; only scan it for rate-limit text.
        if (isRateLimitText(line)) emit({ t: 'error', message: line.slice(0, 2000), rateLimited: true });
      });

      let outClosed = false;
      let onOutClosed: (() => void) | undefined;
      out.on('close', () => {
        outClosed = true;
        onOutClosed?.();
      });

      let exitInfo: { code: number | null; signal: NodeJS.Signals | null } | undefined;
      child.on('exit', (code, signal) => {
        exitInfo = { code, signal };
        // The CLI is gone: stop the watchdog so reaping descendants can't flip a clean exit to failed.
        dog.stop();
        const exitCode = code ?? (signal === 'SIGKILL' ? 137 : signal === 'SIGTERM' ? 143 : 1);
        void (async () => {
          // Leftovers in the group (MCP servers, browsers) must be gone before the run resolves and
          // its semaphore slots (e.g. the browser profile) are released.
          await reapGroup(pid, this.killGraceMs);
          // Group is dead, so stdout closes promptly; bound the wait anyway.
          if (!outClosed) {
            await new Promise<void>((r) => {
              onOutClosed = r;
              setTimeout(r, 1000).unref();
            });
          }
          finish(exitCode);
        })();
      });
    });
  }
}

// --- learning loop WP-B helpers ------------------------------------------------------------------

/** Why an attempt / run failed: the supervisor's reason, else the last error event, else the exit code. */
function failureOf(result: AttemptResult, events: RunEvent[]): string {
  if (result.reason) return result.reason;
  const lastError = [...events].reverse().find((e) => e.t === 'error');
  if (lastError?.t === 'error') return lastError.message.slice(0, 2000);
  return `exit ${result.exitCode}`;
}

/** `prompt.md` of a run: the full system prompt and task prompt the agent was started with. */
function promptMarkdown(ctx: RunContext, systemPrompt: string, prompt: string, attempt: number): string {
  return [
    `<!-- run ${ctx.agentRunId} · role ${ctx.role} · ${ctx.model.provider}/${ctx.model.model} · prompt version ${ctx.promptVersion} · attempt ${attempt} -->`,
    '# System prompt',
    '',
    systemPrompt,
    '',
    '# Task prompt',
    '',
    prompt,
    '',
  ].join('\n');
}

const isWin = process.platform === 'win32';

/**
 * Points `path` at `target` with a symlink, so a CLI that refreshes credentials in place writes
 * them to the user's own file; copies when symlinks are unavailable. A missing target removes
 * `path`. The link (or copy) is made under a temp name and renamed into place, so concurrent runs
 * never write through an existing link onto the target.
 */
function linkFile(path: string, target: string) {
  mkdirSync(dirname(path), { recursive: true });
  let current: string | null | undefined; // link target, null = regular file, undefined = absent
  try {
    current = lstatSync(path).isSymbolicLink() ? readlinkSync(path) : null;
  } catch {
    current = undefined;
  }
  if (!existsSync(target)) {
    if (current !== undefined) rmSync(path, { force: true });
    return;
  }
  if (current === target) return;
  const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  try {
    symlinkSync(target, tmp);
  } catch {
    copyFileSync(target, tmp);
  }
  renameSync(tmp, path);
}

function signalGroup(pid: number | undefined, sig: NodeJS.Signals, child?: { kill(sig: NodeJS.Signals): boolean }) {
  try {
    if (pid !== undefined && !isWin) process.kill(-pid, sig);
    else child?.kill(sig);
  } catch {
    // already gone
  }
}

/** True while any process in group `pid` exists (probe with signal 0). */
function groupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function waitGroupGone(pid: number, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (groupAlive(pid)) {
    if (Date.now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, 25));
  }
  return true;
}

/**
 * Terminates every remaining process in the CLI's process group: only if the group still exists
 * (avoids signalling a recycled pgid), SIGTERM, wait up to `graceMs`, then SIGKILL and confirm.
 */
export async function reapGroup(pid: number | undefined, graceMs: number): Promise<void> {
  if (pid === undefined || isWin || !groupAlive(pid)) return;
  signalGroup(pid, 'SIGTERM');
  if (await waitGroupGone(pid, graceMs)) return;
  signalGroup(pid, 'SIGKILL');
  if (!(await waitGroupGone(pid, 5000))) {
    console.warn(`[bif] process group ${pid} still present after SIGKILL`);
  }
}
