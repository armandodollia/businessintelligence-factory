/**
 * Review council, design §8: everything downstream of the review loop sees ONE review per council round,
 * the round's `council_review` Decision, and never a member's own review as a review of the task.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { BifConfig } from '../../../src/core/config/schema.js';
import { councilStep } from '../../../src/core/council/round.js';
import { councilFor } from '../../../src/core/council/settings.js';
import { councilMemberOf, councilReviewDecisions, councilReviewOf } from '../../../src/core/council/store.js';
import {
  answerEscalation,
  escalationPrompt,
  escalationToolHandlers,
  rerunAfterEscalation,
  runEscalation,
} from '../../../src/core/escalation/escalation.js';
import type { FakeScript } from '../../../src/core/harness/adapter.js';
import { recordRetrieval } from '../../../src/core/knowledge/retrievalLog.js';
import { compareExperiment, runExperiment } from '../../../src/core/learning/experiments.js';
import { listOutcomes, recordOutcome, recordOverrideOutcome, taskLastReviewDecision } from '../../../src/core/learning/outcomes.js';
import { AuditError, auditCandidates, startReviewerAudit } from '../../../src/core/learning/reviewerAudit.js';
import { listReviewIssues } from '../../../src/core/learning/reviewIssues.js';
import { promptVersionMetrics } from '../../../src/core/metrics/promptMetrics.js';
import type { AgentRequest } from '../../../src/core/research/deps.js';
import { lastReviewsByTask } from '../../../src/core/research/outputs.js';
import { runTaskWithReview } from '../../../src/core/research/reviewLoop.js';
import { decisionReviewQueue } from '../../../src/core/scoring/decisionQueue.js';
import { exportTrainingDataWithSummary } from '../../../src/core/scoring/export.js';
import type { Store } from '../../../src/core/store/db.js';
import type { Decision, Task } from '../../../src/core/types.js';
import { withholding } from '../../../src/core/stakeholders/withheld.js';
import { createWorkspace } from '../../../src/core/workspace/tree.js';
import { addTask, researchSetup, review, revise, submitWork, submitCopyOnly, TASK_COPY, TASK_FINDING, withTaskIds, workDone, type Picker } from '../helpers/research.js';

const opened: Store[] = [];
afterEach(() => {
  for (const s of opened.splice(0)) s.close();
});

type Council = NonNullable<BifConfig['council']>;
type Sent = { score: number | null; issues?: Array<Record<string, unknown>>; summary?: string; questions?: string[] };

const COUNCIL: Council = {
  members: [
    { name: 'a', provider: 'claude', model: 'opus', lens: 'evidence' },
    { name: 'b', provider: 'codex', model: 'gpt-6.1-sol', lens: 'reasoning' },
    { name: 'c', provider: 'claude', model: 'sonnet', lens: 'brief' },
  ],
  stages: { news_scan: {} },
};

const REVENUE = 'The revenue figure in the finding does not match the cited filing';
const STALE = 'The pricing claim rests on a page captured two years ago';

const send =
  (r: Sent): FakeScript =>
  async (t) => {
    await t.call('submit_review', { issues: [], summary: `score ${r.score}`, ...r });
  };

const escalate: FakeScript = async (t) => {
  await t.call('submit_escalation', { questions: [{ question: 'Which source should the re-run trust?', options: ['The filing', 'The press release'], recommended: 0, why: 'The reviewers and the worker disagree.' }] });
};

/**
 * A store with one business, in which `news_scan` is a council stage and every other type has its single
 * reviewer (score 9). Members follow `members(req)`; a missing answer means the member ends without a review.
 */
function world(members: (name: string, req: AgentRequest) => Sent | undefined, over: Partial<Council> = {}, answer: 'fix' | 'pushback' = 'fix') {
  const pick: Picker = (req) => {
    if (req.kind === 'work') return submitWork();
    if (req.kind === 'revise') return revise(answer)(req);
    if (req.kind === 'escalate') return escalate;
    if (req.kind === 'audit') return review(9);
    const name = req.runTags?.councilMember;
    if (!name) return review(9);
    const sent = members(name, req);
    return sent ? send(withTaskIds(s.store, req.task, sent)) : async () => {};
  };
  const s = researchSetup(opened, {
    config: (c) => void (c.council = { ...structuredClone(COUNCIL), ...over }),
    extraHandlers: () => escalationToolHandlers(),
    pick,
  });
  const ws = createWorkspace(s.store, { name: 'Acme', sector: 'saas' });
  const task = (extra: Partial<Task> = {}) => addTask(s.store, { workspaceId: ws.id, ...extra });
  return { ...s, ws, task };
}

/** Round 1: member a upholds one issue and scores 6, b sends a nit; round 2: everyone passes it. */
const twoRounds = (name: string, req: AgentRequest): Sent =>
  req.round === 1 && name === 'a'
    ? { score: 6, issues: [{ class: 'substantive', description: REVENUE, evidence: [TASK_COPY] }] }
    : req.round === 1 && name === 'b'
      ? { score: 9, issues: [{ class: 'nit', description: 'The title is long' }] }
      : { score: 9.5 };

/** Never passes: member a keeps one blocking issue. */
const neverPasses = (name: string): Sent => (name === 'a' ? { score: 4, issues: [{ class: 'blocking', description: REVENUE, where: [TASK_FINDING] }] } : { score: 9 });

const payloadOf = (d: Decision) => d.payload as Record<string, unknown>;

describe('the task\'s review is the council review', () => {
  it('last review of the outputs, latest review decision and task-end outcome all read the round, not a member', async () => {
    const w = world(twoRounds);
    const task = w.task();
    const out = await runTaskWithReview(task, w.deps);
    expect(out).toMatchObject({ status: 'verified', round: 2 });
    const [d1, d2] = councilReviewDecisions(w.store, task);

    const last = lastReviewsByTask(w.store, [w.ws.id]).get(task.id)!;
    expect(last).toMatchObject({ score: 9.5, issues: [], decisionId: d2!.id, synthetic: false });
    expect(taskLastReviewDecision(w.store, task)!.id).toBe(d2!.id);

    const end = listOutcomes(w.store, { taskId: task.id, source: 'review_loop' });
    expect(end.map((o) => [o.outcome, o.label, o.evidenceJson])).toEqual([['verified', 'confirmed', { round: 2, score: 9.5, reviewDecisionId: d2!.id }]]);

    // The history: the upheld issue only (never the nit), on the round and its Decision.
    const rows = listReviewIssues(w.store, { taskId: task.id });
    expect(rows.map((r) => [r.issueId, r.text, r.status, r.reviewDecisionId, r.reviewerRunId])).toEqual([['I1', REVENUE, 'fixed', d1!.id, d1!.agentRunId]]);
    // Six member runs, each with its own review Decision: kept, and none of them the task's review.
    const memberReviews = w.store.decisions.list({ workspaceId: w.ws.id, kind: 'review' }).filter((d) => payloadOf(d).tool === 'submit_review');
    expect(memberReviews).toHaveLength(6);
    expect(memberReviews.every((d) => councilMemberOf(w.store, d.agentRunId) !== undefined)).toBe(true);
  });

  it('an unverified task shows the objections the council upheld', async () => {
    const w = world(neverPasses, { rounds: 2 });
    const task = w.task();
    const out = await runTaskWithReview(task, w.deps);
    expect(out).toMatchObject({ status: 'unverified', round: 2 });
    const d = councilReviewDecisions(w.store, task).at(-1)!;
    const last = lastReviewsByTask(w.store, [w.ws.id]).get(task.id)!;
    expect(last).toMatchObject({ score: 4, decisionId: d.id, synthetic: false });
    expect(last.issues).toMatchObject([{ id: 'I1', class: 'blocking', description: REVENUE, raisedBy: ['a'] }]);
    const [end] = listOutcomes(w.store, { taskId: task.id, source: 'review_loop' });
    expect(end).toMatchObject({ outcome: 'unverified', label: 'missed-evidence' });
    expect(end!.evidenceJson).toEqual({ round: 2, score: 4, reviewDecisionId: d.id, openIssues: [{ issueId: 'I1', class: 'blocking' }] });
  });

  it('a failed round is a review that did not happen: score 0, no objection, labelled like a failed reviewer run', async () => {
    const w = world((name) => (name === 'b' ? undefined : neverPasses(name)));
    const task = w.task();
    const out = await runTaskWithReview(task, w.deps);
    expect(out.status).toBe('unverified');
    const d = councilReviewDecisions(w.store, task)[0]!;
    expect(lastReviewsByTask(w.store, [w.ws.id]).get(task.id)).toMatchObject({ score: 0, issues: [], decisionId: d.id, synthetic: true });
    const [end] = listOutcomes(w.store, { taskId: task.id, source: 'review_loop' });
    expect(end).toMatchObject({ outcome: 'unverified', label: 'weak-review' });
    expect(end!.evidenceJson).toEqual({ round: 1, score: 0, reviewDecisionId: d.id, openIssues: [] });
  });

  it('excluding a verified output blames the council review that passed it', async () => {
    const w = world(() => ({ score: 9 }));
    const task = w.task();
    await runTaskWithReview(task, w.deps);
    const finding = w.store.findings.list({ taskId: task.id })[0]!;
    const outcomes = recordOverrideOutcome(w.store, { targetType: 'finding', targetId: finding.id, include: false });
    const d = councilReviewDecisions(w.store, task)[0]!;
    expect(outcomes.map((o) => [o.outcome, o.label, o.decisionId, o.role, o.taskId])).toEqual([
      ['excluded', 'user-rejected', expect.any(String), 'worker', task.id],
      ['excluded_after_pass', 'weak-review', d.id, 'reviewer', task.id],
    ]);
  });

  it('a later single review of the same task (the stage was switched off) takes over, and member runs are never its reviewer run', async () => {
    const w = world(neverPasses, { rounds: 1 });
    const task = w.task();
    expect((await runTaskWithReview(task, w.deps)).status).toBe('unverified');
    const councilDecision = councilReviewDecisions(w.store, task)[0]!;
    // The council is switched off; the task is reviewed again by the single reviewer.
    delete w.config.council;
    w.store.tasks.update(task.id, { status: 'queued', step: 'review', round: 2 });
    const out = await runTaskWithReview(w.store.tasks.get(task.id)!, w.deps);
    expect(out).toMatchObject({ status: 'verified', round: 2 });
    const single = w.store.agentRuns.list({ taskId: task.id, role: 'reviewer' }).at(-1)!;
    expect(councilMemberOf(w.store, single.id)).toBeUndefined();
    const last = taskLastReviewDecision(w.store, task)!;
    expect(last.agentRunId).toBe(single.id);
    expect(last.id).not.toBe(councilDecision.id);
    expect(lastReviewsByTask(w.store, [w.ws.id]).get(task.id)).toMatchObject({ score: 9, decisionId: last.id });
  });
});

describe('what a council round\'s Decision is taken to be a run of', () => {
  it('an outcome on it is an outcome of its task, and of the reviewer role', async () => {
    const w = world(() => ({ score: 9 }));
    const task = w.task();
    await runTaskWithReview(task, w.deps);
    const d = councilReviewDecisions(w.store, task)[0]!;
    const o = recordOutcome(w.store, { decisionId: d.id, outcome: 'audit_failed', label: 'weak-review', source: 'reviewer_audit', sourceKey: 'k' })!;
    expect(o).toMatchObject({ taskId: task.id, taskType: 'news_scan', role: 'reviewer', runId: d.agentRunId, promptVersion: d.promptVersion });
  });

  it('private research stays withheld: the round\'s Decision of an own-stakeholder task in progress is served without its content', async () => {
    // Own-stakeholder research saves no finding: the member's issue rests on the evidence copy the deliverable cites.
    const citing = (name: string): Sent => (name === 'a' ? { score: 4, issues: [{ class: 'blocking', description: REVENUE, evidence: [TASK_COPY] }] } : { score: 9 });
    const w = world(citing, { stages: { own_stakeholders: {} }, rounds: 1 });
    const task = w.task({ type: 'own_stakeholders', phase: 'stakeholders', status: 'reviewing' });
    await workDone(w, task, submitCopyOnly('private'));
    const stage = councilFor(w.config, 'own_stakeholders')!;
    await councilStep(w.deps, task.id, 1, stage);
    const d = councilReviewDecisions(w.store, task)[0]!;
    expect(councilReviewOf(d)!.issues).toMatchObject([{ description: REVENUE }]);
    const served = withholding(w.store);
    expect(served.run(d.agentRunId)).toBe(true);
    expect(served.servedDecision(d)).toMatchObject({ payload: { tool: 'harness', withheld: true }, refs: [] });
    expect(JSON.stringify(decisionReviewQueue(w.ws.id, w))).not.toContain(REVENUE);
    expect(decisionReviewQueue(w.ws.id, w).filter((i) => i.targetId === d.id)).toEqual([]);
    // A task that is not private is served as it is.
    const open = w.task({ status: 'reviewing', result: { summary: 'public' } });
    await workDone(w, open);
    await councilStep(w.deps, open.id, 1, councilFor({ ...w.config, council: { ...w.config.council!, stages: { news_scan: {} } } }, 'news_scan')!);
    const other = councilReviewDecisions(w.store, open)[0]!;
    expect(withholding(w.store).servedDecision(other)).toEqual(other);
  });
});

describe('a round interrupted after a member sent its review', () => {
  it('leaves nothing that counts: the earlier round stays the task\'s review everywhere', async () => {
    const ac = new AbortController();
    // Round 1 fails on member a's issue. In round 2 member a passes it with a 10 and the others never end.
    let hang = false;
    const w = world((name, req) => (req.round === 1 ? neverPasses(name) : { score: 10 }), { rounds: 3 });
    const base = w.state.pick;
    w.state.pick = (req) => (hang && req.kind === 'review' && req.round === 2 && req.runTags?.councilMember !== 'a' ? () => new Promise<void>(() => {}) : base(req));
    hang = true;
    const task = w.task();
    const settled = runTaskWithReview(task, { ...w.deps, signal: ac.signal }).then(() => 'done', (e: Error) => e.name);
    const submitted = () => w.store.decisions.list({ workspaceId: w.ws.id, kind: 'review' }).filter((d) => payloadOf(d).tool === 'submit_review' && payloadOf(d).score === 10).length;
    for (let i = 0; i < 400 && submitted() < 1; i++) await new Promise((r) => setTimeout(r, 5));
    expect(submitted()).toBe(1);
    ac.abort();
    expect(await settled).toBe('AbortError');

    const [d1, ...more] = councilReviewDecisions(w.store, task);
    expect(more).toEqual([]);
    const now = w.store.tasks.get(task.id)!;
    expect(now).toMatchObject({ status: 'reviewing', round: 2 });
    expect(taskLastReviewDecision(w.store, now)!.id).toBe(d1!.id);
    expect(lastReviewsByTask(w.store, [w.ws.id]).get(task.id)).toMatchObject({ score: 4, decisionId: d1!.id });
    expect(escalationPrompt(w.store, now)).toContain('## Last review (council of 3 reviewers, score 4)');
    expect(listReviewIssues(w.store, { taskId: task.id }).map((r) => [r.round, r.issueId])).toEqual([[1, 'I1']]);
  });
});

describe('the reviewer audit', () => {
  it('does not audit a task whose final review was a council; a single-reviewer task of the tree still is a candidate', async () => {
    const w = world(() => ({ score: 9 }));
    const councilTask = w.task();
    const singleTask = w.task({ type: 'public_filings' });
    await runTaskWithReview(councilTask, w.deps);
    await runTaskWithReview(singleTask, w.deps);
    expect(w.store.tasks.get(councilTask.id)!.status).toBe('verified');
    expect(auditCandidates(w.deps, w.ws.id, 10).map((p) => p.task.id)).toEqual([singleTask.id]);
    expect(() => startReviewerAudit(w.deps, { workspaceId: w.ws.id, taskIds: [councilTask.id] })).toThrow(AuditError);
    const batch = startReviewerAudit(w.deps, { workspaceId: w.ws.id });
    const audits = await batch.done;
    expect(audits.map((a) => [a.taskId, a.verdict])).toEqual([[singleTask.id, 'agree']]);
  });
});

describe('escalation', () => {
  it('sees the open issues of the council, not one member\'s review, and re-runs the task as a revision with a new round budget', async () => {
    const w = world((name, req) => (req.round <= 3 ? neverPasses(name) : { score: 9 }), { rounds: 2 });
    const task = w.task();
    const out = await runTaskWithReview(task, w.deps);
    expect(out).toMatchObject({ status: 'unverified', round: 2 });
    const prompt = escalationPrompt(w.store, w.store.tasks.get(task.id)!);
    expect(prompt).toContain(`## Last review (council of 3 reviewers, score 4)\n- [I1] (blocking) ${REVENUE}`);
    expect(prompt.match(/## Last review/g)).toHaveLength(1);

    const [q] = await runEscalation(w.deps, task.id);
    answerEscalation(w, q!.id, { choice: 0 });
    const rerun = await rerunAfterEscalation(w.deps, task.id);
    // The re-run has the stage's two rounds again: round 3 revises against the council's open issue and
    // fails, round 4 passes.
    expect(rerun).toMatchObject({ status: 'verified', round: 4 });
    const revision = w.requests.filter((r) => r.kind === 'revise' && r.round === 3)[0]!;
    expect(revision.prompt).toContain(`- [I1] (blocking) ${REVENUE} (about: ${w.store.findings.list({ taskId: task.id })[0]!.id})`);
    expect(councilReviewDecisions(w.store, task).map((d) => councilReviewOf(d)!.round)).toEqual([1, 2, 3, 4]);
  });

  it('after a failed round it is told why, and nothing of the partial council is taken as review issues', async () => {
    const w = world((name) => (name === 'b' ? undefined : neverPasses(name)));
    const task = w.task();
    const out = await runTaskWithReview(task, w.deps);
    expect(out.status).toBe('unverified');
    const prompt = escalationPrompt(w.store, w.store.tasks.get(task.id)!);
    expect(prompt).toContain(
      "## Last review (council of 3 reviewers)\nThe council round failed, and the task ended without a revision: council member 'b' (codex/gpt-6.1-sol) gave no review: the run ended without a review",
    );
    expect(prompt).not.toContain('(blocking)');
  });
});

describe('the first review of work that was done again (council review C3)', () => {
  const CAUSE = 'The hypothesis ignores the churn data that points the other way';
  const substantive = (description: string): Sent => ({ score: 6, issues: [{ class: 'substantive', description, where: [TASK_FINDING] }] });
  const record = (w: ReturnType<typeof world>, task: Task, round: number) => councilReviewDecisions(w.store, task).map((d) => councilReviewOf(d)!).filter((p) => p.round === round).at(-1)!;
  const prompts = (w: ReturnType<typeof world>, round: number) => w.requests.filter((r) => r.kind === 'review' && r.round === round).map((r) => r.prompt);
  /** The person answers the escalation and the task is run again. */
  const rerun = async (w: ReturnType<typeof world>, task: Task) => {
    const [q] = await runEscalation(w.deps, task.id);
    answerEscalation(w, q!.id, { choice: 0 });
    return rerunAfterEscalation(w.deps, task.id);
  };

  it('after a failed council round the work is redone in round 2: its first review is a first review, so a substantive issue blocks', async () => {
    // Round 1: member b gives no review, so the round fails. Round 2 (after the re-run): member a finds a
    // substantive issue. Round 3: everyone passes the revision.
    const w = world((name, req) => (req.round === 1 ? (name === 'b' ? undefined : { score: 9 }) : req.round === 2 && name === 'a' ? substantive(REVENUE) : { score: 9 }));
    const task = w.task();
    expect(await runTaskWithReview(task, w.deps)).toMatchObject({ status: 'unverified', round: 1 });
    expect(record(w, task, 1).failed).toBeDefined();
    const out = await rerun(w, task);
    expect(w.requests.filter((r) => r.kind !== 'review' && r.kind !== 'escalate').map((r) => [r.kind, r.round])).toEqual([['work', 1], ['work', 2], ['revise', 3]]);
    expect(record(w, task, 2)).toMatchObject({ pass: false, score: 6, issues: [{ id: 'I1', description: REVENUE, standing: 'upheld' }], advisory: [] });
    expect(out).toMatchObject({ status: 'verified', round: 3 });
    // The members of round 2 are not told of a revision that never was; those of round 3 are.
    for (const p of prompts(w, 2)) expect(p).not.toContain('## Review round');
    for (const p of prompts(w, 3)) expect(p).toContain('## Review round 3\nThe worker has revised the deliverable since the first review.');
  });

  it('a task that failed before any review and is run again: the same', async () => {
    const w = world((name, req) => (req.round === 2 && name === 'a' ? substantive(REVENUE) : { score: 9 }));
    const base = w.state.pick;
    w.state.pick = (req) => (req.kind === 'work' && req.round === 1 ? async () => { throw new Error('the worker crashed'); } : base(req));
    const task = w.task();
    expect(await runTaskWithReview(task, w.deps)).toMatchObject({ status: 'failed', round: 1 });
    expect(councilReviewDecisions(w.store, task)).toEqual([]);
    const out = await rerun(w, task);
    expect(record(w, task, 2)).toMatchObject({ pass: false, score: 6, issues: [{ id: 'I1', description: REVENUE, standing: 'upheld' }], advisory: [] });
    expect(out).toMatchObject({ status: 'verified', round: 3 });
    for (const p of prompts(w, 2)) expect(p).not.toContain('## Review round');
  });

  it('reviews of the deliverable the worker replaced do not count: after valid rounds, a failed round and a re-run, the redone work has its first review; its second is a late one', async () => {
    // Round 1: an upheld issue. Round 2: the round fails (b gives no review). The re-run does the work
    // again in round 3. Round 3: a new substantive issue. Round 4: another new one, and the score with it.
    const w = world((name, req) => {
      if (req.round === 2) return name === 'b' ? undefined : { score: 9 };
      if (name !== 'a') return { score: 9 };
      return req.round === 1 ? substantive(REVENUE) : req.round === 3 ? substantive(STALE) : substantive(CAUSE);
    });
    const task = w.task();
    expect(await runTaskWithReview(task, w.deps)).toMatchObject({ status: 'unverified', round: 2 });
    const out = await rerun(w, task);
    expect(w.requests.filter((r) => r.kind !== 'review' && r.kind !== 'escalate').map((r) => [r.kind, r.round])).toEqual([['work', 1], ['revise', 2], ['work', 3], ['revise', 4]]);
    // Round 3 is the first review of the redone work: the new substantive issue blocks.
    expect(record(w, task, 3)).toMatchObject({ pass: false, score: 6, issues: [{ description: STALE, standing: 'upheld' }], advisory: [] });
    for (const p of prompts(w, 3)) expect(p).not.toContain('## Review round');
    // Round 4 is its second: a substantive issue nobody raised before is advice, as in any second review.
    expect(record(w, task, 4)).toMatchObject({ pass: true, score: 9, issues: [], advisory: [{ description: CAUSE, standing: 'advisory' }] });
    for (const p of prompts(w, 4)) expect(p).toContain('## Review round 4');
    expect(out).toMatchObject({ status: 'verified', round: 4 });
  });

  it('a re-run that revises the reviewed deliverable goes on where the reviews stopped: a new substantive issue is a late one', async () => {
    // Rounds 1 and 2 (the limit): one blocking issue stays open. The re-run revises against it in round 3,
    // where member a raises a new substantive issue instead.
    const w = world((name, req) => (req.round <= 2 ? neverPasses(name) : name === 'a' ? substantive(STALE) : { score: 9 }), { rounds: 2 });
    const task = w.task();
    expect(await runTaskWithReview(task, w.deps)).toMatchObject({ status: 'unverified', round: 2 });
    const out = await rerun(w, task);
    expect(w.requests.filter((r) => r.kind === 'revise').map((r) => r.round)).toEqual([2, 3]);
    expect(record(w, task, 3)).toMatchObject({ pass: true, issues: [], advisory: [{ description: STALE, standing: 'advisory' }] });
    for (const p of prompts(w, 3)) expect(p).toContain('## Review round 3');
    expect(out).toMatchObject({ status: 'verified', round: 3 });
  });
});

describe('the decision queue and the export', () => {
  it('the queue offers the council review as the review to rate, and marks a member\'s score as one member\'s', async () => {
    const w = world(twoRounds);
    const task = w.task();
    await runTaskWithReview(task, w.deps);
    const titles = decisionReviewQueue(w.ws.id, w).filter((i) => i.criteria.score !== undefined).map((i) => [i.title, i.criteria.score]);
    expect(titles).toEqual([
      ['[council member a] Review score (reviewer)', 6],
      ['[council member b] Review score (reviewer)', 9],
      ['[council member c] Review score (reviewer)', 9.5],
      ['Council review score', 6],
      ['[council member a] Review score (reviewer)', 9.5],
      ['[council member b] Review score (reviewer)', 9.5],
      ['[council member c] Review score (reviewer)', 9.5],
      ['Council review score', 9.5],
    ]);
  });

  it('the export has the council review as the review of the task, with its final status, and marks every member line', async () => {
    const w = world(twoRounds);
    const task = w.task();
    const single = w.task({ type: 'public_filings' });
    await runTaskWithReview(task, w.deps);
    await runTaskWithReview(single, w.deps);
    const { jsonl } = exportTrainingDataWithSummary(w.ws.id, w);
    type Line = { type: string; decision: Decision; finalReviewStatus?: string; councilMember?: string; councilRoundId?: string };
    const lines = jsonl.trim().split('\n').map((l) => JSON.parse(l) as Line).filter((l) => l.type === 'decision' && l.decision.kind === 'review');
    const ofTask = lines.filter((l) => l.decision.refs.includes(task.id));
    const reviews = ofTask.filter((l) => l.councilMember === undefined);
    // Unmarked review lines of the council task: exactly its two council reviews.
    const roundIds = councilReviewDecisions(w.store, task).map((d) => d.agentRunId);
    expect(reviews.map((l) => [payloadOf(l.decision).event, payloadOf(l.decision).round, payloadOf(l.decision).score, l.finalReviewStatus, l.decision.agentRunId])).toEqual([
      ['council_review', 1, 6, 'verified', roundIds[0]],
      ['council_review', 2, 9.5, 'verified', roundIds[1]],
    ]);
    const members = ofTask.filter((l) => l.councilMember !== undefined);
    expect(members.map((l) => [l.councilMember, l.councilRoundId, payloadOf(l.decision).tool])).toEqual([
      ...['a', 'b', 'c'].map((m) => [m, roundIds[0], 'submit_review']),
      ...['a', 'b', 'c'].map((m) => [m, roundIds[1], 'submit_review']),
    ]);
    // The single-reviewer task's review line is as it always was.
    const other = lines.filter((l) => l.decision.refs.includes(single.id));
    expect(other).toHaveLength(1);
    expect(other[0]).not.toHaveProperty('councilMember');
    expect(other[0]).toMatchObject({ finalReviewStatus: 'verified' });
  });

  it('when one member was shown upload-derived text, the council review (which carries the members\' words) is left out with the task', async () => {
    const w = world(twoRounds);
    const task = w.task();
    await runTaskWithReview(task, w.deps);
    const clean = exportTrainingDataWithSummary(w.ws.id, w);
    expect(clean.jsonl).toContain('council_review');
    const memberRun = w.store.agentRuns.list({ taskId: task.id, role: 'reviewer' })[1]!;
    recordRetrieval({ store: w.store }, { workspaceId: w.ws.id, agentRunId: memberRun.id, taskId: task.id, role: 'reviewer' }, {
      tool: 'read_artifact', query: 'x', scope: 'node', results: [{ id: 'art_up', kind: 'artifact' }], tokensReturned: 10, latencyMs: 1, uploadDerived: true,
    });
    const exposed = exportTrainingDataWithSummary(w.ws.id, w);
    expect(exposed.jsonl).not.toContain('council_review');
    expect(exposed.jsonl).not.toContain(REVENUE);
    expect(exposed.summary.excludedJudgments.total).toBeGreaterThan(0);
  });
});

describe('experiments and prompt metrics', () => {
  it('an arm task of a council stage has one review score per round, and its council Decisions carry the arm', async () => {
    const perTask = new Map<string, number>();
    const w = world((name, req) => {
      // Arm B (worker model haiku) needs two rounds.
      const hard = req.task!.model.model === 'haiku';
      if (name === 'a') perTask.set(req.task!.id, (perTask.get(req.task!.id) ?? 0) + 1);
      return hard && req.round === 1 && name === 'a' ? { score: 5, issues: [{ class: 'blocking', description: STALE, where: [TASK_FINDING] }] } : { score: 9 };
    });
    const source = await runTaskWithReview(w.task(), w.deps);
    const exp = await runExperiment(w.deps, { taskId: source.id, arms: [{}, { model: { provider: 'claude', model: 'haiku' } }] });
    const cmp = compareExperiment(w.store, exp.id)!;
    expect(cmp.arms.map((a) => [a.arm, a.reviewScores, a.tasks.map((t) => [t.status, t.round, t.finalScore])])).toEqual([
      ['A', [9], [['verified', 1, 9]]],
      ['B', [5, 9], [['verified', 2, 9]]],
    ]);
    const armTask = w.store.tasks.get(exp.arms[1]!.taskIds[0]!)!;
    const tagged = w.store.db.prepare('SELECT experiment_id AS e, arm AS a FROM decisions WHERE id = ?');
    for (const d of councilReviewDecisions(w.store, armTask)) expect(tagged.get(d.id)).toEqual({ e: exp.id, a: 'B' });
    // Normal outcomes and the normal last-review of the source task are untouched by the arms.
    expect(listOutcomes(w.store, { workspaceIds: [w.ws.id], source: 'review_loop' }).map((o) => o.taskId)).toEqual([source.id]);
  });

  it('a round recorded twice (a restart after the record) is one review score: that of the later record (council review C5)', async () => {
    let again = false;
    const w = world(() => (again ? { score: 9.5 } : { score: 9 }));
    const source = await runTaskWithReview(w.task(), w.deps);
    const exp = await runExperiment(w.deps, { taskId: source.id, arms: [{}, { model: { provider: 'claude', model: 'haiku' } }] });
    const scores = () => compareExperiment(w.store, exp.id)!.arms.map((a) => [a.arm, a.reviewScores]);
    expect(scores()).toEqual([['A', [9]], ['B', [9]]]);
    // Round 1 of arm A's task is run and recorded once more, as after a restart between the record and the next step.
    const armTask = w.store.tasks.get(exp.arms[0]!.taskIds[0]!)!;
    again = true;
    await councilStep(w.deps, armTask.id, 1, councilFor(w.config, 'news_scan')!);
    expect(councilReviewDecisions(w.store, armTask).map((d) => [councilReviewOf(d)!.round, councilReviewOf(d)!.score])).toEqual([[1, 9], [1, 9.5]]);
    expect(scores()).toEqual([['A', [9.5]], ['B', [9]]]);
  });

  it('member runs stay ordinary reviewer runs for metrics; the task counts once, under its worker', async () => {
    const w = world(twoRounds);
    const task = w.task();
    await runTaskWithReview(task, w.deps);
    const metrics = promptVersionMetrics(w.store, w.ws.id);
    const reviewerRuns = metrics.filter((m) => m.role === 'reviewer').reduce((n, m) => n + m.runs, 0);
    expect(reviewerRuns).toBe(6);
    expect(metrics.filter((m) => m.role === 'reviewer').every((m) => m.tasks === 0)).toBe(true);
    const worker = metrics.filter((m) => m.role === 'worker');
    expect(worker.reduce((n, m) => n + m.tasks, 0)).toBe(1);
    expect(worker.reduce((n, m) => n + m.verified, 0)).toBe(1);
  });
});
