/**
 * Shared pieces of the KS-4 read tools (design §7.1, §9, §12): the request environment, visibility
 * predicates (SQL, so tree isolation is inside every FTS query), the reviewer slice check, and paging
 * that accounts for the whole response envelope (no response ever exceeds its budget).
 *
 * Visibility (design §7.1):
 * - queries (`search`, `list_changes`, cards) see the active ids of the scope: `node` (default) = the
 *   node, its descendants and its ancestors; `tree` (explicit) = the whole business tree;
 * - a read BY ID (`expand`, `read_artifact`) accepts any id of the caller's tree: naming the id is the
 *   explicit request (ids of siblings only reach an agent through a tree-wide query, `read_workspace`
 *   or a citation), and the item is labelled with its source node;
 * - an id outside the tree and an unknown id get the same `notFound` text (design §12).
 */
import type { BifConfig, KnowledgeBudgetKind, ProviderId } from '../config/schema.js';
import type { Store } from '../store/db.js';
import type { RetrievalResultRef, RetrievalRole } from '../types.js';
import { encodeCursor, decodeCursor, estimateTokens, fitToBudget } from './budget.js';
import { itemIsUploadDerived } from './provenance.js';
import { activeIds, type KnowledgeScope, type ScopeMode } from './scope.js';
import { artifactVisible, canonicalArtifactId, capText } from './texts.js';
import { FENCE_CLOSE, FENCE_OPEN } from './trust.js';
import type { Entity, EntityKind, Relation, RelationSourceKind, RelationType } from '../types.js';
import { getEntity } from './entities.js';
import { SOURCE_TABLES, sourceUsableSql, sourceVisibleSql } from './usable.js';

/** Who reads and with what limits. */
export type ReadEnv = {
  store: Store;
  config: Pick<BifConfig, 'knowledge'>;
  role: RetrievalRole;
  provider?: ProviderId;
  /** The caller's scope (from its workspace). */
  scope: KnowledgeScope;
  now: Date;
  /**
   * The request's scope (`scope` input; default `node`): what a response lists AROUND a named item
   * (card facts and relations, an entity's neighbours, a node card) and, through
   * `allowByIdSiblingRead`, whether an item outside node scope may be read by id.
   */
  mode?: ScopeMode;
  /**
   * Reviewer / escalation runs: the only ids they may read (design §9 "reviewer"). Nested items not in
   * the slice are left out of a response. `undefined` for every other role.
   */
  slice?: ReviewSlice;
};

/** Roles that only ever see usable facts and records (design §9). */
export function usableOnly(role: RetrievalRole): boolean {
  return role === 'synthesizer' || role === 'interviewer';
}

/** The task's review slice: its outputs, their evidence artifacts (and those artifacts' chunks), and the facts they confirm / replace / retract. */
export type ReviewSlice = { ids: Set<string>; artifactIds: Set<string> };

/** Whether `id` (any kind) may be read under the slice; always true without one. */
export function inSlice(env: Pick<ReadEnv, 'store' | 'slice'>, id: string): boolean {
  const s = env.slice;
  if (!s) return true;
  if (s.ids.has(id)) return true;
  if (id.startsWith('chk_')) {
    const row = env.store.db.prepare('SELECT artifact_id AS a FROM chunks WHERE id = ?').get(id) as { a: string } | undefined;
    if (!row) return false;
    for (const a of s.artifactIds) if (canonicalArtifactId(env.store, a) === row.a) return true;
  }
  return false;
}

/** What one read produced, before the envelope (tokens, cursor, content_trust) is added. */
export type ReadOutput = {
  data: Record<string, unknown>;
  /** Every item whose text the response carries, in response order (retrieval log, design §13). */
  results: RetrievalResultRef[];
  /** Known upload-derived text in the response (results are re-checked as well). */
  uploadDerived: boolean;
  /** The response left items out (budget); `cursor` continues. */
  truncated: boolean;
  more?: number;
  cursor?: string;
  relaxed?: boolean;
  notes?: string[];
  images?: Array<{ data: string; mimeType: string }>;
  /** Where this page started: a notice that serves nothing of it hands out this cursor and count. */
  restart?: { cursor: string; remaining: number };
  /**
   * Nothing of the page could be served within the budget (not even a shortened item or one character
   * of a passage): the dispatcher answers with the "repeat with a larger max_tokens" notice instead of a
   * page that would hand out a cursor to the same place.
   */
  stalled?: boolean;
  /** What the log stores as the query (search text, or a compact form of the input). */
  query: string;
  /** `node` | `tree` | `node:<id>`. */
  scopeLabel: string;
};

/** Ids of the visible set as a JSON array for `json_each` (SQL predicates below). */
export function idsParam(scope: KnowledgeScope, mode: ScopeMode): string {
  return JSON.stringify(activeIds(scope, mode));
}

/** SQL (0/1): fact `f` is visible — home in the tree, and a scope row in the active ids. Params `:tree`, `:ids`. */
export const factVisibleSql = (f: string): string =>
  `(${f}.workspace_id IN (SELECT value FROM json_each(:tree)) AND EXISTS (SELECT 1 FROM item_scopes s
     WHERE s.item_kind = 'fact' AND s.item_id = ${f}.id AND s.workspace_id IN (SELECT value FROM json_each(:ids))))`;

/** SQL (0/1): artifact `a` is visible. Params `:tree`, `:ids`. */
export const artifactVisibleSql = (a: string): string =>
  `(${a}.workspace_id IN (SELECT value FROM json_each(:tree)) AND EXISTS (SELECT 1 FROM item_scopes s
     WHERE s.item_kind = 'artifact' AND s.item_id = ${a}.id AND s.workspace_id IN (SELECT value FROM json_each(:ids))))`;

/** SQL (0/1): a typed record `r` (no scope rows) is visible by its workspace. Param `:ids`. */
export const recordVisibleSql = (r: string): string => `(${r}.workspace_id IN (SELECT value FROM json_each(:ids)))`;

/** `:tree` and `:ids` for the predicates above. */
export function visParams(scope: KnowledgeScope, mode: ScopeMode): { tree: string; ids: string } {
  return { tree: JSON.stringify(scope.treeIds), ids: idsParam(scope, mode) };
}

/** Days between an ISO date and `now` (0 for unparseable dates). */
export function ageDays(iso: string | undefined, now: Date): number | undefined {
  if (!iso) return undefined;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? Math.max(0, Math.floor((now.getTime() - t) / 86_400_000)) : undefined;
}

/** `YYYY-MM-DD` of an ISO date. */
export const day = (iso: string | undefined): string => (iso ?? '').slice(0, 10);

/** True when any result is upload-derived now (stored flags plus `itemIsUploadDerived`). */
export function anyUploadDerived(store: Store, results: readonly RetrievalResultRef[]): boolean {
  const seen = new Set<string>();
  for (const r of results) {
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    if (itemIsUploadDerived(store, r.id)) return true;
  }
  return false;
}

/** Deduplicates refs by id (first kind wins), keeping order. */
export function uniqueRefs(refs: readonly RetrievalResultRef[]): RetrievalResultRef[] {
  const seen = new Set<string>();
  const out: RetrievalResultRef[] = [];
  for (const r of refs) {
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    out.push(r);
  }
  return out;
}

/**
 * Tokens reserved for the envelope the dispatcher adds (`tokens`, `truncated`, `more`, `cursor`,
 * `content_trust`, `relaxed`, `notes`). Notes are counted separately by the caller.
 */
export const ENVELOPE_TOKENS = 48;

/** A page of items, plus where it started (to repeat it with a larger budget). */
export type ItemPage<T> = {
  items: T[];
  truncated: boolean;
  more: number;
  cursor?: string;
  offset: number;
  /** A cursor for this same page (the "nothing fits" notice hands it out: repeat with a larger max_tokens). */
  startCursor: string;
  /** Items from `offset` on (what a notice says was left out when nothing of the page is served). */
  remaining: number;
  /** Nothing fit, not even the next item shortened. */
  stalled?: boolean;
};

/**
 * One page of `items` for a response whose fixed part is `header`; the whole JSON stays within `budget`.
 * Never skips an item (KS-8 ruling): when the next item alone is larger than the page, it is shortened
 * to fit (`shortenItem`, marked `cut: true`; `expand` of its id gives the full text) and the cursor
 * moves past it.
 */
export function pageOf<T>(
  items: readonly T[],
  header: Record<string, unknown>,
  budget: number,
  opts: { key: string; cursor?: string; notes?: readonly string[]; itemsKey?: string },
): ItemPage<T> {
  const offset = opts.cursor ? Math.min(decodeCursor(opts.cursor, opts.key), items.length) : 0;
  const overhead =
    estimateTokens(JSON.stringify({ ...header, [opts.itemsKey ?? 'items']: [] })) +
    ENVELOPE_TOKENS +
    (opts.notes?.length ? estimateTokens(JSON.stringify(opts.notes)) : 0);
  const rest = items.slice(offset);
  const startCursor = encodeCursor({ key: opts.key, offset });
  const fit = fitToBudget(rest, (x) => JSON.stringify(x), budget, overhead);
  if (!fit.items.length && rest.length) {
    const room = budget - overhead;
    const short = shortenItem(rest[0], (x) => estimateTokens(`${JSON.stringify(x)}\n`) <= room) as T | undefined;
    if (short === undefined) return { items: [], truncated: true, more: rest.length, offset, startCursor, remaining: rest.length, stalled: true };
    const page: ItemPage<T> = { items: [short], truncated: true, more: rest.length - 1, offset, startCursor, remaining: rest.length };
    if (rest.length > 1) page.cursor = encodeCursor({ key: opts.key, offset: offset + 1 });
    return page;
  }
  const out: ItemPage<T> = { items: fit.items, truncated: fit.truncated, more: fit.more, offset, startCursor, remaining: rest.length };
  if (fit.more > 0 && fit.items.length > 0) out.cursor = encodeCursor({ key: opts.key, offset: offset + fit.items.length });
  return out;
}

/** Fields never shortened: ids, kinds, states, dates (they are short, and an id is how the full text is fetched). */
const KEEP_WHOLE = /^(id|kind|type|source|status|lifecycle|change|relation|mode|flags|cited_by)$|_ids?$|_at$/;
/** Angle-bracket runs (incl. lookalikes) a cut must not end inside (see `stripFences`). */
const TRAILING_ANGLES = /[<>＜﹤＞﹥]+$/;

/**
 * `s` cut to about `max` characters, never inside a fence marker: a fenced value
 * (`<<<EVIDENCE id\n…\n>>>`) keeps its opening line and closing marker and is cut inside; any other
 * value is cut and loses a trailing run of angle brackets. Served text is redacted before it gets here.
 */
export function cutServedText(s: string, max: number): string {
  if (s.length <= max) return s;
  const nl = s.indexOf('\n');
  if (s.startsWith(`${FENCE_OPEN} `) && nl > 0 && s.endsWith(`\n${FENCE_CLOSE}`)) {
    const head = s.slice(0, nl + 1);
    const inner = s.slice(nl + 1, s.length - FENCE_CLOSE.length - 1);
    return `${head}${capText(inner, Math.max(0, max - head.length - FENCE_CLOSE.length - 2))}\n${FENCE_CLOSE}`;
  }
  const cut = capText(s, Math.max(0, max));
  return cut.endsWith('…') ? `${cut.slice(0, -1).replace(TRAILING_ANGLES, '')}…` : cut;
}

/**
 * The item shortened so that `fits` holds, marked `cut: true` (a string becomes `{ text, cut: true }`):
 * every text field longer than a common cap is cut to it (`cutServedText`), and when that is not
 * enough every list field keeps only its first entries; the largest caps that fit win. Ids, kinds,
 * states and dates are kept whole. `undefined` when even the barest form does not fit.
 */
export function shortenItem(item: unknown, fits: (x: unknown) => boolean): unknown {
  const wrap = (x: unknown) => (typeof item === 'string' || typeof x !== 'object' || x === null ? { text: x, cut: true } : { ...(x as object), cut: true });
  let longest = 0;
  let longestList = 0;
  const scan = (v: unknown, key?: string): void => {
    if (key !== undefined && KEEP_WHOLE.test(key)) return;
    if (typeof v === 'string') longest = Math.max(longest, v.length);
    else if (Array.isArray(v)) {
      longestList = Math.max(longestList, v.length);
      v.forEach((x) => scan(x));
    } else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) scan(x, k);
  };
  scan(item);
  const capped = (v: unknown, n: number, m: number, key?: string): unknown => {
    if (key !== undefined && KEEP_WHOLE.test(key)) return v;
    if (typeof v === 'string') return cutServedText(v, n);
    if (Array.isArray(v)) return v.slice(0, m).map((x) => capped(x, n, m));
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, capped(x, n, m, k)]));
    return v;
  };
  const ok = (n: number, m: number) => fits(wrap(capped(item, n, m)));
  /** Largest value in [lo, hi] for which `test` holds (monotone), or `undefined`. */
  const largest = (lo: number, hi: number, test: (x: number) => boolean): number | undefined => {
    if (!test(lo)) return undefined;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (test(mid)) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  };
  // Prefer whole lists with shorter text; else fewer list entries with at least a snippet of text each.
  const n = largest(0, longest, (x) => ok(x, longestList));
  if (n !== undefined) return wrap(capped(item, n, longestList));
  for (const floor of [Math.min(80, longest), 0]) {
    const m = largest(0, longestList, (x) => ok(floor, x));
    if (m === undefined) continue;
    const best = largest(floor, longest, (x) => ok(x, m))!;
    return wrap(capped(item, best, m));
  }
  return undefined;
}

/** Budget kind of each read tool (design §9; KS-0 notes: `read_artifact` uses `expand`, `list_changes` uses `search`). */
export const BUDGET_KIND: Record<string, KnowledgeBudgetKind> = {
  search: 'search',
  get_card: 'card',
  expand: 'expand',
  read_artifact: 'expand',
  list_changes: 'search',
  read_workspace: 'card',
};

// ---------------------------------------------------------------------------
// Reads by id (design §7.1, ruling after the KS-4 gate)

/**
 * THE sibling rule for reads by id (`expand`, `read_artifact`, `get_card`, `read_workspace` with a
 * `workspace_id`): may a request read an item of the caller's tree that is OUTSIDE its node scope (a
 * sibling's or cousin's), when it names the item's id?
 *
 * Ruling (confirmed by the user, design §3 decision 13: nothing inside a tree is confidential from
 * another node of it): yes, in node scope too —
 * same-tree nodes may read and cite each other, and an agent only holds a sibling id because it asked
 * tree-wide or because in-scope evidence cites it. The item is labelled with its source node; what
 * the response lists AROUND it still follows the request's scope.
 *
 * If the user rules that such reads need `scope: "tree"`, this is the one line to change:
 * `return mode === 'tree';`.
 */
export function allowByIdSiblingRead(_scope: KnowledgeScope, _mode: ScopeMode): boolean {
  return true;
}

/** Whether an item of the caller's tree may be read by id: in node scope, or allowed by `allowByIdSiblingRead`. */
export function readableById(scope: KnowledgeScope, mode: ScopeMode, inNodeScope: boolean): boolean {
  return inNodeScope || allowByIdSiblingRead(scope, mode);
}

/** A fact is in node scope when one of its scope rows is a node id of the view. */
export function factInNodeScope(store: Store, scope: KnowledgeScope, factId: string): boolean {
  return (
    store.db
      .prepare(`SELECT 1 FROM item_scopes s WHERE s.item_kind = 'fact' AND s.item_id = ? AND s.workspace_id IN (SELECT value FROM json_each(?)) LIMIT 1`)
      .get(factId, JSON.stringify(scope.nodeIds)) !== undefined
  );
}

/** An artifact is in node scope when one of its scope rows is a node id of the view. */
export function artifactInNodeScope(store: Store, scope: KnowledgeScope, artifactId: string): boolean {
  return artifactVisible(store, scope, artifactId, 'node');
}

function entityGroupIds(store: Store, id: string): string[] {
  return (
    store.db
      .prepare(`WITH RECURSIVE grp(id) AS (SELECT ? UNION SELECT e.id FROM entities e JOIN grp ON e.merged_into_id = grp.id) SELECT id FROM grp`)
      .all(id) as Array<{ id: string }>
  ).map((r) => r.id);
}

/**
 * An entity (survivor) is visible in `mode`: always in tree mode; in node mode when its home is a node
 * id of the view or a visible record (fact, typed record, capture) references it or a merged row.
 */
export function entityVisibleIn(store: Store, view: KnowledgeScope, mode: ScopeMode, e: Entity): boolean {
  if (mode === 'tree') return view.treeIds.includes(e.workspaceId) || e.rootWorkspaceId === view.rootId;
  if (view.nodeIds.includes(e.workspaceId)) return true;
  const p = { ...visParams(view, mode), grp: JSON.stringify(entityGroupIds(store, e.id)) };
  // node:sqlite rejects unused named parameters: records bind only `:ids` and `:grp`.
  const hit = (sql: string, params: Record<string, string>) => store.db.prepare(sql).get(params) !== undefined;
  return (
    hit(`SELECT 1 FROM findings f WHERE f.entity_id IN (SELECT value FROM json_each(:grp)) AND ${factVisibleSql('f')} LIMIT 1`, p) ||
    ['competitors', 'personas', 'symptoms', 'symptom_hypotheses'].some((t) =>
      hit(`SELECT 1 FROM ${t} r WHERE r.entity_id IN (SELECT value FROM json_each(:grp)) AND ${recordVisibleSql('r')} LIMIT 1`, { ids: p.ids, grp: p.grp }),
    ) ||
    hit(`SELECT 1 FROM artifact_captures cap JOIN artifacts a ON a.id = cap.artifact_id
         WHERE cap.entity_id IN (SELECT value FROM json_each(:grp)) AND ${artifactVisibleSql('a')} LIMIT 1`, p)
  );
}

// ---------------------------------------------------------------------------
// What a by-id response lists AROUND the named item (re-gate: one helper for every such list)

/**
 * Something listed around a named item: a fact, an artifact, a typed record or capture (by workspace),
 * an entity, or a relation of the named entity (`anchor`: that entity).
 */
export type AroundItem =
  | { kind: 'fact'; id: string }
  | { kind: 'artifact'; id: string }
  | { kind: 'workspace'; workspaceId: string }
  | { kind: 'entity'; entity: Entity }
  | { kind: 'relation'; relation: Relation; anchor: Entity };

/**
 * Causal relation types (user decision, design §3): around a symptom or cause entity they are listed
 * TREE-WIDE in node scope too (an HR cause of a Product symptom must be findable from Product), each
 * labelled with its source node. Every other relation type keeps the node boundary.
 */
export const CAUSAL_RELATION_TYPES: readonly RelationType[] = ['causes', 'addresses'];
/** Entity kinds whose causal relations cross nodes by default. */
export const CAUSAL_ANCHOR_KINDS: readonly EntityKind[] = ['symptom', 'cause'];

/** The causal case of `aroundVisible`: a `causes` / `addresses` edge around a symptom or cause entity. */
export function isCrossNodeCausal(relation: Pick<Relation, 'type'>, anchor: Pick<Entity, 'kind'>): boolean {
  return CAUSAL_RELATION_TYPES.includes(relation.type) && CAUSAL_ANCHOR_KINDS.includes(anchor.kind);
}

/**
 * Whether a relation is shown around `anchor` by the named causal case (decision 15): a causal type
 * around a symptom / cause entity, asserted by a record anywhere in the tree. The ONE rule for causal
 * edges: `aroundVisible` (cards, `expand`) and `crossNodeCausalEdges` (KS-5 briefings) both call it.
 */
export function causalEdgeShown(store: Store, scope: KnowledgeScope, relation: Relation, anchor: Pick<Entity, 'kind'>): boolean {
  return relation.rootWorkspaceId === scope.rootId && isCrossNodeCausal(relation, anchor) && relationSourceVisible(store, scope, 'tree', relation);
}

/** Node of the record asserting an edge (its "source node", used for every `source` label of an edge). */
export function relationSourceNode(store: Store, r: Pick<Relation, 'sourceKind' | 'sourceId'>): string | undefined {
  const table = SOURCE_TABLES[r.sourceKind as keyof typeof SOURCE_TABLES];
  if (!table) return undefined;
  const row = store.db.prepare(`SELECT workspace_id AS w FROM ${table} WHERE id = ?`).get(r.sourceId) as { w: string } | undefined;
  return row?.w;
}

/** A causal edge listed tree-wide: its endpoints (survivors) and the node of the record asserting it. */
export type CausalEdge = {
  relation: Relation;
  type: RelationType;
  from: Entity;
  to: Entity;
  sourceKind: RelationSourceKind;
  sourceId: string;
  sourceWorkspaceId: string;
};

/**
 * Live causal edges of the scope's WHOLE tree that span more than one node (the two entities' home
 * nodes and the asserting record's node are not all the same), oldest first — for the company-level
 * briefing (KS-5 user ruling). An edge is kept only when `causalEdgeShown` holds around one of its
 * ends, so the briefing lists exactly what the cards of those entities list in node scope (KS-7).
 */
export function crossNodeCausalEdges(store: Store, scope: KnowledgeScope, max = 50): CausalEdge[] {
  const rows = store.db
    .prepare(
      `SELECT r.id, r.root_workspace_id AS root, r.from_entity_id AS f, r.to_entity_id AS t, r.type, r.source_kind AS sk,
              r.source_id AS sid, r.created_at AS at
       FROM relations r
       WHERE r.root_workspace_id = ? AND r.type IN (SELECT value FROM json_each(?)) AND ${sourceUsableSql('r.source_kind', 'r.source_id')} = 1
       ORDER BY r.rowid`,
    )
    .all(scope.rootId, JSON.stringify(CAUSAL_RELATION_TYPES)) as Array<Record<string, string>>;
  const out: CausalEdge[] = [];
  for (const r of rows) {
    const relation: Relation = {
      id: r.id!, rootWorkspaceId: r.root!, fromEntityId: r.f!, type: r.type as RelationType, toEntityId: r.t!,
      sourceKind: r.sk as RelationSourceKind, sourceId: r.sid!, createdAt: r.at!,
    };
    let from: Entity;
    let to: Entity;
    try {
      from = getEntity(store, scope, relation.fromEntityId);
      to = getEntity(store, scope, relation.toEntityId);
    } catch {
      continue;
    }
    if (!causalEdgeShown(store, scope, relation, from) && !causalEdgeShown(store, scope, relation, to)) continue;
    const src = relationSourceNode(store, relation);
    if (!src || new Set([from.workspaceId, to.workspaceId, src]).size < 2) continue;
    out.push({ relation, type: relation.type, from, to, sourceKind: relation.sourceKind, sourceId: relation.sourceId, sourceWorkspaceId: src });
    if (out.length >= max) break;
  }
  return out;
}

/** Whether the record asserting an edge is visible from the active ids of `mode` (design §7.1). */
function relationSourceVisible(store: Store, scope: KnowledgeScope, mode: ScopeMode, r: Relation): boolean {
  const row = store.db
    .prepare(`WITH vis(ws) AS (SELECT value FROM json_each(:vis)) SELECT ${sourceVisibleSql(':k', ':id')} AS v`)
    .get({ vis: idsParam(scope, mode), k: r.sourceKind, id: r.sourceId }) as { v: number } | undefined;
  return row?.v === 1;
}

/**
 * Whether an item listed around a named one may be shown: it follows the request's scope (`env.mode`,
 * node by default) exactly like a query — node scope sees the view's node ids, `tree` the whole tree.
 * Every around-item list of `expand` / `read_artifact` goes through here (page versions, captures,
 * fact versions and updates, evidence metadata, relation names); cards use the same mode directly.
 */
export function aroundVisible(env: ReadEnv, item: AroundItem): boolean {
  const mode = env.mode ?? 'node';
  const { store, scope } = env;
  switch (item.kind) {
    case 'fact': {
      const f = store.findings.get(item.id);
      if (!f || !scope.treeIds.includes(f.workspaceId)) return false;
      return mode === 'tree' || factInNodeScope(store, scope, item.id);
    }
    case 'artifact':
      return artifactVisible(store, scope, item.id, mode);
    case 'workspace':
      return activeIds(scope, mode).includes(item.workspaceId);
    case 'entity':
      return entityVisibleIn(store, scope, mode, item.entity);
    case 'relation':
      // Same tree always; then the named case (`causalEdgeShown`): causal edges around a symptom / cause cross nodes.
      if (item.relation.rootWorkspaceId !== scope.rootId) return false;
      if (mode === 'tree') return relationSourceVisible(store, scope, 'tree', item.relation);
      return causalEdgeShown(store, scope, item.relation, item.anchor) || relationSourceVisible(store, scope, mode, item.relation);
  }
}

/** `{ source }` label of an item whose home is not the caller's node. */
export function sourceLabel(env: ReadEnv, workspaceId: string | undefined): { source?: string } {
  return workspaceId && workspaceId !== env.scope.workspaceId ? { source: workspaceId } : {};
}

/** Note for a response that left around-items out because of node scope. */
export function outsideScopeNote(n: number): string {
  return `${n} related item(s) outside node scope left out: repeat with scope "tree" to include them`;
}
