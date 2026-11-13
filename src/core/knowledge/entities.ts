/**
 * Entities (design §7.4; build plan KS-3): resolve-or-create within one business tree, merge
 * suggestions, merges and renames.
 *
 * - Identity: unique per (tree root, kind, name key); aliases match too; a merged row resolves to its
 *   survivor (`entityKeys.ts`). Nothing ever crosses trees: an id of another tree is answered exactly
 *   like an unknown id (`notFound`, design §12).
 * - Near-matches never block a save: the entity is created and `entity_merge_suggestions` rows are
 *   written for the user (trigram candidates from `entities_fts` in the same tree and kind, scored by
 *   `entityNameSimilarity` ≥ `ENTITY_SUGGESTION_FLOOR`, each pair suggested once).
 * - Upload-only names (design-thread ruling 5 after the KS-0 gate; `entityIsUploadOnly` in
 *   `provenance.ts`): resolved at check time, no stored flag. A name that is upload-only when it
 *   becomes an alias (merge, rename) is kept on a merged row of its own and never copied into the
 *   survivor's public `aliases`, so it keeps that status: `aliases` holds only publicly attested
 *   names. When a publicly attested entity is merged into an upload-only one, the two rows swap names
 *   so the survivor's display name is the public one and the upload-only name becomes the alias.
 * - Entities carry names only: no summary is ever written by an agent (cards are computed, §10).
 */
import { ENTITY_KINDS, type EntityKind } from '../config/schema.js';
import type { Store } from '../store/db.js';
import { knowledgeRepos, newId } from '../store/repos.js';
import type { Entity, EntityMergeSuggestion, MergeSuggestionStatus } from '../types.js';
import { scopeOf } from '../workspace/tree.js';
import { ensureEntity, entityNameKey, findEntityByKey, survivorOf } from './entityKeys.js';
import { entityIsUploadOnly, entityReferences } from './provenance.js';
import { inTree, notFound, type KnowledgeScope } from './scope.js';
import { redactServed } from './trust.js';

/** An entity by id, or by kind and name (resolved or created in the caller's tree). */
export type EntityRef = { id: string } | { kind: EntityKind; name: string };

/** Who names the entity: home node of a created entity (default: the scope's node) and run. */
export type EntityContext = { workspaceId?: string; agentRunId?: string; now?: Date };

export type EntityResolution = {
  /** The surviving entity (never a merged row). */
  entity: Entity;
  created: boolean;
  /** Merge suggestions written for a newly created entity. */
  suggestions: EntityMergeSuggestion[];
};

/**
 * Kinds a finding subject resolves to first, in order. Same list as the backfill's
 * `SUBJECT_ENTITY_KINDS` (not imported: `backfill.ts` pulls in the export and, through it, the tool
 * handlers that use this module; a test keeps the two equal).
 */
export const SUBJECT_KINDS: readonly EntityKind[] = ['competitor', 'persona', 'company'];

/** Minimum `entityNameSimilarity` for a merge suggestion (0–1). */
export const ENTITY_SUGGESTION_FLOOR = 0.5;
/** At most this many suggestions per new entity. */
export const ENTITY_SUGGESTION_LIMIT = 3;
/** FTS candidates scored per new entity. */
const SUGGESTION_CANDIDATES = 50;
/** Longest stored entity name (hypothesis sentences name `cause` entities). */
export const MAX_ENTITY_NAME_CHARS = 200;

/** A merge / rename that conflicts with the current state (the API maps it to 409). */
export class EntityConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EntityConflictError';
  }
}

/** Display name as stored: trimmed, whitespace collapsed, capped at `MAX_ENTITY_NAME_CHARS`. */
export function cleanEntityName(name: string): string {
  return name.trim().replace(/\s+/g, ' ').slice(0, MAX_ENTITY_NAME_CHARS).trim();
}

/**
 * KS-4 gate (redact before every cut): an agent-supplied name with the identity secrets of the tree
 * redacted from the WHOLE text, then cleaned and cut to `MAX_ENTITY_NAME_CHARS` — a name cut first
 * could be stored with half a secret that no later redaction recognises.
 */
export function cleanAgentEntityName(store: Store, rootId: string, name: string): string {
  return cleanEntityName(redactServed(store, rootId, name));
}

const isEntityKind = (k: string): k is EntityKind => (ENTITY_KINDS as readonly string[]).includes(k);

/** The entity `id` of the scope's tree, as its survivor. Unknown and out-of-tree ids: `notFound('entity', id)`. */
export function getEntity(store: Store, scope: KnowledgeScope, id: string): Entity {
  const e = knowledgeRepos(store).entities.get(id);
  if (!e || e.rootWorkspaceId !== scope.rootId) throw notFound('entity', id);
  return survivorOf(store, e);
}

/**
 * Resolves `ref` in the scope's tree: an id (same tree only), or the exact name key / an alias of
 * that kind (following merges); otherwise creates the entity (home = `ctx.workspaceId`, default the
 * scope's node) and writes merge suggestions for near-matches. Never blocks on a near-match.
 */
export function resolveEntityDetailed(store: Store, scope: KnowledgeScope, ref: EntityRef, ctx: EntityContext = {}): EntityResolution {
  if ('id' in ref) return { entity: getEntity(store, scope, ref.id), created: false, suggestions: [] };
  if (!isEntityKind(ref.kind)) throw new Error(`unknown entity kind '${String(ref.kind)}'`);
  const name = cleanAgentEntityName(store, scope.rootId, ref.name);
  const key = entityNameKey(name);
  if (!key) throw new Error('entity name is empty');
  const found = findEntityByKey(store, scope.rootId, [ref.kind], key);
  if (found) return { entity: found, created: false, suggestions: [] };
  const home = ctx.workspaceId ?? scope.workspaceId;
  if (!inTree(scope, home)) throw notFound('workspace', home);
  return store.transaction(() => {
    const { entity, created } = ensureEntity(store, {
      rootWorkspaceId: scope.rootId,
      workspaceId: home,
      kind: ref.kind,
      name,
      ...(ctx.agentRunId !== undefined ? { createdByRun: ctx.agentRunId } : {}),
      ...(ctx.now ? { now: ctx.now } : {}),
    });
    return { entity, created, suggestions: created ? suggestMerges(store, entity, ctx.now) : [] };
  });
}

/** `resolveEntityDetailed(...).entity` (build plan contract). */
export function resolveEntity(store: Store, scope: KnowledgeScope, ref: EntityRef, ctx: EntityContext = {}): Entity {
  return resolveEntityDetailed(store, scope, ref, ctx).entity;
}

/**
 * The `company` entity of a node: named by the node's scope name, home = that node, created on first
 * use (build plan KS-3). `workspaceId` defaults to the scope's node and must be in its tree.
 */
export function companyEntity(store: Store, scope: KnowledgeScope, workspaceId: string = scope.workspaceId, ctx: EntityContext = {}): Entity {
  const ws = inTree(scope, workspaceId) ? store.workspaces.get(workspaceId) : undefined;
  if (!ws) throw notFound('workspace', workspaceId);
  return ensureEntity(store, {
    rootWorkspaceId: scope.rootId,
    workspaceId,
    kind: 'company',
    name: cleanEntityName(scopeOf(ws).name),
    ...(ctx.agentRunId !== undefined ? { createdByRun: ctx.agentRunId } : {}),
    ...(ctx.now ? { now: ctx.now } : {}),
  }).entity;
}

/**
 * The entity a finding's `subject` names when `save_finding` gets no `entity` (same rule as the
 * KS-0 backfill): an existing `competitor`, `persona` or `company` entity of the tree with that name
 * key or alias (in that order); else, when the subject is a node's scope name, that node's company
 * entity (created on first use; the caller's own node first); else a `topic` entity.
 */
export function subjectEntity(store: Store, scope: KnowledgeScope, subject: string, ctx: EntityContext = {}): EntityResolution {
  const key = entityNameKey(cleanAgentEntityName(store, scope.rootId, subject));
  if (!key) throw new Error('subject is empty');
  const existing = findEntityByKey(store, scope.rootId, SUBJECT_KINDS, key);
  if (existing) return { entity: existing, created: false, suggestions: [] };
  const own = ctx.workspaceId ?? scope.workspaceId;
  const nodes = scope.treeIds.filter((id) => {
    const w = store.workspaces.get(id);
    return !!w && entityNameKey(scopeOf(w).name) === key;
  });
  const node = nodes.includes(own) ? own : nodes[0];
  if (node !== undefined) return { entity: companyEntity(store, scope, node, ctx), created: false, suggestions: [] };
  return resolveEntityDetailed(store, scope, { kind: 'topic', name: subject }, ctx);
}

// ---------------------------------------------------------------------------
// lookup without creating (integration: KS-2's duplicate handshake)

/**
 * What `resolveEntity(ref)` would return, without writing anything: the surviving entity, or `null`
 * when resolving would create it (so no record references it yet). Validates like `resolveEntity`:
 * an id of another tree throws `notFound`, an unknown kind or an empty name throws.
 */
export function lookupEntity(store: Store, scope: KnowledgeScope, ref: EntityRef): Entity | null {
  if ('id' in ref) return getEntity(store, scope, ref.id);
  if (!isEntityKind(ref.kind)) throw new Error(`unknown entity kind '${String(ref.kind)}'`);
  const key = entityNameKey(cleanAgentEntityName(store, scope.rootId, ref.name));
  if (!key) throw new Error('entity name is empty');
  return findEntityByKey(store, scope.rootId, [ref.kind], key) ?? null;
}

/**
 * What `subjectEntity(subject)` would return, without writing anything (`null`: it would create the
 * entity — a node's company entity on first use, or a topic).
 */
export function lookupSubjectEntity(store: Store, scope: KnowledgeScope, subject: string): Entity | null {
  const key = entityNameKey(cleanAgentEntityName(store, scope.rootId, subject));
  if (!key) throw new Error('subject is empty');
  const existing = findEntityByKey(store, scope.rootId, SUBJECT_KINDS, key);
  if (existing) return existing;
  // A node named by the subject: its company entity would be created (no company with this key exists).
  if (scope.treeIds.some((id) => { const w = store.workspaces.get(id); return !!w && entityNameKey(scopeOf(w).name) === key; })) return null;
  return findEntityByKey(store, scope.rootId, ['topic'], key) ?? null;
}

// ---------------------------------------------------------------------------
// merge suggestions

/** Character trigrams of a name key, padded with one space each side (`' acme '`). */
function trigrams(key: string, pad = true): Set<string> {
  const s = pad ? ` ${key} ` : key;
  const out = new Set<string>();
  for (let i = 0; i + 3 <= s.length; i++) out.add(s.slice(i, i + 3));
  return out;
}

/**
 * Bounded name similarity (0–1): Dice coefficient of the padded character trigrams of the two name
 * keys. "Acme" ~ "Acme Inc" 0.67, "Globex" ~ "Globex Corp" 0.7, "Acme" ~ "Acne" 0.25.
 */
export function entityNameSimilarity(a: string, b: string): number {
  const ta = trigrams(entityNameKey(a));
  const tb = trigrams(entityNameKey(b));
  if (!ta.size || !tb.size) return 0;
  let shared = 0;
  for (const g of ta) if (tb.has(g)) shared++;
  return (2 * shared) / (ta.size + tb.size);
}

/**
 * Writes merge suggestions for `entity` (design §7.4, build plan KS-3): live entities of the same
 * tree and kind found by trigram match on `entities_fts` (name and aliases), scored by
 * `entityNameSimilarity` against the name and each alias, kept when ≥ `ENTITY_SUGGESTION_FLOOR`, best
 * `ENTITY_SUGGESTION_LIMIT` first; a pair already suggested (either direction, any status) is skipped.
 */
export function suggestMerges(store: Store, entity: Entity, now: Date = new Date()): EntityMergeSuggestion[] {
  const grams = [...trigrams(entity.nameKey, false)];
  if (!grams.length) return [];
  const match = grams.map((g) => `"${g.replaceAll('"', '""')}"`).join(' OR ');
  const rows = store.db
    .prepare(
      `SELECT e.id AS id FROM entities_fts JOIN entities e ON e.rowid = entities_fts.rowid
       WHERE entities_fts MATCH ? AND e.root_workspace_id = ? AND e.kind = ? AND e.merged_into_id IS NULL AND e.id <> ?
       ORDER BY bm25(entities_fts), e.rowid LIMIT ${SUGGESTION_CANDIDATES}`,
    )
    .all(match, entity.rootWorkspaceId, entity.kind, entity.id) as Array<{ id: string }>;
  const repo = knowledgeRepos(store);
  const suggested = store.db.prepare(
    `SELECT 1 FROM entity_merge_suggestions WHERE (entity_id = ? AND candidate_id = ?) OR (entity_id = ? AND candidate_id = ?)`,
  );
  const scored = rows
    .map(({ id }) => repo.entities.get(id)!)
    .map((c) => ({ c, score: Math.max(...[c.name, ...c.aliases].map((n) => entityNameSimilarity(entity.name, n))) }))
    .filter((x) => x.score >= ENTITY_SUGGESTION_FLOOR && !suggested.get(entity.id, x.c.id, x.c.id, entity.id))
    .sort((a, b) => b.score - a.score || a.c.id.localeCompare(b.c.id))
    .slice(0, ENTITY_SUGGESTION_LIMIT);
  return scored.map(({ c, score }) =>
    repo.entityMergeSuggestions.insert({
      id: newId('ems'),
      rootWorkspaceId: entity.rootWorkspaceId,
      entityId: entity.id,
      candidateId: c.id,
      score: Math.round(score * 1000) / 1000,
      status: 'open',
      createdAt: now.toISOString(),
    }),
  );
}

/** A merge suggestion with its upload rule applied (ruling 5): either entity upload-only. */
export type MergeSuggestionView = EntityMergeSuggestion & { uploadOnly: boolean };

/** Merge suggestions of the scope's tree (default: open ones), oldest first. */
export function listMergeSuggestions(
  store: Store,
  scope: KnowledgeScope,
  status: MergeSuggestionStatus = 'open',
): MergeSuggestionView[] {
  return knowledgeRepos(store)
    .entityMergeSuggestions.list({ rootWorkspaceId: scope.rootId, status })
    .map((s) => ({ ...s, uploadOnly: entityIsUploadOnly(store, s.entityId) || entityIsUploadOnly(store, s.candidateId) }));
}

/** Rejects an open merge suggestion of the scope's tree (`notFound` for other trees). */
export function rejectMergeSuggestion(store: Store, scope: KnowledgeScope, id: string, actor: string, now: Date = new Date()): EntityMergeSuggestion {
  const repo = knowledgeRepos(store).entityMergeSuggestions;
  const s = repo.get(id);
  if (!s || s.rootWorkspaceId !== scope.rootId) throw notFound('merge suggestion', id);
  if (s.status !== 'open') throw new EntityConflictError(`merge suggestion '${id}' is already ${s.status}`);
  return repo.update(id, { status: 'rejected', decidedAt: now.toISOString(), actor });
}

// ---------------------------------------------------------------------------
// merge and rename

/** Tables whose rows point at an entity by `entity_id` (re-pointed by a merge). */
const ENTITY_ID_TABLES = ['findings', 'competitors', 'personas', 'symptoms', 'symptom_hypotheses', 'artifact_captures'] as const;

export type MergeResult = {
  survivor: Entity;
  loser: Entity;
  /** Rows re-pointed per table, plus `relations`. */
  repointed: Record<string, number>;
  /** The loser's name was upload-only: kept on the loser row, not in the survivor's `aliases`. */
  aliasUploadOnly: boolean;
  /** An upload-only survivor took the loser's public name; its old name is now the upload-only alias. */
  swappedNames: boolean;
  /** Upload-derived records behind any upload-only name involved (for the feedback event's provenance). */
  uploadRefs: string[];
};

const derivedRefs = (store: Store, id: string) => entityReferences(store, id).filter((r) => r.derived).map((r) => r.recordId);

/** `(root, kind, key)` is held by no row other than `rows` (the two rows swapping names). */
function keyFree(store: Store, root: string, kind: EntityKind, key: string, rows: readonly string[]): boolean {
  return !knowledgeRepos(store).entities.list({ rootWorkspaceId: root, kind, nameKey: key }).some((e) => !rows.includes(e.id));
}

/**
 * Merges `loserId` into `survivorId` (design §7.4): both must be live entities of the same tree (of
 * `opts.scope`'s tree when given; any other id is `notFound`). Re-points facts, typed records,
 * captures and relations (duplicate edges and self-loops dropped) to the survivor, sets the loser's
 * `merged_into_id`, closes the pair's open suggestions (`accepted`) and re-points the loser's other
 * open suggestions (closing those that become self-pairs or duplicates). Names (ruling 5): the
 * loser's public aliases join the survivor's; its name joins them only when publicly attested — an
 * upload-only name stays on the loser row as an upload-only alias. A public loser merged into an
 * upload-only survivor swaps names with it (survivor id kept). The human action and its feedback
 * event are `mergeEntitiesAsUser` (`feedback/actions.ts`).
 */
export function mergeEntities(
  store: Store,
  survivorId: string,
  loserId: string,
  actor: string,
  opts: { scope?: KnowledgeScope; now?: Date } = {},
): MergeResult {
  return store.transaction(() => {
    const repo = knowledgeRepos(store).entities;
    const s0 = repo.get(survivorId);
    const root = opts.scope?.rootId ?? s0?.rootWorkspaceId;
    if (!s0 || s0.rootWorkspaceId !== root) throw notFound('entity', survivorId);
    const l0 = repo.get(loserId);
    if (!l0 || l0.rootWorkspaceId !== root) throw notFound('entity', loserId);
    if (s0.id === l0.id) throw new EntityConflictError('cannot merge an entity into itself');
    if (s0.mergedIntoId) throw new EntityConflictError(`entity '${s0.id}' was already merged into '${s0.mergedIntoId}'`);
    if (l0.mergedIntoId) throw new EntityConflictError(`entity '${l0.id}' was already merged into '${l0.mergedIntoId}'`);
    const at = (opts.now ?? new Date()).toISOString();

    const loserUploadOnly = entityIsUploadOnly(store, l0.id);
    const survivorUploadOnly = entityIsUploadOnly(store, s0.id);
    const uploadRefs = [
      ...new Set([...(loserUploadOnly ? derivedRefs(store, l0.id) : []), ...(survivorUploadOnly ? derivedRefs(store, s0.id) : [])]),
    ];

    const repointed: Record<string, number> = {};
    for (const t of ENTITY_ID_TABLES) {
      repointed[t] = Number(store.db.prepare(`UPDATE ${t} SET entity_id = ? WHERE entity_id = ?`).run(s0.id, l0.id).changes);
    }
    const run = (sql: string, ...p: string[]) => Number(store.db.prepare(sql).run(...p).changes);
    repointed.relations =
      run('UPDATE OR IGNORE relations SET from_entity_id = ? WHERE from_entity_id = ?', s0.id, l0.id) +
      run('UPDATE OR IGNORE relations SET to_entity_id = ? WHERE to_entity_id = ?', s0.id, l0.id);
    // Left-overs are duplicates of an edge the survivor already has; an edge between the two is now a self-loop.
    run('DELETE FROM relations WHERE from_entity_id = ? OR to_entity_id = ?', l0.id, l0.id);
    run('DELETE FROM relations WHERE from_entity_id = ? AND to_entity_id = ?', s0.id, s0.id);

    // Names.
    const swap =
      !loserUploadOnly &&
      survivorUploadOnly &&
      l0.nameKey !== s0.nameKey &&
      keyFree(store, root, s0.kind, l0.nameKey, [s0.id, l0.id]) &&
      keyFree(store, root, l0.kind, s0.nameKey, [s0.id, l0.id]);
    const survivorName = swap ? { name: l0.name, nameKey: l0.nameKey } : { name: s0.name, nameKey: s0.nameKey };
    const keys = new Set([survivorName.nameKey]);
    const aliases: string[] = [];
    const add = (n: string) => {
      const k = entityNameKey(n);
      if (k && !keys.has(k)) {
        keys.add(k);
        aliases.push(n);
      }
    };
    for (const a of s0.aliases) add(a);
    for (const a of l0.aliases) add(a);
    if (!loserUploadOnly && !swap) add(l0.name);
    if (swap) {
      // Free both keys first (unique per root, kind, key).
      repo.update(l0.id, { nameKey: `\u0000merge:${l0.id}` });
      repo.update(s0.id, { ...survivorName, aliases, updatedAt: at });
      repo.update(l0.id, { name: s0.name, nameKey: s0.nameKey, mergedIntoId: s0.id, updatedAt: at });
    } else {
      repo.update(s0.id, { aliases, updatedAt: at });
      repo.update(l0.id, { mergedIntoId: s0.id, updatedAt: at });
    }

    // Suggestions.
    const sugg = knowledgeRepos(store).entityMergeSuggestions;
    const open = store.db
      .prepare(`SELECT id FROM entity_merge_suggestions WHERE status = 'open' AND (entity_id = ? OR candidate_id = ?) ORDER BY rowid`)
      .all(l0.id, l0.id) as Array<{ id: string }>;
    for (const { id } of open) {
      const s = sugg.get(id)!;
      const a = s.entityId === l0.id ? s0.id : s.entityId;
      const b = s.candidateId === l0.id ? s0.id : s.candidateId;
      const pair = (s.entityId === s0.id || s.candidateId === s0.id) && a === b;
      if (pair) {
        sugg.update(id, { status: 'accepted', decidedAt: at, actor });
        continue;
      }
      const dup = sugg
        .list({ rootWorkspaceId: root })
        .some((o) => o.id !== id && ((o.entityId === a && o.candidateId === b) || (o.entityId === b && o.candidateId === a)));
      if (a === b || dup) sugg.update(id, { status: 'rejected', decidedAt: at, actor });
      else sugg.update(id, { entityId: a, candidateId: b });
    }

    return {
      survivor: repo.get(s0.id)!,
      loser: repo.get(l0.id)!,
      repointed,
      aliasUploadOnly: loserUploadOnly,
      swappedNames: swap,
      uploadRefs,
    };
  });
}

export type RenameResult = {
  entity: Entity;
  previousName: string;
  /** The previous name was upload-only: kept on a merged row of its own, not in `aliases`. */
  aliasUploadOnly: boolean;
  uploadRefs: string[];
};

/**
 * Renames a live entity (user action, design §17): the new name becomes the display name and key;
 * the previous name stays resolvable — in `aliases` when publicly attested, else on a merged row of
 * its own (an upload-only alias, ruling 5). A name another entity of the same kind already holds is
 * an `EntityConflictError` (merge instead); a name held by a merged row of this entity swaps with it.
 */
export function renameEntity(
  store: Store,
  entityId: string,
  newName: string,
  opts: { scope?: KnowledgeScope; now?: Date } = {},
): RenameResult {
  return store.transaction(() => {
    const repo = knowledgeRepos(store).entities;
    const e = repo.get(entityId);
    if (!e || (opts.scope && e.rootWorkspaceId !== opts.scope.rootId)) throw notFound('entity', entityId);
    if (e.mergedIntoId) throw new EntityConflictError(`entity '${e.id}' was merged into '${e.mergedIntoId}'`);
    const name = cleanAgentEntityName(store, e.rootWorkspaceId, newName);
    const key = entityNameKey(name);
    if (!key) throw new Error('entity name is empty');
    const at = (opts.now ?? new Date()).toISOString();
    if (key === e.nameKey) {
      return { entity: repo.update(e.id, { name, updatedAt: at }), previousName: e.name, aliasUploadOnly: false, uploadRefs: [] };
    }
    const uploadOnly = entityIsUploadOnly(store, e.id);
    const uploadRefs = uploadOnly ? [...new Set(derivedRefs(store, e.id))] : [];
    const aliases = e.aliases.filter((a) => entityNameKey(a) !== key);
    if (!uploadOnly && !aliases.some((a) => entityNameKey(a) === e.nameKey)) aliases.push(e.name);
    const holder = repo.list({ rootWorkspaceId: e.rootWorkspaceId, kind: e.kind, nameKey: key })[0];
    if (holder && survivorOf(store, holder).id !== e.id) {
      throw new EntityConflictError(`another ${e.kind} entity is already named '${holder.name}' (${holder.id}); merge them instead`);
    }
    if (holder) {
      // A merged row of this entity holds the name: it takes the previous name instead.
      repo.update(holder.id, { nameKey: `\u0000rename:${holder.id}` });
      repo.update(e.id, { name, nameKey: key, aliases, updatedAt: at });
      repo.update(holder.id, { name: e.name, nameKey: e.nameKey, mergedIntoId: e.id, updatedAt: at });
    } else {
      repo.update(e.id, { name, nameKey: key, aliases, updatedAt: at });
      if (uploadOnly) {
        repo.insert({
          id: newId('ent'),
          rootWorkspaceId: e.rootWorkspaceId,
          workspaceId: e.workspaceId,
          kind: e.kind,
          name: e.name,
          nameKey: e.nameKey,
          aliases: [],
          mergedIntoId: e.id,
          createdAt: at,
          updatedAt: at,
        });
      }
    }
    return { entity: repo.get(e.id)!, previousName: e.name, aliasUploadOnly: uploadOnly, uploadRefs };
  });
}

// ---------------------------------------------------------------------------
// names for cards (KS-4)

export type EntityNameView = { name: string; uploadOnly: boolean; /** The merged row holding an upload-only alias. */ entityId?: string };

/**
 * Display name and aliases of an entity of the scope's tree with their upload status (ruling 5), for
 * cards and expansions: public aliases from `aliases`, upload-only aliases from merged rows. A
 * response that shows an upload-only name must list that row's id (or the entity id) in its
 * retrieval `results` and carry the upload flag.
 */
export function entityNames(store: Store, scope: KnowledgeScope, id: string): { entity: Entity; uploadOnly: boolean; aliases: EntityNameView[] } {
  const entity = getEntity(store, scope, id);
  const aliases: EntityNameView[] = entity.aliases.map((name) => ({ name, uploadOnly: false }));
  const keys = new Set([entity.nameKey, ...entity.aliases.map(entityNameKey)]);
  const merged = store.db
    .prepare(
      `WITH RECURSIVE grp(id) AS (SELECT ? UNION SELECT e.id FROM entities e JOIN grp ON e.merged_into_id = grp.id)
       SELECT e.id AS id FROM entities e WHERE e.id IN (SELECT id FROM grp) AND e.id <> ? ORDER BY e.rowid`,
    )
    .all(entity.id, entity.id) as Array<{ id: string }>;
  for (const { id: rowId } of merged) {
    const row = knowledgeRepos(store).entities.get(rowId)!;
    if (keys.has(row.nameKey)) continue;
    keys.add(row.nameKey);
    aliases.push(entityIsUploadOnly(store, row.id) ? { name: row.name, uploadOnly: true, entityId: row.id } : { name: row.name, uploadOnly: false });
  }
  return { entity, uploadOnly: entityIsUploadOnly(store, entity.id), aliases };
}

/** Every live entity of the scope's tree (for lists; filtered by kind when given). */
export function listEntities(store: Store, scope: KnowledgeScope, kind?: EntityKind): Entity[] {
  return knowledgeRepos(store)
    .entities.list({ rootWorkspaceId: scope.rootId, ...(kind ? { kind } : {}), mergedIntoId: null });
}

