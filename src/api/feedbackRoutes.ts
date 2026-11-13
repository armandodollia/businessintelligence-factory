/**
 * Learning loop WP-A routes: the feedback log, symptom hypothesis corrections / include overrides and
 * direct profile edits. Every action records a feedback event; the actor comes from
 * `config.user.id` (never from the request body).
 */
import type { Context, Hono } from 'hono';
import { z } from 'zod';
import type { BifConfig } from '../core/config/schema.js';
import { correctHypothesis, editProfile, setIncludeOverride } from '../core/feedback/actions.js';
import { FEEDBACK_KINDS, actorOf, listFeedback, type FeedbackFilter, type FeedbackTargetType } from '../core/feedback/events.js';
import type { Store } from '../core/store/db.js';

const TARGET_TYPES = [
  'finding', 'recommendation', 'persona', 'competitor', 'hypothesis', 'profile', 'unit_proposal', 'user_request', 'scoring_weights', 'prompt',
  'entity', 'artifact', // knowledge store KS-3 / KS-7
] as const satisfies readonly FeedbackTargetType[];

const schemas = {
  include: z.object({ include: z.boolean().nullable(), reason: z.string().optional() }),
  correctHypothesis: z
    .object({
      hypothesis: z.string().optional(),
      confidence: z.number().min(0).max(100).optional(),
      reason: z.string().optional(),
    })
    .refine((v) => v.hypothesis !== undefined || v.confidence !== undefined, 'give a hypothesis text and/or a confidence'),
  profile: z.object({ patch: z.record(z.string(), z.unknown()), reason: z.string().optional() }),
};

class BadRequest extends Error {}

async function body<T extends z.ZodType>(c: Context, schema: T): Promise<z.infer<T>> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw new BadRequest('request body must be JSON');
  }
  const r = schema.safeParse(raw);
  if (!r.success) throw new BadRequest(r.error.issues.map((i) => `${i.path.map(String).join('.') || '<body>'}: ${i.message}`).join('; '));
  return r.data;
}

/** Mounts the WP-A routes. Call before the `/api/*` 404 fallback. */
export function mountFeedbackRoutes(app: Hono, deps: { store: Store; config: BifConfig }): void {
  const { store, config } = deps;
  const wrap =
    (fn: (c: Context) => Promise<Response> | Response) =>
    async (c: Context): Promise<Response> => {
      try {
        return await fn(c);
      } catch (e) {
        if (e instanceof BadRequest) return c.json({ error: e.message }, 400);
        throw e;
      }
    };

  /** Feedback events of a workspace, oldest first; filters `kind`, `targetType`, `targetId`. */
  app.get(
    '/api/workspaces/:id/feedback',
    wrap((c) => {
      const id = c.req.param('id')!;
      if (!store.workspaces.get(id)) return c.json({ error: `workspace '${id}' not found` }, 404);
      const filter: FeedbackFilter = { workspaceId: id };
      const kind = c.req.query('kind');
      if (kind) {
        if (!(FEEDBACK_KINDS as readonly string[]).includes(kind)) throw new BadRequest(`unknown feedback kind '${kind}'`);
        filter.kind = kind as FeedbackFilter['kind'];
      }
      const targetType = c.req.query('targetType');
      if (targetType) {
        if (!(TARGET_TYPES as readonly string[]).includes(targetType)) throw new BadRequest(`unknown target type '${targetType}'`);
        filter.targetType = targetType as FeedbackTargetType;
      }
      const targetId = c.req.query('targetId');
      if (targetId) filter.targetId = targetId;
      return c.json(listFeedback(store, filter));
    }),
  );

  /** Include override for a symptom hypothesis (interviewer drill-down); `null` resets to verified-only. */
  app.post(
    '/api/hypotheses/:id/include',
    wrap(async (c) => {
      const id = c.req.param('id')!;
      const { include, reason } = await body(c, schemas.include);
      return c.json(setIncludeOverride(store, 'hypothesis', id, include, { actor: actorOf(config), ...(reason ? { reason } : {}) }));
    }),
  );

  /** The user's correction of a symptom hypothesis (text and/or confidence 0–100). */
  app.post(
    '/api/hypotheses/:id/correct',
    wrap(async (c) => {
      const id = c.req.param('id')!;
      const { reason, ...input } = await body(c, schemas.correctHypothesis);
      const correction = Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined));
      return c.json(correctHypothesis(store, id, correction, { actor: actorOf(config), ...(reason ? { reason } : {}) }));
    }),
  );

  /** Direct profile edit (JSON merge patch; `uploads` is app-managed). */
  app.patch(
    '/api/workspaces/:id/profile',
    wrap(async (c) => {
      const id = c.req.param('id')!;
      const { patch, reason } = await body(c, schemas.profile);
      return c.json(editProfile(store, id, patch, { actor: actorOf(config), ...(reason ? { reason } : {}) }));
    }),
  );
}
