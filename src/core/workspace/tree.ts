import type { Store } from '../store/db.js';
import { newId } from '../store/repos.js';
import type { Audience, ScopeLevel, Workspace, WorkspaceScope } from '../types.js';

const LEVELS: readonly ScopeLevel[] = ['company', 'division', 'slice'];

/** Scope of a workspace with defaults (level `company`, name = workspace name). */
export function scopeOf(ws: Workspace): WorkspaceScope {
  const s = (ws.scope ?? {}) as Partial<WorkspaceScope>;
  return {
    level: LEVELS.includes(s.level as ScopeLevel) ? (s.level as ScopeLevel) : 'company',
    name: typeof s.name === 'string' && s.name ? s.name : ws.name,
    description: typeof s.description === 'string' ? s.description : '',
  };
}

/** Audiences of a workspace; default `['external']`. */
export function audiencesOf(ws: Workspace): Audience[] {
  const a = (ws.audiences ?? []).filter((x): x is Audience => x === 'external' || x === 'internal');
  return a.length ? [...new Set(a)] : ['external'];
}

export type CreateWorkspaceInput = {
  name: string;
  sector: string;
  scope?: Partial<WorkspaceScope>;
  audiences?: Audience[];
  parentWorkspaceId?: string;
};

/** Creates a workspace with scope/audience defaults; the parent (if any) must exist. */
export function createWorkspace(store: Store, input: CreateWorkspaceInput): Workspace {
  if (input.parentWorkspaceId !== undefined && !store.workspaces.get(input.parentWorkspaceId)) {
    throw new Error(`parent workspace '${input.parentWorkspaceId}' not found`);
  }
  const ws: Workspace = {
    id: newId('ws'),
    name: input.name,
    sector: input.sector,
    createdAt: new Date().toISOString(),
    scope: {
      level: input.scope?.level ?? (input.parentWorkspaceId ? 'division' : 'company'),
      name: input.scope?.name || input.name,
      description: input.scope?.description ?? '',
    },
    audiences: input.audiences?.length ? [...new Set(input.audiences)] : ['external'],
  };
  if (input.parentWorkspaceId !== undefined) ws.parentWorkspaceId = input.parentWorkspaceId;
  return store.workspaces.insert(ws);
}

/** Ancestors of a workspace, nearest first. Cycle-safe; stops at a missing parent. */
export function ancestors(store: Store, wsId: string): Workspace[] {
  const out: Workspace[] = [];
  const seen = new Set([wsId]);
  let parentId = store.workspaces.get(wsId)?.parentWorkspaceId;
  while (parentId && !seen.has(parentId)) {
    seen.add(parentId);
    const parent = store.workspaces.get(parentId);
    if (!parent) break;
    out.push(parent);
    parentId = parent.parentWorkspaceId;
  }
  return out;
}

/** Direct children of a workspace. */
export function children(store: Store, wsId: string): Workspace[] {
  return store.workspaces.list({ parentWorkspaceId: wsId }).filter((w) => w.id !== wsId);
}

/** All descendants (breadth-first). Cycle-safe. */
export function descendants(store: Store, wsId: string): Workspace[] {
  const out: Workspace[] = [];
  const seen = new Set([wsId]);
  const queue = [wsId];
  while (queue.length) {
    for (const c of children(store, queue.shift()!)) {
      if (seen.has(c.id)) continue;
      seen.add(c.id);
      out.push(c);
      queue.push(c.id);
    }
  }
  return out;
}

/** Other children of the same parent. */
export function siblings(store: Store, wsId: string): Workspace[] {
  const parentId = store.workspaces.get(wsId)?.parentWorkspaceId;
  return parentId ? children(store, parentId).filter((w) => w.id !== wsId) : [];
}

/** Root workspace id of the tree (the workspace itself when it has no parent). */
export function rootOf(store: Store, wsId: string): string {
  return ancestors(store, wsId).at(-1)?.id ?? wsId;
}

/**
 * True when both workspaces belong to the same business tree (same root). A workspace is in its own
 * tree even without a row; unknown workspaces share no tree with anything else.
 */
export function sameTree(store: Store, a: string, b: string): boolean {
  if (a === b) return true;
  if (!store.workspaces.get(a) || !store.workspaces.get(b)) return false;
  return rootOf(store, a) === rootOf(store, b);
}

export type TreeNode = { workspace: Workspace; children: TreeNode[] };

/** The tree under `wsId` (cycle-safe), for the business map. */
export function workspaceTree(store: Store, wsId: string): TreeNode | undefined {
  const root = store.workspaces.get(wsId);
  if (!root) return undefined;
  const seen = new Set<string>();
  const build = (ws: Workspace): TreeNode => {
    seen.add(ws.id);
    return { workspace: ws, children: children(store, ws.id).filter((c) => !seen.has(c.id)).map(build) };
  };
  return build(root);
}
