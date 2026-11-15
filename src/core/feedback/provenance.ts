/**
 * Provenance of human feedback (learning loop WP-A): which agent judgment (Decision → agent run →
 * prompt version) a rating or feedback event is about, and whether an agent revised a rated item
 * after it was rated (review queue re-queue).
 */
import { flowRepos } from '../flows/repos.js';
import type { Store } from '../store/db.js';
import type { Decision, Rating } from '../types.js';
import { rootOf } from '../workspace/tree.js';

/** Payload keys naming a decision's primary subject, in precedence order (as in export.ts). */
const PRIMARY_KEYS = ['findingId', 'symptomId', 'recommendationId', 'personaId', 'competitorId'] as const;

/** A reuse record (`payload.reused: true`) only ties a run to an item; it is never a judgment. */
const isReuse = (d: Decision) => (d.payload as { reused?: unknown } | null)?.reused === true;

/**
 * The item a Decision judges: `<recId>:<personaId>` for persona feedback, the hypothesis for
 * `save_hypothesis` (which also names its symptom), else the first primary subject key of the payload.
 */
export function judgedSubject(d: Decision): string | undefined {
  const p = (d.payload ?? {}) as Record<string, unknown>;
  if (d.kind === 'persona_feedback') {
    const recId = (p.input as Record<string, unknown> | undefined)?.recommendation_id;
    return typeof recId === 'string' && typeof p.personaId === 'string' ? `${recId}:${p.personaId}` : undefined;
  }
  if (p.tool === 'save_hypothesis') return typeof p.hypothesisId === 'string' ? p.hypothesisId : undefined;
  for (const k of PRIMARY_KEYS) if (typeof p[k] === 'string') return p[k] as string;
  return undefined;
}

/** Item id → its judgments (Decisions, reuse records excluded) in log order, for one workspace. */
export function judgmentIndex(store: Store, workspaceId: string): Map<string, Decision[]> {
  const out = new Map<string, Decision[]>();
  for (const d of store.decisions.list({ workspaceId })) {
    if (isReuse(d)) continue;
    const s = judgedSubject(d);
    if (!s) continue;
    const list = out.get(s);
    if (list) list.push(d);
    else out.set(s, [d]);
  }
  return out;
}

export type JudgmentProvenance = { decisionId?: string; agentRunId?: string; promptVersion?: string };

function fromRun(store: Store, runId: string | undefined): JudgmentProvenance {
  const run = runId ? store.agentRuns.get(runId) : undefined;
  if (!run) return {};
  return { agentRunId: run.id, ...(run.promptVersion ? { promptVersion: run.promptVersion } : {}) };
}

/**
 * Run + prompt version of a Decision. System decisions (user / scheduler, prompt version `n/a`) have
 * no agent run; an agent decision keeps its run id even when the run row is gone.
 */
function fromDecision(store: Store, d: Decision): JudgmentProvenance {
  const out: JudgmentProvenance = { decisionId: d.id };
  const run = store.agentRuns.get(d.agentRunId);
  const system = typeof (d.payload as { actor?: unknown } | null)?.actor === 'string'; // recordSystemDecision
  if (run || (d.promptVersion !== 'n/a' && !system)) out.agentRunId = d.agentRunId;
  const version = d.promptVersion !== 'n/a' ? d.promptVersion : run?.promptVersion;
  if (version) out.promptVersion = version;
  return out;
}

/** Latest of `list` created at or before `at` (the first one when `at` predates them all). */
function current(list: Decision[], at: string | undefined): Decision {
  let pick = list[0]!;
  if (at === undefined) return list.at(-1)!;
  for (const d of list) if (d.createdAt <= at) pick = d;
  return pick;
}

/** Task that (last) saved an output, for outputs without a judging Decision. */
function outputTask(store: Store, targetType: string, id: string): string | undefined {
  switch (targetType) {
    case 'finding':
      return store.findings.get(id)?.taskId;
    case 'recommendation':
      return store.recommendations.get(id)?.taskId;
    case 'persona':
      return store.personas.get(id)?.taskId;
    case 'competitor':
      return store.competitors.get(id)?.taskId;
    case 'hypothesis':
      return store.symptomHypotheses.get(id)?.taskId;
    // flow records: the task that saved the flow version (a check answer: its flow's), or the mention
    case 'flow':
      return flowRepos(store).flows.get(id)?.taskId;
    case 'flow_check':
      return flowRepos(store).flows.get(id.split(':')[0]!)?.taskId;
    case 'review_mention':
      return flowRepos(store).reviewMentions.get(id)?.taskId;
    default:
      return undefined;
  }
}

/**
 * Agent judgment behind a rating / feedback target, as of `at` (default: now):
 * - `decision`: that Decision; `unit_proposal`: the Decision that (last) proposed it;
 * - `user_request`: the requesting run;
 * - `flow_verdict`: the persona run that gave the verdict; `flow_type`: the run that proposed it;
 * - `flow`, `flow_check` (`<flowId>:<checklistId>:<itemKey>`), `review_mention`: the latest
 *   non-reviewer run of the task that saved the flow version / mention (none when no task did);
 * - outputs (`finding`, `recommendation`, `persona`, `competitor`, `symptom`, `hypothesis`) and
 *   `persona_feedback` (`<recId>:<personaId>`): the latest judgment of the item at `at`; failing
 *   that, the latest non-reviewer run of the output's task.
 * Empty when nothing is known (or the target is not an agent output, e.g. `profile`).
 */
export function targetProvenance(
  store: Store,
  workspaceId: string,
  targetType: string,
  targetId: string,
  at?: string,
  index?: Map<string, Decision[]>,
): JudgmentProvenance {
  const ownDecision = (id: string | undefined) => {
    const d = id ? store.decisions.get(id) : undefined;
    return d && d.workspaceId === workspaceId ? d : undefined;
  };
  switch (targetType) {
    case 'decision': {
      const d = ownDecision(targetId);
      return d ? fromDecision(store, d) : {};
    }
    case 'unit_proposal': {
      const p = store.unitProposals.get(targetId);
      const d = ownDecision(p?.decisionId);
      return d ? fromDecision(store, d) : {};
    }
    case 'user_request': {
      const r = store.userRequests.get(targetId);
      return r && r.workspaceId === workspaceId ? fromRun(store, r.agentRunId) : {};
    }
    // flow records: a verdict's persona run (its prompt version is the persona's), a flow type's proposing run
    case 'flow_verdict': {
      const v = flowRepos(store).flowVerdicts.get(targetId);
      return v && v.workspaceId === workspaceId ? fromRun(store, v.agentRunId) : {};
    }
    case 'flow_type': {
      const t = flowRepos(store).flowTypes.get(targetId);
      return t && t.rootWorkspaceId === rootOf(store, workspaceId) ? fromRun(store, t.proposedByRun) : {};
    }
    default: {
      const list = (index ?? judgmentIndex(store, workspaceId)).get(targetId);
      if (list?.length) return fromDecision(store, current(list, at));
      const taskId = outputTask(store, targetType, targetId);
      if (!taskId) return {};
      const run = store.agentRuns
        .list({ taskId })
        .filter((r) => r.workspaceId === workspaceId && r.role !== 'reviewer')
        .at(-1);
      return fromRun(store, run?.id);
    }
  }
}

/** Rating target types whose items an agent can revise after they were rated. */
const REVISABLE: ReadonlySet<Rating['targetType']> = new Set([
  'finding', 'recommendation', 'symptom', 'competitor', 'persona', 'persona_feedback',
]);

/**
 * Whether an agent revised the rated item after the rating: a judgment of the item (a revision /
 * re-save Decision, not a reuse record) was logged after the rating was made, so the rated revision
 * is no longer the current one. Decisions themselves are never revised.
 */
export function isRatingStale(r: Rating, index: Map<string, Decision[]>): boolean {
  if (!REVISABLE.has(r.targetType)) return false;
  const list = index.get(r.targetId);
  return !!list?.some((d) => d.createdAt > r.createdAt);
}

/**
 * Keys `<targetType>|<targetId>|<criterion>` the user has rated on the item's current revision (the
 * review queue's "already rated" set): a rating made before the agent revised the item no longer
 * counts, so the item is queued again.
 */
export function currentRatedKeys(store: Store, workspaceId: string, ratings: Rating[] = store.ratings.list({ workspaceId })): Set<string> {
  const index = judgmentIndex(store, workspaceId);
  const out = new Set<string>();
  for (const r of ratings) if (!isRatingStale(r, index)) out.add(`${r.targetType}|${r.targetId}|${r.criterion}`);
  return out;
}
