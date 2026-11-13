/**
 * Learning loop WP-F (migration 20): reviewer audits and A/B experiments.
 * Types only (no runtime imports beyond config / core types), so the web app can import them.
 */
import type { ModelRef, Role, TaskType } from '../config/schema.js';
import type { UsageTotals } from '../metrics/usage.js';

/** How an audit came about. */
export type AuditTrigger = 'api' | 'schedule';

/**
 * Result of one audit:
 * - `agree`: the auditor passed the task as well (score >= the task type's pass threshold);
 * - `miss`: the auditor failed work the original reviewer passed (a `weak-review` outcome on the
 *   original review decision and a lesson signal, `auditMisses`);
 * - `invalid`: the auditor produced no valid review (its own failure, not evidence against the original);
 * - `skipped`: no different model was configured to audit with.
 */
export type AuditVerdict = 'agree' | 'miss' | 'invalid' | 'skipped';

export type AuditIssue = { id?: string; class: string; description: string };

/** One re-review of a verified task by a different model (`reviewer_audits`). */
export interface ReviewerAudit {
  id: string;
  /** Audits started together (one API call or one scheduled occurrence). */
  batchId: string;
  workspaceId: string;
  /** Business-tree root of the task: audits and their lesson signals stay per tree. */
  rootWorkspaceId: string;
  taskId: string;
  taskType: TaskType;
  startedBy: AuditTrigger;
  /** The configured user (`config.user.id`) for API audits; `scheduler` for scheduled ones. */
  actor: string;
  scheduleId?: string;
  status: 'running' | 'done' | 'failed';
  verdict?: AuditVerdict;
  /** Why the audit was skipped / failed / invalid. */
  reason?: string;
  passThreshold: number;
  /** The passing review being audited, its run, model, prompt version and score. */
  originalDecisionId: string;
  originalRunId?: string;
  originalModel: ModelRef;
  originalPromptVersion?: string;
  originalScore: number;
  auditModel?: ModelRef;
  auditRunId?: string;
  auditDecisionId?: string;
  auditPromptVersion?: string;
  auditScore?: number;
  auditIssues: AuditIssue[];
  /** The `weak-review` decision outcome written for a miss. */
  outcomeId?: string;
  createdAt: string;
  endedAt?: string;
}

/** Counts over a list of audits. `missRate` = miss / (agree + miss); null without valid audits. */
export type AuditSummary = { total: number; agree: number; miss: number; invalid: number; skipped: number; running: number; missRate: number | null };

/**
 * A lesson signal for WP-E (`auditMisses`): a passing review that an auditor on another model failed.
 * `role` / `promptVersion` are the ORIGINAL reviewer's (whose prompt a lesson would change).
 */
export type AuditMiss = {
  auditId: string;
  workspaceId: string;
  rootWorkspaceId: string;
  taskId: string;
  taskType: TaskType;
  role: Extract<Role, 'reviewer'>;
  promptVersion?: string;
  originalDecisionId: string;
  originalModel: ModelRef;
  originalScore: number;
  auditModel: ModelRef;
  auditScore: number;
  /** The auditor's issues; `classes` = their distinct classes (blocking, substantive, ...). */
  issues: AuditIssue[];
  classes: string[];
  outcomeId?: string;
  createdAt: string;
};

/** A cron schedule of reviewer audits for one business tree (`audit_schedules`). */
export interface AuditSchedule {
  id: string;
  workspaceId: string;
  rootWorkspaceId: string;
  cron: string;
  n: number;
  enabled: boolean;
  lastRunAt?: string;
  activatedAt?: string;
  actor: string;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// experiments

export const EXPERIMENT_ARMS = ['A', 'B'] as const;
export type ExperimentArmName = (typeof EXPERIMENT_ARMS)[number];

/** What an arm changes for the worker: its model and / or its system prompt (a stored prompt version). */
export type ExperimentArmSpec = {
  arm: ExperimentArmName;
  model: ModelRef;
  /** Worker system prompt version (`prompt_versions` hash); absent = the current prompt. */
  promptVersion?: string;
  /** The arm's tasks (one per repeat), clones of the source task tagged with the experiment and arm. */
  taskIds: string[];
};

export interface Experiment {
  id: string;
  workspaceId: string;
  rootWorkspaceId: string;
  sourceTaskId: string;
  /** Research run holding the arm tasks (created `done`, so no drain loop or resume ever runs them). */
  researchRunId: string;
  name?: string;
  arms: ExperimentArmSpec[];
  repeats: number;
  /** `interrupted`: the server stopped while it ran (its unfinished arm tasks end `failed`). */
  status: 'running' | 'done' | 'failed' | 'interrupted';
  failureReason?: string;
  actor: string;
  createdAt: string;
  endedAt?: string;
}

/** Comparison of one arm (`compareExperiment`). Rates are over the arm's finished tasks. */
export type ArmResult = {
  arm: ExperimentArmName;
  model: ModelRef;
  promptVersion?: string;
  /** Prompt versions the arm's worker runs actually used. */
  workerPromptVersions: string[];
  /** Models of the arm's reviewer runs (the loop picks the reviewer per worker provider). */
  reviewerModels: ModelRef[];
  tasks: Array<{ taskId: string; status: string; round: number; finalScore: number | null; failureReason?: string }>;
  finished: number;
  verified: number;
  /** verified / finished; null before any task finished. */
  passRate: number | null;
  firstRoundPassRate: number | null;
  /** Mean review rounds of verified + unverified tasks. */
  meanRounds: number | null;
  /** Every valid review score of the arm, and their mean. */
  reviewScores: number[];
  meanReviewScore: number | null;
  /** User ratings of the arm's decisions and outputs. */
  userRatings: { count: number; agree: number; agreeRate: number | null };
  /** Σ `agent_usage` of the arm's tasks, and per finished task. */
  cost: UsageTotals;
  costPerTask: number | null;
};

export type ExperimentComparison = { experiment: Experiment; arms: ArmResult[] };
