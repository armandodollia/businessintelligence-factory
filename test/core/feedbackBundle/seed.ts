/**
 * A seeded store for the feedback bundle tests: two business trees with real review loops (a task on
 * public evidence, a task that cites an upload, a failed task), a reviewer audit, and rows in every
 * other table a bundle reads. Every text field holds a marker:
 *
 * - `research(...)`: research content. In no standard bundle; may be in a bundle with review texts.
 * - `never(...)`: an upload, text taken from one, an internal stakeholder record, a stored password,
 *   a machine folder. In no bundle at either level.
 * - `own(...)`: the tester's own words (a reason, the note). In both levels, as typed.
 * - `keyed(...)`: a key of a free-form record (a profile the interviewer shaped, a before / after
 *   value). In no bundle at either level: no carried text of the fuller level holds one.
 *
 * Business and node names (`NAMES`) and the user id (`USER`) are in no bundle either.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { newCouncilRoundId } from '../../../src/core/council/store.js';
import { editProfile } from '../../../src/core/feedback/actions.js';
import { recordFeedback } from '../../../src/core/feedback/events.js';
import { uploadInternal } from '../../../src/core/internal/uploads.js';
import { recordLessonSignal } from '../../../src/core/learning/lessons/signals.js';
import { runExperiment } from '../../../src/core/learning/experiments.js';
import { lessonRepos } from '../../../src/core/learning/lessons/store.js';
import { runReviewerAudit } from '../../../src/core/learning/reviewerAudit.js';
import { personaLearningRepos } from '../../../src/core/personas/store.js';
import { recordPolicyEvent } from '../../../src/core/policy/policyEvents.js';
import { runTaskWithReview } from '../../../src/core/research/reviewLoop.js';
import { STOPPED_REQUEST_RESPONSE } from '../../../src/core/research/stop.js';
import type { Store } from '../../../src/core/store/db.js';
import { newId } from '../../../src/core/store/repos.js';
import { usageRepos } from '../../../src/core/store/usageRepos.js';
import type { Task } from '../../../src/core/types.js';
import { createWorkspace } from '../../../src/core/workspace/tree.js';
import { addTask, researchSetup, review, revise, type Picker } from '../helpers/research.js';

export const RESEARCH: string[] = [];
export const NEVER: string[] = [];
export const OWN: string[] = [];
export const KEYS: string[] = [];

const marker = (list: string[], prefix: string) => (what: string): string => {
  const token = `${prefix}-${what}-7731`;
  if (!list.includes(token)) list.push(token);
  return `some words ${token} and more words`;
};
/** A text field of research content, holding its marker. */
export const research = marker(RESEARCH, 'ZQRES');
export const never = marker(NEVER, 'ZQNEVER');
export const own = marker(OWN, 'ZQOWN');
export const keyed = marker(KEYS, 'ZQKEY');
/** The marker token of a text made by `research` / `never` / `own`. */
export const tokenOf = (text: string): string => /ZQ[A-Z]+-[a-z0-9.-]+-7731/.exec(text)![0];

export const NAMES = { business: 'Zephyrine Outfitters', child: 'Zephyrine Outfitters Wholesale', scope: 'Wholesale arm of the house', other: 'Quillfeather Logistics' };
/** The words of those names that only they have: in no bundle either, alone or inside the key of a free-form record. */
export const NAME_WORDS = ['zephyrine', 'outfitters', 'quillfeather'];
export const USER = 'zq.tester-id';
export const PASSWORD = 'pw-ZQ-site-9931';
export const INBOX_PASSWORD = 'pw-ZQ-inbox-4417';
/** A folder of the tester's machine that the tool does not know, as it stands quoted in a failure message. */
export const MACHINE_DIR = '/Users/zq-home-dir/Library/Application Support/Business Intelligence Factory/logs';
/** The start of the data folder's name: like the application folder, it has spaces. */
export const DATA_DIR_PREFIX = 'zq data folder ';
/** A page of a site under research, as it stands in the first line of a failure message. In no standard bundle. */
export const SITE_HOST = 'zq-site-under-research.example';
export const SITE_URL = `https://${SITE_HOST}/pricing?plan=pro`;
/** The failure reasons of withheld research (a task, its run, an experiment arm). In no bundle at either level. */
export const WITHHELD_REASONS: string[] = [];
/** Parts of machine paths that are in no bundle. */
export const MACHINE_PARTS = ['zq-home-dir', 'Application Support', 'zq data folder'];

const T0 = Date.parse('2026-11-02T10:00:00.000Z');
const at = (minutes: number): string => new Date(T0 + minutes * 60_000).toISOString();

export type Seeded = Awaited<ReturnType<typeof seedWorld>>;

/** See the module doc. `opened`: every store opened is pushed there, for the caller to close. */
export async function seedWorld(opened: Store[]) {
  let uploadId: string | undefined;
  let withheldFailures = 0;
  const pick: Picker = (r) => {
    const cites = r.task?.subject === 'cites-upload';
    if (r.kind === 'work') {
      if (r.task?.subject === 'fails') return async () => { throw new Error(`open '${MACHINE_DIR}/run.log' failed\n${research('failure-tail')}`); };
      // Withheld research (own stakeholders of a node with a hidden one): its task, and the arms of an experiment on it.
      if (r.task?.subject === 'withheld') {
        return async () => {
          const reason = never(`withheld-failure-${withheldFailures++}`);
          WITHHELD_REASONS.push(tokenOf(reason));
          throw new Error(reason);
        };
      }
      return async (t) => {
        let evidence = uploadId;
        if (!cites) {
          const a = (await t.call('save_artifact', { kind: 'text', mime: 'text/plain', content: research('artifact-content') })) as { artifactId: string };
          evidence = a.artifactId;
        }
        await t.call('save_finding', {
          claim: cites ? never('upload-derived-claim') : research('finding-claim'), subject: cites ? never('upload-derived-subject') : research('finding-subject'),
          evidence: [evidence],
        });
        await t.call('submit_result', { summary: cites ? never('upload-derived-summary') : research('deliverable-summary'), evidence: [evidence] });
      };
    }
    if (r.kind === 'review') {
      return r.round === 1
        ? review(3, [{ class: 'blocking', description: cites ? never('upload-review-issue') : research('review-issue') }])
        : review(9);
    }
    if (r.kind === 'revise') return revise()(r);
    if (r.kind === 'audit') return review(3, [{ class: 'substantive', description: research('audit-issue') }]);
    return undefined;
  };
  const s = researchSetup(opened, {
    dir: mkdtempSync(join(tmpdir(), DATA_DIR_PREFIX)),
    pick,
    config: (c) => {
      c.user = { id: USER };
      c.personaPanel = {};
      c.budgets = { workspace: { maxCostUsd: 500 } };
    },
  });
  const { store } = s;
  const root = createWorkspace(store, { name: NAMES.business, sector: 'retail' });
  const child = createWorkspace(store, {
    name: NAMES.child, sector: 'retail', parentWorkspaceId: root.id, scope: { level: 'division', name: NAMES.scope, description: research('scope-description') },
  });
  const other = createWorkspace(store, { name: NAMES.other, sector: 'logistics' });
  store.identities.insert({ id: newId('idn'), workspaceId: root.id, site: 'shop.example', name: 'n', email: 'zq@mail.example', password: PASSWORD, emailPassword: INBOX_PASSWORD, createdAt: at(0) });

  const upload = uploadInternal(root.id, { name: `${tokenOf(never('upload-name'))}.txt`, bytes: new TextEncoder().encode(never('upload-body')), mime: 'text/plain' }, s);
  uploadId = upload.id;

  const model = { provider: 'claude' as const, model: 'sonnet' };
  const task = (extra: Partial<Task>) => addTask(store, { workspaceId: root.id, brief: research('task-brief'), acceptanceCriteria: [research('task-criterion')], ...extra });
  const publicTask = await runTaskWithReview(task({ subject: research('task-subject') }), s.deps);
  const uploadTask = await runTaskWithReview(task({ subject: 'cites-upload' }), s.deps);
  const failedTask = await runTaskWithReview(task({ subject: 'fails' }), s.deps);
  const otherTask = await runTaskWithReview(addTask(store, { workspaceId: other.id, brief: research('other-task-brief'), subject: research('other-task-subject') }), s.deps);
  const [audit] = await runReviewerAudit(s.deps, { workspaceId: root.id, taskIds: [publicTask.id] });

  const runsOf = (t: Task) => store.agentRuns.list({ taskId: t.id });
  const workerRun = runsOf(publicTask).find((r) => r.role === 'worker')!;
  const finding = store.findings.list({ workspaceId: root.id }).find((f) => f.taskId === publicTask.id)!;
  const uploadFinding = store.findings.list({ workspaceId: root.id }).find((f) => f.taskId === uploadTask.id)!;

  // Usage and attempts of the worker run (a rate-limited first attempt whose message names a folder).
  usageRepos(store).agentUsage.insert({
    id: newId('use'), workspaceId: root.id, runId: workerRun.id, taskId: publicTask.id, role: 'worker', provider: 'claude', model: 'sonnet',
    promptVersion: workerRun.promptVersion ?? 'p', attempt: 1, inputTokens: 1000, outputTokens: 200, cacheReadTokens: 50, cacheWriteTokens: 10, costUsd: 0.0123, createdAt: at(1),
  });
  usageRepos(store).agentRunAttempts.insert({
    id: newId('att'), workspaceId: root.id, runId: workerRun.id, attempt: 1, startedAt: workerRun.startedAt, endedAt: workerRun.startedAt, exitCode: 1, rateLimited: false,
    failureReason: `spawn failed: ENOENT ${s.dir}/${root.id}/runs/r1/cwd\n${research('attempt-failure-tail')}`,
  });

  // A failure whose first line names a page of a site under research.
  usageRepos(store).agentRunAttempts.insert({
    id: newId('att'), workspaceId: root.id, runId: workerRun.id, attempt: 2, startedAt: workerRun.startedAt, endedAt: workerRun.startedAt, exitCode: 1, rateLimited: false,
    failureReason: `navigation failed: net::ERR_NAME_NOT_RESOLVED at ${SITE_URL}\n${research('url-failure-tail')}`,
  });

  // Withheld research: own-stakeholder research of a node that has a hidden stakeholder. Its task
  // failed, and an experiment re-ran it: every failure reason of it holds a marker.
  store.personas.insert({
    id: newId('per'), workspaceId: child.id, slug: 'stk-hidden', segment: never('hidden-stakeholder-segment'), profile: {}, agentMdPath: '', version: 1,
    audience: 'internal', status: 'verified', kind: 'stakeholder', stakeholderType: 'leader', subjectKind: 'own', disclosure: 'hidden',
  });
  const withheldTask = await runTaskWithReview(addTask(store, { workspaceId: child.id, type: 'own_stakeholders', brief: research('withheld-task-brief'), subject: 'withheld' }), s.deps);
  const experiment = await runExperiment(s.deps, { taskId: withheldTask.id, arms: [{}, {}], actor: USER });
  // The experiment itself failed too, and says why in more than one line.
  const experimentReason = never('withheld-experiment-failure');
  WITHHELD_REASONS.push(tokenOf(experimentReason));
  store.db.prepare('UPDATE experiments SET failure_reason = ? WHERE id = ?').run(`arm A stopped\n${experimentReason}`, experiment.id);
  // An experiment on research that is not withheld, which failed: its message is the fuller level's to carry.
  const failedExperimentId = newId('exp');
  store.db
    .prepare(
      `INSERT INTO experiments (id, workspace_id, root_workspace_id, source_task_id, research_run_id, arms, repeats, status, failure_reason, actor, created_at, ended_at)
       VALUES (?, ?, ?, ?, ?, '[]', 1, 'failed', ?, ?, ?, ?)`,
    )
    .run(failedExperimentId, root.id, root.id, publicTask.id, publicTask.runId, `arm B could not start\n${research('experiment-failure-tail')}`, USER, at(3), at(4));

  // Other research content of the tree.
  const persona = store.personas.insert({
    id: newId('per'), workspaceId: root.id, slug: tokenOf(research('persona-slug')), segment: research('persona-segment'),
    profile: { goals: { value: research('persona-profile'), confidence: 0.6, evidence: [] } }, agentMdPath: '', version: 1, audience: 'external', status: 'verified',
  });
  const reaction = (personaId: string, extra: Record<string, unknown> = {}) => ({
    personaId, scores: { appeal: 4, adoption: 2, willingnessToPay: 3, friction: 2 }, concerns: [research('panel-concern')], reasoning: research('panel-reasoning'),
    wouldChangeMind: research('panel-change-mind'), simulated: true as const, round: 2, seat: { ...model, effort: 'high' }, textHash: 'h1', ...extra,
  });
  const rec = store.recommendations.insert({
    id: newId('rec'), workspaceId: root.id, title: research('recommendation-title'), summary: research('recommendation-summary'), criteria: { impact: 4 },
    findingIds: [finding.id], personaFeedback: [reaction(persona.id, { sameAsBaseline: true })], priority: 3.2, createdAt: at(5), status: 'verified',
  });
  store.personaPanelReads.insert({ id: newId('ppr'), workspaceId: root.id, recommendationId: rec.id, kind: 'persona', personaId: persona.id, round: 1, textHash: 'h0', reaction: reaction(persona.id, { round: 1 }), createdAt: at(4) });
  store.personaPanelReads.insert({
    id: newId('ppr'), workspaceId: root.id, recommendationId: rec.id, kind: 'baseline', round: 1, textHash: 'h1', agentRunId: workerRun.id,
    reaction: (({ personaId: _p, ...b }) => b)(reaction('x')), createdAt: at(4),
  });
  store.competitors.insert({
    id: newId('cmp'), workspaceId: root.id, name: research('competitor-name'), site: 'https://competitor.example', threat: 3, directness: 4,
    comparison: { pricing: 1, onboarding: 2, ux: 3, features: 4 }, evidence: [], createdAt: at(5), updatedAt: at(5), status: 'verified',
  });
  const symptom = store.symptoms.insert({ id: newId('sym'), workspaceId: root.id, kind: 'symptom', title: research('symptom-title'), detail: research('symptom-detail'), criteria: {}, evidence: [] });
  store.symptomHypotheses.insert({ id: newId('hyp'), workspaceId: root.id, symptomId: symptom.id, hypothesis: research('hypothesis'), confidence: 0.4, evidence: [], createdAt: at(5) });
  store.interview.insert({ id: newId('trn'), workspaceId: root.id, role: 'user', text: research('interview-turn'), createdAt: at(1) });
  store.profiles.update(root.id, { data: { ...(store.profiles.get(root.id)?.data ?? {}), about: research('profile-about') } });
  const unit = store.unitProposals.insert({
    id: newId('upr'), workspaceId: root.id, name: research('unit-name'), description: research('unit-description'), level: 'division', audiences: ['external'],
    evidence: [], reasoning: research('unit-reasoning'), status: 'rejected', createdAt: at(5), decidedAt: at(6), actor: USER, decisionReason: own('unit-reject-reason'),
  });
  recordFeedback(store, {
    workspaceId: root.id, actor: USER, kind: 'proposal_reject', targetType: 'unit_proposal', targetId: unit.id, createdAt: at(6),
    beforeJson: { status: 'proposed', name: research('unit-name') }, afterJson: { status: 'rejected' }, reason: own('unit-reject-reason'),
  });

  // The tester's own feedback: ratings and feedback events, with reasons as typed.
  store.ratings.insert({
    id: newId('rat'), workspaceId: root.id, targetType: 'finding', targetId: finding.id, criterion: 'confidence', agentValue: 4, verdict: 'disagree', userValue: 2,
    reason: `${own('rating-reason')} I used ${PASSWORD} on ${NAMES.business}`, createdAt: at(10), actor: USER, agentRunId: workerRun.id, promptVersion: workerRun.promptVersion ?? 'p',
  });
  store.ratings.insert({
    id: newId('rat'), workspaceId: root.id, targetType: 'finding', targetId: finding.id, criterion: 'severity', agentValue: research('rating-agent-value'), verdict: 'agree',
    createdAt: at(11), actor: USER, agentRunId: workerRun.id,
  });
  // A rating of an upload-derived finding: its reason speaks of the upload and stays out.
  store.ratings.insert({
    id: newId('rat'), workspaceId: root.id, targetType: 'finding', targetId: uploadFinding.id, criterion: 'confidence', agentValue: 4, verdict: 'disagree', userValue: 1,
    reason: never('upload-rating-reason'), createdAt: at(12), actor: USER,
  });
  const include = recordFeedback(store, {
    workspaceId: root.id, actor: USER, kind: 'include_override', targetType: 'finding', targetId: finding.id, createdAt: at(13),
    beforeJson: { include: null, status: 'verified', claim: research('feedback-before-claim') }, afterJson: { include: false, note: research('feedback-after-note') },
    reason: own('feedback-reason'),
  });
  recordFeedback(store, {
    workspaceId: root.id, actor: USER, kind: 'include_override', targetType: 'finding', targetId: uploadFinding.id, createdAt: at(14),
    beforeJson: { include: null, status: 'verified' }, afterJson: { include: false }, reason: never('upload-feedback-reason'),
  });
  recordFeedback(store, {
    workspaceId: root.id, actor: USER, kind: 'stakeholder_note', targetType: 'stakeholder', targetId: persona.id, createdAt: at(15),
    afterJson: { action: 'note' }, reason: never('internal-stakeholder-note'),
  });
  recordFeedback(store, { workspaceId: root.id, actor: USER, kind: 'user_action', targetType: 'workspace', targetId: root.id, createdAt: at(16), afterJson: { action: 'start_research', phases: 2 } });
  // Records whose shape is not the tool's: a profile as the interviewer shaped it (its keys are the
  // agent's words) edited by the person, and a before / after value with keys of that kind.
  store.profiles.update(root.id, {
    data: { ...(store.profiles.get(root.id)?.data ?? {}), pricing: { [keyed('profile-nested-key')]: 49 }, [keyed('profile-section-key')]: { amount: 120000 } },
  });
  editProfile(
    store, root.id,
    { pricing: { [keyed('profile-nested-key')]: 59, [keyed('profile-added-key')]: true }, [keyed('profile-section-key')]: { amount: 130000, [keyed('profile-deep-key')]: { n: 1 } } },
    { actor: USER, reason: own('profile-edit-reason') },
  );
  recordFeedback(store, {
    workspaceId: root.id, actor: USER, kind: 'include_override', targetType: 'finding', targetId: finding.id, createdAt: at(17),
    beforeJson: { include: null, [keyed('before-key')]: 3 }, afterJson: { include: true, weights: { [keyed('after-nested-key')]: 0.4, [`${NAMES.other} share`]: 0.6 } },
  });

  // A single word of a business name: alone in a reason the tester typed, and inside the key of a free-form record.
  recordFeedback(store, {
    workspaceId: root.id, actor: USER, kind: 'include_override', targetType: 'finding', targetId: finding.id, createdAt: at(18),
    beforeJson: { include: true }, afterJson: { include: false, zephyrineShare: 0.7, outfitters_total: 3 },
    reason: `${own('name-word-reason')} the figures for Quillfeather and for zephyrine's shop`,
  });

  // A competitor named in a reason the tester typed: whole, and by its distinctive word alone.
  store.competitors.insert({
    id: 'cmp_named', workspaceId: root.id, name: 'Brindlewick Freight', threat: 2, directness: 2,
    comparison: { pricing: 1, onboarding: 1, ux: 1, features: 1 }, evidence: [], createdAt: at(18), updatedAt: at(18), status: 'verified',
  });
  recordFeedback(store, {
    workspaceId: root.id, actor: USER, kind: 'include_override', targetType: 'finding', targetId: finding.id, createdAt: at(19),
    beforeJson: { include: false }, afterJson: { include: true },
    reason: `${own('competitor-name-reason')} we lost two deals to Brindlewick Freight, and Brindlewick undercut us`,
  });

  // Requests to the person: an agent's, an escalation's, a budget's.
  store.userRequests.insert({
    id: newId('req'), workspaceId: root.id, agentRunId: workerRun.id, taskId: publicTask.id, kind: 'login', site: 'shop.example', details: research('request-details'),
    status: 'resolved', response: research('request-response'), createdAt: at(20), resolvedAt: at(50), actor: USER,
  });
  store.userRequests.insert({
    id: newId('req'), workspaceId: root.id, agentRunId: workerRun.id, taskId: failedTask.id, kind: 'escalation', details: research('escalation-question'), status: 'resolved',
    response: research('escalation-answer'), createdAt: at(21), resolvedAt: at(81), actor: USER,
    optionsJson: { options: [research('escalation-option-a'), research('escalation-option-b')], recommended: 0, rationale: research('escalation-rationale'), choice: 1 },
  });
  store.userRequests.insert({
    id: newId('req'), workspaceId: root.id, agentRunId: 'budget', kind: 'approval', site: `budget:workspace:${root.id}`,
    details: 'Workspace budget reached: 1 tokens / $500.00 spent. [budget-cap tokens=- cost=500]', status: 'resolved', createdAt: at(22), resolvedAt: at(25), actor: USER,
  });

  // A request that "Stop research" closed: the agent that asked was stopped, the person denied nothing.
  store.userRequests.insert({
    id: newId('req'), workspaceId: root.id, agentRunId: workerRun.id, taskId: publicTask.id, kind: 'approval', site: 'shop.example', details: research('stopped-request-details'),
    status: 'denied', response: STOPPED_REQUEST_RESPONSE, createdAt: at(26), resolvedAt: at(27),
  });

  // Policy events.
  recordPolicyEvent(store, { workspaceId: root.id, agentRunId: workerRun.id, taskId: publicTask.id, role: 'worker', kind: 'blocked', action: 'save_finding', site: 'shop.example', detail: research('policy-detail'), createdAt: at(23) });
  recordPolicyEvent(store, { workspaceId: root.id, agentRunId: workerRun.id, role: 'worker', kind: 'approval_denied', action: research('policy-action'), detail: research('policy-answer'), createdAt: at(24) });

  // Lessons: a rule, a decided proposal, a retro, a recorded signal.
  const lessons = lessonRepos(store);
  const proposal = lessons.proposals.insert({
    id: newId('lprop'), rootWorkspaceId: root.id, role: 'worker', action: 'add', category: 'review:blocking:news_scan', text: research('lesson-proposal-text'),
    rationale: research('lesson-rationale'), evidence: [{ kind: 'review_issue', id: 'x', quote: research('lesson-evidence-quote') }], stats: { tasks: 3 }, source: 'engine',
    status: 'rejected', createdAt: at(30), decidedAt: at(31), actor: USER, reason: own('lesson-reject-reason'),
  });
  lessons.rules.insert({
    id: newId('lrule'), rootWorkspaceId: root.id, role: 'worker', category: 'review:blocking:news_scan', marker: 'L-7F3A2C', text: research('lesson-rule-text'), strength: 1,
    version: 1, status: 'active', source: 'engine', proposalId: proposal.id, actor: USER, createdAt: at(32), changedAt: at(32),
  });
  lessons.retros.insert({
    id: newId('retro'), rootWorkspaceId: root.id, status: 'done', triggeredBy: 'user', windowStart: at(0), windowEnd: at(60),
    digest: { tasks: 3, signals: 2, [keyed('retro-digest-key')]: 4 },
    evidenceIds: ['a', 'b'], proposalIds: [proposal.id], summary: research('retro-summary'), createdAt: at(60), endedAt: at(61),
  });
  lessons.retros.insert({
    id: newId('retro'), rootWorkspaceId: root.id, status: 'failed', triggeredBy: 'schedule', windowStart: at(0), windowEnd: at(70), digest: { tasks: 3 }, evidenceIds: [],
    proposalIds: [], failureReason: `retro run failed: no answer\n${research('retro-failure-tail')}`, createdAt: at(70), endedAt: at(71),
  });
  recordLessonSignal(store, { workspaceId: root.id, role: 'reviewer', category: 'audit:missed_issue', source: 'test', taskId: publicTask.id, note: research('signal-note'), createdAt: at(33) });

  // Persona learning.
  const pl = personaLearningRepos(store);
  const learningRun = pl.runs.insert({
    id: newId('plr'), rootWorkspaceId: root.id, personaId: persona.id, status: 'proposed', signalsThrough: at(34), shownSignalIds: ['s1', 's2'], shownStatementIds: [],
    stats: { n: 5, agree: 1, disagree: 4, items: 3, lower: 0.4 }, assumption: research('learning-assumption'), createdAt: at(34), endedAt: at(35),
  });
  pl.runs.insert({
    id: newId('plr'), rootWorkspaceId: root.id, personaId: persona.id, status: 'failed', signalsThrough: at(37), shownSignalIds: [], shownStatementIds: [],
    stats: { n: 5, agree: 1, disagree: 4, items: 3, lower: 0.4 }, failureReason: `learning run failed: no answer\n${research('learning-failure-tail')}`, createdAt: at(37), endedAt: at(38),
  });
  pl.proposals.insert({
    id: newId('ppr'), rootWorkspaceId: root.id, workspaceId: root.id, personaId: persona.id, runId: learningRun.id, action: 'add', text: research('persona-proposal-text'),
    rationale: research('persona-proposal-rationale'), evidence: ['s1'], stats: { n: 5 }, source: 'retro', status: 'accepted', finalText: research('persona-proposal-final'),
    createdAt: at(35), decidedAt: at(36), actor: USER, reason: own('persona-accept-reason'),
  });
  pl.adjustments.insert({
    id: newId('pad'), rootWorkspaceId: root.id, workspaceId: root.id, personaId: persona.id, marker: 'P-11AA22', text: research('persona-adjustment-text'), version: 1,
    status: 'active', source: 'retro', actor: USER, stats: { n: 5 }, internal: false, createdAt: at(36), changedAt: at(36),
  });

  // A council round of the public task (the round is a Decision; see council/store.ts).
  const issue = (id: string, standing: 'upheld' | 'advisory', text: string) => ({ id, class: 'substantive' as const, description: text, raisedBy: ['evidence-reader'], standing });
  store.decisions.insert({
    id: newId('dec'), workspaceId: root.id, agentRunId: newCouncilRoundId(publicTask.id), role: 'reviewer', model, kind: 'review', refs: [publicTask.id], promptVersion: 'p', createdAt: at(40),
    payload: {
      tool: 'harness', event: 'council_review', taskId: publicTask.id, round: 1, score: 6, pass: false,
      issues: [issue('C1', 'upheld', research('council-upheld'))], advisory: [issue('C2', 'advisory', research('council-advisory'))],
      dropped: [{ issue: { id: 'C3', class: 'nit', description: research('council-dropped') }, raisedBy: ['evidence-reader'], rule: 'nit' }],
      questions: [{ text: research('council-question'), raisedBy: ['evidence-reader'] }], followUps: [{ text: research('council-follow-up'), raisedBy: ['evidence-reader'] }],
      members: [
        { name: 'evidence-reader', provider: 'claude', model: 'opus', lens: 'evidence', blocking: true, state: 'reviewed', score: 6, countedScore: 6 },
        { name: 'brief-reader', provider: 'codex', model: 'gpt-6.1-sol', lens: 'brief', blocking: false, state: 'unavailable', reason: research('council-member-reason') },
      ],
      passScore: 9, blockOn: 'any', onUnavailable: 'report',
    },
  });

  return {
    ...s, root, child, other, upload, publicTask, uploadTask, failedTask, otherTask, audit, workerRun, finding, uploadFinding, persona, rec, include, proposal,
    withheldTask, experiment, failedExperimentId,
  };
}
