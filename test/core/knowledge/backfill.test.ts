import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { ArtifactStore } from '../../../src/core/evidence/artifacts.js';
import { uploadInternal } from '../../../src/core/internal/uploads.js';
import { backfillKnowledge } from '../../../src/core/knowledge/backfill.js';
import { ensureEntity, entityNameKey, findEntityByKey } from '../../../src/core/knowledge/entityKeys.js';
import { evidenceIncludesUpload, internalUploadIds } from '../../../src/core/scoring/export.js';
import { openStore, type Store } from '../../../src/core/store/db.js';
import { MIGRATIONS } from '../../../src/core/store/migrations.js';
import { knowledgeRepos } from '../../../src/core/store/repos.js';

/** Index of the knowledge store migration (18); never the total count. */
const KS0 = 17;
const opened: Store[] = [];
afterEach(() => {
  for (const s of opened.splice(0)) s.close();
});
const T0 = '2026-11-01T10:00:00.000Z';

/**
 * A pre-KS-0 database: tree A (root ws_a "Acme" → child ws_c "Acme Payments"), tree B (ws_b
 * "Beta"). Competitor Globex in A, persona, symptom + strength, findings whose subjects name the
 * competitor, the company and a topic; a page artifact that is also linked as an upload in a profile
 * (sha dedupe), cited by a finding; a finding of tree B with the subject "Globex".
 */
function legacy(): Store {
  const path = join(mkdtempSync(join(tmpdir(), 'bif-kbf-')), 'bif.db');
  const raw = new DatabaseSync(path);
  for (const [i, m] of MIGRATIONS.slice(0, KS0).entries()) {
    raw.exec(m);
    raw.exec(`PRAGMA user_version = ${i + 1}`);
  }
  const finding = (id: string, ws: string, subject: string, evidence: string[], status = 'verified') =>
    `INSERT INTO findings (id, workspace_id, run_id, task_id, subject, claim, criteria, evidence, status, created_at)
     VALUES ('${id}', '${ws}', 'rrun_1', 'tsk_1', '${subject}', 'claim ${id}', '{}', '${JSON.stringify(evidence)}', '${status}', '${T0}');`;
  raw.exec(`
    INSERT INTO workspaces (id, name, sector, created_at, scope) VALUES ('ws_a', 'Acme', 'saas', '${T0}', '{"level":"company","name":"Acme","description":""}');
    INSERT INTO workspaces (id, name, sector, created_at, scope, parent_workspace_id)
      VALUES ('ws_c', 'Payments', 'saas', '${T0}', '{"level":"division","name":"Acme Payments","description":""}', 'ws_a');
    INSERT INTO workspaces (id, name, sector, created_at, scope) VALUES ('ws_b', 'Beta', 'saas', '${T0}', '{"level":"company","name":"Beta","description":""}');
    INSERT INTO artifacts (id, workspace_id, kind, path, sha256, mime, source_url, title, captured_at)
      VALUES ('art_page', 'ws_a', 'page_snapshot', 'p', 'h1', 'text/html', 'https://www.Example.com/Pricing/?utm_source=x#top', 'Pricing', '${T0}');
    INSERT INTO artifacts (id, workspace_id, kind, path, sha256, mime, source_url, captured_at)
      VALUES ('art_ftp', 'ws_a', 'document', 'p2', 'h2', 'text/plain', 'ftp://files.example.com/a.txt', '${T0}');
    INSERT INTO artifacts (id, workspace_id, kind, path, sha256, mime, title, captured_at)
      VALUES ('art_up', 'ws_b', 'upload', 'p3', 'h3', 'text/csv', 'KPIs', '${T0}');
    INSERT INTO profiles (workspace_id, data) VALUES ('ws_a', '{"uploads":["art_page"]}');
    INSERT INTO competitors (id, workspace_id, name, threat, directness, comparison, evidence, created_at, updated_at)
      VALUES ('cmp_1', 'ws_a', 'Globex', 4, 5, '{}', '[]', '${T0}', '${T0}');
    INSERT INTO personas (id, workspace_id, slug, segment, profile, agent_md_path, version)
      VALUES ('per_1', 'ws_c', 'ops-olivia', 'Operations leads', '{}', 'x.md', 1);
    INSERT INTO symptoms (id, workspace_id, kind, title, detail, criteria, evidence) VALUES ('sym_1', 'ws_a', 'symptom', 'Churn up', 'd', '{}', '[]');
    INSERT INTO symptoms (id, workspace_id, kind, title, detail, criteria, evidence) VALUES ('sym_2', 'ws_a', 'strength', 'Fast support', 'd', '{}', '[]');
    ${finding('fnd_globex', 'ws_c', ' GLOBEX ', ['art_page'])}
    ${finding('fnd_acme', 'ws_a', 'Acme', [])}
    ${finding('fnd_pay', 'ws_c', 'Acme  Payments', [], 'pending')}
    ${finding('fnd_t1', 'ws_a', 'Pricing pages', ['art_ftp'])}
    ${finding('fnd_t2', 'ws_c', 'pricing   PAGES', [])}
    ${finding('fnd_b', 'ws_b', 'Globex', ['art_up'])}
  `);
  raw.close();
  const s = openStore(path);
  opened.push(s);
  return s;
}

/** Every row of every table the backfill writes, for idempotency comparisons. */
function snapshot(s: Store) {
  const q = (sql: string) => s.db.prepare(sql).all();
  return {
    artifacts: q('SELECT id, url_key, upload_derived FROM artifacts ORDER BY id'),
    findings: q('SELECT id, lineage_id, first_seen_at, last_confirmed_at, entity_id, upload_derived FROM findings ORDER BY id'),
    captures: q('SELECT * FROM artifact_captures ORDER BY id'),
    texts: q('SELECT * FROM artifact_texts ORDER BY artifact_id'),
    scopes: q('SELECT * FROM item_scopes ORDER BY item_kind, item_id, workspace_id'),
    entities: q('SELECT * FROM entities ORDER BY id'),
    typed: q(`SELECT 'c', id, entity_id FROM competitors UNION ALL SELECT 'p', id, entity_id FROM personas
              UNION ALL SELECT 's', id, entity_id FROM symptoms ORDER BY 1, 2`),
  };
}

describe('knowledge backfill (KS-0)', () => {
  it('computes url keys for artifacts and their captures (http(s) only)', () => {
    const s = legacy();
    backfillKnowledge(s);
    expect(s.artifacts.get('art_page')!.urlKey).toBe('https://example.com/Pricing');
    expect(s.artifacts.get('art_ftp')!.urlKey).toBeUndefined();
    expect(knowledgeRepos(s).artifactCaptures.list({ artifactId: 'art_page' })[0]!.urlKey).toBe('https://example.com/Pricing');
  });

  it('materializes upload_derived exactly as the export expands upload references', () => {
    const s = legacy();
    backfillKnowledge(s);
    expect(s.artifacts.get('art_page')!.uploadDerived).toBe(true); // profile-linked (sha-deduped upload)
    expect(s.artifacts.get('art_up')!.uploadDerived).toBe(true);
    expect(s.artifacts.get('art_ftp')!.uploadDerived).toBe(false);
    const uploads = internalUploadIds(s);
    for (const a of s.artifacts.list()) expect(a.uploadDerived, a.id).toBe(uploads.has(a.id));
    for (const f of s.findings.list()) expect(f.uploadDerived, f.id).toBe(evidenceIncludesUpload(s, f.id, uploads));
    expect(s.findings.list().filter((f) => f.uploadDerived).map((f) => f.id).sort()).toEqual(['fnd_b', 'fnd_globex']);
  });

  it('creates per-tree entities from typed records and finding subjects, and links them', () => {
    const s = legacy();
    const report = backfillKnowledge(s);
    const k = knowledgeRepos(s);
    const ent = (id: string | undefined) => (id ? k.entities.get(id) : undefined);

    const globex = ent(s.competitors.get('cmp_1')!.entityId)!;
    expect(globex).toMatchObject({ rootWorkspaceId: 'ws_a', workspaceId: 'ws_a', kind: 'competitor', name: 'Globex', nameKey: 'globex', aliases: [] });
    expect(ent(s.personas.get('per_1')!.entityId)).toMatchObject({ rootWorkspaceId: 'ws_a', workspaceId: 'ws_c', kind: 'persona', name: 'Operations leads' });
    expect(ent(s.symptoms.get('sym_1')!.entityId)).toMatchObject({ kind: 'symptom', name: 'Churn up' });
    expect(ent(s.symptoms.get('sym_2')!.entityId)).toMatchObject({ kind: 'topic', name: 'Fast support' });

    // Finding subjects: competitor of the same tree (from a child node), company scope names, topics.
    expect(s.findings.get('fnd_globex')!.entityId).toBe(globex.id);
    expect(ent(s.findings.get('fnd_acme')!.entityId)).toMatchObject({ kind: 'company', name: 'Acme', workspaceId: 'ws_a' });
    expect(ent(s.findings.get('fnd_pay')!.entityId)).toMatchObject({ kind: 'company', name: 'Acme Payments', workspaceId: 'ws_c' });
    const topic = ent(s.findings.get('fnd_t1')!.entityId)!;
    expect(topic).toMatchObject({ kind: 'topic', name: 'Pricing pages', nameKey: 'pricing pages' });
    expect(s.findings.get('fnd_t2')!.entityId).toBe(topic.id); // distinct subjects by key, tree-wide

    // Tree B never sees tree A's entities: its "Globex" is its own topic.
    const b = ent(s.findings.get('fnd_b')!.entityId)!;
    expect(b).toMatchObject({ rootWorkspaceId: 'ws_b', kind: 'topic', name: 'Globex' });
    expect(b.id).not.toBe(globex.id);

    expect(report.entities).toBe(k.entities.list().length);
    expect(k.entities.list().every((e) => e.nameKey === entityNameKey(e.name))).toBe(true);
    // Entities are searchable by trigram.
    expect(s.db.prepare(`SELECT rowid FROM entities_fts WHERE entities_fts MATCH 'lobe'`).all()).toHaveLength(2);
  });

  it('repairs missing invariant rows and is idempotent (twice = same result, nothing to do)', () => {
    const s = legacy();
    // Rows a pre-KS-1 code path or a crash could leave without their companions.
    s.db.exec(`DELETE FROM artifact_captures WHERE artifact_id = 'art_ftp'`);
    s.db.exec(`DELETE FROM item_scopes WHERE item_id IN ('fnd_acme', 'art_up')`);
    s.db.exec(`DELETE FROM artifact_texts WHERE artifact_id = 'art_page'`);
    const first = backfillKnowledge(s);
    expect(first).toMatchObject({ captures: 1, scopes: 2, texts: 1 });
    expect(knowledgeRepos(s).artifactCaptures.list({ artifactId: 'art_ftp' })).toHaveLength(1);
    expect(knowledgeRepos(s).itemScopes.list({ itemId: 'fnd_acme' })).toEqual([{ itemKind: 'fact', itemId: 'fnd_acme', workspaceId: 'ws_a', source: 'home' }]);
    expect(knowledgeRepos(s).artifactTexts.get('art_page')!.status).toBe('pending');

    const before = snapshot(s);
    const second = backfillKnowledge(s);
    expect(snapshot(s)).toEqual(before);
    expect(second).toEqual({
      captures: 0, scopes: 0, texts: 0, lineages: 0, urlKeys: 0, entities: 0,
      linked: { competitors: 0, personas: 0, symptoms: 0, findings: 0 },
      uploadDerived: { artifacts: 0, findings: 0, chunks: 0 },
    });
  });

  it('keeps user edits: a merged or renamed entity is never recreated', () => {
    const s = legacy();
    backfillKnowledge(s);
    const k = knowledgeRepos(s);
    const topicId = s.findings.get('fnd_t1')!.entityId!;
    // The user merges the topic into the competitor (KS-3 does this; simulated here).
    const globexId = s.competitors.get('cmp_1')!.entityId!;
    k.entities.update(topicId, { mergedIntoId: globexId });
    k.entities.update(globexId, { aliases: ['Pricing pages'] });
    s.findings.insert({
      id: 'fnd_new', workspaceId: 'ws_a', runId: 'r', taskId: 't', subject: 'pricing pages', claim: 'c', criteria: {}, evidence: [],
      status: 'pending', createdAt: T0,
    });
    const n = k.entities.list().length;
    backfillKnowledge(s);
    expect(k.entities.list()).toHaveLength(n);
    expect(s.findings.get('fnd_new')!.entityId).toBe(globexId); // resolved to the survivor
  });
});

describe('upload_derived in normal operation (design §12)', () => {
  it('triggers keep the flag equal to the export expansion when an upload dedupes onto a cited page', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bif-kup-'));
    const s = openStore(join(dir, 'bif.db'));
    opened.push(s);
    const artifacts = new ArtifactStore(s, dir);
    s.workspaces.insert({ id: 'ws_a', name: 'Acme', sector: 'saas', createdAt: T0 });
    const page = artifacts.save({ workspaceId: 'ws_a', kind: 'page_snapshot', mime: 'text/html', bytes: '<p>KPI table</p>' });
    const other = artifacts.save({ workspaceId: 'ws_a', kind: 'page_snapshot', mime: 'text/html', bytes: '<p>public</p>' });
    const cite = (id: string, evidence: string[]) =>
      s.findings.insert({ id, workspaceId: 'ws_a', runId: 'r', taskId: 't', subject: 'Acme', claim: id, criteria: {}, evidence, status: 'verified', createdAt: T0 });
    cite('fnd_page', [page.id]);
    cite('fnd_other', [other.id]);
    s.findings.insert({
      id: 'fnd_page_v2', workspaceId: 'ws_a', runId: 'r', taskId: 't2', subject: 'Acme', claim: 'v2', criteria: {}, evidence: [other.id],
      status: 'pending', createdAt: T0, lineageId: 'fnd_page', version: 2, replacesId: 'fnd_page', lifecycle: 'candidate',
    });
    const agree = () => {
      const uploads = internalUploadIds(s);
      for (const a of s.artifacts.list()) expect(a.uploadDerived, a.id).toBe(uploads.has(a.id));
      for (const f of s.findings.list().filter((x) => x.version === 1)) expect(f.uploadDerived, f.id).toBe(evidenceIncludesUpload(s, f.id, uploads));
    };
    agree();
    expect(s.findings.list().some((f) => f.uploadDerived)).toBe(false);
    // The user uploads the same bytes: the existing page artifact is now an internal upload.
    const up = uploadInternal('ws_a', { name: 'kpi.html', bytes: new TextEncoder().encode('<p>KPI table</p>'), mime: 'text/html' }, { store: s, artifacts });
    expect(up.id).toBe(page.id);
    agree();
    expect(s.findings.get('fnd_page')!.uploadDerived).toBe(true);
    expect(s.findings.get('fnd_page_v2')!.uploadDerived).toBe(true); // sticky along the lineage
    expect(s.findings.get('fnd_other')!.uploadDerived).toBe(false);
    expect(backfillKnowledge(s).uploadDerived).toEqual({ artifacts: 0, findings: 0, chunks: 0 }); // nothing left to do
  });
});

describe('entity keys (KS-0 seam for KS-3)', () => {
  it('ensureEntity: exact key or alias within the tree and kind, else create; merged entities resolve to the survivor', () => {
    const s = legacy();
    const a = ensureEntity(s, { rootWorkspaceId: 'ws_a', workspaceId: 'ws_a', kind: 'product', name: 'Widget Pro' });
    expect(a.created).toBe(true);
    expect(ensureEntity(s, { rootWorkspaceId: 'ws_a', workspaceId: 'ws_c', kind: 'product', name: '  widget   PRO ' })).toEqual({ entity: a.entity, created: false });
    expect(ensureEntity(s, { rootWorkspaceId: 'ws_b', workspaceId: 'ws_b', kind: 'product', name: 'Widget Pro' }).created).toBe(true);
    expect(ensureEntity(s, { rootWorkspaceId: 'ws_a', workspaceId: 'ws_a', kind: 'feature', name: 'Widget Pro' }).created).toBe(true);
    knowledgeRepos(s).entities.update(a.entity.id, { aliases: ['WPro'] });
    expect(findEntityByKey(s, 'ws_a', ['product'], entityNameKey('wpro'))!.id).toBe(a.entity.id);
    expect(findEntityByKey(s, 'ws_b', ['product'], entityNameKey('wpro'))).toBeUndefined();
    const b = ensureEntity(s, { rootWorkspaceId: 'ws_a', workspaceId: 'ws_a', kind: 'product', name: 'Widget Max' }).entity;
    knowledgeRepos(s).entities.update(b.id, { mergedIntoId: a.entity.id });
    expect(ensureEntity(s, { rootWorkspaceId: 'ws_a', workspaceId: 'ws_a', kind: 'product', name: 'widget max' }).entity.id).toBe(a.entity.id);
  });
});
