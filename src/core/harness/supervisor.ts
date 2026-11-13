import { spawn } from 'node:child_process';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import type { BifConfig } from '../config/schema.js';
import { AbortError, type EventBus } from '../events.js';
import type { Store } from '../store/db.js';
import { newId } from '../store/repos.js';
import type { AgentRun, Role } from '../types.js';
import { isRateLimitText, type FakeScript, type RunEvent, type ToolClient } from './adapter.js';
import { getAdapter } from './adapters/index.js';
import { Semaphore } from './semaphore.js';
import type { RunContext, TokenRegistry } from './tokens.js';
import type { HandleTool } from './tools/handlers.js';
import type { ToolName } from './tools/registry.js';

/** Roles that count against `limits.maxParallelWorkers`. */
const LIMITED_ROLES: ReadonlySet<Role> = new Set(['worker', 'reviewer', 'persona']);

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
};

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

  constructor(private readonly deps: SupervisorDeps) {
    this.workers = new Semaphore(deps.config.limits.maxParallelWorkers);
    const maxBrowser = deps.config.limits.maxBrowserRuns;
    this.browsers = maxBrowser > 0 ? new Semaphore(maxBrowser) : null;
    this.backoff = deps.backoff ?? DEFAULT_BACKOFF;
    this.killGraceMs = deps.killGraceMs ?? 5000;
  }

  /**
   * Runs one agent. Resolves (never rejects) once a run has started, with `failed` on any error.
   * Rejects only before start: `AbortError` when cancelled while queued, or a config error.
   */
  async run(opts: RunOptions): Promise<RunOutcome> {
    if (opts.needsBrowser && !this.browsers) {
      throw new Error('this run needs a browser but limits.maxBrowserRuns is 0');
    }
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
    const { store, events, tokens, dataDir } = this.deps;
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
          const path = join(dataDir, ctx.workspaceId, 'runs', ctx.agentRunId, 'events.jsonl');
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
        store.agentRuns.update(ctx.agentRunId, { status: 'failed', exitCode: 1, endedAt: new Date().toISOString() });
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
    const { store, events, tokens, dataDir } = this.deps;
    const runDir = join(dataDir, ctx.workspaceId, 'runs', ctx.agentRunId);
    const cwd = join(runDir, 'cwd');
    mkdirSync(cwd, { recursive: true });
    const eventsPath = join(runDir, 'events.jsonl');
    writeFileSync(eventsPath, '');

    const record = (e: RunEvent) => {
      all.push(e);
      appendFileSync(eventsPath, JSON.stringify(e) + '\n');
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

    let attempt = 0;
    let result: AttemptResult;
    for (;;) {
      attempt++;
      setAttempt(attempt);
      result = opts.fake
        ? await this.attemptFake(ctx, opts, record)
        : await this.attemptCli(ctx, token, cwd, runDir, opts, record);
      // Runs killed by the watchdog or an abort (result.reason set) are never retried.
      if (!result.rateLimited || result.exitCode === 0 || result.reason || opts.signal?.aborted) break;
      if (attempt >= this.backoff.maxAttempts) {
        result.reason = `rate limited; gave up after ${attempt} attempts`;
        break;
      }
      const delay = Math.min(this.backoff.baseMs * 2 ** (attempt - 1), this.backoff.maxMs);
      await sleep(delay, opts.signal);
      if (opts.signal?.aborted) break;
    }

    const status: AgentRun['status'] = result.exitCode === 0 ? 'done' : 'failed';
    tokens.revoke(token);
    store.agentRuns.update(ctx.agentRunId, { status, exitCode: result.exitCode, endedAt: new Date().toISOString() });
    this.emitStatus(ctx, status, result.exitCode, result.reason);
    const outcome: RunOutcome = { agentRunId: ctx.agentRunId, exitCode: result.exitCode, events: all, status, attempts: attempt };
    if (result.reason !== undefined) outcome.reason = result.reason;
    return outcome;
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

  private attemptCli(
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
    const spec = {
      prompt: opts.prompt,
      systemPrompt: opts.systemPrompt,
      model: ctx.model.model,
      mcpUrl: `${mcpBaseUrl.replace(/\/+$/, '')}/mcp/${token}`,
      extraMcpServers: opts.needsBrowser ? config.browser.mcpServers : {},
      cwd,
    };
    const built = adapter.buildCommand(spec);
    for (const f of built.files) {
      mkdirSync(dirname(f.path), { recursive: true });
      writeFileSync(f.path, f.content);
    }
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

      const signalGroup = (sig: NodeJS.Signals) => {
        try {
          if (child.pid !== undefined && process.platform !== 'win32') process.kill(-child.pid, sig);
          else child.kill(sig);
        } catch {
          // already gone
        }
      };
      // SIGTERM the whole group, then SIGKILL it after the grace period no matter what — even if
      // the CLI itself already exited — so descendants that ignore SIGTERM die too.
      const terminateGroup = () => {
        signalGroup('SIGTERM');
        if (killTimer) return;
        killTimer = setTimeout(() => signalGroup('SIGKILL'), this.killGraceMs);
        killTimer.unref();
      };
      const kill = (why: string) => {
        if (reason || settled) return;
        reason = why;
        terminateGroup();
      };

      const dog = this.watchdog(ctx, () => kill(`idle timeout: no output for ${config.limits.idleTimeoutMs} ms`));
      const onAbort = () => kill('aborted');
      opts.signal?.addEventListener('abort', onAbort, { once: true });
      if (opts.signal?.aborted) onAbort();

      const finish = (exitCode: number, extraError?: string) => {
        if (settled) return;
        settled = true;
        dog.stop();
        opts.signal?.removeEventListener('abort', onAbort);
        if (extraError) emit({ t: 'error', message: extraError, rateLimited: false });
        if (reason) emit({ t: 'error', message: reason, rateLimited: false });
        // Process exit code wins when non-zero; otherwise trust the stream (OpenCode exits 0 on error).
        let code = exitCode !== 0 ? exitCode : (lastDone ?? 0);
        if (reason && code === 0) code = 1;
        if (lastDone !== code) emit({ t: 'done', exitCode: code });
        const res: AttemptResult = { exitCode: code, rateLimited };
        if (reason !== undefined) res.reason = reason;
        resolve(res);
      };

      child.on('error', (err) => {
        reason ??= `spawn failed: ${err.message}`;
        finish(127);
      });

      const out = createInterface({ input: child.stdout! });
      out.on('line', (line) => {
        dog.touch();
        appendFileSync(stdoutLog, line + '\n');
        for (const e of adapter.parseLine(line)) emit(e);
      });
      const err = createInterface({ input: child.stderr! });
      err.on('line', (line) => {
        dog.touch();
        appendFileSync(stderrLog, line + '\n');
        // stderr is never JSON events; only scan it for rate-limit text.
        if (isRateLimitText(line)) {
          emit({ t: 'error', message: line.slice(0, 2000), rateLimited: true });
        }
      });

      let outClosed = false;
      let exitInfo: { code: number | null; signal: NodeJS.Signals | null } | undefined;
      const maybeFinish = () => {
        if (!outClosed || !exitInfo) return;
        const { code, signal } = exitInfo;
        const exitCode = code ?? (signal === 'SIGKILL' ? 137 : signal === 'SIGTERM' ? 143 : 1);
        finish(exitCode);
      };
      out.on('close', () => {
        outClosed = true;
        maybeFinish();
      });
      child.on('exit', (code, signal) => {
        exitInfo = { code, signal };
        // Kill leftovers in the group (e.g. MCP servers the CLI started).
        terminateGroup();
        maybeFinish();
        // stdout may be held open by a grandchild; don't wait on it forever.
        setTimeout(() => {
          outClosed = true;
          maybeFinish();
        }, 2000).unref();
      });
    });
  }
}
