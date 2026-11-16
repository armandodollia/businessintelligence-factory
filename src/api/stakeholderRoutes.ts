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
 *
 * Positions (design 2026-11-15-stakeholder-positions-design.md §9). `GET …/stakeholders` lists under
 * `own` only own stakeholders that have not left, a former colleague at a competitor in that
 * competitor's group and a parked one under `former`; `places` names the competitors and nodes of the
 * tree a person can go to. `GET …/stakeholders/:personaId/positions` serves the history and, for a
 * former colleague, the two layers; `POST …/stakeholders/:personaId/position` records that a person
 * left, moved, was promoted or demoted, or returned, and with `left` for a former colleague that they
 * moved on to another company. Both answer 409 for a hidden stakeholder.
 */
import type { Context, Hono } from 'hono';
import { z } from 'zod';
import type { BifConfig } from '../core/config/schema.js';
import { actorOf } from '../core/feedback/events.js';
import { publicLayerStatus, publicLayerUsed, type PublicLayerStatus } from '../core/stakeholders/combine.js';
import { isHidden, stakeholderPersonas, treeCompetitors } from '../core/stakeholders/personas.js';
import { changePosition, isFormerColleague, markLeft, markReturned, positionsOf, type LeftInput } from '../core/stakeholders/positions.js';
import { answerQuestions, openQuestions, revealStakeholder } from '../core/stakeholders/questions.js';
import { reactToRead, readsOf } from '../core/stakeholders/reads.js';
import { stakeholdersSettings } from '../core/stakeholders/settings.js';
import { addNote, ownStakeholder, recordDecision, StakeholderError } from '../core/stakeholders/statements.js';
import { stakeholderRepos } from '../core/stakeholders/store.js';
import { REAL_DECISIONS, STAKEHOLDER_TYPES, type StakeholderPosition, type StakeholderType } from '../core/stakeholders/types.js';
import type { Store } from '../core/store/db.js';
import { descendants, rootOf, sameTree, scopeOf } from '../core/workspace/tree.js';
import type { LeftFrom, Persona, PersonaProfileField, Workspace } from '../core/types.js';

/** `dataDir`: where agent.md files live (a position change rewrites the stakeholder's). */
export type StakeholderRouteDeps = { store: Store; config: BifConfig; dataDir: string };

/** All a hidden stakeholder may show (§7). */
export type HiddenStakeholderView = { id: string; label: string; stakeholderType: StakeholderType; disclosure: 'hidden'; questions: number };
/** An open stakeholder: the hidden view's fields plus what research found and how many statements the user made. */
export type OpenStakeholderView = Omit<HiddenStakeholderView, 'disclosure'> & {
  disclosure: 'open';
  /** `former`: a parked former colleague (stakeholder positions design §3). */
  subjectKind: 'own' | 'competitor' | 'former';
  relation: string;
  /** For a former colleague: the combined profile, each field with what it rests on (`basis`, `conflict`). */
  profile: Record<string, PersonaProfileField>;
  version: number;
  status: string;
  /** The user's "Use for reads and learning" override, when set (`POST /api/personas/:id/include`). */
  includeOverride?: boolean;
  /** Number of the user's statements about the stakeholder (their text: `GET …/stakeholders/:personaId/statements`). */
  statements: number;
  /** The current title, when the user gave one. */
  positionTitle?: string;
  /** Former colleagues only: the day the person left (YYYY-MM-DD) and the position held then. */
  leftAt?: string;
  leftFrom?: LeftFrom;
  /** Former colleagues only: what research last saw of the person's company and title. */
  publicPosition?: { text: string; evidence: string[] };
  /** Former colleagues only: whether research has stored a public layer (served by the positions route). */
  hasPublicLayer?: boolean;
};
export type StakeholderView = HiddenStakeholderView | OpenStakeholderView;

/** A row of the position history with the name of its place: the node, the competitor, or the company the user named. */
export type ServedStakeholderPosition = StakeholderPosition & { placeName?: string };
/** `GET …/stakeholders/:personaId/positions`: the history, newest first; the two layers of a former colleague. */
export type StakeholderPositionsView = {
  positions: ServedStakeholderPosition[];
  internalProfile?: Record<string, PersonaProfileField>;
  publicProfile?: Record<string, PersonaProfileField>;
  /** With a public layer: when research saved it. */
  publicSavedAt?: string;
  /** With a public layer: false when the research that saved it failed (the layer is stored and not used). */
  publicLayerUsed?: boolean;
  /** With a public layer: how the research that saved it ended (`pending`: not yet). A layer of `unverified` research is used. */
  publicLayerStatus?: PublicLayerStatus;
  /** When the combined profile was last written from both layers; absent while it never was. */
  combinedAt?: string;
};

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
  /** One shape per change; dates, lengths and "exactly one destination" are checked by `core/stakeholders/positions.ts`. */
  position: z.discriminatedUnion('change', [
    z.object({
      change: z.literal('left'),
      date: z.string(),
      to: z.object({
        competitorId: z.string().optional(),
        newCompetitor: z.object({ name: z.string(), site: z.string().optional() }).optional(),
        elsewhere: z.object({ companyName: z.string().optional() }).optional(),
      }),
      label: z.string().optional(),
      title: z.string().optional(),
      note: z.string().optional(),
    }),
    z.object({
      change: z.enum(['moved', 'promoted', 'demoted']),
      date: z.string(),
      toWorkspaceId: z.string().optional(),
      stakeholderType: z.enum(STAKEHOLDER_TYPES).optional(),
      title: z.string().optional(),
      note: z.string().optional(),
    }),
    z.object({
      change: z.literal('returned'),
      date: z.string(),
      toWorkspaceId: z.string(),
      label: z.string().optional(),
      stakeholderType: z.enum(STAKEHOLDER_TYPES).optional(),
      title: z.string().optional(),
      note: z.string().optional(),
    }),
  ]),
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
    ...(p.positionTitle ? { positionTitle: p.positionTitle } : {}),
    ...(isFormerColleague(p)
      ? {
          leftAt: p.leftAt,
          ...(p.leftFrom ? { leftFrom: p.leftFrom } : {}),
          ...(p.publicPosition ? { publicPosition: { text: p.publicPosition.text, evidence: p.publicPosition.evidence } } : {}),
          hasPublicLayer: !!p.publicProfile,
        }
      : {}),
  };
}

const bySlug = (a: Persona, b: Persona) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0);

/** Mounts the stakeholder routes. Call before the `/api/*` 404 fallback; `workspace` resolves an id or throws the app's 404. */
export function mountStakeholderRoutes(app: Hono, deps: StakeholderRouteDeps, workspace: (id: string) => Workspace): void {
  const { store, config } = deps;
  const positionDeps = { store, dataDir: deps.dataDir };
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

  /**
   * The node's own stakeholders that have not left, its competitor stakeholders grouped by competitor
   * (most important competitor first; former colleagues who went to one are among them), and its parked
   * former colleagues. `places`: where a person can go, the competitors and the nodes of the tree.
   */
  app.get(
    `${base}/stakeholders`,
    wrap((c, ws) => {
      const all = stakeholderPersonas(store, ws.id).sort(bySlug);
      const rivals = all.filter((p) => p.subjectKind === 'competitor');
      // As in `stakeholderView`, a stakeholder without a subject kind counts as an own one.
      const isOwn = (p: Persona) => (p.subjectKind ?? 'own') === 'own' && !p.leftAt;
      const own = all.filter(isOwn).map((p) => stakeholderView(store, p));
      // Everyone else left for somewhere that is no competitor: never listed as an own stakeholder.
      const former = all.filter((p) => p.subjectKind !== 'competitor' && !isOwn(p)).map((p) => stakeholderView(store, p));
      const tree = treeCompetitors(store, ws.id);
      const order = tree.map((x) => x.id);
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
      const root = store.workspaces.get(rootOf(store, ws.id)) ?? ws;
      const places = {
        competitors: tree.map((x) => ({ competitorId: x.id, name: x.name })),
        nodes: [root, ...descendants(store, root.id)].map((w) => ({ workspaceId: w.id, name: scopeOf(w).name })),
      };
      return c.json({ enabled: stakeholdersSettings(config).enabled, own, competitors, former, places });
    }),
  );

  /**
   * The position history of a stakeholder, newest first, and for a former colleague the internal layer
   * (the profile as it was when they left) and the public layer (what research found since), with when
   * the public layer was saved, whether it is used (`publicLayerUsed`), how the research that saved it
   * ended (`publicLayerStatus`) and when the combined profile was last written. 409 for a hidden
   * stakeholder: nothing of it is served.
   */
  app.get(
    `${base}/stakeholders/:personaId/positions`,
    wrap((c, ws) => {
      const persona = ownStakeholder(store, ws.id, c.req.param('personaId'));
      if (isHidden(persona)) throw new StakeholderError(`stakeholder '${persona.id}' is hidden: answer or skip its questions first`, 409);
      const placeName = (p: StakeholderPosition): string | undefined => {
        if (p.placeKind === 'competitor') return (p.competitorId ? store.competitors.get(p.competitorId)?.name : undefined) || undefined;
        if (p.placeKind === 'elsewhere') return p.companyName || undefined;
        const node = p.workspaceId ? store.workspaces.get(p.workspaceId) : undefined;
        return node ? scopeOf(node).name : undefined;
      };
      const positions: ServedStakeholderPosition[] = positionsOf(store, persona.id).map((p) => {
        const name = placeName(p);
        return { ...p, ...(name ? { placeName: name } : {}) };
      });
      const former = isFormerColleague(persona);
      const view: StakeholderPositionsView = {
        positions,
        ...(former && persona.internalProfile ? { internalProfile: persona.internalProfile } : {}),
        ...(former && persona.publicProfile
          ? {
              publicProfile: persona.publicProfile,
              ...(persona.publicSavedAt ? { publicSavedAt: persona.publicSavedAt } : {}),
              publicLayerUsed: publicLayerUsed(store, persona),
              publicLayerStatus: publicLayerStatus(store, persona),
            }
          : {}),
        ...(former && persona.combinedAt ? { combinedAt: persona.combinedAt } : {}),
      };
      return c.json(view);
    }),
  );

  /**
   * Records that the person left, moved, was promoted or demoted, or returned; answers the stakeholder's
   * view. `left` for someone who left already records that they moved on to another company (the history
   * row is `moved`; `markLeft`).
   */
  app.post(
    `${base}/stakeholders/:personaId/position`,
    wrap(async (c, ws) => {
      const input = await body(c, schemas.position);
      const personaId = c.req.param('personaId')!;
      const actor = actorOf(config);
      const persona =
        input.change === 'left'
          ? // That exactly one destination is named is checked by `markLeft`.
            markLeft(positionDeps, actor, ws.id, personaId, { ...input, to: input.to as LeftInput['to'] })
          : input.change === 'returned'
            ? markReturned(positionDeps, actor, ws.id, personaId, input)
            : changePosition(positionDeps, actor, ws.id, personaId, input);
      return c.json(stakeholderView(store, persona));
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
