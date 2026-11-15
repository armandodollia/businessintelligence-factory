/**
 * Stakeholder routes (design 2026-11-15-stakeholder-personas-design.md §7, §14, §16), under
 * `/api/workspaces/:id/…` where `:id` is the caller's node.
 *
 * - Reads: the node's own and competitor stakeholders; the open question round grouped by stakeholder;
 *   the user's own statements about one stakeholder; the simulated reads of a recommendation.
 * - Writes: answers / skips of the question round, "Show what the tool found", a note, a recorded real
 *   decision, a reaction to a read. The actor is `actorOf(config)`, never the request body; each write
 *   records its feedback event in `core/stakeholders/*`.
 * - Hidden until asked (§7): a hidden stakeholder is served as `{ id, label, stakeholderType,
 *   disclosure: 'hidden', questions }` only (`questions`: its open questions). Its profile, relation,
 *   evidence, agent.md path, adjustments, proposals, signals and reads are never served by any route.
 *   The user's own statements are served for hidden stakeholders too: they are the user's words.
 * - Isolation: an id of another business tree answers exactly like an unknown one (404).
 */
import type { Context, Hono } from 'hono';
import { z } from 'zod';
import type { BifConfig } from '../core/config/schema.js';
import { actorOf } from '../core/feedback/events.js';
import { isHidden, stakeholderPersonas, treeCompetitors } from '../core/stakeholders/personas.js';
import { answerQuestions, openQuestions, revealStakeholder } from '../core/stakeholders/questions.js';
import { reactToRead, readsOf } from '../core/stakeholders/reads.js';
import { stakeholdersSettings } from '../core/stakeholders/settings.js';
import { addNote, ownStakeholder, recordDecision, StakeholderError } from '../core/stakeholders/statements.js';
import { stakeholderRepos } from '../core/stakeholders/store.js';
import { REAL_DECISIONS, type StakeholderType } from '../core/stakeholders/types.js';
import type { Store } from '../core/store/db.js';
import { sameTree } from '../core/workspace/tree.js';
import type { Persona, PersonaProfileField, Workspace } from '../core/types.js';

export type StakeholderRouteDeps = { store: Store; config: BifConfig };

/** All a hidden stakeholder may show (§7). */
export type HiddenStakeholderView = { id: string; label: string; stakeholderType: StakeholderType; disclosure: 'hidden'; questions: number };
/** An open stakeholder: the hidden view's fields plus what research found and how many statements the user made. */
export type OpenStakeholderView = Omit<HiddenStakeholderView, 'disclosure'> & {
  disclosure: 'open';
  subjectKind: 'own' | 'competitor';
  relation: string;
  profile: Record<string, PersonaProfileField>;
  version: number;
  status: string;
  /** The user's "Use for reads and learning" override, when set (`POST /api/personas/:id/include`). */
  includeOverride?: boolean;
  /** Number of the user's statements about the stakeholder (their text: `GET …/stakeholders/:personaId/statements`). */
  statements: number;
};
export type StakeholderView = HiddenStakeholderView | OpenStakeholderView;

class BadRequest extends Error {}

/** Body shapes; lengths, emptiness and redaction are checked by `core/stakeholders/*` (answers and notes are capped, reasons refused over 2,000 characters). */
const schemas = {
  answers: z.object({
    answers: z.array(z.object({ questionId: z.string().min(1), text: z.string() })).default([]),
    skip: z.array(z.string().min(1)).optional(),
    skipAll: z.boolean().optional(),
  }),
  note: z.object({ text: z.string(), field: z.string().optional() }),
  decision: z.object({ personaId: z.string().min(1), decision: z.enum(REAL_DECISIONS), reasoning: z.string() }),
  reaction: z.object({ reaction: z.enum(['agree', 'disagree']), reason: z.string().optional() }),
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

/** The view of one stakeholder persona: the hidden view while hidden, else the open view. */
export function stakeholderView(store: Store, p: Persona): StakeholderView {
  const repos = stakeholderRepos(store);
  const base = {
    id: p.id,
    label: p.segment,
    stakeholderType: p.stakeholderType ?? 'other',
    questions: repos.questions.list({ personaId: p.id, status: 'open' }).length,
  };
  if (isHidden(p)) return { ...base, disclosure: 'hidden' };
  return {
    ...base,
    disclosure: 'open',
    subjectKind: p.subjectKind ?? 'own',
    relation: p.relation ?? '',
    profile: p.profile,
    version: p.version,
    status: p.status ?? 'pending',
    ...(p.includeOverride !== undefined ? { includeOverride: p.includeOverride } : {}),
    statements: repos.statements.list({ personaId: p.id }).length,
  };
}

const bySlug = (a: Persona, b: Persona) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0);

/** Mounts the stakeholder routes. Call before the `/api/*` 404 fallback; `workspace` resolves an id or throws the app's 404. */
export function mountStakeholderRoutes(app: Hono, deps: StakeholderRouteDeps, workspace: (id: string) => Workspace): void {
  const { store, config } = deps;
  const base = '/api/workspaces/:id';

  const wrap =
    (fn: (c: Context, ws: Workspace) => Promise<Response> | Response) =>
    async (c: Context): Promise<Response> => {
      const ws = workspace(c.req.param('id')!);
      try {
        return await fn(c, ws);
      } catch (e) {
        if (e instanceof BadRequest) return c.json({ error: e.message }, 400);
        if (e instanceof StakeholderError) return c.json({ error: e.message }, e.status);
        throw e;
      }
    };

  /** The node's own stakeholders, and its competitor stakeholders grouped by competitor (most important competitor first). */
  app.get(
    `${base}/stakeholders`,
    wrap((c, ws) => {
      const all = stakeholderPersonas(store, ws.id).sort(bySlug);
      const own = all.filter((p) => p.subjectKind !== 'competitor').map((p) => stakeholderView(store, p));
      const rivals = all.filter((p) => p.subjectKind === 'competitor');
      const order = treeCompetitors(store, ws.id).map((x) => x.id);
      const ids = [...new Set(rivals.map((p) => p.subjectId ?? ''))].sort((a, b) => {
        const ia = order.indexOf(a);
        const ib = order.indexOf(b);
        return (ia < 0 ? Infinity : ia) - (ib < 0 ? Infinity : ib) || (a < b ? -1 : a > b ? 1 : 0);
      });
      const competitors = ids.map((competitorId) => ({
        competitorId,
        name: store.competitors.get(competitorId)?.name ?? competitorId,
        stakeholders: rivals.filter((p) => (p.subjectId ?? '') === competitorId).map((p) => stakeholderView(store, p)),
      }));
      return c.json({ enabled: stakeholdersSettings(config).enabled, own, competitors });
    }),
  );

  /** The node's open questions grouped by stakeholder (id, label and type only), node-wide questions last. */
  app.get(
    `${base}/stakeholder-questions`,
    wrap((c, ws) => c.json({ groups: openQuestions(store, ws.id) })),
  );

  app.post(
    `${base}/stakeholder-questions/answers`,
    wrap(async (c, ws) => {
      const input = await body(c, schemas.answers);
      return c.json(answerQuestions(store, actorOf(config), ws.id, input));
    }),
  );

  /** "Show what the tool found": opens the stakeholder (a skip of its questions). */
  app.post(
    `${base}/stakeholders/:personaId/reveal`,
    wrap((c, ws) => c.json(stakeholderView(store, revealStakeholder(store, actorOf(config), ws.id, c.req.param('personaId')!)))),
  );

  app.post(
    `${base}/stakeholders/:personaId/notes`,
    wrap(async (c, ws) => {
      const input = await body(c, schemas.note);
      const statement = addNote(store, actorOf(config), ws.id, {
        personaId: c.req.param('personaId')!,
        text: input.text,
        ...(input.field !== undefined ? { field: input.field } : {}),
      });
      return c.json(statement, 201);
    }),
  );

  /** The user's own statements about a stakeholder (hidden ones too: the user's words, not research), newest first. */
  app.get(
    `${base}/stakeholders/:personaId/statements`,
    wrap((c, ws) => {
      const persona = ownStakeholder(store, ws.id, c.req.param('personaId'));
      const statements = stakeholderRepos(store)
        .statements.list({ personaId: persona.id })
        .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
      return c.json({ statements });
    }),
  );

  /** "Record the real decision" of an own stakeholder on a recommendation. */
  app.post(
    `${base}/recommendations/:recId/stakeholder-decisions`,
    wrap(async (c, ws) => {
      const input = await body(c, schemas.decision);
      const statement = recordDecision(store, actorOf(config), ws.id, { recommendationId: c.req.param('recId')!, ...input });
      return c.json(statement, 201);
    }),
  );

  /** The simulated reads of a recommendation by open stakeholders, each with the stakeholder's label and type. */
  app.get(
    `${base}/recommendations/:recId/stakeholder-reads`,
    wrap((c, ws) => {
      const recId = c.req.param('recId')!;
      const rec = store.recommendations.get(recId);
      if (!rec || !sameTree(store, ws.id, rec.workspaceId)) throw new StakeholderError(`recommendation '${recId}' not found`, 404);
      const reads = readsOf(store, ws.id, rec.id).map((r) => {
        const p = store.personas.get(r.personaId)!;
        return { ...r, label: p.segment, stakeholderType: p.stakeholderType ?? 'other', subjectKind: p.subjectKind ?? 'own' };
      });
      return c.json({ reads });
    }),
  );

  app.post(
    `${base}/stakeholder-reads/:readId/reaction`,
    wrap(async (c, ws) => {
      const input = await body(c, schemas.reaction);
      return c.json(reactToRead(store, actorOf(config), ws.id, c.req.param('readId')!, input.reaction, input.reason), 201);
    }),
  );
}
