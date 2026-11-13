/**
 * Knowledge store KS-7 routes (design §17): the Knowledge view's API, under
 * `/api/workspaces/:id/knowledge/…` where `:id` is the caller's node.
 *
 * Reads: search, entity card, item (fact / artifact / chunk / entity / record) and artifact text, and
 * the changes feed go through KS-4's `knowledgeRead` with `role: 'user'` (same engine, budgets, fencing
 * and retrieval log as agents). Every read takes `scope=node` (default) or `scope=tree`. By-id reads
 * return the named item labelled with its source node; what is listed around it follows the scope.
 * Isolation: an id of another tree answers exactly like an unknown one (404, design §12).
 * The entity list, merge suggestions, stale / conflict lists and stats come from `userViews.ts`
 * under the same scope rules.
 *
 * Writes: every human action runs through `feedback/actions.ts`; the actor is `actorOf(config)`, never
 * a request body. Pruning is the only path that removes anything (files only, logged).
 */
import type { Context, Hono } from 'hono';
import { z } from 'zod';
import { ENTITY_KINDS, type BifConfig } from '../core/config/schema.js';
import type { EventBus } from '../core/events.js';
import type { ArtifactStore } from '../core/evidence/artifacts.js';
import {
  FeedbackActionError,
  acceptMergeSuggestionAsUser,
  acceptReplacementAsUser,
  mergeEntitiesAsUser,
  pruneArtifactsAsUser,
  rejectMergeSuggestionAsUser,
  renameEntityAsUser,
  retractFactAsUser,
  setFactScopesAsUser,
} from '../core/feedback/actions.js';
import { actorOf } from '../core/feedback/events.js';
import { gcReport, PruneError } from '../core/knowledge/gc.js';
import { scopeFor, activeIds, type KnowledgeScope, type ScopeMode } from '../core/knowledge/scope.js';
import { SEARCH_KINDS, type SearchKind } from '../core/knowledge/search.js';
import { isoDateInput } from '../core/knowledge/readCommon.js';
import { knowledgeRead, type KnowledgeReadInput, type KnowledgeReadTool } from '../core/knowledge/tools.js';
import { explainUploadDerived } from '../core/knowledge/uploadCause.js';
import { conflictFacts, knowledgeStats, staleFacts, visibleEntities, visibleMergeSuggestions, type ViewEnv } from '../core/knowledge/userViews.js';
import type { Store } from '../core/store/db.js';
import type { EntityKind } from '../core/types.js';

export type KnowledgeRouteDeps = { store: Store; artifacts: ArtifactStore; config: BifConfig; events: EventBus };

class BadRequest extends Error {}
class NotFound extends Error {}

const reason = z.string().max(2000).optional();
const schemas = {
  reason: z.object({ reason }),
  // KS-6 × KS-7: retract as a duplicate of another fact of the same tree (`duplicate-saved` trigger b).
  retract: z.object({ reason, duplicateOf: z.string().min(1).optional() }),
  accept: z.object({ survivorId: z.string().min(1).optional(), reason }),
  merge: z.object({ survivorId: z.string().min(1), loserId: z.string().min(1), reason }),
  rename: z.object({ name: z.string().min(1).max(200), reason }),
  scopes: z.object({ workspaceIds: z.array(z.string().min(1)).min(1).max(50), reason }),
  prune: z.object({ artifactIds: z.array(z.string().min(1)).min(1).max(500), minAgeDays: z.number().int().min(0).optional(), reason }),
};

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

function scopeParam(c: Context): ScopeMode {
  const s = c.req.query('scope');
  if (s === undefined || s === '' || s === 'node') return 'node';
  if (s === 'tree') return 'tree';
  throw new BadRequest(`scope must be "node" or "tree"`);
}

/** An ISO date query parameter (`since`), normalized; 400 when unparseable. */
function isoParam(c: Context, name: string): string | undefined {
  const v = c.req.query(name);
  if (v === undefined || v === '') return undefined;
  try {
    return isoDateInput(name, v);
  } catch (e) {
    throw new BadRequest((e as Error).message);
  }
}

function intParam(c: Context, name: string): number | undefined {
  const v = c.req.query(name);
  if (v === undefined || v === '') return undefined;
  const n = Number(v);
  if (!Number.isInteger(n)) throw new BadRequest(`${name} must be an integer`);
  return n;
}

/** Mounts the KS-7 routes. Call before the `/api/*` 404 fallback. */
export function mountKnowledgeRoutes(app: Hono, deps: KnowledgeRouteDeps): void {
  const { store, artifacts, config, events } = deps;
  const base = '/api/workspaces/:id/knowledge';

  const wrap =
    (fn: (c: Context) => Promise<Response> | Response) =>
    async (c: Context): Promise<Response> => {
      try {
        return await fn(c);
      } catch (e) {
        if (e instanceof BadRequest) return c.json({ error: e.message }, 400);
        if (e instanceof NotFound) return c.json({ error: e.message }, 404);
        if (e instanceof FeedbackActionError) return c.json({ error: e.message }, e.status);
        if (e instanceof PruneError) return c.json({ error: e.message, refused: e.refused }, e.status);
        throw e;
      }
    };

  /** The caller's node and scope; 404 for an unknown node. */
  const caller = (c: Context): KnowledgeScope => {
    const id = c.req.param('id')!;
    if (!store.workspaces.get(id)) throw new NotFound(`workspace '${id}' not found`);
    return scopeFor(store, id);
  };
  const view = (c: Context): ViewEnv => ({ store, config, scope: caller(c), mode: scopeParam(c) });
  const actorOpts = (c: Context, r: string | undefined) => ({ actor: actorOf(config), workspaceId: c.req.param('id')!, ...(r ? { reason: r } : {}) });

  /** One read through the KS-4 engine as the user; not-found answers 404, other refusals 400. */
  const read = (c: Context, tool: KnowledgeReadTool, input: KnowledgeReadInput): Record<string, unknown> => {
    const scope = caller(c);
    const cursor = c.req.query('cursor');
    const maxTokens = intParam(c, 'max_tokens');
    const r = knowledgeRead(
      { store, config, events, files: artifacts },
      { workspaceId: scope.workspaceId, role: 'user' },
      tool,
      { ...input, scope: scopeParam(c), ...(cursor ? { cursor } : {}), ...(maxTokens !== undefined ? { max_tokens: Math.max(100, maxTokens) } : {}) },
    );
    if (!r.ok) {
      if (/ not found$/.test(r.error)) throw new NotFound(r.error);
      throw new BadRequest(r.error);
    }
    return { ...r.data, retrievalEventId: r.retrievalEventId };
  };

  /** Adds `uploadWhy` (why the export leaves it out) to every item flagged upload-derived. */
  const why = (id: string): { uploadWhy?: string } => {
    const e = explainUploadDerived(store, id);
    return e ? { uploadWhy: e.text } : {};
  };

  // --- reads -------------------------------------------------------------------------------------

  /** Search (`q`, `kinds=fact,passage,…`, `entity_id`, `include_unverified`, `include_history`, `since`, `limit`). */
  app.get(`${base}/search`, wrap((c) => {
    const kindsRaw = c.req.query('kinds');
    const kinds = kindsRaw ? kindsRaw.split(',').map((k) => k.trim()).filter(Boolean) : undefined;
    if (kinds?.some((k) => !(SEARCH_KINDS as readonly string[]).includes(k))) throw new BadRequest(`kinds must be among ${SEARCH_KINDS.join(', ')}`);
    const limit = intParam(c, 'limit');
    const q = c.req.query('q');
    const entityId = c.req.query('entity_id');
    const since = isoParam(c, 'since');
    const data = read(c, 'search', {
      ...(q !== undefined ? { query: q } : {}),
      ...(kinds ? { kinds: kinds as SearchKind[] } : {}),
      ...(entityId ? { entity_id: entityId } : {}),
      ...(since ? { since } : {}),
      ...(limit !== undefined ? { limit: Math.min(50, Math.max(1, limit)) } : {}),
      ...(c.req.query('include_unverified') === 'true' ? { include_unverified: true } : {}),
      ...(c.req.query('include_history') === 'true' ? { include_history: true } : {}),
    });
    const hits = (data.hits as Array<Record<string, unknown>> | undefined) ?? [];
    data.hits = hits.map((h) => (Array.isArray(h.flags) && h.flags.includes('upload') && typeof h.id === 'string' ? { ...h, ...why(h.id) } : h));
    return c.json(data);
  }));

  /** Entities visible in the scope (`kind` filter). */
  app.get(`${base}/entities`, wrap((c) => {
    const kind = c.req.query('kind');
    if (kind && !(ENTITY_KINDS as readonly string[]).includes(kind)) throw new BadRequest(`unknown entity kind '${kind}'`);
    return c.json(visibleEntities(view(c), kind ? (kind as EntityKind) : undefined));
  }));

  /** An entity's card (any entity of the tree, labelled; what it lists follows the scope). */
  app.get(`${base}/entities/:entityId`, wrap((c) => c.json(read(c, 'get_card', { entity_id: c.req.param('entityId')! }))));

  /** The node card of the caller (or `workspace_id`, another node of the tree, labelled). */
  app.get(`${base}/node`, wrap((c) => {
    const ws = c.req.query('workspace_id');
    return c.json(read(c, 'get_card', { workspace_id: ws || c.req.param('id')! }));
  }));

  /**
   * One item by id: a fact with its history and evidence, an artifact with its captures and outline, a
   * chunk's text (fenced), an entity or a typed record (`around` = neighbouring chunks).
   */
  app.get(`${base}/items/:itemId`, wrap((c) => {
    const itemId = c.req.param('itemId')!;
    const around = intParam(c, 'around');
    const data = read(c, 'expand', { id: itemId, ...(around !== undefined ? { around: Math.min(3, Math.max(0, around)) } : {}) });
    return c.json({ ...data, ...why(itemId) });
  }));

  /** An artifact's extracted text (`mode=outline|text|raw`; images are served by `/api/artifacts/:id`). */
  app.get(`${base}/artifacts/:artifactId`, wrap((c) => {
    const mode = c.req.query('mode') ?? 'text';
    if (!['outline', 'text', 'raw'].includes(mode)) throw new BadRequest('mode must be outline, text or raw');
    const id = c.req.param('artifactId')!;
    const data = read(c, 'read_artifact', { artifact_id: id, mode: mode as 'outline' | 'text' | 'raw' });
    return c.json({ ...data, ...why(id) });
  }));

  /** Changes feed (`since`, `run_id`, `entity_id`). */
  app.get(`${base}/changes`, wrap((c) => {
    const since = isoParam(c, 'since');
    const runId = c.req.query('run_id');
    const entityId = c.req.query('entity_id');
    return c.json(read(c, 'list_changes', { ...(since ? { since } : {}), ...(runId ? { run_id: runId } : {}), ...(entityId ? { entity_id: entityId } : {}) }));
  }));

  app.get(`${base}/stats`, wrap((c) => c.json(knowledgeStats(view(c)))));
  app.get(`${base}/stale`, wrap((c) => c.json(staleFacts(view(c)))));
  app.get(`${base}/conflicts`, wrap((c) => c.json(conflictFacts(view(c)))));
  app.get(`${base}/merge-suggestions`, wrap((c) => c.json(visibleMergeSuggestions(view(c)))));

  // --- human actions (feedback/actions.ts; actor from config) ------------------------------------

  app.post(`${base}/merge-suggestions/:sid/accept`, wrap(async (c) => {
    const b = await body(c, schemas.accept);
    const r = acceptMergeSuggestionAsUser(store, c.req.param('sid')!, { ...actorOpts(c, b.reason), ...(b.survivorId ? { survivorId: b.survivorId } : {}) });
    return c.json({ survivor: r.survivor });
  }));

  app.post(`${base}/merge-suggestions/:sid/reject`, wrap(async (c) => {
    const b = await body(c, schemas.reason);
    return c.json(rejectMergeSuggestionAsUser(store, c.req.param('sid')!, actorOpts(c, b.reason)));
  }));

  app.post(`${base}/entities/merge`, wrap(async (c) => {
    const b = await body(c, schemas.merge);
    const r = mergeEntitiesAsUser(store, b.survivorId, b.loserId, actorOpts(c, b.reason));
    return c.json({ survivor: r.survivor });
  }));

  app.post(`${base}/entities/:entityId/rename`, wrap(async (c) => {
    const b = await body(c, schemas.rename);
    const r = renameEntityAsUser(store, c.req.param('entityId')!, b.name, actorOpts(c, b.reason));
    return c.json({ entity: r.entity });
  }));

  app.post(`${base}/facts/:factId/retract`, wrap(async (c) => {
    const b = await body(c, schemas.retract);
    return c.json(retractFactAsUser(store, c.req.param('factId')!, { ...actorOpts(c, b.reason), ...(b.duplicateOf ? { duplicateOf: b.duplicateOf } : {}) }));
  }));

  app.put(`${base}/facts/:factId/scopes`, wrap(async (c) => {
    const b = await body(c, schemas.scopes);
    return c.json({ workspaceIds: setFactScopesAsUser(store, c.req.param('factId')!, b.workspaceIds, actorOpts(c, b.reason)) });
  }));

  app.post(`${base}/facts/:factId/accept-replacement`, wrap(async (c) => {
    const b = await body(c, schemas.reason);
    return c.json(acceptReplacementAsUser(store, c.req.param('factId')!, actorOpts(c, b.reason)));
  }));

  // --- gc (design §14) -----------------------------------------------------------------------------

  /** The gc report over the scope's nodes (`minAgeDays` ≥ `knowledge.retention.pruneMinAgeDays`). */
  app.get(`${base}/gc`, wrap((c) => {
    const v = view(c);
    const minAgeDays = intParam(c, 'minAgeDays');
    return c.json(gcReport(store, artifacts, config, { workspaceIds: activeIds(v.scope, v.mode), ...(minAgeDays !== undefined ? { minAgeDays } : {}) }));
  }));

  /** The user's prune: all or nothing, files only, logged (409 with `refused` when anything is refused). */
  app.post(`${base}/gc/prune`, wrap(async (c) => {
    const b = await body(c, schemas.prune);
    const scope = caller(c);
    const r = pruneArtifactsAsUser({ store, files: artifacts, config, events }, scope.workspaceId, b.artifactIds, {
      actor: actorOf(config), ...(b.reason ? { reason: b.reason } : {}), ...(b.minAgeDays !== undefined ? { minAgeDays: b.minAgeDays } : {}),
    });
    return c.json({ pruned: r.pruned.map((x) => x.artifactId), bytes: r.bytes, minAgeDays: r.minAgeDays, decisionId: r.decisionId });
  }));
}
