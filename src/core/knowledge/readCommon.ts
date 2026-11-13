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
import { artifactVisible, canonicalArtifactId } from './texts.js';
import type { Entity, EntityKind, Relation, RelationType } from '../types.js';
import { sourceVisibleSql } from './usable.js';

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
  /** A cursor for this same page (the truncation notice hands it out: repeat with a larger max_tokens). */
  startCursor: string;
  /** Items from `offset` on (what a notice says was left out when nothing of the page is served). */
  remaining: number;
};

/** One page of `items` for a response whose fixed part is `header`; the whole JSON stays within `budget`. */
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
    // The next item alone is larger than the budget: a placeholder takes its place, so paging never
    // stalls, and it carries the cursor that fetches exactly that item with a larger max_tokens. The
    // item counts as left out (`truncated`, `more`). Its ids are still logged (over-listing only).
    const placeholder = {
      omitted: true,
      note: 'this item is larger than the response budget: repeat with retry_cursor and a larger max_tokens',
      retry_cursor: startCursor,
    } as unknown as T;
    return {
      items: [placeholder], truncated: true, more: rest.length, offset, startCursor, remaining: rest.length,
      cursor: rest.length > 1 ? encodeCursor({ key: opts.key, offset: offset + 1 }) : startCursor,
    };
  }
  const out: ItemPage<T> = { items: fit.items, truncated: fit.truncated, more: fit.more, offset, startCursor, remaining: rest.length };
  if (fit.more > 0 && fit.items.length > 0) out.cursor = encodeCursor({ key: opts.key, offset: offset + fit.items.length });
  return out;
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
      // Same tree always; then the named case: causal edges around a symptom / cause cross nodes.
      if (item.relation.rootWorkspaceId !== scope.rootId) return false;
      if (mode === 'tree' || isCrossNodeCausal(item.relation, item.anchor)) return relationSourceVisible(store, scope, 'tree', item.relation);
      return relationSourceVisible(store, scope, mode, item.relation);
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
