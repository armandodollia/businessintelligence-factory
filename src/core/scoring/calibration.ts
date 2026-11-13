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
    const scale = criterionDef(targetType, criterion)?.scale;
    const deltas: number[] = [];
    for (const r of ratings) {
      if (!scale) continue;
      const d = normalizedDelta(scale, r.agentValue, r.verdict === 'agree' ? r.agentValue : r.userValue);
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

/** Solves A x = b (A square) by Gaussian elimination with partial pivoting; undefined if singular. */
function solve(A: number[][], b: number[]): number[] | undefined {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]!]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r]![c]!) > Math.abs(M[p]![c]!)) p = r;
    if (Math.abs(M[p]![c]!) < 1e-12) return undefined;
    [M[c], M[p]] = [M[p]!, M[c]!];
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r]![c]! / M[c]![c]!;
      for (let k = c; k <= n; k++) M[r]![k]! -= f * M[c]![k]!;
    }
  }
  return M.map((row, i) => row[n]! / row[i]!);
}

/**
 * Proposes priority weights from the user's priority overrides (ratings on recommendation
 * `priority` with verdict `disagree` and a numeric value; latest per recommendation): least
 * squares of the user's priority on the normalized criteria (small ridge, no intercept),
 * negatives clamped to 0, rescaled to mean 1. Returns the current weights (default 1) when there
 * are fewer than 5 overrides or the fit is degenerate. Proposal only — never applied here.
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

  const k = cols.length;
  const lambda = 1e-3;
  const XtX = Array.from({ length: k }, (_, a) =>
    Array.from({ length: k }, (_, b) => X.reduce((s, row) => s + row[a]! * row[b]!, 0) + (a === b ? lambda : 0)),
  );
  const Xty = Array.from({ length: k }, (_, a) => X.reduce((s, row, i) => s + row[a]! * y[i]!, 0));
  const beta = solve(XtX, Xty);
  if (!beta) return current;
  const clamped = beta.map((b) => Math.max(0, b));
  const sum = clamped.reduce((a, b) => a + b, 0);
  if (!(sum > 0)) return current;
  const out = { ...current };
  cols.forEach((c, i) => (out[c.key] = Math.round((clamped[i]! * k * 100) / sum) / 100));
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
      const d = def ? normalizedDelta(def.scale, r.agentValue, r.userValue) : undefined;
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
