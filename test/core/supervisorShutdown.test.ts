/**
 * Shutting the server down stops the agents it started (design
 * 2026-11-16-desktop-app-and-feedback-bundle-design.md §4.1): `Supervisor.close()` stops the process
 * tree of every running CLI and waits for it. A run stopped this way is left as a crash would leave
 * it (its record still says `running`), so the recovery of the next start continues the work.
 *
 * The agent CLI here is `test/fixtures/fake-cli.mjs`: no model is called.
 */
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { BifConfig } from '../../src/core/config/schema.js';
import type { RunOptions, RunOutcome } from '../../src/core/harness/supervisor.js';
import { resumeInterrupted } from '../../src/core/research/orchestrator.js';
import { researchToolHandlers } from '../../src/core/research/tools.js';
import type { Store } from '../../src/core/store/db.js';
import { addTask, researchSetup, review, submitWork, type SetupOptions } from './helpers/research.js';

const FAKE_CLI = join(import.meta.dirname, '../fixtures/fake-cli.mjs');
const NOW = '2026-11-16T10:00:00.000Z';

const opened: Store[] = [];
/** Process ids this file started (CLIs and what they started): whatever a failing test leaves behind is stopped by id. */
const startedPids: number[] = [];
afterEach(() => {
  for (const pid of startedPids.splice(0)) {
    for (const target of process.platform === 'win32' ? [pid] : [-pid, pid]) {
      try {
        process.kill(target, 'SIGKILL');
      } catch {
        // gone, as it should be
      }
    }
  }
  for (const s of opened.splice(0)) {
    try {
      s.close();
    } catch {
      // closed by the test (the first "process" of a restart)
    }
  }
});

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until<T>(what: string, read: () => T | undefined | false, ms = 20_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = read();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(20);
  }
}

const settledWithin = (p: Promise<unknown>, ms: number): Promise<'settled' | 'pending'> =>
  Promise.race([p.then(() => 'settled' as const, () => 'settled' as const), sleep(ms).then(() => 'pending' as const)]);

function setup(opts: SetupOptions = {}) {
  const s = researchSetup(opened, {
    extraHandlers: () => researchToolHandlers(),
    ...opts,
    config: (c: BifConfig) => {
      c.providers.claude.command = FAKE_CLI;
      c.limits.idleTimeoutMs = 60_000;
      opts.config?.(c);
    },
  });
  if (!s.store.workspaces.get('ws_a')) s.store.workspaces.insert({ id: 'ws_a', name: 'Acme', sector: 'saas', createdAt: NOW });
  return s;
}

/** A real (fake) CLI run of `task` that never ends on its own. `stubbornChild`: it also starts a process that ignores a polite stop. */
function longRun(s: ReturnType<typeof setup>, taskId: string, script: Record<string, unknown> = {}): { pending: Promise<RunOutcome>; opts: RunOptions } {
  const opts: RunOptions = {
    ctx: { workspaceId: 'ws_a', role: 'worker', model: { provider: 'claude', model: 'sonnet' }, promptVersion: 'pv_1', taskId },
    prompt: JSON.stringify({ lines: [], sleepForever: true, ...script }),
    systemPrompt: 'sys',
    needsBrowser: false,
  };
  return { pending: s.supervisor.run(opts), opts };
}

function runOf(s: ReturnType<typeof setup>, taskId: string) {
  const run = s.store.agentRuns.list({ workspaceId: 'ws_a' }).find((r) => r.taskId === taskId);
  if (run?.pid !== undefined && !startedPids.includes(run.pid)) startedPids.push(run.pid);
  return run;
}

describe('Supervisor.close stops the agents it started', () => {
  it('a long-running CLI and what it started are gone, and its record is left as a crash would leave it', async () => {
    const s = setup();
    s.store.researchRuns.insert({ id: 'rrun_1', workspaceId: 'ws_a', phase: 'deep_dives', status: 'running', startedAt: NOW });
    const task = addTask(s.store, { status: 'running' });
    const { pending } = longRun(s, task.id, { stubbornChild: true });
    const run = await until('the CLI to start', () => {
      const r = runOf(s, task.id);
      return r?.pid !== undefined ? r : undefined;
    });
    const cwd = join(s.dir, 'ws_a', 'runs', run.id, 'cwd');
    // The process the CLI started ignores a polite stop: only the forced one after the grace ends it.
    await until('the process the CLI started', () => existsSync(join(cwd, 'child.ready')));
    const childPid = Number(readFileSync(join(cwd, 'child.pid'), 'utf8'));
    startedPids.push(childPid);
    expect(alive(run.pid!)).toBe(true);
    expect(alive(childPid)).toBe(true);

    await s.supervisor.close();

    expect(alive(run.pid!)).toBe(false);
    expect(alive(childPid)).toBe(false);
    // The interrupted kind: still `running`, with its process id, not closed out as a failure.
    const after = s.store.agentRuns.get(run.id)!;
    expect(after).toMatchObject({ status: 'running', pid: run.pid });
    expect(after.endedAt).toBeUndefined();
    expect(after.failureReason).toBeUndefined();
    expect(s.tokens.resolve(after.token)).not.toBeNull();
    expect(s.store.tasks.get(task.id)!.status).toBe('running');
    // Nothing downstream ran: the run did not end for its caller, and no status change was announced.
    expect(await settledWithin(pending, 300)).toBe('pending');
    expect(s.seen.filter((e) => e.type === 'run_status' && e.agentRunId === run.id).map((e) => (e as { status: string }).status)).toEqual(['running']);
  }, 30_000);

  it('after close no run starts: neither a new one nor one that was waiting for a free place', async () => {
    const s = setup({ config: (c) => (c.limits.maxParallelWorkers = 1) });
    const first = addTask(s.store, { status: 'running' });
    const second = addTask(s.store, { status: 'running' });
    const a = longRun(s, first.id);
    await until('the first CLI to start', () => runOf(s, first.id)?.pid);
    const b = longRun(s, second.id); // waits: one worker at a time
    await sleep(50);
    expect(runOf(s, second.id)).toBeUndefined();

    await s.supervisor.close();
    const c = longRun(s, addTask(s.store).id);

    expect(await settledWithin(Promise.race([a.pending, b.pending, c.pending]), 400)).toBe('pending');
    expect(s.store.agentRuns.list({ workspaceId: 'ws_a' }).map((r) => r.taskId)).toEqual([first.id]);
  }, 30_000);

  it('a run waiting out a rate limit does not start its next attempt after close', async () => {
    const s = setup();
    const task = addTask(s.store, { status: 'running' });
    const counterFile = join(mkdtempSync(join(tmpdir(), 'bif-shutdown-')), 'count');
    const rejected = JSON.stringify({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', rateLimitType: 'five_hour' } });
    const { pending } = longRun(s, task.id, { sleepForever: false, counterFile, attempts: [{ lines: [rejected], exitCode: 1 }] });
    // The first attempt was refused; the supervisor waits (5 ms here) before the next.
    await until('the first attempt', () => existsSync(counterFile));
    await s.supervisor.close();
    const attempts = Number(readFileSync(counterFile, 'utf8'));
    await sleep(300);
    expect(Number(readFileSync(counterFile, 'utf8'))).toBe(attempts);
    expect(await settledWithin(pending, 50)).toBe('pending');
    expect(runOf(s, task.id)!.status).toBe('running');
  }, 30_000);

  it('the next start fails the interrupted run, queues its task again and finishes the research run', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bif-shutdown-'));
    // --- process 1: a worker runs when the server is shut down.
    const s1 = setup({ dir });
    const rr = s1.store.researchRuns.insert({ id: 'rrun_1', workspaceId: 'ws_a', phase: 'deep_dives', status: 'running', startedAt: NOW });
    const task = addTask(s1.store, { status: 'running' });
    longRun(s1, task.id);
    const run = await until('the CLI to start', () => {
      const r = runOf(s1, task.id);
      return r?.pid !== undefined ? r : undefined;
    });
    await s1.supervisor.close();
    expect(alive(run.pid!)).toBe(false);
    s1.store.close();

    // --- process 2: the same data; the recovery of the start continues the work.
    const s2 = setup({
      dir,
      pick: (r) => (r.kind === 'work' ? submitWork() : r.kind === 'review' ? review(9) : async () => {}),
    });
    const report = resumeInterrupted(s2.deps);
    expect(report.failedRuns).toEqual([run.id]);
    expect(report.requeuedTasks).toEqual([task.id]);
    expect(report.continuedRuns).toEqual([rr.id]);
    expect(s2.store.agentRuns.get(run.id)).toMatchObject({ status: 'failed' });
    const [finished] = await report.done;
    expect(finished).toMatchObject({ id: rr.id, status: 'done' });
    expect(s2.store.tasks.get(task.id)!.status).toBe('verified');
    await s2.supervisor.close();
  }, 30_000);
});
