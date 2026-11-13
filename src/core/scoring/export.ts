import type { Store } from '../store/db.js';
import type { Decision, Rating } from '../types.js';

/** Payload keys naming a decision's primary subject, in precedence order. */
const PRIMARY_KEYS = ['findingId', 'symptomId', 'recommendationId', 'personaId'] as const;

/**
 * Ids whose (non-persona_feedback) ratings join a decision: its primary subject id when the payload
 * names one (e.g. a `save_finding` score decision joins only that finding's ratings, not ratings of
 * the evidence or task it also references); otherwise its refs. Ratings of the decision itself
 * (targetType `decision`) always join.
 */
function joinTargets(d: Decision): Set<string> {
  const p = (d.payload ?? {}) as Record<string, unknown>;
  for (const k of PRIMARY_KEYS) if (typeof p[k] === 'string') return new Set([p[k] as string]);
  return new Set(d.refs);
}

/**
 * Rating target id (`<recId>:<personaId>`) of a persona_feedback decision, from the persona stamped
 * on it by the panel (`payload.personaId`). Undefined for unstamped (legacy) decisions, which then
 * get no persona_feedback ratings rather than a guessed persona's.
 */
function feedbackTargetId(d: Decision): string | undefined {
  const p = (d.payload ?? {}) as Record<string, unknown>;
  const input = p.input as Record<string, unknown> | undefined;
  const recId = input?.recommendation_id;
  return typeof recId === 'string' && typeof p.personaId === 'string' ? `${recId}:${p.personaId}` : undefined;
}

/**
 * Ids of internal uploads, across ALL workspaces (uploads of ancestors / siblings may be cited by a
 * node): every artifact of kind `upload`, plus every id listed in any `profile.uploads` (covers an
 * upload whose bytes sha-deduped onto an artifact saved earlier under another kind).
 */
function uploadIds(store: Store): Set<string> {
  const ids = new Set<string>(store.artifacts.list({ kind: 'upload' }).map((a) => a.id));
  for (const p of store.profiles.list()) {
    const u = p.data.uploads;
    if (Array.isArray(u)) for (const id of u) if (typeof id === 'string') ids.add(id);
  }
  return ids;
}

/**
 * A decision's refs expanded one hop: each referenced finding / symptom / persona contributes the
 * evidence artifacts it cites (so a decision about a finding backed by an upload is upload-linked).
 */
function expandedRefs(store: Store, d: Decision): string[] {
  const out = new Set(d.refs);
  for (const id of d.refs) {
    const evidence =
      store.findings.get(id)?.evidence ??
      store.symptoms.get(id)?.evidence ??
      Object.values(store.personas.get(id)?.profile ?? {}).flatMap((f) => f.evidence ?? []);
    for (const e of evidence) out.add(e);
  }
  return [...out];
}

/**
 * Training export: one JSON line per decision in the workspace (`{decision, ratings}`), joined with
 * the user's ratings. A persona_feedback decision joins only the persona_feedback ratings of exactly
 * its `<recId>:<personaId>`; other decisions join ratings of their primary subject (see
 * `joinTargets`) and never persona_feedback ratings; every decision joins ratings of itself.
 * Decisions referencing an internal upload — directly or through a referenced finding / symptom /
 * persona's evidence (one hop) — are excluded unless `includeUploads`.
 */
export function exportTrainingData(workspaceId: string, deps: { store: Store }, includeUploads = false): string {
  const { store } = deps;
  const ratings = store.ratings.list({ workspaceId });
  const uploads = includeUploads ? undefined : uploadIds(store);
  const lines: string[] = [];
  for (const decision of store.decisions.list({ workspaceId })) {
    if (uploads && expandedRefs(store, decision).some((id) => uploads.has(id))) continue;
    const self = (r: Rating) => r.targetType === 'decision' && r.targetId === decision.id;
    let joined: Rating[];
    if (decision.kind === 'persona_feedback') {
      const target = feedbackTargetId(decision);
      joined = ratings.filter((r) => self(r) || (r.targetType === 'persona_feedback' && r.targetId === target));
    } else {
      const targets = joinTargets(decision);
      joined = ratings.filter(
        (r) => self(r) || (r.targetType !== 'persona_feedback' && r.targetType !== 'decision' && targets.has(r.targetId)),
      );
    }
    lines.push(JSON.stringify({ decision, ratings: joined }));
  }
  return lines.length ? `${lines.join('\n')}\n` : '';
}
