/**
 * Learning loop WP-G: metrics view logic — the report types (mirror of `src/core/metrics/report.ts`),
 * the filter and its query, value formatting, line-chart geometry for inline SVG, and the hooks.
 * Views use only these; the API client is `metricsApi` in `api.ts`.
 */
import { useCallback, useMemo, useState } from 'react';
import { api, metricsApi } from './api.js';
import { exportSummaryView, type ExportSummaryView } from './exportSummary.js';
import { useBusEvents, useResource } from './hooks.js';
import { formatRate, formatTokens, formatUsd } from './usage.js';

// ---------------------------------------------------------------------------
// report types

export type MetricsGroupBy = 'role' | 'task_type' | 'prompt_version' | 'model';
export type MetricsBucket = 'day' | 'week';
export type MetricsScope = 'tree' | 'node';

export type MetricsRow = {
  runs: number;
  failedRuns: number;
  failureRate: number | null;
  attempts: number;
  rateLimitedAttempts: number;
  tasks: number;
  verified: number;
  unverified: number;
  failed: number;
  passRate: number | null;
  firstRoundPassRate: number | null;
  meanRounds: number | null;
  reviewIssues: number;
  ratings: number;
  agrees: number;
  agreeRate: number | null;
  meanDelta: number | null;
  costUsd: number;
  totalTokens: number;
  outcomes: number;
  outcomeCounts: Partial<Record<string, number>>;
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

export type MetricsReport = {
  rootWorkspaceId: string;
  workspaceIds: string[];
  scope: MetricsScope;
  window: { since: string | null; until: string | null };
  groupBy: MetricsGroupBy;
  bucket: MetricsBucket;
  experiments: { included: boolean; excludedRuns: number };
  totals: MetricsRow;
  groups: MetricsGroupRow[];
  series: MetricsPoint[];
  groupSeries: Array<{ key: string; points: MetricsPoint[] }>;
  failuresByReason: Array<{ reason: string; runs: number }>;
  reviewIssuesByClass: Array<{ class: string; issues: number; tasks: number }>;
  outcomeLabels: string[];
  knowledge: {
    store: {
      facts: { candidate: number; current: number; replaced: number; retracted: number; total: number };
      observations: number;
      artifacts: number;
      imagesWithoutDescription: number;
      chunks: number;
      textChars: number;
      fileBytes: number | null;
      entities: number;
      relations: number;
    };
    freshness: { currentFacts: number; stale: number; staleShare: number | null };
    retrieval: {
      retrievals: number;
      user: { reads: number; searches: number; zeroResultSearches: number; tokensReturned: number };
      runs: number;
      withUse: number;
      hitRate: number | null;
      searches: number;
      zeroResultSearches: number;
      zeroResultRate: number | null;
      retrievedTokens: number;
      usedTokens: number;
    };
    retrievedShare: number | null;
    byGroup: MetricsKnowledgeGroup[];
  };
  // --- WP-E slot: lessons effect per prompt version (integration types this) ---
  lessons: unknown;
  // --- end WP-E slot ---
};

// ---------------------------------------------------------------------------
// filter

export type MetricsFilter = {
  scope: MetricsScope;
  groupBy: MetricsGroupBy;
  bucket: MetricsBucket;
  /** `YYYY-MM-DD` (date input) or ''. */
  since: string;
  until: string;
  includeExperiments: boolean;
};

export const DEFAULT_METRICS_FILTER: MetricsFilter = { scope: 'tree', groupBy: 'role', bucket: 'day', since: '', until: '', includeExperiments: false };

export const GROUP_BY_OPTIONS: ReadonlyArray<{ value: MetricsGroupBy; label: string }> = [
  { value: 'role', label: 'Role' },
  { value: 'task_type', label: 'Task type' },
  { value: 'prompt_version', label: 'Prompt version' },
  { value: 'model', label: 'Model' },
];

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/** Query string of the metrics route. A date-only `until` covers its whole day (UTC). */
export function metricsQuery(f: MetricsFilter): string {
  const q = new URLSearchParams({ scope: f.scope, groupBy: f.groupBy, bucket: f.bucket });
  if (f.since) q.set('since', DATE_ONLY.test(f.since) ? `${f.since}T00:00:00.000Z` : f.since);
  if (f.until) q.set('until', DATE_ONLY.test(f.until) ? `${f.until}T23:59:59.999Z` : f.until);
  if (f.includeExperiments) q.set('includeExperiments', '1');
  return q.toString();
}

// ---------------------------------------------------------------------------
// formatting and the charted metrics

export type MetricKind = 'rate' | 'usd' | 'rounds' | 'count';

export function formatMetric(v: number | null | undefined, kind: MetricKind): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  switch (kind) {
    case 'rate':
      return formatRate(v);
    case 'usd':
      return formatUsd(v);
    case 'rounds':
      return v.toFixed(1);
    case 'count':
      return formatTokens(v);
  }
}

export type ChartedMetric = { id: keyof MetricsRow; label: string; kind: MetricKind; note: string };

/** The time-series charts, in display order (one single-series chart each). */
export const CHARTED_METRICS: readonly ChartedMetric[] = [
  { id: 'passRate', label: 'Review pass rate', kind: 'rate', note: 'verified / finished tasks' },
  { id: 'firstRoundPassRate', label: 'First-round pass rate', kind: 'rate', note: 'verified in round 1 / finished tasks' },
  { id: 'meanRounds', label: 'Rounds to pass', kind: 'rounds', note: 'mean review rounds of verified + unverified tasks' },
  { id: 'failureRate', label: 'Run failure rate', kind: 'rate', note: 'failed / agent runs' },
  { id: 'costUsd', label: 'Cost', kind: 'usd', note: 'agent usage, computed or CLI-reported price' },
  { id: 'agreeRate', label: 'Rating agreement', kind: 'rate', note: 'your ratings that agreed with the agent' },
];

// ---------------------------------------------------------------------------
// chart geometry (inline SVG; no chart library)

export type ChartDot = { x: number; y: number; bucket: string; value: number };
export type ChartGeometry = { path: string; dots: ChartDot[]; yMax: number };

const r3 = (v: number) => Math.round(v * 1000) / 1000;

/**
 * Line geometry of one series: x spread evenly over the buckets (a single bucket is centred), y from
 * 0 (bottom) to `yMax` (top) — 1 for rates, else the series max. A null value is a gap in the line.
 */
export function chartGeometry(
  points: ReadonlyArray<{ bucket: string; value: number | null }>,
  kind: MetricKind,
  box: { width: number; height: number; pad: number },
): ChartGeometry {
  const values = points.map((p) => p.value).filter((v): v is number => v !== null && Number.isFinite(v));
  const yMax = kind === 'rate' ? 1 : Math.max(0, ...values) || 1;
  const w = box.width - 2 * box.pad;
  const h = box.height - 2 * box.pad;
  const n = points.length;
  const xOf = (i: number) => r3(box.pad + (n === 1 ? w / 2 : (i * w) / (n - 1)));
  const yOf = (v: number) => r3(box.pad + (1 - Math.min(v, yMax) / yMax) * h);
  const dots: ChartDot[] = [];
  const parts: string[] = [];
  let pen = false;
  points.forEach((p, i) => {
    if (p.value === null || !Number.isFinite(p.value)) {
      pen = false;
      return;
    }
    const d = { x: xOf(i), y: yOf(p.value), bucket: p.bucket, value: p.value };
    dots.push(d);
    parts.push(`${pen ? 'L' : 'M'}${d.x} ${d.y}`);
    pen = true;
  });
  return { path: parts.join(' '), dots, yMax };
}

/** One metric of the series as chart points (`costUsd` of an empty bucket is 0, rates are null). */
export function seriesOf(points: readonly MetricsPoint[], id: keyof MetricsRow): Array<{ bucket: string; value: number | null }> {
  return points.map((p) => {
    const v = p[id];
    return { bucket: p.bucket, value: typeof v === 'number' ? v : null };
  });
}

/** Outcome-label columns that have at least one count (in the report's label order). */
export function outcomeColumns(r: Pick<MetricsReport, 'outcomeLabels' | 'groups'>): string[] {
  return r.outcomeLabels.filter((l) => r.groups.some((g) => (g.outcomeCounts[l] ?? 0) > 0));
}

// ---------------------------------------------------------------------------
// hooks

/** The metrics report with its filter; reloads when a run finishes. */
export function useMetrics(wsId: string | null | undefined) {
  const [filter, setFilterState] = useState<MetricsFilter>(DEFAULT_METRICS_FILTER);
  const query = metricsQuery(filter);
  const res = useResource(`metrics:${wsId ?? ''}:${query}`, wsId ? () => metricsApi.getMetrics(wsId, query) : null);
  useBusEvents(wsId, (e) => {
    if (e.type === 'run_status' && e.status !== 'running') void res.reload();
  });
  const setFilter = useCallback((patch: Partial<MetricsFilter>) => setFilterState((f) => ({ ...f, ...patch })), []);
  return { filter, setFilter, report: res.data ?? null, loading: res.loading, error: res.error, reload: res.reload };
}

/**
 * The training-export exclusion summary, fetched ONLY on `compute()`: the route runs the whole export,
 * so the metrics page never loads it on open (integration note on the Decision log's cost).
 */
export function useExportSummaryOnDemand(wsId: string | null | undefined) {
  const [state, setState] = useState<{ wsId: string; data: unknown } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ wsId: string; message: string } | null>(null);
  const compute = useCallback(async () => {
    if (!wsId) return;
    const owner = wsId;
    setBusy(true);
    setError(null);
    try {
      setState({ wsId: owner, data: await api.exportSummary(owner) });
    } catch (e) {
      setError({ wsId: owner, message: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  }, [wsId]);
  const data = state && state.wsId === wsId ? state.data : undefined;
  const view: ExportSummaryView | null = useMemo(() => (data === undefined ? null : exportSummaryView(data)), [data]);
  return { view, compute, busy, error: error && error.wsId === wsId ? error.message : null };
}
