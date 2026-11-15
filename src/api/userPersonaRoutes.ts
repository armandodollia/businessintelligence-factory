/**
 * The You page's routes (user persona design §11, §12, §16), under `/api/workspaces/:id/…` where `:id`
 * is any node of a business tree: the tree's user persona of the configured person (`actorOf(config)`).
 *
 * - `GET …/user-persona`: whether learning runs (`enabled`), the roles the brief goes to (`usedBy`) and
 *   `useInPrompts`, the gate over the person's open interactions, statistics of their interactions over
 *   `windowDays`, the persona (`id`, `version`) once it exists, its active lines by field (each with the
 *   number of interactions it rests on), its proposals (pending first, then decided, newest first, at
 *   most 20) and its last learning run. Reading creates nothing.
 * - `GET …/user-persona/interactions?limit=&before=`: the person's interactions in the tree, newest first,
 *   50 per page by default and 200 at most; `next` is the cursor of the following page (`before`).
 *   `?line=<adjustment id>`: only the interactions that line rests on (the evidence of the proposal that
 *   last set its text); a line of another person's persona or of another tree answers 404.
 * - Accept, reject and retire use the persona learning routes (`personaLearningRoutes.ts`).
 * - The actor id is never in a response: the persona is served as `{ id, version }`, lines and
 *   proposals without `actor`. Interactions never carry it. Text is plain data for the browser.
 */
import type { Context, Hono } from 'hono';
import type { BifConfig } from '../core/config/schema.js';
import { actorOf } from '../core/feedback/events.js';
import { lessonsSettings } from '../core/learning/lessons/settings.js';
import { PersonaLearningError } from '../core/personas/adjustments.js';
import { personaLearningRepos } from '../core/personas/store.js';
import type { PersonaAdjustment } from '../core/personas/types.js';
import type { Store } from '../core/store/db.js';
import type { Workspace } from '../core/types.js';
import { collectInteractions, interactionGate, interactionStats, openInteractions, type Interaction } from '../core/userPersona/interactions.js';
import { USER_BRIEF_ROLES, userLines, userPersonaOf } from '../core/userPersona/persona.js';
import { userPersonaSettings } from '../core/userPersona/settings.js';
import { rootOf } from '../core/workspace/tree.js';
import { lastRunOf, servedProposals, withoutActor } from './personaLearningRoutes.js';

export type UserPersonaRouteDeps = { store: Store; config: BifConfig };

/** Interactions per page by default, and at most. */
const PAGE_DEFAULT = 50;
const PAGE_MAX = 200;
const DAY_MS = 24 * 60 * 60 * 1000;

class BadRequest extends Error {}

/** `?limit=`: a whole number of at least 1 (more than `PAGE_MAX` gives `PAGE_MAX`); absent: `PAGE_DEFAULT`. */
function pageSize(raw: string | undefined): number {
  if (raw === undefined || raw === '') return PAGE_DEFAULT;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) throw new BadRequest('limit must be a whole number of at least 1');
  return Math.min(n, PAGE_MAX);
}

/** Mounts the You page's routes. Call before the `/api/*` 404 fallback; `workspace` resolves an id or throws the app's 404. */
export function mountUserPersonaRoutes(app: Hono, deps: UserPersonaRouteDeps, workspace: (id: string) => Workspace): void {
  const { store, config } = deps;
  const base = '/api/workspaces/:id/user-persona';
  const repos = personaLearningRepos(store);

  const wrap =
    (fn: (c: Context, ws: Workspace) => Response) =>
    (c: Context): Response => {
      const ws = workspace(c.req.param('id')!);
      try {
        return fn(c, ws);
      } catch (e) {
        if (e instanceof BadRequest) return c.json({ error: e.message }, 400);
        if (e instanceof PersonaLearningError) return c.json({ error: e.message }, e.status);
        throw e;
      }
    };

  /** The interaction ids a line rests on: the evidence of the accepted proposal that last set its text. */
  const evidenceOf = (line: PersonaAdjustment): string[] => {
    const setters = repos.proposals
      .list({ personaId: line.personaId, status: 'accepted' })
      .filter((p) => p.action !== 'retire' && (p.adjustmentId === line.id || p.id === line.proposalId))
      .sort((a, b) => (b.decidedAt ?? b.createdAt).localeCompare(a.decidedAt ?? a.createdAt));
    return setters[0]?.evidence ?? [];
  };

  app.get(
    base,
    wrap((c, ws) => {
      const settings = userPersonaSettings(config);
      const lessons = lessonsSettings(config);
      const actor = actorOf(config);
      const root = rootOf(store, ws.id);
      const now = new Date();
      const persona = userPersonaOf(store, root, actor);
      const since = new Date(now.getTime() - settings.windowDays * DAY_MS).toISOString();
      const lastRun = persona ? lastRunOf(repos.runs.list({ personaId: persona.id })) : undefined;
      return c.json({
        // Whether the retro would learn at all: it runs user persona learning only with all three enabled.
        enabled: settings.enabled && lessons.enabled && lessons.retro.enabled,
        usedBy: [...USER_BRIEF_ROLES],
        // The brief reaches prompts only with both switches on (`promptUserBrief`).
        useInPrompts: settings.enabled && settings.useInPrompts,
        gate: interactionGate(openInteractions(store, settings, root, actor, now), settings),
        stats: interactionStats(collectInteractions(store, root, actor, { since })),
        ...(persona ? { persona: { id: persona.id, version: persona.version } } : {}),
        fields: userLines(store, root, actor).map(({ field, lines }) => ({
          field,
          lines: lines.map((a) => ({ ...withoutActor(a), evidence: evidenceOf(a).length })),
        })),
        proposals: persona ? servedProposals(repos.proposals.list({ personaId: persona.id })).map(withoutActor) : [],
        ...(lastRun ? { lastRun: { id: lastRun.id, status: lastRun.status, ...(lastRun.assumption !== undefined ? { assumption: lastRun.assumption } : {}), createdAt: lastRun.createdAt } } : {}),
      });
    }),
  );

  app.get(
    `${base}/interactions`,
    wrap((c, ws) => {
      const actor = actorOf(config);
      const root = rootOf(store, ws.id);
      const newestFirst = collectInteractions(store, root, actor).reverse();
      const lineId = c.req.query('line');
      if (lineId !== undefined) {
        const line = repos.adjustments.get(lineId);
        const persona = userPersonaOf(store, root, actor);
        // Another person's line, another tree's, or an unknown id: the same 404.
        if (!line || !persona || line.personaId !== persona.id) throw new PersonaLearningError(`persona adjustment '${lineId}' not found`, 404);
        const ids = new Set(evidenceOf(line));
        return c.json({ interactions: newestFirst.filter((x) => ids.has(x.id)) });
      }
      const limit = pageSize(c.req.query('limit'));
      const before = c.req.query('before');
      let start = 0;
      if (before !== undefined && before !== '') {
        const at = newestFirst.findIndex((x) => x.id === before);
        if (at < 0) throw new BadRequest(`unknown cursor '${before}'`);
        start = at + 1;
      }
      const interactions: Interaction[] = newestFirst.slice(start, start + limit);
      const more = start + limit < newestFirst.length;
      return c.json({ interactions, ...(more ? { next: interactions.at(-1)!.id } : {}) });
    }),
  );
}
