import type { Hono } from 'hono';
import { treeWorkspaceIds } from '../core/evidence/synthesis.js';
import { outcomeReport } from '../core/learning/outcomes.js';
import type { Store } from '../core/store/db.js';
import type { Workspace } from '../core/types.js';

/**
 * Learning loop WP-C routes. Mounted by `createApp` before the `/api/*` 404 fallback; `workspace`
 * resolves an id or throws the app's 404 error.
 */
export function mountOutcomeRoutes(app: Hono, deps: { store: Store }, workspace: (id: string) => Workspace): void {
  const { store } = deps;
  /**
   * Outcomes report: counts of each decision-outcome label per role / task type / prompt version.
   * `?scope=tree`: every node of the workspace's business tree (never another tree).
   */
  app.get('/api/workspaces/:id/outcomes', (c) => {
    const id = workspace(c.req.param('id')).id;
    const ids = c.req.query('scope') === 'tree' ? treeWorkspaceIds(store, id) : [id];
    return c.json(outcomeReport(store, ids));
  });
}
