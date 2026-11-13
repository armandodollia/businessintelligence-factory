import { afterEach, describe, expect, it } from 'vitest';
import type { FakeScript } from '../../src/core/harness/adapter.js';
import { promptStoreGaps } from '../../src/core/prompts/store.js';
import { resumeInterrupted, startPhase } from '../../src/core/research/orchestrator.js';
import { runTaskWithReview } from '../../src/core/research/reviewLoop.js';
import { researchToolHandlers } from '../../src/core/research/tools.js';
import type { Store } from '../../src/core/store/db.js';
import { addTask, researchSetup, review, revise, submitWork, type SetupOptions } from './helpers/research.js';

const opened: Store[] = [];
afterEach(() => {
  for (const s of opened.splice(0)) s.close();
});

function setup(opts: SetupOptions = {}) {
  const s = researchSetup(opened, { extraHandlers: () => researchToolHandlers(), ...opts });
  s.store.workspaces.insert({ id: 'ws_a', name: 'Acme', sector: 'saas', createdAt: new Date().toISOString() } as never);
  return s;
}

const propose =
  (tasks: unknown[]): FakeScript =>
  async (t) => {
    await t.call('propose_tasks', { tasks });
  };

describe('run timing and failures (WP-B)', () => {
  it('agent runs record round and task type; every prompt version resolves to its text', async () => {
    const s = setup({
      pick: (r) => {
        if (r.kind === 'orchestrate') {
          return r.round === 1
            ? propose([{ type: 'news_scan', brief: 'scan', model: { provider: 'claude', model: 'sonnet' }, needs_browser: false, acceptance_criteria: ['c'] }])
            : async () => {};
        }
        if (r.kind === 'review') return r.round === 1 ? review(3, [{ class: 'blocking', description: 'missing date' }]) : review(9);
        if (r.kind === 'revise') return revise()(r);
        return submitWork();
      },
    });
    const rr = await startPhase('ws_a', 'deep_dives', s.deps);
    expect(rr.status).toBe('done');
    const [task] = s.store.tasks.list({ runId: rr.id });
    const runs = s.store.agentRuns.list({ taskId: task!.id });
    expect(runs.map((r) => [r.role, r.round, r.taskType])).toEqual([
      ['worker', 1, 'news_scan'],
      ['reviewer', 1, 'news_scan'],
      ['worker', 2, 'news_scan'],
      ['reviewer', 2, 'news_scan'],
    ]);
    const orch = s.store.agentRuns.list({ role: 'orchestrator' });
    expect(orch.map((r) => r.round)).toEqual([1, 2]);
    expect(runs.every((r) => r.attempts === 1)).toBe(true);
    expect(promptStoreGaps(s.store)).toEqual([]);
  });

  it('a failed task records why', async () => {
    const s = setup({ pick: (r) => (r.kind === 'work' ? async () => {} : review(9)) });
    const task = addTask(s.store);
    const out = await runTaskWithReview(task, s.deps);
    expect(out.status).toBe('failed');
    expect(s.store.tasks.get(task.id)!.failureReason).toBe('run ended without submit_result');
  });

  it('a task that cannot run records the error', async () => {
    const s = setup({ config: (c) => (c.limits.maxBrowserRuns = 0), pick: () => submitWork() });
    const task = addTask(s.store, { needsBrowser: true });
    const out = await runTaskWithReview(task, s.deps);
    expect(out.status).toBe('failed');
    expect(s.store.tasks.get(task.id)!.failureReason).toMatch(/maxBrowserRuns is 0/);
  });

  it('a failed research run records why', async () => {
    const s = setup({ pick: () => async () => { throw new Error('orchestrator crashed'); } });
    const rr = await startPhase('ws_a', 'deep_dives', s.deps);
    expect(rr.status).toBe('failed');
    expect(s.store.researchRuns.get(rr.id)!.failureReason).toMatch(/orchestrator run failed.*orchestrator crashed/);
  });

  it('tasks abandoned at resume record why', () => {
    const s = setup();
    s.store.researchRuns.insert({ id: 'rrun_old', workspaceId: 'ws_a', phase: 'deep_dives', status: 'done', startedAt: 'x' });
    const task = addTask(s.store, { runId: 'rrun_old', status: 'running' });
    resumeInterrupted(s.deps);
    expect(s.store.tasks.get(task.id)).toMatchObject({ status: 'failed', failureReason: expect.stringMatching(/interrupted/) });
  });
});
