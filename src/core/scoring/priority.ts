import type { BifConfig } from '../config/schema.js';
import type { ExtraToolHandler, ToolResult } from '../harness/tools/handlers.js';
import { findReplay, titleKey } from '../harness/tools/idempotency.js';
import type { ToolInput, ToolName } from '../harness/tools/registry.js';
import type { Store } from '../store/db.js';
import { newId } from '../store/repos.js';
import type { Criteria, Decision, Recommendation } from '../types.js';
import { CRITERIA, INVERTED_KEYS, RECOMMENDATION_KEYS, pctFraction, toNumber } from './criteria.js';

export type PriorityConfig = { weights?: Record<string, number>; personaWeight?: number };

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const round2 = (v: number) => Math.round(v * 100) / 100;

const LEVELS: Record<string, number> = { 'very low': 1, low: 2, medium: 3, moderate: 3, high: 4, 'very high': 5 };

/** A `range` value (cost) on the 1–5 scale: a number, a level word, or a numeric range within 1–5. */
function rangeTo15(v: unknown): number | undefined {
  const n = toNumber(v);
  if (n !== undefined) return n >= 1 && n <= 5 ? n : undefined;
  if (typeof v !== 'string') return undefined;
  const s = v.trim().toLowerCase();
  if (LEVELS[s] !== undefined) return LEVELS[s];
  const m = /^(\d+(?:\.\d+)?)\s*[-–]\s*(\d+(?:\.\d+)?)$/.exec(s);
  if (m) {
    const mid = (Number(m[1]) + Number(m[2])) / 2;
    if (mid >= 1 && mid <= 5) return mid;
  }
  return undefined;
}

/**
 * A recommendation criterion normalized to 0–5 where higher is better (difficulty, cost, risk and
 * timeToValue inverted as 6 − v). Undefined when missing or not normalizable (e.g. cost
 * "$10k–$50k"); such criteria are left out of the weighted mean.
 */
export function normalizeCriterion(key: string, value: unknown): number | undefined {
  const def = CRITERIA.recommendation.find((c) => c.key === key);
  if (!def || value === undefined || value === null) return undefined;
  let v: number | undefined;
  if (def.scale === 'pct') {
    const n = toNumber(value);
    return n === undefined ? undefined : pctFraction(n) * 5;
  }
  if (def.scale === 'range') v = rangeTo15(value);
  else {
    const n = toNumber(value);
    v = n === undefined ? undefined : clamp(n, 1, 5);
  }
  if (v === undefined) return undefined;
  return INVERTED_KEYS.has(key) ? 6 - v : v;
}

/** Mean persona score on 1–5: per persona mean(appeal, adoption, willingnessToPay, 6 − friction), then averaged. */
export function personaScore(rec: Pick<Recommendation, 'personaFeedback'>): number | undefined {
  const per = (rec.personaFeedback ?? []).map((f) => {
    const s = f.scores;
    return (clamp(s.appeal, 1, 5) + clamp(s.adoption, 1, 5) + clamp(s.willingnessToPay, 1, 5) + (6 - clamp(s.friction, 1, 5))) / 4;
  });
  return per.length ? per.reduce((a, b) => a + b, 0) / per.length : undefined;
}

/**
 * Priority on 0–5 (2 decimals): weighted mean of the normalized evidence criteria
 * (Σ w·n / Σ w, default weight 1), with the simulated persona score added as one more term of
 * weight `personaWeight` (default 0 → persona feedback never moves priority).
 */
export function computePriority(rec: Pick<Recommendation, 'criteria' | 'personaFeedback'>, cfg: PriorityConfig): number {
  let num = 0;
  let den = 0;
  for (const key of RECOMMENDATION_KEYS) {
    const n = normalizeCriterion(key, rec.criteria[key]);
    const w = cfg.weights?.[key] ?? 1;
    if (n === undefined || !(w > 0)) continue;
    num += w * n;
    den += w;
  }
  const pw = cfg.personaWeight ?? 0;
  const p = pw > 0 ? personaScore(rec) : undefined;
  if (p !== undefined) {
    num += pw * p;
    den += pw;
  }
  return den > 0 ? round2(clamp(num / den, 0, 5)) : 0;
}

/** Recomputes and stores `priority` for every recommendation in the workspace. */
export function scoreRecommendations(workspaceId: string, deps: { store: Store; config: BifConfig }): Recommendation[] {
  const { store, config } = deps;
  return store.transaction(() =>
    store.recommendations
      .list({ workspaceId })
      .map((r) => store.recommendations.update(r.id, { priority: computePriority(r, config.scoring) })),
  );
}

/** Rejects criteria keys outside `CRITERIA.recommendation` (excluding `priority`, which is computed). */
function checkRecommendationCriteria(c: Criteria): string | undefined {
  const allowed = new Set<string>(RECOMMENDATION_KEYS);
  const unknown = Object.keys(c).filter((k) => !allowed.has(k));
  return unknown.length ? `unknown recommendation criteria: ${unknown.join(', ')} (allowed: ${[...allowed].join(', ')})` : undefined;
}

const fail = (error: string): ToolResult => ({ ok: false, error });

/** `save_recommendation` handler (synthesizer): validates findings + criteria, stores with computed priority. */
export function scoringToolHandlers(): Partial<Record<ToolName, ExtraToolHandler>> {
  return {
    async save_recommendation(ctx, raw, deps) {
      const input = raw as ToolInput<'save_recommendation'>;
      const { store, config, events } = deps;
      const missing = input.finding_ids.filter((id) => store.findings.get(id)?.workspaceId !== ctx.workspaceId);
      if (missing.length) return fail(`finding_ids reference unknown findings (not in this workspace): ${missing.join(', ')}`);
      const bad = checkRecommendationCriteria(input.criteria);
      if (bad) return fail(bad);
      // Idempotent per (task, title): a replay (or a revision re-saving it) updates the existing
      // recommendation instead of creating a duplicate.
      const replay = findReplay(store, ctx, 'save_recommendation', 'task', (p) => {
        const prior = store.recommendations.get(String(p.recommendationId));
        return !!prior && titleKey(prior.title) === titleKey(input.title);
      });
      if (replay) {
        const id = (replay.payload as { recommendationId: string }).recommendationId;
        const prior = store.recommendations.get(id)!;
        const next = { ...prior, summary: input.summary, criteria: input.criteria, findingIds: input.finding_ids };
        const priority = computePriority(next, config.scoring);
        store.recommendations.update(id, { summary: next.summary, criteria: next.criteria, findingIds: next.findingIds, priority });
        return { ok: true, data: { recommendationId: id, priority, duplicate: true } };
      }
      const rec: Recommendation = {
        id: newId('rec'),
        workspaceId: ctx.workspaceId,
        title: input.title,
        summary: input.summary,
        criteria: input.criteria,
        findingIds: input.finding_ids,
        personaFeedback: [],
        priority: 0,
        createdAt: new Date().toISOString(),
      };
      rec.priority = computePriority(rec, config.scoring);
      const payload: Record<string, unknown> = { tool: 'save_recommendation', recommendationId: rec.id, criteria: input.criteria, priority: rec.priority };
      if (input.priority !== undefined) payload.agentPriority = input.priority;
      const decision: Decision = {
        id: newId('dec'),
        workspaceId: ctx.workspaceId,
        agentRunId: ctx.agentRunId,
        role: ctx.role,
        model: ctx.model,
        kind: 'score',
        payload,
        refs: [...new Set([rec.id, ...input.finding_ids])],
        promptVersion: ctx.promptVersion,
        createdAt: new Date().toISOString(),
      };
      store.transaction(() => {
        store.recommendations.insert(rec);
        store.decisions.insert(decision);
      });
      events.emit({ type: 'decision', workspaceId: ctx.workspaceId, decision });
      return { ok: true, data: { recommendationId: rec.id, priority: rec.priority } };
    },
  };
}
