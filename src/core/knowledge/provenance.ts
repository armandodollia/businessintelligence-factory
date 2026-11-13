/**
 * Upload provenance of any item, resolved from the CURRENT materialized flags (design §12).
 *
 * Artifacts, chunks and findings carry `upload_derived` (kept by the migration-18 triggers and the
 * backfill, never reset). Records without a flag column are resolved through their evidence, so a
 * late classification (an artifact listed as an upload after the record was saved) is seen at
 * check time:
 * - fact observation → its fact, or any artifact it cites;
 * - competitor, symptom, unit proposal → `evidence` (artifact or finding ids);
 * - symptom hypothesis → `evidence` (finding or artifact ids);
 * - persona → every profile field's `evidence`;
 * - recommendation → `findingIds`.
 * - entity → `entityIsUploadOnly` (KS-3, below); entity merge suggestion → either of its entities.
 * Cards are not resolvable here (KS-4 lists the facts, records and entities a card was built from in
 * `result_ids`). Unknown ids are not upload-derived.
 */
import type { Store } from '../store/db.js';
import { knowledgeRepos } from '../store/repos.js';
import type { Entity } from '../types.js';
import { descendants, scopeOf } from '../workspace/tree.js';
import { entityNameKey } from './entityKeys.js';
import { factUsableSql, outputUsableSql, sourceUsableSql } from './usable.js';

const flag = (store: Store, table: 'artifacts' | 'chunks' | 'findings', id: string): boolean | undefined => {
  const row = store.db.prepare(`SELECT upload_derived AS d FROM ${table} WHERE id = ?`).get(id) as { d: number } | undefined;
  return row ? row.d === 1 : undefined;
};

/** Ids an item without its own flag rests on; `undefined` when `id` is not such a record. */
function evidenceOf(store: Store, id: string): string[] | undefined {
  const obs = knowledgeRepos(store).factObservations.get(id);
  if (obs) return [obs.findingId, ...obs.evidence];
  const c = store.competitors.get(id);
  if (c) return c.evidence;
  const s = store.symptoms.get(id);
  if (s) return s.evidence;
  const h = store.symptomHypotheses.get(id);
  if (h) return h.evidence;
  const p = store.personas.get(id);
  if (p) return Object.values(p.profile ?? {}).flatMap((f) => (Array.isArray(f?.evidence) ? f.evidence : []));
  const r = store.recommendations.get(id);
  if (r) return r.findingIds;
  const u = store.unitProposals.get(id);
  if (u) return u.evidence;
  return undefined;
}

/** Whether item `id` is upload-derived now (see module doc). Cycle-safe. */
export function itemIsUploadDerived(store: Store, id: string, seen: Set<string> = new Set()): boolean {
  if (seen.has(id)) return false;
  seen.add(id);
  const own = flag(store, 'artifacts', id) ?? flag(store, 'findings', id);
  if (own !== undefined) return own;
  const chunk = store.db.prepare('SELECT upload_derived AS d, artifact_id AS a FROM chunks WHERE id = ?').get(id) as
    | { d: number; a: string }
    | undefined;
  if (chunk) return chunk.d === 1 || flag(store, 'artifacts', chunk.a) === true;
  const evidence = evidenceOf(store, id);
  if (evidence) return evidence.some((e) => itemIsUploadDerived(store, e, seen));
  // KS-3: entity ids (their names) and merge suggestions resolve through the entity rule.
  return entityUploadStatus(store, id) ?? suggestionUploadStatus(store, id) ?? false;
}

// ---------------------------------------------------------------------------
// Knowledge store KS-3: upload-only entity names (design §12; design-thread ruling 5 after the KS-0
// gate). No stored flag: resolved at check time from the current record flags, like the records
// above.

/** A record that references an entity: by `entity_id`, or as the source of an edge touching it. */
export type EntityReference = {
  kind: 'fact' | 'competitor' | 'persona' | 'symptom' | 'hypothesis' | 'capture' | 'relation';
  /** The referencing row (capture or relation id for those kinds). */
  id: string;
  /** The record whose provenance counts: the row itself, a capture's artifact, an edge's source. */
  recordId: string;
  /** Upload-derived now (`itemIsUploadDerived` of `recordId`). */
  derived: boolean;
  /** Usable now (`usable.ts`: current verified / included facts and outputs; symptoms, artifacts). */
  usable: boolean;
};

const GROUP_CTE = `WITH RECURSIVE grp(id) AS (
  SELECT ? UNION SELECT e.id FROM entities e JOIN grp ON e.merged_into_id = grp.id)`;

/**
 * Every record that references entity `entityId` or a row merged into it: facts (any lifecycle),
 * competitors, personas, symptoms, symptom hypotheses, captures, and the source record of every edge
 * from or to it.
 */
export function entityReferences(store: Store, entityId: string): EntityReference[] {
  const out: EntityReference[] = [];
  const typed = [
    ['fact', 'findings', factUsableSql('t')],
    ['competitor', 'competitors', outputUsableSql('t')],
    ['persona', 'personas', outputUsableSql('t')],
    ['symptom', 'symptoms', '1'],
    ['hypothesis', 'symptom_hypotheses', outputUsableSql('t')],
  ] as const;
  for (const [kind, table, usable] of typed) {
    const rows = store.db
      .prepare(`${GROUP_CTE} SELECT t.id AS id, ${usable} AS usable FROM ${table} t WHERE t.entity_id IN (SELECT id FROM grp) ORDER BY t.rowid`)
      .all(entityId) as Array<{ id: string; usable: number }>;
    for (const r of rows) out.push({ kind, id: r.id, recordId: r.id, derived: itemIsUploadDerived(store, r.id), usable: r.usable === 1 });
  }
  const captures = store.db
    .prepare(`${GROUP_CTE} SELECT c.id AS id, c.artifact_id AS a FROM artifact_captures c WHERE c.entity_id IN (SELECT id FROM grp) ORDER BY c.rowid`)
    .all(entityId) as Array<{ id: string; a: string }>;
  for (const c of captures) {
    out.push({ kind: 'capture', id: c.id, recordId: c.a, derived: itemIsUploadDerived(store, c.a), usable: !!store.artifacts.get(c.a) });
  }
  const edges = store.db
    .prepare(
      `${GROUP_CTE} SELECT r.id AS id, r.source_id AS src, ${sourceUsableSql('r.source_kind', 'r.source_id')} AS usable FROM relations r
       WHERE r.from_entity_id IN (SELECT id FROM grp) OR r.to_entity_id IN (SELECT id FROM grp) ORDER BY r.rowid`,
    )
    .all(entityId) as Array<{ id: string; src: string; usable: number }>;
  for (const e of edges) out.push({ kind: 'relation', id: e.id, recordId: e.src, derived: itemIsUploadDerived(store, e.src), usable: e.usable === 1 });
  return out;
}

/** True when `entity` is a `company` entity named like a node of its tree (scope names are user-entered). */
function isScopeCompany(store: Store, entity: Entity): boolean {
  if (entity.kind !== 'company') return false;
  const root = store.workspaces.get(entity.rootWorkspaceId);
  if (!root) return false;
  return [root, ...descendants(store, root.id)].some((w) => entityNameKey(scopeOf(w).name) === entity.nameKey);
}

/**
 * Whether entity `entityId`'s name is upload-only now (ruling 5): every record that references it is
 * upload-derived, so the name itself came only from uploads and must be treated like upload text.
 * - One non-derived, usable reference makes the name publicly attested (not upload-only).
 * - No references at all, or only non-derived ones not yet usable: not upload-only (the name did not
 *   come from an upload). A company entity named after a node of its tree is never upload-only.
 * - A merged row (an alias of its survivor): upload-only unless its name was taken into the
 *   survivor's public `aliases` at merge / rename time (`mergeEntities`, `renameEntity` keep an
 *   upload-only name on this row only); a name equal to the survivor's follows the survivor.
 * Unknown ids: false.
 */
export function entityIsUploadOnly(store: Store, entityId: string): boolean {
  return entityUploadStatus(store, entityId) ?? false;
}

/** `entityIsUploadOnly`, or `undefined` when `id` is not an entity. */
function entityUploadStatus(store: Store, id: string, depth = 0): boolean | undefined {
  const entity = knowledgeRepos(store).entities.get(id);
  if (!entity) return undefined;
  if (entity.mergedIntoId && depth < 32) {
    const target = knowledgeRepos(store).entities.get(entity.mergedIntoId);
    if (target) {
      if (target.nameKey === entity.nameKey) return entityUploadStatus(store, target.id, depth + 1);
      return !target.aliases.some((a) => entityNameKey(a) === entity.nameKey);
    }
  }
  if (isScopeCompany(store, entity)) return false;
  const refs = entityReferences(store, entity.id);
  if (refs.some((r) => !r.derived && r.usable)) return false;
  return refs.some((r) => r.derived);
}

/** A merge suggestion is upload-derived when either of its entities is upload-only; `undefined` if not a suggestion. */
function suggestionUploadStatus(store: Store, id: string): boolean | undefined {
  const s = knowledgeRepos(store).entityMergeSuggestions.get(id);
  if (!s) return undefined;
  return entityIsUploadOnly(store, s.entityId) || entityIsUploadOnly(store, s.candidateId);
}

/** Whether merge suggestion `id` involves an upload-only entity (ruling 5: suggestions follow the entity rule). */
export function mergeSuggestionIsUploadOnly(store: Store, id: string): boolean {
  return suggestionUploadStatus(store, id) ?? false;
}
// --- end knowledge store KS-3 ----------------------------------------------------------------------
