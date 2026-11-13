/**
 * Metrics view (learning loop WP-G): review pass rate, rounds to pass, failures, cost, rating
 * agreement and decision-outcome labels over time and per role / task type / prompt version / model,
 * plus the knowledge-store metrics, for ONE business tree (or one node of it). Read-only; nothing is
 * stored (no migration).
 *
 * Public API: `metricsReport(store, options)`; `bucketOf(iso, bucket)`.
 *
 * Every figure uses the definition of its source module, applied per item so it can be windowed and
 * bucketed:
 * - runs, failures: `agent_runs` (status, `failure_reason`) and `agent_run_attempts`;
 * - pass rate, first-round pass rate, mean rounds: as `promptVersionMetrics` — a finished task
 *   (verified / unverified / failed) counts for its first worker run; rounds of verified + unverified;
 * - review issues: non-synthetic `review_issues`, by the worker run whose deliverable drew them;
 * - cost, tokens: `agent_usage` per run (`usageByRun`, same sums as `usageTotals` / `costReport`);
 * - rating agreement: the ratings `calibrationReport` uses (`ratingsWithSignals`), delta by
 *   `ratingDelta`, attributed to the producing run by `originRunOfRating`;
 * - outcome labels: `listOutcomes` (what `outcomeReport` counts);
 * - knowledge: `knowledgeMetrics` as is (human reads stay apart in `knowledge.retrieval.user`), its
 *   retrieval groups re-summed by the chosen dimension.
 *
 * Time: every item is placed at the start of the agent run that did the work (a task: its first
 * worker run; a rating / outcome / issue: the run that produced the judged value), else at its own
 * time. `since` / `until` (inclusive, ISO) and the buckets use that time; buckets are UTC days or
 * ISO weeks (key = the Monday). Knowledge figures use their own windows (retrieval time).
 *
 * Experiments and audits (WP-F): tagged runs (`experimentRunFilter`: experiment arm and reviewer-audit
 * runs) — and every item attributed to them — are left out unless `includeExperiments`. Knowledge figures are not filtered by experiment.
 */
import type { BifConfig } from '../config/schema.js';
import { treeWorkspaceIds } from '../evidence/synthesis.js';
import { ratingsWithSignals } from '../feedback/signals.js';
import { knowledgeMetrics, type KnowledgeMetrics, type RetrievalGroup } from '../knowledge/metrics.js';
import { listOutcomes } from '../learning/outcomes.js';
import { learningRepos } from '../learning/store.js';
import { OUTCOME_LABELS, type OutcomeLabel } from '../learning/types.js';
import { ratingDelta } from '../scoring/calibration.js';
import type { Store } from '../store/db.js';
import type { AgentRun, Task } from '../types.js';
import { rootOf } from '../workspace/tree.js';
import { experimentRunFilter } from './experimentFilter.js';
import { originRunOfRating, ratingOriginIndex } from './promptMetrics.js';
import { usageByRun } from './usage.js';

export const METRICS_GROUP_BYS = ['role', 'task_type', 'prompt_version', 'model'] as const;
export type MetricsGroupBy = (typeof METRICS_GROUP_BYS)[number];
export const METRICS_BUCKETS = ['day', 'week'] as const;
export type MetricsBucket = (typeof METRICS_BUCKETS)[number];

export type MetricsReportOptions = {
  /** Any node of the business tree. */
  workspaceId: string;
  /** `tree` (default): every node of its business tree; `node`: that workspace alone. */
  scope?: 'node' | 'tree';
  /** Inclusive ISO bounds on the time of the work (see module doc). */
  since?: string;
  until?: string;
  /** Dimension of `groups` / `groupSeries` (default `role`). */
  groupBy?: MetricsGroupBy;
  /** Series bucket (default `day`). */
  bucket?: MetricsBucket;
  /** Count experiment and audit runs too (default false: production trend only). */
  includeExperiments?: boolean;
  /** Predicate override (tests); default `experimentRunFilter(store)` (WP-F tags). */
  isExperimentRun?: (run: AgentRun) => boolean;
  /** Passed to `knowledgeMetrics`. */
  config?: Pick<BifConfig, 'knowledge'>;
  dataDir?: string;
  now?: Date;
};

export type MetricsRow = {
  runs: number;
  failedRuns: number;
  /** failedRuns / runs; null without runs. */
  failureRate: number | null;
  /** `agent_run_attempts` rows, and how many were rate limited. */
  attempts: number;
  rateLimitedAttempts: number;
  /** Finished tasks (verified / unverified / failed). */
  tasks: number;
  verified: number;
  unverified: number;
  failed: number;
  passRate: number | null;
  firstRoundPassRate: number | null;
  /** Mean review rounds of verified + unverified tasks. */
  meanRounds: number | null;
  /** Non-synthetic review issues raised. */
  reviewIssues: number;
  ratings: number;
  agrees: number;
  agreeRate: number | null;
  /** Mean normalized user − agent delta (agree = 0). */
  meanDelta: number | null;
  costUsd: number;
  totalTokens: number;
  outcomes: number;
  outcomeCounts: Partial<Record<OutcomeLabel, number>>;
};

export type MetricsGroupRow = MetricsRow & { key: string; firstSeen: string | null; lastSeen: string | null };
export type MetricsPoint = MetricsRow & { bucket: string };

export type MetricsKnowledgeGroup = {
  key: string;
  runs: number;
  retrievals: number;
  withUse: number;
  hitRate: number | null;
  searches: number;
  zeroResultSearches: number;
  zeroResultRate: number | null;
  retrievedTokens: number;
  retrievedTokensPerRun: number | null;
};

// --- WP-E slot: lessons effect per prompt version (integration fills this) -------------------------
/**
 * Lessons effect per prompt version (WP-E lessons engine). `null` until integration wires WP-E's
 * per-version lesson figures in (`metricsReport` sets `lessons`); the web view has the matching slot.
 */
export type MetricsLessonsSlot = null;
// --- end WP-E slot ---------------------------------------------------------------------------------

export type MetricsReport = {
  rootWorkspaceId: string;
  workspaceIds: string[];
  scope: 'node' | 'tree';
  window: { since: string | null; until: string | null };
  groupBy: MetricsGroupBy;
  bucket: MetricsBucket;
  experiments: { included: boolean; excludedRuns: number };
  totals: MetricsRow;
  groups: MetricsGroupRow[];
  /** Every bucket from the first to the last with data (gaps filled with empty rows). */
  series: MetricsPoint[];
  /** Per group, on the same buckets as `series`. */
  groupSeries: Array<{ key: string; points: MetricsPoint[] }>;
  failuresByReason: Array<{ reason: string; runs: number }>;
  reviewIssuesByClass: Array<{ class: string; issues: number; tasks: number }>;
  outcomeLabels: OutcomeLabel[];
  knowledge: {
    store: KnowledgeMetrics['store'];
    freshness: KnowledgeMetrics['freshness'];
    retrieval: Omit<KnowledgeMetrics['retrieval'], 'byTool' | 'byGroup'>;
    /** Share of agent input tokens that was retrieved knowledge. */
    retrievedShare: number | null;
    byGroup: MetricsKnowledgeGroup[];
  };
  lessons: MetricsLessonsSlot;
};

const FINAL = new Set(['verified', 'unverified', 'failed']);
const DAY_MS = 86_400_000;
/** Gap filling stops beyond this many buckets (only buckets with data are listed then). */
const MAX_FILLED_BUCKETS = 731;
const UNKNOWN = '(unknown)';
const NONE = '(none)';

const ratio = (n: number, d: number): number | null => (d > 0 ? Math.round((n / d) * 1000) / 1000 : null);
const mean = (xs: number[]): number | null => (xs.length ? Math.round((xs.reduce((s, x) => s + x, 0) / xs.length) * 1000) / 1000 : null);

/** UTC day (`YYYY-MM-DD`) or ISO week (its Monday) of an ISO time; null when unparsable. */
export function bucketOf(iso: string, bucket: MetricsBucket): string | null {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return null;
  const day = Math.floor(ms / DAY_MS) * DAY_MS;
  if (bucket === 'day') return new Date(day).toISOString().slice(0, 10);
  const dow = (new Date(day).getUTCDay() + 6) % 7; // Monday = 0
  return new Date(day - dow * DAY_MS).toISOString().slice(0, 10);
}

class Acc {
  runs = 0;
  failedRuns = 0;
  attempts = 0;
  rateLimited = 0;
  tasks = 0;
  verified = 0;
  unverified = 0;
  failed = 0;
  firstRound = 0;
  rounds: number[] = [];
  issues = 0;
  ratings = 0;
  agrees = 0;
  deltas: number[] = [];
  cost = 0;
  tokens = 0;
  outcomes = 0;
  counts: Partial<Record<OutcomeLabel, number>> = {};
  first: string | null = null;
  last: string | null = null;

  seen(iso: string): void {
    if (Number.isNaN(Date.parse(iso))) return;
    if (this.first === null || iso < this.first) this.first = iso;
    if (this.last === null || iso > this.last) this.last = iso;
  }

  row(): MetricsRow {
    return {
      runs: this.runs,
      failedRuns: this.failedRuns,
      failureRate: ratio(this.failedRuns, this.runs),
      attempts: this.attempts,
      rateLimitedAttempts: this.rateLimited,
      tasks: this.tasks,
      verified: this.verified,
      unverified: this.unverified,
      failed: this.failed,
      passRate: ratio(this.verified, this.tasks),
      firstRoundPassRate: ratio(this.firstRound, this.tasks),
      meanRounds: mean(this.rounds),
      reviewIssues: this.issues,
      ratings: this.ratings,
      agrees: this.agrees,
      agreeRate: ratio(this.agrees, this.ratings),
      meanDelta: mean(this.deltas),
      costUsd: Math.round(this.cost * 1e6) / 1e6,
      totalTokens: this.tokens,
      outcomes: this.outcomes,
      outcomeCounts: { ...this.counts },
    };
  }
}

/** What an item is grouped by (from the run that did the work, when known). */
type Attr = { role: string; taskType: string | null; promptVersion: string | null; model: string | null };

function keyOf(a: Attr | null, groupBy: MetricsGroupBy): string {
  if (!a) return UNKNOWN;
  switch (groupBy) {
    case 'role':
      return a.role;
    case 'task_type':
      return a.taskType ?? NONE;
    case 'prompt_version':
      // Like `costReport.byPromptVersion`: a prompt version belongs to one role.
      return `${a.role}:${a.promptVersion ?? NONE}`;
    case 'model':
      return a.model ?? UNKNOWN;
  }
}

function bucketList(present: Iterable<string>, bucket: MetricsBucket): string[] {
  const keys = [...new Set(present)].sort();
  if (keys.length < 2) return keys;
  const step = bucket === 'day' ? DAY_MS : 7 * DAY_MS;
  const from = Date.parse(`${keys[0]}T00:00:00.000Z`);
  const to = Date.parse(`${keys.at(-1)}T00:00:00.000Z`);
  if ((to - from) / step + 1 > MAX_FILLED_BUCKETS) return keys;
  const out: string[] = [];
  for (let t = from; t <= to; t += step) out.push(new Date(t).toISOString().slice(0, 10));
  return out;
}

function windowMs(v: string | undefined, name: string): number | null {
  if (v === undefined || v === '') return null;
  const ms = Date.parse(v);
  if (Number.isNaN(ms)) throw new RangeError(`${name} must be an ISO date`);
  return ms;
}

/** Metrics of one business tree (or node) over time and per group; see module doc. */
export function metricsReport(store: Store, opts: MetricsReportOptions): MetricsReport {
  const scope = opts.scope ?? 'tree';
  const groupBy = opts.groupBy ?? 'role';
  const bucket = opts.bucket ?? 'day';
  const includeExperiments = opts.includeExperiments === true;
  const isExperiment = opts.isExperimentRun ?? experimentRunFilter(store);
  const sinceMs = windowMs(opts.since, 'since');
  const untilMs = windowMs(opts.until, 'until');
  const ids = scope === 'node' ? [opts.workspaceId] : treeWorkspaceIds(store, opts.workspaceId);
  const root = store.workspaces.get(opts.workspaceId) ? rootOf(store, opts.workspaceId) : opts.workspaceId;

  // --- runs, the experiment filter, attribution -------------------------------------------------
  const allRuns = ids.flatMap((id) => store.agentRuns.list({ workspaceId: id }));
  const excluded = new Set(includeExperiments ? [] : allRuns.filter(isExperiment).map((r) => r.id));
  const runById = new Map(allRuns.filter((r) => !excluded.has(r.id)).map((r) => [r.id, r]));
  const tasks = new Map<string, Task>(ids.flatMap((id) => store.tasks.list({ workspaceId: id })).map((t) => [t.id, t]));
  const attrOf = (run: AgentRun): Attr => ({
    role: run.role,
    taskType: run.taskType ?? (run.taskId ? tasks.get(run.taskId)?.type : undefined) ?? null,
    promptVersion: run.promptVersion ?? null,
    model: `${run.model.provider}/${run.model.model}`,
  });
  // First worker (non-reviewer) run of each task, by start time — experiment runs included, so a
  // task an experiment started is attributed to (and filtered with) that run.
  const firstWorker = new Map<string, AgentRun>();
  for (const run of [...allRuns].sort((a, b) => a.startedAt.localeCompare(b.startedAt))) {
    if (run.taskId && run.role !== 'reviewer' && !firstWorker.has(run.taskId)) firstWorker.set(run.taskId, run);
  }

  // --- accumulation -------------------------------------------------------------------------------
  const totals = new Acc();
  const groups = new Map<string, Acc>();
  const buckets = new Map<string, Acc>();
  const groupBuckets = new Map<string, Map<string, Acc>>();
  const inWindow = (iso: string): boolean => {
    if (sinceMs === null && untilMs === null) return true;
    const ms = Date.parse(iso);
    if (Number.isNaN(ms)) return false;
    return (sinceMs === null || ms >= sinceMs) && (untilMs === null || ms <= untilMs);
  };
  const add = (iso: string, attr: Attr | null, f: (a: Acc) => void): boolean => {
    if (!inWindow(iso)) return false;
    const key = keyOf(attr, groupBy);
    let g = groups.get(key);
    if (!g) groups.set(key, (g = new Acc()));
    const b = bucketOf(iso, bucket);
    const targets = [totals, g];
    if (b) {
      let p = buckets.get(b);
      if (!p) buckets.set(b, (p = new Acc()));
      let gb = groupBuckets.get(key);
      if (!gb) groupBuckets.set(key, (gb = new Map()));
      let gp = gb.get(b);
      if (!gp) gb.set(b, (gp = new Acc()));
      targets.push(p, gp);
    }
    g.seen(iso);
    for (const a of targets) f(a);
    return true;
  };

  // Runs, attempts, failures.
  const attempts = new Map<string, { n: number; rl: number }>();
  for (const row of store.db
    .prepare(
      `SELECT run_id AS runId, COUNT(*) AS n, COALESCE(SUM(rate_limited), 0) AS rl FROM agent_run_attempts
       WHERE workspace_id IN (${ids.map(() => '?').join(', ')}) GROUP BY run_id`,
    )
    .all(...ids) as Array<{ runId: string; n: number; rl: number }>) {
    attempts.set(row.runId, { n: Number(row.n), rl: Number(row.rl) });
  }
  const failures = new Map<string, number>();
  for (const run of runById.values()) {
    const at = attempts.get(run.id);
    const counted = add(run.startedAt, attrOf(run), (a) => {
      a.runs++;
      if (run.status === 'failed') a.failedRuns++;
      a.attempts += at?.n ?? 0;
      a.rateLimited += at?.rl ?? 0;
    });
    if (counted && run.status === 'failed') {
      const reason = run.failureReason ?? '(no reason recorded)';
      failures.set(reason, (failures.get(reason) ?? 0) + 1);
    }
  }

  // Tasks: review outcome by the first worker run.
  for (const t of tasks.values()) {
    if (!FINAL.has(t.status)) continue;
    const run = firstWorker.get(t.id);
    if (run && excluded.has(run.id)) continue;
    const attr: Attr = run ? attrOf(run) : { role: UNKNOWN, taskType: t.type, promptVersion: null, model: null };
    add(run?.startedAt ?? t.createdAt, attr, (a) => {
      a.tasks++;
      if (t.status === 'verified') {
        a.verified++;
        if (t.round === 1) a.firstRound++;
      } else if (t.status === 'unverified') a.unverified++;
      else a.failed++;
      if (t.status !== 'failed') a.rounds.push(t.round);
    });
  }

  // Review issues (reviewer judgments only), by the worker run whose deliverable drew them.
  const issueClasses = new Map<string, { issues: number; tasks: Set<string> }>();
  for (const id of ids) {
    for (const i of learningRepos(store).reviewIssues.list({ workspaceId: id })) {
      if (i.synthetic) continue;
      const runId = i.workerRunId ?? firstWorker.get(i.taskId)?.id;
      if (runId && excluded.has(runId)) continue;
      const run = runId ? runById.get(runId) : undefined;
      if (!add(run?.startedAt ?? i.createdAt, run ? attrOf(run) : null, (a) => a.issues++)) continue;
      let c = issueClasses.get(i.class);
      if (!c) issueClasses.set(i.class, (c = { issues: 0, tasks: new Set() }));
      c.issues++;
      c.tasks.add(i.taskId);
    }
  }

  // Rating agreement, by the run that produced the rated value.
  for (const id of ids) {
    const index = ratingOriginIndex(store, id);
    for (const r of ratingsWithSignals(store, id)) {
      const own = (r as { agentRunId?: unknown }).agentRunId;
      if (typeof own === 'string' && excluded.has(own)) continue;
      const run = originRunOfRating(store, id, r, index);
      if (run && excluded.has(run.id)) continue;
      const d = ratingDelta(r);
      add(run?.startedAt ?? r.createdAt, run ? attrOf(run) : null, (a) => {
        a.ratings++;
        if (r.verdict === 'agree') a.agrees++;
        if (d !== undefined) a.deltas.push(d);
      });
    }
  }

  // Outcome labels (grouped like `outcomeReport`: the outcome's own role / task type / version).
  for (const o of listOutcomes(store, { workspaceIds: ids })) {
    if (o.runId && excluded.has(o.runId)) continue;
    const run = o.runId ? runById.get(o.runId) : undefined;
    const ra = run ? attrOf(run) : null;
    const attr: Attr | null =
      o.role || ra
        ? { role: o.role ?? ra?.role ?? UNKNOWN, taskType: o.taskType ?? ra?.taskType ?? null, promptVersion: o.promptVersion ?? ra?.promptVersion ?? null, model: ra?.model ?? null }
        : null;
    add(run?.startedAt ?? o.createdAt, attr, (a) => {
      a.outcomes++;
      a.counts[o.label] = (a.counts[o.label] ?? 0) + 1;
    });
  }

  // Cost and tokens per run (grouped like `costReport`: the usage row's own role / model / version).
  for (const u of usageByRun(store, ids)) {
    if (excluded.has(u.runId)) continue;
    const run = runById.get(u.runId);
    const attr: Attr = {
      role: u.role,
      taskType: run ? attrOf(run).taskType : null,
      promptVersion: u.promptVersion,
      model: `${u.provider}/${u.model}`,
    };
    add(run?.startedAt ?? u.firstAt, attr, (a) => {
      a.cost += u.costUsd;
      a.tokens += u.totalTokens;
    });
  }

  // --- knowledge (KS-6) -----------------------------------------------------------------------------
  const km = knowledgeMetrics(store, {
    workspaceId: opts.workspaceId,
    scope,
    ...(opts.since ? { since: opts.since } : {}),
    ...(opts.until ? { until: opts.until } : {}),
    ...(opts.config ? { config: opts.config } : {}),
    ...(opts.dataDir ? { dataDir: opts.dataDir } : {}),
    ...(opts.now ? { now: opts.now } : {}),
  });
  const { byTool: _byTool, byGroup, ...retrieval } = km.retrieval;
  void _byTool;

  // --- output ---------------------------------------------------------------------------------------
  const bucketKeys = bucketList(buckets.keys(), bucket);
  const pointsOf = (m: Map<string, Acc> | undefined): MetricsPoint[] =>
    bucketKeys.map((b) => ({ bucket: b, ...(m?.get(b) ?? new Acc()).row() }));
  const groupRows: MetricsGroupRow[] = [...groups.entries()].map(([key, a]) => ({ key, firstSeen: a.first, lastSeen: a.last, ...a.row() }));
  groupRows.sort((x, y) =>
    groupBy === 'prompt_version'
      ? x.key.split(':')[0]!.localeCompare(y.key.split(':')[0]!) || (x.firstSeen ?? '').localeCompare(y.firstSeen ?? '') || x.key.localeCompare(y.key)
      : x.key.localeCompare(y.key),
  );

  return {
    rootWorkspaceId: root,
    workspaceIds: ids,
    scope,
    window: { since: opts.since || null, until: opts.until || null },
    groupBy,
    bucket,
    experiments: { included: includeExperiments, excludedRuns: excluded.size },
    totals: totals.row(),
    groups: groupRows,
    series: pointsOf(buckets),
    groupSeries: groupRows.map((g) => ({ key: g.key, points: pointsOf(groupBuckets.get(g.key)) })),
    failuresByReason: [...failures.entries()]
      .map(([reason, runs]) => ({ reason, runs }))
      .sort((a, b) => b.runs - a.runs || a.reason.localeCompare(b.reason)),
    reviewIssuesByClass: [...issueClasses.entries()]
      .map(([cls, c]) => ({ class: cls, issues: c.issues, tasks: c.tasks.size }))
      .sort((a, b) => b.issues - a.issues || a.class.localeCompare(b.class)),
    outcomeLabels: [...OUTCOME_LABELS],
    knowledge: {
      store: km.store,
      freshness: km.freshness,
      retrieval,
      retrievedShare: km.usage.total.retrievedShare,
      byGroup: knowledgeGroups(byGroup, groupBy),
    },
    // --- WP-E slot: lessons effect per prompt version ---
    lessons: null,
    // --- end WP-E slot ---
  };
}

/** `knowledgeMetrics` retrieval groups re-summed by the chosen dimension (groups partition runs). */
function knowledgeGroups(rows: RetrievalGroup[], groupBy: MetricsGroupBy): MetricsKnowledgeGroup[] {
  const by = new Map<string, MetricsKnowledgeGroup>();
  for (const r of rows) {
    const key = keyOf({ role: r.role, taskType: r.taskType, promptVersion: r.promptVersion, model: r.model }, groupBy);
    let g = by.get(key);
    if (!g) {
      g = { key, runs: 0, retrievals: 0, withUse: 0, hitRate: null, searches: 0, zeroResultSearches: 0, zeroResultRate: null, retrievedTokens: 0, retrievedTokensPerRun: null };
      by.set(key, g);
    }
    g.runs += r.runs;
    g.retrievals += r.retrievals;
    g.withUse += r.withUse;
    g.searches += r.searches;
    g.zeroResultSearches += r.zeroResultSearches;
    g.retrievedTokens += r.retrievedTokens;
  }
  return [...by.values()]
    .map((g) => ({
      ...g,
      hitRate: ratio(g.withUse, g.retrievals),
      zeroResultRate: ratio(g.zeroResultSearches, g.searches),
      retrievedTokensPerRun: g.runs ? Math.round(g.retrievedTokens / g.runs) : null,
    }))
    .sort((a, b) => a.key.localeCompare(b.key));
}
