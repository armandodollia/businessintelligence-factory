/**
 * `list_changes` (design §9): what changed in the caller's scope since a time (`since`, default the
 * last 30 days) or during a research run (`run_id`): new facts, replacements (old → new), retractions
 * — from APPLIED observations, so only reviewed changes appear — facts that became stale in the window,
 * and changed pages that current facts cite (a later capture of the same URL with different text).
 *
 * Observing a fact past its TTL records KS-2's lazy WP-C `stale` outcome (`recordStaleOutcome`,
 * idempotent per fact version and `last_confirmed_at`), so the first observation writes it once.
 *
 * Synthesizer and interviewer see usable facts only: old claims of replacements and retracted claims
 * are shown as ids.
 */
import { knowledgeRepos } from '../store/repos.js';
import type { Finding, RetrievalResultRef } from '../types.js';
import { cursorKey } from './budget.js';
import { getEntity } from './entities.js';
import { factFreshness, recordStaleOutcome } from './facts.js';
import { artifactVisibleSql, cursorAtItem, day, factVisibleSql, pageOf, usableOnly, visParams, type ReadEnv, type ReadOutput } from './readCommon.js';
import { notFound, type KnowledgeScope, type ScopeMode } from './scope.js';
import { servedLine } from './texts.js';
import { factUsableSql } from './usable.js';

export type ChangesInput = { since?: string; runId?: string; entityId?: string; scope?: ScopeMode; cursor?: string };

/** Window used when neither `since` nor `run_id` is given. */
export const DEFAULT_CHANGES_DAYS = 30;
const CLAIM = 240;

type Change = { item: Record<string, unknown>; refs: RetrievalResultRef[]; upload: boolean };

export function runListChanges(env: ReadEnv, view: KnowledgeScope, input: ChangesInput, budget: number, cursorParts: unknown): ReadOutput {
  const { store } = env;
  const ws = env.scope.workspaceId;
  const mode = input.scope ?? 'node';
  let since = input.since;
  if (input.runId) {
    const run = store.researchRuns.get(input.runId);
    if (!run || !env.scope.treeIds.includes(run.workspaceId)) throw notFound('run', input.runId);
    since = run.startedAt;
  }
  since ??= new Date(env.now.getTime() - DEFAULT_CHANGES_DAYS * 86_400_000).toISOString();
  let group: string[] | undefined;
  if (input.entityId) {
    const e = getEntity(store, env.scope, input.entityId);
    group = (store.db
      .prepare(`WITH RECURSIVE grp(id) AS (SELECT ? UNION SELECT e.id FROM entities e JOIN grp ON e.merged_into_id = grp.id) SELECT id FROM grp`)
      .all(e.id) as Array<{ id: string }>).map((r) => r.id);
  }
  const hide = usableOnly(env.role);
  const vis = visParams(view, mode);
  const entityWhere = group ? 'AND f.entity_id IN (SELECT value FROM json_each(:grp))' : '';
  const base: Record<string, string> = { ...vis, ...(group ? { grp: JSON.stringify(group) } : {}) };
  const claim = (f: Finding | undefined) => (f ? servedLine(store, ws, f.claim, CLAIM) : undefined);
  const changes: Change[] = [];

  // Applied observations (reviewed changes) in the window.
  const obsRows = store.db
    .prepare(
      `SELECT o.id AS id FROM fact_observations o JOIN findings f ON f.id = o.finding_id
       WHERE o.status = 'applied' AND o.kind IN ('create', 'replace', 'retract')
         AND ${input.runId ? 'o.run_id = :run' : 'o.applied_at >= :since'} AND ${factVisibleSql('f')} ${entityWhere}
       ORDER BY CASE o.kind WHEN 'create' THEN 0 WHEN 'replace' THEN 1 ELSE 2 END, o.applied_at DESC, o.rowid DESC`,
    )
    .all({ ...base, ...(input.runId ? { run: input.runId } : { since }) }) as Array<{ id: string }>;
  const obsRepo = knowledgeRepos(store).factObservations;
  for (const { id } of obsRows) {
    const o = obsRepo.get(id)!;
    const f = store.findings.get(o.findingId)!;
    if (o.kind === 'create') {
      if (hide && !(f.lifecycle === 'current')) continue;
      changes.push({ item: { change: 'new', id: f.id, claim: claim(f), date: day(o.appliedAt), lifecycle: f.lifecycle ?? 'current', ...(f.workspaceId !== ws ? { source: f.workspaceId } : {}), ...(f.uploadDerived ? { upload: true } : {}) },
        refs: [{ id: f.id, kind: 'fact' }], upload: f.uploadDerived === true });
    } else if (o.kind === 'replace') {
      const prior = o.priorFindingId ? store.findings.get(o.priorFindingId) : undefined;
      const from: Record<string, unknown> = { id: o.priorFindingId };
      const refs: RetrievalResultRef[] = [{ id: f.id, kind: 'fact' }];
      let upload = f.uploadDerived === true;
      if (prior && !hide) {
        from.claim = claim(prior);
        refs.push({ id: prior.id, kind: 'fact' });
        upload ||= prior.uploadDerived === true;
      }
      changes.push({ item: { change: 'replaced', from, to: { id: f.id, claim: claim(f) }, date: day(o.appliedAt), ...(upload ? { upload: true } : {}) }, refs, upload });
    } else {
      const item: Record<string, unknown> = { change: 'retracted', id: f.id, date: day(o.appliedAt) };
      let refs: RetrievalResultRef[] = [];
      let upload = false;
      if (!hide) {
        item.claim = claim(f);
        if (o.reason) item.reason = servedLine(store, ws, o.reason, CLAIM);
        refs = [{ id: f.id, kind: 'fact' }];
        upload = f.uploadDerived === true;
        if (upload) item.upload = true;
      }
      changes.push({ item, refs, upload });
    }
  }

  // Facts that became stale in the window (and the lazy `stale` outcome for every stale one observed).
  const current = store.db
    .prepare(`SELECT f.id AS id FROM findings f WHERE ${factUsableSql('f')} AND ${factVisibleSql('f')} ${entityWhere} ORDER BY f.rowid`)
    .all(base) as Array<{ id: string }>;
  const sinceMs = Date.parse(since);
  const stale: Array<{ f: Finding; at: number }> = [];
  for (const { id } of current) {
    const f = store.findings.get(id)!;
    const fresh = factFreshness(store, f, env.config, env.now);
    if (!fresh.stale) continue;
    recordStaleOutcome(store, env.config, f, env.now);
    const at = Date.parse(fresh.since) + fresh.ttlDays * 86_400_000;
    if (!Number.isFinite(sinceMs) || at >= sinceMs) stale.push({ f, at });
  }
  stale.sort((a, b) => b.at - a.at);
  for (const { f, at } of stale) {
    const fresh = factFreshness(store, f, env.config, env.now);
    changes.push({
      item: { change: 'stale', id: f.id, claim: claim(f), last_confirmed: day(fresh.since), ttl_days: fresh.ttlDays, stale_since: day(new Date(at).toISOString()), ...(f.uploadDerived ? { upload: true } : {}) },
      refs: [{ id: f.id, kind: 'fact' }], upload: f.uploadDerived === true,
    });
  }

  // Changed pages that current facts cite: a later capture of the same URL (in the window) with other text.
  const pages = store.db
    .prepare(
      `SELECT DISTINCT a.id AS cited, n.id AS newer, n.captured_at AS at FROM findings f, json_each(f.evidence) ev
         JOIN artifacts a ON a.id = ev.value
         JOIN artifact_texts ta ON ta.artifact_id = a.id
         JOIN artifacts n ON n.url_key = a.url_key AND n.id <> a.id AND n.captured_at > a.captured_at
         JOIN artifact_texts tn ON tn.artifact_id = n.id
       WHERE ${factUsableSql('f')} AND ${factVisibleSql('f')} ${entityWhere}
         AND a.url_key IS NOT NULL AND n.captured_at >= :since AND ${artifactVisibleSql('n')}
         AND ta.content_sha256 IS NOT NULL AND tn.content_sha256 IS NOT NULL
         AND COALESCE((SELECT d.content_sha256 FROM artifact_texts d WHERE d.artifact_id = ta.duplicate_of), ta.content_sha256)
          <> COALESCE((SELECT d.content_sha256 FROM artifact_texts d WHERE d.artifact_id = tn.duplicate_of), tn.content_sha256)
       ORDER BY n.captured_at DESC, n.rowid DESC`,
    )
    .all({ ...base, since }) as Array<{ cited: string; newer: string; at: string }>;
  const seenPairs = new Set<string>();
  for (const p of pages) {
    if (seenPairs.has(p.cited)) continue; // newest later capture per cited page
    seenPairs.add(p.cited);
    const a = store.artifacts.get(p.cited)!;
    const n = store.artifacts.get(p.newer)!;
    const citedBy = (store.db
      .prepare(`SELECT f.id AS id FROM findings f, json_each(f.evidence) ev WHERE ev.value = :a AND ${factUsableSql('f')} AND ${factVisibleSql('f')} ORDER BY f.rowid`)
      .all({ ...vis, a: a.id }) as Array<{ id: string }>).map((r) => r.id);
    const upload = a.uploadDerived === true || n.uploadDerived === true;
    changes.push({
      item: { change: 'page_changed', artifact_id: a.id, newer_artifact_id: n.id, url: servedLine(store, ws, a.sourceUrl ?? a.urlKey ?? '', 300), captured: day(p.at), cited_by: citedBy, ...(upload ? { upload: true } : {}) },
      refs: [{ id: a.id, kind: 'artifact' }, { id: n.id, kind: 'artifact' }], upload,
    });
  }

  const header = { since, scope: mode, ...(input.runId ? { run_id: input.runId } : {}) };
  const notes = hide ? ['usable facts only: old and retracted claims are shown as ids'] : [];
  const key = cursorKey(cursorParts);
  // Re-gate (binding): a change carries more than any one item's `expand` returns (dates, both claims,
  // a reason), so a shortened change points at this same request, at it, with the budget that holds it.
  const page = pageOf(changes.map((c) => c.item), header, budget, {
    key, notes, itemsKey: 'changes', ...(input.cursor ? { cursor: input.cursor } : {}),
    recover: (_c, i, need) => env.again?.(cursorAtItem(key, i), need),
  });
  const shown = changes.slice(page.offset, page.offset + page.items.length);
  const out: ReadOutput = {
    data: { ...header, changes: page.items },
    results: shown.flatMap((c) => c.refs),
    uploadDerived: shown.some((c) => c.upload),
    truncated: page.truncated,
    restart: { cursor: page.startCursor, remaining: page.remaining },
    more: page.more,
    notes,
    query: input.runId ? `run ${input.runId}` : `since ${since}`,
    scopeLabel: view.workspaceId !== env.scope.workspaceId ? `node:${view.workspaceId}` : mode,
  };
  if (page.stalled) out.stalled = true;
  if (page.cursor) out.cursor = page.cursor;
  return out;
}
