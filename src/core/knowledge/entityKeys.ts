/**
 * Entity identity primitives (design §7.4): the name key, lookup by key or alias within one tree,
 * and find-or-create. Used by the backfill; KS-3's `resolveEntity` builds on them (adding merge
 * suggestions, relations and run context). Every lookup takes the tree root, so nothing crosses
 * trees. Merged entities resolve to their survivor.
 */
import type { EntityKind } from '../config/schema.js';
import { titleKey } from '../harness/tools/idempotency.js';
import type { Store } from '../store/db.js';
import { knowledgeRepos, newId } from '../store/repos.js';
import type { Entity } from '../types.js';

/** Normalized entity name (`entities.name_key`): trimmed, lowercased, whitespace collapsed (`titleKey`). */
export function entityNameKey(name: string): string {
  return titleKey(name);
}

/** Follows `mergedIntoId` to the surviving entity (cycle-safe; stops at a missing survivor). */
export function survivorOf(store: Store, entity: Entity): Entity {
  const repo = knowledgeRepos(store).entities;
  let e = entity;
  const seen = new Set([e.id]);
  while (e.mergedIntoId && !seen.has(e.mergedIntoId)) {
    const next = repo.get(e.mergedIntoId);
    if (!next) break;
    seen.add(next.id);
    e = next;
  }
  return e;
}

/**
 * The entity of tree `rootId` whose name key — or one of whose aliases' keys — equals `key`, trying
 * `kinds` in order (exact name before alias within a kind). Returns the survivor of a merged entity.
 */
export function findEntityByKey(store: Store, rootId: string, kinds: readonly EntityKind[], key: string): Entity | undefined {
  const repo = knowledgeRepos(store).entities;
  for (const kind of kinds) {
    const exact = repo.list({ rootWorkspaceId: rootId, kind, nameKey: key })[0];
    if (exact) return survivorOf(store, exact);
    const rows = store.db
      .prepare(`SELECT id FROM entities WHERE root_workspace_id = ? AND kind = ? AND aliases <> '[]' ORDER BY rowid`)
      .all(rootId, kind) as Array<{ id: string }>;
    for (const { id } of rows) {
      const e = repo.get(id)!;
      if (e.aliases.some((a) => entityNameKey(a) === key)) return survivorOf(store, e);
    }
  }
  return undefined;
}

export type EnsureEntityInput = {
  rootWorkspaceId: string;
  /** Home node of the record that names the entity (used only when creating). */
  workspaceId: string;
  kind: EntityKind;
  name: string;
  createdByRun?: string;
  now?: Date;
};

/** Finds the entity of that kind and name (key or alias) in the tree, or creates it. No suggestions. */
export function ensureEntity(store: Store, input: EnsureEntityInput): { entity: Entity; created: boolean } {
  const name = input.name.trim().replace(/\s+/g, ' ');
  const key = entityNameKey(name);
  if (!key) throw new Error('ensureEntity: empty name');
  const found = findEntityByKey(store, input.rootWorkspaceId, [input.kind], key);
  if (found) return { entity: found, created: false };
  const at = (input.now ?? new Date()).toISOString();
  const entity: Entity = {
    id: newId('ent'),
    rootWorkspaceId: input.rootWorkspaceId,
    workspaceId: input.workspaceId,
    kind: input.kind,
    name,
    nameKey: key,
    aliases: [],
    createdAt: at,
    updatedAt: at,
  };
  if (input.createdByRun !== undefined) entity.createdByRun = input.createdByRun;
  knowledgeRepos(store).entities.insert(entity);
  return { entity, created: true };
}
