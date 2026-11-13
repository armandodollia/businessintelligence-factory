import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROLES, type BifConfig } from '../config/schema.js';
import { calibrationDir } from '../prompts/index.js';
import type { Store } from '../store/db.js';
import type { Rating, Role } from '../types.js';
import { RECOMMENDATION_KEYS, criterionDef, normalizedDelta, toNumber, type TargetType } from './criteria.js';
import { normalizeCriterion } from './priority.js';
import { resolveTarget } from './ratings.js';

export type CalibrationRow = { targetType: TargetType; criterion: string; n: number; agreeRate: number; meanDelta: number };
export type CalibrationReport = { byCriterion: CalibrationRow[] };

export type PromptPatchExample = {
  criterion: string;
  agentValue: Rating['agentValue'];
  userValue: Rating['userValue'];
  reason: string | undefined;
};
export type PromptPatch = { role: Role; examples: PromptPatchExample[]; patchText: string };

/** Minimum number of user priority overrides before weights are refit. */
export const MIN_WEIGHT_SAMPLES = 5;

const round = (v: number, d = 3) => Math.round(v * 10 ** d) / 10 ** d;

/**
 * Rating agreement per (targetType, criterion): `n` ratings, share that agreed, and `meanDelta` =
 * mean of `normalizedDelta` (user − agent as a signed fraction of the criterion's scale span: 1-5 →
 * /4, pct → fraction points, trend → /2, range → relative) over comparable ratings; an agree is 0.
 */
export function calibrationReport(workspaceId: string, deps: { store: Store }): CalibrationReport {
  const groups = new Map<string, { targetType: TargetType; criterion: string; ratings: Rating[] }>();
  for (const r of deps.store.ratings.list({ workspaceId })) {
    const key = `${r.targetType}\u0000${r.criterion}`;
    let g = groups.get(key);
    if (!g) groups.set(key, (g = { targetType: r.targetType, criterion: r.criterion, ratings: [] }));
    g.ratings.push(r);
  }
  const byCriterion = [...groups.values()].map(({ targetType, criterion, ratings }) => {
    const def = criterionDef(targetType, criterion);
    const deltas: number[] = [];
    for (const r of ratings) {
      if (!def) continue;
      const d = normalizedDelta(def, r.agentValue, r.verdict === 'agree' ? r.agentValue : r.userValue);
      if (d !== undefined) deltas.push(d);
    }
    return {
      targetType,
      criterion,
      n: ratings.length,
      agreeRate: round(ratings.filter((r) => r.verdict === 'agree').length / ratings.length),
      meanDelta: deltas.length ? round(deltas.reduce((a, b) => a + b, 0) / deltas.length) : 0,
    };
  });
  byCriterion.sort((a, b) => a.targetType.localeCompare(b.targetType) || a.criterion.localeCompare(b.criterion));
  return { byCriterion };
}

/** Euclidean projection of `v` onto the probability simplex {a ≥ 0, Σa = 1} (Duchi et al. 2008). */
export function projectSimplex(v: number[]): number[] {
  const u = [...v].sort((a, b) => b - a);
  let css = 0;
  let theta = 0;
  for (let i = 0; i < u.length; i++) {
    css += u[i]!;
    const t = (css - 1) / (i + 1);
    if (u[i]! - t > 0) theta = t;
  }
  return v.map((x) => Math.max(0, x - theta));
}

/**
 * min ‖Xα − y‖² subject to α ≥ 0, Σα = 1, by projected gradient descent (step 1/L with
 * L = 2‖X‖²_F ≥ the gradient's Lipschitz constant). Convex, so it converges to the optimum.
 */
export function simplexLeastSquares(X: number[][], y: number[], iterations = 20_000): number[] {
  const k = X[0]?.length ?? 0;
  let a = new Array<number>(k).fill(1 / k);
  const L = 2 * X.reduce((s, row) => s + row.reduce((t, v) => t + v * v, 0), 0);
  if (!(L > 0)) return a;
  for (let it = 0; it < iterations; it++) {
    const r = X.map((row, i) => row.reduce((s, v, j) => s + v * a[j]!, 0) - y[i]!);
    const g = Array.from({ length: k }, (_, j) => 2 * X.reduce((s, row, i) => s + row[j]! * r[i]!, 0));
    const next = projectSimplex(a.map((v, j) => v - g[j]! / L));
    const moved = next.reduce((s, v, j) => s + Math.abs(v - a[j]!), 0);
    a = next;
    if (moved < 1e-12) break;
  }
  return a;
}

/**
 * Proposes priority weights from the user's priority overrides (ratings on recommendation
 * `priority` with verdict `disagree` and a numeric value; latest per recommendation).
 *
 * Fits the model `computePriority` actually uses — priority = Σ w·n / Σ w, i.e. a convex
 * combination Σ α·n with α = w / Σw (α ≥ 0, Σα = 1) — by simplex-constrained least squares on
 * the normalized criteria, then reports weights α·K (mean 1 over the K fitted criteria; only
 * ratios matter). Criteria a sample lacks are imputed with the column mean (exact when samples are
 * complete); criteria no sample has keep their current weight. Returns the current weights
 * (default 1) when there are fewer than 5 overrides. Proposal only — never applied here.
 */
export function proposeWeights(workspaceId: string, deps: { store: Store; config: BifConfig }): Record<string, number> {
  const { store, config } = deps;
  const current: Record<string, number> = { ...config.scoring.weights };
  for (const k of RECOMMENDATION_KEYS) current[k] = config.scoring.weights[k] ?? 1;

  const latest = new Map<string, number>();
  for (const r of store.ratings.list({ workspaceId, targetType: 'recommendation', criterion: 'priority', verdict: 'disagree' })) {
    const y = toNumber(r.userValue);
    if (y !== undefined) latest.set(r.targetId, y);
  }
  const samples = [...latest].flatMap(([id, y]) => {
    const rec = store.recommendations.get(id);
    return rec && rec.workspaceId === workspaceId ? [{ rec, y }] : [];
  });
  if (samples.length < MIN_WEIGHT_SAMPLES) return current;

  // Feature matrix; missing values imputed with the column mean; all-missing columns dropped.
  const raw = samples.map((s) => RECOMMENDATION_KEYS.map((k) => normalizeCriterion(k, s.rec.criteria[k])));
  const cols = RECOMMENDATION_KEYS.map((key, j) => {
    const vals = raw.map((row) => row[j]).filter((v): v is number => v !== undefined);
    return { key, j, mean: vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : undefined };
  }).filter((c): c is { key: (typeof RECOMMENDATION_KEYS)[number]; j: number; mean: number } => c.mean !== undefined);
  if (!cols.length) return current;
  const X = raw.map((row) => cols.map((c) => row[c.j] ?? c.mean));
  const y = samples.map((s) => s.y);

  const alpha = simplexLeastSquares(X, y);
  const out = { ...current };
  cols.forEach((c, i) => (out[c.key] = Math.round(alpha[i]! * cols.length * 1000) / 1000));
  return out;
}

const fmt = (v: unknown) => (v === undefined || v === null ? '(none)' : typeof v === 'string' ? `"${v}"` : String(v));

/**
 * Builds a calibration patch for `role` from the user's 10 largest disagreements on values that
 * role produced (deltas normalized per scale so criteria are comparable), formatted as a few-shot
 * "Calibration examples" block. `patchText` is '' when there is nothing to calibrate.
 */
export function proposePromptPatch(workspaceId: string, role: Role, deps: { store: Store }): PromptPatch {
  const { store } = deps;
  const items = store.ratings
    .list({ workspaceId, verdict: 'disagree' })
    .flatMap((r) => {
      const target = resolveTarget(store, workspaceId, r.targetType, r.targetId, r.criterion);
      if (!target || target.role !== role) return [];
      const def = criterionDef(r.targetType, r.criterion);
      const d = def ? normalizedDelta(def, r.agentValue, r.userValue) : undefined;
      return [{ r, title: target.title, mag: d === undefined ? 0 : Math.abs(d) }];
    })
    .sort((a, b) => b.mag - a.mag)
    .slice(0, 10);

  const examples: PromptPatchExample[] = items.map(({ r }) => ({
    criterion: r.criterion,
    agentValue: r.agentValue,
    userValue: r.userValue,
    reason: r.reason,
  }));
  const patchText = items.length
    ? [
        '## Calibration examples (approved by the user)',
        '',
        'The user corrected these past judgments of yours. Calibrate future values the same way;',
        'they are examples of the user\'s standards, not facts about the current business.',
        '',
        ...items.map(
          ({ r, title }, i) =>
            `${i + 1}. ${r.targetType} "${title}" — \`${r.criterion}\`: you said ${fmt(r.agentValue)}; the user says ${fmt(r.userValue)}.` +
            (r.reason ? ` Reason: ${r.reason}` : ''),
        ),
        '',
      ].join('\n')
    : '';
  return { role, examples, patchText };
}

/**
 * Writes the approved patch to `calibration/<role>.md`, which `loadPrompt(role)` appends (so the
 * prompt version changes). Replaces any previous appendix for the role. Call only on explicit
 * user approval (API).
 */
export function applyPromptPatch(patch: PromptPatch): { path: string } {
  if (!(ROLES as readonly string[]).includes(patch.role)) throw new Error(`unknown role '${patch.role}'`);
  const dir = calibrationDir();
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${patch.role}.md`);
  writeFileSync(path, patch.patchText);
  return { path };
}
