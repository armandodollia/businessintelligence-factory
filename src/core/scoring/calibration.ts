import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROLES, type BifConfig } from '../config/schema.js';
import { calibrationDir, type CalibrationScope } from '../prompts/index.js';
import type { Store } from '../store/db.js';
import type { Rating, Role, TaskType } from '../types.js';
import { rootOf } from '../workspace/tree.js';
import { RECOMMENDATION_KEYS, criterionDef, normalizedDelta, toNumber, type TargetType } from './criteria.js';
import { normalizeCriterion, personaScore } from './priority.js';
import { resolveTarget } from './ratings.js';
// Learning loop WP-A: feedback signals (include overrides, unit proposal decisions) count in calibration.
import { ratingsWithSignals, signalDelta } from '../feedback/signals.js';
import { lessonsAppendix, type LessonsTarget } from '../learning/lessons/appendix.js'; // learning loop WP-E
import { experimentTaskIds, isTaggedDecision, taggedRunIds } from '../learning/runTags.js'; // ruling R3

export type CalibrationRow = { targetType: TargetType; criterion: string; n: number; agreeRate: number; meanDelta: number };
/**
 * One (role, taskType, targetType, criterion) group (spec §10: disagreements per role / criterion /
 * task type). `taskType` is absent for values not produced by a research task (interview symptoms,
 * system decisions).
 */
export type CalibrationGroupRow = CalibrationRow & { role: Role | 'unknown'; taskType?: TaskType };
export type CalibrationReport = { byCriterion: CalibrationRow[]; byRoleTask: CalibrationGroupRow[] };

/**
 * Calibration scope (business tree root + data dir) of a workspace. `config` (or just the data dir):
 * with a config, `lessons.enabled: false` leaves the accepted lesson rules out (ruling R1); a bare data
 * dir (tests, read-only callers) keeps them. `target`: the task / run the prompt is built for, so the
 * stored lessons-off flag applies (wave-2 integration).
 */
export function calibrationScope(
  store: Store,
  config: string | Pick<BifConfig, 'dataDir' | 'lessons'>,
  workspaceId: string,
  target: LessonsTarget = {},
): CalibrationScope {
  const rootWorkspaceId = rootOf(store, workspaceId);
  const dataDir = typeof config === 'string' ? config : config.dataDir;
  // Read when the prompt is built, so a config change applies to the next prompt.
  const enabled = () => typeof config === 'string' || config.lessons?.enabled !== false;
  // Learning loop WP-E: the tree's accepted lesson rules are appended with the calibration appendix.
  return { dataDir, rootWorkspaceId, lessons: (name) => (enabled() ? lessonsAppendix(store, rootWorkspaceId, name, target) : '') };
}

export type PromptPatchExample = {
  criterion: string;
  agentValue: Rating['agentValue'];
  userValue: Rating['userValue'];
  reason: string | undefined;
};
export type PromptPatch = {
  role: Role;
  examples: PromptPatchExample[];
  patchText: string;
  /** WP-A: the rated items behind `examples` (privacy: export filtering of the applied patch). */
  sources?: Array<{ targetType: TargetType; targetId: string }>;
};

/** Minimum number of user priority overrides before weights are refit. */
export const MIN_WEIGHT_SAMPLES = 5;

const round = (v: number, d = 3) => Math.round(v * 10 ** d) / 10 ** d;

/**
 * Rating agreement per (targetType, criterion): `n` ratings, share that agreed, and `meanDelta` =
 * mean of `normalizedDelta` (user − agent as a signed fraction of the criterion's scale span: 1-5 →
 * /4, pct → fraction points, trend → /2, range → relative) over comparable ratings; an agree is 0.
 */
export function calibrationReport(workspaceId: string, deps: { store: Store }, opts: CalibrationOptions = {}): CalibrationReport {
  const { store } = deps;
  const ratings = calibrationRatings(store, workspaceId, opts);
  const byCriterion = groupRows(ratings, (r) => `${r.targetType}\u0000${r.criterion}`).map(({ first, rows }) =>
    summarize(first.targetType, first.criterion, rows),
  );
  byCriterion.sort((a, b) => a.targetType.localeCompare(b.targetType) || a.criterion.localeCompare(b.criterion));

  // Per role / task type that produced the rated value (spec §10).
  const runOf = judgingRuns(store, workspaceId);
  const origin = new Map<string, { role: Role | 'unknown'; taskType?: TaskType }>();
  const originOf = (r: Rating) => {
    const k = `${r.targetType}\u0000${r.targetId}\u0000${r.criterion}`;
    let o = origin.get(k);
    if (!o) {
      o = { role: resolveTarget(store, workspaceId, r.targetType, r.targetId, r.criterion)?.role ?? 'unknown' };
      const tt = taskTypeOf(store, workspaceId, r, runOf);
      if (tt) o.taskType = tt;
      origin.set(k, o);
    }
    return o;
  };
  const byRoleTask = groupRows(ratings, (r) => {
    const o = originOf(r);
    return `${o.role}\u0000${o.taskType ?? ''}\u0000${r.targetType}\u0000${r.criterion}`;
  }).map(({ first, rows }) => {
    const o = originOf(first);
    const row: CalibrationGroupRow = { role: o.role, ...summarize(first.targetType, first.criterion, rows) };
    if (o.taskType) row.taskType = o.taskType;
    return row;
  });
  byRoleTask.sort(
    (a, b) =>
      a.role.localeCompare(b.role) ||
      (a.taskType ?? '').localeCompare(b.taskType ?? '') ||
      a.targetType.localeCompare(b.targetType) ||
      a.criterion.localeCompare(b.criterion),
  );
  return { byCriterion, byRoleTask };
}

function groupRows(ratings: Rating[], keyOf: (r: Rating) => string): Array<{ first: Rating; rows: Rating[] }> {
  const groups = new Map<string, { first: Rating; rows: Rating[] }>();
  for (const r of ratings) {
    const key = keyOf(r);
    const g = groups.get(key);
    if (g) g.rows.push(r);
    else groups.set(key, { first: r, rows: [r] });
  }
  return [...groups.values()];
}

function summarize(targetType: TargetType, criterion: string, ratings: Rating[]): CalibrationRow {
  const def = criterionDef(targetType, criterion);
  const deltas: number[] = [];
  for (const r of ratings) {
    const d = def ? normalizedDelta(def, r.agentValue, r.verdict === 'agree' ? r.agentValue : r.userValue) : signalDelta(r);
    if (d !== undefined) deltas.push(d);
  }
  return {
    targetType,
    criterion,
    n: ratings.length,
    agreeRate: round(ratings.filter((r) => r.verdict === 'agree').length / ratings.length),
    meanDelta: deltas.length ? round(deltas.reduce((a, b) => a + b, 0) / deltas.length) : 0,
  };
}

// --- ruling R3 (wave 2): experiment and audit judgments stay out of calibration -------------------
export type CalibrationOptions = {
  /** Count ratings of experiment and reviewer-audit judgments too (default false). */
  includeExperiments?: boolean;
};

/**
 * The ratings calibration learns from (`ratingsWithSignals`), without ratings of experiment and
 * reviewer-audit judgments unless `includeExperiments` (ruling R3). A rating is such a judgment's when
 * the run it rated is tagged (WP-F `taggedRunIds`), when it rates a tagged decision, when the item it
 * rates was first judged by a tagged run, or when the item belongs to an experiment arm task. The
 * experiment's own arm comparison (`compareExperiment`) reads ratings directly and still counts them.
 */
export function calibrationRatings(store: Store, workspaceId: string, opts: CalibrationOptions = {}): Rating[] {
  const ratings = ratingsWithSignals(store, workspaceId);
  if (opts.includeExperiments) return ratings;
  const tagged = taggedRunIds(store);
  const armTasks = experimentTaskIds(store);
  if (!tagged.size && !armTasks.size) return ratings;
  const judgedBy = judgingRuns(store, workspaceId);
  const runTask = (runId: string | undefined) => (runId ? store.agentRuns.get(runId)?.taskId : undefined);
  const itemTask = (r: Rating): string | undefined => {
    switch (r.targetType) {
      case 'finding':
        return store.findings.get(r.targetId)?.taskId;
      case 'decision':
        return runTask(store.decisions.get(r.targetId)?.agentRunId);
      default:
        return runTask(judgedBy.get(r.targetId));
    }
  };
  return ratings.filter((r) => {
    if (r.agentRunId && tagged.has(r.agentRunId)) return false;
    if (r.targetType === 'decision' && isTaggedDecision(store, r.targetId)) return false;
    const judge = judgedBy.get(r.targetId);
    if (judge && tagged.has(judge)) return false;
    const task = itemTask(r);
    return !(task && armTasks.has(task));
  });
}
// --- end ruling R3 ---------------------------------------------------------------------------------

const SUBJECT_KEYS = ['findingId', 'symptomId', 'recommendationId', 'personaId', 'competitorId'] as const;

/** Item id → agent run of the first Decision that judged it (save_finding / save_persona / ...). */
function judgingRuns(store: Store, workspaceId: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const d of store.decisions.list({ workspaceId })) {
    const p = d.payload as Record<string, unknown> | null;
    if (!p || typeof p !== 'object') continue;
    for (const k of SUBJECT_KEYS) {
      const v = p[k];
      if (typeof v === 'string' && !out.has(v)) out.set(v, d.agentRunId);
    }
  }
  return out;
}

/** Task type of the research task whose run produced the rated value, if any. */
function taskTypeOf(store: Store, workspaceId: string, r: Rating, runOf: Map<string, string>): TaskType | undefined {
  const taskType = (taskId: string | undefined) => {
    const t = taskId ? store.tasks.get(taskId) : undefined;
    return t && t.workspaceId === workspaceId ? t.type : undefined;
  };
  const ofRun = (runId: string | undefined) => taskType(runId ? store.agentRuns.get(runId)?.taskId : undefined);
  switch (r.targetType) {
    case 'finding':
      return taskType(store.findings.get(r.targetId)?.taskId);
    case 'persona_feedback':
      return 'persona_panel';
    case 'decision':
      return ofRun(store.decisions.get(r.targetId)?.agentRunId);
    default:
      return ofRun(runOf.get(r.targetId));
  }
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
 * Proposes priority weights from the user's priority ratings (latest per recommendation: a
 * `disagree` contributes the user's value, an `agree` the agent's priority at rating time).
 *
 * Fits the complete configured formula `computePriority` uses —
 * priority = (Σ w·n + personaWeight·p) / (Σ w + personaWeight), the persona term (simulated
 * persona score p) present only when personaWeight > 0 and the recommendation has feedback, and
 * each sample's absent criteria skipped exactly as `computePriority` skips them — by least squares
 * over w ≥ 0 (projected gradient, two starts: current weights and the simplex fit on mean-imputed
 * criteria). personaWeight is the user's setting and is held fixed; it pins the weights' scale. When
 * no sample has a persona term only ratios matter and weights are reported with mean 1 over the
 * fitted criteria. Criteria no sample has keep their current weight. Returns the current weights
 * (default 1) when there are fewer than 5 samples. Proposal only — never applied here.
 */
export function proposeWeights(workspaceId: string, deps: { store: Store; config: BifConfig }): Record<string, number> {
  const { store, config } = deps;
  const current: Record<string, number> = { ...config.scoring.weights };
  for (const k of RECOMMENDATION_KEYS) current[k] = config.scoring.weights[k] ?? 1;

  // Samples: the latest priority rating per recommendation — a disagree gives the user's value, an
  // agree confirms the agent's priority at rating time (y = agentValue).
  const latest = new Map<string, number>();
  for (const r of store.ratings.list({ workspaceId, targetType: 'recommendation', criterion: 'priority' })) {
    const y = toNumber(r.verdict === 'agree' ? r.agentValue : r.userValue);
    if (y === undefined) continue;
    latest.delete(r.targetId); // keep insertion order = latest rating
    latest.set(r.targetId, y);
  }
  const samples = [...latest].flatMap(([id, y]) => {
    const rec = store.recommendations.get(id);
    return rec && rec.workspaceId === workspaceId ? [{ rec, y }] : [];
  });
  if (samples.length < MIN_WEIGHT_SAMPLES) return current;

  // Exact per-sample terms of computePriority: present (normalized) criteria + persona term.
  const pw = config.scoring.personaWeight ?? 0;
  const raw = samples.map((s) => RECOMMENDATION_KEYS.map((k) => normalizeCriterion(k, s.rec.criteria[k])));
  const cols = RECOMMENDATION_KEYS.map((key, j) => ({ key, j })).filter(({ j }) => raw.some((row) => row[j] !== undefined));
  if (!cols.length) return current;
  const rows: FitRow[] = samples.map((s, i) => {
    const p = pw > 0 ? personaScore(s.rec) : undefined;
    return {
      n: cols.map((c) => raw[i]![c.j]),
      c: p === undefined ? 0 : pw * p,
      d: p === undefined ? 0 : pw,
      y: s.y,
    };
  });
  const scaleFree = rows.every((r) => r.d === 0);

  // Two starts: the current weights, and the simplex fit on mean-imputed criteria (scaled to mean 1).
  const means = cols.map((_, j) => {
    const vals = rows.map((r) => r.n[j]).filter((v): v is number => v !== undefined);
    return vals.reduce((a, b) => a + b, 0) / vals.length;
  });
  const alpha = simplexLeastSquares(rows.map((r) => r.n.map((v, j) => v ?? means[j]!)), rows.map((r) => r.y));
  const starts = [cols.map((c) => current[c.key]!), alpha.map((a) => a * cols.length)];
  let best = starts.map((w0) => fitWeights(rows, w0)).sort((a, b) => a.loss - b.loss)[0]!.w;
  if (scaleFree) {
    const mean = best.reduce((a, b) => a + b, 0) / best.length;
    if (!(mean > 0)) return current;
    best = best.map((w) => w / mean);
  }
  const out = { ...current };
  cols.forEach((c, i) => (out[c.key] = Math.round(best[i]! * 1000) / 1000));
  return out;
}

/** One priority override: normalized criteria (undefined = absent), persona numerator/denominator terms, target. */
type FitRow = { n: Array<number | undefined>; c: number; d: number; y: number };

/** computePriority's formula (before clamping/rounding) for weights `w`. */
function predict(r: FitRow, w: number[]): { f: number; D: number } {
  let num = r.c;
  let D = r.d;
  r.n.forEach((v, j) => {
    if (v !== undefined) {
      num += w[j]! * v;
      D += w[j]!;
    }
  });
  return { f: D > 0 ? num / D : 0, D };
}

const lossOf = (rows: FitRow[], w: number[]) => rows.reduce((s, r) => s + (predict(r, w).f - r.y) ** 2, 0);

/**
 * Least squares of the exact priority formula f = (Σ w·n + pw·p) / (Σ w + pw) over w ≥ 0 (absent
 * criteria skipped per sample, as `computePriority` does), by projected gradient descent with
 * Armijo backtracking. ∂f/∂w_k = (n_k − f) / D for present k.
 */
function fitWeights(rows: FitRow[], w0: number[], iterations = 5000): { w: number[]; loss: number } {
  const MAX_W = 1000;
  let w = w0.map((v) => Math.min(MAX_W, Math.max(0, v)));
  let loss = lossOf(rows, w);
  let step = 1;
  for (let it = 0; it < iterations && loss > 1e-14; it++) {
    const g = new Array<number>(w.length).fill(0);
    for (const r of rows) {
      const { f, D } = predict(r, w);
      if (!(D > 0)) continue;
      r.n.forEach((v, j) => {
        if (v !== undefined) g[j]! += (2 * (f - r.y) * (v - f)) / D;
      });
    }
    let improved = false;
    for (let tries = 0; tries < 40; tries++) {
      const next = w.map((v, j) => Math.min(MAX_W, Math.max(0, v - step * g[j]!)));
      const nl = lossOf(rows, next);
      if (nl < loss) {
        const gain = loss - nl;
        w = next;
        loss = nl;
        step *= 2;
        improved = gain > 1e-15;
        break;
      }
      step /= 2;
    }
    if (!improved) break;
  }
  return { w, loss };
}

const fmt = (v: unknown) => (v === undefined || v === null ? '(none)' : typeof v === 'string' ? `"${v}"` : String(v));

/**
 * Builds a calibration patch for `role` from the user's 10 largest disagreements on values that
 * role produced (deltas normalized per scale so criteria are comparable), formatted as a few-shot
 * "Calibration examples" block. `patchText` is '' when there is nothing to calibrate.
 */
export function proposePromptPatch(workspaceId: string, role: Role, deps: { store: Store }, opts: CalibrationOptions = {}): PromptPatch {
  const { store } = deps;
  // The user's current view only: the latest rating per (target, criterion); if that is an agree,
  // the earlier disagreement no longer stands. `priority` is computed by the harness from weights,
  // not judged by the agent, so it is never a prompt example (it feeds proposeWeights instead).
  const latest = new Map<string, Rating>();
  for (const r of calibrationRatings(store, workspaceId, opts)) {
    if (r.targetType === 'recommendation' && r.criterion === 'priority') continue;
    const key = `${r.targetType}\u0000${r.targetId}\u0000${r.criterion}`;
    latest.delete(key);
    latest.set(key, r);
  }
  const items = [...latest.values()]
    .filter((r) => r.verdict === 'disagree')
    .flatMap((r) => {
      const target = resolveTarget(store, workspaceId, r.targetType, r.targetId, r.criterion);
      if (!target || target.role !== role) return [];
      const def = criterionDef(r.targetType, r.criterion);
      const d = def ? normalizedDelta(def, r.agentValue, r.userValue) : signalDelta(r);
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
  return { role, examples, patchText, sources: items.map(({ r }) => ({ targetType: r.targetType, targetId: r.targetId })) };
}

const EXAMPLE_LINE = /^\s*\d+\.\s+(.*\S)\s*$/;

/** Dedupe key of one example line: the item + criterion part (before "you said"), else the whole line. */
function exampleKey(text: string): string {
  const i = text.indexOf(': you said ');
  return (i > 0 ? text.slice(0, i) : text).trim().toLowerCase();
}

/** Numbered example lines (`1. ...`) of an appendix, without their numbers. */
function exampleLines(text: string): string[] {
  return text.split('\n').flatMap((l) => {
    const m = EXAMPLE_LINE.exec(l);
    return m ? [m[1]!] : [];
  });
}

/** Free text (headers / rubric clarifications) of an appendix: every non-example line. */
function proseOf(text: string): string {
  return text
    .split('\n')
    .filter((l) => !EXAMPLE_LINE.test(l))
    .join('\n')
    .trim();
}

/**
 * Merges an approved patch into an existing appendix: examples are appended, a newer example for
 * the same item + criterion replaces the older one (the user changed their mind), exact
 * duplicates are dropped, and examples are renumbered. Prose (header, rubric clarifications) of
 * the existing appendix is kept; prose of the patch is added when not already present.
 */
export function mergeCalibration(existing: string, patchText: string): string {
  if (!existing.trim()) return patchText;
  if (!patchText.trim()) return existing;
  const examples = new Map<string, string>();
  for (const line of [...exampleLines(existing), ...exampleLines(patchText)]) {
    const k = exampleKey(line);
    examples.delete(k);
    examples.set(k, line);
  }
  const prose = [proseOf(existing)];
  const extra = proseOf(patchText);
  if (extra && !prose[0]!.includes(extra)) prose.push(extra);
  const numbered = [...examples.values()].map((l, i) => `${i + 1}. ${l}`);
  return `${[prose.filter(Boolean).join('\n\n'), numbered.join('\n')].filter(Boolean).join('\n\n')}\n`;
}

/**
 * Merges the approved patch into `<dataDir>/<rootWorkspaceId>/calibration/<role>.md` of the
 * business tree in `scope` (`mergeCalibration`: append + dedupe, never overwrite), which
 * `loadPrompt(role, scope)` appends — so the prompt version of that business's runs changes and
 * other businesses are untouched. Call only on explicit user approval (API).
 */
export function applyPromptPatch(patch: PromptPatch, scope: CalibrationScope): { path: string; text: string } {
  if (!(ROLES as readonly string[]).includes(patch.role)) throw new Error(`unknown role '${patch.role}'`);
  const dir = calibrationDir(scope);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${patch.role}.md`);
  const text = mergeCalibration(existsSync(path) ? readFileSync(path, 'utf8') : '', patch.patchText);
  writeFileSync(path, text);
  return { path, text };
}

// --- learning loop WP-G: one rating's delta, by the same rule as `calibrationReport` -------------
/** Normalized user − agent delta of one rating (0 for an agree); undefined when not comparable. */
export function ratingDelta(r: Rating): number | undefined {
  const def = criterionDef(r.targetType, r.criterion);
  return def ? normalizedDelta(def, r.agentValue, r.verdict === 'agree' ? r.agentValue : r.userValue) : signalDelta(r);
}
// --- end WP-G -----------------------------------------------------------------------------------
