import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { learningRepos } from '../../src/core/learning/store.js';
import {
  type RecordOutcomeInput,
  listOutcomes,
  outcomeReport,
  outputSaveDecision,
  recordOutcome,
  recordOverrideOutcome,
} from '../../src/core/learning/outcomes.js';
import { setIncludeInSynthesis } from '../../src/core/evidence/synthesis.js';
import { decideUnitProposal, setIncludeOverride } from '../../src/core/feedback/actions.js';
import { feedbackOutcomesRegistered, outcomesFromFeedback, registerFeedbackOutcomes } from '../../src/core/learning/feedbackOutcomes.js';
import { OUTCOME_LABELS } from '../../src/core/learning/types.js';
import { resumeInterrupted } from '../../src/core/research/orchestrator.js';
import { setOutputInclude } from '../../src/core/research/outputs.js';
import { runTaskWithReview } from '../../src/core/research/reviewLoop.js';
import { recordWhatChanged } from '../../src/core/scheduler/whatChanged.js';
import type { Store } from '../../src/core/store/db.js';
import { MIGRATIONS } from '../../src/core/store/migrations.js';
import { newId } from '../../src/core/store/repos.js';
import type { Decision, Finding, ResearchRun } from '../../src/core/types.js';
import { rejectUnitProposal } from '../../src/core/workspace/businessMap.js';
import { createWorkspace } from '../../src/core/workspace/tree.js';
import { addTask, researchSetup, review, revise, submitWork } from './helpers/research.js';

const opened: Store[] = [];
afterEach(() => {
  for (const s of opened.splice(0)) s.close();
});

const outcomesOf = (store: Store) => learningRepos(store).decisionOutcomes.list();

function agentDecision(store: Store, extra: Partial<Decision> = {}): Decision {
  return store.decisions.insert({
    id: newId('dec'), workspaceId: 'ws_a', agentRunId: 'run_x', role: 'worker', model: { provider: 'claude', model: 'sonnet' },
    kind: 'decision', payload: { tool: 'log_decision', what: 'x' }, refs: [], promptVersion: 'pv1', createdAt: new Date().toISOString(),
    ...extra,
  });
}

describe('migration 16 (learning loop WP-C)', () => {
  it('is migration 16 and creates both tables', () => {
    const s = researchSetup(opened);
    expect(s.store.schemaVersion()).toBe(MIGRATIONS.length);
    expect(MIGRATIONS[15]).toMatch(/CREATE TABLE decision_outcomes/);
    expect(MIGRATIONS[15]).toMatch(/CREATE TABLE review_issues/);
    expect(learningRepos(s.store).decisionOutcomes.list()).toEqual([]);
    expect(learningRepos(s.store).reviewIssues.list()).toEqual([]);
  });
});

describe('recordOutcome', () => {
  it('copies role, prompt version and task type from the judged decision and its run', () => {
    const s = researchSetup(opened);
    const task = addTask(s.store, { type: 'public_filings' });
    s.store.agentRuns.insert({
      id: 'run_x', workspaceId: 'ws_a', taskId: task.id, role: 'worker', model: { provider: 'claude', model: 'sonnet' },
      token: 'tok', status: 'done', startedAt: new Date().toISOString(), promptVersion: 'pv1',
    });
    const d = agentDecision(s.store);
    const o = recordOutcome(s.store, { decisionId: d.id, outcome: 'verified', label: 'confirmed', source: 'review_loop', evidence: { round: 1 } });
    expect(o).toMatchObject({
      workspaceId: 'ws_a', decisionId: d.id, outcome: 'verified', label: 'confirmed', source: 'review_loop', actor: 'system',
      role: 'worker', promptVersion: 'pv1', taskId: task.id, taskType: 'public_filings', evidenceJson: { round: 1 },
    });
    expect(outcomesOf(s.store)).toHaveLength(1);
  });

  it('automatic sources are idempotent; user sources append (history) with the user as actor', () => {
    const s = researchSetup(opened);
    const d = agentDecision(s.store);
    const auto = { decisionId: d.id, outcome: 'superseded', label: 'missed-evidence', source: 'supersede', targetType: 'finding', targetId: 'fnd_1' } as const;
    const first = recordOutcome(s.store, auto);
    expect(recordOutcome(s.store, auto)?.id).toBe(first?.id);
    const user = { decisionId: d.id, outcome: 'excluded', label: 'user-rejected', source: 'user_override', targetType: 'finding', targetId: 'fnd_1' } as const;
    recordOutcome(s.store, user);
    const second = recordOutcome(s.store, { ...user, actor: 'alice' });
    expect(outcomesOf(s.store)).toHaveLength(3);
    expect(outcomesOf(s.store)[1]!.actor).toBe('local-user');
    expect(second?.actor).toBe('alice');
  });

  it('returns undefined for an unknown decision (nothing written)', () => {
    const s = researchSetup(opened);
    expect(recordOutcome(s.store, { decisionId: 'dec_nope', outcome: 'x', label: 'stale', source: 'what_changed' })).toBeUndefined();
    expect(outcomesOf(s.store)).toEqual([]);
  });
});

describe('recordOutcome on non-decision subjects (integration: knowledge-store lineage)', () => {
  const cols = (s: ReturnType<typeof researchSetup>) =>
    (s.store.db.prepare('PRAGMA table_info(decision_outcomes)').all() as Array<{ name: string; notnull: number }>);

  it('migration 16: decision_id nullable, subject / run / source_key columns, CHECK decision or subject, unique source key', () => {
    const s = researchSetup(opened);
    const c = cols(s);
    expect(c.find((x) => x.name === 'decision_id')!.notnull).toBe(0);
    expect(c.map((x) => x.name)).toEqual(expect.arrayContaining(['subject_type', 'subject_id', 'run_id', 'source_key']));
    const insert = (id: string, decision: string | null, subject: string | null, key: string | null) =>
      s.store.db
        .prepare(
          `INSERT INTO decision_outcomes (id, workspace_id, decision_id, subject_type, subject_id, outcome, label, evidence_json, source, source_key, created_at)
           VALUES (?, 'ws_a', ?, ?, ?, 'stale', 'stale', '{}', 'fact_lineage', ?, 'x')`,
        )
        .run(id, decision, subject ? 'fact_version' : null, subject, key);
    expect(() => insert('d1', null, null, null)).toThrow(/CHECK/);
    insert('d2', null, 'fv_1', 'k1');
    expect(() => insert('d3', null, 'fv_1', 'k1')).toThrow(/UNIQUE/);
    insert('d4', null, 'fv_1', 'k2');
    insert('d5', null, 'fv_2', 'k1');
  });

  it('labels include confirmed, changed, retracted, stale and user-rejected', () => {
    expect(OUTCOME_LABELS).toEqual(expect.arrayContaining(['confirmed', 'changed', 'retracted', 'stale', 'user-rejected']));
  });

  it('stale on a synthetic subject without a decision: idempotent per (subject, outcome, caller sourceKey)', () => {
    const s = researchSetup(opened);
    const stale = (lastConfirmedAt: string): RecordOutcomeInput => ({
      workspaceId: 'ws_a', subjectType: 'test_fact', subjectId: 'fact_1', outcome: 'stale', label: 'stale', source: 'fact_lineage',
      sourceKey: `fact_1|stale|${lastConfirmedAt}`, evidence: { lastConfirmedAt },
    });
    const a = recordOutcome(s.store, stale('2026-10-01T00:00:00Z'))!;
    expect(a).toMatchObject({ subjectType: 'test_fact', subjectId: 'fact_1', label: 'stale', actor: 'system', sourceKey: 'fact_1|stale|2026-10-01T00:00:00Z' });
    expect(a.decisionId).toBeUndefined();
    expect(recordOutcome(s.store, stale('2026-10-01T00:00:00Z'))!.id).toBe(a.id);
    const b = recordOutcome(s.store, stale('2026-11-01T00:00:00Z'))!; // re-confirmed, then stale again
    expect(b.id).not.toBe(a.id);
    expect(outcomesOf(s.store)).toHaveLength(2);
  });

  it('a subject version attaches to its saving decision when one exists (role, prompt version, run copied)', () => {
    const s = researchSetup(opened);
    s.store.agentRuns.insert({
      id: 'run_x', workspaceId: 'ws_a', role: 'worker', model: { provider: 'claude', model: 'sonnet' },
      token: 'tok', status: 'done', startedAt: new Date().toISOString(), promptVersion: 'pv1',
    });
    const save = agentDecision(s.store, { payload: { tool: 'save_fact', factVersionId: 'fv_1' } });
    const obs = (kind: 'confirmed' | 'changed' | 'retracted', obsId: string, decisionId?: string): RecordOutcomeInput => ({
      workspaceId: 'ws_a', subjectType: 'test_fact_version', subjectId: 'fv_1', outcome: kind, label: kind, source: 'fact_lineage',
      sourceKey: obsId, ...(decisionId ? { decisionId } : {}),
    });
    const changed = recordOutcome(s.store, obs('changed', 'obs_1', save.id))!;
    expect(changed).toMatchObject({ decisionId: save.id, subjectId: 'fv_1', role: 'worker', promptVersion: 'pv1', runId: 'run_x', label: 'changed' });
    expect(recordOutcome(s.store, obs('changed', 'obs_1', save.id))!.id).toBe(changed.id);
    recordOutcome(s.store, obs('confirmed', 'obs_2', save.id));
    // Same observation key, different outcome → its own row.
    recordOutcome(s.store, obs('retracted', 'obs_2', save.id));
    // No saving decision known: still written on the subject, with the caller's run when given.
    const loose = recordOutcome(s.store, { ...obs('retracted', 'obs_3'), runId: 'run_x', role: 'worker', promptVersion: 'pv1' })!;
    expect(loose).toMatchObject({ runId: 'run_x', role: 'worker', promptVersion: 'pv1' });
    expect(loose.decisionId).toBeUndefined();
    expect(outcomesOf(s.store).map((o) => [o.outcome, o.sourceKey])).toEqual([
      ['changed', 'obs_1'], ['confirmed', 'obs_2'], ['retracted', 'obs_2'], ['retracted', 'obs_3'],
    ]);
  });

  it('run_id is filled from an agent decision, never from a system decision', () => {
    const s = researchSetup(opened);
    s.store.agentRuns.insert({
      id: 'run_y', workspaceId: 'ws_a', role: 'worker', model: { provider: 'claude', model: 'sonnet' },
      token: 'tok', status: 'done', startedAt: new Date().toISOString(), promptVersion: 'pv1',
    });
    const agent = agentDecision(s.store, { agentRunId: 'run_y' });
    expect(recordOutcome(s.store, { decisionId: agent.id, outcome: 'verified', label: 'confirmed', source: 'review_loop' })!.runId).toBe('run_y');
    const sys = agentDecision(s.store, { agentRunId: 'scheduler', role: 'orchestrator', promptVersion: 'n/a', payload: { actor: 'scheduler' } });
    expect(recordOutcome(s.store, { decisionId: sys.id, outcome: 'x', label: 'stale', source: 'what_changed' })!.runId).toBeUndefined();
  });

  it('a subject without a decision needs a workspace; neither decision nor subject writes nothing', () => {
    const s = researchSetup(opened);
    expect(() => recordOutcome(s.store, { subjectType: 'test_fact', subjectId: 'f', outcome: 'stale', label: 'stale', source: 'fact_lineage' } as RecordOutcomeInput)).toThrow(/workspace/);
    expect(recordOutcome(s.store, { workspaceId: 'ws_a', outcome: 'stale', label: 'stale', source: 'fact_lineage' } as RecordOutcomeInput)).toBeUndefined();
    expect(outcomesOf(s.store)).toEqual([]);
  });

  it('feedback-driven outcomes are keyed on the feedback event (replaying the event writes nothing more)', async () => {
    const s = researchSetup(opened);
    s.store.recommendations.insert({
      id: 'rec_9', workspaceId: 'ws_a', title: 'T', summary: 's', criteria: {}, findingIds: [], personaFeedback: [],
      priority: 1, createdAt: new Date().toISOString(), status: 'unverified',
    });
    agentDecision(s.store, { role: 'synthesizer', payload: { tool: 'save_recommendation', recommendationId: 'rec_9' }, refs: ['rec_9'] });
    const release = registerFeedbackOutcomes();
    try {
      setIncludeOverride(s.store, 'recommendation', 'rec_9', true, { actor: 'ana' });
    } finally {
      release();
    }
    const [o] = outcomesOf(s.store);
    expect(o).toMatchObject({ label: 'confirmed', sourceKey: `feedback:${String(o!.evidenceJson.feedbackEventId)}` });
    const { latestFeedback } = await import('../../src/core/feedback/events.js');
    outcomesFromFeedback(s.store, latestFeedback(s.store, { kind: 'include_override' })!);
    expect(outcomesOf(s.store)).toHaveLength(1);
  });

  it('the outcomes report groups subject-only outcomes without a role or prompt version', () => {
    const s = researchSetup(opened);
    recordOutcome(s.store, { workspaceId: 'ws_a', subjectType: 'test_fact', subjectId: 'f1', outcome: 'stale', label: 'stale', source: 'fact_lineage', sourceKey: 'k' });
    expect(outcomeReport(s.store, ['ws_a']).rows).toEqual([{ counts: { stale: 1 }, total: 1 }]);
  });
});

describe('task end outcomes (review loop)', () => {
  it('verified task → confirmed on its deliverable decision', async () => {
    const s = researchSetup(opened, { pick: (r) => (r.kind === 'work' ? submitWork() : review(9)) });
    const task = addTask(s.store);
    await runTaskWithReview(task, s.deps);
    const [o] = outcomesOf(s.store);
    const d = s.store.decisions.get(o!.decisionId!)!;
    expect((d.payload as { tool: string }).tool).toBe('submit_result');
    expect(o).toMatchObject({ outcome: 'verified', label: 'confirmed', source: 'review_loop', taskId: task.id, targetType: 'task', taskType: 'news_scan', role: 'worker' });
    expect(o!.evidenceJson).toMatchObject({ round: 1, score: 9 });
  });

  it('unverified on scope-expansion issues only → over-scoped; on substantive issues → missed-evidence', async () => {
    const scope = researchSetup(opened, {
      config: (c) => (c.loop.maxRounds = 1),
      pick: (r) => (r.kind === 'work' ? submitWork() : review(5, [{ class: 'scope_expansion', description: 'also cover Europe' }])),
    });
    await runTaskWithReview(addTask(scope.store), scope.deps);
    expect(outcomesOf(scope.store).map((o) => [o.outcome, o.label])).toEqual([['unverified', 'over-scoped']]);

    const thin = researchSetup(opened, {
      config: (c) => (c.loop.maxRounds = 1),
      pick: (r) => (r.kind === 'work' ? submitWork() : review(5, [{ class: 'substantive', description: 'no source date' }])),
    });
    await runTaskWithReview(addTask(thin.store), thin.deps);
    expect(outcomesOf(thin.store).map((o) => [o.outcome, o.label])).toEqual([['unverified', 'missed-evidence']]);
  });

  it('unverified after a malformed final review → weak-review', async () => {
    const s = researchSetup(opened, {
      config: (c) => (c.loop.maxRounds = 1),
      pick: (r) => (r.kind === 'work' ? submitWork() : async () => {}),
    });
    await runTaskWithReview(addTask(s.store), s.deps);
    expect(outcomesOf(s.store).map((o) => [o.outcome, o.label])).toEqual([['unverified', 'weak-review']]);
  });

  it('failed task → run-failed on the failed worker run decision', async () => {
    const s = researchSetup(opened, { pick: (r) => (r.kind === 'work' ? async () => {} : review(9)) });
    const task = addTask(s.store);
    expect((await runTaskWithReview(task, s.deps)).status).toBe('failed');
    const [o] = outcomesOf(s.store);
    expect(o).toMatchObject({ outcome: 'failed', label: 'run-failed', taskId: task.id });
    expect((s.store.decisions.get(o!.decisionId!)!.payload as { event: string }).event).toBe('worker_run_failed');
  });

  it('superseded outputs → missed-evidence on their save decision', async () => {
    let reviews = 0;
    const s = researchSetup(opened, {
      pick: (r) => {
        if (r.kind === 'work') return submitWork({ summary: 'v1' }, 'Acme costs $10');
        if (r.kind === 'review') return review(++reviews === 1 ? 5 : 9, reviews === 1 ? [{ class: 'blocking', description: 'price is wrong' }] : []);
        return async (t) => {
          await revise('fix', { summary: 'v2' }, false)(r)(t);
        };
      },
    });
    const task = addTask(s.store);
    expect((await runTaskWithReview(task, s.deps)).status).toBe('verified');
    const finding = s.store.findings.list({ taskId: task.id })[0]!;
    expect(finding.status).toBe('superseded');
    const sup = outcomesOf(s.store).find((o) => o.outcome === 'superseded')!;
    expect(sup).toMatchObject({ label: 'missed-evidence', source: 'supersede', targetType: 'finding', targetId: finding.id });
    expect(sup.decisionId).toBe(outputSaveDecision(s.store, 'finding', finding.id)?.id);
  });

  it('a task abandoned at startup recovery → run-failed', () => {
    const s = researchSetup(opened);
    const task = addTask(s.store, { status: 'running', runId: 'rrun_gone' });
    s.store.agentRuns.insert({
      id: 'run_w', workspaceId: 'ws_a', taskId: task.id, role: 'worker', model: { provider: 'claude', model: 'sonnet' },
      token: 'tok_w', status: 'done', startedAt: new Date().toISOString(), promptVersion: 'pv1',
    });
    agentDecision(s.store, { agentRunId: 'run_w', payload: { tool: 'submit_result', result: {} }, refs: [task.id] });
    const report = resumeInterrupted(s.deps);
    expect(report.abandonedTasks).toEqual([task.id]);
    expect(outcomesOf(s.store).map((o) => [o.outcome, o.label, o.taskId])).toEqual([['failed', 'run-failed', task.id]]);
  });
});

describe('user override / reject outcomes (one path: feedback events → onFeedback listener → recordOutcome)', () => {
  let unregister: () => void = () => {};
  beforeAll(() => {
    unregister = registerFeedbackOutcomes();
  });
  afterAll(() => unregister());

  async function verifiedTask() {
    const s = researchSetup(opened, { pick: (r) => (r.kind === 'work' ? submitWork() : review(9)) });
    const task = addTask(s.store);
    await runTaskWithReview(task, s.deps);
    learningRepos(s.store).decisionOutcomes.list(); // task-end outcome exists
    return { s, task, finding: s.store.findings.list({ taskId: task.id })[0]! };
  }
  const userOutcomes = (store: Store) => outcomesOf(store).filter((o) => o.source === 'user_override' || o.source === 'user_reject');

  it('registration is idempotent', () => {
    expect(feedbackOutcomesRegistered()).toBe(true);
    const again = registerFeedbackOutcomes();
    again();
    expect(feedbackOutcomesRegistered()).toBe(true);
  });

  it('excluding a verified finding → user-rejected on its save decision + weak-review on the passing review, by the actor', async () => {
    const { s, finding, task } = await verifiedTask();
    setIncludeOverride(s.store, 'finding', finding.id, false, { actor: 'ana', reason: 'wrong company' });
    const user = userOutcomes(s.store);
    expect(user.map((o) => [o.outcome, o.label, o.targetId])).toEqual([
      ['excluded', 'user-rejected', finding.id],
      ['excluded_after_pass', 'weak-review', finding.id],
    ]);
    expect(user[0]!.decisionId).toBe(outputSaveDecision(s.store, 'finding', finding.id)?.id);
    const reviewDecision = s.store.decisions.get(user[1]!.decisionId!)!;
    expect(reviewDecision).toMatchObject({ kind: 'review', role: 'reviewer' });
    expect(user[1]!.taskId).toBe(task.id);
    expect(user.every((o) => o.actor === 'ana')).toBe(true);
    expect(user[0]!.evidenceJson).toMatchObject({ reason: 'wrong company', feedbackEventId: expect.any(String) });
  });

  it('one outcome per action: the same override again, the core primitive alone and a reset write nothing more', async () => {
    const { s, finding } = await verifiedTask();
    setIncludeOverride(s.store, 'finding', finding.id, false);
    const n = userOutcomes(s.store).length;
    expect(n).toBe(2); // excluded + excluded_after_pass, once
    setIncludeOverride(s.store, 'finding', finding.id, false); // unchanged: no feedback event, no outcome
    setIncludeInSynthesis(s.store, finding.id, true); // primitive, not a human action: no outcome
    setIncludeOverride(s.store, 'finding', finding.id, null); // reset: records nothing
    expect(userOutcomes(s.store)).toHaveLength(n);
  });

  it('including an unverified output → confirmed; null resets record nothing', async () => {
    const s = researchSetup(opened, {
      config: (c) => (c.loop.maxRounds = 1),
      pick: (r) => (r.kind === 'work' ? submitWork() : review(5)),
    });
    const task = addTask(s.store);
    await runTaskWithReview(task, s.deps);
    const finding = s.store.findings.list({ taskId: task.id })[0]!;
    setIncludeOverride(s.store, 'finding', finding.id, true);
    setIncludeOverride(s.store, 'finding', finding.id, null);
    expect(userOutcomes(s.store).map((o) => [o.outcome, o.label])).toEqual([['included', 'confirmed']]);
  });

  it('recommendation include overrides record exactly one outcome', () => {
    const s = researchSetup(opened);
    s.store.recommendations.insert({
      id: 'rec_1', workspaceId: 'ws_a', title: 'Cut price', summary: 's', criteria: {}, findingIds: [], personaFeedback: [],
      priority: 1, createdAt: new Date().toISOString(), status: 'verified',
    });
    const save = agentDecision(s.store, { role: 'synthesizer', kind: 'decision', payload: { tool: 'save_recommendation', recommendationId: 'rec_1' }, refs: ['rec_1'] });
    setIncludeOverride(s.store, 'recommendation', 'rec_1', false);
    setOutputInclude(s.store, 'recommendation', 'rec_1', true); // primitive: no outcome
    expect(outcomesOf(s.store).map((o) => [o.decisionId, o.outcome, o.label, o.targetType])).toEqual([
      [save.id, 'excluded', 'user-rejected', 'recommendation'],
    ]);
  });

  it('hypothesis include overrides → outcome on its save_hypothesis decision (targetType hypothesis)', () => {
    const s = researchSetup(opened);
    s.store.symptoms.insert({ id: 'sym_1', workspaceId: 'ws_a', kind: 'symptom', title: 'Churn up', detail: 'd', criteria: { severity: 4 }, evidence: [] });
    s.store.symptomHypotheses.insert({
      id: 'hyp_1', workspaceId: 'ws_a', symptomId: 'sym_1', hypothesis: 'Price rise drives churn', confidence: 60, evidence: [],
      createdAt: new Date().toISOString(), status: 'unverified',
    });
    const save = agentDecision(s.store, { kind: 'score', payload: { tool: 'save_hypothesis', hypothesisId: 'hyp_1', symptomId: 'sym_1' }, refs: ['hyp_1'] });
    setIncludeOverride(s.store, 'hypothesis', 'hyp_1', true, { actor: 'ana' });
    setIncludeOverride(s.store, 'hypothesis', 'hyp_1', false, { actor: 'ana' });
    expect(outcomesOf(s.store).map((o) => [o.decisionId, o.outcome, o.label, o.targetType, o.actor])).toEqual([
      [save.id, 'included', 'confirmed', 'hypothesis', 'ana'],
      [save.id, 'excluded', 'user-rejected', 'hypothesis', 'ana'],
    ]);
  });

  it('recordOverrideOutcome is a no-op for outputs without a save decision', () => {
    const s = researchSetup(opened);
    expect(recordOverrideOutcome(s.store, { targetType: 'finding', targetId: 'fnd_none', include: false })).toEqual([]);
  });

  it('rejecting a unit proposal → exactly one user-rejected outcome on its proposal decision', () => {
    const s = researchSetup(opened);
    const ws = createWorkspace(s.store, { name: 'Acme', sector: 'saas' });
    const d = agentDecision(s.store, { workspaceId: ws.id, payload: { tool: 'propose_business_unit', name: 'Payments' } });
    const proposal = (id: string) => s.store.unitProposals.insert({
      id, workspaceId: ws.id, name: 'Payments', description: 'd', level: 'division', audiences: ['external'],
      evidence: [], reasoning: 'r', status: 'proposed', decisionId: d.id, createdAt: new Date().toISOString(),
    });
    proposal('up_1');
    decideUnitProposal(s.store, 'up_1', { action: 'reject', reason: 'not a real unit' }, { actor: 'ana' });
    expect(outcomesOf(s.store).map((o) => [o.decisionId, o.outcome, o.label, o.source, o.targetType, o.actor])).toEqual([
      [d.id, 'rejected', 'user-rejected', 'user_reject', 'unit_proposal', 'ana'],
    ]);
    expect(outcomesOf(s.store)[0]!.evidenceJson).toMatchObject({ reason: 'not a real unit' });
    proposal('up_2');
    rejectUnitProposal(s.store, 'up_2', 'primitive'); // not a human action path: no outcome
    expect(outcomesOf(s.store)).toHaveLength(1);
  });
});

describe('what_changed outcomes', () => {
  function run(store: Store, workspaceId: string, scheduleId: string, at: string): ResearchRun {
    return store.researchRuns.insert({ id: newId('rrun'), workspaceId, phase: 'deep_dives', status: 'done', startedAt: at, scheduleId });
  }
  function finding(store: Store, workspaceId: string, runId: string, subject: string, claim: string, evidence: string[] = []): Finding {
    const f = store.findings.insert({
      id: newId('fnd'), workspaceId, runId, taskId: 'tsk_x', subject, claim, criteria: {}, evidence, status: 'verified',
      createdAt: new Date().toISOString(),
    });
    agentDecision(store, { workspaceId, kind: 'score', payload: { tool: 'save_finding', findingId: f.id }, refs: [f.id] });
    return f;
  }

  it('a finding no longer found while its subject was re-researched → contradicted/stale; changed screenshot → changed/stale', () => {
    const s = researchSetup(opened);
    const ws = createWorkspace(s.store, { name: 'Acme', sector: 'saas' });
    s.store.schedules.insert({ id: 'sch_1', workspaceId: ws.id, name: 'weekly', cron: '0 0 * * 1', phases: ['deep_dives'], enabled: true });
    const shot = (content: string) =>
      s.artifacts.save({ workspaceId: ws.id, kind: 'screenshot', mime: 'image/png', flow: 'signup', step: 1, bytes: content });
    const prev = run(s.store, ws.id, 'sch_1', '2026-01-01T00:00:00Z');
    const next = run(s.store, ws.id, 'sch_1', '2026-01-08T00:00:00Z');
    const v1 = shot('signup v1');
    const price = finding(s.store, ws.id, prev.id, 'Acme', 'Acme Pro costs $10/mo');
    const same = finding(s.store, ws.id, prev.id, 'Acme', 'Acme has SSO');
    const signup = finding(s.store, ws.id, prev.id, 'Globex', 'Globex signup has 1 step', [v1.id]);
    const gone = finding(s.store, ws.id, prev.id, 'Initech', 'Initech is hiring');
    finding(s.store, ws.id, next.id, 'Acme', 'Acme Pro costs $12/mo');
    finding(s.store, ws.id, next.id, 'Acme', 'Acme has SSO');
    finding(s.store, ws.id, next.id, 'Globex', 'Globex signup has 1 step', [shot('signup v2').id]);

    const [wc] = recordWhatChanged({ store: s.store }, 'sch_1', [next]);
    const rows = outcomesOf(s.store).filter((o) => o.source === 'what_changed');
    expect(rows.map((o) => [o.targetId, o.outcome, o.label]).sort()).toEqual(
      [
        [price.id, 'contradicted', 'stale'],
        [signup.id, 'changed', 'stale'],
      ].sort(),
    );
    expect(rows.every((o) => (o.evidenceJson as { whatChangedDecisionId: string }).whatChangedDecisionId === wc!.id)).toBe(true);
    expect(rows.some((o) => o.targetId === same.id || o.targetId === gone.id)).toBe(false);
    // Re-running the step adds nothing.
    recordWhatChanged({ store: s.store }, 'sch_1', [next]);
    expect(outcomesOf(s.store).filter((o) => o.source === 'what_changed')).toHaveLength(2);
  });
});

describe('outcome report', () => {
  it('counts labels per role / task type / prompt version', async () => {
    const s = researchSetup(opened);
    const t1 = addTask(s.store, { type: 'news_scan' });
    const t2 = addTask(s.store, { type: 'public_filings' });
    const mk = (taskId: string, pv: string) => {
      const runId = newId('run');
      s.store.agentRuns.insert({
        id: runId, workspaceId: 'ws_a', taskId, role: 'worker', model: { provider: 'claude', model: 'sonnet' }, token: runId,
        status: 'done', startedAt: new Date().toISOString(), promptVersion: pv,
      });
      return agentDecision(s.store, { agentRunId: runId, promptVersion: pv });
    };
    const a = mk(t1.id, 'v1');
    const b = mk(t1.id, 'v1');
    const c = mk(t2.id, 'v2');
    recordOutcome(s.store, { decisionId: a.id, outcome: 'verified', label: 'confirmed', source: 'review_loop' });
    recordOutcome(s.store, { decisionId: b.id, outcome: 'unverified', label: 'missed-evidence', source: 'review_loop' });
    recordOutcome(s.store, { decisionId: b.id, outcome: 'superseded', label: 'missed-evidence', source: 'supersede', targetId: 'x' });
    recordOutcome(s.store, { decisionId: c.id, outcome: 'excluded', label: 'user-rejected', source: 'user_override' });
    agentDecision(s.store, { workspaceId: 'ws_other' });

    const report = outcomeReport(s.store, ['ws_a']);
    expect(report.labels).toContain('worker-miss');
    expect(report.rows).toEqual([
      { role: 'worker', taskType: 'news_scan', promptVersion: 'v1', counts: { confirmed: 1, 'missed-evidence': 2 }, total: 3 },
      { role: 'worker', taskType: 'public_filings', promptVersion: 'v2', counts: { 'user-rejected': 1 }, total: 1 },
    ]);
    expect(listOutcomes(s.store, { workspaceIds: ['ws_a'], label: 'missed-evidence' })).toHaveLength(2);
    expect(listOutcomes(s.store, { workspaceIds: ['ws_a'], taskId: t2.id })).toHaveLength(1);
    expect(outcomeReport(s.store, ['ws_other']).rows).toEqual([]);
  });
});

describe('task end outcomes after a repeated review', () => {
  it('only the latest reviewer run of the final round labels an unverified task', async () => {
    const s = researchSetup(opened, {
      config: (c) => (c.loop.maxRounds = 1),
      pick: (r) => (r.kind === 'work' ? submitWork() : review(5, [{ class: 'scope_expansion', description: 'also cover Europe' }])),
    });
    const task = addTask(s.store);
    // A crashed earlier review of the same round left a blocking issue behind.
    learningRepos(s.store).reviewIssues.insert({
      id: newId('rvi'), workspaceId: 'ws_a', taskId: task.id, round: 1, issueId: 'I9', class: 'blocking', text: 'stale crash row',
      evidence: [], status: 'open', synthetic: false, reviewerRunId: 'run_crashed', createdAt: new Date().toISOString(),
    });
    await runTaskWithReview(task, s.deps);
    expect(outcomesOf(s.store).map((o) => [o.outcome, o.label])).toEqual([['unverified', 'over-scoped']]);
  });
});
