import type { Rating } from '../types.js';

/**
 * `1-5`: integer-ish score 1–5. `pct`: percent 0–100 (values ≤ 1 are read as a 0–1 fraction).
 * `trend`: one of ↑ → ↓. `range`: free numeric value or range (e.g. cost "$10k–$50k", review 0–10).
 */
export type Scale = '1-5' | 'pct' | 'trend' | 'range';
export type CriterionDef = { key: string; scale: Scale };
export type TargetType = Rating['targetType'];

/** Persona profile fields (spec §8b). Each is ratable on its confidence (criterion = field name). */
export const PERSONA_FIELDS = [
  'demographics',
  'socioeconomic',
  'personality_values',
  'goals',
  'needs',
  'pain_points',
  'jobs_to_be_done',
  'buying_behavior',
  'channels_media',
  'alternatives_switching',
  'tech_attitude',
  'voice',
  'segment_size_value',
] as const;
export type PersonaField = (typeof PERSONA_FIELDS)[number];

/** Evidence-backed recommendation criteria combined into `priority`. */
export const RECOMMENDATION_KEYS = [
  'upside',
  'difficulty',
  'cost',
  'timeToValue',
  'risk',
  'confidence',
  'strategicFit',
  'competitiveUrgency',
] as const;
export type RecommendationKey = (typeof RECOMMENDATION_KEYS)[number];

/** Criteria where a higher value is worse; normalized as 6 − v before weighting. */
export const INVERTED_KEYS: ReadonlySet<string> = new Set(['difficulty', 'cost', 'timeToValue', 'risk']);

export const PERSONA_FEEDBACK_KEYS = ['appeal', 'adoption', 'willingnessToPay', 'friction'] as const;

const RECOMMENDATION_SCALES: Record<RecommendationKey, Scale> = {
  upside: '1-5',
  difficulty: '1-5',
  cost: 'range',
  timeToValue: '1-5',
  risk: '1-5',
  confidence: 'pct',
  strategicFit: '1-5',
  competitiveUrgency: '1-5',
};

/**
 * Ratable criteria per target type (spec §9). Recommendation also exposes `priority` so the user
 * can override the computed priority — those overrides feed `proposeWeights`.
 */
export const CRITERIA: Record<TargetType, CriterionDef[]> = {
  symptom: [
    { key: 'severity', scale: '1-5' },
    { key: 'trend', scale: 'trend' },
    { key: 'causeConfidence', scale: 'pct' },
  ],
  competitor: [
    { key: 'threat', scale: '1-5' },
    { key: 'directness', scale: '1-5' },
    { key: 'pricing', scale: '1-5' },
    { key: 'onboarding', scale: '1-5' },
    { key: 'ux', scale: '1-5' },
    { key: 'features', scale: '1-5' },
  ],
  finding: [
    { key: 'relevance', scale: '1-5' },
    { key: 'reliability', scale: '1-5' },
    { key: 'novelty', scale: '1-5' },
  ],
  recommendation: [
    ...RECOMMENDATION_KEYS.map((key) => ({ key, scale: RECOMMENDATION_SCALES[key] })),
    { key: 'priority', scale: 'range' },
  ],
  persona: PERSONA_FIELDS.map((key) => ({ key, scale: 'pct' as const })),
  persona_feedback: PERSONA_FEEDBACK_KEYS.map((key) => ({ key, scale: '1-5' as const })),
  decision: [
    { key: 'confidence', scale: 'pct' },
    { key: 'score', scale: 'range' },
  ],
};

export function criterionDef(targetType: TargetType, criterion: string): CriterionDef | undefined {
  return CRITERIA[targetType]?.find((c) => c.key === criterion);
}

/** Numeric value of a criterion, or undefined when not numeric (trend arrows, free text). */
export function toNumber(v: unknown): number | undefined {
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v.trim().replace(/%$/, ''));
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

/** Percent → 0–1 fraction (values ≤ 1 are already fractions). */
export function pctFraction(v: number): number {
  return Math.min(1, Math.max(0, v > 1 ? v / 100 : v));
}

const TREND_NUM: Record<string, number> = { '↓': -1, down: -1, '→': 0, flat: 0, '↑': 1, up: 1 };

/**
 * Signed disagreement between two values of a criterion as a fraction of the scale's span, so
 * deltas are comparable across criteria (1-5 → /4, pct → /1 after fraction, trend → /2,
 * range → relative). Undefined when either side is not comparable.
 */
export function normalizedDelta(scale: Scale, agent: unknown, user: unknown): number | undefined {
  if (scale === 'trend') {
    const a = TREND_NUM[String(agent ?? '').trim().toLowerCase()];
    const u = TREND_NUM[String(user ?? '').trim().toLowerCase()];
    return a === undefined || u === undefined ? undefined : (u - a) / 2;
  }
  const a = toNumber(agent);
  const u = toNumber(user);
  if (a === undefined || u === undefined) return undefined;
  switch (scale) {
    case '1-5':
      return (u - a) / 4;
    case 'pct':
      return pctFraction(u) - pctFraction(a);
    case 'range':
      return (u - a) / Math.max(Math.abs(a), Math.abs(u), 1);
  }
}
