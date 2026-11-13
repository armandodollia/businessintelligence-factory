import type { Store } from '../store/db.js';

const short = (v: unknown, n = 140): string => {
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return s.length > n ? `${s.slice(0, n)}…` : s;
};

/** One-line summary of a recorded tool call (from its Decision payload). */
function summarize(p: Record<string, unknown>): string {
  switch (p.tool) {
    case 'log_decision':
      return `log_decision: ${short(p.what)}`;
    case 'save_finding':
      return `save_finding ${String(p.findingId)}${p.revision ? ' (revised)' : ''}`;
    case 'submit_result':
      return `submit_result: deliverable submitted ${short(p.result, 200)}`;
    case 'submit_review':
      return `submit_review: score ${String(p.score)}`;
    case 'respond_to_review':
      return `respond_to_review ${String(p.issueId)}: ${String(p.action)}`;
    case 'propose_tasks': {
      const r = p.result as { accepted?: unknown[]; rejected?: unknown[] } | undefined;
      return `propose_tasks: ${r?.accepted?.length ?? 0} accepted, ${r?.rejected?.length ?? 0} rejected`;
    }
    case 'propose_business_unit':
      return `propose_business_unit: ${short(p.name)}${p.revision ? ' (revised)' : ''}`;
    case 'get_identity':
      return `get_identity: ${short(p.site)} (${short(p.email)})`;
    case 'harness':
      return '';
    default:
      return `${String(p.tool)}: ${short(Object.fromEntries(Object.entries(p).filter(([k]) => k !== 'tool')))}`;
  }
}

/**
 * "Your previous attempt in this run already did:" section for a rate-limit retry: every tool call
 * recorded as a Decision by this run, plus its user requests, so the agent continues instead of
 * redoing (or paraphrasing) work. Empty string when the run recorded nothing.
 */
export function priorAttemptSection(store: Store, agentRunId: string): string {
  const lines: string[] = [];
  for (const d of store.decisions.list({ agentRunId })) {
    const p = d.payload as Record<string, unknown> | null;
    if (!p || typeof p !== 'object') continue;
    const line = summarize(p);
    if (line) lines.push(`- ${line}`);
  }
  for (const r of store.userRequests.list({ agentRunId })) {
    lines.push(`- request ${r.kind} on ${r.site ?? '?'}: ${r.status}${r.response ? ` (${short(r.response)})` : ''}`);
  }
  if (!lines.length) return '';
  return [
    '## Your previous attempt in this run already did:',
    ...lines,
    'It was interrupted by a rate limit. Do not repeat or paraphrase these calls; continue from where it stopped.',
  ].join('\n');
}
