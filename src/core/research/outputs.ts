import type { Store } from '../store/db.js';
import type { Finding, OutputStatus, Persona, Recommendation, Task } from '../types.js';

/**
 * Review status of task outputs (findings, recommendations, personas; spec §7.2, migration 11).
 *
 * Every output carries the task that (last) saved it and the review round it was (re-)saved in
 * (`taskRound`). When the task's review loop ends, its *current* outputs take the task's final
 * status; outputs from earlier rounds that were not re-submitted in the final round are
 * `superseded` (e.g. a `$10` finding corrected to `$20` in a revision).
 */

/** Final statuses a task hands to its outputs. */
export type TaskOutcome = Extract<OutputStatus, 'verified' | 'unverified' | 'failed'>;

type Overridable = { status?: OutputStatus | undefined; includeOverride?: boolean | undefined };

/**
 * Whether a recommendation / persona may be used downstream (persona panel): never when
 * `superseded`; otherwise the user's override, else `verified` only.
 */
export function isOutputUsable(x: Overridable): boolean {
  if (x.status === 'superseded') return false;
  return x.includeOverride ?? (x.status ?? 'pending') === 'verified';
}

/** Whether a recommendation is shown in Strategy: not superseded; failed only when the user included it. */
export function isRecommendationShown(r: Overridable): boolean {
  if (r.status === 'superseded') return false;
  return r.status !== 'failed' || r.includeOverride === true;
}

export type TaskOutputs = { findings: Finding[]; recommendations: Recommendation[]; personas: Persona[] };

/** Outputs (last) saved by a task, in its own workspace. */
export function taskOutputs(store: Store, task: Pick<Task, 'id' | 'workspaceId'>): TaskOutputs {
  const own = <T extends { workspaceId: string }>(xs: T[]) => xs.filter((x) => x.workspaceId === task.workspaceId);
  return {
    findings: own(store.findings.list({ taskId: task.id })),
    recommendations: own(store.recommendations.list({ taskId: task.id })),
    personas: own(store.personas.list({ taskId: task.id })),
  };
}

const OUTPUT_ID = /\b(?:fnd|rec|per)_[0-9A-Z]{26}\b/g;

/** Output ids (`fnd_` / `rec_` / `per_`) cited anywhere in a deliverable. */
export function citedOutputIds(result: unknown): Set<string> {
  const ids = new Set<string>();
  if (result !== undefined) for (const m of JSON.stringify(result).matchAll(OUTPUT_ID)) ids.add(m[0]);
  return ids;
}

/**
 * Ids of the task's current outputs: those (re-)saved in the latest round in which the task saved
 * any output, plus any output cited by id in its submitted deliverable. Outputs without a recorded
 * round (created before migration 11) are always current. Superseded outputs are never current.
 */
export function currentOutputIds(store: Store, task: Task, outputs: TaskOutputs = taskOutputs(store, task)): Set<string> {
  const all = [...outputs.findings, ...outputs.recommendations, ...outputs.personas];
  const rounds = all.map((o) => o.taskRound).filter((r): r is number => typeof r === 'number');
  const latest = rounds.length ? Math.max(...rounds) : undefined;
  const cited = citedOutputIds(task.result);
  return new Set(
    all
      .filter((o) => o.status !== 'superseded')
      .filter((o) => o.taskRound === undefined || o.taskRound === latest || cited.has(o.id))
      .map((o) => o.id),
  );
}

/**
 * Applies a task's final status to its outputs: current outputs take `status`, the others become
 * `superseded`. Run inside the caller's transaction.
 */
export function applyTaskStatus(store: Store, task: Task, status: TaskOutcome): void {
  const outputs = taskOutputs(store, task);
  const current = currentOutputIds(store, task, outputs);
  const next = (id: string): OutputStatus => (current.has(id) ? status : 'superseded');
  for (const f of outputs.findings) store.findings.update(f.id, { status: next(f.id) });
  for (const r of outputs.recommendations) store.recommendations.update(r.id, { status: next(r.id) });
  for (const p of outputs.personas) store.personas.update(p.id, { status: next(p.id) });
}

/** User override (API) for a recommendation or persona; `null` resets to the default. Throws if unknown. */
export function setOutputInclude(
  store: Store,
  kind: 'recommendation' | 'persona',
  id: string,
  include: boolean | null,
): Recommendation | Persona {
  if (kind === 'recommendation') {
    if (!store.recommendations.get(id)) throw new Error(`recommendation '${id}' not found`);
    return store.recommendations.update(id, { includeOverride: include ?? undefined });
  }
  if (!store.personas.get(id)) throw new Error(`persona '${id}' not found`);
  return store.personas.update(id, { includeOverride: include ?? undefined });
}

/** Latest effective reviewer verdict on a task (spec §7.2: unverified results show the objections). */
export type LastReview = { score: number; issues: unknown[]; decisionId: string; at: string; synthetic: boolean };

/**
 * Latest effective review per task id over the given workspaces. A submitted review counts only
 * when its reviewer run finished `done` (same rule as the review loop); otherwise the loop's
 * synthetic (score 0) review counts instead.
 */
export function lastReviewsByTask(store: Store, workspaceIds: string[]): Map<string, LastReview> {
  const out = new Map<string, LastReview>();
  const reviews = workspaceIds
    .flatMap((id) => store.decisions.list({ workspaceId: id, kind: 'review' }))
    .map((d, i) => ({ d, i }))
    .sort((a, b) => a.d.createdAt.localeCompare(b.d.createdAt) || a.i - b.i)
    .map(({ d }) => d);
  for (const d of reviews) {
    const p = (d.payload ?? {}) as { tool?: string; event?: string; score?: unknown; issues?: unknown };
    const synthetic = p.event === 'synthetic_review';
    if (!synthetic && p.tool !== 'submit_review') continue;
    if (typeof p.score !== 'number') continue;
    if (!synthetic && store.agentRuns.get(d.agentRunId)?.status !== 'done') continue;
    for (const taskId of d.refs) {
      out.set(taskId, { score: p.score, issues: Array.isArray(p.issues) ? p.issues : [], decisionId: d.id, at: d.createdAt, synthetic });
    }
  }
  return out;
}

/** Adds `lastReview` (by `taskId`) to each item that has one. */
export function withLastReview<T extends { taskId?: string | undefined }>(
  items: T[],
  reviews: Map<string, LastReview>,
): Array<T & { lastReview?: LastReview }> {
  return items.map((x) => {
    const review = x.taskId ? reviews.get(x.taskId) : undefined;
    return review ? { ...x, lastReview: review } : x;
  });
}
