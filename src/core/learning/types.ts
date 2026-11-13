/**
 * Learning loop WP-C (migration 16): decision outcomes and review-issue history.
 * Types only (no runtime imports beyond the role/task-type types), so the web app can import them.
 */
import type { Role, TaskType } from '../config/schema.js';

/**
 * Outcome labels (in the spirit of the reference factory's `.agent-metrics` labels):
 * - `confirmed`: the decision held up (task verified, user included an output the review failed).
 * - `weak-review`: a review was wrong or useless (the user excluded a verified output; the final
 *   review of an unverified task was malformed).
 * - `over-scoped`: the task stayed unverified only on scope-expansion (and nit) issues.
 * - `missed-evidence`: the work missed support (unverified on blocking/substantive issues; an output
 *   withdrawn after review, i.e. superseded).
 * - `stale`: a later scheduled run changed or no longer found the finding (knowledge store: a fact
 *   first observed past its TTL).
 * - `changed`: a later observation replaced the subject (knowledge store: a fact version superseded).
 * - `retracted`: the subject was withdrawn (knowledge store: a fact retracted).
 * - `user-rejected`: the user excluded an output or rejected a proposal.
 * - `reviewer-false-positive`: the reviewer dropped an issue after the worker pushed back on it.
 * - `worker-miss`: the worker pushed back, the reviewer upheld the issue, and the worker then fixed it.
 * - `run-failed`: the task failed (worker runs failed, or it could not run).
 * - `duplicate-saved` (knowledge store KS-6): the agent answered a duplicate handshake with `new` and
 *   the user later merged the result with a fact the handshake had shown (entity merge, or a
 *   retraction as a duplicate of that fact).
 */
export const OUTCOME_LABELS = [
  'confirmed',
  'weak-review',
  'over-scoped',
  'missed-evidence',
  'stale',
  'changed',
  'retracted',
  'user-rejected',
  'reviewer-false-positive',
  'worker-miss',
  'run-failed',
  'duplicate-saved', // knowledge store KS-6
] as const;
export type OutcomeLabel = (typeof OUTCOME_LABELS)[number];

/**
 * What wrote the outcome. `user_*` sources are human actions (actor = the configured user id).
 * `fact_lineage`: knowledge-store lineage events (fact observations, TTL), keyed by `sourceKey`.
 */
export const OUTCOME_SOURCES = [
  'review_loop', 'supersede', 'what_changed', 'dispute', 'user_override', 'user_reject', 'fact_lineage',
  'reviewer_audit', // learning loop WP-F: an auditor on another model failed a review that passed
] as const;
export type OutcomeSource = (typeof OUTCOME_SOURCES)[number];

/** Kinds of output an outcome can concern (besides the task itself). */
export type OutcomeTargetType = 'task' | 'finding' | 'recommendation' | 'persona' | 'competitor' | 'hypothesis' | 'unit_proposal' | 'review_issue';

/**
 * An after-the-fact judgment (`decision_outcomes`, append-only) of an agent decision and/or a
 * non-decision subject. `decisionId` is the agent decision being judged (the task's deliverable, an
 * output's save decision, a review, a pushback, a unit proposal; for a subject, the decision that
 * saved it when one exists). `subjectType` / `subjectId` name a non-decision subject (e.g. a fact
 * version); at least one of `decisionId` / `subjectId` is set. `runId`, `role`, `taskType` and
 * `promptVersion` are copied from the decision (and its run's task) at write time so reports group
 * without joins; a subject without a decision takes them from the caller when known.
 * `sourceKey`: the source event (feedback event, fact observation, ...); rows are unique per
 * (subject, outcome, sourceKey).
 */
export interface DecisionOutcome {
  id: string;
  workspaceId: string;
  decisionId?: string;
  subjectType?: string;
  subjectId?: string;
  /** Agent run that made the judged decision, when known. */
  runId?: string;
  /** What happened, e.g. `verified`, `unverified`, `failed`, `superseded`, `contradicted`, `changed`, `excluded`, `included`, `rejected`, `withdrawn_after_pushback`, `fixed_after_upheld`, `excluded_after_pass`, `stale`, `confirmed`, `retracted`. */
  outcome: string;
  label: OutcomeLabel;
  /** Supporting facts (ids, round, score, issue text, ...). */
  evidenceJson: Record<string, unknown>;
  source: OutcomeSource;
  sourceKey?: string;
  /** Who acted: the configured user id for `user_*` sources, else `system`. */
  actor: string;
  taskId?: string;
  targetType?: OutcomeTargetType;
  targetId?: string;
  role?: Role;
  taskType?: TaskType;
  promptVersion?: string;
  createdAt: string;
}

export const REVIEW_ISSUE_STATUSES = ['open', 'fixed', 'pushed_back', 'upheld', 'withdrawn'] as const;
/**
 * `open`: raised, not answered (yet). `fixed`: the worker fixed it. `pushed_back`: the worker pushed
 * back, the next review has not ruled. `upheld`: the next review reasserted it. `withdrawn`: the next
 * review dropped it after the pushback.
 */
export type ReviewIssueStatus = (typeof REVIEW_ISSUE_STATUSES)[number];

/**
 * One issue of one review round (`review_issues`; one row per task + round + issue, never deleted;
 * the status moves as the worker and the next review answer it). `issueId` is stable across rounds:
 * an issue the reviewer repeats keeps its id.
 */
export interface ReviewIssueRecord {
  id: string;
  workspaceId: string;
  taskId: string;
  round: number;
  /** Stable issue id (`I1`, `I2`, ...). */
  issueId: string;
  /** The id the reviewer used in this round's `submit_review`. */
  rawIssueId?: string;
  class: 'blocking' | 'substantive' | 'nit' | 'scope_expansion';
  text: string;
  evidence: string[];
  status: ReviewIssueStatus;
  /** Harness-made issue of a malformed / failed review (not a reviewer judgment). */
  synthetic: boolean;
  reviewerRunId: string;
  reviewDecisionId?: string;
  /** Worker / synthesizer run whose deliverable this review judged, and its prompt version. */
  workerRunId?: string;
  workerPromptVersion?: string;
  /** Reason the worker gave in `respond_to_review` (fix or pushback). */
  responseReason?: string;
  responseDecisionId?: string;
  createdAt: string;
  resolvedAt?: string;
}

/** One row of the outcomes report: counts of each label for a role / task type / prompt version. */
export interface OutcomeReportRow {
  /** Absent for outcomes of a subject without a known decision or role. */
  role?: Role;
  taskType?: TaskType;
  promptVersion?: string;
  counts: Partial<Record<OutcomeLabel, number>>;
  total: number;
}

export interface OutcomeReport {
  labels: OutcomeLabel[];
  rows: OutcomeReportRow[];
}

/** Recurrence of one review-issue class for one executing role + task type (lessons input). */
export interface IssueRecurrence {
  role: Role;
  taskType: TaskType;
  /** Prompt version of the worker run whose deliverable drew the issue. */
  promptVersion?: string;
  class: ReviewIssueRecord['class'];
  /** Distinct tasks with at least one non-synthetic issue of this class. */
  taskIds: string[];
  /** Issue rows (all rounds). */
  issues: number;
}
