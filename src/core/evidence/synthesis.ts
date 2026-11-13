import type { Store } from '../store/db.js';
import type { Finding } from '../types.js';
import { descendants, rootOf, sameTree } from '../workspace/tree.js';

/**
 * Whether a finding may feed recommendation synthesis (spec §7.2): verified findings only, unless
 * the user overrode it (`includeInSynthesis` true includes an unverified finding, false excludes a
 * verified one). Superseded findings (replaced in a later review round) are never used.
 */
export function isSynthesisEligible(f: Pick<Finding, 'status' | 'includeInSynthesis'>): boolean {
  if (f.status === 'superseded') return false;
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

/**
 * Prompt section listing the findings usable for synthesis — from every node of the business tree,
 * tagged by source node when not the workspace itself — and how many were left out.
 */
export function synthesisFindingsSection(store: Store, workspaceId: string): string {
  const all = treeWorkspaceIds(store, workspaceId).flatMap((id) => store.findings.list({ workspaceId: id }));
  const usable = all.filter(isSynthesisEligible);
  const lines = usable.map(
    (f) =>
      `- [${f.id}] ${f.subject}: ${f.claim.length > 200 ? `${f.claim.slice(0, 200)}…` : f.claim}` +
      `${f.workspaceId !== workspaceId ? ` (source ${f.workspaceId})` : ''}`,
  );
  return [
    '## Findings usable for synthesis (verified, or included by the user; any node of this business tree)',
    lines.join('\n') || '- (none)',
    `${all.length - usable.length} other finding(s) are unverified, pending, superseded or excluded by the user and must NOT be used ` +
      'or cited in recommendations (save_recommendation rejects them).',
  ].join('\n');
}
