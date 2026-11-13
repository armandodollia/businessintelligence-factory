import { afterEach, describe, expect, it } from 'vitest';
import { diffRuns } from '../../src/core/scheduler/diff.js';
import { nextDue, startScheduler } from '../../src/core/scheduler/scheduler.js';
import type { Store } from '../../src/core/store/db.js';
import { newId } from '../../src/core/store/repos.js';
import type { Artifact, Finding, ResearchRun } from '../../src/core/types.js';
import { createWorkspace } from '../../src/core/workspace/tree.js';
import { researchSetup } from './helpers/research.js';

const opened: Store[] = [];
afterEach(() => {
  for (const s of opened.splice(0)) s.close();
});

const DAY = 24 * 3600_000;

function setup() {
  const t = researchSetup(opened);
  const ws = createWorkspace(t.store, { name: 'Acme', sector: 'saas' });
  const calls: string[] = [];
  t.deps.phaseRunners = {
    scoring: async (workspaceId) => {
      calls.push(workspaceId);
    },
  };
  return { ...t, ws, calls };
}

function addSchedule(
  store: Store,
  workspaceId: string,
  extra: { enabled?: boolean; lastRunAt?: string; cron?: string; activatedAt?: string } = {},
) {
  return store.schedules.insert({
    id: newId('sch'),
    workspaceId,
    name: 'daily scoring',
    cron: extra.cron ?? '0 9 * * *',
    phases: ['scoring'],
    enabled: extra.enabled ?? true,
    ...(extra.lastRunAt ? { lastRunAt: extra.lastRunAt } : {}),
    ...(extra.activatedAt ? { activatedAt: extra.activatedAt } : {}),
  });
}

describe('scheduler', () => {
  it('missed run executes on start', async () => {
    const t = setup();
    const now = Date.now();
    const s = addSchedule(t.store, t.ws.id, { lastRunAt: new Date(now - 3 * DAY).toISOString() });
    const sched = startScheduler(t.deps, () => now);
    await sched.idle();
    // Three missed daily runs → executed once, not three times.
    expect(t.calls).toEqual([t.ws.id]);
    expect(t.store.schedules.get(s.id)!.lastRunAt).toBe(new Date(now).toISOString());
    const runs = t.store.researchRuns.list({ workspaceId: t.ws.id });
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ phase: 'scoring', status: 'done' });
    // A later tick within the same day does not run it again.
    await sched.tick();
    await sched.idle();
    expect(t.calls).toHaveLength(1);
    sched.stop();
  });

  it('disabled schedule never runs', async () => {
    const t = setup();
    let now = Date.now();
    addSchedule(t.store, t.ws.id, { enabled: false, lastRunAt: new Date(now - 3 * DAY).toISOString() });
    const sched = startScheduler(t.deps, () => now);
    await sched.idle();
    now += 10 * DAY;
    await sched.tick();
    await sched.idle();
    sched.stop();
    expect(t.calls).toEqual([]);
    expect(t.store.researchRuns.list()).toHaveLength(0);
  });

  it('new schedule without lastRunAt waits for its next occurrence', async () => {
    const t = setup();
    let now = Date.now();
    addSchedule(t.store, t.ws.id);
    const sched = startScheduler(t.deps, () => now);
    await sched.idle();
    expect(t.calls).toEqual([]);
    now += 2 * DAY;
    await sched.tick();
    await sched.idle();
    sched.stop();
    expect(t.calls).toEqual([t.ws.id]);
  });

  it('a schedule created after its occurrence today waits until the next day (creation baseline)', async () => {
    const t = setup();
    // Server starts 08:00 local; a daily 09:00 schedule is created at 10:00.
    const start = new Date(2026, 10, 12, 8, 0, 0).getTime();
    let now = start;
    const sched = startScheduler(t.deps, () => now);
    await sched.idle();
    now = new Date(2026, 10, 12, 10, 0, 0).getTime();
    addSchedule(t.store, t.ws.id, { activatedAt: new Date(now).toISOString() });
    await sched.tick();
    await sched.idle();
    expect(t.calls).toEqual([]); // the 09:00 occurrence predates the schedule
    now = new Date(2026, 10, 13, 8, 59, 0).getTime();
    await sched.tick();
    await sched.idle();
    expect(t.calls).toEqual([]);
    now = new Date(2026, 10, 13, 9, 0, 30).getTime();
    await sched.tick();
    await sched.idle();
    sched.stop();
    expect(t.calls).toEqual([t.ws.id]);
  });

  it('re-enabled schedule does not run occurrences missed while disabled', async () => {
    const t = setup();
    const now = new Date(2026, 10, 12, 10, 0, 0).getTime();
    addSchedule(t.store, t.ws.id, {
      lastRunAt: new Date(now - 5 * DAY).toISOString(),
      activatedAt: new Date(now - 60_000).toISOString(),
    });
    const sched = startScheduler(t.deps, () => now);
    await sched.idle();
    sched.stop();
    expect(t.calls).toEqual([]);
  });

  it('skips a workspace that already has a running research run', async () => {
    const t = setup();
    const now = Date.now();
    addSchedule(t.store, t.ws.id, { lastRunAt: new Date(now - 3 * DAY).toISOString() });
    t.store.researchRuns.insert({
      id: newId('rrun'), workspaceId: t.ws.id, phase: 'deep_dives', status: 'running', startedAt: new Date().toISOString(),
    });
    const sched = startScheduler(t.deps, () => now);
    await sched.idle();
    sched.stop();
    expect(t.calls).toEqual([]);
  });

  it('records what changed against the previous run of the same phase', async () => {
    const t = setup();
    const now = Date.now();
    const prev = t.store.researchRuns.insert({
      id: newId('rrun'), workspaceId: t.ws.id, phase: 'scoring', status: 'done',
      startedAt: new Date(now - 5 * DAY).toISOString(), endedAt: new Date(now - 5 * DAY).toISOString(),
    });
    addFinding(t.store, t.ws.id, prev.id, 'Acme', 'Acme Pro costs $10/mo', []);
    t.deps.phaseRunners = {
      scoring: async (workspaceId, deps) => {
        const rr = deps.store.researchRuns.list({ workspaceId, status: 'running' })[0]!;
        addFinding(deps.store, workspaceId, rr.id, 'Acme', 'Acme Pro costs $12/mo', []);
      },
    };
    addSchedule(t.store, t.ws.id, { lastRunAt: new Date(now - 3 * DAY).toISOString() });
    const sched = startScheduler(t.deps, () => now);
    await sched.idle();
    sched.stop();
    const changes = t.store.decisions.list({ workspaceId: t.ws.id }).filter((d) => (d.payload as { event?: string }).event === 'what_changed');
    expect(changes).toHaveLength(1);
    const p = changes[0]!.payload as { prevRunId: string; newFindings: string[] };
    expect(p.prevRunId).toBe(prev.id);
    expect(p.newFindings).toHaveLength(1);
    expect(t.seen.some((e) => e.type === 'decision' && e.decision.id === changes[0]!.id)).toBe(true);
  });

  it('nextDue rejects invalid cron', () => {
    expect(() => nextDue('not a cron', new Date())).toThrow();
    expect(nextDue('0 9 * * *', new Date(2026, 10, 10, 8, 0)).getTime()).toBe(new Date(2026, 10, 10, 9, 0).getTime());
  });
});

// ---------------------------------------------------------------------------
// diff

function addRun(store: Store, workspaceId: string): ResearchRun {
  return store.researchRuns.insert({
    id: newId('rrun'), workspaceId, phase: 'deep_dives', status: 'done', startedAt: new Date().toISOString(),
  });
}

function addFinding(store: Store, workspaceId: string, runId: string, subject: string, claim: string, evidence: string[]): Finding {
  return store.findings.insert({
    id: newId('fnd'), workspaceId, runId, taskId: 'tsk_x', subject, claim, criteria: {}, evidence,
    status: 'verified', createdAt: new Date().toISOString(),
  });
}

function shot(t: ReturnType<typeof setup>, flow: string, step: number, content: string): Artifact {
  return t.artifacts.save({ workspaceId: t.ws.id, kind: 'screenshot', mime: 'image/png', flow, step, bytes: content });
}

describe('diffRuns', () => {
  it('diff detects changed screenshot for same flow step', () => {
    const t = setup();
    const a = addRun(t.store, t.ws.id);
    const b = addRun(t.store, t.ws.id);
    const s1 = shot(t, 'signup', 1, 'landing v1');
    const s2 = shot(t, 'signup', 2, 'form v1');
    addFinding(t.store, t.ws.id, a.id, 'Acme', 'Signup takes 2 steps', [s1.id, s2.id]);
    const s2b = shot(t, 'signup', 2, 'form v2 with phone field');
    addFinding(t.store, t.ws.id, b.id, 'Acme', 'Signup takes 2 steps', [s1.id, s2b.id]);

    const d = diffRuns(a.id, b.id, { store: t.store });
    expect(d.changedArtifacts).toEqual([{ flow: 'signup', step: 2, prev: s2.id, next: s2b.id }]);
    expect(d.newFindings).toEqual([]);
    expect(d.removedSubjects).toEqual([]);
  });

  it('new claims (e.g. changed pricing) are new findings; vanished subjects are removed', () => {
    const t = setup();
    const a = addRun(t.store, t.ws.id);
    const b = addRun(t.store, t.ws.id);
    addFinding(t.store, t.ws.id, a.id, 'Acme', 'Acme Pro costs $10/mo', []);
    addFinding(t.store, t.ws.id, a.id, 'Globex', 'Globex has a free tier', []);
    addFinding(t.store, t.ws.id, b.id, 'Acme', 'Acme Pro costs $10/mo.', []);
    const changed = addFinding(t.store, t.ws.id, b.id, 'Acme', 'Acme Enterprise costs $99/mo', []);
    const d = diffRuns(a.id, b.id, { store: t.store });
    expect(d.newFindings).toEqual([changed.id]);
    expect(d.removedSubjects).toEqual(['Globex']);
  });
});
