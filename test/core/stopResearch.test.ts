/**
 * Stopping the research of one business from the app (`stopResearch`): the running pipeline and its
 * agent runs end through the abort path, the research run is recorded as stopped, tasks that were in
 * work go back to the queue, and nothing is deleted. Research can be started again afterwards, and a
 * restart of the server does not start the stopped research by itself.
 *
 * Agents are in-process scripts, or `test/fixtures/hanging-cli.mjs` where a real process must be
 * shown to be gone. No model is called.
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { BifConfig } from '../../src/core/config/schema.js';
import { councilRounds } from '../../src/core/council/store.js';
import { startEscalations } from '../../src/core/escalation/escalation.js';
import { AbortError } from '../../src/core/events.js';
import type { FakeScript } from '../../src/core/harness/adapter.js';
import type { RunOptions, RunOutcome, Supervisor } from '../../src/core/harness/supervisor.js';
import { resolveUserRequest } from '../../src/core/harness/tools/handlers.js';
import { getExperiment, startExperiment } from '../../src/core/learning/experiments.js';
import { isExperimentTask } from '../../src/core/learning/runTags.js';
import { listPolicyEvents } from '../../src/core/policy/policyEvents.js';
import { attachEventRecorders } from '../../src/core/telemetry/recorders.js';
import { isPipelineLocked, PipelineBusyError } from '../../src/core/research/lock.js';
import { currentResearchRun, resumeInterrupted, runPipeline, runTaskTracked, stopResearch, STOPPED_REASON } from '../../src/core/research/orchestrator.js';
import { STOPPED_REQUEST_RESPONSE } from '../../src/core/research/stop.js';
import { researchToolHandlers } from '../../src/core/research/tools.js';
import type { Store } from '../../src/core/store/db.js';
import { newId } from '../../src/core/store/repos.js';
import { addTask, researchSetup, review, submitWork, type Picker, type SetupOptions } from './helpers/research.js';

const HANGING_CLI = join(import.meta.dirname, '../fixtures/hanging-cli.mjs');
const STUBBORN_CLI = join(import.meta.dirname, '../fixtures/stubborn-cli.mjs');
const NOW = '2026-11-16T10:00:00.000Z';

const opened: Store[] = [];
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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function until<T>(what: string, read: () => T | undefined | false, ms = 20_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = read();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(10);
  }
}

function setup(opts: SetupOptions = {}) {
  const s = researchSetup(opened, { extraHandlers: () => researchToolHandlers(), ...opts });
  for (const id of ['ws_a', 'ws_other']) {
    if (!s.store.workspaces.get(id)) s.store.workspaces.insert({ id, name: id, sector: 'saas', createdAt: NOW });
  }
  return s;
}

/** Orchestrator script: proposes `n` tasks in its first round, nothing afterwards. */
const propose = (n: number): Picker => (req) =>
  req.kind !== 'orchestrate'
    ? undefined
    : async (t) => {
        if (req.round !== 1) return;
        await t.call('propose_tasks', {
          tasks: Array.from({ length: n }, (_, i) => ({ type: 'news_scan', subject: `Subject ${i}`, brief: `Scan the news about subject ${i}`, needs_browser: false, acceptance_criteria: ['one dated article'] })),
        });
      };

const never: FakeScript = () => new Promise<void>(() => {});

const tasksOf = (s: ReturnType<typeof setup>, workspaceId = 'ws_a') => s.store.tasks.list({ workspaceId });

describe('stopResearch', () => {
  it('ends the running pipeline: its agent runs are stopped, the research run is recorded as stopped, tasks in work are queued again, nothing is deleted', async () => {
    let worked = 0;
    const s = setup({
      // The first task finishes and is verified; the second is in work when research is stopped.
      pick: (r) => propose(2)(r) ?? (r.kind === 'review' ? review(9) : r.kind === 'work' ? (++worked === 1 ? submitWork() : never) : undefined),
    });
    const pipeline = runPipeline('ws_a', ['deep_dives'], s.deps);
    pipeline.catch(() => {});
    await until('the second task to be in work', () => worked === 2 && tasksOf(s).some((t) => t.status === 'verified'));
    const before = { tasks: tasksOf(s).length, findings: s.store.findings.list({ workspaceId: 'ws_a' }).length, runs: s.store.agentRuns.list({ workspaceId: 'ws_a' }).length };
    expect(before.findings).toBe(1);
    const seenBefore = s.seen.length;

    const report = await stopResearch(s.deps, 'ws_a');

    await expect(pipeline).rejects.toThrow(/cancel|abort/i);
    expect(report.stopped).toBe(true);
    expect(isPipelineLocked(s.store, 'ws_a')).toBe(false);
    // Recorded as stopped: nothing says `running` any more.
    const [rr] = s.store.researchRuns.list({ workspaceId: 'ws_a' });
    expect(rr).toMatchObject({ status: 'failed', failureReason: STOPPED_REASON });
    expect(rr!.endedAt).toBeDefined();
    expect(report.researchRuns).toEqual([rr!.id]);
    expect(s.store.pipelines.list({ workspaceId: 'ws_a' })).toEqual([expect.objectContaining({ status: 'failed', endedAt: expect.any(String) })]);
    expect(s.store.agentRuns.list({ workspaceId: 'ws_a' }).filter((r) => r.status === 'running')).toEqual([]);
    expect(s.store.agentRuns.list({ workspaceId: 'ws_a' }).filter((r) => r.failureReason === 'aborted')).toHaveLength(1);
    // Finished work is kept; the task that was in work waits in the queue with its step and round.
    const tasks = tasksOf(s);
    expect(tasks.map((t) => t.status).sort()).toEqual(['queued', 'verified']);
    const queued = tasks.find((t) => t.status === 'queued')!;
    expect(queued).toMatchObject({ step: 'work', round: 1 });
    expect(report.requeuedTasks).toEqual([queued.id]);
    expect(queued.failureReason).toBeUndefined();
    expect({ tasks: tasks.length, findings: s.store.findings.list({ workspaceId: 'ws_a' }).length, runs: s.store.agentRuns.list({ workspaceId: 'ws_a' }).length }).toEqual(before);
    // No task was announced as failed or unverified: that would start an escalation agent.
    expect(s.seen.slice(seenBefore).filter((e) => e.type === 'task_status')).toEqual([]);
    // And nothing starts afterwards.
    await sleep(100);
    expect(s.store.agentRuns.list({ workspaceId: 'ws_a' })).toHaveLength(before.runs);
  });

  it('stops the process of a running agent CLI', async () => {
    const s = setup({ config: (c) => (c.providers.claude.command = HANGING_CLI) });
    // The orchestrator is a script; the worker is the real (stand-in) CLI.
    s.deps.fake = (req) => propose(1)(req);
    const pipeline = runPipeline('ws_a', ['deep_dives'], s.deps);
    pipeline.catch(() => {});
    const runs = join(s.dir, 'ws_a', 'runs');
    const pid = await until('the agent CLI to start', () => {
      const file = existsSync(runs) ? readdirSync(runs).map((id) => join(runs, id, 'cwd', 'cli.pid')).find((f) => existsSync(f)) : undefined;
      return file ? Number(readFileSync(file, 'utf8')) : undefined;
    });
    startedPids.push(pid);
    expect(alive(pid)).toBe(true);

    await stopResearch(s.deps, 'ws_a');

    expect(alive(pid)).toBe(false);
    expect(s.store.agentRuns.list({ workspaceId: 'ws_a' }).filter((r) => r.status === 'running')).toEqual([]);
    await expect(pipeline).rejects.toThrow(/cancel|abort/i);
  }, 30_000);

  it('research can be started again afterwards, and runs to its end', async () => {
    const s = setup({ pick: (r) => propose(1)(r) ?? (r.kind === 'work' ? never : undefined) });
    const first = runPipeline('ws_a', ['deep_dives'], s.deps);
    first.catch(() => {});
    await until('the task to be in work', () => s.requests.some((r) => r.kind === 'work'));
    await stopResearch(s.deps, 'ws_a');

    s.state.pick = (r) => propose(1)(r) ?? (r.kind === 'work' ? submitWork() : r.kind === 'review' ? review(9) : undefined);
    const [again] = await runPipeline('ws_a', ['deep_dives'], s.deps);
    expect(again).toMatchObject({ status: 'done', phase: 'deep_dives' });
    expect(s.store.researchRuns.list({ workspaceId: 'ws_a' }).map((r) => r.status)).toEqual(['failed', 'done']);
    // The task the stop left in the queue belongs to the stopped run: the new run did not pick it up.
    expect(tasksOf(s).map((t) => t.status).sort()).toEqual(['queued', 'verified']);
  });

  it('touches one business only: the research of another keeps running and finishes', async () => {
    let release: (() => void) | undefined;
    const held = new Promise<void>((r) => (release = r));
    const s = setup({
      pick: (r) =>
        propose(1)(r) ??
        (r.kind === 'review'
          ? review(9)
          : r.kind === 'work'
            ? r.workspaceId === 'ws_a'
              ? never
              : async (t) => {
                  await held;
                  await submitWork()(t);
                }
            : undefined),
    });
    const a = runPipeline('ws_a', ['deep_dives'], s.deps);
    a.catch(() => {});
    const other = runPipeline('ws_other', ['deep_dives'], s.deps);
    await until('both tasks to be in work', () => s.requests.filter((r) => r.kind === 'work').length === 2);

    await stopResearch(s.deps, 'ws_a');

    expect(isPipelineLocked(s.store, 'ws_other')).toBe(true);
    expect(s.store.researchRuns.list({ workspaceId: 'ws_other' })).toEqual([expect.objectContaining({ status: 'running' })]);
    expect(s.store.agentRuns.list({ workspaceId: 'ws_other', status: 'running' })).toHaveLength(1);
    release!();
    expect(await other).toEqual([expect.objectContaining({ status: 'done' })]);
    expect(tasksOf(s, 'ws_other').map((t) => t.status)).toEqual(['verified']);
  });

  it('with nothing running it changes nothing and says so', async () => {
    const s = setup();
    const done = s.store.researchRuns.insert({ id: 'rrun_done', workspaceId: 'ws_a', phase: 'deep_dives', status: 'done', startedAt: NOW, endedAt: NOW });
    const task = addTask(s.store, { runId: done.id, status: 'verified' });
    expect(await stopResearch(s.deps, 'ws_a')).toEqual({ stopped: false, researchRuns: [], pipelines: [], requeuedTasks: [], closedRequests: [] });
    expect(s.store.researchRuns.get(done.id)).toEqual(done);
    expect(s.store.tasks.get(task.id)).toEqual(task);
  });

  it('a restart does not start stopped research by itself', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bif-stop-'));
    const s1 = setup({ dir, pick: (r) => propose(1)(r) ?? (r.kind === 'work' ? never : undefined) });
    const pipeline = runPipeline('ws_a', ['deep_dives', 'scoring'], s1.deps);
    pipeline.catch(() => {});
    await until('the task to be in work', () => s1.requests.some((r) => r.kind === 'work'));
    await stopResearch(s1.deps, 'ws_a');
    const [task] = tasksOf(s1);
    s1.store.close();

    const s2 = setup({ dir });
    const report = resumeInterrupted(s2.deps);
    expect(report).toMatchObject({ failedRuns: [], requeuedTasks: [], abandonedTasks: [], continuedRuns: [], continuedPipelines: [] });
    expect(await report.done).toEqual([]);
    expect(s2.requests).toEqual([]);
    expect(s2.seen.filter((e) => e.type === 'task_status')).toEqual([]);
    expect(s2.store.tasks.get(task!.id)).toMatchObject({ status: 'queued' });
    expect(isPipelineLocked(s2.store, 'ws_a')).toBe(false);
  });

  it('stops research that a restart continued, and leaves the other continued business locked and running', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bif-stop-'));
    // --- process 1: both businesses are in research when the server dies (as after a quit).
    const s1 = setup({ dir });
    for (const ws of ['ws_a', 'ws_other']) {
      s1.store.researchRuns.insert({ id: `rrun_${ws}`, workspaceId: ws, phase: 'deep_dives', status: 'running', startedAt: NOW });
      addTask(s1.store, { workspaceId: ws, runId: `rrun_${ws}`, status: 'running' });
    }
    s1.store.close();

    // --- process 2.
    let release: (() => void) | undefined;
    const held = new Promise<void>((r) => (release = r));
    const s2 = setup({
      dir,
      pick: (r) =>
        r.kind === 'orchestrate'
          ? async () => {}
          : r.kind === 'review'
            ? review(9)
            : r.workspaceId === 'ws_a'
              ? never
              : async (t) => {
                  await held;
                  await submitWork()(t);
                },
    });
    const report = resumeInterrupted(s2.deps);
    await until('both tasks to be in work again', () => s2.requests.filter((r) => r.kind === 'work').length === 2);

    const stopped = await stopResearch(s2.deps, 'ws_a');

    expect(stopped).toMatchObject({ stopped: true, researchRuns: ['rrun_ws_a'] });
    expect(isPipelineLocked(s2.store, 'ws_a')).toBe(false);
    expect(isPipelineLocked(s2.store, 'ws_other')).toBe(true);
    release!();
    await until('the other business to finish', () => s2.store.researchRuns.get('rrun_ws_other')!.status === 'done');
    await expect(report.done).rejects.toThrow(/cancel|abort/i);
    await until('its lock to be released', () => !isPipelineLocked(s2.store, 'ws_other'));
  });

  it('stops a task that is run again outside a pipeline (after an answered escalation)', async () => {
    const s = setup({ pick: (r) => (r.kind === 'work' ? never : undefined) });
    const ended = s.store.researchRuns.insert({ id: 'rrun_1', workspaceId: 'ws_a', phase: 'deep_dives', status: 'done', startedAt: NOW, endedAt: NOW });
    const task = addTask(s.store, { runId: ended.id });
    const rerun = runTaskTracked(task, s.deps);
    rerun.catch(() => {});
    await until('the task to be in work', () => s.requests.some((r) => r.kind === 'work'));

    const report = await stopResearch(s.deps, 'ws_a');

    await expect(rerun).rejects.toThrow(/cancel|abort/i);
    expect(report).toMatchObject({ stopped: true, requeuedTasks: [task.id] });
    expect(s.store.agentRuns.list({ workspaceId: 'ws_a', status: 'running' })).toEqual([]);
    expect(s.store.researchRuns.get(ended.id)).toEqual(ended);
  });

  it('a task that waits for the person goes back to the queue and its request is closed: no answer can restart it, and the next start fails nothing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bif-stop-'));
    // The worker asks the person to log in and waits for the answer.
    const asks: Picker = (r) =>
      propose(1)(r) ?? (r.kind === 'work' ? async (t) => void (await t.call('request_user_action', { kind: 'login', site: 'example.com', instructions: 'Log in to the site' })) : undefined);
    const s1 = setup({ dir, pick: asks });
    const pipeline = runPipeline('ws_a', ['deep_dives', 'scoring'], s1.deps);
    pipeline.catch(() => {});
    const task = await until('the task to wait for the person', () => tasksOf(s1).find((t) => t.status === 'waiting_user'));
    const [request] = s1.store.userRequests.list({ taskId: task.id, status: 'pending' });
    expect(request).toBeDefined();
    const seenBefore = s1.seen.length;

    const report = await stopResearch(s1.deps, 'ws_a');

    // The task is in the queue with its step and round, like a task that was in work; nothing is failed.
    expect(report).toMatchObject({ stopped: true, requeuedTasks: [task.id], closedRequests: [request!.id] });
    expect(s1.store.tasks.get(task.id)).toMatchObject({ status: 'queued', step: 'work', round: 1 });
    expect(s1.store.tasks.get(task.id)!.failureReason).toBeUndefined();
    // Its request is closed, and says why; the page is told, so it no longer shows it.
    expect(s1.store.userRequests.get(request!.id)).toMatchObject({ status: 'denied', response: STOPPED_REQUEST_RESPONSE, resolvedAt: expect.any(String) });
    expect(s1.store.userRequests.list({ workspaceId: 'ws_a', status: 'pending' })).toEqual([]);
    const after = s1.seen.slice(seenBefore);
    expect(after.filter((e) => e.type === 'user_request_resolved')).toEqual([expect.objectContaining({ request: expect.objectContaining({ id: request!.id, status: 'denied' }) })]);
    expect(after.filter((e) => e.type === 'task_status')).toEqual([]);
    // It can no longer be answered, so no answer puts the task back in work without an agent.
    expect(() => resolveUserRequest({ store: s1.store, events: s1.events }, request!.id, 'resolved')).toThrow(/already denied/);
    expect(s1.store.tasks.get(task.id)!.status).toBe('queued');
    await sleep(100);
    expect(s1.requests.map((r) => r.kind)).toEqual(['orchestrate', 'work']);
    s1.store.close();

    // The next start of the app: nothing to recover, nothing fails, and no escalation agent starts.
    const s2 = setup({ dir });
    const escalations = startEscalations(s2.deps);
    const resumed = resumeInterrupted(s2.deps);
    expect(resumed).toMatchObject({ failedRuns: [], requeuedTasks: [], waitingTasks: [], abandonedTasks: [], continuedRuns: [], continuedPipelines: [] });
    expect(await resumed.done).toEqual([]);
    await escalations.idle();
    await sleep(100);
    expect(s2.store.tasks.get(task.id)).toMatchObject({ status: 'queued' });
    expect(s2.store.tasks.get(task.id)!.failureReason).toBeUndefined();
    expect(s2.seen.filter((e) => e.type === 'task_status')).toEqual([]);
    expect(s2.requests).toEqual([]);
    escalations.stop();
  });

  it('a request for approval closed by the stop is not recorded as a denial of the person', async () => {
    const s = setup({
      pick: (r) => propose(1)(r) ?? (r.kind === 'work' ? async (t) => void (await t.call('request_approval', { action: 'request a demo', site: 'example.com', details: 'Ask for a demo of the product' })) : undefined),
    });
    const recorders = attachEventRecorders({ store: s.store, events: s.events, config: s.config });
    const pipeline = runPipeline('ws_a', ['deep_dives'], s.deps);
    pipeline.catch(() => {});
    const task = await until('the task to wait for the person', () => tasksOf(s).find((t) => t.status === 'waiting_user'));

    const report = await stopResearch(s.deps, 'ws_a');

    expect(report.closedRequests).toHaveLength(1);
    expect(s.store.tasks.get(task.id)!.status).toBe('queued');
    await recorders.stop();
    expect(listPolicyEvents(s.store, { workspaceId: 'ws_a' }).map((e) => e.kind)).toEqual(['approval_requested']);
  });

  it('leaves a running experiment of the same business alone: its arm tasks stay in work and it runs to its end', async () => {
    let release: (() => void) | undefined;
    const held = new Promise<void>((r) => (release = r));
    // Asked when a worker starts: the store knows an arm task from the moment it is made.
    const isArm = (taskId: string | undefined) => !!taskId && isExperimentTask(s.store, taskId);
    const s: ReturnType<typeof setup> = setup({
      pick: (r) =>
        propose(1)(r) ??
        (r.kind === 'review'
          ? review(9)
          : r.kind === 'work'
            ? isArm(r.task?.id)
              ? async (t) => {
                  await held;
                  await submitWork()(t);
                }
              : never
            : undefined),
    });
    // An earlier, finished research run with a finished task: the source of the experiment.
    const old = s.store.researchRuns.insert({ id: 'rrun_old', workspaceId: 'ws_a', phase: 'deep_dives', status: 'done', startedAt: NOW, endedAt: NOW });
    const source = addTask(s.store, { runId: old.id, status: 'verified' });
    const { experiment, done } = startExperiment(s.deps, { taskId: source.id, arms: [{}, {}] });
    const armIds = experiment.arms.flatMap((a) => a.taskIds);
    await until('the arm tasks to be in work', () => armIds.every((id) => s.store.tasks.get(id)!.status === 'running'));
    const pipeline = runPipeline('ws_a', ['deep_dives'], s.deps);
    pipeline.catch(() => {});
    const researchTask = await until('a research task to be in work', () => tasksOf(s).find((t) => !armIds.includes(t.id) && t.id !== source.id && t.status === 'running'));

    const report = await stopResearch(s.deps, 'ws_a');

    // Research is stopped: its task is queued again. The experiment is not research of the pipeline.
    expect(report.requeuedTasks).toEqual([researchTask.id]);
    expect(armIds.map((id) => s.store.tasks.get(id)!.status)).toEqual(['running', 'running']);
    expect(s.store.agentRuns.list({ workspaceId: 'ws_a', status: 'running' }).map((r) => r.taskId).sort()).toEqual([...armIds].sort());
    expect(getExperiment(s.store, experiment.id)!.status).toBe('running');
    // And it finishes as if nothing had happened.
    release!();
    expect(await done).toMatchObject({ status: 'done' });
    expect(armIds.map((id) => s.store.tasks.get(id)!.status)).toEqual(['verified', 'verified']);
  });
});

// ---------------------------------------------------------------------------------------------------
// Several task agents in flight. The runs of a stopped pipeline end in any order: one that waited for a
// worker slot ends at once, a started one only when its process is gone. The stop is recorded after
// the last of them has ended, so every task of the stopped research is back in the queue.

type Setup = ReturnType<typeof setup>;

const ended = (status: 'done' | 'failed', reason?: string): RunOutcome => ({
  agentRunId: newId('arun'), exitCode: status === 'done' ? 0 : 1, events: [], status, attempts: 1, ...(reason !== undefined ? { reason } : {}),
});

const aborted = (signal: AbortSignal | undefined) =>
  new Promise<void>((resolve) => {
    if (signal?.aborted) resolve();
    else signal?.addEventListener('abort', () => resolve(), { once: true });
  });

/**
 * Puts a stub in the supervisor's place: nothing is started, a run is what `run` makes of it. The
 * orchestrator's run plans `tasks` tasks into the research run that is running and ends.
 */
function stubSupervisor(s: Setup, tasks: number, run: (opts: RunOptions, n: number) => Promise<RunOutcome>): void {
  let n = 0;
  s.deps.supervisor = {
    run: async (opts: RunOptions) => {
      if (opts.ctx.role !== 'orchestrator') return run(opts, ++n);
      const rr = currentResearchRun(s.store, opts.ctx.workspaceId)!;
      if (!s.store.tasks.list({ runId: rr.id }).length) {
        for (let i = 0; i < tasks; i++) addTask(s.store, { workspaceId: rr.workspaceId, runId: rr.id, subject: `Subject ${i}`, brief: `Scan the news about subject ${i}` });
      }
      return ended('done');
    },
  } as unknown as Supervisor;
}

/**
 * The real supervisor, except that a run that was started ends for its caller only `ms` after the
 * abort, as a CLI whose process takes that long to go. A run that never started (it waited for a
 * worker slot) still ends at once.
 */
function slowToGo(s: Setup, ms: number): void {
  const run = s.supervisor.run.bind(s.supervisor);
  s.supervisor.run = async (opts) => {
    const out = await run(opts);
    if (opts.signal?.aborted) await sleep(ms);
    return out;
  };
}

/** The next start of the app on the same data: what it recovers, and which agents it starts. */
async function nextStart(dir: string) {
  const s = setup({ dir });
  const escalations = startEscalations(s.deps);
  const resumed = resumeInterrupted(s.deps);
  const continued = await resumed.done;
  await escalations.idle();
  await sleep(100);
  escalations.stop();
  return { s, resumed, continued };
}

const reviewersAtWork = (s: Setup) => s.store.agentRuns.list({ workspaceId: 'ws_a', status: 'running' }).filter((r) => r.role === 'reviewer').length;

const NOTHING_TO_RECOVER = { failedRuns: [], requeuedTasks: [], waitingTasks: [], abandonedTasks: [], continuedRuns: [], continuedPipelines: [] };

describe('stopResearch with several task agents in flight', () => {
  it('a run that ends late, one that ends at once and a task that waits for the person: all three are queued, the request is closed, and the next start fails nothing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bif-stop-'));
    const s1 = setup({ dir });
    stubSupervisor(s1, 3, async (opts, n) => {
      if (n === 3) {
        // The third agent asks the person to log in and waits for the answer.
        void s1.handle({ ...opts.ctx, agentRunId: newId('arun') }, 'request_user_action', { kind: 'login', site: 'example.com', instructions: 'Log in to the site' }, { signal: opts.signal! });
      }
      await aborted(opts.signal);
      // The second run waited for a worker slot: it never started, and ends at once.
      if (n === 2) throw new AbortError('run cancelled before start');
      // The others were started: each ends when its process is gone.
      await sleep(n === 1 ? 50 : 20);
      return ended('failed', 'aborted');
    });
    const pipeline = runPipeline('ws_a', ['deep_dives'], s1.deps);
    pipeline.catch(() => {});
    await until('two tasks in work and one waiting for the person', () => {
      const statuses = tasksOf(s1).map((t) => t.status).sort();
      return statuses.join() === 'running,running,waiting_user';
    });
    const [request] = s1.store.userRequests.list({ workspaceId: 'ws_a', status: 'pending' });
    expect(request).toBeDefined();
    const ids = tasksOf(s1).map((t) => t.id).sort();
    const seenBefore = s1.seen.length;

    const report = await stopResearch(s1.deps, 'ws_a');

    await expect(pipeline).rejects.toThrow(/cancel|abort/i);
    expect(tasksOf(s1).map((t) => t.status)).toEqual(['queued', 'queued', 'queued']);
    expect(tasksOf(s1).map((t) => t.failureReason)).toEqual([undefined, undefined, undefined]);
    expect([...report.requeuedTasks].sort()).toEqual(ids);
    expect(report.closedRequests).toEqual([request!.id]);
    expect(s1.store.userRequests.get(request!.id)).toMatchObject({ status: 'denied', response: STOPPED_REQUEST_RESPONSE });
    expect(s1.store.userRequests.list({ workspaceId: 'ws_a', status: 'pending' })).toEqual([]);
    expect(s1.store.researchRuns.list({ workspaceId: 'ws_a' })).toEqual([expect.objectContaining({ status: 'failed', failureReason: STOPPED_REASON })]);
    expect(isPipelineLocked(s1.store, 'ws_a')).toBe(false);
    expect(s1.seen.slice(seenBefore).filter((e) => e.type === 'task_status')).toEqual([]);
    s1.store.close();

    // The next start of the app: nothing to recover, nothing is failed, and no escalation agent starts.
    const { s: s2, resumed, continued } = await nextStart(dir);
    expect(resumed).toMatchObject(NOTHING_TO_RECOVER);
    expect(continued).toEqual([]);
    expect(tasksOf(s2).map((t) => t.status)).toEqual(['queued', 'queued', 'queued']);
    expect(s2.seen.filter((e) => e.type === 'task_status')).toEqual([]);
    expect(s2.requests).toEqual([]);
  });

  it('two agent CLIs that ignore the polite stop and two tasks that wait for a worker slot: the processes are gone, all four tasks are queued, within the kill grace', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bif-stop-'));
    const s1 = setup({
      dir,
      config: (c) => {
        c.providers.claude.command = STUBBORN_CLI;
        c.limits.maxParallelWorkers = 2;
      },
    });
    // The orchestrator is a script; the workers are the real (stand-in) CLI.
    s1.deps.fake = (req) => propose(4)(req);
    const pipeline = runPipeline('ws_a', ['deep_dives'], s1.deps);
    pipeline.catch(() => {});
    const runs = join(s1.dir, 'ws_a', 'runs');
    const pids = await until('two agent CLIs to start', () => {
      const files = existsSync(runs) ? readdirSync(runs).map((id) => join(runs, id, 'cwd', 'cli.pid')).filter((f) => existsSync(f)) : [];
      return files.length === 2 && tasksOf(s1).filter((t) => t.status === 'running').length === 4 ? files.map((f) => Number(readFileSync(f, 'utf8'))) : undefined;
    });
    startedPids.push(...pids);

    const startedAt = Date.now();
    const report = await stopResearch(s1.deps, 'ws_a');

    // The test's supervisor has a kill grace of 100 ms; each run is stopped at the same time.
    expect(Date.now() - startedAt).toBeLessThan(5000);
    expect(pids.map(alive)).toEqual([false, false]);
    expect(tasksOf(s1).map((t) => t.status)).toEqual(['queued', 'queued', 'queued', 'queued']);
    expect(report.requeuedTasks).toHaveLength(4);
    expect(s1.store.agentRuns.list({ workspaceId: 'ws_a', status: 'running' })).toEqual([]);
    expect(s1.store.agentRuns.list({ workspaceId: 'ws_a' }).filter((r) => r.failureReason === 'aborted')).toHaveLength(2);
    await expect(pipeline).rejects.toThrow(/cancel|abort/i);
    s1.store.close();

    const { s: s2, resumed } = await nextStart(dir);
    expect(resumed).toMatchObject(NOTHING_TO_RECOVER);
    expect(tasksOf(s2).map((t) => t.status)).toEqual(['queued', 'queued', 'queued', 'queued']);
    expect(s2.requests).toEqual([]);
  }, 30_000);

  it('tasks in review by one reviewer, one reviewer started and one waiting for a worker slot: both are queued in the review step', async () => {
    const s = setup({
      config: (c) => (c.limits.maxParallelWorkers = 1),
      pick: (r) => propose(2)(r) ?? (r.kind === 'work' ? submitWork() : r.kind === 'review' ? never : undefined),
    });
    slowToGo(s, 40);
    const pipeline = runPipeline('ws_a', ['deep_dives'], s.deps);
    pipeline.catch(() => {});
    // One worker slot: one reviewer is started, the other waits for the slot.
    await until('both tasks to be in review', () => tasksOf(s).length === 2 && tasksOf(s).every((t) => t.status === 'reviewing') && reviewersAtWork(s) === 1);
    const seenBefore = s.seen.length;

    const report = await stopResearch(s.deps, 'ws_a');

    expect(tasksOf(s).map((t) => ({ status: t.status, step: t.step, round: t.round }))).toEqual([
      { status: 'queued', step: 'review', round: 1 },
      { status: 'queued', step: 'review', round: 1 },
    ]);
    expect(report.requeuedTasks).toHaveLength(2);
    expect(s.store.agentRuns.list({ workspaceId: 'ws_a', status: 'running' })).toEqual([]);
    // The work that was submitted stays; no review was recorded and no task status announced.
    expect(tasksOf(s).map((t) => t.submittedRound)).toEqual([1, 1]);
    expect(s.seen.slice(seenBefore).filter((e) => e.type === 'task_status')).toEqual([]);
    await expect(pipeline).rejects.toThrow(/cancel|abort/i);
  });

  it('tasks in review by a council, some members started and some waiting for a worker slot: both are queued in the review step and no round is recorded', async () => {
    const council: NonNullable<BifConfig['council']> = {
      members: [
        { name: 'a', provider: 'claude', model: 'opus', lens: 'evidence' },
        { name: 'b', provider: 'codex', model: 'gpt-6.1-sol', lens: 'reasoning' },
        { name: 'c', provider: 'claude', model: 'sonnet', lens: 'brief', blocking: false },
      ],
      stages: { news_scan: {} },
    };
    const s = setup({
      config: (c) => {
        c.council = council;
        c.limits.maxParallelWorkers = 3;
      },
      pick: (r) => propose(2)(r) ?? (r.kind === 'work' ? submitWork() : r.kind === 'review' ? never : undefined),
    });
    slowToGo(s, 40);
    const pipeline = runPipeline('ws_a', ['deep_dives'], s.deps);
    pipeline.catch(() => {});
    // Three worker slots, four blocking members of two councils: three are started, one waits.
    await until('three members to be at work', () => tasksOf(s).length === 2 && tasksOf(s).every((t) => t.status === 'reviewing') && reviewersAtWork(s) === 3);
    const reviewerRuns = s.store.agentRuns.list({ workspaceId: 'ws_a' }).filter((r) => r.role === 'reviewer').length;

    const report = await stopResearch(s.deps, 'ws_a');

    const tasks = tasksOf(s);
    expect(tasks.map((t) => ({ status: t.status, step: t.step, round: t.round }))).toEqual([
      { status: 'queued', step: 'review', round: 1 },
      { status: 'queued', step: 'review', round: 1 },
    ]);
    expect(report.requeuedTasks).toHaveLength(2);
    expect(tasks.flatMap((t) => councilRounds(s.store, t.id))).toEqual([]);
    expect(s.store.agentRuns.list({ workspaceId: 'ws_a', status: 'running' })).toEqual([]);
    await expect(pipeline).rejects.toThrow(/cancel|abort/i);
    // The member that waited for a slot was never started, and nothing starts afterwards.
    await sleep(100);
    expect(s.store.agentRuns.list({ workspaceId: 'ws_a' }).filter((r) => r.role === 'reviewer')).toHaveLength(reviewerRuns);
  });

  it('a run that ends by itself at the moment of the stop: its task is queued like the others, and nothing is announced', async () => {
    const s = setup();
    stubSupervisor(s, 2, async (opts, n) => {
      await aborted(opts.signal);
      // The first agent ended well in the same moment; the second is stopped and takes a while to go.
      if (n === 1) return ended('done');
      await sleep(40);
      return ended('failed', 'aborted');
    });
    const pipeline = runPipeline('ws_a', ['deep_dives'], s.deps);
    pipeline.catch(() => {});
    await until('both tasks to be in work', () => tasksOf(s).length === 2 && tasksOf(s).every((t) => t.status === 'running'));
    const seenBefore = s.seen.length;

    const report = await stopResearch(s.deps, 'ws_a');

    expect(tasksOf(s).map((t) => ({ status: t.status, step: t.step }))).toEqual([{ status: 'queued', step: 'work' }, { status: 'queued', step: 'work' }]);
    expect(report.requeuedTasks).toHaveLength(2);
    expect(s.seen.slice(seenBefore).filter((e) => e.type === 'task_status')).toEqual([]);
    await expect(pipeline).rejects.toThrow(/cancel|abort/i);
  });

  it('while a stop waits for an agent to go, research of the business cannot be started; what starts afterwards is not marked by the stop', async () => {
    let works = 0;
    const s = setup({ pick: (r) => propose(1)(r) ?? (r.kind === 'work' ? (++works === 1 ? never : submitWork()) : r.kind === 'review' ? review(9) : undefined) });
    slowToGo(s, 80);
    // No pipeline runs: a task is run again after an answered escalation, and that is what is stopped.
    const old = s.store.researchRuns.insert({ id: 'rrun_1', workspaceId: 'ws_a', phase: 'deep_dives', status: 'done', startedAt: NOW, endedAt: NOW });
    const task = addTask(s.store, { runId: old.id });
    const rerun = runTaskTracked(task, s.deps);
    rerun.catch(() => {});
    await until('the agent of the re-run to be started', () => s.store.agentRuns.list({ workspaceId: 'ws_a', status: 'running' }).length === 1);

    const stop = stopResearch(s.deps, 'ws_a');
    await sleep(10);
    // The stopped agent is not gone yet and the stop is not recorded: a start is refused, as while research runs.
    expect(isPipelineLocked(s.store, 'ws_a')).toBe(true);
    await expect(runPipeline('ws_a', ['deep_dives'], s.deps)).rejects.toBeInstanceOf(PipelineBusyError);
    expect(s.store.pipelines.list({ workspaceId: 'ws_a' })).toEqual([]);
    expect(s.store.researchRuns.list({ workspaceId: 'ws_a' })).toEqual([old]);

    expect(await stop).toEqual({ stopped: true, researchRuns: [], pipelines: [], requeuedTasks: [task.id], closedRequests: [] });

    // Recorded: research can be started, runs to its end, and nothing of it says it was stopped.
    expect(isPipelineLocked(s.store, 'ws_a')).toBe(false);
    const [again] = await runPipeline('ws_a', ['deep_dives'], s.deps);
    expect(again).toMatchObject({ status: 'done' });
    expect(again!.failureReason).toBeUndefined();
    expect(s.store.pipelines.list({ workspaceId: 'ws_a' })).toEqual([expect.objectContaining({ status: 'done' })]);
    expect(isPipelineLocked(s.store, 'ws_a')).toBe(false);
  });

  it('a second stop while the first is at work is the same stop: one record, one answer', async () => {
    const s = setup({ pick: (r) => propose(2)(r) ?? (r.kind === 'work' ? never : undefined) });
    slowToGo(s, 60);
    const pipeline = runPipeline('ws_a', ['deep_dives'], s.deps);
    pipeline.catch(() => {});
    await until('both agents to be started', () => s.store.agentRuns.list({ workspaceId: 'ws_a', status: 'running' }).filter((r) => r.role === 'worker').length === 2);

    const first = stopResearch(s.deps, 'ws_a');
    await sleep(10);
    const second = stopResearch(s.deps, 'ws_a');
    const [a, b] = await Promise.all([first, second]);

    expect(b).toEqual(a);
    expect(a.requeuedTasks).toHaveLength(2);
    expect(a.researchRuns).toHaveLength(1);
    expect(tasksOf(s).map((t) => t.status)).toEqual(['queued', 'queued']);
    expect(isPipelineLocked(s.store, 'ws_a')).toBe(false);
    // The stop is over: one more finds nothing running.
    expect(await stopResearch(s.deps, 'ws_a')).toMatchObject({ stopped: false, requeuedTasks: [] });
  });

  it('a pipeline does not begin its next phase after the stop, also when the phase at work ends by itself', async () => {
    let release: (() => void) | undefined;
    const held = new Promise<void>((r) => (release = r));
    const ran: string[] = [];
    const s = setup();
    // Phases without agents: the first does not look at the stop and ends well, the second must not begin.
    s.deps.phaseRunners = {
      persona_panel: async () => {
        ran.push('persona_panel');
        await held;
      },
      scoring: async () => void ran.push('scoring'),
    };
    const pipeline = runPipeline('ws_a', ['persona_panel', 'scoring'], s.deps);
    pipeline.catch(() => {});
    await until('the first phase to be at work', () => ran.length === 1);

    const stop = stopResearch(s.deps, 'ws_a');
    await sleep(10);
    release!();
    const report = await stop;

    await expect(pipeline).rejects.toThrow(/cancel|abort/i);
    expect(ran).toEqual(['persona_panel']);
    // The phase that ended is recorded as ended; the pipeline is stopped before the next one.
    expect(s.store.researchRuns.list({ workspaceId: 'ws_a' }).map((r) => `${r.phase}:${r.status}`)).toEqual(['persona_panel:done']);
    expect(s.store.pipelines.list({ workspaceId: 'ws_a' })).toEqual([expect.objectContaining({ status: 'failed', nextIndex: 1 })]);
    expect(report).toMatchObject({ stopped: true, researchRuns: [], pipelines: [s.store.pipelines.list({ workspaceId: 'ws_a' })[0]!.id] });
    expect(isPipelineLocked(s.store, 'ws_a')).toBe(false);
  });

  it('rows that say research is running while nothing is in flight are recorded as stopped like any other', async () => {
    const s = setup();
    const rr = s.store.researchRuns.insert({ id: 'rrun_1', workspaceId: 'ws_a', phase: 'deep_dives', status: 'running', startedAt: NOW });
    const inWork = addTask(s.store, { runId: rr.id, status: 'running' });
    const inReview = addTask(s.store, { runId: rr.id, status: 'reviewing', step: 'review' });
    const done = addTask(s.store, { runId: rr.id, status: 'verified' });

    const report = await stopResearch(s.deps, 'ws_a');

    expect(report).toMatchObject({ stopped: true, researchRuns: [rr.id], requeuedTasks: [inWork.id, inReview.id] });
    expect(s.store.researchRuns.get(rr.id)).toMatchObject({ status: 'failed', failureReason: STOPPED_REASON });
    expect([inWork, inReview, done].map((t) => s.store.tasks.get(t.id)!.status)).toEqual(['queued', 'queued', 'verified']);
  });

  it('a stop that comes before research continued by a restart has begun: it never begins', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bif-stop-'));
    const s1 = setup({ dir });
    // One research run in a pipeline, one outside any: both were interrupted by a quit.
    s1.store.pipelines.insert({ id: 'pipe_1', workspaceId: 'ws_a', phases: ['deep_dives', 'scoring'], nextIndex: 0, status: 'running', startedAt: NOW });
    s1.store.researchRuns.insert({ id: 'rrun_piped', workspaceId: 'ws_a', phase: 'deep_dives', status: 'running', startedAt: NOW, pipelineId: 'pipe_1' });
    s1.store.researchRuns.insert({ id: 'rrun_loose', workspaceId: 'ws_a', phase: 'deep_dives', status: 'running', startedAt: NOW });
    const tasks = ['rrun_piped', 'rrun_loose'].map((runId) => addTask(s1.store, { runId, status: 'running' }));
    s1.store.close();

    const s2 = setup({ dir, pick: () => never });
    const resumed = resumeInterrupted(s2.deps);
    expect(resumed.continuedRuns).toEqual(['rrun_piped', 'rrun_loose']);
    // The continuation begins on a later tick; the stop is here first.
    const report = await stopResearch(s2.deps, 'ws_a');

    expect(report).toMatchObject({ stopped: true, researchRuns: ['rrun_piped', 'rrun_loose'], pipelines: ['pipe_1'] });
    await expect(resumed.done).rejects.toThrow(/cancel|abort/i);
    await sleep(50);
    expect(s2.requests).toEqual([]);
    expect(s2.store.researchRuns.list({ workspaceId: 'ws_a' }).map((r) => r.status)).toEqual(['failed', 'failed']);
    expect(s2.store.pipelines.get('pipe_1')).toMatchObject({ status: 'failed', nextIndex: 0 });
    expect(tasks.map((t) => s2.store.tasks.get(t.id)!.status)).toEqual(['queued', 'queued']);
    expect(isPipelineLocked(s2.store, 'ws_a')).toBe(false);
  });
});
