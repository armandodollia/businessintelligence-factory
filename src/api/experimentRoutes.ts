/**
 * Learning loop WP-F routes: reviewer audits (on demand and scheduled) and A/B experiments. Mounted by
 * `createApp` before the `/api/*` 404 fallback. The acting user is `config.user.id`, never the body.
 * Audits are per business tree: every route answers for the tree of the given workspace only.
 */
import type { Context, Hono } from 'hono';
import { z } from 'zod';
import type { BifConfig } from '../core/config/schema.js';
import { modelRefSchema } from '../core/config/schema.js';
import { actorOf } from '../core/feedback/events.js';
import { compareExperiment, ExperimentError, listExperiments, startExperiment } from '../core/learning/experiments.js';
import {
  AuditError,
  auditMisses,
  auditSummary,
  createAuditSchedule,
  getAuditSchedule,
  listAudits,
  listAuditSchedules,
  startReviewerAudit,
  updateAuditSchedule,
} from '../core/learning/reviewerAudit.js';
import type { ResearchDeps } from '../core/research/deps.js';
import type { Store } from '../core/store/db.js';
import type { Workspace } from '../core/types.js';
import { rootOf } from '../core/workspace/tree.js';

export type WpfRouteDeps = { store: Store; config: BifConfig; research: ResearchDeps };

const schemas = {
  audit: z.strictObject({
    n: z.number().int().min(1).max(50).optional(),
    taskIds: z.array(z.string().min(1)).min(1).max(50).optional(),
  }),
  schedule: z.strictObject({ cron: z.string().trim().min(1), n: z.number().int().min(1).max(50) }),
  schedulePatch: z.strictObject({
    enabled: z.boolean().optional(),
    cron: z.string().trim().min(1).optional(),
    n: z.number().int().min(1).max(50).optional(),
  }),
  experiment: z.strictObject({
    taskId: z.string().min(1),
    name: z.string().max(200).optional(),
    repeats: z.number().int().min(1).max(5).optional(),
    arms: z.tuple([
      z.strictObject({ model: modelRefSchema.optional(), promptVersion: z.string().min(1).optional(), promptText: z.string().optional() }),
      z.strictObject({ model: modelRefSchema.optional(), promptVersion: z.string().min(1).optional(), promptText: z.string().optional() }),
    ]),
    /** Ruling R4: explicit confirm that a browser task's real-world actions repeat per arm and repeat. */
    confirmBrowser: z.boolean().optional(),
  }),
};

async function body<T extends z.ZodType>(c: Context, schema: T): Promise<{ ok: true; data: z.infer<T> } | { ok: false; res: Response }> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    return { ok: false, res: c.json({ error: 'request body must be JSON' }, 400) };
  }
  const r = schema.safeParse(raw);
  if (!r.success) {
    const msg = r.error.issues.map((i) => `${i.path.length ? i.path.join('.') : '(body)'}: ${i.message}`).join('; ');
    return { ok: false, res: c.json({ error: msg }, 400) };
  }
  return { ok: true, data: r.data };
}

function fail(c: Context, e: unknown): Response {
  if (e instanceof AuditError || e instanceof ExperimentError) {
    return c.json({ error: e.message }, e.code === 'not_found' ? 404 : e.code === 'forbidden' ? 403 : 400);
  }
  throw e;
}

export function mountWpfRoutes(app: Hono, deps: WpfRouteDeps, workspace: (id: string) => Workspace): void {
  const { store, config, research } = deps;

  // --- reviewer audits ---------------------------------------------------------------------------
  /** Audits of the workspace's business tree (newest first), their summary and the tree's audit schedules. */
  app.get('/api/workspaces/:id/audits', (c) => {
    const root = rootOf(store, workspace(c.req.param('id')).id);
    const audits = listAudits(store, { rootWorkspaceId: root });
    return c.json({ rootWorkspaceId: root, summary: auditSummary(audits), audits: [...audits].reverse(), schedules: listAuditSchedules(store, root) });
  });

  /** Starts an audit of the N most recently verified tasks of the tree (or `taskIds`); runs in the background. */
  app.post('/api/workspaces/:id/audits', async (c) => {
    const id = workspace(c.req.param('id')).id;
    const b = await body(c, schemas.audit);
    if (!b.ok) return b.res;
    try {
      const started = startReviewerAudit(research, {
        workspaceId: id, startedBy: 'api', actor: actorOf(config),
        ...(b.data.n !== undefined ? { n: b.data.n } : {}), ...(b.data.taskIds ? { taskIds: b.data.taskIds } : {}),
      });
      started.done.catch((e: unknown) => console.error(`[bif] reviewer audit ${started.batchId} failed: ${(e as Error).message}`));
      return c.json({ batchId: started.batchId, audits: started.audits }, 202);
    } catch (e) {
      return fail(c, e);
    }
  });

  /** WP-E lesson signals of the tree: audits whose auditor failed a passing review. */
  app.get('/api/workspaces/:id/audit-misses', (c) => {
    const root = rootOf(store, workspace(c.req.param('id')).id);
    const since = c.req.query('since');
    return c.json(auditMisses(store, { rootWorkspaceId: root, ...(since ? { since } : {}) }));
  });

  app.post('/api/workspaces/:id/audit-schedules', async (c) => {
    const id = workspace(c.req.param('id')).id;
    const b = await body(c, schemas.schedule);
    if (!b.ok) return b.res;
    try {
      return c.json(createAuditSchedule(store, { workspaceId: id, cron: b.data.cron, n: b.data.n, actor: actorOf(config) }), 201);
    } catch (e) {
      return fail(c, e);
    }
  });

  app.post('/api/audit-schedules/:id', async (c) => {
    const b = await body(c, schemas.schedulePatch);
    if (!b.ok) return b.res;
    try {
      if (!getAuditSchedule(store, c.req.param('id'))) return c.json({ error: `audit schedule '${c.req.param('id')}' not found` }, 404);
      const patch: { enabled?: boolean; cron?: string; n?: number } = {};
      if (b.data.enabled !== undefined) patch.enabled = b.data.enabled;
      if (b.data.cron !== undefined) patch.cron = b.data.cron;
      if (b.data.n !== undefined) patch.n = b.data.n;
      return c.json(updateAuditSchedule(store, c.req.param('id'), patch));
    } catch (e) {
      return fail(c, e);
    }
  });

  // --- experiments -------------------------------------------------------------------------------
  app.get('/api/workspaces/:id/experiments', (c) => c.json(listExperiments(store, workspace(c.req.param('id')).id)));

  /** Starts an A/B experiment on a finished task of this workspace; runs in the background. */
  app.post('/api/workspaces/:id/experiments', async (c) => {
    const id = workspace(c.req.param('id')).id;
    const b = await body(c, schemas.experiment);
    if (!b.ok) return b.res;
    const task = store.tasks.get(b.data.taskId);
    if (!task || task.workspaceId !== id) return c.json({ error: `task '${b.data.taskId}' not found in this workspace` }, 404);
    const arm = (a: (typeof b.data.arms)[number]) => ({
      ...(a.model ? { model: a.model } : {}), ...(a.promptVersion ? { promptVersion: a.promptVersion } : {}),
      ...(a.promptText !== undefined ? { promptText: a.promptText } : {}),
    });
    try {
      const started = startExperiment(research, {
        taskId: task.id, arms: [arm(b.data.arms[0]), arm(b.data.arms[1])], actor: actorOf(config),
        ...(b.data.repeats !== undefined ? { repeats: b.data.repeats } : {}), ...(b.data.name ? { name: b.data.name } : {}),
        ...(b.data.confirmBrowser !== undefined ? { confirmBrowser: b.data.confirmBrowser } : {}),
      });
      started.done.catch((e: unknown) => console.error(`[bif] experiment ${started.experiment.id} failed: ${(e as Error).message}`));
      return c.json(started.experiment, 202);
    } catch (e) {
      return fail(c, e);
    }
  });

  /** An experiment with its per-arm comparison. */
  app.get('/api/experiments/:id', (c) => {
    const cmp = compareExperiment(store, c.req.param('id'));
    return cmp ? c.json(cmp) : c.json({ error: `experiment '${c.req.param('id')}' not found` }, 404);
  });
}
