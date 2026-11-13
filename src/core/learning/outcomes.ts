import type { Store } from '../store/db.js';
import { newId } from '../store/repos.js';
import type { Role } from '../config/schema.js';
import type { Decision, Task } from '../types.js';
import { learningRepos } from './store.js';
import { experimentTaskIds, isAuditRun, isTaggedDecision } from './runTags.js'; // learning loop WP-F
import {
  OUTCOME_LABELS,
  type DecisionOutcome,
  type OutcomeLabel,
  type OutcomeReport,
  type OutcomeReportRow,
  type OutcomeSource,
  type OutcomeTargetType,
} from './types.js';

/**
 * Decision outcomes (learning loop WP-C, migration 16): after-the-fact labels on agent decisions or
 * non-decision subjects, written automatically by the review loop (task end, superseded outputs,
 * review disputes), the scheduler's "what changed" hook (`whatChangedOutcomes.ts`) and the user's
 * include overrides / rejects (via feedback events, `feedbackOutcomes.ts`). Everything goes through
 * `recordOutcome`, the single writer.
 */

/** Actor of human outcomes when the caller passes none (the feedback listener passes the event's actor). */
export const DEFAULT_USER_ACTOR = 'local-user';
/** Actor of automatic outcomes (review loop, scheduler, disputes). */
export const SYSTEM_ACTOR = 'system';

const isUserSource = (s: OutcomeSource) => s === 'user_override' || s === 'user_reject';

/**
 * Input of `recordOutcome`. Give the judged agent `decisionId`, or a non-decision subject
 * (`subjectType` + `subjectId`, e.g. a fact version) — with its saving `decisionId` when one exists.
 */
export type RecordOutcomeInput = {
  /** The agent decision being judged (for a subject: the decision that saved it, if any). */
  decisionId?: string;
  /** Non-decision subject, e.g. `fact_version` + its id. */
  subjectType?: string;
  subjectId?: string;
  /** Required when there is no (known) decision; otherwise the decision's workspace. */
  workspaceId?: string;
  outcome: string;
  label: OutcomeLabel;
  source: OutcomeSource;
  /**
   * The source event (feedback event id, fact observation id, or for `stale` the caller's
   * `<factId>|stale|<lastConfirmedAt>`). Calls are idempotent per (subject, outcome, sourceKey).
   * Without it, automatic sources are idempotent per (decision, outcome, label, source, target) and
   * `user_*` sources append.
   */
  sourceKey?: string;
  evidence?: Record<string, unknown>;
  /** Human actor (user sources; default `local-user`). Automatic sources are always `system`. */
  actor?: string;
  /** Defaults to the task of the decision's agent run. */
  taskId?: string;
  targetType?: OutcomeTargetType;
  targetId?: string;
  /** For a subject without a decision: the run / role / prompt version that produced it, when known. */
  runId?: string;
  role?: Role;
  promptVersion?: string;
};

/**
 * THE single writer of `decision_outcomes`. With a known `decisionId` it copies the decision's
 * workspace, role, prompt version and agent run, plus the task (and task type) of that run. With
 * only a subject it writes on the subject (`workspaceId` required). An unknown decision without a
 * subject, or neither, writes nothing (`undefined`). Idempotent per (subject — else decision —,
 * outcome, `sourceKey`) via a unique index; see `RecordOutcomeInput.sourceKey` for calls without one.
 */
export function recordOutcome(store: Store, input: RecordOutcomeInput): DecisionOutcome | undefined {
  const decision = input.decisionId ? store.decisions.get(input.decisionId) : undefined;
  const subject = input.subjectId ? { type: input.subjectType ?? 'subject', id: input.subjectId } : undefined;
  if (!decision && !subject) return undefined;
  const workspaceId = decision?.workspaceId ?? input.workspaceId;
  if (!workspaceId) throw new Error('recordOutcome: a subject without a decision needs a workspaceId');
  const user = isUserSource(input.source);
  const sourceKey = input.sourceKey ?? (user ? undefined : `auto:${input.source}:${input.label}:${input.targetId ?? ''}`);
  const repo = learningRepos(store).decisionOutcomes;
  if (sourceKey !== undefined) {
    const existing = existingOutcome(store, subject ?? { type: 'decision', id: decision!.id }, input.outcome, sourceKey);
    if (existing) return existing;
  }
  const taskId = input.taskId ?? (decision ? taskOfDecision(store, decision) : undefined);
  const task = taskId ? store.tasks.get(taskId) : undefined;
  const row: DecisionOutcome = {
    id: newId('dout'),
    workspaceId,
    outcome: input.outcome,
    label: input.label,
    evidenceJson: input.evidence ?? {},
    source: input.source,
    actor: user ? (input.actor ?? DEFAULT_USER_ACTOR) : SYSTEM_ACTOR,
    createdAt: new Date().toISOString(),
  };
  if (decision) row.decisionId = decision.id;
  if (subject) {
    row.subjectType = subject.type;
    row.subjectId = subject.id;
  }
  const runId = decision ? runOfDecision(store, decision) : input.runId;
  if (runId) row.runId = runId;
  const role = decision?.role ?? input.role;
  if (role) row.role = role;
  const promptVersion = decision?.promptVersion ?? input.promptVersion;
  if (promptVersion) row.promptVersion = promptVersion;
  if (sourceKey !== undefined) row.sourceKey = sourceKey;
  if (taskId) row.taskId = taskId;
  if (task) row.taskType = task.type;
  if (input.targetType) row.targetType = input.targetType;
  if (input.targetId) row.targetId = input.targetId;
  return repo.insert(row);
}

/** The row already written for (subject, outcome, sourceKey), if any (mirrors the unique index). */
function existingOutcome(store: Store, subject: { type: string; id: string }, outcome: string, sourceKey: string): DecisionOutcome | undefined {
  const hit = store.db
    .prepare(
      `SELECT id FROM decision_outcomes
       WHERE COALESCE(subject_type, 'decision') = ? AND COALESCE(subject_id, decision_id) = ? AND outcome = ? AND source_key = ?`,
    )
    .get(subject.type, subject.id, outcome, sourceKey) as { id: string } | undefined;
  return hit ? learningRepos(store).decisionOutcomes.get(hit.id) : undefined;
}

/** The agent run behind a decision; system decisions (user / scheduler, `payload.actor`) have none. */
function runOfDecision(store: Store, d: Decision): string | undefined {
  if (typeof (d.payload as { actor?: unknown } | null)?.actor === 'string') return undefined;
  return store.agentRuns.get(d.agentRunId)?.id ?? (d.promptVersion !== 'n/a' ? d.agentRunId : undefined);
}

function taskOfDecision(store: Store, d: Decision): string | undefined {
  return store.agentRuns.get(d.agentRunId)?.taskId;
}

// ---------------------------------------------------------------------------
// lookups

export type OutputKind = 'finding' | 'recommendation' | 'persona' | 'competitor' | 'hypothesis';

const SAVE_TOOL: Record<OutputKind, { tool: string; key: string }> = {
  finding: { tool: 'save_finding', key: 'findingId' },
  recommendation: { tool: 'save_recommendation', key: 'recommendationId' },
  persona: { tool: 'save_persona', key: 'personaId' },
  competitor: { tool: 'save_competitor', key: 'competitorId' },
  hypothesis: { tool: 'save_hypothesis', key: 'hypothesisId' },
};

function outputOf(store: Store, kind: OutputKind, id: string): { workspaceId: string; taskId?: string; status?: string } | undefined {
  switch (kind) {
    case 'finding':
      return store.findings.get(id);
    case 'recommendation':
      return store.recommendations.get(id);
    case 'persona':
      return store.personas.get(id);
    case 'competitor':
      return store.competitors.get(id);
    case 'hypothesis':
      return store.symptomHypotheses.get(id);
  }
}

/** The (latest) agent decision that saved an output (`save_finding`, `save_recommendation`, ...). */
export function outputSaveDecision(store: Store, kind: OutputKind, id: string): Decision | undefined {
  const { tool, key } = SAVE_TOOL[kind];
  const workspaceId = outputOf(store, kind, id)?.workspaceId;
  const candidates = workspaceId ? store.decisions.list({ workspaceId }) : [];
  return candidates.filter((d) => {
    const p = d.payload as Record<string, unknown> | null;
    return !!p && p.tool === tool && p[key] === id;
  }).at(-1);
}

/** Decisions of a task's runs with the given role(s), in order. */
function taskRunDecisions(store: Store, task: Pick<Task, 'id' | 'workspaceId'>, roles: readonly string[]): Decision[] {
  return store.agentRuns
    .list({ taskId: task.id })
    .filter((r) => r.workspaceId === task.workspaceId && roles.includes(r.role))
    .filter((r) => !isAuditRun(store, r.id)) // learning loop WP-F: reviewer audits are not the task's reviews
    .flatMap((r) => store.decisions.list({ agentRunId: r.id }))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

const WORKER_ROLES = ['worker', 'synthesizer'] as const;

/** The task's latest deliverable (`submit_result`) decision, else its latest worker-run decision. */
export function taskDeliverableDecision(store: Store, task: Pick<Task, 'id' | 'workspaceId'>): Decision | undefined {
  const decisions = taskRunDecisions(store, task, WORKER_ROLES);
  return decisions.filter((d) => (d.payload as { tool?: string } | null)?.tool === 'submit_result').at(-1) ?? decisions.at(-1);
}

/** The latest review decision (`submit_review` or the loop's synthetic review) of the task's reviewer runs. */
export function taskLastReviewDecision(store: Store, task: Pick<Task, 'id' | 'workspaceId'>): Decision | undefined {
  return taskRunDecisions(store, task, ['reviewer']).filter((d) => d.kind === 'review').at(-1);
}

// ---------------------------------------------------------------------------
// task end (review loop) and superseded outputs

type IssueLike = { class: string; synthetic?: boolean };

/** Label of an unverified task from the final review's open issues. */
export function unverifiedLabel(finalIssues: IssueLike[], finalReviewSynthetic: boolean): OutcomeLabel {
  if (finalReviewSynthetic) return 'weak-review';
  const classes = new Set(finalIssues.filter((i) => !i.synthetic).map((i) => i.class));
  if (classes.has('scope_expansion') && !classes.has('blocking') && !classes.has('substantive')) return 'over-scoped';
  return 'missed-evidence';
}

/**
 * Outcomes of a task that just ended (`verified | unverified | failed`): one on its deliverable
 * decision (`confirmed`; `over-scoped` / `missed-evidence` / `weak-review` for unverified;
 * `run-failed`) and one `superseded` / `missed-evidence` per output withdrawn by a later round, on
 * that output's save decision. Idempotent. Call after the task's outputs got their final status.
 */
export function recordTaskEndOutcomes(store: Store, task: Task): DecisionOutcome[] {
  const out: DecisionOutcome[] = [];
  const status = task.status;
  if (status !== 'verified' && status !== 'unverified' && status !== 'failed') return out;
  const review = taskLastReviewDecision(store, task);
  const rp = (review?.payload ?? {}) as { score?: unknown; issues?: unknown; event?: string };
  const roundRows = learningRepos(store)
    .reviewIssues.list({ taskId: task.id, round: task.round })
    .filter((r) => r.workspaceId === task.workspaceId);
  // A review repeated after a restart replaces the earlier one: only its latest reviewer run counts.
  const finalIssues = roundRows.filter((r) => r.reviewerRunId === roundRows.at(-1)?.reviewerRunId);
  const deliverable = taskDeliverableDecision(store, task);
  if (deliverable) {
    const label: OutcomeLabel =
      status === 'verified'
        ? 'confirmed'
        : status === 'failed'
          ? 'run-failed'
          : unverifiedLabel(
              finalIssues.length ? finalIssues : Array.isArray(rp.issues) ? (rp.issues as IssueLike[]) : [],
              rp.event === 'synthetic_review',
            );
    const evidence: Record<string, unknown> = { round: task.round };
    if (status !== 'failed' && typeof rp.score === 'number') evidence.score = rp.score;
    if (status !== 'failed' && review) evidence.reviewDecisionId = review.id;
    if (status === 'unverified') {
      evidence.openIssues = finalIssues.filter((i) => i.status === 'open').map((i) => ({ issueId: i.issueId, class: i.class }));
    }
    const o = recordOutcome(store, {
      decisionId: deliverable.id, outcome: status, label, source: 'review_loop', evidence,
      taskId: task.id, targetType: 'task', targetId: task.id,
    });
    if (o) out.push(o);
  }
  for (const [kind, rows] of ownedOutputs(store, task)) {
    for (const x of rows) {
      if (x.status !== 'superseded') continue;
      const save = outputSaveDecision(store, kind, x.id);
      if (!save) continue;
      const o = recordOutcome(store, {
        decisionId: save.id, outcome: 'superseded', label: 'missed-evidence', source: 'supersede',
        evidence: { taskStatus: status, round: task.round, taskRound: x.taskRound ?? null },
        taskId: task.id, targetType: kind, targetId: x.id,
      });
      if (o) out.push(o);
    }
  }
  return out;
}

type OwnedOutput = { id: string; workspaceId: string; status?: string | undefined; taskRound?: number | undefined };

function ownedOutputs(store: Store, task: Pick<Task, 'id' | 'workspaceId'>): Array<[OutputKind, OwnedOutput[]]> {
  const own = <T extends OwnedOutput>(xs: T[]) => xs.filter((x) => x.workspaceId === task.workspaceId);
  return [
    ['finding', own(store.findings.list({ taskId: task.id }))],
    ['recommendation', own(store.recommendations.list({ taskId: task.id }))],
    ['persona', own(store.personas.list({ taskId: task.id }))],
    ['competitor', own(store.competitors.list({ taskId: task.id }))],
    ['hypothesis', own(store.symptomHypotheses.list({ taskId: task.id }))],
  ];
}

// ---------------------------------------------------------------------------
// user include overrides and rejects

/**
 * Outcomes of a user include override on an output. Called only by the feedback listener
 * (`feedbackOutcomes.ts`) for `include_override` events, never by the core setters. `false` (exclude) → `excluded` /
 * `user-rejected` on the output's save decision, plus `excluded_after_pass` / `weak-review` on the
 * passing review when the output was `verified`. `true` on an output that is not verified →
 * `included` / `confirmed`. `null` (reset) and `true` on a verified output record nothing; outputs
 * without a save decision record nothing.
 */
export function recordOverrideOutcome(
  store: Store,
  input: {
    targetType: OutputKind;
    targetId: string;
    include: boolean | null;
    actor?: string;
    reason?: string;
    /** The feedback event of the override: evidence + idempotency key (`feedback:<id>`). */
    feedbackEventId?: string;
  },
): DecisionOutcome[] {
  const { targetType, targetId, include } = input;
  if (include === null) return [];
  const output = outputOf(store, targetType, targetId);
  if (!output) return [];
  const status = output.status ?? 'pending';
  if (include && status === 'verified') return [];
  const save = outputSaveDecision(store, targetType, targetId);
  if (!save) return [];
  const evidence: Record<string, unknown> = { include, status };
  if (input.reason) evidence.reason = input.reason;
  if (input.feedbackEventId) evidence.feedbackEventId = input.feedbackEventId;
  const common = {
    source: 'user_override' as const, targetType, targetId,
    ...(input.actor ? { actor: input.actor } : {}),
    ...(input.feedbackEventId ? { sourceKey: `feedback:${input.feedbackEventId}` } : {}),
  };
  const taskId = output.taskId;
  const out: DecisionOutcome[] = [];
  const first = recordOutcome(store, {
    ...common, decisionId: save.id, outcome: include ? 'included' : 'excluded', label: include ? 'confirmed' : 'user-rejected', evidence,
    ...(taskId ? { taskId } : {}),
  });
  if (first) out.push(first);
  if (!include && status === 'verified' && taskId) {
    const task = store.tasks.get(taskId);
    const review = task ? taskLastReviewDecision(store, task) : undefined;
    if (review) {
      const o = recordOutcome(store, {
        ...common, decisionId: review.id, outcome: 'excluded_after_pass', label: 'weak-review',
        evidence: { ...evidence, saveDecisionId: save.id }, taskId,
      });
      if (o) out.push(o);
    }
  }
  return out;
}

/** Outcome of the user rejecting a unit proposal (`rejected` / `user-rejected` on its proposal decision). */
export function recordUnitProposalRejected(
  store: Store,
  proposal: { id: string; decisionId?: string | undefined },
  reason: string,
  actor?: string,
  feedbackEventId?: string,
): DecisionOutcome | undefined {
  if (!proposal.decisionId) return undefined;
  return recordOutcome(store, {
    decisionId: proposal.decisionId, outcome: 'rejected', label: 'user-rejected', source: 'user_reject',
    evidence: { ...(reason ? { reason } : {}), ...(feedbackEventId ? { feedbackEventId } : {}) },
    ...(feedbackEventId ? { sourceKey: `feedback:${feedbackEventId}` } : {}), targetType: 'unit_proposal', targetId: proposal.id, ...(actor ? { actor } : {}),
  });
}

// ---------------------------------------------------------------------------
// queries (outcomes report; lessons engine input)

export type OutcomeFilter = {
  workspaceIds?: string[];
  label?: OutcomeLabel;
  source?: OutcomeSource;
  role?: string;
  taskId?: string;
  decisionId?: string;
  promptVersion?: string;
  /** ISO time; only outcomes created at or after it. */
  since?: string;
  /**
   * Learning loop WP-F: outcomes of experiment arm tasks and of decisions made by experiment / audit runs
   * are left out unless true (they must not count twice in normal reports and lessons).
   */
  includeExperiments?: boolean;
};

/** Outcomes in insertion order, filtered (workspaces: e.g. one business tree, never across trees). */
export function listOutcomes(store: Store, filter: OutcomeFilter = {}): DecisionOutcome[] {
  const repo = learningRepos(store).decisionOutcomes;
  const base = {
    ...(filter.label ? { label: filter.label } : {}),
    ...(filter.source ? { source: filter.source } : {}),
    ...(filter.taskId ? { taskId: filter.taskId } : {}),
    ...(filter.decisionId ? { decisionId: filter.decisionId } : {}),
    ...(filter.promptVersion ? { promptVersion: filter.promptVersion } : {}),
  };
  const rows = filter.workspaceIds ? filter.workspaceIds.flatMap((workspaceId) => repo.list({ ...base, workspaceId })) : repo.list(base);
  const experimentTasks = filter.includeExperiments ? undefined : experimentTaskIds(store); // WP-F
  return rows
    .filter((o) => !experimentTasks || !((o.taskId && experimentTasks.has(o.taskId)) || (o.decisionId && isTaggedDecision(store, o.decisionId))))
    .filter((o) => (filter.role ? o.role === filter.role : true))
    .filter((o) => (filter.since ? o.createdAt >= filter.since : true))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/** Counts of each outcome label per role / task type / prompt version over the given workspaces. */
export function outcomeReport(store: Store, workspaceIds: string[]): OutcomeReport {
  const rows = new Map<string, OutcomeReportRow>();
  for (const o of listOutcomes(store, { workspaceIds })) {
    const key = `${o.role ?? ''}\u0000${o.taskType ?? ''}\u0000${o.promptVersion ?? ''}`;
    let row = rows.get(key);
    if (!row) {
      row = { counts: {}, total: 0 };
      if (o.role) row.role = o.role;
      if (o.promptVersion) row.promptVersion = o.promptVersion;
      if (o.taskType) row.taskType = o.taskType;
      rows.set(key, row);
    }
    row.counts[o.label] = (row.counts[o.label] ?? 0) + 1;
    row.total++;
  }
  return {
    labels: [...OUTCOME_LABELS],
    rows: [...rows.values()].sort(
      (a, b) =>
        (a.role ?? '').localeCompare(b.role ?? '') ||
        (a.taskType ?? '').localeCompare(b.taskType ?? '') ||
        (a.promptVersion ?? '').localeCompare(b.promptVersion ?? ''),
    ),
  };
}
