import type { Store } from '../store/db.js';
import { newId } from '../store/repos.js';
import type { Rating, Role } from '../types.js';
import { CRITERIA, criterionDef, toNumber, type CriterionDef, type TargetType } from './criteria.js';
import { COST_FORMATS, costScore } from './priority.js';

export type RatingInput = Omit<Rating, 'id' | 'createdAt' | 'agentValue'>;

export class RatingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RatingError';
  }
}

type Target = { agentValue: Rating['agentValue']; title: string; role: Role | undefined };

const scalar = (v: unknown): number | string | null =>
  typeof v === 'number' || typeof v === 'string' ? v : null;

/**
 * Resolves a rating target in the workspace: the agent's current value for `criterion`, a display
 * title, and the agent role that produced the value. Undefined when the target does not exist.
 *
 * Target ids: persona_feedback = `<recommendationId>:<personaId>`; persona = persona id
 * (criterion = profile field, value = its confidence); decision = decision id.
 */
export function resolveTarget(
  store: Store,
  workspaceId: string,
  targetType: TargetType,
  targetId: string,
  criterion: string,
): Target | undefined {
  const own = <T extends { workspaceId: string }>(x: T | undefined) => (x && x.workspaceId === workspaceId ? x : undefined);
  switch (targetType) {
    case 'finding': {
      const f = own(store.findings.get(targetId));
      return f && { agentValue: scalar(f.criteria[criterion]), title: f.claim, role: 'worker' };
    }
    case 'symptom': {
      const s = own(store.symptoms.get(targetId));
      return s && { agentValue: scalar(s.criteria[criterion]), title: s.title, role: 'interviewer' };
    }
    case 'recommendation': {
      const r = own(store.recommendations.get(targetId));
      if (!r) return undefined;
      const v = criterion === 'priority' ? r.priority : r.criteria[criterion];
      return { agentValue: scalar(v), title: r.title, role: 'synthesizer' };
    }
    case 'persona': {
      const p = own(store.personas.get(targetId));
      return p && { agentValue: scalar(p.profile[criterion]?.confidence), title: p.segment, role: 'worker' };
    }
    case 'persona_feedback': {
      const sep = targetId.indexOf(':');
      if (sep <= 0) return undefined;
      const r = own(store.recommendations.get(targetId.slice(0, sep)));
      const fb = r?.personaFeedback.find((f) => f.personaId === targetId.slice(sep + 1));
      if (!r || !fb) return undefined;
      return {
        agentValue: scalar((fb.scores as Record<string, unknown>)[criterion]),
        title: `${r.title} — persona ${fb.personaId} (simulated)`,
        role: 'persona',
      };
    }
    case 'decision': {
      const d = own(store.decisions.get(targetId));
      if (!d) return undefined;
      const p = (d.payload ?? {}) as Record<string, unknown>;
      return { agentValue: scalar(p[criterion]), title: String(p.what ?? p.tool ?? d.kind), role: d.role };
    }
    case 'competitor': {
      // No competitor table: a competitor exists when ≥ 1 finding has it as subject (targetId =
      // subject). Value from the latest such finding carrying the criterion, else null.
      const all = store.findings.list({ workspaceId, subject: targetId });
      if (!all.length) return undefined;
      const f = all.filter((x) => x.criteria[criterion] !== undefined).at(-1);
      return { agentValue: f ? scalar(f.criteria[criterion]) : null, title: targetId, role: 'worker' };
    }
  }
}

const TREND_VALUES = new Set(['↑', '→', '↓', 'up', 'flat', 'down']);

/**
 * Checks a user's value against the criterion's scale and unit; returns an error message or
 * undefined. 1-5: number 1–5. pct: number 0–100 (percent) or 0–1 (fraction), per the declared
 * unit. trend: ↑ → ↓ (or up/flat/down). range: recommendation `cost` must parse with `costScore`,
 * recommendation `priority` is 0–5, decision `score` (review) is 0–10, anything else a number.
 */
export function checkUserValue(targetType: TargetType, def: CriterionDef, v: unknown): string | undefined {
  const n = toNumber(v);
  const between = (lo: number, hi: number, what: string) =>
    n === undefined || n < lo || n > hi ? `must be ${what} (got ${JSON.stringify(v)})` : undefined;
  switch (def.scale) {
    case '1-5':
      return between(1, 5, 'a number 1–5');
    case 'pct':
      return def.unit === 'fraction' ? between(0, 1, 'a fraction 0–1') : between(0, 100, 'a percent 0–100');
    case 'trend':
      return TREND_VALUES.has(String(v ?? '').trim().toLowerCase()) ? undefined : `must be one of ↑ → ↓ (got ${JSON.stringify(v)})`;
    case 'range':
      if (targetType === 'recommendation' && def.key === 'cost') {
        return costScore(v) === undefined ? `must be ${COST_FORMATS} (got ${JSON.stringify(v)})` : undefined;
      }
      if (targetType === 'recommendation' && def.key === 'priority') return between(0, 5, 'a priority 0–5');
      if (targetType === 'decision' && def.key === 'score') return between(0, 10, 'a review score 0–10');
      return n === undefined ? `must be a number (got ${JSON.stringify(v)})` : undefined;
  }
}

/**
 * Stores the user's rating of one agent criterion value, snapshotting the agent's current value
 * (`agentValue`). Throws `RatingError` for an unknown target type / criterion, a missing target,
 * `disagree` without `userValue`, or a `userValue` outside the criterion's scale/unit
 * (`checkUserValue`).
 */
export function rateCriterion(input: RatingInput, deps: { store: Store }): Rating {
  const { store } = deps;
  if (!Object.hasOwn(CRITERIA, input.targetType)) throw new RatingError(`unknown target type '${input.targetType}'`);
  if (!criterionDef(input.targetType, input.criterion)) {
    throw new RatingError(
      `unknown criterion '${input.criterion}' for ${input.targetType} (allowed: ${CRITERIA[input.targetType].map((c) => c.key).join(', ')})`,
    );
  }
  if (input.verdict !== 'agree' && input.verdict !== 'disagree') throw new RatingError(`invalid verdict '${String(input.verdict)}'`);
  if (input.verdict === 'disagree' && (input.userValue === undefined || input.userValue === '')) {
    throw new RatingError('disagree needs the userValue the user believes is right');
  }
  if (input.verdict === 'disagree') {
    const bad = checkUserValue(input.targetType, criterionDef(input.targetType, input.criterion)!, input.userValue);
    if (bad) throw new RatingError(`userValue for ${input.targetType}.${input.criterion}: ${bad}`);
  }
  const target = resolveTarget(store, input.workspaceId, input.targetType, input.targetId, input.criterion);
  if (!target) throw new RatingError(`${input.targetType} '${input.targetId}' not found in workspace '${input.workspaceId}'`);
  const rating: Rating = {
    id: newId('rat'),
    workspaceId: input.workspaceId,
    targetType: input.targetType,
    targetId: input.targetId,
    criterion: input.criterion,
    agentValue: target.agentValue,
    verdict: input.verdict,
    createdAt: new Date().toISOString(),
  };
  if (input.verdict === 'disagree') rating.userValue = input.userValue;
  if (input.reason?.trim()) rating.reason = input.reason.trim();
  return store.ratings.insert(rating);
}
