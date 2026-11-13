/**
 * Knowledge store KS-6 routes: knowledge-store metrics and the WP-E learning signals of a business
 * tree (design §13; `src/core/knowledge/metrics.ts`). Read-only. Mounted by `createApp` before the
 * `/api/*` 404 fallback; `workspace` resolves an id or throws the app's 404 error.
 */
import type { Hono } from 'hono';
import type { BifConfig } from '../core/config/schema.js';
import type { ArtifactStore } from '../core/evidence/artifacts.js';
import { knowledgeMetrics, knowledgeSignals, type KnowledgeMetricsFilter } from '../core/knowledge/metrics.js';
import type { Store } from '../core/store/db.js';
import type { Workspace } from '../core/types.js';

export type KnowledgeMetricsRouteDeps = { store: Store; config: BifConfig; artifacts: ArtifactStore };

const ISO = /^\d{4}-\d{2}-\d{2}(T[\d:.]+(Z|[+-]\d{2}:\d{2})?)?$/;

export function mountKnowledgeMetricsRoutes(app: Hono, deps: KnowledgeMetricsRouteDeps, workspace: (id: string) => Workspace): void {
  const { store, config, artifacts } = deps;
  /** `?scope=node` (default tree), `?since=` / `?until=` (ISO); 400 on a malformed value. */
  const filterOf = (id: string, q: (k: string) => string | undefined): KnowledgeMetricsFilter | string => {
    const scope = q('scope');
    if (scope !== undefined && scope !== 'tree' && scope !== 'node') return `scope must be tree or node`;
    const f: KnowledgeMetricsFilter = { workspaceId: workspace(id).id, config };
    if (scope) f.scope = scope;
    for (const k of ['since', 'until'] as const) {
      const v = q(k);
      if (v === undefined || v === '') continue;
      if (!ISO.test(v) || Number.isNaN(Date.parse(v))) return `${k} must be an ISO date`;
      f[k] = v;
    }
    return f;
  };

  /** Store size, freshness, retrieval, usage join and signals (one business tree, or one node). */
  app.get('/api/workspaces/:id/knowledge/metrics', (c) => {
    const f = filterOf(c.req.param('id'), (k) => c.req.query(k));
    if (typeof f === 'string') return c.json({ error: f }, 400);
    return c.json(knowledgeMetrics(store, { ...f, dataDir: artifacts.dataDir }));
  });

  /** The WP-E machine signals only. */
  app.get('/api/workspaces/:id/knowledge/signals', (c) => {
    const f = filterOf(c.req.param('id'), (k) => c.req.query(k));
    if (typeof f === 'string') return c.json({ error: f }, 400);
    return c.json(knowledgeSignals(store, f));
  });
}
