/**
 * Knowledge-store backfill (design §15; build plan KS-0 item 8). Run at startup, after migrations.
 * Idempotent and incremental: every step only touches rows that still miss what it adds, so a
 * second run changes nothing, and rows written by code paths that predate the knowledge store
 * (before KS-1 / KS-2 / KS-3 wire their save paths) are completed at the next start.
 *
 * Steps, in one transaction:
 * 1. Invariant rows: a capture, a `home` scope row and an `artifact_texts` row (`pending`, so the
 *    extraction queue picks it up) per artifact; a `home` scope row, lineage and first-seen time per
 *    finding; `last_confirmed_at` = `created_at` for verified findings never confirmed since.
 * 2. `url_key` on artifacts and captures (`urlKey`, http(s) only).
 * 3. `upload_derived` (+ `upload_cause`): artifacts the export treats as internal uploads
 *    (`internalUploadIds`: kind `upload` plus profile-linked ids), their text duplicates, chunks,
 *    findings citing any flagged artifact (evidence, `finding_evidence`, any observation) and later
 *    versions of those lineages — the same rules as the migration-18 triggers, so a store written
 *    while a rule was missing is repaired at the next start. Only ever sets 1.
 * 4. Entities (per tree root): competitors → `competitor`, personas → `persona` (named by segment),
 *    symptoms → `symptom` (strengths → `topic`); finding subjects → an existing competitor /
 *    persona / company entity with that key in the tree, else a `company` entity when the subject is
 *    a node's scope name, else a `topic`. Only rows without `entity_id` are resolved, so user merges
 *    and renames are never undone (lookups follow `merged_into_id` and match aliases).
 */
import type { Store } from '../store/db.js';
import { internalUploadIds } from '../scoring/export.js';
import type { EntityKind } from '../config/schema.js';
import { descendants, rootOf, scopeOf } from '../workspace/tree.js';
import { ensureEntity, entityNameKey, findEntityByKey } from './entityKeys.js';
import { urlKey } from './extract/index.js';

export type BackfillReport = {
  /** Captures added for artifacts without any. */
  captures: number;
  /** `home` scope rows added for findings / artifacts without any scope row. */
  scopes: number;
  /** `artifact_texts` rows added. */
  texts: number;
  /** Findings whose lineage / first-seen / last-confirmed time was filled. */
  lineages: number;
  /** Artifacts and captures that got a `url_key`. */
  urlKeys: number;
  entities: number;
  linked: { competitors: number; personas: number; symptoms: number; findings: number };
  /** Rows newly flagged (including trigger cascades). */
  uploadDerived: { artifacts: number; findings: number; chunks: number };
};

/** Finding subjects resolve to an existing entity of these kinds first (KS-3 rule), in this order. */
export const SUBJECT_ENTITY_KINDS: readonly EntityKind[] = ['competitor', 'persona', 'company'];

const changes = (store: Store, sql: string, ...params: string[]): number => Number(store.db.prepare(sql).run(...params).changes);
const flagged = (store: Store, table: 'artifacts' | 'findings' | 'chunks'): number =>
  Number((store.db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE upload_derived = 1`).get() as { n: number }).n);

function invariantRows(store: Store, r: BackfillReport): void {
  r.captures = changes(
    store,
    `INSERT OR IGNORE INTO artifact_captures (id, artifact_id, workspace_id, source_url, title, flow, step, note, description, captured_at)
     SELECT CASE WHEN a.id LIKE 'art!_%' ESCAPE '!' THEN 'cap_' || substr(a.id, 5) ELSE 'cap_' || a.id END,
       a.id, a.workspace_id, a.source_url, a.title, a.flow, a.step, a.note, a.description, a.captured_at
     FROM artifacts a WHERE NOT EXISTS (SELECT 1 FROM artifact_captures c WHERE c.artifact_id = a.id) ORDER BY a.rowid`,
  );
  r.scopes =
    changes(
      store,
      `INSERT OR IGNORE INTO item_scopes (item_kind, item_id, workspace_id, source)
       SELECT 'fact', f.id, f.workspace_id, 'home' FROM findings f
       WHERE NOT EXISTS (SELECT 1 FROM item_scopes s WHERE s.item_kind = 'fact' AND s.item_id = f.id) ORDER BY f.rowid`,
    ) +
    changes(
      store,
      `INSERT OR IGNORE INTO item_scopes (item_kind, item_id, workspace_id, source)
       SELECT 'artifact', a.id, a.workspace_id, 'home' FROM artifacts a
       WHERE NOT EXISTS (SELECT 1 FROM item_scopes s WHERE s.item_kind = 'artifact' AND s.item_id = a.id) ORDER BY a.rowid`,
    );
  r.texts = changes(
    store,
    `INSERT OR IGNORE INTO artifact_texts (artifact_id, workspace_id, status)
     SELECT a.id, a.workspace_id, 'pending' FROM artifacts a
     WHERE NOT EXISTS (SELECT 1 FROM artifact_texts t WHERE t.artifact_id = a.id) ORDER BY a.rowid`,
  );
  r.lineages =
    changes(
      store,
      `UPDATE findings SET lineage_id = COALESCE(lineage_id, id), first_seen_at = COALESCE(first_seen_at, created_at)
       WHERE lineage_id IS NULL OR first_seen_at IS NULL`,
    ) +
    changes(
      store,
      `UPDATE findings SET last_confirmed_at = created_at
       WHERE status = 'verified' AND last_confirmed_at IS NULL AND confirm_count = 0`,
    );
}

function urlKeys(store: Store, r: BackfillReport): void {
  for (const table of ['artifacts', 'artifact_captures'] as const) {
    const rows = store.db
      .prepare(`SELECT id, source_url FROM ${table} WHERE url_key IS NULL AND source_url IS NOT NULL`)
      .all() as Array<{ id: string; source_url: string }>;
    const update = store.db.prepare(`UPDATE ${table} SET url_key = ? WHERE id = ?`);
    for (const row of rows) {
      const key = urlKey(row.source_url);
      if (key !== undefined) r.urlKeys += Number(update.run(key, row.id).changes);
    }
  }
}

/** Same rules as the migration-18 triggers (see there), applied to every row still unflagged. */
const UPLOAD_PROPAGATION = [
  `UPDATE artifacts SET upload_derived = 1, upload_cause = COALESCE(upload_cause, (
     SELECT 'duplicate_of:' || t.duplicate_of FROM artifact_texts t JOIN artifacts c ON c.id = t.duplicate_of
     WHERE t.artifact_id = artifacts.id AND c.upload_derived = 1))
   WHERE upload_derived = 0 AND id IN (
     SELECT t.artifact_id FROM artifact_texts t JOIN artifacts c ON c.id = t.duplicate_of WHERE c.upload_derived = 1)`,
  `UPDATE chunks SET upload_derived = 1
   WHERE upload_derived = 0 AND artifact_id IN (SELECT id FROM artifacts WHERE upload_derived = 1)`,
  `UPDATE findings SET upload_derived = 1, upload_cause = COALESCE(upload_cause, (
     SELECT 'evidence:' || a.id FROM json_each(CASE WHEN json_valid(findings.evidence) THEN findings.evidence ELSE '[]' END) j
     JOIN artifacts a ON a.id = j.value WHERE a.upload_derived = 1 LIMIT 1))
   WHERE upload_derived = 0 AND EXISTS (
     SELECT 1 FROM json_each(CASE WHEN json_valid(findings.evidence) THEN findings.evidence ELSE '[]' END) j
     JOIN artifacts a ON a.id = j.value WHERE a.upload_derived = 1)`,
  `UPDATE findings SET upload_derived = 1, upload_cause = COALESCE(upload_cause, (
     SELECT 'finding_evidence:' || a.id FROM finding_evidence fe JOIN artifacts a ON a.id = fe.artifact_id
     WHERE fe.finding_id = findings.id AND a.upload_derived = 1 ORDER BY fe.seq LIMIT 1))
   WHERE upload_derived = 0 AND EXISTS (
     SELECT 1 FROM finding_evidence fe JOIN artifacts a ON a.id = fe.artifact_id
     WHERE fe.finding_id = findings.id AND a.upload_derived = 1)`,
  `UPDATE findings SET upload_derived = 1, upload_cause = COALESCE(upload_cause, (
     SELECT 'observation:' || o.id FROM fact_observations o
     JOIN json_each(CASE WHEN json_valid(o.evidence) THEN o.evidence ELSE '[]' END) j
     JOIN artifacts a ON a.id = j.value
     WHERE o.finding_id = findings.id AND a.upload_derived = 1 ORDER BY o.rowid LIMIT 1))
   WHERE upload_derived = 0 AND EXISTS (
     SELECT 1 FROM fact_observations o
     JOIN json_each(CASE WHEN json_valid(o.evidence) THEN o.evidence ELSE '[]' END) j
     JOIN artifacts a ON a.id = j.value
     WHERE o.finding_id = findings.id AND a.upload_derived = 1)`,
  // Lineage last: any version after a flagged one (one pass suffices: the condition is "any earlier").
  `UPDATE findings SET upload_derived = 1, upload_cause = COALESCE(upload_cause, (
     SELECT 'lineage:' || p.id FROM findings p
     WHERE p.lineage_id = findings.lineage_id AND p.version < findings.version AND p.upload_derived = 1 ORDER BY p.version LIMIT 1))
   WHERE upload_derived = 0 AND EXISTS (
     SELECT 1 FROM findings p WHERE p.lineage_id = findings.lineage_id AND p.version < findings.version AND p.upload_derived = 1)`,
];

function uploadFlags(store: Store, r: BackfillReport): void {
  const before = { artifacts: flagged(store, 'artifacts'), findings: flagged(store, 'findings'), chunks: flagged(store, 'chunks') };
  // Which profile lists an upload (for the cause); the set itself is the export's authority.
  const listedBy = new Map<string, string>();
  for (const p of store.profiles.list()) {
    const u = p.data.uploads;
    if (Array.isArray(u)) for (const id of u) if (typeof id === 'string' && !listedBy.has(id)) listedBy.set(id, p.workspaceId);
  }
  const setArtifact = store.db.prepare(
    'UPDATE artifacts SET upload_derived = 1, upload_cause = COALESCE(upload_cause, ?) WHERE id = ? AND upload_derived = 0',
  );
  for (const id of internalUploadIds(store)) {
    const cause = store.artifacts.get(id)?.kind === 'upload' ? 'kind:upload' : `profile:${listedBy.get(id) ?? ''}`;
    setArtifact.run(cause, id);
  }
  for (const sql of UPLOAD_PROPAGATION) changes(store, sql);
  r.uploadDerived = {
    artifacts: flagged(store, 'artifacts') - before.artifacts,
    findings: flagged(store, 'findings') - before.findings,
    chunks: flagged(store, 'chunks') - before.chunks,
  };
}

function entities(store: Store, r: BackfillReport, now: Date): void {
  const roots = new Map<string, string>();
  const root = (ws: string) => {
    let id = roots.get(ws);
    if (id === undefined) roots.set(ws, (id = rootOf(store, ws)));
    return id;
  };
  const ensure = (ws: string, kind: EntityKind, name: string) => {
    const res = ensureEntity(store, { rootWorkspaceId: root(ws), workspaceId: ws, kind, name, now });
    if (res.created) r.entities++;
    return res.entity;
  };

  for (const c of store.competitors.list({ entityId: null })) {
    if (!entityNameKey(c.name)) continue;
    store.competitors.update(c.id, { entityId: ensure(c.workspaceId, 'competitor', c.name).id });
    r.linked.competitors++;
  }
  for (const p of store.personas.list({ entityId: null })) {
    if (!entityNameKey(p.segment)) continue;
    store.personas.update(p.id, { entityId: ensure(p.workspaceId, 'persona', p.segment).id });
    r.linked.personas++;
  }
  for (const s of store.symptoms.list({ entityId: null })) {
    if (!entityNameKey(s.title)) continue;
    store.symptoms.update(s.id, { entityId: ensure(s.workspaceId, s.kind === 'strength' ? 'topic' : 'symptom', s.title).id });
    r.linked.symptoms++;
  }

  // Scope names of every node, per tree: a finding subject naming a node is about that company.
  const companyNames = new Map<string, Map<string, { ws: string; name: string }[]>>();
  const companiesOf = (rootId: string) => {
    let m = companyNames.get(rootId);
    if (!m) {
      m = new Map();
      for (const w of [store.workspaces.get(rootId), ...descendants(store, rootId)]) {
        if (!w) continue;
        const name = scopeOf(w).name;
        const key = entityNameKey(name);
        if (key) m.set(key, [...(m.get(key) ?? []), { ws: w.id, name }]);
      }
      companyNames.set(rootId, m);
    }
    return m;
  };
  const lineageEntity = store.db.prepare(
    'SELECT entity_id FROM findings WHERE lineage_id = ? AND entity_id IS NOT NULL ORDER BY version DESC LIMIT 1',
  );
  for (const f of store.findings.list({ entityId: null })) {
    const key = entityNameKey(f.subject);
    if (!key) continue;
    const rootId = root(f.workspaceId);
    const fromLineage = f.lineageId ? (lineageEntity.get(f.lineageId) as { entity_id: string } | undefined)?.entity_id : undefined;
    let entityId = fromLineage ?? findEntityByKey(store, rootId, SUBJECT_ENTITY_KINDS, key)?.id;
    if (!entityId) {
      const nodes = companiesOf(rootId).get(key);
      const node = nodes?.find((n) => n.ws === f.workspaceId) ?? nodes?.[0];
      entityId = node ? ensure(node.ws, 'company', node.name).id : ensure(f.workspaceId, 'topic', f.subject).id;
    }
    store.findings.update(f.id, { entityId });
    r.linked.findings++;
  }
}

/** Runs every backfill step (see module doc); returns what changed. Safe to call on every start. */
export function backfillKnowledge(store: Store, now: Date = new Date()): BackfillReport {
  const r: BackfillReport = {
    captures: 0, scopes: 0, texts: 0, lineages: 0, urlKeys: 0, entities: 0,
    linked: { competitors: 0, personas: 0, symptoms: 0, findings: 0 },
    uploadDerived: { artifacts: 0, findings: 0, chunks: 0 },
  };
  store.transaction(() => {
    invariantRows(store, r);
    urlKeys(store, r);
    uploadFlags(store, r);
    entities(store, r, now);
  });
  return r;
}

/** True when a backfill run changed anything (for a startup log line). */
export function backfillChanged(r: BackfillReport): boolean {
  const n = r.captures + r.scopes + r.texts + r.lineages + r.urlKeys + r.entities;
  return n + Object.values(r.linked).reduce((a, b) => a + b, 0) + Object.values(r.uploadDerived).reduce((a, b) => a + b, 0) > 0;
}
