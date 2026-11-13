import type { Store } from '../store/db.js';
import type { Finding, Role } from '../types.js';
import { defaultConfig, type BifConfig, type ProviderId } from '../config/schema.js'; // KS-5
import { synthesisBriefing } from '../knowledge/briefing.js'; // KS-5
import { descendants, rootOf, sameTree } from '../workspace/tree.js';

/**
 * Whether a finding may feed recommendation synthesis (spec §7.2): verified findings only, unless
 * the user overrode it (`includeInSynthesis` true includes an unverified finding, false excludes a
 * verified one). Superseded findings (replaced in a later review round) are never used, nor are
 * facts whose lifecycle is not `current` (an unverified update, a replaced or retracted version).
 */
export function isSynthesisEligible(f: Pick<Finding, 'status' | 'includeInSynthesis'> & Partial<Pick<Finding, 'lifecycle'>>): boolean {
  if (f.status === 'superseded') return false;
  // Knowledge store KS-2: only the current version of a fact (not candidate / replaced / retracted).
  if ((f.lifecycle ?? 'current') !== 'current') return false;
  return f.includeInSynthesis ?? f.status === 'verified';
}

/** Workspace ids of the business tree containing `workspaceId` (the workspace itself first). */
export function treeWorkspaceIds(store: Store, workspaceId: string): string[] {
  if (!store.workspaces.get(workspaceId)) return [workspaceId];
  const root = rootOf(store, workspaceId);
  const ids = [root, ...descendants(store, root).map((w) => w.id)];
  return [workspaceId, ...ids.filter((id) => id !== workspaceId)];
}

/**
 * Findings usable for synthesis in a workspace: eligible findings of every node of its business tree
 * (spec §8c: any node may cite same-tree findings), own workspace first.
 */
export function synthesisFindings(store: Store, workspaceId: string): Finding[] {
  return treeWorkspaceIds(store, workspaceId).flatMap((id) => store.findings.list({ workspaceId: id }).filter(isSynthesisEligible));
}

/** Ids among `ids` that are findings of the workspace's business tree but not eligible for synthesis. */
export function ineligibleFindingIds(store: Store, workspaceId: string, ids: string[]): string[] {
  return ids.filter((id) => {
    const f = store.findings.get(id);
    return f !== undefined && sameTree(store, workspaceId, f.workspaceId) && !isSynthesisEligible(f);
  });
}

/** User override (API): include or exclude a finding from synthesis. Throws if unknown. */
export function setIncludeInSynthesis(store: Store, findingId: string, include: boolean | null): Finding {
  if (!store.findings.get(findingId)) throw new Error(`finding '${findingId}' not found`);
  // null resets to the default (verified findings only); `undefined` clears the column.
  return store.findings.update(findingId, { includeInSynthesis: include ?? undefined });
}

// --- knowledge store KS-5: the synthesis briefing replaces the "every usable finding of the tree" list ---
/**
 * Prompt section of the facts usable for synthesis (KS-5 `synthesisBriefing`): current, usable facts
 * of this node, its sub-units and parents, grouped by entity, ranked, redacted then cut, fenced and fitted
 * to the role's briefing budget, with counts of what is not shown and the tree-wide search instruction
 * for causes. Sibling nodes' facts are counted, not listed (`search` with `scope: "tree"`; they may still
 * be cited). Callers that put it into a run's prompt use `synthesisBriefing` directly for its `read`.
 */
export function synthesisFindingsSection(
  store: Store,
  workspaceId: string,
  opts: { config?: Pick<BifConfig, 'knowledge'>; role?: Role; provider?: ProviderId } = {},
): string {
  return synthesisBriefing({ store, config: opts.config ?? defaultConfig }, { workspaceId, role: opts.role ?? 'synthesizer', ...(opts.provider ? { provider: opts.provider } : {}) }).section;
}
// --- end KS-5 ---
