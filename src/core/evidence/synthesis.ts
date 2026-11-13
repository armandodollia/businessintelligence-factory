import type { Store } from '../store/db.js';
import type { Finding } from '../types.js';

/**
 * Whether a finding may feed recommendation synthesis (spec §7.2): verified findings only, unless
 * the user overrode it (`includeInSynthesis` true includes an unverified finding, false excludes a
 * verified one).
 */
export function isSynthesisEligible(f: Pick<Finding, 'status' | 'includeInSynthesis'>): boolean {
  return f.includeInSynthesis ?? f.status === 'verified';
}

/** The workspace's findings usable for synthesis. */
export function synthesisFindings(store: Store, workspaceId: string): Finding[] {
  return store.findings.list({ workspaceId }).filter(isSynthesisEligible);
}

/** Ids among `ids` that are findings of the workspace but not eligible for synthesis. */
export function ineligibleFindingIds(store: Store, workspaceId: string, ids: string[]): string[] {
  return ids.filter((id) => {
    const f = store.findings.get(id);
    return f !== undefined && f.workspaceId === workspaceId && !isSynthesisEligible(f);
  });
}

/** User override (API): include or exclude a finding from synthesis. Throws if unknown. */
export function setIncludeInSynthesis(store: Store, findingId: string, include: boolean | null): Finding {
  if (!store.findings.get(findingId)) throw new Error(`finding '${findingId}' not found`);
  // null resets to the default (verified findings only); `undefined` clears the column.
  return store.findings.update(findingId, { includeInSynthesis: include ?? undefined });
}

/** Prompt section listing the findings usable for synthesis (and how many were left out). */
export function synthesisFindingsSection(store: Store, workspaceId: string): string {
  const all = store.findings.list({ workspaceId });
  const usable = all.filter(isSynthesisEligible);
  const lines = usable.map((f) => `- [${f.id}] ${f.subject}: ${f.claim.length > 200 ? `${f.claim.slice(0, 200)}…` : f.claim}`);
  return [
    '## Findings usable for synthesis (verified, or included by the user)',
    lines.join('\n') || '- (none)',
    `${all.length - usable.length} other finding(s) are unverified, pending or excluded by the user and must NOT be used ` +
      'or cited in recommendations (save_recommendation rejects them).',
  ].join('\n');
}
