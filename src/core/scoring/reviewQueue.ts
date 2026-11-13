import { competitorCriteria } from '../market/competitors.js';
import type { Store } from '../store/db.js';
import type { Criteria, Rating } from '../types.js';
import { criterionDef, type TargetType } from './criteria.js';

export type ReviewQueueItem = {
  targetType: TargetType;
  targetId: string;
  title: string;
  /** The agent's values, ratable criteria only. */
  criteria: Criteria;
  /** Criterion keys the user has not rated yet. */
  unrated: string[];
};

/**
 * Items of a workspace that still have at least one agent value the user has not rated: findings,
 * symptoms/strengths, recommendations (criteria + computed `priority`), persona feedback (target id
 * `<recommendationId>:<personaId>`, simulated), competitors (threat, directness, comparison areas)
 * and persona profiles (field confidence). Only keys
 * known to `CRITERIA` for the target type are listed, so every queued criterion is ratable.
 * Superseded findings, recommendations and personas (replaced in a later review round) are skipped.
 */
export function reviewQueue(workspaceId: string, deps: { store: Store }): ReviewQueueItem[] {
  const { store } = deps;
  const rated = new Set(store.ratings.list({ workspaceId }).map((r) => `${r.targetType}|${r.targetId}|${r.criterion}`));
  const out: ReviewQueueItem[] = [];
  const push = (targetType: Rating['targetType'], targetId: string, title: string, values: Record<string, unknown>) => {
    const criteria: Criteria = {};
    for (const [k, v] of Object.entries(values)) {
      if ((typeof v === 'number' || typeof v === 'string') && criterionDef(targetType, k)) criteria[k] = v;
    }
    const unrated = Object.keys(criteria).filter((k) => !rated.has(`${targetType}|${targetId}|${k}`));
    if (unrated.length) out.push({ targetType, targetId, title, criteria, unrated });
  };

  for (const s of store.symptoms.list({ workspaceId })) push('symptom', s.id, s.title, s.criteria);
  const live = <T extends { status?: string | undefined }>(xs: T[]) => xs.filter((x) => x.status !== 'superseded');
  for (const f of live(store.findings.list({ workspaceId }))) push('finding', f.id, f.claim, f.criteria);
  for (const r of live(store.recommendations.list({ workspaceId }))) {
    push('recommendation', r.id, r.title, { ...r.criteria, priority: r.priority });
    for (const fb of r.personaFeedback) {
      push('persona_feedback', `${r.id}:${fb.personaId}`, `${r.title} — persona ${fb.personaId} (simulated)`, fb.scores);
    }
  }
  for (const c of store.competitors.list({ workspaceId })) push('competitor', c.id, c.name, competitorCriteria(c));
  for (const p of live(store.personas.list({ workspaceId }))) {
    push('persona', p.id, p.segment, Object.fromEntries(Object.entries(p.profile).map(([k, f]) => [k, f.confidence])));
  }
  return out;
}
