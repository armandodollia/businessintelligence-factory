/**
 * Relations (design §7.4; build plan KS-3): typed edges between two entities of one tree, each backed
 * by the record that asserts it. An edge is live only while its source record is usable
 * (`usable.ts`); that is checked with a join at read time — there is no stored flag — so an edge
 * disappears from `neighbours` as soon as its source fact is replaced, retracted or superseded, and
 * comes back if the record becomes usable again.
 */
import type { Store } from '../store/db.js';
import { knowledgeRepos, newId } from '../store/repos.js';
import type { Relation, RelationSourceKind, RelationType } from '../types.js';
import { getEntity } from './entities.js';
import { activeIds, inTree, notFound, type KnowledgeScope, type ScopeMode } from './scope.js';
import { SOURCE_TABLES, sourceUsableSql, sourceVisibleSql } from './usable.js';

/** Closed list of relation types (design §7.4). */
export const RELATION_TYPES = [
  'competes_with', 'offers', 'has_flow', 'targets', 'experiences', 'causes', 'addresses', 'part_of',
] as const satisfies readonly RelationType[];
// Every `RelationType` is listed (compile-time check).
const _allTypes: Exclude<RelationType, (typeof RELATION_TYPES)[number]> extends never ? true : never = true;
void _allTypes;

export const RELATION_SOURCE_KINDS = Object.keys(SOURCE_TABLES) as RelationSourceKind[];

export const isRelationType = (t: string): t is RelationType => (RELATION_TYPES as readonly string[]).includes(t);

/** An edge to add: entity ids (merged rows resolve to their survivor) and the asserting record. */
export type RelationInput = {
  from: string;
  type: RelationType;
  to: string;
  sourceKind: RelationSourceKind;
  sourceId: string;
};

/**
 * Adds an edge in the scope's tree; idempotent (the same from / type / to / source returns the
 * existing row). Both entities and the source record must belong to the scope's tree — anything else
 * is `notFound`, exactly like an unknown id. An edge from an entity to itself is refused.
 */
export function addRelation(store: Store, scope: KnowledgeScope, edge: RelationInput, now: Date = new Date()): Relation {
  if (!isRelationType(edge.type)) throw new Error(`unknown relation type '${String(edge.type)}'`);
  const table = SOURCE_TABLES[edge.sourceKind];
  if (!table) throw new Error(`unknown relation source kind '${String(edge.sourceKind)}'`);
  const from = getEntity(store, scope, edge.from);
  const to = getEntity(store, scope, edge.to);
  if (from.id === to.id) throw new Error('a relation needs two different entities');
  const src = store.db.prepare(`SELECT workspace_id AS ws FROM ${table} WHERE id = ?`).get(edge.sourceId) as { ws: string } | undefined;
  if (!src || !inTree(scope, src.ws)) throw notFound(edge.sourceKind, edge.sourceId);
  store.db
    .prepare(
      `INSERT OR IGNORE INTO relations (id, root_workspace_id, from_entity_id, type, to_entity_id, source_kind, source_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(newId('rel'), scope.rootId, from.id, edge.type, to.id, edge.sourceKind, edge.sourceId, now.toISOString());
  return knowledgeRepos(store).relations.list({
    fromEntityId: from.id, type: edge.type, toEntityId: to.id, sourceKind: edge.sourceKind, sourceId: edge.sourceId,
  })[0]!;
}

/** An edge returned by `neighbours`: hop distance from the start entity and whether its source is usable now. */
export type Edge = Relation & { depth: 1 | 2; usable: boolean };

export type NeighbourOptions = {
  /** Only these types (default: all). */
  types?: readonly RelationType[];
  depth: 1 | 2;
  /** Only live edges (source record usable). */
  usableOnly: boolean;
  /**
   * Visibility of the source record (design §7.1): `node` (default) — visible from the scope's
   * `nodeIds`; `tree` — any node of the tree.
   */
  mode?: ScopeMode;
};

/**
 * Edges within 1 or 2 hops of an entity of the scope's tree (either direction), as a recursive CTE:
 * depth 1 touches the entity, depth 2 touches one of its depth-1 neighbours. Only edges whose source
 * record is visible in the scope (and usable, with `usableOnly`) are traversed and returned. Ordered
 * by depth, type, then insertion. Unknown and out-of-tree ids: `notFound('entity', id)`.
 */
export function neighbours(store: Store, scope: KnowledgeScope, entityId: string, opts: NeighbourOptions): Edge[] {
  const start = getEntity(store, scope, entityId);
  const depth = opts.depth === 2 ? 2 : 1;
  const usable = sourceUsableSql('r.source_kind', 'r.source_id');
  const where = [
    'r.root_workspace_id = :root',
    `${sourceVisibleSql('r.source_kind', 'r.source_id')} = 1`,
    ...(opts.usableOnly ? [`${usable} = 1`] : []),
    ...(opts.types ? ['r.type IN (SELECT value FROM json_each(:types))'] : []),
  ];
  const rows = store.db
    .prepare(
      `WITH RECURSIVE
         vis(ws) AS (SELECT value FROM json_each(:vis)),
         live AS (SELECT r.*, r.rowid AS rid, ${usable} AS usable FROM relations r WHERE ${where.join(' AND ')}),
         hop(entity, depth) AS (
           SELECT :start, 0
           UNION
           SELECT CASE WHEN l.from_entity_id = hop.entity THEN l.to_entity_id ELSE l.from_entity_id END, hop.depth + 1
           FROM hop JOIN live l ON l.from_entity_id = hop.entity OR l.to_entity_id = hop.entity
           WHERE hop.depth + 1 < :depth
         )
       SELECT l.id, l.root_workspace_id, l.from_entity_id, l.type, l.to_entity_id, l.source_kind, l.source_id, l.created_at,
              l.usable, MIN(h.depth) + 1 AS depth, l.rid
       FROM live l JOIN hop h ON l.from_entity_id = h.entity OR l.to_entity_id = h.entity
       GROUP BY l.id
       ORDER BY depth, l.type, l.rid`,
    )
    .all({
      root: scope.rootId,
      vis: JSON.stringify(activeIds(scope, opts.mode ?? 'node')),
      start: start.id,
      depth,
      ...(opts.types ? { types: JSON.stringify(opts.types) } : {}),
    }) as Array<Record<string, string | number>>;
  return rows.map((r) => ({
    id: String(r.id),
    rootWorkspaceId: String(r.root_workspace_id),
    fromEntityId: String(r.from_entity_id),
    type: r.type as RelationType,
    toEntityId: String(r.to_entity_id),
    sourceKind: r.source_kind as RelationSourceKind,
    sourceId: String(r.source_id),
    createdAt: String(r.created_at),
    depth: Number(r.depth) as 1 | 2,
    usable: Number(r.usable) === 1,
  }));
}
