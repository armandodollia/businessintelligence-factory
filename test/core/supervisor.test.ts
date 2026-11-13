import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { defaultConfig, type BifConfig } from '../../src/core/config/schema.js';
import { EventBus, type BusEvent } from '../../src/core/events.js';
import { ArtifactStore } from '../../src/core/evidence/artifacts.js';
import type { RunEvent } from '../../src/core/harness/adapter.js';
import { Supervisor, type RunOptions } from '../../src/core/harness/supervisor.js';
import { TokenRegistry } from '../../src/core/harness/tokens.js';
import { createToolHandlers, resolveUserRequest } from '../../src/core/harness/tools/handlers.js';
import { openStore, type Store } from '../../src/core/store/db.js';
import { newId } from '../../src/core/store/repos.js';

const FAKE_CLI = join(import.meta.dirname, '../fixtures/fake-cli.mjs');
const CLAUDE_FIXTURE = readFileSync(join(import.meta.dirname, '../fixtures/claude-stream.jsonl'), 'utf8')
  .split('\n')
  .filter(Boolean);

const opened: Store[] = [];
afterEach(() => {
  for (const s of opened.splice(0)) s.close();
});

function setup(cfg: (c: BifConfig) => void = () => {}) {
  const dir = mkdtempSync(join(tmpdir(), 'bif-sup-'));
  const store = openStore(join(dir, 'bif.db'));
  opened.push(store);
  const config = structuredClone(defaultConfig);
  config.providers.claude.command = FAKE_CLI;
  config.limits.idleTimeoutMs = 2000;
  config.browser.mcpServers = { playwright: { command: 'npx', args: ['@playwright/mcp@0.0.41'] } };
  cfg(config);
  const events = new EventBus();
  const seen: BusEvent[] = [];
  events.on((e) => seen.push(e));
  const tokens = new TokenRegistry(store);
  const handle = createToolHandlers({ store, artifacts: new ArtifactStore(store, dir), config, events });
  const sup = new Supervisor({
    store, config, tokens, events, handle, dataDir: dir, mcpBaseUrl: 'http://127.0.0.1:4317',
    backoff: { baseMs: 10, maxMs: 40, maxAttempts: 6 }, killGraceMs: 150,
  });
  return { dir, store, config, events, seen, tokens, handle, sup };
}

const baseCtx: RunOptions['ctx'] = {
  workspaceId: 'ws_a',
  role: 'worker',
  model: { provider: 'claude', model: 'sonnet' },
  promptVersion: 'pv_1',
};

const cli = (script: object, extra: Partial<RunOptions> = {}): RunOptions => ({
  ctx: baseCtx, prompt: JSON.stringify(script), systemPrompt: 'sys', needsBrowser: false, ...extra,
});

const readEvents = (dir: string, ws: string, id: string): RunEvent[] =>
  readFileSync(join(dir, ws, 'runs', id, 'events.jsonl'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));

describe('Supervisor', () => {
  it('persists events.jsonl and marks done', async () => {
    const { dir, store, seen, sup, tokens } = setup();
    const res = await sup.run(cli({ lines: CLAUDE_FIXTURE }, { needsBrowser: true }));
    expect(res.exitCode).toBe(0);
    expect(res.status).toBe('done');
    expect(res.events).toContainEqual({ t: 'tool_call', name: 'save_finding', input: expect.anything() });
    expect(res.events.at(-1)).toEqual({ t: 'done', exitCode: 0 });
    expect(readEvents(dir, 'ws_a', res.agentRunId)).toEqual(res.events);
    const run = store.agentRuns.get(res.agentRunId)!;
    expect(run).toMatchObject({ status: 'done', exitCode: 0, role: 'worker', promptVersion: 'pv_1' });
    expect(run.endedAt).toBeDefined();
    expect(tokens.resolve(run.token)).toBeNull(); // revoked after the run
    expect(seen.filter((e) => e.type === 'run_event')).toHaveLength(res.events.length);
    expect(seen).toContainEqual(expect.objectContaining({ type: 'run_status', status: 'done', agentRunId: res.agentRunId }));

    const cwd = join(dir, 'ws_a', 'runs', res.agentRunId, 'cwd');
    const mcp = JSON.parse(readFileSync(join(cwd, '.bif-mcp.json'), 'utf8'));
    expect(run.token.startsWith('revoked:')).toBe(true); // revocation persisted
    expect(mcp.mcpServers.bif.url).toBe(`http://127.0.0.1:4317/mcp/${run.token.slice('revoked:'.length)}`);
    expect(mcp.mcpServers.playwright).toBeDefined();
    const argv = JSON.parse(readFileSync(join(cwd, 'argv.json'), 'utf8')) as string[];
    expect(argv).toContain('--strict-mcp-config');
    expect(argv[argv.indexOf('--append-system-prompt') + 1]).toBe('sys');
  });

  it('adds browser MCP servers only when needsBrowser', async () => {
    const { dir, sup } = setup();
    const res = await sup.run(cli({ lines: CLAUDE_FIXTURE }));
    const mcp = JSON.parse(readFileSync(join(dir, 'ws_a', 'runs', res.agentRunId, 'cwd', '.bif-mcp.json'), 'utf8'));
    expect(Object.keys(mcp.mcpServers)).toEqual(['bif']);
  });

  it('non-zero exit without done line → failed with synthetic done', async () => {
    const { store, sup } = setup();
    const res = await sup.run(cli({ lines: ['not json'], exitCode: 3 }));
    expect(res).toMatchObject({ exitCode: 3, status: 'failed' });
    expect(res.events.at(-1)).toEqual({ t: 'done', exitCode: 3 });
    expect(store.agentRuns.get(res.agentRunId)!.status).toBe('failed');
  });

  it('supervisor kills run after idleTimeoutMs and marks failed', async () => {
    const { store, sup, seen } = setup((c) => (c.limits.idleTimeoutMs = 200));
    const t0 = Date.now();
    const res = await sup.run(cli({ lines: [CLAUDE_FIXTURE[0]!], sleepForever: true, ignoreSigterm: true }));
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(res.status).toBe('failed');
    expect(res.exitCode).not.toBe(0);
    expect(res.reason).toMatch(/idle/);
    expect(store.agentRuns.get(res.agentRunId)).toMatchObject({ status: 'failed' });
    expect(seen).toContainEqual(expect.objectContaining({ type: 'run_status', status: 'failed', reason: expect.stringMatching(/idle/) }));
  });

  it('retries on rateLimited then succeeds', async () => {
    const { dir, sup } = setup();
    const counterFile = join(dir, 'count');
    const rejected = JSON.stringify({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected' } });
    const res = await sup.run(
      cli({ counterFile, attempts: [{ lines: [rejected], exitCode: 1 }, { lines: [rejected], exitCode: 1 }, { lines: CLAUDE_FIXTURE }] }),
    );
    expect(readFileSync(counterFile, 'utf8')).toBe('3');
    expect(res).toMatchObject({ exitCode: 0, status: 'done', attempts: 3 });
    expect(res.events.filter((e) => e.t === 'error' && e.rateLimited)).toHaveLength(2);
    expect(res.events.at(-1)).toEqual({ t: 'done', exitCode: 0 });
  });

  it('rate-limit retry prompt lists what the previous attempt already did', async () => {
    const { dir, sup, store, events } = setup();
    const counterFile = join(dir, 'count');
    const rejected = JSON.stringify({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected' } });
    // Attempt 1 "calls" save_finding and log_decision before being rate limited.
    events.on((e) => {
      if (e.type !== 'run_status' || e.status !== 'running') return;
      for (const payload of [
        { tool: 'save_finding', findingId: 'fnd_PRIOR', criteria: {} },
        { tool: 'log_decision', what: 'chose the pricing page first', why: 'w' },
      ]) {
        store.decisions.insert({
          id: newId('dec'), workspaceId: 'ws_a', agentRunId: e.agentRunId, role: 'worker',
          model: { provider: 'claude', model: 'sonnet' }, kind: 'decision', payload, refs: [], promptVersion: 'pv', createdAt: '',
        });
      }
    });
    const res = await sup.run(cli({ counterFile, attempts: [{ lines: [rejected], exitCode: 1 }, { lines: CLAUDE_FIXTURE }] }));
    expect(res).toMatchObject({ status: 'done', attempts: 2 });
    const cwd = join(dir, 'ws_a', 'runs', res.agentRunId, 'cwd');
    const prompts = readdirSync(cwd).filter((f) => f.startsWith('prompt.')).sort().map((f) => readFileSync(join(cwd, f), 'utf8'));
    expect(prompts).toHaveLength(2);
    expect(prompts[0]).not.toContain('Your previous attempt');
    expect(prompts[1]).toContain('## Your previous attempt in this run already did:');
    expect(prompts[1]).toContain('- save_finding fnd_PRIOR');
    expect(prompts[1]).toContain('- log_decision: chose the pricing page first');
  });

  it('gives up after maxAttempts rate-limited attempts', async () => {
    const { dir, config, store, tokens, events, handle } = setup();
    const sup = new Supervisor({
      store, config, tokens, events, handle, dataDir: dir, mcpBaseUrl: 'http://x',
      backoff: { baseMs: 1, maxMs: 2, maxAttempts: 2 },
    });
    const rejected = JSON.stringify({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected' } });
    const res = await sup.run(cli({ counterFile: join(dir, 'c'), attempts: [{ lines: [rejected], exitCode: 1 }] }));
    expect(res).toMatchObject({ status: 'failed', attempts: 2 });
  });

  it('respects maxParallelWorkers=1 (two runs serialize)', async () => {
    const { sup } = setup((c) => (c.limits.maxParallelWorkers = 1));
    let active = 0;
    let maxActive = 0;
    const script = async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 100));
      active--;
    };
    const opts = (fake: () => Promise<void>): RunOptions => ({ ctx: baseCtx, prompt: 'p', systemPrompt: 's', needsBrowser: false, fake });
    const [a, b] = await Promise.all([sup.run(opts(script)), sup.run(opts(script))]);
    expect(maxActive).toBe(1);
    expect(a.status).toBe('done');
    expect(b.status).toBe('done');

    // orchestrator runs are not limited by the worker semaphore
    const { sup: sup2 } = setup((c) => (c.limits.maxParallelWorkers = 1));
    active = 0;
    maxActive = 0;
    await Promise.all([
      sup2.run({ ...opts(script), ctx: { ...baseCtx, role: 'orchestrator' } }),
      sup2.run({ ...opts(script), ctx: { ...baseCtx, role: 'orchestrator' } }),
    ]);
    expect(maxActive).toBe(2);
  });

  it('respects maxBrowserRuns', async () => {
    const { sup } = setup((c) => {
      c.limits.maxParallelWorkers = 5;
      c.limits.maxBrowserRuns = 1;
    });
    let active = 0;
    let maxActive = 0;
    const fake = async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 80));
      active--;
    };
    await Promise.all([1, 2, 3].map(() => sup.run({ ctx: baseCtx, prompt: 'p', systemPrompt: 's', needsBrowser: true, fake })));
    expect(maxActive).toBe(1);
  });

  it('fake mode: tool calls go through handlers, are recorded, and errors throw', async () => {
    const { dir, store, sup } = setup();
    let caught = '';
    const res = await sup.run({
      ctx: baseCtx, prompt: 'p', systemPrompt: 's', needsBrowser: false,
      fake: async (tools) => {
        await tools.call('log_decision', { what: 'w', why: 'y', confidence: 0.5 });
        try {
          await tools.call('submit_review', { score: 5, issues: [] });
        } catch (e) {
          caught = (e as Error).message;
        }
      },
    });
    expect(res.status).toBe('done');
    expect(caught).toMatch(/not available to role 'worker'/);
    expect(store.decisions.list({ agentRunId: res.agentRunId })).toHaveLength(1);
    expect(res.events).toEqual([
      { t: 'tool_call', name: 'log_decision', input: { what: 'w', why: 'y', confidence: 0.5 } },
      { t: 'tool_result', name: 'log_decision', ok: true },
      { t: 'tool_call', name: 'submit_review', input: { score: 5, issues: [] } },
      { t: 'tool_result', name: 'submit_review', ok: false },
      { t: 'done', exitCode: 0 },
    ]);
    expect(readEvents(dir, 'ws_a', res.agentRunId)).toEqual(res.events);

    const failed = await sup.run({ ctx: baseCtx, prompt: 'p', systemPrompt: 's', needsBrowser: false, fake: async () => { throw new Error('boom'); } });
    expect(failed).toMatchObject({ status: 'failed', exitCode: 1 });
    expect(failed.events).toContainEqual({ t: 'error', message: 'boom', rateLimited: false });
  });

  it('idle timer paused while user request pending', async () => {
    const { store, events, sup } = setup((c) => (c.limits.idleTimeoutMs = 200));
    const resolver = events.on((e) => {
      if (e.type === 'user_request') setTimeout(() => resolveUserRequest({ store, events }, e.request.id, 'resolved', 'done'), 600);
    });
    let answer: unknown;
    const res = await sup.run({
      ctx: baseCtx, prompt: 'p', systemPrompt: 's', needsBrowser: false,
      fake: async (tools) => {
        answer = await tools.call('request_user_action', { kind: 'register', site: 'acme.test', instructions: 'sign up' });
      },
    });
    resolver();
    expect(res.status).toBe('done');
    expect(answer).toMatchObject({ status: 'resolved', response: 'done' });
  });

  it('idle timeout also applies to a stuck fake script', async () => {
    const { sup } = setup((c) => (c.limits.idleTimeoutMs = 100));
    const res = await sup.run({ ctx: baseCtx, prompt: 'p', systemPrompt: 's', needsBrowser: false, fake: () => new Promise(() => {}) });
    expect(res).toMatchObject({ status: 'failed', reason: expect.stringMatching(/idle/) });
  });

  it('missing CLI binary → failed run, no throw', async () => {
    const { sup } = setup((c) => (c.providers.claude.command = '/nonexistent/claude-xyz'));
    const res = await sup.run(cli({ lines: [] }));
    expect(res.status).toBe('failed');
    expect(res.events.some((e) => e.t === 'error')).toBe(true);
  });
});

describe('Supervisor fix round 1', () => {
  const alive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };

  it('internal error after token issue → failed run, revoked token, no zombie', async () => {
    const { dir, store, config, tokens, events, seen } = setup();
    const sup = new Supervisor({ store, config, tokens, events, dataDir: dir, mcpBaseUrl: 'http://x' }); // no handle
    const res = await sup.run({ ctx: baseCtx, prompt: 'p', systemPrompt: 's', needsBrowser: false, fake: async () => {} });
    expect(res).toMatchObject({ status: 'failed', exitCode: 1, reason: expect.stringMatching(/supervisor error/) });
    expect(res.events.slice(-2)).toEqual([
      { t: 'error', message: expect.stringMatching(/deps.handle/), rateLimited: false },
      { t: 'done', exitCode: 1 },
    ]);
    const run = store.agentRuns.get(res.agentRunId)!;
    expect(run.status).toBe('failed');
    expect(tokens.resolve(run.token)).toBeNull();
    expect(new TokenRegistry(store).resolve(run.token)).toBeNull();
    expect(seen).toContainEqual(expect.objectContaining({ type: 'run_status', status: 'failed', agentRunId: res.agentRunId }));
    expect(store.agentRuns.list({ status: 'running' })).toHaveLength(0);
  });

  it('cancel while queued → run never starts', async () => {
    const { store, sup } = setup((c) => (c.limits.maxParallelWorkers = 1));
    let release!: () => void;
    const blocker = sup.run({
      ctx: baseCtx, prompt: 'p', systemPrompt: 's', needsBrowser: false,
      fake: () => new Promise<void>((r) => (release = r)),
    });
    await new Promise((r) => setTimeout(r, 20));
    const ac = new AbortController();
    let started = false;
    const queued = sup.run({
      ctx: baseCtx, prompt: 'p', systemPrompt: 's', needsBrowser: false, signal: ac.signal,
      fake: async () => {
        started = true;
      },
    });
    await new Promise((r) => setTimeout(r, 20));
    ac.abort();
    await expect(queued).rejects.toThrow(/abort|cancel/i);
    release();
    await blocker;
    expect(started).toBe(false);
    expect(store.agentRuns.list()).toHaveLength(1);

    // already-aborted signal: CLI mode never spawns either
    const pre = new AbortController();
    pre.abort();
    await expect(sup.run(cli({ lines: [] }, { signal: pre.signal }))).rejects.toThrow(/abort|cancel/i);
    await expect(
      sup.run({ ctx: { ...baseCtx, role: 'orchestrator' }, prompt: 'p', systemPrompt: 's', needsBrowser: false, signal: pre.signal, fake: async () => {} }),
    ).rejects.toThrow(/abort|cancel/i);
    expect(store.agentRuns.list()).toHaveLength(1);
  });

  it('reaps a SIGTERM-ignoring descendant before run() resolves', async () => {
    const { dir, sup } = setup((c) => (c.limits.idleTimeoutMs = 300));
    const res = await sup.run(cli({ lines: [CLAUDE_FIXTURE[0]!], sleepForever: true, stubbornChild: true }));
    expect(res).toMatchObject({ status: 'failed', reason: expect.stringMatching(/idle/) });
    const childPid = Number(readFileSync(join(dir, 'ws_a', 'runs', res.agentRunId, 'cwd', 'child.pid'), 'utf8'));
    // The grandchild ignored SIGTERM; run() must not resolve until it has been SIGKILLed.
    expect(alive(childPid)).toBe(false);
    expect(res.events.at(-1)).toEqual({ t: 'done', exitCode: res.exitCode });
  });

  it('idle-killed runs are not rate-limit retried', async () => {
    const { dir, sup } = setup((c) => (c.limits.idleTimeoutMs = 200));
    const counterFile = join(dir, 'count');
    const rejected = JSON.stringify({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected' } });
    const res = await sup.run(cli({ counterFile, attempts: [{ lines: [rejected], sleepForever: true }] }));
    expect(res).toMatchObject({ status: 'failed', attempts: 1, reason: expect.stringMatching(/idle/) });
    expect(readFileSync(counterFile, 'utf8')).toBe('1');
  });

  it('a descendant left after a normal exit is reaped before run() resolves', async () => {
    const { dir, sup } = setup();
    const res = await sup.run(cli({ lines: CLAUDE_FIXTURE, stubbornChild: true }));
    expect(res.status).toBe('done');
    const childPid = Number(readFileSync(join(dir, 'ws_a', 'runs', res.agentRunId, 'cwd', 'child.pid'), 'utf8'));
    expect(alive(childPid)).toBe(false);
  });

  it("'done' is the last event even when output keeps arriving", async () => {
    const { sup } = setup((c) => (c.limits.idleTimeoutMs = 2000));
    const res = await sup.run(cli({ lines: [...CLAUDE_FIXTURE, CLAUDE_FIXTURE.at(-1)!] }));
    expect(res.events.at(-1)!.t).toBe('done');
    expect(res.events.filter((e) => e.t === 'done').length).toBeGreaterThanOrEqual(1);
  });
});

describe('Supervisor post-cap fixes', () => {
  it('relative dataDir: paths handed to the CLI are absolute and exist', async () => {
    const { dir, store, config, tokens, events, handle } = setup();
    const rel = relative(process.cwd(), dir);
    expect(isAbsolute(rel)).toBe(false);
    const sup = new Supervisor({ store, config, tokens, events, handle, dataDir: rel, mcpBaseUrl: 'http://x' });
    const res = await sup.run(cli({ lines: CLAUDE_FIXTURE }));
    expect(res.status).toBe('done');
    const cwd = join(dir, 'ws_a', 'runs', res.agentRunId, 'cwd');
    const argv = JSON.parse(readFileSync(join(cwd, 'argv.json'), 'utf8')) as string[];
    const mcpPath = argv[argv.indexOf('--mcp-config') + 1]!;
    expect(isAbsolute(mcpPath)).toBe(true);
    expect(readFileSync(mcpPath, 'utf8')).toContain('"bif"');
    expect(mcpPath).toBe(join(cwd, '.bif-mcp.json'));
  });

  it('rate-limit error then exit 0 without a successful done → failed attempt, retried', async () => {
    const { dir, sup } = setup();
    const counterFile = join(dir, 'count');
    const rejected = JSON.stringify({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected' } });
    const res = await sup.run(cli({ counterFile, attempts: [{ lines: [rejected], exitCode: 0 }, { lines: CLAUDE_FIXTURE }] }));
    expect(readFileSync(counterFile, 'utf8')).toBe('2');
    expect(res).toMatchObject({ status: 'done', exitCode: 0, attempts: 2 });
    expect(res.events.filter((e) => e.t === 'done')).toEqual([{ t: 'done', exitCode: 1 }, { t: 'done', exitCode: 0 }]);

    // a rate-limit blip followed by a successful result is still success
    const ok = await sup.run(cli({ lines: [rejected, ...CLAUDE_FIXTURE] }));
    expect(ok).toMatchObject({ status: 'done', attempts: 1 });
  });

  it('records the CLI pid on the AgentRun', async () => {
    const { store, sup } = setup();
    const res = await sup.run(cli({ lines: CLAUDE_FIXTURE }));
    const run = store.agentRuns.get(res.agentRunId)!;
    expect(typeof run.pid).toBe('number');
    expect(run.pid).toBeGreaterThan(0);
    const fake = await sup.run({ ctx: baseCtx, prompt: 'p', systemPrompt: 's', needsBrowser: false, fake: async () => {} });
    expect(store.agentRuns.get(fake.agentRunId)!.pid).toBeUndefined();
  });

  it('a clean exit is not flipped to failed while descendants are reaped', async () => {
    // idle timeout shorter than the reap grace: the watchdog must already be stopped
    const { dir, store, config, tokens, events, handle } = setup((c) => (c.limits.idleTimeoutMs = 300)); // > fake-cli's 200 ms start-up delay
    const sup = new Supervisor({ store, config, tokens, events, handle, dataDir: dir, mcpBaseUrl: 'http://x', killGraceMs: 900 });
    const res = await sup.run(cli({ lines: CLAUDE_FIXTURE, stubbornChild: true }));
    expect(res).toMatchObject({ status: 'done', exitCode: 0 });
    expect(res.reason).toBeUndefined();
  });
});

