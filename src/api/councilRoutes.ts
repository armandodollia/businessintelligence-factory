/**
 * Review council routes (design 2026-11-16-review-council-design.md §9). Read-only. Mounted by `createApp`
 * before the `/api/*` 404 fallback; `workspace` resolves an id or throws the app's 404 error.
 *
 * - `GET /api/workspaces/:id/tasks/:taskId/council`: the council table of a task, asked from a node of
 *   its business tree: the rules of its stage and every recorded round (members with score and state,
 *   issues with who raised them, dropped issues, questions, follow-ups). `{ rounds: [] }` for a task no
 *   council reviewed. Tree-checked like every route under a workspace: a task of another business tree
 *   answers exactly like an unknown one (404, same body). There is no variant without the node.
 *   Private research (stakeholder design §7): the rounds of a withheld task are served as withheld
 *   (round, Decision id and time only), like its other Decisions.
 * - `GET /api/council`: the configured council for the settings page (defaults applied, each member
 *   available or not and why, the stages); `{ council: null }` when none is configured.
 */
import type { Hono } from 'hono';
import type { BifConfig } from '../core/config/schema.js';
import { councilFor, councilOverview } from '../core/council/settings.js';
import { councilView } from '../core/council/store.js';
import { withholding } from '../core/stakeholders/withheld.js';
import type { Store } from '../core/store/db.js';
import type { Workspace } from '../core/types.js';
import { sameTree } from '../core/workspace/tree.js';

export function mountCouncilRoutes(app: Hono, deps: { store: Store; config: BifConfig }, workspace: (id: string) => Workspace): void {
  const { store, config } = deps;

  app.get('/api/workspaces/:id/tasks/:taskId/council', (c) => {
    const from = workspace(c.req.param('id')).id;
    const taskId = c.req.param('taskId');
    const task = store.tasks.get(taskId);
    if (!task || !sameTree(store, from, task.workspaceId)) return c.json({ error: `task '${taskId}' not found` }, 404);
    return c.json(councilView(store, task, councilFor(config, task.type), withholding(store).task(task)));
  });

  app.get('/api/council', (c) => c.json({ council: councilOverview(config) ?? null }));
}
