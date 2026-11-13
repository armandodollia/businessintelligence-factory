/**
 * Lesson signals (learning loop WP-E): every machine and human signal of one business tree,
 * normalized to (role, category, unit). A unit is the task the signal occurred in (else the agent
 * run, else the source row); "a category recurs in ≥ 3 tasks" counts distinct units.
 *
 * Sources (the existing query APIs; nothing is re-derived):
 * - review issues (`issueRecurrence` + `listReviewIssues`): `review:<class>:<taskType>` for the
 *   executing role (worker / synthesizer);
 * - decision outcomes (`listOutcomes`), negative labels only: `outcome:<label>` for the judged role
 *   (`duplicate-saved` comes from the knowledge signals instead);
 * - worker failures (`agent_runs.failure_reason`, `agent_run_attempts`): `failure:<class>`, leaving
 *   out infrastructure classes no prompt can fix (rate limits, interruptions, spawn errors, budgets);
 * - policy denials (`listPolicyEvents`, out-of-tree blocks left out — see KS-6): `policy:<kind>:<action>`;
 * - human feedback (`listFeedback`) on an agent run's output: `feedback:exclude:<type>`,
 *   `feedback:proposal_reject`, `feedback:proposal_edit`, `feedback:hypothesis_correction`,
 *   `feedback:fact_retract`; rating disagreements: `rating:<targetType>:<criterion>`;
 * - knowledge signals (`knowledgeSignals`): `knowledge:<kind>` (rate kinds only at a rate ≥ 0.5);
 * - signals recorded by other packages (`recordLessonSignal`, e.g. WP-F reviewer-audit misses).
 *
 * Nothing crosses trees: every query is bounded to the tree's workspaces.
 */
import { ROLES, type BifConfig } from '../../config/schema.js';
import { listFeedback } from '../../feedback/events.js';
import { TOOL_NAMES } from '../../harness/tools/registry.js';
import { knowledgeSignals } from '../../knowledge/metrics.js';
import { DENIAL_KINDS, KNOWLEDGE_BLOCK_SITE, listPolicyEvents } from '../../policy/policyEvents.js';
import type { Store } from '../../store/db.js';
import { newId } from '../../store/repos.js';
import { usageRepos } from '../../store/usageRepos.js';
import type { AgentRun, Role } from '../../types.js';
import { descendants, rootOf } from '../../workspace/tree.js';
import { listOutcomes } from '../outcomes.js';
import { issueRecurrence, listReviewIssues } from '../reviewIssues.js';
import type { OutcomeLabel } from '../types.js';
import { lessonRepos } from './store.js';
import type { LessonSignalRecord } from './types.js';

export type LessonSignalSource = 'review_issue' | 'outcome' | 'failure' | 'policy' | 'feedback' | 'rating' | 'knowledge' | 'recorded';

export type LessonSignal = {
  role: Role;
  category: string;
  /** Unit of recurrence: the task id, else the agent run id, else the source row id. */
  unit: string;
  taskId?: string;
  agentRunId?: string;
  promptVersion?: string;
  source: LessonSignalSource;
  /** The source row (review issue, outcome, run, policy event, feedback event, rating, retrieval event, signal). */
  refId: string;
  createdAt?: string;
  /** Candidate quote (review-issue text, a recorded signal's note); quoted only when `LessonPrivacy` allows. */
  text?: string;
  /** Ids the quote rests on (review-issue evidence, the runs that wrote it). */
  textRefs?: string[];
};

/** Outcome labels that are lessons (something went wrong for the judged role). */
export const LESSON_OUTCOME_LABELS: ReadonlySet<OutcomeLabel> = new Set([
  'weak-review', 'over-scoped', 'missed-evidence', 'user-rejected', 'reviewer-false-positive', 'worker-miss', 'run-failed',
]);

/** Failure classes no prompt can fix (left out of lessons). */
const INFRA_FAILURES: ReadonlySet<string> = new Set(['rate_limited', 'interrupted', 'spawn', 'budget']);
/** Knowledge signal kinds that are rates: a signal only at or above this rate. */
const RATE_KINDS: ReadonlySet<string> = new Set(['zero_result', 'unused_tokens']);
export const KNOWLEDGE_RATE_FLOOR = 0.5;

const isRole = (r: unknown): r is Role => typeof r === 'string' && (ROLES as readonly string[]).includes(r);
/** Category parts that come from data (policy actions, criteria): identifier characters only. */
export const safePart = (s: string | undefined): string => (s ?? 'unknown').replace(/[^A-Za-z0-9_.-]+/g, '_').slice(0, 60) || 'unknown';

/**
 * The policy action of a denial as a category part: a tool name (blocked tool calls, knowledge
 * blocks) or the configured action-policy item the action matches; anything else is `other`. The
 * action of an approval request is agent-written text and never reaches a category (or a rule).
 */
export function policyActionKey(action: string | undefined, config?: Pick<BifConfig, 'actionPolicy'>): string {
  if (!action) return 'other';
  if ((TOOL_NAMES as readonly string[]).includes(action)) return action;
  const a = action.toLowerCase();
  const p = config?.actionPolicy;
  const item = p ? [...p.never, ...p.approvalRequired, ...p.allowed].find((n) => n.trim() && a.includes(n.trim().toLowerCase())) : undefined;
  return item ? safePart(item.trim().toLowerCase()) : 'other';
}

/** Class of a run failure reason (supervisor / review-loop wording). */
export function failureClass(reason: string): string {
  if (/rate.?limit/i.test(reason)) return 'rate_limited';
  if (/idle timeout|timed? ?out|no (activity|output) for/i.test(reason)) return 'timeout';
  if (/budget|spend cap/i.test(reason)) return 'budget';
  if (/spawn failed|ENOENT/i.test(reason)) return 'spawn';
  if (/abort|interrupt|cancel/i.test(reason)) return 'interrupted';
  return 'error';
}

/** Every workspace of the tree of `rootWorkspaceId` (root first). */
export function treeIds(store: Store, rootWorkspaceId: string): string[] {
  return [rootWorkspaceId, ...descendants(store, rootWorkspaceId).map((w) => w.id)];
}

export type SignalWindow = { since?: string; until?: string };

const inWindow = (at: string | undefined, w: SignalWindow) => !at || ((!w.since || at >= w.since) && (!w.until || at < w.until));

/** All lesson signals of one business tree (see module doc), optionally within a time window. */
export function collectLessonSignals(
  store: Store,
  rootWorkspaceId: string,
  window: SignalWindow = {},
  config?: Pick<BifConfig, 'knowledge' | 'actionPolicy'>,
): LessonSignal[] {
  const ids = treeIds(store, rootWorkspaceId);
  const idSet = new Set(ids);
  const out: LessonSignal[] = [];
  const runs = new Map<string, AgentRun | undefined>();
  const runOf = (id: string | undefined): AgentRun | undefined => {
    if (!id) return undefined;
    if (!runs.has(id)) {
      const r = store.agentRuns.get(id);
      runs.set(id, r && idSet.has(r.workspaceId) ? r : undefined);
    }
    return runs.get(id);
  };
  const push = (s: Omit<LessonSignal, 'unit'> & { unit?: string }) => {
    if (!isRole(s.role)) return;
    out.push({ ...s, unit: s.unit ?? s.taskId ?? s.agentRunId ?? s.refId });
  };

  // Review issues: recurrence groups per role / task type / worker prompt version, rows for quotes.
  const rows = listReviewIssues(store, { workspaceIds: ids, ...(window.since ? { since: window.since } : {}) }).filter((r) => inWindow(r.createdAt, window));
  for (const g of issueRecurrence(store, ids, { byPromptVersion: true, ...(window.since ? { since: window.since } : {}) })) {
    for (const taskId of g.taskIds) {
      const mine = rows.filter((r) => r.taskId === taskId && r.class === g.class && (r.workerPromptVersion || undefined) === g.promptVersion);
      const first = mine[0];
      if (!first) continue; // outside `until`
      push({
        role: g.role, category: `review:${g.class}:${g.taskType}`, taskId, source: 'review_issue', refId: first.id, createdAt: first.createdAt,
        ...(first.workerRunId ? { agentRunId: first.workerRunId } : {}),
        ...(g.promptVersion ? { promptVersion: g.promptVersion } : {}),
        text: first.text,
        textRefs: [...first.evidence, first.reviewerRunId, ...(first.workerRunId ? [first.workerRunId] : [])],
      });
    }
  }

  // Decision outcomes (negative labels) of the judged role.
  for (const o of listOutcomes(store, { workspaceIds: ids, ...(window.since ? { since: window.since } : {}) })) {
    if (!LESSON_OUTCOME_LABELS.has(o.label) || !o.role || !inWindow(o.createdAt, window)) continue;
    push({
      role: o.role, category: `outcome:${o.label}`, source: 'outcome', refId: o.id, createdAt: o.createdAt,
      ...(o.taskId ? { taskId: o.taskId } : {}),
      ...(o.runId ? { agentRunId: o.runId } : {}),
      ...(o.promptVersion ? { promptVersion: o.promptVersion } : {}),
    });
  }

  // Worker failures: failed runs and failed (non rate-limited) attempts.
  const failed = (run: AgentRun, reason: string, refId: string, at: string) => {
    const cls = failureClass(reason);
    if (INFRA_FAILURES.has(cls) || !inWindow(at, window)) return;
    push({
      role: run.role, category: `failure:${cls}`, agentRunId: run.id, source: 'failure', refId, createdAt: at,
      ...(run.taskId ? { taskId: run.taskId } : {}),
      ...(run.promptVersion ? { promptVersion: run.promptVersion } : {}),
    });
  };
  for (const ws of ids) {
    for (const run of store.agentRuns.list({ workspaceId: ws })) {
      runs.set(run.id, run);
      if (run.status === 'failed' && run.failureReason) failed(run, run.failureReason, run.id, run.endedAt ?? run.startedAt);
    }
    for (const a of usageRepos(store).agentRunAttempts.list({ workspaceId: ws })) {
      if (a.exitCode === 0 || a.rateLimited || !a.failureReason) continue;
      const run = runOf(a.runId);
      if (run) failed(run, a.failureReason, a.id, a.endedAt);
    }
  }

  // Policy denials (blocked attempts, denied approvals) of the tree.
  for (const e of listPolicyEvents(store, {
    workspaceId: rootWorkspaceId,
    kinds: DENIAL_KINDS,
    excludeSites: [KNOWLEDGE_BLOCK_SITE.out_of_tree],
    ...(window.since ? { since: window.since } : {}),
  })) {
    if (!e.role || !inWindow(e.createdAt, window)) continue;
    const run = runOf(e.agentRunId);
    push({
      role: e.role, category: `policy:${e.kind}:${policyActionKey(e.action, config)}`, source: 'policy', refId: e.id, createdAt: e.createdAt,
      ...(e.taskId ?? run?.taskId ? { taskId: (e.taskId ?? run?.taskId)! } : {}),
      ...(e.agentRunId ? { agentRunId: e.agentRunId } : {}),
      ...(run?.promptVersion ? { promptVersion: run.promptVersion } : {}),
    });
  }

  // Human feedback on agent output, and rating disagreements.
  for (const ws of ids) {
    for (const f of listFeedback(store, { workspaceId: ws })) {
      if (!inWindow(f.createdAt, window)) continue;
      let category: string | undefined;
      if (f.kind === 'include_override' && (f.afterJson as { include?: unknown } | undefined)?.include === false) category = `feedback:exclude:${f.targetType}`;
      else if (f.kind === 'proposal_reject' || f.kind === 'proposal_edit' || f.kind === 'hypothesis_correction' || f.kind === 'fact_retract') category = `feedback:${f.kind}`;
      const run = runOf(f.agentRunId);
      if (!category || !run) continue;
      push({
        role: run.role, category, agentRunId: run.id, source: 'feedback', refId: f.id, createdAt: f.createdAt,
        ...(run.taskId ? { taskId: run.taskId } : {}),
        ...(f.promptVersion ?? run.promptVersion ? { promptVersion: (f.promptVersion ?? run.promptVersion)! } : {}),
      });
    }
    for (const r of store.ratings.list({ workspaceId: ws })) {
      if (r.verdict !== 'disagree' || !inWindow(r.createdAt, window)) continue;
      if (r.targetType === 'recommendation' && r.criterion === 'priority') continue; // computed from weights
      const run = runOf(r.agentRunId);
      if (!run) continue;
      push({
        role: run.role, category: `rating:${r.targetType}:${safePart(r.criterion)}`, agentRunId: run.id, source: 'rating', refId: r.id,
        createdAt: r.createdAt,
        ...(run.taskId ? { taskId: run.taskId } : {}),
        ...(r.promptVersion ?? run.promptVersion ? { promptVersion: (r.promptVersion ?? run.promptVersion)! } : {}),
      });
    }
  }

  // Knowledge-store signals (KS-6), per task.
  for (const k of knowledgeSignals(store, {
    workspaceId: rootWorkspaceId,
    scope: 'tree',
    ...(window.since ? { since: window.since } : {}),
    ...(window.until ? { until: window.until } : {}),
    ...(config ? { config: { knowledge: config.knowledge } } : {}),
  })) {
    if (!isRole(k.role)) continue;
    if (RATE_KINDS.has(k.kind) && (k.rate ?? 0) < KNOWLEDGE_RATE_FLOOR) continue;
    for (const taskId of k.taskIds) {
      push({
        role: k.role, category: `knowledge:${k.kind}`, taskId, source: 'knowledge', refId: k.examples[0] ?? taskId,
        ...(k.promptVersion ? { promptVersion: k.promptVersion } : {}),
      });
    }
  }

  // Signals recorded by other packages.
  for (const s of lessonRepos(store).signals.list({ rootWorkspaceId })) {
    if (!inWindow(s.createdAt, window)) continue;
    push({
      role: s.role, category: s.category, source: 'recorded', refId: s.refId ?? s.id, createdAt: s.createdAt,
      ...(s.taskId ? { taskId: s.taskId } : {}),
      ...(s.agentRunId ? { agentRunId: s.agentRunId } : {}),
      ...(s.promptVersion ? { promptVersion: s.promptVersion } : {}),
      ...(s.note ? { text: s.note, textRefs: [s.refId ?? s.id] } : {}),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// recordLessonSignal (API for other packages, e.g. WP-F reviewer-audit misses)

export type RecordLessonSignalInput = {
  /** Any workspace of the tree the signal belongs to. */
  workspaceId: string;
  /** The role the lesson is for (e.g. `reviewer` for an audit miss). */
  role: Role;
  /** Lowercase identifier, `<area>:<kind>` (e.g. `audit:missed_issue`). */
  category: string;
  /** Who records it (e.g. `reviewer_audit`). */
  source: string;
  /** Idempotency key within `source` (e.g. the audit row id); a repeated call returns the first row. */
  sourceKey?: string;
  taskId?: string;
  agentRunId?: string;
  promptVersion?: string;
  refId?: string;
  /** Text for the user (never in a rule; quoted as an example only under the upload rules). */
  note?: string;
  createdAt?: string;
};

const CATEGORY = /^[a-z0-9_]+(:[a-z0-9_.-]+){1,3}$/;

/**
 * Records a lesson signal for the role in the workspace's tree (counted by the engine like any other
 * signal: a rule is proposed once the category recurs in `lessons.minTasks` tasks). The task and run,
 * when given, must belong to the same tree (else the call throws, like an unknown id).
 */
export function recordLessonSignal(store: Store, input: RecordLessonSignalInput): LessonSignalRecord {
  if (!isRole(input.role)) throw new Error(`unknown role '${String(input.role)}'`);
  if (!CATEGORY.test(input.category) || input.category.startsWith('retro:')) throw new Error(`invalid lesson category '${input.category}'`);
  if (!store.workspaces.get(input.workspaceId)) throw new Error(`workspace '${input.workspaceId}' not found`);
  const root = rootOf(store, input.workspaceId);
  const inTree = (ws: string | undefined) => !!ws && rootOf(store, ws) === root;
  if (input.taskId && !inTree(store.tasks.get(input.taskId)?.workspaceId)) throw new Error(`task '${input.taskId}' not found`);
  if (input.agentRunId && !inTree(store.agentRuns.get(input.agentRunId)?.workspaceId)) throw new Error(`agent run '${input.agentRunId}' not found`);
  const repo = lessonRepos(store).signals;
  if (input.sourceKey) {
    const prior = repo.list({ source: input.source, sourceKey: input.sourceKey })[0];
    if (prior) return prior;
  }
  const row: LessonSignalRecord = {
    id: newId('lsig'),
    workspaceId: input.workspaceId,
    rootWorkspaceId: root,
    role: input.role,
    category: input.category,
    source: input.source,
    createdAt: input.createdAt ?? new Date().toISOString(),
  };
  for (const k of ['sourceKey', 'taskId', 'agentRunId', 'promptVersion', 'refId', 'note'] as const) {
    const v = input[k]?.trim();
    if (v) row[k] = v;
  }
  return repo.insert(row);
}
