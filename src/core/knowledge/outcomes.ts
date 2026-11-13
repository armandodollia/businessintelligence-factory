/**
 * Knowledge-store decision outcomes (design §13 "WP-C"; build plan KS-6). Who writes which label, each
 * once per subject and source event (`recordOutcome`'s unique key):
 *
 * | label             | written by                                                        | key            |
 * |-------------------|-------------------------------------------------------------------|----------------|
 * | `confirmed`       | `applyObservations` (facts.ts) — a verified confirmation           | observation id |
 * | `changed`         | `applyObservations` — the version a verified replacement replaced; `factOutcomesFromFeedback` — an accepted unverified update | observation id |
 * | `retracted`       | `applyObservations` — a verified retraction                        | observation id |
 * | `stale`           | `recordStaleOutcome` (facts.ts), called by `list_changes` (KS-4), the briefing (KS-5) and, with a config, the scheduled "what changed" (`whatChangedOutcomes.ts`) | `last_confirmed_at` |
 * | `user-rejected`   | `factOutcomesFromFeedback` — the user retracted a fact (`fact_retract`) | observation id |
 * | `duplicate-saved` | `duplicateSavedFromFeedback` (here) — see below                    | feedback event |
 *
 * `duplicate-saved` (design §13: "a duplicate handshake answered `new` that the user later merges"):
 * fact F was saved with an explicit `relation: "new"` after a duplicate handshake in the same agent
 * run had shown candidate facts, and the user then
 * - merged two entities so that F and a fact of a shown candidate's lineage now sit on one entity
 *   (they were on the two merged entities: `entity_merge`, pairs computed before the merge by
 *   `mergeDuplicateSaves` and carried in the event's `afterJson.duplicateSaved`), or
 * - retracted F as a duplicate of another fact (`retractFactByUser(…, { duplicateOf })`,
 *   `afterJson.duplicateOf`; v1 has no fact merge, this is its form).
 * The outcome judges F's save decision; written through the feedback listener (WP-C's one place).
 */
import type { Store } from '../store/db.js';
import { learningRepos } from '../learning/store.js';
import { outputSaveDecision, recordOutcome } from '../learning/outcomes.js';
import type { DecisionOutcome } from '../learning/types.js';
import type { Decision, Finding } from '../types.js';
import { claimSimilarity, normalizeClaim } from './facts.js';

/** The handshake a fact's save answered with `new`, if it did. */
export type AnsweredHandshake = { save: Decision; handshake: Decision; candidateIds: string[] };

/**
 * When fact `f` was saved with an explicit `relation: "new"` right after a duplicate handshake of the
 * same agent run for (about) the same claim: that save, the handshake and the candidates it showed.
 */
export function answeredHandshake(store: Store, f: Pick<Finding, 'id' | 'claim'>): AnsweredHandshake | undefined {
  const save = outputSaveDecision(store, 'finding', f.id);
  const p = save?.payload as { relation?: unknown } | null | undefined;
  if (!save || p?.relation !== 'new') return undefined;
  const claim = normalizeClaim(f.claim);
  const handshake = store.decisions
    .list({ agentRunId: save.agentRunId })
    .filter((d) => {
      const hp = d.payload as { event?: unknown; claim?: unknown } | null;
      if (hp?.event !== 'duplicate_handshake' || d.createdAt > save.createdAt || typeof hp.claim !== 'string') return false;
      return normalizeClaim(hp.claim) === claim || claimSimilarity(hp.claim, f.claim) >= 0.5;
    })
    .at(-1);
  if (!handshake) return undefined;
  const cands = (handshake.payload as { candidates?: unknown }).candidates;
  const candidateIds = Array.isArray(cands) ? cands.flatMap((c) => (typeof (c as { id?: unknown })?.id === 'string' ? [(c as { id: string }).id] : [])) : [];
  return candidateIds.length ? { save, handshake, candidateIds } : undefined;
}

const lineageOf = (store: Store, id: string): string | undefined => {
  const f = store.findings.get(id);
  return f ? (f.lineageId ?? f.id) : undefined;
};

/**
 * Pairs a merge of `loserId` into `survivorId` will reveal as duplicate saves: a fact on one of the two
 * entities that answered a handshake with `new`, and a shown candidate whose lineage sits on the
 * OTHER entity. Call BEFORE the merge (it re-points facts). `mergeEntitiesAsUser` stores the pairs in
 * the `entity_merge` event.
 */
export function mergeDuplicateSaves(store: Store, survivorId: string, loserId: string): Array<{ findingId: string; duplicateOf: string }> {
  const on = (entityId: string) => store.findings.list({ entityId }).filter((f) => f.status !== 'superseded');
  const sides = [on(survivorId), on(loserId)];
  const lineages = sides.map((fs) => new Set(fs.map((f) => f.lineageId ?? f.id)));
  const out: Array<{ findingId: string; duplicateOf: string }> = [];
  sides.forEach((facts, i) => {
    const other = lineages[1 - i]!;
    for (const f of facts) {
      const hs = answeredHandshake(store, f);
      const hit = hs?.candidateIds.find((c) => {
        const l = lineageOf(store, c);
        return l !== undefined && other.has(l);
      });
      if (hit) out.push({ findingId: f.id, duplicateOf: hit });
    }
  });
  return out;
}

/** One `duplicate-saved` outcome on fact `findingId`'s save decision, keyed by the feedback event. */
export function recordDuplicateSavedOutcome(
  store: Store,
  input: { findingId: string; duplicateOf: string; feedbackEventId: string; actor: string; via: 'entity_merge' | 'fact_retract' },
): DecisionOutcome | undefined {
  const f = store.findings.get(input.findingId);
  if (!f) return undefined;
  const hs = answeredHandshake(store, f);
  if (!hs) return undefined;
  return recordOutcome(store, {
    decisionId: hs.save.id,
    subjectType: 'fact_version',
    subjectId: f.id,
    workspaceId: f.workspaceId,
    outcome: 'duplicate_saved',
    label: 'duplicate-saved',
    source: 'user_reject',
    sourceKey: `feedback:${input.feedbackEventId}`,
    actor: input.actor,
    evidence: {
      duplicateOf: input.duplicateOf,
      handshakeDecisionId: hs.handshake.id,
      candidatesShown: hs.candidateIds,
      feedbackEventId: input.feedbackEventId,
      via: input.via,
    },
    targetType: 'finding',
    targetId: f.id,
  });
}

/** The `duplicate-saved` outcomes a feedback event implies (for the feedback listener); [] otherwise. */
export function duplicateSavedFromFeedback(
  store: Store,
  event: { id: string; kind: string; targetId: string; actor: string; afterJson?: unknown },
): DecisionOutcome[] {
  const after = (event.afterJson ?? {}) as { duplicateSaved?: unknown; duplicateOf?: unknown };
  const out: DecisionOutcome[] = [];
  if (event.kind === 'entity_merge' && Array.isArray(after.duplicateSaved)) {
    for (const pair of after.duplicateSaved as Array<{ findingId?: unknown; duplicateOf?: unknown }>) {
      if (typeof pair?.findingId !== 'string' || typeof pair.duplicateOf !== 'string') continue;
      const o = recordDuplicateSavedOutcome(store, {
        findingId: pair.findingId, duplicateOf: pair.duplicateOf, feedbackEventId: event.id, actor: event.actor, via: 'entity_merge',
      });
      if (o) out.push(o);
    }
  }
  if (event.kind === 'fact_retract' && typeof after.duplicateOf === 'string') {
    const o = recordDuplicateSavedOutcome(store, {
      findingId: event.targetId, duplicateOf: after.duplicateOf, feedbackEventId: event.id, actor: event.actor, via: 'fact_retract',
    });
    if (o) out.push(o);
  }
  return out;
}

// ---------------------------------------------------------------------------
// lineage outcomes of a research run (the scheduled "what changed", `whatChangedOutcomes.ts`)

/** Applied observations of a research run (any workspace of it), in insertion order. */
export function appliedObservationsOfRun(store: Store, researchRunId: string) {
  return store.db
    .prepare(`SELECT id, lineage_id AS lineageId, finding_id AS findingId, kind FROM fact_observations WHERE run_id = ? AND status = 'applied' ORDER BY rowid`)
    .all(researchRunId) as Array<{ id: string; lineageId: string; findingId: string; kind: string }>;
}

/** Lineages a research run observed (created, confirmed, replaced or retracted, applied). */
export function observedLineages(store: Store, researchRunId: string): Set<string> {
  return new Set(appliedObservationsOfRun(store, researchRunId).map((o) => o.lineageId));
}

/**
 * The lineage outcomes (`confirmed`, `changed`, `retracted`) written when the run's observations were
 * applied at task end, in insertion order. Reads only: they are written once, by `applyObservations`.
 */
export function lineageOutcomesOfRun(store: Store, researchRunId: string): DecisionOutcome[] {
  const ids = store.db
    .prepare(
      `SELECT o.id AS id FROM decision_outcomes o
       WHERE o.source = 'fact_lineage' AND o.source_key IN (SELECT id FROM fact_observations WHERE run_id = ?)
       ORDER BY o.rowid`,
    )
    .all(researchRunId) as Array<{ id: string }>;
  const repo = learningRepos(store).decisionOutcomes;
  return ids.flatMap(({ id }) => {
    const o = repo.get(id);
    return o ? [o] : [];
  });
}
