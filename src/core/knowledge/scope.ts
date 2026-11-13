/**
 * Knowledge scope (design §7.1, §12 "Tree isolation"). Built once per tool call from the caller's
 * workspace (the `RunContext`); it is the only way a knowledge query obtains workspace ids.
 *
 * - `treeIds`: every node of the caller's business tree (root first, then breadth-first).
 * - `nodeIds`: the caller, its descendants, then its ancestors (nearest first) — the default view.
 * - Nothing ever crosses trees: ids supplied by an agent are checked against `treeIds`, and an
 *   out-of-tree id gets exactly the same error as an unknown one (`notFound`).
 *
 * Invariant relied on: a workspace's parent never changes after creation (re-parenting would have
 * to rewrite `entities.root_workspace_id`).
 */
import type { Store } from '../store/db.js';
import { knowledgeRepos } from '../store/repos.js';
import type { ScopedItemKind, ScopeSource } from '../types.js';
import { ancestors, descendants, rootOf } from '../workspace/tree.js';

export type KnowledgeScope = {
  /** The node the view is for (the caller, or the node a query narrowed to). */
  workspaceId: string;
  rootId: string;
  treeIds: string[];
  nodeIds: string[];
  /** Ancestors of `workspaceId`, nearest first (a subset of `nodeIds`; used for ranking). */
  ancestorIds: string[];
};

export type ScopeMode = 'node' | 'tree';

/** "Not found" for an unknown id and an id outside the caller's tree alike (design §12). */
export class KnowledgeNotFoundError extends Error {
  constructor(kind: string, id: string) {
    super(`${kind} '${id}' not found`);
    this.name = 'KnowledgeNotFoundError';
  }
}

export function notFound(kind: string, id: string): KnowledgeNotFoundError {
  return new KnowledgeNotFoundError(kind, id);
}

function viewOf(store: Store, workspaceId: string, rootId: string, treeIds: string[]): KnowledgeScope {
  const ancestorIds = ancestors(store, workspaceId).map((w) => w.id);
  return {
    workspaceId,
    rootId,
    treeIds,
    nodeIds: [workspaceId, ...descendants(store, workspaceId).map((w) => w.id), ...ancestorIds],
    ancestorIds,
  };
}

/** The scope of a caller in `workspaceId`. Throws `KnowledgeNotFoundError` for an unknown workspace. */
export function scopeFor(store: Store, workspaceId: string): KnowledgeScope {
  if (!store.workspaces.get(workspaceId)) throw notFound('workspace', workspaceId);
  const rootId = rootOf(store, workspaceId);
  const treeIds = [rootId, ...descendants(store, rootId).map((w) => w.id)];
  return viewOf(store, workspaceId, rootId, treeIds);
}

/** Workspace ids a query in `mode` may read (design §7.1: `node` default, `tree` explicit). */
export function activeIds(s: KnowledgeScope, mode: ScopeMode): string[] {
  return mode === 'tree' ? s.treeIds : s.nodeIds;
}

/** True when `workspaceId` is a node of the scope's tree. */
export function inTree(s: KnowledgeScope, workspaceId: string): boolean {
  return s.treeIds.includes(workspaceId);
}

/**
 * The view of another node of the same tree (`workspace_id` input): that node's own `nodeIds`.
 * `undefined` when the node is unknown or in another tree — callers answer both with `notFound`.
 */
export function narrowTo(store: Store, s: KnowledgeScope, workspaceId: string): KnowledgeScope | undefined {
  if (!inTree(s, workspaceId)) return undefined;
  return viewOf(store, workspaceId, s.rootId, s.treeIds);
}

/** Result ordering (design §7.1): 0 own node, 1 descendant, 2 ancestor, 3 the rest of the tree. */
export function scopeRank(s: KnowledgeScope, itemWorkspaceId: string): 0 | 1 | 2 | 3 {
  if (itemWorkspaceId === s.workspaceId) return 0;
  if (s.ancestorIds.includes(itemWorkspaceId)) return 2;
  if (s.nodeIds.includes(itemWorkspaceId)) return 1;
  return 3;
}

/**
 * Replaces the scope labels of a fact or artifact (design §7.1): `home` at save (the insert
 * triggers write it), `agent` for `applies_to`, `user` for a later change. Every id must be a node
 * of the item's own tree; an unknown item or an out-of-tree node throws `KnowledgeNotFoundError`
 * and changes nothing. Callers log the judgment (a Decision / feedback event) themselves.
 */
export function setItemScopes(store: Store, kind: ScopedItemKind, id: string, workspaceIds: string[], source: ScopeSource): void {
  const ids = [...new Set(workspaceIds)];
  if (!ids.length) throw new Error('setItemScopes: at least one workspace id is required');
  const home = (kind === 'fact' ? store.findings.get(id) : store.artifacts.get(id))?.workspaceId;
  if (home === undefined) throw notFound(kind, id);
  const tree = scopeFor(store, home);
  for (const ws of ids) if (!inTree(tree, ws)) throw notFound('workspace', ws);
  const repo = knowledgeRepos(store).itemScopes;
  store.transaction(() => {
    repo.delete({ itemKind: kind, itemId: id });
    for (const ws of ids) repo.insert({ itemKind: kind, itemId: id, workspaceId: ws, source });
  });
}
