/**
 * Learning loop WP-G route: the metrics view of a business tree (`src/core/metrics/report.ts`).
 * Read-only. Mounted by `createApp` before the `/api/*` 404 fallback; `workspace` resolves an id or
 * throws the app's 404 error.
 *
 * The training-export exclusion summary is NOT part of this response: it runs the whole export, so
 * the metrics page asks `GET .../export/summary` only when the user requests it.
 */
import type { Hono } from 'hono';
import type { BifConfig } from '../core/config/schema.js';
import type { ArtifactStore } from '../core/evidence/artifacts.js';
import { METRICS_BUCKETS, METRICS_GROUP_BYS, metricsReport, type MetricsReportOptions } from '../core/metrics/report.js';
import type { Store } from '../core/store/db.js';
import type { Workspace } from '../core/types.js';

export type MetricsRouteDeps = { store: Store; config: BifConfig; artifacts: ArtifactStore };

const ISO = /^\d{4}-\d{2}-\d{2}(T[\d:.]+(Z|[+-]\d{2}:\d{2})?)?$/;

/** Query → report options, or the 400 message. */
export function metricsOptionsOf(workspaceId: string, q: (k: string) => string | undefined): MetricsReportOptions | string {
  const o: MetricsReportOptions = { workspaceId };
  const scope = q('scope');
  if (scope !== undefined && scope !== '') {
    if (scope !== 'tree' && scope !== 'node') return 'scope must be tree or node';
    o.scope = scope;
  }
  const groupBy = q('groupBy');
  if (groupBy !== undefined && groupBy !== '') {
    if (!(METRICS_GROUP_BYS as readonly string[]).includes(groupBy)) return `groupBy must be one of ${METRICS_GROUP_BYS.join(', ')}`;
    o.groupBy = groupBy as MetricsReportOptions['groupBy'] & string;
  }
  const bucket = q('bucket');
  if (bucket !== undefined && bucket !== '') {
    if (!(METRICS_BUCKETS as readonly string[]).includes(bucket)) return `bucket must be one of ${METRICS_BUCKETS.join(', ')}`;
    o.bucket = bucket as MetricsReportOptions['bucket'] & string;
  }
  for (const k of ['since', 'until'] as const) {
    const v = q(k);
    if (v === undefined || v === '') continue;
    if (!ISO.test(v) || Number.isNaN(Date.parse(v))) return `${k} must be an ISO date`;
    o[k] = v;
  }
  const inc = q('includeExperiments');
  if (inc !== undefined && inc !== '') {
    if (!['0', '1', 'true', 'false'].includes(inc)) return 'includeExperiments must be 1 or 0';
    o.includeExperiments = inc === '1' || inc === 'true';
  }
  return o;
}

export function mountMetricsRoutes(app: Hono, deps: MetricsRouteDeps, workspace: (id: string) => Workspace): void {
  const { store, config, artifacts } = deps;
  /**
   * Metrics over time and per group. Query: `scope` (tree | node), `since` / `until` (ISO),
   * `groupBy` (role | task_type | prompt_version | model), `bucket` (day | week),
   * `includeExperiments` (1 | 0, default 0).
   */
  app.get('/api/workspaces/:id/metrics', (c) => {
    const o = metricsOptionsOf(workspace(c.req.param('id')).id, (k) => c.req.query(k));
    if (typeof o === 'string') return c.json({ error: o }, 400);
    return c.json(metricsReport(store, { ...o, config, dataDir: artifacts.dataDir }));
  });
}
