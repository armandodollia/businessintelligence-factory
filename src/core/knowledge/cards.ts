/**
 * Computed cards (design §10; decision 6): assembled by code at query time from reviewed records,
 * within the caller's scope and budget. No agent writes a card; nothing here is stored.
 *
 * Entity card: name, kind, aliases (upload-only aliases marked), home node; typed records (competitor
 * ratings, persona segment and top fields, symptom detail and its hypotheses); the top current usable
 * facts, one line each `[id] claim (confirmed <date>, n sources)`, ranked by recommendations citing
 * them, recency of confirmation, confirm count; the last replacements / retractions (ids only);
 * relations by type (`neighbours`, live edges only); flows from captures; and a final line saying what
 * was left out and how to get it.
 *
 * Node card: scope and audiences, profile keys, symptoms and strengths, the entities with the most
 * current facts, top recommendations, counts (facts current / stale / history, artifacts) and the last
 * research run.
 *
 * Every line carries the ids whose text it shows (`refs`, for the retrieval log) and its upload flag;
 * an upload-derived line is marked `[upload]`.
 */
import type { Store } from '../store/db.js';
import type { Entity, Finding, RetrievalResultRef } from '../types.js';
import { audiencesOf, scopeOf } from '../workspace/tree.js';
import { entityNames, getEntity } from './entities.js';
import { factFreshness } from './facts.js';
import { entityIsUploadOnly, itemIsUploadDerived } from './provenance.js';
import { aroundVisible, artifactVisibleSql, day, factVisibleSql, isCrossNodeCausal, recordVisibleSql, visParams, type ReadEnv } from './readCommon.js';
import { neighbours, type Edge } from './relations.js';
import { SOURCE_TABLES } from './usable.js';
import type { KnowledgeScope, ScopeMode } from './scope.js';
import { servedLine } from './texts.js';
import { factUsableSql, outputUsableSql } from './usable.js';

export type CardLine = { text: string; refs: RetrievalResultRef[]; upload: boolean };

export type Card = {
  /** The fixed part of the card (always returned). */
  header: Record<string, unknown>;
  headerRefs: RetrievalResultRef[];
  headerUpload: boolean;
  /** Lines in priority order (budget drops the tail). */
  lines: CardLine[];
};

/** Facts shown on one entity card before the "left out" line (the rest: `search` with `entity_id`). */
export const CARD_MAX_FACTS = 15;
const CARD_MAX_NAMES_PER_TYPE = 10;
const LINE_TEXT = 300;

const mark = (line: CardLine): CardLine => (line.upload ? { ...line, text: `${line.text} [upload]` } : line);

function groupOf(store: Store, id: string): string[] {
  return (
    store.db
      .prepare(`WITH RECURSIVE grp(id) AS (SELECT ? UNION SELECT e.id FROM entities e JOIN grp ON e.merged_into_id = grp.id) SELECT id FROM grp`)
      .all(id) as Array<{ id: string }>
  ).map((r) => r.id);
}

/** Facts of an entity (survivor + merged rows) that are current, usable and visible; best first. */
export function cardFacts(store: Store, view: KnowledgeScope, mode: ScopeMode, group: string[]): Finding[] {
  const rows = store.db
    .prepare(
      `SELECT f.id AS id FROM findings f
       WHERE f.entity_id IN (SELECT value FROM json_each(:grp)) AND ${factUsableSql('f')} AND ${factVisibleSql('f')}
       ORDER BY (SELECT COUNT(*) FROM recommendations r, json_each(r.finding_ids) j WHERE j.value = f.id) DESC,
                COALESCE(f.last_confirmed_at, f.first_seen_at, f.created_at) DESC, f.confirm_count DESC, f.rowid`,
    )
    .all({ grp: JSON.stringify(group), ...visParams(view, mode) }) as Array<{ id: string }>;
  return rows.map((r) => store.findings.get(r.id)!);
}

/** `[id] claim (confirmed <date>, n sources)` with stale / source / upload markers. */
export function factLine(env: ReadEnv, f: Finding): CardLine {
  const ws = env.scope.workspaceId;
  const fresh = factFreshness(env.store, f, env.config, env.now);
  const sources = new Set(f.evidence).size;
  const extra = [`confirmed ${day(f.lastConfirmedAt ?? f.firstSeenAt ?? f.createdAt)}`, `${sources} source${sources === 1 ? '' : 's'}`];
  if (fresh.stale) extra.push('stale');
  if (f.workspaceId !== ws) extra.push(`source ${f.workspaceId}`);
  return mark({
    text: `[${f.id}] ${servedLine(env.store, ws, f.claim, LINE_TEXT)} (${extra.join(', ')})`,
    refs: [{ id: f.id, kind: 'fact' }],
    upload: f.uploadDerived === true,
  });
}

/** Name of another entity for a relation line, with its refs and upload status. */
function otherName(env: ReadEnv, id: string): { text: string; refs: RetrievalResultRef[]; upload: boolean } | undefined {
  try {
    const e = getEntity(env.store, env.scope, id);
    return { text: `${servedLine(env.store, env.scope.workspaceId, e.name, 120)} [${e.id}]`, refs: [{ id: e.id, kind: 'entity' }], upload: entityIsUploadOnly(env.store, e.id) };
  } catch {
    return undefined;
  }
}

function typedLines(env: ReadEnv, view: KnowledgeScope, mode: ScopeMode, group: string[]): CardLine[] {
  const { store } = env;
  const ws = env.scope.workspaceId;
  const p = { grp: JSON.stringify(group), ids: visParams(view, mode).ids };
  const ids = (table: string, usable: string) =>
    (store.db
      .prepare(`SELECT r.id AS id FROM ${table} r WHERE r.entity_id IN (SELECT value FROM json_each(:grp)) AND ${usable} AND ${recordVisibleSql('r')} ORDER BY r.rowid`)
      .all(p) as Array<{ id: string }>).map((r) => r.id);
  const out: CardLine[] = [];
  const src = (w: string) => (w !== ws ? ` (source ${w})` : '');
  for (const id of ids('competitors', outputUsableSql('r'))) {
    const c = store.competitors.get(id)!;
    const cmp = c.comparison;
    out.push(mark({
      text: `competitor [${c.id}]${c.site ? ` ${servedLine(store, ws, c.site, 80)}` : ''}: threat ${c.threat}/5, directness ${c.directness}/5; vs. this business: pricing ${cmp.pricing}, onboarding ${cmp.onboarding}, ux ${cmp.ux}, features ${cmp.features}${src(c.workspaceId)}`,
      refs: [{ id: c.id, kind: 'record' }], upload: itemIsUploadDerived(store, c.id),
    }));
  }
  for (const id of ids('personas', outputUsableSql('r'))) {
    const per = store.personas.get(id)!;
    const top = Object.entries(per.profile ?? {})
      .sort((a, b) => (b[1]?.confidence ?? 0) - (a[1]?.confidence ?? 0))
      .slice(0, 3)
      .map(([k, v]) => `${k}: ${servedLine(store, ws, v?.value ?? '', 80)}`);
    out.push(mark({
      text: `persona [${per.id}] segment "${servedLine(store, ws, per.segment, 80)}" (${per.audience ?? 'external'})${top.length ? `; ${top.join('; ')}` : ''}${src(per.workspaceId)}`,
      refs: [{ id: per.id, kind: 'record' }], upload: itemIsUploadDerived(store, per.id),
    }));
  }
  for (const id of ids('symptoms', '1')) {
    const s = store.symptoms.get(id)!;
    out.push(mark({
      text: `${s.kind} [${s.id}] ${servedLine(store, ws, s.title, 120)}: ${servedLine(store, ws, s.detail, 160)}${src(s.workspaceId)}`,
      refs: [{ id: s.id, kind: 'record' }], upload: itemIsUploadDerived(store, s.id),
    }));
    const hyps = store.db
      .prepare(`SELECT r.id AS id FROM symptom_hypotheses r WHERE r.symptom_id = :sym AND ${outputUsableSql('r')} AND ${recordVisibleSql('r')} ORDER BY r.confidence DESC, r.rowid`)
      .all({ sym: s.id, ids: p.ids }) as Array<{ id: string }>;
    for (const { id: hid } of hyps) {
      const h = store.symptomHypotheses.get(hid)!;
      out.push(mark({
        text: `  hypothesis [${h.id}] ${servedLine(store, ws, h.hypothesis, 200)} (confidence ${h.confidence}%)`,
        refs: [{ id: h.id, kind: 'record' }], upload: itemIsUploadDerived(store, h.id),
      }));
    }
  }
  return out;
}

function changeLines(store: Store, view: KnowledgeScope, mode: ScopeMode, group: string[]): CardLine[] {
  const rows = store.db
    .prepare(
      `SELECT f.id AS id, f.lifecycle AS lc,
         (SELECT n.id FROM findings n WHERE n.replaces_id = f.id AND n.lifecycle = 'current' ORDER BY n.version DESC LIMIT 1) AS next,
         (SELECT MAX(o.applied_at) FROM fact_observations o WHERE o.lineage_id = f.lineage_id AND o.status = 'applied' AND o.kind IN ('replace', 'retract')) AS at
       FROM findings f WHERE f.entity_id IN (SELECT value FROM json_each(:grp)) AND f.lifecycle IN ('replaced', 'retracted') AND ${factVisibleSql('f')}
       ORDER BY at DESC, f.rowid DESC LIMIT 5`,
    )
    .all({ grp: JSON.stringify(group), ...visParams(view, mode) }) as Array<{ id: string; lc: string; next: string | null; at: string | null }>;
  // Ids only: history claims are not shown on a card (expand the id for them).
  return rows.map((r) => ({
    text: r.lc === 'replaced' ? `changed [${r.id}] → [${r.next ?? '?'}]${r.at ? ` (${day(r.at)})` : ''}` : `retracted [${r.id}]${r.at ? ` (${day(r.at)})` : ''}`,
    refs: [],
    upload: false,
  }));
}

/** Home node of the record asserting an edge (its "source node"). */
function edgeSourceNode(store: Store, e: Edge): string | undefined {
  const row = store.db.prepare(`SELECT workspace_id AS w FROM ${SOURCE_TABLES[e.sourceKind]} WHERE id = ?`).get(e.sourceId) as { w: string } | undefined;
  return row?.w;
}

/**
 * Relation lines of an entity card. Which edges are listed is decided by `aroundVisible` (the request's
 * scope; its named causal case lists `causes` / `addresses` around a symptom or cause entity
 * tree-wide). A name is labelled `(source <node>)` when the record asserting its edge lives in another
 * node than the caller's; a causal edge shown across nodes also logs its edge and source record ids.
 */
function relationLines(env: ReadEnv, view: KnowledgeScope, mode: ScopeMode, survivor: Entity, group: Set<string>): { lines: CardLine[]; left: number } {
  const around: ReadEnv = { ...env, scope: view, mode };
  const edges = neighbours(env.store, view, survivor.id, { depth: 1, usableOnly: true, mode: 'tree' })
    .filter((e) => aroundVisible(around, { kind: 'relation', relation: e, anchor: survivor }));
  const byType = new Map<string, Array<{ other: string; edge: Edge }>>();
  for (const e of edges) {
    const out = group.has(e.fromEntityId);
    const other = out ? e.toEntityId : e.fromEntityId;
    const key = out ? `${e.type} →` : `← ${e.type}`;
    const list = byType.get(key) ?? [];
    if (!list.some((x) => x.other === other)) list.push({ other, edge: e });
    byType.set(key, list);
  }
  const lines: CardLine[] = [];
  let left = 0;
  for (const [type, others] of byType) {
    const names: CardLine[] = [];
    for (const { other, edge } of others.slice(0, CARD_MAX_NAMES_PER_TYPE)) {
      const n = otherName(env, other);
      if (!n) continue;
      const src = edgeSourceNode(env.store, edge);
      const label = src && src !== env.scope.workspaceId ? ` (source ${src})` : '';
      const causal = isCrossNodeCausal(edge, survivor);
      names.push({
        text: `${n.text}${label}`,
        refs: [...n.refs, ...(causal ? [{ id: edge.id, kind: 'relation' }, { id: edge.sourceId, kind: edge.sourceKind }] : [])],
        upload: n.upload || (causal && itemIsUploadDerived(env.store, edge.sourceId)),
      });
    }
    left += Math.max(0, others.length - CARD_MAX_NAMES_PER_TYPE);
    if (!names.length) continue;
    const upload = names.some((n) => n.upload);
    lines.push(mark({ text: `${type} ${names.map((n) => n.text).join(', ')}`, refs: names.flatMap((n) => n.refs), upload }));
  }
  return { lines, left };
}

function flowLines(env: ReadEnv, view: KnowledgeScope, mode: ScopeMode, group: string[]): CardLine[] {
  const rows = env.store.db
    .prepare(
      `SELECT cap.flow AS flow, cap.step AS step, cap.captured_at AS at, a.id AS art FROM artifact_captures cap JOIN artifacts a ON a.id = cap.artifact_id
       WHERE cap.entity_id IN (SELECT value FROM json_each(:grp)) AND cap.flow IS NOT NULL AND ${artifactVisibleSql('a')}
       ORDER BY cap.captured_at DESC, cap.rowid DESC`,
    )
    .all({ grp: JSON.stringify(group), ...visParams(view, mode) }) as Array<{ flow: string; step: number | null; at: string; art: string }>;
  const flows = new Map<string, { steps: Set<number>; last: string; arts: string[] }>();
  for (const r of rows) {
    const f = flows.get(r.flow) ?? { steps: new Set<number>(), last: r.at, arts: [] };
    if (r.step !== null) f.steps.add(r.step);
    if (!f.arts.includes(r.art)) f.arts.push(r.art);
    flows.set(r.flow, f);
  }
  return [...flows].map(([name, f]) => {
    // The flow name comes from the captures of these artifacts: served under their flags.
    const arts = f.arts.slice(0, 5);
    return mark({
      text: `flow "${servedLine(env.store, env.scope.workspaceId, name, 80)}": ${f.steps.size} step${f.steps.size === 1 ? '' : 's'}, last walked ${day(f.last)} (latest: ${arts[0]})`,
      refs: f.arts.map((id) => ({ id, kind: 'artifact' })),
      upload: f.arts.some((id) => env.store.artifacts.get(id)?.uploadDerived === true),
    });
  });
}

/** The card of entity `entityId` (any id of the tree; a merged row resolves to its survivor). */
export function entityCard(env: ReadEnv, view: KnowledgeScope, mode: ScopeMode, entityId: string, maxFacts = CARD_MAX_FACTS): Card {
  const { store } = env;
  const ws = env.scope.workspaceId;
  const names = entityNames(store, env.scope, entityId);
  const e = names.entity;
  const group = groupOf(store, e.id);
  const headerRefs: RetrievalResultRef[] = [{ id: e.id, kind: 'entity' }];
  for (const a of names.aliases) if (a.entityId) headerRefs.push({ id: a.entityId, kind: 'entity' });
  const header = {
    entity: {
      id: e.id,
      name: servedLine(store, ws, e.name, 200),
      kind: e.kind,
      home: e.workspaceId,
      ...(names.aliases.length ? { aliases: names.aliases.map((a) => (a.uploadOnly ? `${servedLine(store, ws, a.name, 120)} [upload]` : servedLine(store, ws, a.name, 120))) } : {}),
      ...(names.uploadOnly ? { upload: true } : {}),
    },
  };
  const lines: CardLine[] = [...typedLines(env, view, mode, group)];
  const facts = cardFacts(store, view, mode, group);
  lines.push(...facts.slice(0, maxFacts).map((f) => factLine(env, f)));
  lines.push(...changeLines(store, view, mode, group));
  const rel = relationLines(env, view, mode, e, new Set(group));
  lines.push(...rel.lines);
  lines.push(...flowLines(env, view, mode, group));
  const left: string[] = [];
  if (facts.length > maxFacts) left.push(`${facts.length - maxFacts} more current facts (search with entity_id "${e.id}")`);
  if (rel.left) left.push(`${rel.left} more related entities (expand "${e.id}")`);
  lines.push({
    text: left.length
      ? `left out: ${left.join('; ')}. Unverified and history facts: search with include_unverified / include_history.`
      : 'nothing left out of this card for your scope. Unverified and history facts: search with include_unverified / include_history.',
    refs: [], upload: false,
  });
  return { header, headerRefs, headerUpload: names.uploadOnly || names.aliases.some((a) => a.uploadOnly), lines };
}

/** The card of node `view.workspaceId` within its own view (`mode` node) or the tree. */
export function nodeCard(env: ReadEnv, view: KnowledgeScope, mode: ScopeMode): Card {
  const { store } = env;
  const ws = env.scope.workspaceId;
  const node = store.workspaces.get(view.workspaceId)!;
  const sc = scopeOf(node);
  const p = visParams(view, mode);
  const header = {
    node: {
      id: node.id,
      name: servedLine(store, ws, node.name, 200),
      level: sc.level,
      scope: servedLine(store, ws, sc.name, 200),
      ...(sc.description ? { description: servedLine(store, ws, sc.description, 400) } : {}),
      audiences: audiencesOf(node),
      ...(node.parentWorkspaceId ? { parent: node.parentWorkspaceId } : {}),
    },
    // Another node's card (read by id): labelled with its source node; it shows that node's own view.
    ...(node.id !== env.scope.workspaceId ? { source: node.id } : {}),
  };
  const lines: CardLine[] = [];
  const profile = store.profiles.get(node.id)?.data ?? {};
  const keys = Object.keys(profile);
  if (keys.length) lines.push({ text: `profile keys: ${keys.map((k) => servedLine(store, ws, k, 60)).join(', ')}`, refs: [], upload: false });

  // Counts (inside the scope predicate).
  const current = store.db
    .prepare(`SELECT f.id AS id FROM findings f WHERE ${factUsableSql('f')} AND ${factVisibleSql('f')}`)
    .all(p) as Array<{ id: string }>;
  const stale = current.filter((r) => factFreshness(store, store.findings.get(r.id)!, env.config, env.now).stale).length;
  const history = (store.db.prepare(`SELECT COUNT(*) AS n FROM findings f WHERE f.lifecycle IN ('replaced', 'retracted') AND ${factVisibleSql('f')}`).get(p) as { n: number }).n;
  const artifacts = (store.db.prepare(`SELECT COUNT(*) AS n FROM artifacts a WHERE ${artifactVisibleSql('a')}`).get(p) as { n: number }).n;
  lines.push({ text: `counts: facts ${current.length} current (${stale} stale), ${history} history; artifacts ${artifacts}`, refs: [], upload: false });

  const run = store.db
    .prepare('SELECT id, phase, status, started_at AS at FROM research_runs WHERE workspace_id = ? ORDER BY started_at DESC, rowid DESC LIMIT 1')
    .get(node.id) as { id: string; phase: string; status: string; at: string } | undefined;
  if (run) lines.push({ text: `last research run [${run.id}] ${run.phase} ${run.status}, started ${day(run.at)}`, refs: [], upload: false });

  const syms = store.db
    .prepare(`SELECT r.id AS id FROM symptoms r WHERE ${recordVisibleSql('r')} ORDER BY r.kind, r.rowid`)
    .all({ ids: p.ids }) as Array<{ id: string }>;
  for (const { id } of syms) {
    const s = store.symptoms.get(id)!;
    lines.push(mark({
      text: `${s.kind} [${s.id}] ${servedLine(store, ws, s.title, 160)}${s.workspaceId !== node.id ? ` (source ${s.workspaceId})` : ''}`,
      refs: [{ id: s.id, kind: 'record' }], upload: itemIsUploadDerived(store, s.id),
    }));
  }

  const ents = store.db
    .prepare(
      `SELECT e.id AS id, COUNT(f.id) AS n, MAX(COALESCE(f.last_confirmed_at, f.first_seen_at, f.created_at)) AS last FROM findings f
       JOIN entities e ON e.id = f.entity_id
       WHERE ${factUsableSql('f')} AND ${factVisibleSql('f')} GROUP BY e.id ORDER BY n DESC, last DESC, e.rowid LIMIT 8`,
    )
    .all(p) as Array<{ id: string; n: number; last: string }>;
  for (const r of ents) {
    try {
      const e = getEntity(store, env.scope, r.id);
      lines.push(mark({
        text: `entity ${servedLine(store, ws, e.name, 120)} (${e.kind}) [${e.id}]: ${r.n} current fact${r.n === 1 ? '' : 's'}, last confirmed ${day(r.last)}`,
        refs: [{ id: e.id, kind: 'entity' }], upload: entityIsUploadOnly(store, e.id),
      }));
    } catch {
      // not in this tree (cannot happen for visible facts)
    }
  }

  const recs = store.db
    .prepare(`SELECT r.id AS id FROM recommendations r WHERE ${outputUsableSql('r')} AND ${recordVisibleSql('r')} ORDER BY r.priority DESC, r.rowid LIMIT 5`)
    .all({ ids: p.ids }) as Array<{ id: string }>;
  for (const { id } of recs) {
    const r = store.recommendations.get(id)!;
    lines.push(mark({
      text: `recommendation [${r.id}] ${servedLine(store, ws, r.title, 160)} (priority ${r.priority})`,
      refs: [{ id: r.id, kind: 'record' }], upload: itemIsUploadDerived(store, r.id),
    }));
  }
  lines.push({ text: 'more: search (scope "tree" for the rest of the business), get_card with an entity_id, list_changes', refs: [], upload: false });
  return { header, headerRefs: [], headerUpload: false, lines };
}
