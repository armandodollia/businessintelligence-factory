import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { openStore, type Store } from '../../../src/core/store/db.js';
import { MIGRATIONS } from '../../../src/core/store/migrations.js';

/** Knowledge store KS-0: migration 18 (index 17). Never asserts the total migration count. */
const KS0 = 17;

const opened: Store[] = [];
afterEach(() => {
  for (const s of opened.splice(0)) s.close();
});

const T0 = '2026-11-01T10:00:00.000Z';
const T1 = '2026-11-02T10:00:00.000Z';
const ART_PAGE = 'art_01HZZZZZZZZZZZZZZZZZZZZZZA';
const ART_UPLOAD = 'art_01HZZZZZZZZZZZZZZZZZZZZZZB';

/** A database at the version just before KS-0, with rows in every table the migration touches. */
function legacyDb(): string {
  const dir = mkdtempSync(join(tmpdir(), 'bif-m18-'));
  const path = join(dir, 'bif.db');
  const raw = new DatabaseSync(path);
  for (const [i, m] of MIGRATIONS.slice(0, KS0).entries()) {
    raw.exec(m);
    raw.exec(`PRAGMA user_version = ${i + 1}`);
  }
  raw.exec(`
    INSERT INTO workspaces (id, name, sector, created_at) VALUES ('ws_a', 'Acme', 'saas', '${T0}');
    INSERT INTO artifacts (id, workspace_id, kind, path, sha256, mime, source_url, title, flow, step, note, captured_at)
      VALUES ('${ART_PAGE}', 'ws_a', 'page_snapshot', 'p/a.html', 'sha_a', 'text/html', 'https://www.example.com/pricing?utm_source=x',
              'Pricing page', 'checkout', 2, 'plans visible', '${T0}');
    INSERT INTO artifacts (id, workspace_id, kind, path, sha256, mime, title, captured_at)
      VALUES ('${ART_UPLOAD}', 'ws_a', 'upload', 'p/kpi.csv', 'sha_b', 'text/csv', 'KPI export', '${T1}');
    INSERT INTO findings (id, workspace_id, run_id, task_id, subject, claim, criteria, evidence, status, created_at)
      VALUES ('fnd_v', 'ws_a', 'rrun_1', 'tsk_1', 'Acme', 'Acme raised prices for the team plan', '{}', '["${ART_PAGE}"]', 'verified', '${T0}');
    INSERT INTO findings (id, workspace_id, run_id, task_id, subject, claim, criteria, evidence, status, created_at)
      VALUES ('fnd_p', 'ws_a', 'rrun_1', 'tsk_1', 'Churn', 'Churn doubled in Q3', '{}', '["${ART_UPLOAD}"]', 'pending', '${T1}');
    INSERT INTO competitors (id, workspace_id, name, threat, directness, comparison, evidence, created_at, updated_at)
      VALUES ('cmp_1', 'ws_a', 'Globex', 4, 5, '{}', '[]', '${T0}', '${T0}');
  `);
  raw.close();
  return path;
}

function open(path: string): Store {
  const s = openStore(path);
  opened.push(s);
  return s;
}

const all = (s: Store, sql: string, ...p: Array<string | number>) => s.db.prepare(sql).all(...p) as Array<Record<string, unknown>>;
const one = (s: Store, sql: string, ...p: Array<string | number>) => s.db.prepare(sql).get(...p) as Record<string, unknown> | undefined;
const cols = (s: Store, t: string) => all(s, `PRAGMA table_info(${t})`).map((c) => c.name);

describe('migration 18 (knowledge store KS-0)', () => {
  it('is the knowledge store migration and creates every table and column of the contract', () => {
    expect(MIGRATIONS[KS0]).toMatch(/CREATE TABLE artifact_captures/);
    const s = open(legacyDb());
    expect(s.schemaVersion()).toBe(MIGRATIONS.length);
    expect(cols(s, 'artifacts')).toEqual(expect.arrayContaining(['description', 'url_key', 'upload_derived']));
    expect(cols(s, 'findings')).toEqual(expect.arrayContaining([
      'lineage_id', 'version', 'replaces_id', 'lifecycle', 'entity_id', 'first_seen_at', 'last_confirmed_at', 'confirm_count',
      'ttl_days', 'upload_derived', 'lineage_conflict',
    ]));
    for (const t of ['competitors', 'personas', 'symptoms', 'symptom_hypotheses']) expect(cols(s, t)).toContain('entity_id');
    const tables: Record<string, string[]> = {
      artifact_captures: ['id', 'artifact_id', 'workspace_id', 'agent_run_id', 'task_id', 'run_id', 'source_url', 'url_key', 'title', 'flow', 'step', 'note', 'description', 'entity_id', 'captured_at'],
      artifact_texts: ['artifact_id', 'workspace_id', 'status', 'extractor', 'error', 'char_count', 'token_estimate', 'content_sha256', 'duplicate_of', 'extracted_at'],
      chunks: ['id', 'artifact_id', 'workspace_id', 'seq', 'heading_path', 'locator', 'text', 'char_start', 'char_end', 'token_estimate', 'upload_derived'],
      finding_evidence: ['finding_id', 'seq', 'artifact_id', 'chunk_id', 'quote', 'char_start', 'char_end'],
      fact_observations: ['id', 'workspace_id', 'lineage_id', 'finding_id', 'prior_finding_id', 'kind', 'run_id', 'task_id', 'agent_run_id', 'task_round', 'evidence', 'reason', 'status', 'created_at', 'applied_at'],
      item_scopes: ['item_kind', 'item_id', 'workspace_id', 'source'],
      entities: ['id', 'root_workspace_id', 'workspace_id', 'kind', 'name', 'name_key', 'aliases', 'merged_into_id', 'created_by_run', 'created_at', 'updated_at'],
      relations: ['id', 'root_workspace_id', 'from_entity_id', 'type', 'to_entity_id', 'source_kind', 'source_id', 'created_at'],
      entity_merge_suggestions: ['id', 'root_workspace_id', 'entity_id', 'candidate_id', 'score', 'status', 'created_at', 'decided_at', 'actor'],
      retrieval_events: ['id', 'workspace_id', 'root_workspace_id', 'agent_run_id', 'task_id', 'role', 'provider', 'model', 'prompt_version', 'tool', 'query', 'scope', 'result_ids', 'result_count', 'tokens_returned', 'truncated', 'relaxed', 'latency_ms', 'upload_derived', 'created_at'],
      retrieval_uses: ['retrieval_event_id', 'item_id', 'used_by_kind', 'used_by_id', 'created_at'],
    };
    for (const [t, c] of Object.entries(tables)) expect(cols(s, t)).toEqual(c);
    for (const t of ['findings_fts', 'chunks_fts', 'artifacts_fts', 'entities_fts']) {
      expect(one(s, `SELECT name FROM sqlite_master WHERE name = ?`, t)).toBeDefined();
    }
  });

  it('backfills existing rows: upload flag, captures, pending texts, lineage, scope rows', () => {
    const s = open(legacyDb());
    expect(all(s, 'SELECT id, upload_derived FROM artifacts ORDER BY rowid')).toEqual([
      { id: ART_PAGE, upload_derived: 0 },
      { id: ART_UPLOAD, upload_derived: 1 },
    ]);
    expect(all(s, 'SELECT * FROM artifact_captures ORDER BY rowid')).toEqual([
      {
        id: 'cap_01HZZZZZZZZZZZZZZZZZZZZZZA', artifact_id: ART_PAGE, workspace_id: 'ws_a', agent_run_id: null, task_id: null, run_id: null,
        source_url: 'https://www.example.com/pricing?utm_source=x', url_key: null, title: 'Pricing page', flow: 'checkout', step: 2,
        note: 'plans visible', description: null, entity_id: null, captured_at: T0,
      },
      expect.objectContaining({ id: 'cap_01HZZZZZZZZZZZZZZZZZZZZZZB', artifact_id: ART_UPLOAD, captured_at: T1 }),
    ]);
    expect(all(s, 'SELECT artifact_id, workspace_id, status, char_count FROM artifact_texts ORDER BY rowid')).toEqual([
      { artifact_id: ART_PAGE, workspace_id: 'ws_a', status: 'pending', char_count: 0 },
      { artifact_id: ART_UPLOAD, workspace_id: 'ws_a', status: 'pending', char_count: 0 },
    ]);
    expect(all(s, 'SELECT id, lineage_id, version, lifecycle, first_seen_at, last_confirmed_at, confirm_count, lineage_conflict FROM findings ORDER BY rowid')).toEqual([
      { id: 'fnd_v', lineage_id: 'fnd_v', version: 1, lifecycle: 'current', first_seen_at: T0, last_confirmed_at: T0, confirm_count: 0, lineage_conflict: 0 },
      { id: 'fnd_p', lineage_id: 'fnd_p', version: 1, lifecycle: 'current', first_seen_at: T1, last_confirmed_at: null, confirm_count: 0, lineage_conflict: 0 },
    ]);
    expect(all(s, 'SELECT * FROM item_scopes ORDER BY item_kind, item_id')).toEqual([
      { item_kind: 'artifact', item_id: ART_PAGE, workspace_id: 'ws_a', source: 'home' },
      { item_kind: 'artifact', item_id: ART_UPLOAD, workspace_id: 'ws_a', source: 'home' },
      { item_kind: 'fact', item_id: 'fnd_p', workspace_id: 'ws_a', source: 'home' },
      { item_kind: 'fact', item_id: 'fnd_v', workspace_id: 'ws_a', source: 'home' },
    ]);
  });

  it('indexes existing findings and artifacts in FTS (porter stemming, diacritics removed)', () => {
    const s = open(legacyDb());
    const fts = (sql: string, q: string) => all(s, sql, q).map((r) => r.id);
    const findings = 'SELECT f.id FROM findings_fts JOIN findings f ON f.rowid = findings_fts.rowid WHERE findings_fts MATCH ? ORDER BY bm25(findings_fts)';
    expect(fts(findings, 'price')).toEqual(['fnd_v']); // "prices" stemmed
    expect(fts(findings, 'churn')).toEqual(['fnd_p']);
    const artifacts = 'SELECT a.id FROM artifacts_fts JOIN artifacts a ON a.rowid = artifacts_fts.rowid WHERE artifacts_fts MATCH ?';
    expect(fts(artifacts, 'checkout')).toEqual([ART_PAGE]); // flow column
    expect(fts(artifacts, 'kpi')).toEqual([ART_UPLOAD]);
  });

  it('keeps FTS in sync on insert, update and delete', () => {
    const s = open(legacyDb());
    const hits = (q: string) => all(s, 'SELECT rowid FROM findings_fts WHERE findings_fts MATCH ?', q).length;
    s.db.exec(`UPDATE findings SET claim = 'Acme cut résumé prices' WHERE id = 'fnd_v'`);
    expect(hits('raised')).toBe(0);
    expect(hits('resume')).toBe(1);
    s.db.exec(`UPDATE findings SET status = 'unverified' WHERE id = 'fnd_v'`); // non-indexed column: index untouched
    expect(hits('resume')).toBe(1);
    s.db.exec(`DELETE FROM findings WHERE id = 'fnd_v'`);
    expect(hits('resume')).toBe(0);

    s.db.exec(`INSERT INTO chunks (id, artifact_id, workspace_id, seq, heading_path, text, char_start, char_end, token_estimate)
      VALUES ('chk_1', '${ART_PAGE}', 'ws_a', 0, 'Plans > Team', 'The team plan costs 12 dollars', 0, 30, 8)`);
    expect(all(s, `SELECT rowid FROM chunks_fts WHERE chunks_fts MATCH 'dollar'`)).toHaveLength(1);
    s.db.exec(`INSERT INTO entities (id, root_workspace_id, workspace_id, kind, name, name_key, aliases, created_at, updated_at)
      VALUES ('ent_1', 'ws_a', 'ws_a', 'competitor', 'Globex Corporation', 'globex corporation', '["Globex Inc"]', '${T0}', '${T0}')`);
    expect(all(s, `SELECT rowid FROM entities_fts WHERE entities_fts MATCH 'lobe'`)).toHaveLength(1); // trigram substring
    s.db.exec(`UPDATE artifacts SET description = 'Checkout screen with a red error banner' WHERE id = '${ART_PAGE}'`);
    expect(all(s, `SELECT rowid FROM artifacts_fts WHERE artifacts_fts MATCH 'banner'`)).toHaveLength(1);
  });

  it('new rows get their invariants from triggers: lineage, home scope, pending text, upload flag', () => {
    const s = open(legacyDb());
    s.findings.insert({
      id: 'fnd_new', workspaceId: 'ws_a', runId: 'rrun_2', taskId: 'tsk_2', subject: 'Acme', claim: 'New claim',
      criteria: {}, evidence: [], status: 'pending', createdAt: T1,
    });
    expect(s.findings.get('fnd_new')).toMatchObject({
      lineageId: 'fnd_new', version: 1, lifecycle: 'current', firstSeenAt: T1, confirmCount: 0, uploadDerived: false, lineageConflict: false,
    });
    expect(s.findings.get('fnd_new')!.lastConfirmedAt).toBeUndefined();
    expect(one(s, `SELECT source FROM item_scopes WHERE item_kind = 'fact' AND item_id = 'fnd_new'`)).toEqual({ source: 'home' });

    s.artifacts.insert({ id: 'art_up2', workspaceId: 'ws_a', kind: 'upload', path: 'p/x.pdf', sha256: 'sha_c', mime: 'application/pdf', capturedAt: T1 });
    expect(s.artifacts.get('art_up2')!.uploadDerived).toBe(true);
    expect(one(s, `SELECT status FROM artifact_texts WHERE artifact_id = 'art_up2'`)).toEqual({ status: 'pending' });
    expect(one(s, `SELECT source FROM item_scopes WHERE item_kind = 'artifact' AND item_id = 'art_up2'`)).toEqual({ source: 'home' });

    // A finding citing an upload-derived artifact is upload-derived from its insert on.
    s.findings.insert({
      id: 'fnd_up', workspaceId: 'ws_a', runId: 'rrun_2', taskId: 'tsk_2', subject: 'KPI', claim: 'From the deck',
      criteria: {}, evidence: ['art_up2'], status: 'pending', createdAt: T1,
    });
    expect(s.findings.get('fnd_up')!.uploadDerived).toBe(true);
  });

  it('upload_derived is sticky: never reset, and propagates to citing facts, chunks and later versions', () => {
    const s = open(legacyDb());
    expect(() => s.db.exec(`UPDATE artifacts SET upload_derived = 0 WHERE upload_derived = 0`)).not.toThrow();
    expect(() => s.db.exec(`UPDATE artifacts SET upload_derived = 0 WHERE id = '${ART_UPLOAD}'`)).toThrow(/upload_derived is sticky/);

    s.db.exec(`INSERT INTO chunks (id, artifact_id, workspace_id, seq, text, char_start, char_end, token_estimate)
      VALUES ('chk_p', '${ART_PAGE}', 'ws_a', 0, 'Pricing text', 0, 12, 3)`);
    s.db.exec(`INSERT INTO findings (id, workspace_id, run_id, task_id, subject, claim, criteria, evidence, status, created_at, lineage_id, version, replaces_id, lifecycle)
      VALUES ('fnd_v2', 'ws_a', 'rrun_2', 'tsk_2', 'Acme', 'Acme raised prices again', '{}', '[]', 'pending', '${T1}', 'fnd_v', 2, 'fnd_v', 'candidate')`);
    expect(one(s, `SELECT upload_derived FROM findings WHERE id = 'fnd_v2'`)).toEqual({ upload_derived: 0 });

    // The page turns out to be the same bytes as an upload (profile-linked dedupe): flag the artifact.
    s.db.exec(`INSERT INTO profiles (workspace_id, data) VALUES ('ws_a', '{"uploads":["${ART_PAGE}"]}')`);
    expect(one(s, `SELECT upload_derived FROM artifacts WHERE id = '${ART_PAGE}'`)).toEqual({ upload_derived: 1 });
    expect(one(s, `SELECT upload_derived FROM chunks WHERE id = 'chk_p'`)).toEqual({ upload_derived: 1 });
    expect(one(s, `SELECT upload_derived FROM findings WHERE id = 'fnd_v'`)).toEqual({ upload_derived: 1 }); // cites the page
    expect(one(s, `SELECT upload_derived FROM findings WHERE id = 'fnd_v2'`)).toEqual({ upload_derived: 1 }); // later version
    expect(() => s.db.exec(`UPDATE findings SET upload_derived = 0 WHERE id = 'fnd_v'`)).toThrow(/upload_derived is sticky/);
    expect(() => s.db.exec(`UPDATE chunks SET upload_derived = 0 WHERE id = 'chk_p'`)).toThrow(/upload_derived is sticky/);

    // A profile with malformed data never blocks the write.
    expect(() => s.db.exec(`UPDATE profiles SET data = '{"uploads":"nope"}' WHERE workspace_id = 'ws_a'`)).not.toThrow();
  });

  it('retrieval_events is append-only', () => {
    const s = open(legacyDb());
    s.db.exec(`INSERT INTO retrieval_events (id, workspace_id, root_workspace_id, role, tool, query, scope, result_ids, result_count, tokens_returned, latency_ms, created_at)
      VALUES ('ret_1', 'ws_a', 'ws_a', 'worker', 'search', 'q', 'node', '[]', 0, 0, 1, '${T0}')`);
    expect(() => s.db.exec(`UPDATE retrieval_events SET query = 'x'`)).toThrow(/append-only/);
    expect(() => s.db.exec(`DELETE FROM retrieval_events`)).toThrow(/append-only/);
  });

  it('entities are unique per tree root, kind and name key', () => {
    const s = open(legacyDb());
    const ins = (id: string, root: string, kind: string) => s.db.exec(`INSERT INTO entities (id, root_workspace_id, workspace_id, kind, name, name_key, created_at, updated_at)
      VALUES ('${id}', '${root}', '${root}', '${kind}', 'Globex', 'globex', '${T0}', '${T0}')`);
    ins('ent_a', 'ws_a', 'competitor');
    ins('ent_b', 'ws_b', 'competitor'); // other tree
    ins('ent_c', 'ws_a', 'topic'); // other kind
    expect(() => ins('ent_d', 'ws_a', 'competitor')).toThrow(/UNIQUE/);
  });
});
