import type { BifConfig } from '../config/schema.js';
import type { ExtraToolHandler, ToolResult } from '../harness/tools/handlers.js';
import { findReplay, titleKey } from '../harness/tools/idempotency.js';
import type { ToolInput, ToolName } from '../harness/tools/registry.js';
import type { Store } from '../store/db.js';
import { newId } from '../store/repos.js';
import type { RunContext } from '../harness/tokens.js';
import type { Criteria, Decision, Recommendation } from '../types.js';
import { CRITERIA, INVERTED_KEYS, RECOMMENDATION_KEYS, pctFraction, toNumber } from './criteria.js';

export type PriorityConfig = { weights?: Record<string, number>; personaWeight?: number };

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const round2 = (v: number) => Math.round(v * 100) / 100;

const LEVELS: Record<string, number> = { 'very low': 1, low: 2, medium: 3, moderate: 3, high: 4, 'very high': 5 };

const SUFFIX: Record<string, number> = { k: 1e3, m: 1e6, mm: 1e6, b: 1e9, bn: 1e9 };

/**
 * Money amount → cost score on 1–5, log scale: ≤ $1k → 1, $10k → 2, $100k → 3, $1M → 4,
 * ≥ $10M → 5 (score = clamp(log10(amount) − 2, 1, 5); currency is ignored).
 */
export function costAmountScore(amount: number): number {
  return amount <= 1000 ? 1 : clamp(Math.log10(amount) - 2, 1, 5);
}

/** Units that make a "cost" not money (effort / time / headcount); such values are rejected. */
const NON_MONEY_UNITS =
  /\b(?:months?|mos?|weeks?|wks?|days?|hours?|hrs?|h|years?|yrs?|quarters?|sprints?|ftes?|people|persons?|person-\w+|man-\w+|engineers?|devs?|developers?|headcount|hc|points?|story\s*points?)\b/;

/** Human-readable list of accepted cost formats (tool schema + synthesizer prompt). */
export const COST_FORMATS =
  'a 1–5 score (5 = most expensive), a level word (very low|low|medium|high|very high), or a money ' +
  'amount/range: "$250k", "$10k–$50k", "$1M–$5M", "$1-5M", "$2 million", "2 million USD", "€500k–€1M", ' +
  '"EUR 40,000". Currency symbols $ € £ or codes USD/EUR/GBP; k/M/B or thousand/million/billion. ' +
  'Effort or time units (months, weeks, hours, FTE, people…) are NOT costs — use timeToValue/difficulty.';

/**
 * Cost (`range` scale) → 1–5 score where higher = more expensive (inverted later):
 * - a level word: very low 1, low 2, medium/moderate 3, high 4, very high 5;
 * - a plain number or plain range within 1–5 with no money marker ("3", "2-3"): a score;
 * - otherwise a money amount or range (money markers: $ € £, USD/EUR/GBP, k/M/MM/B/bn,
 *   thousand/million/billion; e.g. "$10–$50", "10k-50k", "$1M–$5M", "$1-5M", "$2 million",
 *   "2 million USD", "€500k–€1M", 250000): the arithmetic midpoint (a multiplier on the upper bound
 *   also applies to a bare lower bound), scored with `costAmountScore`.
 * Undefined when unparseable or when it carries a non-money unit (months, weeks, hours, FTE…).
 */
export function costScore(v: unknown): number | undefined {
  if (typeof v === 'number') {
    if (!Number.isFinite(v) || v < 0) return undefined;
    return v >= 1 && v <= 5 ? v : costAmountScore(v);
  }
  if (typeof v !== 'string') return undefined;
  const raw = v.trim().toLowerCase();
  if (LEVELS[raw] !== undefined) return LEVELS[raw];
  if (NON_MONEY_UNITS.test(raw)) return undefined;
  const iso = /\b(?:usd|eur|gbp)\b/.test(raw);
  const s = raw
    .replace(/,/g, '')
    .replace(/\b(?:usd|eur|gbp)\b/g, ' ')
    .replace(/\s*\bthousand\b/g, 'k')
    .replace(/\s*\bmillions?\b/g, 'm')
    .replace(/\s*\bbillions?\b/g, 'b');
  const re = /([$€£])?\s*(\d+(?:\.\d+)?)\s*(mm|bn|k|m|b)?(?![a-z])/g;
  const tokens = [...s.matchAll(re)].slice(0, 2);
  if (!tokens.length) return undefined;
  const money = iso || /[$€£]/.test(s) || tokens.some((t) => t[3]);
  const last = tokens.at(-1)![3];
  const values = tokens.map((t) => Number(t[2]) * (SUFFIX[t[3] ?? last ?? ''] ?? 1));
  const mid = values.reduce((a, b) => a + b, 0) / values.length;
  if (!money) return mid >= 1 && mid <= 5 ? mid : costAmountScore(mid);
  return costAmountScore(mid);
}

/**
 * A recommendation criterion normalized to 0–5 where higher is better (difficulty, cost, risk and
 * timeToValue inverted as 6 − v). `pct` criteria use their declared unit (recommendation
 * `confidence` is a percent 0–100 → v/100·5). Undefined when missing or unparseable; such criteria
 * are left out of the weighted mean.
 */
export function normalizeCriterion(key: string, value: unknown): number | undefined {
  const def = CRITERIA.recommendation.find((c) => c.key === key);
  if (!def || value === undefined || value === null) return undefined;
  let v: number | undefined;
  if (def.scale === 'pct') {
    const n = toNumber(value);
    return n === undefined ? undefined : pctFraction(n, def.unit) * 5;
  }
  if (def.scale === 'range') v = costScore(value);
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

/**
 * Validates recommendation criteria: keys among the 8 evidence criteria (`priority` is computed);
 * 1-5 keys numbers in 1–5; `confidence` a percent 0–100; `cost` parseable by `costScore`.
 */
export function checkRecommendationCriteria(c: Criteria): string | undefined {
  const allowed = new Set<string>(RECOMMENDATION_KEYS);
  const unknown = Object.keys(c).filter((k) => !allowed.has(k));
  if (unknown.length) return `unknown recommendation criteria: ${unknown.join(', ')} (allowed: ${[...allowed].join(', ')})`;
  for (const [k, v] of Object.entries(c)) {
    const def = CRITERIA.recommendation.find((d) => d.key === k)!;
    const n = toNumber(v);
    if (def.scale === 'pct') {
      const max = def.unit === 'fraction' ? 1 : 100;
      if (n === undefined || n < 0 || n > max) return `criteria.${k} must be a ${def.unit === 'fraction' ? 'fraction 0–1' : 'percent 0–100'}`;
    }
    if (def.scale === '1-5' && (n === undefined || n < 1 || n > 5)) return `criteria.${k} must be a number 1–5`;
    if (def.scale === 'range' && costScore(v) === undefined) return `criteria.${k} must be ${COST_FORMATS}`;
  }
  return undefined;
}

const fail = (error: string): ToolResult => ({ ok: false, error });

/** JSON with sorted object keys (order-insensitive equality of criteria). */
function stableJson(v: unknown): string {
  return JSON.stringify(v, (_k, x: unknown) =>
    x && typeof x === 'object' && !Array.isArray(x)
      ? Object.fromEntries(Object.entries(x as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)))
      : x,
  );
}

function scoreDecision(ctx: RunContext, payload: Record<string, unknown>, refs: string[]): Decision {
  return {
    id: newId('dec'),
    workspaceId: ctx.workspaceId,
    agentRunId: ctx.agentRunId,
    role: ctx.role,
    model: ctx.model,
    kind: 'score',
    payload,
    refs: [...new Set(refs)],
    promptVersion: ctx.promptVersion,
    createdAt: new Date().toISOString(),
  };
}

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
        const changed =
          prior.summary !== next.summary ||
          stableJson(prior.criteria) !== stableJson(next.criteria) ||
          stableJson([...prior.findingIds].sort()) !== stableJson([...next.findingIds].sort());
        if (!changed) {
          // Identical replay: nothing new was judged — no second Decision.
          store.recommendations.update(id, { priority });
          return { ok: true, data: { recommendationId: id, priority, duplicate: true } };
        }
        // A revision is a new judgment: record a new score Decision (ratings made after it join it).
        const previous = store.decisions
          .list({ workspaceId: ctx.workspaceId, kind: 'score' })
          .filter((d) => (d.payload as { tool?: string; recommendationId?: string } | null)?.recommendationId === id)
          .at(-1);
        const payload: Record<string, unknown> = {
          tool: 'save_recommendation', recommendationId: id, criteria: input.criteria, priority, revisionOf: previous?.id ?? replay.id,
        };
        if (input.priority !== undefined) payload.agentPriority = input.priority;
        const decision = scoreDecision(ctx, payload, [id, ...input.finding_ids]);
        store.transaction(() => {
          store.recommendations.update(id, { summary: next.summary, criteria: next.criteria, findingIds: next.findingIds, priority });
          store.decisions.insert(decision);
        });
        events.emit({ type: 'decision', workspaceId: ctx.workspaceId, decision });
        return { ok: true, data: { recommendationId: id, priority, duplicate: true, revised: true } };
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
      const decision = scoreDecision(ctx, payload, [rec.id, ...input.finding_ids]);
      store.transaction(() => {
        store.recommendations.insert(rec);
        store.decisions.insert(decision);
      });
      events.emit({ type: 'decision', workspaceId: ctx.workspaceId, decision });
      return { ok: true, data: { recommendationId: rec.id, priority: rec.priority } };
    },
  };
}
