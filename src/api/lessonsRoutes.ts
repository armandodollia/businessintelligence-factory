/**
 * Learning loop WP-E routes: the lessons page (proposals, rules with their per-version effect, retros)
 * and the user's decisions. Everything is keyed by the caller's business tree (`rootOf`): a proposal or
 * rule of another tree answers 404 like an unknown id. The actor comes from `config.user.id`, never
 * from the request body.
 */
import type { Context, Hono } from 'hono';
import { z } from 'zod';
import type { BifConfig } from '../core/config/schema.js';
import type { EventBus } from '../core/events.js';
import {
  acceptLessonProposalAsUser, evaluateLessonsAsUser, FeedbackActionError, proposeRuleRetirementAsUser, rejectLessonProposalAsUser, runRetroAsUser,
} from '../core/feedback/actions.js';
import { actorOf } from '../core/feedback/events.js';
import { activeRules } from '../core/learning/lessons/appendix.js';
import { rulesWithEffect } from '../core/learning/lessons/engine.js';
import { nextRetroAt } from '../core/learning/lessons/retro.js';
import { lessonsSettings } from '../core/learning/lessons/settings.js';
import { lessonRepos } from '../core/learning/lessons/store.js';
import type { ResearchDeps } from '../core/research/deps.js';
import type { Store } from '../core/store/db.js';
import { ROLES } from '../core/config/schema.js';
import { rootOf } from '../core/workspace/tree.js';

export type LessonsRouteDeps = { store: Store; config: BifConfig; events: EventBus; research: ResearchDeps };

const decisionBody = z.object({ reason: z.string().max(2000).optional() });

class BadRequest extends Error {}
class NotFound extends Error {}

/** Decided proposals listed on the page (newest first). */
const DECIDED_LIMIT = 50;
const RETRO_LIMIT = 10;

/** Mounts the WP-E routes. Call before the `/api/*` 404 fallback. */
export function mountLessonsRoutes(app: Hono, deps: LessonsRouteDeps): void {
  const { store, config, events, research } = deps;
  const base = '/api/workspaces/:id/lessons';

  const wrap =
    (fn: (c: Context) => Promise<Response> | Response) =>
    async (c: Context): Promise<Response> => {
      try {
        return await fn(c);
      } catch (e) {
        if (e instanceof BadRequest) return c.json({ error: e.message }, 400);
        if (e instanceof NotFound) return c.json({ error: e.message }, 404);
        if (e instanceof FeedbackActionError) return c.json({ error: e.message }, e.status);
        throw e;
      }
    };
  const caller = (c: Context): { id: string; root: string } => {
    const id = c.req.param('id')!;
    if (!store.workspaces.get(id)) throw new NotFound(`workspace '${id}' not found`);
    return { id, root: rootOf(store, id) };
  };
  const reason = async (c: Context): Promise<string | undefined> => {
    let raw: unknown = {};
    try {
      raw = await c.req.json();
    } catch {
      raw = {};
    }
    const r = decisionBody.safeParse(raw ?? {});
    if (!r.success) throw new BadRequest(r.error.issues.map((i) => i.message).join('; '));
    return r.data.reason?.trim() || undefined;
  };

  /** The lessons page of the caller's business tree. */
  app.get(
    base,
    wrap((c) => {
      const { root } = caller(c);
      const s = lessonsSettings(config);
      const repo = lessonRepos(store);
      const all = repo.proposals.list({ rootWorkspaceId: root });
      const pending = all.filter((p) => p.status === 'pending');
      const decided = all.filter((p) => p.status !== 'pending').sort((a, b) => (b.decidedAt ?? '').localeCompare(a.decidedAt ?? '')).slice(0, DECIDED_LIMIT);
      const roles = ROLES.map((role) => ({
        role,
        active: activeRules(store, root, role).length,
        pending: pending.filter((p) => p.role === role).length,
        cap: s.maxRulesPerRole,
      })).filter((r) => r.active || r.pending);
      return c.json({
        rootWorkspaceId: root,
        settings: {
          enabled: s.enabled, minTasks: s.minTasks, retireAfterCleanTasks: s.retireAfterCleanTasks, minEffectTasks: s.minEffectTasks,
          maxRulesPerRole: s.maxRulesPerRole,
          retro: { enabled: s.retro.enabled, cron: s.retro.cron, windowDays: s.retro.windowDays, maxProposals: s.retro.maxProposals, nextAt: nextRetroAt(config) },
        },
        roles,
        proposals: [...pending, ...decided],
        rules: rulesWithEffect(store, root),
        retros: repo.retros.list({ rootWorkspaceId: root }).reverse().slice(0, RETRO_LIMIT),
      });
    }),
  );

  /** Runs the lessons engine now; returns the new pending proposals. */
  app.post(
    `${base}/evaluate`,
    wrap((c) => {
      const { root } = caller(c);
      return c.json({ proposals: evaluateLessonsAsUser({ store, config }, root, { actor: actorOf(config) }) });
    }),
  );

  /** The user's accept (the only path that puts a rule in a prompt or takes one out). */
  app.post(
    `${base}/proposals/:pid/accept`,
    wrap(async (c) => {
      const { id } = caller(c);
      const r = await reason(c);
      const res = acceptLessonProposalAsUser({ store, events, config }, id, c.req.param('pid')!, { actor: actorOf(config), ...(r ? { reason: r } : {}) });
      return c.json(res);
    }),
  );

  app.post(
    `${base}/proposals/:pid/reject`,
    wrap(async (c) => {
      const { id } = caller(c);
      const r = await reason(c);
      return c.json(rejectLessonProposalAsUser({ store, config }, id, c.req.param('pid')!, { actor: actorOf(config), ...(r ? { reason: r } : {}) }));
    }),
  );

  /** A pending proposal to take an active rule out of the prompt (accepting it is a separate step). */
  app.post(
    `${base}/rules/:rid/propose-retire`,
    wrap((c) => {
      const { root } = caller(c);
      const p = proposeRuleRetirementAsUser(store, c.req.param('rid')!, root, { actor: actorOf(config) });
      if (!p) throw new NotFound(`active lesson rule '${c.req.param('rid')}' not found`);
      return c.json(p);
    }),
  );

  /** Starts the retro of the caller's business tree now (runs in the background; 202). */
  app.post(
    `${base}/retro`,
    wrap((c) => {
      const { root } = caller(c);
      const s = lessonsSettings(config);
      if (!s.enabled || !s.retro.enabled) return c.json({ error: 'the retro is disabled (lessons.enabled / lessons.retro.enabled)' }, 409);
      runRetroAsUser(research, root, { actor: actorOf(config) }); // re-gate (Opus 4): the actor is recorded
      return c.json({ started: true, rootWorkspaceId: root }, 202);
    }),
  );
}
