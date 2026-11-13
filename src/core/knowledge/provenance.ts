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
 * Entities and cards are not resolvable here (KS-3 / KS-4 list the facts and records a card or
 * entity line was built from in `result_ids`). Unknown ids are not upload-derived.
 */
import type { Store } from '../store/db.js';
import { knowledgeRepos } from '../store/repos.js';

const flag = (store: Store, table: 'artifacts' | 'chunks' | 'findings', id: string): boolean | undefined => {
  const row = store.db.prepare(`SELECT upload_derived AS d FROM ${table} WHERE id = ?`).get(id) as { d: number } | undefined;
  return row ? row.d === 1 : undefined;
};

/** Ids an item without its own flag rests on; `undefined` when `id` is not such a record. (Exported for KS-2's `explainUploadDerived`.) */
export function evidenceOf(store: Store, id: string): string[] | undefined {
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
  return (evidenceOf(store, id) ?? []).some((e) => itemIsUploadDerived(store, e, seen));
}
