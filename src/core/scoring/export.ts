import type { Store } from '../store/db.js';
import type { Decision, Rating } from '../types.js';

/** Ids a decision is about: its refs plus ids named in its payload. */
function decisionTargets(d: Decision): Set<string> {
  const ids = new Set<string>([d.id, ...d.refs]);
  const p = (d.payload ?? {}) as Record<string, unknown>;
  for (const k of ['findingId', 'symptomId', 'recommendationId', 'personaId']) {
    if (typeof p[k] === 'string') ids.add(p[k] as string);
  }
  return ids;
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
 * Training export: one JSON line per decision in the workspace (`{decision, ratings}`), joined with
 * the user's ratings of the decision itself or of the items it refers to. A persona_feedback
 * decision joins only the persona_feedback ratings of exactly its `<recId>:<personaId>`; other
 * decisions never join persona_feedback ratings. Decisions referencing any internal upload (see
 * `uploadIds`) are excluded unless `includeUploads`.
 */
export function exportTrainingData(workspaceId: string, deps: { store: Store }, includeUploads = false): string {
  const { store } = deps;
  const ratings = store.ratings.list({ workspaceId });
  const uploads = includeUploads ? new Set<string>() : uploadIds(store);
  const lines: string[] = [];
  for (const decision of store.decisions.list({ workspaceId })) {
    if (decision.refs.some((id) => uploads.has(id))) continue;
    let joined: Rating[];
    if (decision.kind === 'persona_feedback') {
      const target = feedbackTargetId(decision);
      joined = ratings.filter((r) =>
        r.targetType === 'persona_feedback' ? r.targetId === target : r.targetType === 'decision' && r.targetId === decision.id,
      );
    } else {
      const targets = decisionTargets(decision);
      joined = ratings.filter((r) =>
        r.targetType === 'persona_feedback'
          ? false
          : r.targetType === 'decision'
            ? r.targetId === decision.id
            : targets.has(r.targetId),
      );
    }
    lines.push(JSON.stringify({ decision, ratings: joined }));
  }
  return lines.length ? `${lines.join('\n')}\n` : '';
}
