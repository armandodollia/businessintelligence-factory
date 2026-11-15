import type { Store } from '../store/db.js';
import { applyObservations } from '../knowledge/facts.js'; // KS-2
// Flow records: `flows.ts` imports `isOutputUsable` from here; both sides use the other only at call time.
import { applyFlowStatus } from '../flows/flows.js';
import { flowRepos } from '../flows/repos.js';
import type { Flow } from '../flows/types.js';
import { decisionTags } from '../learning/runTags.js'; // learning loop WP-F
import type { Competitor, Finding, OutputStatus, Persona, Recommendation, SymptomHypothesis, Task } from '../types.js';

/**
 * Review status of task outputs (findings, recommendations, personas — migration 11; competitors and
 * symptom hypotheses — migration 13; spec §7.2; flows — migration 22, `flows/flows.ts`).
 *
 * Every output carries the task that (last) saved it and the review round it was (re-)saved in
 * (`taskRound`). When the task's review loop ends, its *current* outputs take the task's final
 * status; the others are `superseded`. Current means: (re-)saved in the task's final SUBMITTED round
 * (`Task.submittedRound`), or cited by id in the final deliverable. So an output from an earlier
 * round that the final revision neither re-saved nor cited is withdrawn — e.g. a `$10` finding
 * corrected to `$20`, or a round-1 finding dropped without replacement. A revision that saves
 * nothing keeps earlier outputs only by citing their ids in its resubmitted deliverable (the revise
 * prompt lists them and states this rule).
 */

/** Final statuses a task hands to its outputs. */
export type TaskOutcome = Extract<OutputStatus, 'verified' | 'unverified' | 'failed'>;

type Overridable = { status?: OutputStatus | undefined; includeOverride?: boolean | undefined };

/**
 * Whether an output may be used downstream (persona panel, interviewer drill-down, Competitors view,
 * review queue): never when `superseded`; otherwise the user's override, else `verified` only.
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

export type TaskOutputs = {
  findings: Finding[];
  recommendations: Recommendation[];
  personas: Persona[];
  competitors: Competitor[];
  hypotheses: SymptomHypothesis[];
  flows: Flow[];
};

/** Outputs (last) saved by a task, in its own workspace. */
export function taskOutputs(store: Store, task: Pick<Task, 'id' | 'workspaceId'>): TaskOutputs {
  const own = <T extends { workspaceId: string }>(xs: T[]) => xs.filter((x) => x.workspaceId === task.workspaceId);
  return {
    findings: own(store.findings.list({ taskId: task.id })),
    recommendations: own(store.recommendations.list({ taskId: task.id })),
    personas: own(store.personas.list({ taskId: task.id })),
    competitors: own(store.competitors.list({ taskId: task.id })),
    hypotheses: own(store.symptomHypotheses.list({ taskId: task.id })),
    flows: own(flowRepos(store).flows.list({ taskId: task.id })),
  };
}

/** Every output of `o`, of every kind (one list, so callers cannot miss a kind). */
export const allOutputs = (o: TaskOutputs) => [...o.findings, ...o.recommendations, ...o.personas, ...o.competitors, ...o.hypotheses, ...o.flows];

const OUTPUT_ID = /\b(?:fnd|rec|per|cmp|hyp|flw)_[0-9A-Z]{26}\b/g;

/** Output ids (`fnd_` / `rec_` / `per_` / `cmp_` / `hyp_` / `flw_`) cited anywhere in a deliverable. */
export function citedOutputIds(result: unknown): Set<string> {
  const ids = new Set<string>();
  if (result !== undefined) for (const m of JSON.stringify(result).matchAll(OUTPUT_ID)) ids.add(m[0]);
  return ids;
}

/**
 * Ids of the task's current outputs: (re-)saved in its final submitted round
 * (`task.submittedRound`; before any submission: the latest round with outputs), or cited by id in
 * its submitted deliverable. Outputs without a recorded round (created before migration 11/13) are
 * always current. Superseded outputs are never current.
 */
export function currentOutputIds(store: Store, task: Task, outputs: TaskOutputs = taskOutputs(store, task)): Set<string> {
  const all = allOutputs(outputs);
  const rounds = all.map((o) => o.taskRound).filter((r): r is number => typeof r === 'number');
  const submitted = task.submittedRound ?? (rounds.length ? Math.max(...rounds) : undefined);
  const cited = citedOutputIds(task.result);
  return new Set(
    all
      .filter((o) => o.status !== 'superseded')
      .filter((o) => o.taskRound === undefined || o.taskRound === submitted || cited.has(o.id))
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
  for (const c of outputs.competitors) store.competitors.update(c.id, { status: next(c.id) });
  for (const h of outputs.hypotheses) store.symptomHypotheses.update(h.id, { status: next(h.id) });
  for (const f of outputs.flows) flowRepos(store).flows.update(f.id, { status: next(f.id) });
  // Flow records: a verified task's candidate flow versions become current (same transaction).
  applyFlowStatus(store, task, status);
  // Knowledge store KS-2: the task's fact observations (create / confirm / replace / retract) are
  // applied, rejected or superseded with the same outcome, in the same transaction (design §7.2).
  applyObservations(store, task, status, { cited: citedOutputIds(task.result) });
}

// --- learning loop WP-F: experiment arm tasks ----------------------------------------------------
/**
 * End of an experiment arm task (instead of `applyTaskStatus`): every output it saved becomes
 * `superseded` and its fact observations are superseded / rejected (never applied), so an experiment
 * adds nothing to the workspace's findings, recommendations, knowledge or synthesis inputs. The task's
 * own status (and its reviews) remain what the experiment compares. Run inside the caller's transaction.
 */
export function retireExperimentOutputs(store: Store, task: Task): void {
  const outputs = taskOutputs(store, task);
  for (const f of outputs.findings) store.findings.update(f.id, { status: 'superseded' });
  for (const r of outputs.recommendations) store.recommendations.update(r.id, { status: 'superseded' });
  for (const p of outputs.personas) store.personas.update(p.id, { status: 'superseded' });
  for (const c of outputs.competitors) store.competitors.update(c.id, { status: 'superseded' });
  for (const h of outputs.hypotheses) store.symptomHypotheses.update(h.id, { status: 'superseded' });
  for (const f of outputs.flows) flowRepos(store).flows.update(f.id, { status: 'superseded' });
  applyObservations(store, task, 'failed', { cited: new Set() });
}
// --- end WP-F ------------------------------------------------------------------------------------

/** JSON of refs + payload of every Decision made by the task's runs (worker, reviewer, ...). */
function taskDecisionTexts(store: Store, taskId: string): string[] {
  return store.agentRuns
    .list({ taskId })
    .flatMap((run) => store.decisions.list({ agentRunId: run.id }))
    .map((d) => JSON.stringify([d.refs, d.payload ?? null]));
}

const ARTIFACT_ID = /\bart_[0-9A-Z]{26}\b/g;

/**
 * Outputs a task is associated with, for provenance / export filtering (privacy): the outputs it
 * owns PLUS any output (of any task) that its runs saved, re-saved or referenced — every output id in
 * the refs or payload of its runs' Decisions (incl. replay / reuse records) — or that its deliverable
 * (`result`, default: the stored one) cites by id. Ownership and review status are not affected.
 */
export function associatedOutputs(store: Store, task: Pick<Task, 'id' | 'workspaceId'>, result?: unknown): TaskOutputs {
  const owned = taskOutputs(store, task);
  const ids = citedOutputIds(result !== undefined ? result : store.tasks.get(task.id)?.result);
  for (const text of taskDecisionTexts(store, task.id)) for (const m of text.matchAll(OUTPUT_ID)) ids.add(m[0]);
  const add = <T extends { id: string }>(list: T[], get: (id: string) => T | undefined, prefix: string): T[] => {
    const have = new Set(list.map((x) => x.id));
    const extra = [...ids].filter((id) => id.startsWith(prefix) && !have.has(id)).map(get).filter((x): x is T => x !== undefined);
    return [...list, ...extra];
  };
  return {
    findings: add(owned.findings, (id) => store.findings.get(id), 'fnd_'),
    recommendations: add(owned.recommendations, (id) => store.recommendations.get(id), 'rec_'),
    personas: add(owned.personas, (id) => store.personas.get(id), 'per_'),
    competitors: add(owned.competitors, (id) => store.competitors.get(id), 'cmp_'),
    hypotheses: add(owned.hypotheses, (id) => store.symptomHypotheses.get(id), 'hyp_'),
    flows: add(owned.flows, (id) => flowRepos(store).flows.get(id), 'flw_'),
  };
}

/**
 * Every artifact a task's associated outputs (`associatedOutputs`) rest on, transitively: findings'
 * evidence, recommendations → cited findings' evidence, persona field evidence, competitor evidence,
 * hypotheses → cited findings' evidence (or cited artifacts), flows → their steps' screenshots. All
 * outputs count, whatever their status (privacy: export filtering).
 */
export function taskOutputEvidence(store: Store, task: Pick<Task, 'id' | 'workspaceId'>, result?: unknown): string[] {
  const o = associatedOutputs(store, task, result);
  const ids = new Set<string>();
  // Sticky provenance: every artifact any earlier Decision of the task's runs recorded (earlier
  // submit_result provenance, save_* refs, a revision's previous evidence) stays associated, so a
  // correction away from upload evidence cannot launder the deliverable into the export.
  for (const text of taskDecisionTexts(store, task.id)) for (const m of text.matchAll(ARTIFACT_ID)) ids.add(m[0]);
  const findingEvidence = (id: string) => store.findings.get(id)?.evidence;
  for (const f of o.findings) for (const a of f.evidence) ids.add(a);
  for (const r of o.recommendations) for (const fid of r.findingIds) for (const a of findingEvidence(fid) ?? []) ids.add(a);
  for (const p of o.personas) for (const field of Object.values(p.profile ?? {})) for (const a of field.evidence ?? []) ids.add(a);
  for (const c of o.competitors) for (const a of c.evidence) ids.add(a);
  for (const h of o.hypotheses) for (const e of h.evidence) for (const a of findingEvidence(e) ?? [e]) ids.add(a);
  for (const f of o.flows) for (const s of flowRepos(store).flowSteps.list({ flowId: f.id })) if (s.artifactId) ids.add(s.artifactId);
  return [...ids];
}

export type IncludeKind = 'recommendation' | 'persona' | 'competitor';

/** User override (API) for a recommendation, persona or competitor; `null` resets to the default. Throws if unknown. */
export function setOutputInclude(
  store: Store,
  kind: IncludeKind,
  id: string,
  include: boolean | null,
): Recommendation | Persona | Competitor {
  const includeOverride = include ?? undefined;
  if (kind === 'recommendation') {
    if (!store.recommendations.get(id)) throw new Error(`recommendation '${id}' not found`);
    return store.recommendations.update(id, { includeOverride });
  }
  if (kind === 'competitor') {
    if (!store.competitors.get(id)) throw new Error(`competitor '${id}' not found`);
    return store.competitors.update(id, { includeOverride });
  }
  if (!store.personas.get(id)) throw new Error(`persona '${id}' not found`);
  return store.personas.update(id, { includeOverride });
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
    if (decisionTags(store, d.id).auditId !== undefined) continue; // learning loop WP-F: an audit is not the task's review
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
