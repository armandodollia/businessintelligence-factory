/**
 * Persona learning routes (design 2026-11-15-persona-learning-design.md §13), under
 * `/api/workspaces/:id/…` where `:id` is the caller's node.
 *
 * - Reads: the number of pending proposals in the whole business tree (`pendingInTree`, for the Lessons
 *   page); for each persona of the node, its gate over the open signals (numbers and what is missing),
 *   its active adjustments with their effect, its proposals (pending first, then decided, newest first,
 *   at most 20) and its last learning run; and one persona's signals, newest first. Learning data of
 *   another node of the tree is read through that node.
 * - Writes: accept (optionally with edited text), reject, retire. The actor is `actorOf(config)`, never
 *   the request body; each records one feedback event and one Decision (`core/personas/adjustments.ts`).
 * - Isolation: an id of another business tree answers exactly like an unknown one (404).
 * - Stakeholder personas (stakeholder design §7, §14): open ones are served like segment personas; a
 *   hidden one is absent from the list, left out of `pendingInTree`, and its persona, proposal and
 *   adjustment ids answer 404 on every route here, exactly like unknown ids.
 * - User personas (user persona design §11, §16): not listed here (the You page has its own routes,
 *   `userPersonaRoutes.ts`), and their signals answer 404. Accept, reject and retire take the configured
 *   person's own user persona from any node of the tree, with `userPersona.maxAdjustments` and
 *   `maxPerField`; another person's answers 404 exactly like an unknown id. A decision on a user persona
 *   answers without the actor id (no `subjectId`, no `actor`). Its pending proposals count in
 *   `pendingInTree` (and in `pendingUser`); another person's do not.
 * - Nothing here is shown to an agent; text is served as stored (redacted) plain data for the browser.
 */
import type { Context, Hono } from 'hono';
import { z } from 'zod';
import type { BifConfig } from '../core/config/schema.js';
import { actorOf } from '../core/feedback/events.js';
import { REASON_MAX } from '../core/flows/feedback.js';
import { ADJUSTMENT_TEXT_MAX, acceptPersonaProposal, adjustmentEffect, PersonaLearningError, rejectPersonaProposal, retireAdjustment } from '../core/personas/adjustments.js';
import { lessonsSettings } from '../core/learning/lessons/settings.js';
import { personaGate } from '../core/personas/gate.js';
import { personaLearningSettings } from '../core/personas/settings.js';
import { collectPersonaSignals, openSignals } from '../core/personas/signals.js';
import { activeAdjustments, personaLearningRepos } from '../core/personas/store.js';
import type { PersonaAdjustment, PersonaLearningRun, PersonaProposal } from '../core/personas/types.js';
import { isHidden, segmentPersonas, stakeholderPersonas } from '../core/stakeholders/personas.js';
import type { Store } from '../core/store/db.js';
import { rootOf } from '../core/workspace/tree.js';
import type { Persona, Workspace } from '../core/types.js';
import { userPersonaSettings } from '../core/userPersona/settings.js';

export type PersonaLearningRouteDeps = { store: Store; config: BifConfig };

/** Proposals served per persona (pending first, then decided, newest first). */
const PROPOSAL_LIMIT = 20;

class BadRequest extends Error {}

const reason = z.string().max(REASON_MAX, `reason is at most ${REASON_MAX.toLocaleString('en-US')} characters`).optional();
const schemas = {
  accept: z.object({ text: z.string().max(ADJUSTMENT_TEXT_MAX, `text is at most ${ADJUSTMENT_TEXT_MAX} characters`).optional(), reason }),
  reasonOnly: z.object({ reason }),
};

const issuesText = (error: z.ZodError) => error.issues.map((i) => `${i.path.map(String).join('.') || '<body>'}: ${i.message}`).join('; ');

/** The request body (an empty body counts as `{}`), checked against `schema`. */
async function body<T extends z.ZodType>(c: Context, schema: T): Promise<z.infer<T>> {
  let raw: unknown;
  try {
    const text = await c.req.text();
    raw = text.trim() === '' ? {} : JSON.parse(text);
  } catch {
    throw new BadRequest('request body must be JSON');
  }
  const r = schema.safeParse(raw);
  if (!r.success) throw new BadRequest(issuesText(r.error));
  return r.data;
}

const newestFirst = (x: string | undefined, y: string | undefined) => (y ?? '').localeCompare(x ?? '');

/** Pending proposals (newest first), then decided ones (newest decision first), at most `PROPOSAL_LIMIT`. */
export function servedProposals(all: PersonaProposal[]): PersonaProposal[] {
  const pending = all.filter((p) => p.status === 'pending').sort((a, b) => newestFirst(a.createdAt, b.createdAt));
  const decided = all.filter((p) => p.status !== 'pending').sort((a, b) => newestFirst(a.decidedAt ?? a.createdAt, b.decidedAt ?? b.createdAt));
  return [...pending, ...decided].slice(0, PROPOSAL_LIMIT);
}

/** The newest run with an assumption (a later failed run does not hide it); without one, the newest run. */
export function lastRunOf(runs: PersonaLearningRun[]): Pick<PersonaLearningRun, 'id' | 'status' | 'assumption' | 'createdAt' | 'stats'> | undefined {
  const sorted = [...runs].sort((a, b) => newestFirst(a.createdAt, b.createdAt));
  const r = sorted.find((x) => x.assumption) ?? sorted[0];
  if (!r) return undefined;
  return { id: r.id, status: r.status, ...(r.assumption !== undefined ? { assumption: r.assumption } : {}), createdAt: r.createdAt, stats: r.stats };
}

/** A user persona row as served: without `subjectId` (the actor id never leaves the server). */
export function servedUserPersona(p: Persona): Omit<Persona, 'subjectId'> {
  const { subjectId: _, ...rest } = p;
  return rest;
}

/** A proposal or line of a user persona as served: without `actor` (the actor id never leaves the server). */
export function withoutActor<T extends PersonaProposal | PersonaAdjustment>(x: T): Omit<T, 'actor'> {
  const { actor: _, ...rest } = x;
  return rest;
}

/** Whether `p` is a user persona of someone else than `actor`: never served or decided here (404, as an unknown id). */
export const othersUserPersona = (p: Pick<Persona, 'kind' | 'subjectId'>, actor: string): boolean => p.kind === 'user' && p.subjectId !== actor;

/** Mounts the persona learning routes. Call before the `/api/*` 404 fallback; `workspace` resolves an id or throws the app's 404. */
export function mountPersonaLearningRoutes(app: Hono, deps: PersonaLearningRouteDeps, workspace: (id: string) => Workspace): void {
  const { store, config } = deps;
  const base = '/api/workspaces/:id';
  const repos = personaLearningRepos(store);
  /**
   * Whether nothing about the persona is served to the caller: a hidden stakeholder (stakeholder design
   * §7), or another person's user persona (user persona design §16).
   */
  const unservedPersona = (personaId: string) => {
    const p = store.personas.get(personaId);
    return !!p && (isHidden(p) || othersUserPersona(p, actorOf(config)));
  };
  /** 404, exactly as for an unknown id, for a proposal of an unserved persona. */
  const servedProposal = (proposalId: string): PersonaProposal | undefined => {
    const p = repos.proposals.get(proposalId);
    if (p && unservedPersona(p.personaId)) throw new PersonaLearningError(`persona proposal '${proposalId}' not found`, 404);
    return p;
  };
  const isUserPersona = (personaId: string | undefined) => personaId !== undefined && store.personas.get(personaId)?.kind === 'user';

  const wrap =
    (fn: (c: Context, ws: Workspace) => Promise<Response> | Response) =>
    async (c: Context): Promise<Response> => {
      const ws = workspace(c.req.param('id')!);
      try {
        return await fn(c, ws);
      } catch (e) {
        if (e instanceof BadRequest) return c.json({ error: e.message }, 400);
        if (e instanceof PersonaLearningError) return c.json({ error: e.message }, e.status);
        throw e;
      }
    };

  /** For each persona of the node: gate, active adjustments with their effect, proposals, last run. */
  app.get(
    `${base}/persona-learning`,
    wrap((c, ws) => {
      const settings = personaLearningSettings(config);
      const now = new Date();
      const learners = [...segmentPersonas(store, ws.id), ...stakeholderPersonas(store, ws.id).filter((p) => !isHidden(p))];
      const personas = learners.map((p) => {
        const lastRun = lastRunOf(repos.runs.list({ personaId: p.id }));
        return {
          personaId: p.id,
          kind: p.kind ?? 'segment',
          segment: p.segment,
          version: p.version,
          gate: personaGate(openSignals(store, settings, p.id, now), settings),
          adjustments: activeAdjustments(store, p.id).map((a) => ({ ...a, effect: adjustmentEffect(store, a) })),
          proposals: servedProposals(repos.proposals.list({ personaId: p.id })),
          ...(lastRun ? { lastRun } : {}),
        };
      });
      const pending = repos.proposals.list({ rootWorkspaceId: rootOf(store, ws.id), status: 'pending' }).filter((p) => !unservedPersona(p.personaId));
      const pendingUser = pending.filter((p) => isUserPersona(p.personaId)).length;
      // Whether persona learning would run at all: the retro runs it only with all three enabled.
      const lessons = lessonsSettings(config);
      const enabled = settings.enabled && lessons.enabled && lessons.retro.enabled;
      return c.json({ enabled, personas, pendingInTree: pending.length, pendingUser });
    }),
  );

  /** Every signal of a persona of the node, both polarities, newest first. */
  app.get(
    `${base}/personas/:personaId/signals`,
    wrap((c, ws) => {
      const personaId = c.req.param('personaId')!;
      const persona = store.personas.get(personaId);
      // A user persona has no signals (its interactions: `GET …/user-persona/interactions`).
      if (persona?.workspaceId !== ws.id || isHidden(persona) || persona.kind === 'user') throw new PersonaLearningError(`persona '${personaId}' not found`, 404);
      return c.json({ signals: collectPersonaSignals(store, personaId).reverse() });
    }),
  );

  /** The user accepts a pending proposal, optionally with edited text. */
  app.post(
    `${base}/persona-proposals/:proposalId/accept`,
    wrap(async (c, ws) => {
      const proposalId = c.req.param('proposalId')!;
      const user = isUserPersona(servedProposal(proposalId)?.personaId);
      const input = await body(c, schemas.accept);
      const u = userPersonaSettings(config);
      const out = acceptPersonaProposal(store, actorOf(config), ws.id, proposalId, {
        ...(input.text !== undefined ? { text: input.text } : {}),
        ...(input.reason !== undefined ? { reason: input.reason } : {}),
        ...(user ? { maxAdjustments: u.maxAdjustments, maxPerField: u.maxPerField } : { maxAdjustments: personaLearningSettings(config).maxAdjustments }),
      });
      if (!user) return c.json(out);
      return c.json({ proposal: withoutActor(out.proposal), adjustment: withoutActor(out.adjustment), persona: servedUserPersona(out.persona) });
    }),
  );

  app.post(
    `${base}/persona-proposals/:proposalId/reject`,
    wrap(async (c, ws) => {
      const proposalId = c.req.param('proposalId')!;
      const user = isUserPersona(servedProposal(proposalId)?.personaId);
      const input = await body(c, schemas.reasonOnly);
      const out = rejectPersonaProposal(store, actorOf(config), ws.id, proposalId, input.reason !== undefined ? { reason: input.reason } : {});
      return c.json(user ? withoutActor(out) : out);
    }),
  );

  /** The user retires an active adjustment directly. */
  app.post(
    `${base}/persona-adjustments/:adjustmentId/retire`,
    wrap(async (c, ws) => {
      const adjustmentId = c.req.param('adjustmentId')!;
      const adjustment = repos.adjustments.get(adjustmentId);
      if (adjustment && unservedPersona(adjustment.personaId)) throw new PersonaLearningError(`persona adjustment '${adjustmentId}' not found`, 404);
      const input = await body(c, schemas.reasonOnly);
      const out = retireAdjustment(store, actorOf(config), ws.id, adjustmentId, input.reason !== undefined ? { reason: input.reason } : {});
      if (!isUserPersona(adjustment?.personaId)) return c.json(out);
      return c.json({ adjustment: withoutActor(out.adjustment), persona: servedUserPersona(out.persona) });
    }),
  );
}
