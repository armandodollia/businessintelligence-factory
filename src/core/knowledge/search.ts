/**
 * `search` (design §9, build plan KS-4): one function per kind over its FTS table, every query inside
 * the caller's visibility predicate (tree isolation in SQL, design §12).
 *
 * Query handling: the agent's text is never passed to MATCH raw. Quoted phrases are kept, the rest is
 * split into letter/digit tokens; each is quoted and they are joined with AND. Zero hits over all
 * requested kinds → one retry with OR, flagged `relaxed`. Empty query with `entity_id` = browse by
 * recency. Ranking inside a kind: bm25 with column weights, then scope order (own node, descendants,
 * ancestors, rest), freshness and verified status, then row order — deterministic.
 *
 * Kinds: `fact` (findings_fts), `passage` (chunks_fts; the hit is reported under the first visible
 * artifact holding the chunk — the canonical, else a visible duplicate), `artifact` (artifacts_fts;
 * hits with the same bytes or the same text collapse), `entity` (entities_fts, trigram; a hit through
 * a merged row reports the survivor and is flagged with `entityIsUploadOnly` of the row that matched),
 * `record` (competitors, personas, symptoms, hypotheses, recommendations, flows, review mentions: v1 uses
 * LIKE on their short text fields — an accepted v1 simplification, the records are few and short; a
 * review mention's quote is served as a fenced snippet).
 *
 * Every hit is a line: id, title or snippet (≤ 200 chars; evidence snippets fenced), entity, source
 * node (when not the caller's), flags (`unverified`, `stale`, `upload`, `history`), age in days.
 */
import type { Store } from '../store/db.js';
import { knowledgeRepos } from '../store/repos.js';
import type { Entity, Finding, RetrievalResultRef, TextChunk } from '../types.js';
import { fenceEvidence, stripFences } from './trust.js';
import { cursorKey } from './budget.js';
import { assemblePage, boundedText, type AssembledPage } from './paging.js';
import { getEntity } from './entities.js';
import { factFreshness, isFactUsable } from './facts.js';
import { entityIsUploadOnly, itemIsUploadDerived } from './provenance.js';
import {
  ageDays, artifactVisibleSql, entityVisibleIn, factVisibleSql, ReadInputError, recordVisibleSql, usableOnly, visParams,
  type ReadEnv, type ReadOutput,
} from './readCommon.js';
import { scopeRank, type KnowledgeScope, type ScopeMode } from './scope.js';
import { chunkSnippet, servedLine, SNIPPET_MAX_CHARS } from './texts.js';
import { factUsableSql, outputUsableSql } from './usable.js';

export const SEARCH_KINDS = ['fact', 'passage', 'artifact', 'entity', 'record'] as const;
export type SearchKind = (typeof SEARCH_KINDS)[number];

export type SearchInput = {
  query?: string;
  kinds?: SearchKind[];
  scope?: ScopeMode;
  /** Narrows to that node's own view (any node of the tree). */
  narrowed?: string;
  entityId?: string;
  includeUnverified?: boolean;
  includeHistory?: boolean;
  since?: string;
  limit?: number;
  cursor?: string;
};

export type SearchHit = {
  kind: SearchKind;
  id: string;
  /** Record type for `record` hits (competitor, persona, symptom, strength, hypothesis, recommendation, flow, review_mention). */
  type?: string;
  title?: string;
  /** Evidence text, fenced (`<<<EVIDENCE art_… … >>>`). */
  snippet?: string;
  /** Passage hits: the artifact the passage is served for. */
  artifact_id?: string;
  entity?: { id: string; name: string };
  /** The item's home node, when it is not the caller's. */
  source?: string;
  flags?: string[];
  age_days?: number;
};

/** Internal hit: the line plus what the log and ranking need. */
type Ranked = { hit: SearchHit; refs: RetrievalResultRef[]; upload: boolean; score: number; rank: number; tie: number[]; key?: string };

export const DEFAULT_LIMIT = 10;
export const MAX_LIMIT = 50;
const MAX_TERMS = 32;
const POOL_FACTOR = 5;
const TITLE_MAX = SNIPPET_MAX_CHARS;

// ---------------------------------------------------------------------------
// query building

export type ParsedQuery = { terms: string[] };

/** Quoted phrases kept whole, the rest split into letter/digit tokens (at most 32 terms). */
export function parseQuery(query: string | undefined): ParsedQuery {
  const terms: string[] = [];
  const text = (query ?? '').normalize('NFKC');
  const rest = text.replace(/"([^"]*)"/g, (_, p: string) => {
    const words = p.match(/[\p{L}\p{N}]+/gu);
    if (words?.length) terms.push(words.join(' '));
    return ' ';
  });
  for (const w of rest.match(/[\p{L}\p{N}]+/gu) ?? []) terms.push(w);
  return { terms: [...new Set(terms)].slice(0, MAX_TERMS) };
}

/** FTS5 MATCH expression: every term quoted (no operators reach FTS), joined by AND or OR. */
export function matchExpr(terms: readonly string[], op: 'AND' | 'OR', column?: string): string {
  const body = terms.map((t) => `"${t.replace(/"/g, '""')}"`).join(` ${op} `);
  return column ? `${column} : (${body})` : body;
}

// ---------------------------------------------------------------------------
// per-kind queries

type Ctx = {
  env: ReadEnv;
  view: KnowledgeScope;
  mode: ScopeMode;
  input: SearchInput;
  limit: number;
  /** Entity group (survivor + merged rows) when `entity_id` is given. */
  group?: string[];
  usableOnly: boolean;
  /** KS-8: entity labels of this call (shared by the copies `elsewhereNote` makes; nothing is written during a read). */
  labels: Map<string, EntityLabel>;
};

function sourceOf(c: Ctx, ws: string): string | undefined {
  return ws === c.env.scope.workspaceId ? undefined : ws;
}

function entityGroup(store: Store, survivorId: string): string[] {
  const rows = store.db
    .prepare(
      `WITH RECURSIVE grp(id) AS (SELECT ? UNION SELECT e.id FROM entities e JOIN grp ON e.merged_into_id = grp.id) SELECT id FROM grp`,
    )
    .all(survivorId) as Array<{ id: string }>;
  return rows.map((r) => r.id);
}

/** Best scope rank over an item's visible scope rows (facts / artifacts) or its workspace (records). */
function bestRank(c: Ctx, kind: 'fact' | 'artifact', id: string, home: string): number {
  const rows = knowledgeRepos(c.env.store).itemScopes.list({ itemKind: kind, itemId: id });
  const ranks = rows.map((r) => scopeRank(c.view, r.workspaceId));
  return ranks.length ? Math.min(...ranks) : scopeRank(c.view, home);
}

type EntityLabel = { label?: { id: string; name: string }; refs: RetrievalResultRef[]; upload: boolean };

/** `entityLabel`, once per entity per search call (KS-8: measured at 10 000 chunks / 1 000 facts). */
function cachedEntityLabel(c: Ctx, id: string | undefined): EntityLabel {
  if (!id) return { refs: [], upload: false };
  let l = c.labels.get(id);
  if (!l) c.labels.set(id, (l = entityLabel(c.env.store, c.env.scope, id)));
  return l;
}

/** Entity reference shown on a hit (survivor name), with its refs and upload status. */
function entityLabel(store: Store, scope: KnowledgeScope, id: string | undefined): EntityLabel {
  if (!id) return { refs: [], upload: false };
  try {
    const e = getEntity(store, scope, id);
    return {
      label: { id: e.id, name: servedLine(store, scope.workspaceId, e.name, 120) },
      refs: [{ id: e.id, kind: 'entity' }],
      upload: entityIsUploadOnly(store, e.id),
    };
  } catch {
    return { refs: [], upload: false };
  }
}

function factFilter(c: Ctx): string {
  if (c.usableOnly) return factUsableSql('f');
  const current = c.input.includeUnverified
    ? `(f.lifecycle = 'current' AND COALESCE(f.status, 'pending') NOT IN ('superseded', 'failed'))`
    : factUsableSql('f');
  return c.input.includeHistory ? `(${current} OR f.lifecycle IN ('replaced', 'retracted'))` : current;
}

function factHit(c: Ctx, f: Finding, score: number): Ranked {
  const { store } = c.env;
  const flags: string[] = [];
  const usable = isFactUsable(f);
  const history = f.lifecycle === 'replaced' || f.lifecycle === 'retracted';
  if (history) flags.push('history');
  else if (!usable) flags.push('unverified');
  const fresh = factFreshness(store, f, c.env.config, c.env.now);
  if (!history && fresh.stale) flags.push('stale');
  const ent = cachedEntityLabel(c, f.entityId);
  const upload = f.uploadDerived === true || ent.upload;
  if (upload) flags.push('upload');
  const hit: SearchHit = {
    kind: 'fact', id: f.id,
    title: servedLine(store, c.env.scope.workspaceId, f.claim, TITLE_MAX),
  };
  if (ent.label) hit.entity = ent.label;
  const src = sourceOf(c, f.workspaceId);
  if (src) hit.source = src;
  if (flags.length) hit.flags = flags;
  hit.age_days = fresh.ageDays;
  return {
    hit, upload, score,
    refs: [{ id: f.id, kind: 'fact' }, ...ent.refs],
    rank: bestRank(c, 'fact', f.id, f.workspaceId),
    tie: [fresh.stale ? 1 : 0, usable ? 0 : 1],
  };
}

function searchFacts(c: Ctx, terms: string[], op: 'AND' | 'OR'): Ranked[] {
  const { store } = c.env;
  const where = [factVisibleSql('f'), factFilter(c)];
  const params: Record<string, string | number> = { ...visParams(c.view, c.mode), lim: c.limit * POOL_FACTOR };
  if (c.input.since) {
    where.push('COALESCE(f.last_confirmed_at, f.first_seen_at, f.created_at) >= :since');
    params.since = c.input.since;
  }
  if (c.group) {
    where.push('f.entity_id IN (SELECT value FROM json_each(:grp))');
    params.grp = JSON.stringify(c.group);
  }
  let rows: Array<{ id: string; score: number }>;
  if (terms.length) {
    params.q = matchExpr(terms, op);
    rows = store.db
      .prepare(
        `SELECT f.id AS id, bm25(findings_fts, 2.0, 1.0) AS score FROM findings_fts JOIN findings f ON f.rowid = findings_fts.rowid
         WHERE findings_fts MATCH :q AND ${where.join(' AND ')} ORDER BY score, f.rowid LIMIT :lim`,
      )
      .all(params) as typeof rows;
  } else {
    rows = store.db
      .prepare(
        `SELECT f.id AS id, 0 AS score FROM findings f WHERE ${where.join(' AND ')}
         ORDER BY COALESCE(f.last_confirmed_at, f.first_seen_at, f.created_at) DESC, f.rowid DESC LIMIT :lim`,
      )
      .all(params) as typeof rows;
  }
  return rows.map((r) => factHit(c, store.findings.get(r.id)!, Number(r.score)));
}

function searchPassages(c: Ctx, terms: string[], op: 'AND' | 'OR'): Ranked[] {
  if (!terms.length) return [];
  const { store } = c.env;
  const params: Record<string, string | number> = { ...visParams(c.view, c.mode), q: matchExpr(terms, op), lim: c.limit * POOL_FACTOR };
  const extra: string[] = [];
  if (c.input.since) {
    extra.push('a.captured_at >= :since');
    params.since = c.input.since;
  }
  if (c.group) {
    extra.push('EXISTS (SELECT 1 FROM artifact_captures cap WHERE cap.artifact_id = a.id AND cap.entity_id IN (SELECT value FROM json_each(:grp)))');
    params.grp = JSON.stringify(c.group);
  }
  // The artifact a chunk is served under: the canonical if visible, else the oldest visible duplicate.
  // KS-8 (measured at 10 000 chunks): two lookups, the canonical by primary key first and the
  // duplicates only when it is not visible (COALESCE stops at the first non-null). One subquery with
  // `a.id = … OR t.duplicate_of = …` could use no index and scanned the artifacts for every match.
  // `duplicate_of` has no index (no migration in KS-8), so the duplicate scan only runs for an
  // artifact that has duplicates (the IN list is built once per statement).
  const cond = `${artifactVisibleSql('a')}${extra.length ? ` AND ${extra.join(' AND ')}` : ''}`;
  const rows = store.db
    .prepare(
      `SELECT * FROM (
         SELECT c.id AS id, bm25(chunks_fts, 2.0, 1.0) AS score, c.rowid AS rid,
           COALESCE(
             (SELECT a.id FROM artifacts a WHERE a.id = c.artifact_id AND ${cond}),
             CASE WHEN c.artifact_id IN (SELECT duplicate_of FROM artifact_texts WHERE duplicate_of IS NOT NULL) THEN
               (SELECT a.id FROM artifact_texts t JOIN artifacts a ON a.id = t.artifact_id
                 WHERE t.duplicate_of = c.artifact_id AND ${cond} ORDER BY a.rowid LIMIT 1)
             END
           ) AS shown
         FROM chunks_fts JOIN chunks c ON c.rowid = chunks_fts.rowid
         WHERE chunks_fts MATCH :q
       ) WHERE shown IS NOT NULL ORDER BY score, rid LIMIT :lim`,
    )
    .all(params) as Array<{ id: string; score: number; shown: string }>;
  const repo = knowledgeRepos(store).chunks;
  return rows.map((r) => {
    const chunk = repo.get(r.id) as TextChunk;
    const art = store.artifacts.get(r.shown)!;
    const canonical = store.artifacts.get(chunk.artifactId);
    const upload = chunk.uploadDerived === true || art.uploadDerived === true || canonical?.uploadDerived === true;
    const hit: SearchHit = {
      kind: 'passage', id: chunk.id, artifact_id: art.id,
      snippet: chunkSnippet(store, c.env.scope.workspaceId, art.id, chunk, terms),
    };
    if (chunk.headingPath) hit.title = servedLine(store, c.env.scope.workspaceId, stripFences(chunk.headingPath), 120);
    const src = sourceOf(c, art.workspaceId);
    if (src) hit.source = src;
    if (upload) hit.flags = ['upload'];
    const age = ageDays(art.capturedAt, c.env.now);
    if (age !== undefined) hit.age_days = age;
    const refs: RetrievalResultRef[] = [{ id: chunk.id, kind: 'chunk' }, { id: art.id, kind: 'artifact' }];
    if (chunk.artifactId !== art.id) refs.push({ id: chunk.artifactId, kind: 'artifact' });
    return { hit, refs, upload, score: Number(r.score), rank: bestRank(c, 'artifact', art.id, art.workspaceId), tie: [] };
  });
}

function searchArtifacts(c: Ctx, terms: string[], op: 'AND' | 'OR'): Ranked[] {
  const { store } = c.env;
  const where = [artifactVisibleSql('a')];
  const params: Record<string, string | number> = { ...visParams(c.view, c.mode), lim: c.limit * POOL_FACTOR };
  if (c.input.since) {
    where.push('a.captured_at >= :since');
    params.since = c.input.since;
  }
  if (c.group) {
    where.push('EXISTS (SELECT 1 FROM artifact_captures cap WHERE cap.artifact_id = a.id AND cap.entity_id IN (SELECT value FROM json_each(:grp)))');
    params.grp = JSON.stringify(c.group);
  }
  let rows: Array<{ id: string; score: number }>;
  if (terms.length) {
    params.q = matchExpr(terms, op);
    rows = store.db
      .prepare(
        `SELECT a.id AS id, bm25(artifacts_fts, 3.0, 2.0, 1.0, 1.0, 1.0) AS score FROM artifacts_fts JOIN artifacts a ON a.rowid = artifacts_fts.rowid
         WHERE artifacts_fts MATCH :q AND ${where.join(' AND ')} ORDER BY score, a.rowid LIMIT :lim`,
      )
      .all(params) as typeof rows;
  } else {
    rows = store.db
      .prepare(`SELECT a.id AS id, 0 AS score FROM artifacts a WHERE ${where.join(' AND ')} ORDER BY a.captured_at DESC, a.rowid DESC LIMIT :lim`)
      .all(params) as typeof rows;
  }
  const texts = knowledgeRepos(store).artifactTexts;
  return rows.map((r) => {
    const a = store.artifacts.get(r.id)!;
    const ws = c.env.scope.workspaceId;
    const upload = a.uploadDerived === true;
    const label = a.title ?? a.sourceUrl ?? `${a.kind} ${a.mime}`;
    const hit: SearchHit = { kind: 'artifact', id: a.id, title: servedLine(store, ws, stripFences(label), 120) };
    if (a.description) hit.snippet = chunkFreeSnippet(store, ws, a.id, a.description);
    const src = sourceOf(c, a.workspaceId);
    if (src) hit.source = src;
    if (upload) hit.flags = ['upload'];
    const age = ageDays(a.capturedAt, c.env.now);
    if (age !== undefined) hit.age_days = age;
    const t = texts.get(a.id);
    const key = t?.contentSha256 ? `t:${t.contentSha256}` : `b:${a.sha256}`;
    return { hit, refs: [{ id: a.id, kind: 'artifact' }], upload, score: Number(r.score), rank: bestRank(c, 'artifact', a.id, a.workspaceId), tie: [], key: `${key}|b:${a.sha256}` };
  });
}

/** An artifact's description served as evidence (under the artifact's flag): redacted whole, cut, fenced. */
function chunkFreeSnippet(store: Store, ws: string, artifactId: string, text: string): string {
  return fenceEvidence(artifactId, servedLine(store, ws, text, SNIPPET_MAX_CHARS));
}

/** Whether an entity (survivor) is visible to the search's view and mode (shared rule, readCommon.ts). */
function entityVisible(c: Ctx, e: Entity): boolean {
  return entityVisibleIn(c.env.store, c.view, c.mode, e);
}

function searchEntities(c: Ctx, terms: string[], op: 'AND' | 'OR'): Ranked[] {
  const { store } = c.env;
  // Trigram tokens need ≥ 3 characters; shorter terms cannot match and are left out.
  const usable = terms.filter((t) => [...t].length >= 3);
  if (!usable.length || c.input.since) return [];
  const rows = store.db
    .prepare(
      `SELECT e.id AS id, bm25(entities_fts, 2.0, 1.0) AS score FROM entities_fts JOIN entities e ON e.rowid = entities_fts.rowid
       WHERE entities_fts MATCH :q AND e.root_workspace_id = :root ORDER BY score, e.rowid LIMIT :lim`,
    )
    .all({ q: matchExpr(usable, op), root: c.view.rootId, lim: c.limit * POOL_FACTOR }) as Array<{ id: string; score: number }>;
  const repo = knowledgeRepos(store).entities;
  const bySurvivor = new Map<string, Ranked>();
  for (const r of rows) {
    const matched = repo.get(r.id)!;
    let survivor: Entity;
    try {
      survivor = getEntity(store, c.env.scope, matched.id);
    } catch {
      continue;
    }
    if (c.group && !c.group.includes(survivor.id)) continue;
    if (bySurvivor.has(survivor.id) || !entityVisible(c, survivor)) continue;
    const ws = c.env.scope.workspaceId;
    const viaAlias = matched.id !== survivor.id && matched.nameKey !== survivor.nameKey;
    const upload = entityIsUploadOnly(store, matched.id) || entityIsUploadOnly(store, survivor.id);
    const hit: SearchHit = {
      kind: 'entity', id: survivor.id, type: survivor.kind,
      title: servedLine(store, ws, viaAlias ? `${survivor.name} (alias: ${matched.name})` : survivor.name, 120),
    };
    const src = sourceOf(c, survivor.workspaceId);
    if (src) hit.source = src;
    if (upload) hit.flags = ['upload'];
    const refs: RetrievalResultRef[] = [{ id: survivor.id, kind: 'entity' }];
    if (matched.id !== survivor.id) refs.push({ id: matched.id, kind: 'entity' });
    bySurvivor.set(survivor.id, { hit, refs, upload, score: Number(r.score), rank: scopeRank(c.view, survivor.workspaceId), tie: [] });
  }
  return [...bySurvivor.values()];
}

/**
 * Record kinds searched with LIKE (v1): table, type label, text columns, usable predicate, title column,
 * the columns naming an entity (`entity_id` browse; none: not browsable), and `always`: a predicate every
 * hit meets whatever the flags (a flow is a hit only as the current version of its variant: replaced
 * versions and candidates never are). Flows and review mentions (flow records) are scoped by their
 * `workspace_id` like the other typed records; a review mention needs no review, so it is always usable.
 */
const RECORD_TABLES = [
  { table: 'competitors', type: 'competitor', cols: ['name', 'site'], usable: outputUsableSql('r'), title: 'name', entityCols: ['entity_id'] },
  // A user persona (user persona design §5) is never a record of the store: never a hit.
  { table: 'personas', type: 'persona', cols: ['segment', 'slug'], usable: outputUsableSql('r'), title: 'segment', entityCols: ['entity_id'], always: `r.kind <> 'user'` },
  { table: 'symptoms', type: 'symptom', cols: ['title', 'detail'], usable: '1', title: 'title', entityCols: ['entity_id'] },
  { table: 'symptom_hypotheses', type: 'hypothesis', cols: ['hypothesis'], usable: outputUsableSql('r'), title: 'hypothesis', entityCols: ['entity_id'] },
  { table: 'recommendations', type: 'recommendation', cols: ['title', 'summary'], usable: outputUsableSql('r'), title: 'title', entityCols: [] },
  {
    table: 'flows', type: 'flow', cols: ['name', 'goal', 'notable'], usable: outputUsableSql('r'), title: 'name',
    entityCols: ['subject_entity_id', 'entity_id'], always: `r.lifecycle = 'current'`,
  },
  { table: 'review_mentions', type: 'review_mention', cols: ['quote'], usable: '1', title: 'quote', entityCols: ['subject_entity_id'] },
] as const satisfies ReadonlyArray<{ table: string; type: string; cols: readonly string[]; usable: string; title: string; entityCols: readonly string[]; always?: string }>;

function searchRecords(c: Ctx, terms: string[], op: 'AND' | 'OR'): Ranked[] {
  const { store } = c.env;
  // Records carry no comparable date: `since` does not filter them.
  const out: Ranked[] = [];
  for (const t of RECORD_TABLES) {
    if (c.group && !t.entityCols.length) continue; // recommendations have no entity
    const where = [recordVisibleSql('r')];
    const params: Record<string, string | number> = { ids: visParams(c.view, c.mode).ids, lim: c.limit * POOL_FACTOR };
    if ('always' in t) where.push(t.always);
    if (!(c.input.includeUnverified && !c.usableOnly)) where.push(t.usable);
    else if (t.usable !== '1') where.push(`COALESCE(r.status, 'pending') <> 'superseded'`);
    if (c.group) {
      where.push(`(${t.entityCols.map((col) => `r.${col} IN (SELECT value FROM json_each(:grp))`).join(' OR ')})`);
      params.grp = JSON.stringify(c.group);
    }
    if (terms.length) {
      const likes = terms.map((term, i) => {
        params[`t${i}`] = `%${term.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
        return `(${t.cols.map((col) => `COALESCE(r.${col}, '') LIKE :t${i} ESCAPE '\\'`).join(' OR ')})`;
      });
      where.push(`(${likes.join(` ${op} `)})`);
    }
    const extraCols =
      t.table === 'symptoms' ? ', r.kind AS skind' : t.table === 'review_mentions' ? ', r.artifact_id AS art, r.polarity AS pol, r.source_type AS st' : '';
    const rows = store.db
      .prepare(`SELECT r.id AS id, r.workspace_id AS ws, r.${t.title} AS title${extraCols} FROM ${t.table} r WHERE ${where.join(' AND ')} ORDER BY r.rowid DESC LIMIT :lim`)
      .all(params) as Array<{ id: string; ws: string; title: string; skind?: string; art?: string; pol?: string; st?: string }>;
    const ws = c.env.scope.workspaceId;
    for (const r of rows) {
      const upload = itemIsUploadDerived(store, r.id);
      const refs: RetrievalResultRef[] = [{ id: r.id, kind: 'record' }];
      const hit: SearchHit = { kind: 'record', id: r.id, type: r.skind === 'strength' ? 'strength' : t.type };
      if (r.art !== undefined) {
        // A review mention: its quote is third-party text, served fenced under its stored copy.
        hit.title = `review mention (${r.pol}, ${r.st})`;
        hit.snippet = fenceEvidence(r.art, servedLine(store, ws, r.title ?? '', SNIPPET_MAX_CHARS));
        refs.push({ id: r.art, kind: 'artifact' });
      } else hit.title = servedLine(store, ws, r.title ?? '', TITLE_MAX);
      const src = sourceOf(c, r.ws);
      if (src) hit.source = src;
      if (upload) hit.flags = ['upload'];
      // More matched terms first (OR retry), then scope order.
      const matchedTerms = terms.filter((term) => (r.title ?? '').toLowerCase().includes(term.toLowerCase())).length;
      out.push({ hit, refs, upload, score: -matchedTerms, rank: scopeRank(c.view, r.ws), tie: [] });
    }
  }
  return out;
}

const RUNNERS: Record<SearchKind, (c: Ctx, terms: string[], op: 'AND' | 'OR') => Ranked[]> = {
  fact: searchFacts,
  passage: searchPassages,
  artifact: searchArtifacts,
  entity: searchEntities,
  record: searchRecords,
};

/** bm25 rounded so float noise never reorders equal scores; then the tie-breakers; the pool order last. */
function rankKind(items: Ranked[], limit: number): Ranked[] {
  const indexed = items.map((r, i) => ({ r, i }));
  indexed.sort((a, b) => {
    const s = Math.round(a.r.score * 1e6) - Math.round(b.r.score * 1e6);
    if (s) return s;
    if (a.r.rank !== b.r.rank) return a.r.rank - b.r.rank;
    for (let k = 0; k < Math.max(a.r.tie.length, b.r.tie.length); k++) {
      const d = (a.r.tie[k] ?? 0) - (b.r.tie[k] ?? 0);
      if (d) return d;
    }
    return a.i - b.i;
  });
  // Collapse hits with the same bytes or the same text (design §8.4).
  const seen = new Set<string>();
  const out: Ranked[] = [];
  for (const { r } of indexed) {
    if (r.key) {
      const keys = r.key.split('|');
      if (keys.some((k) => seen.has(k))) continue;
      for (const k of keys) seen.add(k);
    }
    out.push(r);
    if (out.length >= limit) break;
  }
  return out;
}

/** Runs a search for the caller (see module doc). `budget` in tokens. Throws `KnowledgeNotFoundError` for an `entity_id` outside the tree. */
export function runSearch(env: ReadEnv, view: KnowledgeScope, input: SearchInput, budget: number, cursorParts: unknown): ReadOutput {
  const mode = input.scope ?? 'node';
  const limit = Math.max(1, Math.min(MAX_LIMIT, Math.floor(input.limit ?? DEFAULT_LIMIT)));
  const kinds = input.kinds?.length ? SEARCH_KINDS.filter((k) => input.kinds!.includes(k)) : [...SEARCH_KINDS];
  const notes: string[] = [];
  let group: string[] | undefined;
  if (input.entityId) group = entityGroup(env.store, getEntity(env.store, env.scope, input.entityId).id);
  const { terms } = parseQuery(input.query);
  if (!terms.length && !group) throw new SearchInputError('query is empty: give query text, or an entity_id to browse by recency');
  const c: Ctx = { env, view, mode, input, limit, usableOnly: usableOnly(env.role), labels: new Map(), ...(group ? { group } : {}) };
  const run = (op: 'AND' | 'OR') => kinds.flatMap((k) => rankKind(RUNNERS[k](c, terms, op), limit));
  let hits = run('AND');
  let relaxed = false;
  if (!hits.length && terms.length > 1) {
    hits = run('OR');
    relaxed = true;
  }
  if (!terms.length) notes.push('empty query: newest items of the entity first');
  // The header echoes the request (bounded: the query is the agent's own text, not store content).
  const header = { query: boundedText(input.query ?? '', QUERY_ECHO_JSON), scope: mode };
  const pageWith = (firstNotes: string[]): AssembledPage => assemblePage({
    key: cursorKey(cursorParts), cursor: input.cursor, budget, itemsKey: 'hits', header, headerRefs: [], headerUpload: false,
    notes: env.pageNotes, firstNotes, relaxed,
    // A hit is one item of the store; `expand` of its id returns it whole.
    items: hits.map((h) => ({ value: h.hit, refs: h.refs, upload: h.upload, recover: () => ({ kind: 'expand_id', tool: 'expand', input: { id: h.hit.id } }) })),
  });
  // KS-7 (user decision 14, design §3) as ruled after the paging rework: a node-scoped search with
  // matches elsewhere in the business says how many, on page 1 ALWAYS — the page is measured with the
  // note, so it reserves the room even when that costs a hit (the cursor still reaches that hit). First
  // page only; counts only (no text, no ids; the retrieval row is unchanged); at most `50+` per kind.
  const elsewhere = mode === 'node' && !input.cursor ? elsewhereNote(c, kinds, terms, relaxed ? 'OR' : 'AND') : undefined;
  const page = pageWith(elsewhere ? [...notes, elsewhere] : notes);
  return {
    data: page.data, results: page.results, uploadDerived: page.uploadDerived, truncated: page.truncated, relaxed,
    query: input.query ?? '', scopeLabel: input.narrowed ? `node:${input.narrowed}` : mode,
  };
}

/** JSON characters of the query echoed in a search header. */
const QUERY_ECHO_JSON = 240;

/**
 * Cap of the "elsewhere" count per kind (final-gate follow-up): counting stops here and the note says
 * `<cap>+`, so the note's cost is bounded whatever the size of the tree.
 */
export const ELSEWHERE_COUNT_CAP = 50;
/** Rows looked at per kind for the count: twice the cap, so near items in the pool rarely hide far ones. */
const ELSEWHERE_POOL = ELSEWHERE_COUNT_CAP * 2;

/**
 * "Elsewhere" line of a node-scoped search: per kind, how many of the best tree-wide matches of the same
 * query lie outside node scope — at most `ELSEWHERE_COUNT_CAP`, with `+` when the cap is reached or the
 * pool (`ELSEWHERE_POOL` rows) was full, so the count is a lower bound. Facts, artifacts and records use
 * their scope rank (outside the node's view = rank 3); passages and entities, whose node visibility
 * differs from their home (a visible duplicate, a referencing record), compare with the node-scoped
 * pool. Counts only. `undefined` when there are none.
 */
function elsewhereNote(c: Ctx, kinds: readonly SearchKind[], terms: string[], op: 'AND' | 'OR'): string | undefined {
  const parts: string[] = [];
  const limit = Math.ceil(ELSEWHERE_POOL / POOL_FACTOR);
  for (const k of kinds) {
    const wide = rankKind(RUNNERS[k]({ ...c, mode: 'tree', limit }, terms, op), Number.POSITIVE_INFINITY);
    if (!wide.length) continue;
    let far: Ranked[];
    if (k === 'passage' || k === 'entity') {
      const near = new Set(rankKind(RUNNERS[k]({ ...c, limit }, terms, op), Number.POSITIVE_INFINITY).map((h) => h.hit.id));
      far = wide.filter((h) => !near.has(h.hit.id));
    } else far = wide.filter((h) => h.rank === 3);
    const n = far.length;
    if (n > 0) parts.push(`${k} ${Math.min(n, ELSEWHERE_COUNT_CAP)}${n >= ELSEWHERE_COUNT_CAP || wide.length >= ELSEWHERE_POOL ? '+' : ''}`);
  }
  if (!parts.length) return undefined;
  return `more matches elsewhere in the business (outside node scope): ${parts.join(', ')}; repeat with scope "tree" to see them`;
}

/** A search request that cannot run (empty query without an entity). */
export class SearchInputError extends ReadInputError {
  constructor(message: string) {
    super(message);
    this.name = 'SearchInputError';
  }
}
