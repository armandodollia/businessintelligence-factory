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

/** Recommendation id a persona_feedback decision is about (`payload.input.recommendation_id`). */
function feedbackRecommendation(d: Decision): string | undefined {
  if (d.kind !== 'persona_feedback') return undefined;
  const input = ((d.payload ?? {}) as Record<string, unknown>).input as Record<string, unknown> | undefined;
  return typeof input?.recommendation_id === 'string' ? input.recommendation_id : undefined;
}

/**
 * Training export: one JSON line per decision in the workspace (`{decision, ratings}`), joined
 * with the user's ratings of the decision itself or of the items it refers to (persona_feedback
 * ratings `<recId>:<personaId>` join the persona_feedback decisions on that recommendation).
 * Decisions whose refs include an internal `upload` artifact are excluded unless `includeUploads`.
 */
export function exportTrainingData(workspaceId: string, deps: { store: Store }, includeUploads = false): string {
  const { store } = deps;
  const ratings = store.ratings.list({ workspaceId });
  const isUpload = (id: string) => {
    const a = store.artifacts.get(id);
    return a?.kind === 'upload' && a.workspaceId === workspaceId;
  };
  const lines: string[] = [];
  for (const decision of store.decisions.list({ workspaceId })) {
    if (!includeUploads && decision.refs.some(isUpload)) continue;
    const targets = decisionTargets(decision);
    const feedbackRec = feedbackRecommendation(decision);
    const joined = ratings.filter((r: Rating) =>
      r.targetType === 'persona_feedback'
        ? feedbackRec !== undefined && r.targetId.startsWith(`${feedbackRec}:`)
        : r.targetType === 'decision'
          ? r.targetId === decision.id
          : targets.has(r.targetId),
    );
    lines.push(JSON.stringify({ decision, ratings: joined }));
  }
  return lines.length ? `${lines.join('\n')}\n` : '';
}
