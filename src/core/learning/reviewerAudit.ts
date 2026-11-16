/**
 * Learning loop WP-F (migration 20): reviewer audits.
 *
 * An audit re-reviews recently verified tasks of ONE business tree with a different configured model
 * (another provider when one is enabled). The auditor is a `reviewer` run of the audited task with the
 * reviewer input of the task's final round (`reviewerRunInput`: same system prompt, minimal prompt and
 * prompt reads, logged before the run starts; the dispatcher limits its reads to the task's review
 * slice), except that it runs without lesson rules and is stored with `lessons_off` (ruling R5). The run and its decisions are tagged `audit_id`, so they are never the task's review
 * and stay out of normal metrics. An audit never changes the task.
 *
 * Verdicts: `agree` (auditor passes it too), `miss` (auditor fails work the original reviewer passed),
 * `invalid` (no valid review from the auditor: its own failure, not a miss), `skipped` (no different
 * model configured). A miss writes a `weak-review` decision outcome on the original review decision
 * (`recordOutcome`, source `reviewer_audit`) and is a lesson signal (`auditMisses`, consumed by WP-E).
 *
 * Public API:
 * - `startReviewerAudit(deps, input)` / `runReviewerAudit(deps, input)` — on demand (API) or scheduled.
 * - `auditMisses(store, { rootWorkspaceId, ... })` — WP-E lesson signals, per tree.
 * - `listAudits`, `auditSummary`, `auditModelFor`, `auditCandidates`.
 * - Schedules: `createAuditSchedule`, `updateAuditSchedule`, `listAuditSchedules`, `auditJobSource`.
 */
import { CronExpressionParser } from 'cron-parser';
import { PROVIDER_IDS, type BifConfig, type ModelRef } from '../config/schema.js';
import { treeWorkspaceIds } from '../evidence/synthesis.js';
import { getRunOutputs, validScore } from '../harness/tools/handlers.js';
import { runAgent, type ResearchDeps } from '../research/deps.js';
import { loopSettings, reviewerRunInput } from '../research/reviewLoop.js';
import type { Store } from '../store/db.js';
import { newId, Repo, type TableSpec } from '../store/repos.js';
import type { Decision, Task } from '../types.js';
import { rootOf } from '../workspace/tree.js';
import { recordOutcome, taskLastReviewDecision } from './outcomes.js';
import { isExperimentTask } from './runTags.js';
import type { AuditIssue, AuditMiss, AuditSchedule, AuditSummary, AuditTrigger, ReviewerAudit } from './wpfTypes.js';

export type { AuditMiss, AuditSchedule, AuditSummary, ReviewerAudit } from './wpfTypes.js';

/** Default number of tasks per audit (`config.audit.n` overrides). */
export const DEFAULT_AUDIT_N = 5;
/** Actor of scheduled audits. */
export const SCHEDULER_ACTOR = 'scheduler';

export class AuditError extends Error {
  constructor(
    readonly code: 'not_found' | 'invalid',
    message: string,
  ) {
    super(message);
    this.name = 'AuditError';
  }
}

// ---------------------------------------------------------------------------
// repositories (kept out of store/repos.ts, a shared hot file)

const auditSpec = {
  table: 'reviewer_audits',
  key: 'id',
  fields: {
    id: 'text', batchId: 'text', workspaceId: 'text', rootWorkspaceId: 'text', taskId: 'text', taskType: 'text', startedBy: 'text',
    actor: 'text', scheduleId: 'text', status: 'text', verdict: 'text', reason: 'text', passThreshold: 'real',
    originalDecisionId: 'text', originalRunId: 'text', originalModel: 'json', originalPromptVersion: 'text', originalScore: 'real',
    auditModel: 'json', auditRunId: 'text', auditDecisionId: 'text', auditPromptVersion: 'text', auditScore: 'real',
    auditIssues: 'json', outcomeId: 'text', createdAt: 'text', endedAt: 'text',
  },
} satisfies TableSpec<ReviewerAudit>;

const scheduleSpec = {
  table: 'audit_schedules',
  key: 'id',
  fields: {
    id: 'text', workspaceId: 'text', rootWorkspaceId: 'text', cron: 'text', n: 'int', enabled: 'bool', lastRunAt: 'text',
    activatedAt: 'text', actor: 'text', createdAt: 'text',
  },
} satisfies TableSpec<AuditSchedule>;

type Repos = { audits: Repo<ReviewerAudit, 'id'>; schedules: Repo<AuditSchedule, 'id'> };
const cache = new WeakMap<object, Repos>();

function repos(store: Pick<Store, 'db'>): Repos {
  let r = cache.get(store.db);
  if (!r) {
    r = { audits: new Repo<ReviewerAudit, 'id'>(store.db, auditSpec), schedules: new Repo<AuditSchedule, 'id'>(store.db, scheduleSpec) };
    cache.set(store.db, r);
  }
  return r;
}

// ---------------------------------------------------------------------------
// auditor model

const sameModel = (a: ModelRef, b: ModelRef) => a.provider === b.provider && a.model === b.model;

/**
 * The auditor for a review made by `original` of work by `worker`: `config.audit.model` when it differs
 * from `original`; else the first model of an enabled provider other than the original reviewer's
 * (preferring one that is not the worker's either); else another model of the original's provider;
 * else none (the audit is skipped).
 */
export function auditModelFor(original: ModelRef, worker: ModelRef, config: Pick<BifConfig, 'providers' | 'audit'>): ModelRef | undefined {
  const configured = config.audit?.model;
  if (configured && !sameModel(configured, original) && config.providers[configured.provider].enabled) return configured;
  const firstOf = (id: (typeof PROVIDER_IDS)[number]) => {
    const p = config.providers[id];
    const model = p.models[0];
    return p.enabled && model !== undefined ? { provider: id, model } : undefined;
  };
  const others = PROVIDER_IDS.filter((id) => id !== original.provider);
  for (const id of [...others.filter((id) => id !== worker.provider), ...others.filter((id) => id === worker.provider)]) {
    const m = firstOf(id);
    if (m) return m;
  }
  const own = config.providers[original.provider];
  const model = own.enabled ? own.models.find((m) => m !== original.model) : undefined;
  return model !== undefined ? { provider: original.provider, model } : undefined;
}

// ---------------------------------------------------------------------------
// candidates

type Passing = { task: Task; decision: Decision; score: number; threshold: number };

/** The task's final review when it is a valid `submit_review` that passed (the review an audit checks). */
function passingReview(deps: Pick<ResearchDeps, 'store' | 'config'>, task: Task): Passing | undefined {
  if (task.status !== 'verified' || isExperimentTask(deps.store, task.id)) return undefined;
  const decision = taskLastReviewDecision(deps.store, task);
  if (!decision) return undefined;
  const p = (decision.payload ?? {}) as { tool?: unknown; score?: unknown };
  if (p.tool !== 'submit_review' || typeof p.score !== 'number') return undefined;
  if (deps.store.agentRuns.get(decision.agentRunId)?.status !== 'done') return undefined;
  const threshold = loopSettings(task.type, deps.config).passThreshold;
  return p.score >= threshold ? { task, decision, score: p.score, threshold } : undefined;
}

/** Whether this review was already audited (a finished or running audit; skipped ones may be retried). */
function alreadyAudited(store: Store, decisionId: string): boolean {
  return repos(store).audits.list({ originalDecisionId: decisionId }).some((a) => a.status === 'running' || (a.verdict !== undefined && a.verdict !== 'skipped'));
}

/**
 * Up to `n` verified tasks of the business tree of `workspaceId` whose passing review was not audited
 * yet, most recently reviewed first. Never another tree; never experiment arm tasks.
 */
export function auditCandidates(deps: Pick<ResearchDeps, 'store' | 'config'>, workspaceId: string, n: number): Passing[] {
  const { store } = deps;
  return treeWorkspaceIds(store, workspaceId)
    .flatMap((id) => store.tasks.list({ workspaceId: id, status: 'verified' }))
    .map((t) => passingReview(deps, t))
    .filter((x): x is Passing => x !== undefined && !alreadyAudited(store, x.decision.id))
    .sort((a, b) => b.decision.createdAt.localeCompare(a.decision.createdAt))
    .slice(0, Math.max(0, n));
}

// ---------------------------------------------------------------------------
// running

export type AuditInput = {
  workspaceId: string;
  /** Tasks to audit (default `config.audit.n`, else 5). Ignored with `taskIds`. */
  n?: number;
  /** Explicit verified tasks of the tree (re-audited even if audited before). */
  taskIds?: string[];
  startedBy?: AuditTrigger;
  /** The configured user (API) or `scheduler`. */
  actor?: string;
  scheduleId?: string;
};

/**
 * Starts an audit batch: picks the tasks, writes one `reviewer_audits` row each (status `running`, or
 * `skipped` when no different model is configured) and runs the auditors in the background (`done`).
 * Throws `AuditError` for an unknown workspace or a task id that is not a verified task of the tree.
 */
export function startReviewerAudit(deps: ResearchDeps, input: AuditInput): { batchId: string; audits: ReviewerAudit[]; done: Promise<ReviewerAudit[]> } {
  const { store, config } = deps;
  if (!store.workspaces.get(input.workspaceId)) throw new AuditError('not_found', `workspace '${input.workspaceId}' not found`);
  const root = rootOf(store, input.workspaceId);
  let picked: Passing[];
  if (input.taskIds?.length) {
    const tree = new Set(treeWorkspaceIds(store, input.workspaceId));
    picked = input.taskIds.map((id) => {
      const task = store.tasks.get(id);
      const passing = task && tree.has(task.workspaceId) ? passingReview(deps, task) : undefined;
      if (!passing) throw new AuditError('invalid', `task '${id}' is not a verified task of this business tree`);
      return passing;
    });
  } else {
    picked = auditCandidates(deps, input.workspaceId, input.n ?? config.audit?.n ?? DEFAULT_AUDIT_N);
  }
  const batchId = newId('abat');
  const now = new Date().toISOString();
  const rows = picked.map((p): { row: ReviewerAudit; task: Task } => {
    const run = store.agentRuns.get(p.decision.agentRunId);
    const auditor = auditModelFor(p.decision.model, p.task.model, config);
    const row: ReviewerAudit = {
      id: newId('aud'), batchId, workspaceId: p.task.workspaceId, rootWorkspaceId: root, taskId: p.task.id, taskType: p.task.type,
      startedBy: input.startedBy ?? 'api', actor: input.actor ?? 'local-user', status: auditor ? 'running' : 'done',
      passThreshold: p.threshold, originalDecisionId: p.decision.id, originalModel: p.decision.model, originalScore: p.score,
      auditIssues: [], createdAt: now,
    };
    if (input.scheduleId) row.scheduleId = input.scheduleId;
    if (run) row.originalRunId = run.id;
    if (p.decision.promptVersion) row.originalPromptVersion = p.decision.promptVersion;
    if (auditor) row.auditModel = auditor;
    else {
      row.verdict = 'skipped';
      row.reason = `no different model is configured to audit a review by ${p.decision.model.provider}/${p.decision.model.model}`;
      row.endedAt = now;
    }
    return { row: repos(store).audits.insert(row), task: p.task };
  });
  const done = Promise.all(rows.filter((r) => r.row.status === 'running').map((r) => auditOne(deps, r.row, r.task))).then(() =>
    rows.map((r) => repos(store).audits.get(r.row.id)!),
  );
  return { batchId, audits: rows.map((r) => r.row), done };
}

/** `startReviewerAudit` and wait for every auditor; resolves with the batch's final rows. */
export async function runReviewerAudit(deps: ResearchDeps, input: AuditInput): Promise<ReviewerAudit[]> {
  return startReviewerAudit(deps, input).done;
}

async function auditOne(deps: ResearchDeps, audit: ReviewerAudit, task: Task): Promise<void> {
  const { store } = deps;
  const repo = repos(store).audits;
  const end = (patch: Partial<ReviewerAudit>) => repo.update(audit.id, { ...patch, endedAt: new Date().toISOString() });
  try {
    // What the reviewer of the final round was started with (minimal context, reads logged first), but
    // without lesson rules: ruling R5 — the auditor stays independent of what the reviewer learned.
    const input = reviewerRunInput(deps, task, task.round, { lessonsOff: true });
    const res = await runAgent(deps, {
      kind: 'audit', role: 'reviewer', workspaceId: task.workspaceId, task, round: task.round, attempt: 1,
      prompt: input.prompt, systemPrompt: input.systemPrompt, model: audit.auditModel!, needsBrowser: false,
      promptVersion: input.promptVersion, runTags: { auditId: audit.id, lessonsOff: true }, // R5: stored lessons_off
      ...(input.promptReads.length ? { promptReads: input.promptReads } : {}),
    });
    const review = getRunOutputs(store, res.agentRunId).review;
    const decision = store.decisions
      .list({ agentRunId: res.agentRunId })
      .filter((d) => d.kind === 'review' && (d.payload as { tool?: unknown } | null)?.tool === 'submit_review')
      .at(-1);
    const base: Partial<ReviewerAudit> = { status: 'done', auditRunId: res.agentRunId, auditPromptVersion: input.promptVersion };
    if (decision) base.auditDecisionId = decision.id;
    const score = res.status === 'done' && review !== undefined && validScore(review.score) ? review.score : undefined;
    if (review === undefined || score === undefined) {
      end({ ...base, verdict: 'invalid', reason: res.status === 'done' ? 'the auditor produced no valid review' : `auditor run failed${res.reason ? `: ${res.reason}` : ''}` });
      return;
    }
    const issues: AuditIssue[] = review.issues.map((i) => ({ id: i.id, class: i.class, description: i.description }));
    if (score >= audit.passThreshold) {
      end({ ...base, verdict: 'agree', auditScore: score, auditIssues: issues });
      return;
    }
    const outcome = recordOutcome(store, {
      decisionId: audit.originalDecisionId, outcome: 'audit_failed', label: 'weak-review', source: 'reviewer_audit',
      sourceKey: `audit:${audit.id}`, taskId: task.id, targetType: 'task', targetId: task.id,
      evidence: {
        auditId: audit.id, auditRunId: res.agentRunId, auditModel: audit.auditModel, auditScore: score,
        originalScore: audit.originalScore, passThreshold: audit.passThreshold, issues: issues.map((i) => ({ class: i.class, description: i.description })),
      },
    });
    end({ ...base, verdict: 'miss', auditScore: score, auditIssues: issues, ...(outcome ? { outcomeId: outcome.id } : {}) });
  } catch (err) {
    end({ status: 'failed', reason: (err as Error).message });
  }
}

// ---------------------------------------------------------------------------
// queries

export type AuditFilter = { rootWorkspaceId?: string; taskId?: string; batchId?: string };

/** Audits, oldest first. Pass `rootWorkspaceId` to stay inside one business tree. */
export function listAudits(store: Store, filter: AuditFilter = {}): ReviewerAudit[] {
  return repos(store).audits.list({
    ...(filter.rootWorkspaceId ? { rootWorkspaceId: filter.rootWorkspaceId } : {}),
    ...(filter.taskId ? { taskId: filter.taskId } : {}),
    ...(filter.batchId ? { batchId: filter.batchId } : {}),
  });
}

export function auditSummary(audits: ReviewerAudit[]): AuditSummary {
  const count = (v: string) => audits.filter((a) => a.verdict === v).length;
  const agree = count('agree');
  const miss = count('miss');
  return {
    total: audits.length, agree, miss, invalid: count('invalid'), skipped: count('skipped'),
    running: audits.filter((a) => a.status === 'running').length,
    missRate: agree + miss ? Math.round((miss / (agree + miss)) * 1000) / 1000 : null,
  };
}

/** Filter of `auditMisses`. `rootWorkspaceId` is required: lesson signals never cross trees. */
export type AuditMissFilter = { rootWorkspaceId: string; since?: string; promptVersion?: string; taskType?: Task['type'] };

/**
 * WP-E lesson signals: audits of one business tree whose auditor failed a passing review, oldest first.
 * `role` / `promptVersion` are the original reviewer's; `classes` the auditor's issue classes.
 */
export function auditMisses(store: Store, filter: AuditMissFilter): AuditMiss[] {
  return repos(store)
    .audits.list({ rootWorkspaceId: filter.rootWorkspaceId, verdict: 'miss' })
    .filter((a) => (filter.since ? a.createdAt >= filter.since : true))
    .filter((a) => (filter.promptVersion ? a.originalPromptVersion === filter.promptVersion : true))
    .filter((a) => (filter.taskType ? a.taskType === filter.taskType : true))
    .map((a): AuditMiss => ({
      auditId: a.id, workspaceId: a.workspaceId, rootWorkspaceId: a.rootWorkspaceId, taskId: a.taskId, taskType: a.taskType, role: 'reviewer',
      ...(a.originalPromptVersion ? { promptVersion: a.originalPromptVersion } : {}),
      originalDecisionId: a.originalDecisionId, originalModel: a.originalModel, originalScore: a.originalScore,
      auditModel: a.auditModel!, auditScore: a.auditScore!, issues: a.auditIssues,
      classes: [...new Set(a.auditIssues.map((i) => i.class))],
      ...(a.outcomeId ? { outcomeId: a.outcomeId } : {}),
      createdAt: a.createdAt,
    }));
}

// ---------------------------------------------------------------------------
// schedules (run by the existing scheduler through `auditJobSource`)

function checkCron(cron: string): void {
  try {
    CronExpressionParser.parse(cron, { currentDate: new Date() }).next();
  } catch (e) {
    throw new AuditError('invalid', `invalid cron expression '${cron}': ${(e as Error).message}`);
  }
}

/** A cron schedule of audits for the business tree of `workspaceId` (enabled; first run at the next occurrence). */
export function createAuditSchedule(store: Store, input: { workspaceId: string; cron: string; n: number; actor?: string }): AuditSchedule {
  if (!store.workspaces.get(input.workspaceId)) throw new AuditError('not_found', `workspace '${input.workspaceId}' not found`);
  checkCron(input.cron);
  if (!Number.isInteger(input.n) || input.n < 1) throw new AuditError('invalid', 'n must be a positive integer');
  const now = new Date().toISOString();
  return repos(store).schedules.insert({
    id: newId('asch'), workspaceId: input.workspaceId, rootWorkspaceId: rootOf(store, input.workspaceId), cron: input.cron, n: input.n,
    enabled: true, activatedAt: now, actor: input.actor ?? 'local-user', createdAt: now,
  });
}

/** Enables / disables or changes a schedule; re-enabling resets its baseline (no catch-up run). */
export function updateAuditSchedule(store: Store, id: string, patch: { enabled?: boolean; cron?: string; n?: number }): AuditSchedule {
  const repo = repos(store).schedules;
  const current = repo.get(id);
  if (!current) throw new AuditError('not_found', `audit schedule '${id}' not found`);
  if (patch.cron !== undefined) checkCron(patch.cron);
  if (patch.n !== undefined && (!Number.isInteger(patch.n) || patch.n < 1)) throw new AuditError('invalid', 'n must be a positive integer');
  const next: Partial<AuditSchedule> = {};
  if (patch.cron !== undefined) next.cron = patch.cron;
  if (patch.n !== undefined) next.n = patch.n;
  if (patch.enabled !== undefined) {
    next.enabled = patch.enabled;
    if (patch.enabled && !current.enabled) next.activatedAt = new Date().toISOString();
  }
  return repo.update(id, next);
}

export function getAuditSchedule(store: Store, id: string): AuditSchedule | undefined {
  return repos(store).schedules.get(id);
}

export function listAuditSchedules(store: Store, rootWorkspaceId?: string): AuditSchedule[] {
  return repos(store).schedules.list(rootWorkspaceId ? { rootWorkspaceId } : {});
}

/** The scheduler's job source for audit schedules (`startScheduler` always includes it). */
export function auditJobSource(deps: ResearchDeps): {
  name: string;
  list(): Array<{ id: string; cron: string; lastRunAt?: string; activatedAt?: string }>;
  started(id: string, at: string): void;
  run(id: string): Promise<void>;
} {
  const repo = () => repos(deps.store).schedules;
  return {
    name: 'reviewer-audit',
    list: () => repo().list({ enabled: true }),
    started: (id, at) => void repo().update(id, { lastRunAt: at }),
    run: async (id) => {
      const s = repo().get(id);
      if (!s || !s.enabled || !deps.store.workspaces.get(s.workspaceId)) return;
      await runReviewerAudit(deps, { workspaceId: s.workspaceId, n: s.n, startedBy: 'schedule', actor: SCHEDULER_ACTOR, scheduleId: s.id });
    },
  };
}
