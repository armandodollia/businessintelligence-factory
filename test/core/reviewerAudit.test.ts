/**
 * Learning loop WP-F: reviewer audits. A verified task is re-reviewed by a different model with the
 * same minimal reviewer context (reads logged before the run starts); a miss (auditor fails work the
 * original reviewer passed) becomes a `weak-review` decision outcome and a lesson signal
 * (`auditMisses`). Audits never change the task, never cross business trees and leave normal metrics
 * alone (tagged runs and decisions).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { listOutcomes, taskLastReviewDecision } from '../../src/core/learning/outcomes.js';
import {
  auditMisses,
  auditModelFor,
  auditSummary,
  createAuditSchedule,
  listAudits,
  listAuditSchedules,
  runReviewerAudit,
  updateAuditSchedule,
} from '../../src/core/learning/reviewerAudit.js';
import { isAuditRun, runTags } from '../../src/core/learning/runTags.js';
import { promptVersionMetrics } from '../../src/core/metrics/promptMetrics.js';
import { lastReviewsByTask } from '../../src/core/research/outputs.js';
import { runTaskWithReview } from '../../src/core/research/reviewLoop.js';
import { startScheduler } from '../../src/core/scheduler/scheduler.js';
import { MIGRATIONS } from '../../src/core/store/migrations.js';
import type { Store } from '../../src/core/store/db.js';
import type { Task } from '../../src/core/types.js';
import { createWorkspace } from '../../src/core/workspace/tree.js';
import { addTask, researchSetup, review, submitWork, type Picker } from './helpers/research.js';

const opened: Store[] = [];
afterEach(() => {
  for (const s of opened.splice(0)) s.close();
});

/** A business tree (root + child) and a second tree; `verified(ws)` runs a task to `verified`. */
function world(audit: Picker = () => review(9)) {
  const s = researchSetup(opened, {
    pick: (r) => {
      if (r.kind === 'audit') return audit(r);
      if (r.kind === 'work') {
        return async (t) => {
          await t.call('log_decision', { what: 'WORKER_SECRET_REASONING', why: 'transcript', confidence: 0.5 });
          await submitWork({ summary: `DELIVERABLE ${r.task?.subject}` })(t);
        };
      }
      return r.kind === 'review' ? review(9) : undefined;
    },
  });
  const root = createWorkspace(s.store, { name: 'Acme', sector: 'saas' });
  const child = createWorkspace(s.store, { name: 'Acme Pay', sector: 'saas', parentWorkspaceId: root.id });
  const other = createWorkspace(s.store, { name: 'Globex', sector: 'saas' });
  const verified = async (workspaceId: string, subject = 'Acme'): Promise<Task> =>
    runTaskWithReview(addTask(s.store, { workspaceId, subject }), s.deps);
  return { ...s, root, child, other, verified };
}

describe('migration 20 (learning loop WP-F)', () => {
  it('is applied and adds audits, experiments, schedules and the run / decision / task tags', () => {
    const s = researchSetup(opened);
    expect(s.store.schemaVersion()).toBe(MIGRATIONS.length);
    const m = MIGRATIONS.find((x) => x.includes('CREATE TABLE reviewer_audits'));
    expect(m).toMatch(/CREATE TABLE experiments/);
    expect(m).toMatch(/CREATE TABLE audit_schedules/);
    const cols = (t: string) => (s.store.db.prepare(`PRAGMA table_info(${t})`).all() as Array<{ name: string }>).map((c) => c.name);
    expect(cols('agent_runs')).toEqual(expect.arrayContaining(['experiment_id', 'arm', 'audit_id', 'lessons_off']));
    expect(cols('decisions')).toEqual(expect.arrayContaining(['experiment_id', 'arm', 'audit_id']));
    expect(cols('tasks')).toEqual(expect.arrayContaining(['experiment_id', 'arm']));
  });
});

describe('auditModelFor', () => {
  it('prefers another provider than the original reviewer (and the worker), else another model, else none', () => {
    const s = researchSetup(opened);
    const c = s.config;
    c.providers.opencode = { enabled: true, command: 'opencode', models: ['big-pickle'] };
    expect(auditModelFor({ provider: 'codex', model: 'gpt-6.1-sol' }, { provider: 'claude', model: 'sonnet' }, c)).toEqual({ provider: 'opencode', model: 'big-pickle' });
    c.providers.opencode.enabled = false;
    expect(auditModelFor({ provider: 'codex', model: 'gpt-6.1-sol' }, { provider: 'claude', model: 'sonnet' }, c)).toEqual({ provider: 'claude', model: 'opus' });
    // A configured auditor wins when it differs from the original reviewer.
    c.audit = { model: { provider: 'claude', model: 'haiku' } };
    expect(auditModelFor({ provider: 'codex', model: 'gpt-6.1-sol' }, { provider: 'claude', model: 'sonnet' }, c)).toEqual({ provider: 'claude', model: 'haiku' });
    expect(auditModelFor({ provider: 'claude', model: 'haiku' }, { provider: 'claude', model: 'sonnet' }, c)).toEqual({ provider: 'codex', model: 'gpt-6.1-sol' });
    // Only one provider: another model of it; only one model: no auditor.
    delete c.audit;
    c.providers.codex.enabled = false;
    expect(auditModelFor({ provider: 'claude', model: 'opus' }, { provider: 'claude', model: 'opus' }, c)).toEqual({ provider: 'claude', model: 'sonnet' });
    c.providers.claude.models = ['opus'];
    expect(auditModelFor({ provider: 'claude', model: 'opus' }, { provider: 'claude', model: 'opus' }, c)).toBeUndefined();
  });
});

describe('runReviewerAudit', () => {
  it('re-reviews recently verified tasks with a different model and the same minimal context; agree writes no outcome', async () => {
    let seenReadsBeforeStart = -1;
    const w = world(() => async (t) => {
      // The audit run's prompt reads are logged before the agent starts.
      const run = w.store.agentRuns.list({ role: 'reviewer', status: 'running' }).find((r) => isAuditRun(w.store, r.id))!;
      seenReadsBeforeStart = (w.store.db.prepare('SELECT COUNT(*) AS n FROM retrieval_events WHERE agent_run_id = ?').get(run.id) as { n: number }).n;
      await review(9)(t);
    });
    const task = await w.verified(w.root.id);
    const original = taskLastReviewDecision(w.store, task)!;
    const before = lastReviewsByTask(w.store, [w.root.id]).get(task.id);

    const audits = await runReviewerAudit(w.deps, { workspaceId: w.root.id, n: 5, actor: 'alice' });
    expect(audits).toHaveLength(1);
    const a = audits[0]!;
    expect(a).toMatchObject({
      status: 'done', verdict: 'agree', taskId: task.id, rootWorkspaceId: w.root.id, startedBy: 'api', actor: 'alice',
      originalDecisionId: original.id, originalScore: 9, auditScore: 9, passThreshold: 8,
    });
    expect(a.originalModel).toEqual({ provider: 'codex', model: 'gpt-6.1-sol' });
    expect(a.auditModel).toEqual({ provider: 'claude', model: 'opus' });
    expect(a.outcomeId).toBeUndefined();
    expect(seenReadsBeforeStart).toBeGreaterThan(0);

    // Same minimal reviewer context as the original review: brief, criteria, deliverable, outputs, evidence ids.
    const [orig, audit] = [w.requests.find((r) => r.kind === 'review')!, w.requests.find((r) => r.kind === 'audit')!];
    expect(audit.role).toBe('reviewer');
    expect(audit.prompt).toBe(orig.prompt);
    expect(audit.systemPrompt).toBe(orig.systemPrompt);
    expect(audit.prompt).not.toContain('WORKER_SECRET_REASONING');
    expect(audit.promptReads?.length).toBe(orig.promptReads?.length);

    // Tagged run and decision; the task, its last review and normal metrics are untouched.
    expect(runTags(w.store, a.auditRunId!)).toMatchObject({ auditId: a.id, lessonsOff: false });
    expect((w.store.db.prepare('SELECT audit_id AS u FROM decisions WHERE id = ?').get(a.auditDecisionId!) as { u: string }).u).toBe(a.id);
    expect(w.store.tasks.get(task.id)!.status).toBe('verified');
    expect(taskLastReviewDecision(w.store, task)!.id).toBe(original.id);
    expect(lastReviewsByTask(w.store, [w.root.id]).get(task.id)).toEqual(before);
    const reviewerRuns = promptVersionMetrics(w.store, w.root.id, { role: 'reviewer' }).reduce((n, m) => n + m.runs, 0);
    expect(reviewerRuns).toBe(1);
  });

  it('a miss is a weak-review outcome on the original review and a lesson signal for its tree', async () => {
    const w = world(() => review(4, [{ class: 'blocking', description: 'no dated source' }, { class: 'nit', description: 'typo' }]));
    const task = await w.verified(w.child.id);
    const original = taskLastReviewDecision(w.store, task)!;
    const [a] = await runReviewerAudit(w.deps, { workspaceId: w.root.id });
    expect(a).toMatchObject({ verdict: 'miss', auditScore: 4, workspaceId: w.child.id, rootWorkspaceId: w.root.id });
    const outcomes = listOutcomes(w.store, { decisionId: original.id, source: 'reviewer_audit' });
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]).toMatchObject({
      id: a!.outcomeId, label: 'weak-review', outcome: 'audit_failed', role: 'reviewer', promptVersion: original.promptVersion,
      taskId: task.id, targetType: 'task', targetId: task.id, actor: 'system',
    });
    expect(outcomes[0]!.evidenceJson).toMatchObject({ auditId: a!.id, auditScore: 4, originalScore: 9 });

    const misses = auditMisses(w.store, { rootWorkspaceId: w.root.id });
    expect(misses).toEqual([
      expect.objectContaining({
        auditId: a!.id, taskId: task.id, role: 'reviewer', promptVersion: original.promptVersion, classes: ['blocking', 'nit'],
        originalScore: 9, auditScore: 4, outcomeId: a!.outcomeId,
      }),
    ]);
    // Per tree: another tree sees nothing; a second audit of the same review does not repeat it.
    expect(auditMisses(w.store, { rootWorkspaceId: w.other.id })).toEqual([]);
    expect(await runReviewerAudit(w.deps, { workspaceId: w.root.id })).toEqual([]);
    expect(auditSummary(listAudits(w.store, { rootWorkspaceId: w.root.id }))).toMatchObject({ total: 1, miss: 1, missRate: 1 });
  });

  it('an auditor without a valid review is invalid, not a miss', async () => {
    const w = world(() => async () => {});
    await w.verified(w.root.id);
    const [a] = await runReviewerAudit(w.deps, { workspaceId: w.root.id });
    expect(a).toMatchObject({ verdict: 'invalid', status: 'done' });
    expect(listOutcomes(w.store, { source: 'reviewer_audit' })).toEqual([]);
    expect(auditMisses(w.store, { rootWorkspaceId: w.root.id })).toEqual([]);
  });

  it('never crosses business trees and takes the N most recently verified tasks', async () => {
    const w = world();
    const t1 = await w.verified(w.root.id, 'first');
    const t2 = await w.verified(w.child.id, 'second');
    const foreign = await w.verified(w.other.id, 'foreign');
    const unverified = addTask(w.store, { workspaceId: w.root.id, status: 'unverified' });
    const audits = await runReviewerAudit(w.deps, { workspaceId: w.child.id, n: 1 });
    expect(audits.map((a) => a.taskId)).toEqual([t2.id]);
    const more = await runReviewerAudit(w.deps, { workspaceId: w.root.id, n: 10 });
    expect(more.map((a) => a.taskId)).toEqual([t1.id]);
    const all = listAudits(w.store, { rootWorkspaceId: w.root.id }).map((a) => a.taskId);
    expect(all).not.toContain(foreign.id);
    expect(all).not.toContain(unverified.id);
    // Explicit task ids from another tree are refused.
    await expect(runReviewerAudit(w.deps, { workspaceId: w.root.id, taskIds: [foreign.id] })).rejects.toThrow(/not a verified task of this business tree/);
  });

  it('skips when no different model is configured', async () => {
    const w = world();
    const task = await w.verified(w.root.id);
    w.config.providers.codex.enabled = false;
    w.config.providers.claude.models = ['opus'];
    // Make the original reviewer the only model left.
    w.store.db.prepare(`UPDATE agent_runs SET model = ? WHERE role = 'reviewer'`).run(JSON.stringify({ provider: 'claude', model: 'opus' }));
    w.store.db.prepare(`UPDATE decisions SET model = ? WHERE role = 'reviewer'`).run(JSON.stringify({ provider: 'claude', model: 'opus' }));
    const [a] = await runReviewerAudit(w.deps, { workspaceId: w.root.id });
    expect(a).toMatchObject({ taskId: task.id, verdict: 'skipped', status: 'done', reason: expect.stringMatching(/no different model/) });
    expect(w.requests.filter((r) => r.kind === 'audit')).toHaveLength(0);
  });
});

describe('audit schedules (existing scheduler)', () => {
  it('a due audit schedule runs an audit of its tree with startedBy schedule', async () => {
    const w = world();
    const task = await w.verified(w.root.id);
    const sched = createAuditSchedule(w.store, { workspaceId: w.child.id, cron: '* * * * *', n: 3, actor: 'alice' });
    expect(sched).toMatchObject({ rootWorkspaceId: w.root.id, enabled: true, n: 3 });
    expect(listAuditSchedules(w.store, w.root.id)).toHaveLength(1);
    expect(() => createAuditSchedule(w.store, { workspaceId: w.root.id, cron: 'nope', n: 1 })).toThrow(/invalid cron/);
    let now = Date.now();
    const handle = startScheduler({ ...w.deps, intervalMs: 3_600_000 }, () => now);
    try {
      now += 61_000;
      await handle.tick();
      await handle.idle();
    } finally {
      handle.stop();
    }
    const audits = listAudits(w.store, { rootWorkspaceId: w.root.id });
    expect(audits).toEqual([expect.objectContaining({ taskId: task.id, startedBy: 'schedule', actor: 'scheduler', scheduleId: sched.id, verdict: 'agree' })]);
    expect(listAuditSchedules(w.store, w.root.id)[0]!.lastRunAt).toBeDefined();
    expect(updateAuditSchedule(w.store, sched.id, { enabled: false }).enabled).toBe(false);
  });
});
