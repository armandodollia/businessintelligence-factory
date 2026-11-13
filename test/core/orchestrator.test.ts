import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { FakeScript } from '../../src/core/harness/adapter.js';
import { resolveUserRequest } from '../../src/core/harness/tools/handlers.js';
import type { RunContext } from '../../src/core/harness/tokens.js';
import { processStartTime } from '../../src/core/harness/procinfo.js';
import { recordHarnessDecision } from '../../src/core/research/deps.js';
import {
  killOrphanGroup,
  orchestratorPrompt,
  resumeInterrupted,
  runPipeline,
  startPhase,
} from '../../src/core/research/orchestrator.js';
import { PHASE_TASK_TYPES } from '../../src/core/research/phases.js';
import { researchToolHandlers } from '../../src/core/research/tools.js';
import type { Store } from '../../src/core/store/db.js';
import { newId } from '../../src/core/store/repos.js';
import type { Phase, ResearchRun, Task } from '../../src/core/types.js';
import { researchSetup, review, submitWork, tick, type SetupOptions } from './helpers/research.js';

const opened: Store[] = [];
afterEach(() => {
  for (const s of opened.splice(0)) s.close();
});

const spec = (type: string, extra: Record<string, unknown> = {}) => ({
  type,
  brief: `do ${type}`,
  model: { provider: 'claude', model: 'sonnet' },
  needs_browser: false,
  acceptance_criteria: ['criterion'],
  ...extra,
});

const propose =
  (tasks: unknown[], sink?: unknown[]): FakeScript =>
  async (t) => {
    const r = await t.call('propose_tasks', { tasks });
    sink?.push(r);
  };
const nothing: FakeScript = async () => {};

function setup(opts: SetupOptions = {}) {
  const s = researchSetup(opened, { extraHandlers: () => researchToolHandlers(), ...opts });
  if (!s.store.workspaces.get('ws_a')) s.store.workspaces.insert({ id: 'ws_a', name: 'Acme', sector: 'saas', createdAt: new Date().toISOString() } as never);
  return s;
}

describe('orchestrator phases', () => {
  it('rejects task type not allowed in phase', async () => {
    const results: unknown[] = [];
    const s = setup({
      config: (c) => (c.limits.maxTasksPerRun = 2),
      pick: (r) => {
        if (r.kind === 'orchestrate') {
          return r.round === 1
            ? propose(
                [
                  spec('discover_competitors'),
                  spec('flow_walkthrough'),
                  spec('discover_competitors', { model: { provider: 'claude', model: 'gpt-x' } }),
                  spec('news_scan'),
                  spec('discover_competitors'),
                ],
                results,
              )
            : nothing;
        }
        return r.kind === 'work' ? submitWork() : review(9);
      },
    });
    const rr = await startPhase('ws_a', 'competitor_discovery', s.deps);
    expect(rr.status).toBe('done');
    const res = results[0] as { accepted: Array<{ index: number }>; rejected: Array<{ index: number; reason: string }> };
    expect(res.accepted.map((a) => a.index)).toEqual([0, 3]);
    expect(res.rejected.map((a) => a.index)).toEqual([1, 2, 4]);
    expect(res.rejected[0]!.reason).toMatch(/not allowed in phase 'competitor_discovery'/);
    expect(res.rejected[1]!.reason).toMatch(/not enabled/);
    expect(res.rejected[2]!.reason).toMatch(/maxTasksPerRun/);
    const tasks = s.store.tasks.list({ runId: rr.id });
    expect(tasks.map((t) => t.type)).toEqual(['discover_competitors', 'news_scan']);
    // The dispatcher wrote exactly one task_proposal decision for the call.
    expect(s.store.decisions.list({ kind: 'task_proposal' })).toHaveLength(1);
  });

  it('identical replayed propose_tasks from the same run inserts nothing new', async () => {
    const results: Array<Record<string, unknown>> = [];
    const tasks = [spec('news_scan'), spec('public_filings')];
    const s = setup({
      config: (c) => (c.limits.maxTasksPerRun = 3),
      pick: (r) => {
        if (r.kind === 'orchestrate') {
          return r.round === 1
            ? async (t) => {
                results.push((await t.call('propose_tasks', { tasks })) as Record<string, unknown>);
                results.push((await t.call('propose_tasks', { tasks })) as Record<string, unknown>); // replay
                // budget untouched by the replay: one more task still fits
                results.push((await t.call('propose_tasks', { tasks: [spec('news_scan', { brief: 'other' })] })) as Record<string, unknown>);
              }
            : nothing;
        }
        return r.kind === 'work' ? submitWork({ summary: 'x' }, `claim ${r.task!.id}`) : review(9);
      },
    });
    const rr = await startPhase('ws_a', 'deep_dives', s.deps);
    expect(results[1]).toEqual({ ...results[0], duplicate: true });
    expect((results[2]!.accepted as unknown[]).length).toBe(1);
    expect(s.store.tasks.list({ runId: rr.id })).toHaveLength(3);
    expect(s.store.decisions.list({ kind: 'task_proposal' })).toHaveLength(2);
  });

  it('runs accepted tasks through review loop', async () => {
    const s = setup({
      pick: (r) =>
        r.kind === 'orchestrate'
          ? r.round === 1
            ? propose([spec('news_scan'), spec('customer_pain_points')])
            : nothing
          : r.kind === 'work'
            ? submitWork({ summary: r.task!.type }, `claim ${r.task!.id}`)
            : review(8),
    });
    const rr = await startPhase('ws_a', 'deep_dives', s.deps);
    const tasks = s.store.tasks.list({ runId: rr.id });
    expect(tasks).toHaveLength(2);
    expect(tasks.every((t) => t.status === 'verified' && t.phase === 'deep_dives' && t.round === 1)).toBe(true);
    expect(s.requests.filter((r) => r.kind === 'review')).toHaveLength(2);
    expect(rr).toMatchObject({ status: 'done' });
    expect(rr.endedAt).toBeDefined();
  });

  it('max 2 orchestrator rounds', async () => {
    const s = setup({
      pick: (r) => (r.kind === 'orchestrate' ? propose([spec('news_scan')]) : r.kind === 'work' ? submitWork() : review(9)),
    });
    const rr = await startPhase('ws_a', 'deep_dives', s.deps);
    const orch = s.requests.filter((r) => r.kind === 'orchestrate');
    expect(orch.map((r) => r.round)).toEqual([1, 2]);
    expect(s.store.tasks.list({ runId: rr.id })).toHaveLength(2);
    expect(s.store.tasks.list({ runId: rr.id }).every((t) => t.status === 'verified')).toBe(true);
    // Follow-up round sees the first round's results.
    expect(orch[1]!.prompt).toMatch(/Results of this phase's tasks so far/);
    expect(orch[1]!.prompt).toContain('verified');
  });

  it('no follow-up round when the first round proposes nothing', async () => {
    const s = setup({ pick: () => nothing });
    const rr = await startPhase('ws_a', 'deep_dives', s.deps);
    expect(rr.status).toBe('done');
    expect(s.requests.filter((r) => r.kind === 'orchestrate')).toHaveLength(1);
  });

  it('failed task (retried once) is reported to the follow-up orchestrator round', async () => {
    const s = setup({
      pick: (r) => {
        if (r.kind === 'orchestrate') return r.round === 1 ? propose([spec('news_scan')]) : nothing;
        return async () => {
          throw new Error('CLI crashed: exit 2');
        };
      },
    });
    const rr = await startPhase('ws_a', 'deep_dives', s.deps);
    const [task] = s.store.tasks.list({ runId: rr.id });
    expect(task!.status).toBe('failed');
    expect(s.store.agentRuns.list({ taskId: task!.id }).map((r) => r.status)).toEqual(['failed', 'failed']);
    const followUp = s.requests.filter((r) => r.kind === 'orchestrate')[1]!.prompt;
    expect(followUp).toContain(task!.id);
    expect(followUp).toMatch(/FAILED: all attempts failed/);
    expect(followUp).toMatch(/run history: work r1 attempt 1 failed \(run failed \(exit 1; CLI crashed: exit 2\)\) → retried; work r1 attempt 2 failed .* → gave up/);
  });

  it('retry history is reported also when the retry succeeded, and carries into the next phase', async () => {
    let works = 0;
    const s = setup({
      pick: (r) => {
        if (r.kind === 'orchestrate') {
          const phase = r.prompt.match(/## Phase: (\w+)/)![1];
          return phase === 'competitor_discovery' && r.round === 1
            ? propose([spec('discover_competitors'), spec('news_scan')])
            : nothing;
        }
        if (r.kind === 'work') {
          // discover_competitors fails twice; news_scan fails once and then succeeds
          works++;
          if (r.task!.type === 'discover_competitors' || r.attempt === 1) {
            return async () => {
              throw new Error(`boom ${r.task!.type} ${r.attempt}`);
            };
          }
          return submitWork({ summary: 'ok' }, `claim ${r.task!.id}`);
        }
        return review(9);
      },
    });
    const rr = await startPhase('ws_a', 'competitor_discovery', s.deps);
    const [failed, retried] = s.store.tasks.list({ runId: rr.id });
    expect([failed!.status, retried!.status]).toEqual(['failed', 'verified']);
    const followUp = s.requests.filter((r) => r.kind === 'orchestrate')[1]!.prompt;
    expect(followUp).toMatch(new RegExp(`\\[${retried!.id}\\] news_scan → verified[\\s\\S]*run history: work r1 attempt 1 failed \\(.*boom news_scan 1.*\\) → retried; work r1 attempt 2 succeeded`));

    // Next phase: the orchestrator hears about both tasks.
    await startPhase('ws_a', 'deep_dives', s.deps);
    const next = s.requests.filter((r) => r.kind === 'orchestrate').at(-1)!.prompt;
    expect(next).toMatch(/## Phase: deep_dives/);
    expect(next).toContain(`Problems in the previous phase (competitor_discovery, ${rr.id})`);
    expect(next).toContain(`[${failed!.id}] discover_competitors → failed`);
    expect(next).toContain(`[${retried!.id}] news_scan → verified`);
    expect(next).toContain('boom discover_competitors 2');
    expect(works).toBe(4);
  });

  it('orchestrator context has profile, symptoms, findings, personas, goal, types and models', () => {
    const s = setup();
    s.store.profiles.insert({ workspaceId: 'ws_a', data: { model: 'B2B subscriptions' } });
    s.store.symptoms.insert({
      id: 'sym_1', workspaceId: 'ws_a', kind: 'symptom', title: 'renewals down', detail: 'd', criteria: {}, evidence: [],
    });
    s.store.findings.insert({
      id: 'fnd_1', workspaceId: 'ws_a', runId: 'r', taskId: 't', subject: 'Rival', claim: 'Rival cut prices',
      criteria: {}, evidence: ['art_1'], status: 'verified', createdAt: new Date().toISOString(),
    });
    s.store.personas.insert({
      id: 'per_1', workspaceId: 'ws_a', slug: 'ops-olivia', segment: 'ops', profile: {}, agentMdPath: 'x', version: 1,
    } as never);
    const rr: ResearchRun = { id: 'rrun_x', workspaceId: 'ws_a', phase: 'competitor_discovery', status: 'running', startedAt: '' };
    const p = orchestratorPrompt(s.store, s.config, rr, 1);
    for (const needle of ['B2B subscriptions', 'renewals down', '[fnd_1]', 'Rival cut prices', 'ops-olivia', 'Discover the competitors', 'discover_competitors', '"model":"sonnet"', '"model":"gpt-6.1-sol"']) {
      expect(p).toContain(needle);
    }
    expect(p).not.toContain('flow_walkthrough');
  });

  it('refuses a second concurrent phase in one workspace', async () => {
    const s = setup({ pick: () => () => new Promise<void>((r) => setTimeout(r, 50)) });
    const first = startPhase('ws_a', 'deep_dives', s.deps);
    await expect(startPhase('ws_a', 'synthesis', s.deps)).rejects.toThrow(/already has a running research run/);
    await first;
  });

  it('runPipeline runs phases in order', async () => {
    const calls: string[] = [];
    const s = setup({ pick: (r) => async () => void calls.push(`orchestrate:${r.prompt.match(/## Phase: (\w+)/)![1]}`) });
    s.deps.phaseRunners = {
      persona_panel: async () => void calls.push('runner:persona_panel'),
      scoring: async () => void calls.push('runner:scoring'),
    };
    const runs = await runPipeline('ws_a', ['scoring', 'market_research', 'persona_panel', 'synthesis'], s.deps);
    expect(runs.map((r) => r.phase)).toEqual(['market_research', 'synthesis', 'persona_panel', 'scoring']);
    expect(runs.every((r) => r.status === 'done')).toBe(true);
    expect(calls).toEqual(['orchestrate:market_research', 'orchestrate:synthesis', 'runner:persona_panel', 'runner:scoring']);
  });

  it('runPipeline stops after a failed phase (missing runner)', async () => {
    const s = setup({ pick: () => nothing });
    const runs = await runPipeline('ws_a', ['persona_panel', 'scoring'], s.deps);
    expect(runs.map((r) => [r.phase, r.status])).toEqual([['persona_panel', 'failed']]);
  });

  it('every phase has a goal and task types', () => {
    for (const phase of ['market_research', 'competitor_discovery', 'deep_dives', 'synthesis'] as Phase[]) {
      expect(PHASE_TASK_TYPES[phase].length).toBeGreaterThan(0);
    }
  });
});

describe('resumeInterrupted', () => {
  function seedPhase(store: Store, phase: Phase = 'deep_dives'): ResearchRun {
    const rr: ResearchRun = { id: newId('rrun'), workspaceId: 'ws_a', phase, status: 'running', startedAt: new Date().toISOString() };
    store.researchRuns.insert(rr);
    // The first orchestrator round already happened before the crash.
    recordHarnessDecision(
      store,
      { agentRunId: 'arun_orch', workspaceId: 'ws_a', role: 'orchestrator', model: { provider: 'claude', model: 'opus' }, promptVersion: 'p' },
      'decision',
      { event: 'orchestrator_round', researchRunId: rr.id, phase, round: 1 },
      [rr.id],
    );
    return rr;
  }
  const seedTask = (store: Store, rr: ResearchRun, extra: Partial<Task> = {}): Task =>
    store.tasks.insert({
      id: newId('tsk'), workspaceId: 'ws_a', runId: rr.id, phase: rr.phase, type: 'flow_walkthrough',
      brief: 'Walk the signup flow', model: { provider: 'claude', model: 'sonnet' }, needsBrowser: false,
      acceptanceCriteria: ['a screenshot per step'], status: 'running', round: 1, createdAt: new Date().toISOString(), ...extra,
    });

  it('pending user action survives store reopen and task resumes when resolved', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bif-resume-'));
    // --- process 1: a worker blocks on request_user_action, then the server dies.
    const s1 = setup({ dir });
    const rr = seedPhase(s1.store);
    const task = seedTask(s1.store, rr);
    const child = spawn('sleep', ['30'], { detached: true, stdio: 'ignore' });
    const exited = new Promise<NodeJS.Signals | null>((r) => child.on('exit', (_c, sig) => r(sig)));
    const ctx: RunContext = {
      agentRunId: newId('arun'), workspaceId: 'ws_a', taskId: task.id, role: 'worker',
      model: { provider: 'claude', model: 'sonnet' }, promptVersion: 'pv',
    };
    const token = s1.tokens.issue(ctx);
    s1.store.agentRuns.update(ctx.agentRunId, { pid: child.pid!, pidStartedAt: processStartTime(child.pid!)! });
    void s1.handle(ctx, 'request_user_action', { kind: 'register', site: 'acme.com', instructions: 'Please register' });
    await tick();
    expect(s1.store.tasks.get(task.id)!.status).toBe('waiting_user');
    s1.store.close(); // crash: rows stay as they were

    // --- process 2: fresh store, bus and registry.
    const s2 = setup({
      dir,
      pick: (r) => (r.kind === 'orchestrate' ? nothing : r.kind === 'work' ? submitWork() : review(9)),
    });
    const pending = s2.store.userRequests.list({ status: 'pending' });
    expect(pending).toHaveLength(1);
    const report = resumeInterrupted(s2.deps);
    expect(report.failedRuns).toEqual([ctx.agentRunId]);
    expect(report.waitingTasks).toEqual([task.id]);
    expect(report.continuedRuns).toEqual([rr.id]);
    expect(s2.store.agentRuns.get(ctx.agentRunId)).toMatchObject({ status: 'failed' });
    expect(s2.tokens.resolve(token)).toBeNull();
    expect(await exited).toBe('SIGKILL');

    await tick(50);
    expect(s2.store.tasks.get(task.id)!.status).toBe('waiting_user');
    expect(s2.store.userRequests.get(pending[0]!.id)!.status).toBe('pending');
    expect(s2.requests.filter((r) => r.kind === 'work')).toHaveLength(0);

    resolveUserRequest({ store: s2.store, events: s2.events }, pending[0]!.id, 'resolved', 'registered as Alex');
    const [done] = await report.done;
    expect(done).toMatchObject({ id: rr.id, status: 'done' });
    expect(s2.store.tasks.get(task.id)).toMatchObject({ status: 'verified', round: 1 });
    const work = s2.requests.find((r) => r.kind === 'work')!;
    expect(work.prompt).toContain('registered as Alex');
  });

  it('killOrphanGroup verifies the process start time before killing', async () => {
    const child = spawn('sleep', ['30'], { detached: true, stdio: 'ignore' });
    const exited = new Promise<NodeJS.Signals | null>((r) => child.on('exit', (_c, sig) => r(sig)));
    const started = processStartTime(child.pid!)!;
    expect(Number.isFinite(Date.parse(started))).toBe(true); // LC_ALL=C format
    expect(started).toMatch(/^[A-Z][a-z]{2} [A-Z][a-z]{2} +\d+ \d\d:\d\d:\d\d \d{4}$/);
    expect(killOrphanGroup(child.pid!, 'Mon Jan  1 00:00:00 2001')).toBe(false); // pid reused / before boot
    expect(killOrphanGroup(child.pid!, undefined)).toBe(false); // unverifiable
    expect(killOrphanGroup(child.pid!, started.replace(/\d\d:\d\d:\d\d/, '00:00:00'))).toBe(false); // other process
    expect(child.exitCode).toBeNull();
    expect(killOrphanGroup(child.pid!, started)).toBe(true);
    expect(await exited).toBe('SIGKILL');
  });

  it('re-queues running/reviewing tasks with the same round and continues the phase', async () => {
    const s = setup({ pick: (r) => (r.kind === 'orchestrate' ? nothing : r.kind === 'revise' ? submitWork() : review(9)) });
    const rr = seedPhase(s.store);
    const reviewing = seedTask(s.store, rr, { status: 'reviewing', round: 2, result: { summary: 'v2' } });
    const orphan = s.store.agentRuns.insert({
      id: newId('arun'), workspaceId: 'ws_a', taskId: reviewing.id, role: 'reviewer', model: { provider: 'codex', model: 'gpt-6.1-sol' },
      token: 'tok_orphan', status: 'running', startedAt: new Date().toISOString(), pid: 2 ** 22 + 12345, // no such process: ESRCH ignored
    });
    const report = resumeInterrupted(s.deps);
    expect(report.requeuedTasks).toEqual([reviewing.id]);
    expect(s.store.tasks.get(reviewing.id)).toMatchObject({ status: 'queued', round: 2 });
    expect(s.store.agentRuns.get(orphan.id)).toMatchObject({ status: 'failed', token: 'revoked:tok_orphan' });
    await report.done;
    expect(s.store.tasks.get(reviewing.id)).toMatchObject({ status: 'verified', round: 2 });
    // It resumed at review (deliverable present), no new work run.
    expect(s.requests.filter((r) => r.kind === 'work')).toHaveLength(0);
    expect(s.store.researchRuns.get(rr.id)!.status).toBe('done');
  });
});
