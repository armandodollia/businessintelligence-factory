/**
 * Human feedback as calibration signals (learning loop WP-A). Besides explicit ratings, calibration
 * (`calibrationReport`, `proposePromptPatch`) counts:
 * - unit proposal decisions: real rating rows on the proposing Decision, criterion `unit_proposal`
 *   (`rejected`, `edited` = accepted with edits, `accepted`), written by `decideUnitProposal`;
 * - include overrides: rating-equivalent rows derived from the latest `include_override` feedback
 *   event per output (`feedbackRatings`), criterion `include`: excluding an output (`false`) is a
 *   `disagree` with it; including an output that did not pass review (`true` on a non-verified
 *   output) is an `agree` with the agent over the reviewer. A reset (`null`) withdraws the signal.
 * Both criteria get a scale (`SIGNAL_SCALES`) so their disagreements have a size and rank in the
 * prompt patch's top-N examples.
 */
import type { Store } from '../store/db.js';
import type { Rating } from '../types.js';
import { listFeedback, type FeedbackEvent } from './events.js';
import { judgmentIndex, targetProvenance } from './provenance.js';

/** Criterion of include-override signals. */
export const INCLUDE_CRITERION = 'include';
/** Criterion of unit proposal decisions (rating on the proposing Decision). */
export const UNIT_PROPOSAL_CRITERION = 'unit_proposal';

/**
 * Ordinal scales of the signal criteria, 0 (rejected by the user) – 1 (as the agent proposed). The
 * delta of a rating is user − agent on this scale, so a rejection / exclusion is −1, the largest
 * possible disagreement on any normalized scale.
 */
export const SIGNAL_SCALES: Record<string, Record<string, number>> = {
  [UNIT_PROPOSAL_CRITERION]: { proposed: 1, accepted: 1, edited: 0.5, rejected: 0 },
  [INCLUDE_CRITERION]: { included: 1, excluded: 0 },
};

function signalValue(criterion: string, v: unknown): number | undefined {
  const scale = SIGNAL_SCALES[criterion];
  if (!scale || typeof v !== 'string') return undefined;
  // For `include` the agent side is the output's review status: the agent asserted the output.
  if (criterion === INCLUDE_CRITERION && !Object.hasOwn(scale, v)) return 1;
  return Object.hasOwn(scale, v) ? scale[v] : undefined;
}

/**
 * Signed delta (user − agent) of a signal-criterion rating, 0 for an agree; undefined for any other
 * criterion (those use `normalizedDelta` with their `CRITERIA` scale).
 */
export function signalDelta(r: Pick<Rating, 'criterion' | 'verdict' | 'agentValue' | 'userValue'>): number | undefined {
  if (!Object.hasOwn(SIGNAL_SCALES, r.criterion)) return undefined;
  if (r.verdict === 'agree') return 0;
  const a = signalValue(r.criterion, r.agentValue);
  const u = signalValue(r.criterion, r.userValue);
  return a === undefined || u === undefined ? undefined : u - a;
}

type IncludeState = { include?: boolean | null; status?: string };

/**
 * Rating-equivalent rows of the workspace's current include overrides (latest `include_override`
 * event per output). Target: the output itself (finding, recommendation, persona, competitor), or
 * for a hypothesis (no rating target type of its own) the `save_hypothesis` Decision that produced it.
 * Row id = the feedback event id; `agentValue` = the output's review status before the override.
 */
export function feedbackRatings(store: Store, workspaceId: string): Rating[] {
  const latest = new Map<string, FeedbackEvent>();
  for (const e of listFeedback(store, { workspaceId, kind: 'include_override' })) {
    const key = `${e.targetType}\u0000${e.targetId}`;
    latest.delete(key);
    latest.set(key, e);
  }
  let index: ReturnType<typeof judgmentIndex> | undefined;
  const out: Rating[] = [];
  for (const e of latest.values()) {
    const after = (e.afterJson ?? {}) as IncludeState;
    const before = (e.beforeJson ?? {}) as IncludeState;
    const status = typeof before.status === 'string' ? before.status : 'unknown';
    if (after.include !== false && !(after.include === true && status !== 'verified')) continue;
    let targetType: Rating['targetType'];
    let targetId = e.targetId;
    if (e.targetType === 'hypothesis') {
      index ??= judgmentIndex(store, workspaceId);
      const decisionId = targetProvenance(store, workspaceId, 'hypothesis', e.targetId, e.createdAt, index).decisionId;
      if (!decisionId) continue;
      targetType = 'decision';
      targetId = decisionId;
    } else if (e.targetType === 'finding' || e.targetType === 'recommendation' || e.targetType === 'persona' || e.targetType === 'competitor') {
      targetType = e.targetType;
    } else {
      continue;
    }
    const row: Rating = {
      id: e.id,
      workspaceId,
      targetType,
      targetId,
      criterion: INCLUDE_CRITERION,
      agentValue: status,
      verdict: after.include === false ? 'disagree' : 'agree',
      createdAt: e.createdAt,
      actor: e.actor,
    };
    if (after.include === false) row.userValue = 'excluded';
    if (e.reason) row.reason = e.reason;
    if (e.agentRunId) row.agentRunId = e.agentRunId;
    if (e.promptVersion) row.promptVersion = e.promptVersion;
    out.push(row);
  }
  return out;
}

/** Explicit ratings of a workspace plus its feedback-derived signal rows (`feedbackRatings`). */
export function ratingsWithSignals(store: Store, workspaceId: string, ratings: Rating[] = store.ratings.list({ workspaceId })): Rating[] {
  return [...ratings, ...feedbackRatings(store, workspaceId)];
}
