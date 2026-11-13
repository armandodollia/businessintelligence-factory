/**
 * Lists of the Knowledge view (design §17; build plan KS-7) that no read tool returns: the entity
 * list, merge suggestions, stale and conflict lists, and store counts. The search, card, fact,
 * artifact and changes routes go through `knowledgeRead` (role `user`) instead.
 *
 * Same rules as the read tools: the caller's `KnowledgeScope` is the only source of workspace ids
 * (tree isolation), the request's scope picks node (default) or tree visibility, items from another
 * node than the caller's carry `source`, text is served through `servedLine` (secrets of the tree
 * redacted, then cut), and every upload-derived item is flagged with `explainUploadDerived`'s
 * one-line reason (why the export leaves it out by default).
 */
import type { BifConfig } from '../config/schema.js';
import type { Store } from '../store/db.js';
import { knowledgeRepos } from '../store/repos.js';
import type { EntityKind, Finding } from '../types.js';
import { listEntities, listMergeSuggestions } from './entities.js';
import { factFreshness } from './facts.js';
import { entityIsUploadOnly, itemIsUploadDerived } from './provenance.js';
import { artifactVisibleSql, entityVisibleIn, factVisibleSql, visParams } from './readCommon.js';
import { type KnowledgeScope, type ScopeMode } from './scope.js';
import { servedLine } from './texts.js';
import { explainUploadDerived } from './uploadCause.js';
import { factUsableSql } from './usable.js';

export type ViewEnv = {
  store: Store;
  config: Pick<BifConfig, 'knowledge'>;
  /** The caller's scope (its node). */
  scope: KnowledgeScope;
  /** The request's scope: `node` (default) or `tree`. */
  mode: ScopeMode;
  now?: Date;
};

/** Upload marking of one item: `upload` and, when set, why the export leaves it out. */
export type UploadMark = { upload?: true; uploadWhy?: string };

function uploadMark(store: Store, id: string): UploadMark {
  if (!itemIsUploadDerived(store, id)) return {};
  const why = explainUploadDerived(store, id);
  return { upload: true, ...(why ? { uploadWhy: why.text } : {}) };
}

const source = (env: ViewEnv, ws: string): { source?: string } => (ws !== env.scope.workspaceId ? { source: ws } : {});

export type EntityRow = { id: string; kind: EntityKind; name: string; home: string; source?: string; facts: number; aliases: number } & UploadMark;

/** Live entities visible in the request's scope, most current facts first, then by name. */
export function visibleEntities(env: ViewEnv, kind?: EntityKind): EntityRow[] {
  const { store, scope, mode } = env;
  const count = store.db.prepare(
    `WITH RECURSIVE grp(id) AS (SELECT :e UNION SELECT x.id FROM entities x JOIN grp ON x.merged_into_id = grp.id)
     SELECT COUNT(*) AS n FROM findings f WHERE f.entity_id IN (SELECT id FROM grp) AND ${factUsableSql('f')} AND ${factVisibleSql('f')}`,
  );
  const rows = listEntities(store, scope, kind)
    .filter((e) => entityVisibleIn(store, scope, mode, e))
    .map((e): EntityRow => {
      const uploadOnly = entityIsUploadOnly(store, e.id);
      return {
        id: e.id, kind: e.kind, name: servedLine(store, scope.workspaceId, e.name, 200), home: e.workspaceId, ...source(env, e.workspaceId),
        facts: Number((count.get({ e: e.id, ...visParams(scope, mode) }) as { n: number }).n), aliases: e.aliases.length,
        ...(uploadOnly ? { upload: true as const, uploadWhy: 'the name appears only in upload-derived records' } : {}),
      };
    });
  return rows.sort((a, b) => b.facts - a.facts || a.name.localeCompare(b.name));
}

export type MergeSuggestionRow = {
  id: string;
  score: number;
  createdAt: string;
  entity: { id: string; name: string; kind: EntityKind; home: string };
  candidate: { id: string; name: string; kind: EntityKind; home: string };
} & UploadMark;

/** Open merge suggestions of the tree; in node scope only those touching an entity visible there. */
export function visibleMergeSuggestions(env: ViewEnv): MergeSuggestionRow[] {
  const { store, scope, mode } = env;
  const repo = knowledgeRepos(store).entities;
  const out: MergeSuggestionRow[] = [];
  for (const s of listMergeSuggestions(store, scope)) {
    const a = repo.get(s.entityId);
    const b = repo.get(s.candidateId);
    if (!a || !b) continue;
    if (!entityVisibleIn(store, scope, mode, a) && !entityVisibleIn(store, scope, mode, b)) continue;
    const side = (e: typeof a) => ({ id: e.id, name: servedLine(store, scope.workspaceId, e.name, 200), kind: e.kind, home: e.workspaceId });
    out.push({
      id: s.id, score: Math.round(s.score * 100) / 100, createdAt: s.createdAt, entity: side(a), candidate: side(b),
      ...(s.uploadOnly ? { upload: true as const, uploadWhy: 'one of the names appears only in upload-derived records' } : {}),
    });
  }
  return out;
}

export type FactRow = {
  id: string;
  claim: string;
  lifecycle: string;
  status: string;
  version: number;
  lastConfirmedAt?: string;
  ageDays: number;
  ttlDays: number;
  stale: boolean;
  conflict?: true;
  entity?: { id: string; name: string };
  source?: string;
} & UploadMark;

function factRow(env: ViewEnv, f: Finding): FactRow {
  const { store, scope } = env;
  const fresh = factFreshness(store, f, env.config, env.now ?? new Date());
  const row: FactRow = {
    id: f.id, claim: servedLine(store, scope.workspaceId, f.claim, 400), lifecycle: f.lifecycle ?? 'current', status: f.status,
    version: f.version ?? 1, ageDays: fresh.ageDays, ttlDays: fresh.ttlDays, stale: fresh.stale, ...source(env, f.workspaceId),
    ...uploadMark(store, f.id),
  };
  if (f.lastConfirmedAt) row.lastConfirmedAt = f.lastConfirmedAt;
  if (f.lineageConflict) row.conflict = true;
  const e = f.entityId ? knowledgeRepos(store).entities.get(f.entityId) : undefined;
  if (e && e.rootWorkspaceId === scope.rootId) row.entity = { id: e.id, name: servedLine(store, scope.workspaceId, e.name, 120) };
  return row;
}

function visibleFacts(env: ViewEnv, where: string): Finding[] {
  const rows = env.store.db
    .prepare(`SELECT f.id AS id FROM findings f WHERE ${factVisibleSql('f')} AND ${where} ORDER BY f.rowid`)
    .all(visParams(env.scope, env.mode)) as Array<{ id: string }>;
  return rows.map((r) => env.store.findings.get(r.id)!);
}

/** Usable current facts past their TTL, oldest confirmation first (at most `limit`). */
export function staleFacts(env: ViewEnv, limit = 200): { facts: FactRow[]; more: number } {
  const stale = visibleFacts(env, factUsableSql('f'))
    .map((f) => factRow(env, f))
    .filter((r) => r.stale)
    .sort((a, b) => b.ageDays - a.ageDays || a.id.localeCompare(b.id));
  return { facts: stale.slice(0, limit), more: Math.max(0, stale.length - limit) };
}

/**
 * Lineages that need a person: heads flagged `lineage_conflict` (design §7.2: a replace / retract /
 * confirm that arrived after the lineage moved on), and unverified updates (a `candidate` version
 * whose task did not verify it; applying it is the user's call).
 */
export function conflictFacts(env: ViewEnv): { conflicts: FactRow[]; unverifiedUpdates: FactRow[] } {
  return {
    conflicts: visibleFacts(env, 'f.lineage_conflict = 1').map((f) => factRow(env, f)),
    unverifiedUpdates: visibleFacts(env, `f.lifecycle = 'candidate' AND COALESCE(f.status, 'pending') NOT IN ('superseded', 'pending')`)
      .map((f) => factRow(env, f)),
  };
}

export type KnowledgeStats = {
  scope: ScopeMode;
  facts: { current: number; usable: number; stale: number; candidate: number; replaced: number; retracted: number; conflicts: number };
  artifacts: number;
  chunks: number;
  entities: number;
  openMergeSuggestions: number;
};

/** Counts within the request's scope (design §17 "stats"). */
export function knowledgeStats(env: ViewEnv): KnowledgeStats {
  const { store, scope, mode } = env;
  const p = visParams(scope, mode);
  const lc = store.db
    .prepare(`SELECT f.lifecycle AS lc, COUNT(*) AS n FROM findings f WHERE ${factVisibleSql('f')} GROUP BY f.lifecycle`)
    .all(p) as Array<{ lc: string; n: number }>;
  const by = (k: string) => Number(lc.find((r) => r.lc === k)?.n ?? 0);
  const usable = visibleFacts(env, factUsableSql('f'));
  const one = (sql: string) => Number((store.db.prepare(sql).get(p) as { n: number }).n);
  return {
    scope: mode,
    facts: {
      current: by('current'),
      usable: usable.length,
      stale: usable.filter((f) => factFreshness(store, f, env.config, env.now ?? new Date()).stale).length,
      candidate: by('candidate'),
      replaced: by('replaced'),
      retracted: by('retracted'),
      conflicts: one(`SELECT COUNT(*) AS n FROM findings f WHERE ${factVisibleSql('f')} AND f.lineage_conflict = 1`),
    },
    artifacts: one(`SELECT COUNT(*) AS n FROM artifacts a WHERE ${artifactVisibleSql('a')}`),
    chunks: one(`SELECT COUNT(*) AS n FROM chunks c JOIN artifacts a ON a.id = c.artifact_id WHERE ${artifactVisibleSql('a')}`),
    entities: listEntities(store, scope).filter((e) => entityVisibleIn(store, scope, mode, e)).length,
    openMergeSuggestions: visibleMergeSuggestions(env).length,
  };
}
