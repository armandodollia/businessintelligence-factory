/**
 * The scheduled "what changed" text-diff outcome hook (learning loop WP-C), isolated in ONE function
 * so the knowledge store can replace it (design §13: fact lineage events call `recordOutcome` with
 * `stale` / `changed` instead). `recordWhatChanged` (src/core/scheduler/whatChanged.ts) calls it once
 * per diffed phase run; nothing else does.
 */
import { contradictedFindings } from '../scheduler/diff.js';
import type { Store } from '../store/db.js';
import type { ResearchRun } from '../types.js';
import { outputSaveDecision, recordOutcome } from './outcomes.js';
import type { DecisionOutcome } from './types.js';

/**
 * Outcomes of a scheduled "what changed" diff (`stale`, on each previous finding's save decision):
 * `contradicted` when the next run re-researched the subject but no longer found the claim (e.g.
 * "$10/mo" became "$12/mo"); `changed` when a screenshot the finding cites changed. Subjects the
 * next run did not cover at all record nothing. Idempotent.
 */
export function recordWhatChangedOutcomes(
  store: Store,
  input: {
    whatChangedDecisionId: string;
    prev: ResearchRun;
    next: ResearchRun;
    changedArtifacts: Array<{ prev: string; next: string }>;
  },
): DecisionOutcome[] {
  const out: DecisionOutcome[] = [];
  const contradicted = contradictedFindings(input.prev.id, input.next.id, { store });
  const base = { whatChangedDecisionId: input.whatChangedDecisionId, prevRunId: input.prev.id, nextRunId: input.next.id };
  const write = (findingId: string, outcome: string, evidence: Record<string, unknown>) => {
    const save = outputSaveDecision(store, 'finding', findingId);
    if (!save) return;
    const taskId = store.findings.get(findingId)?.taskId;
    const o = recordOutcome(store, {
      decisionId: save.id, outcome, label: 'stale', source: 'what_changed', evidence: { ...base, ...evidence },
      targetType: 'finding', targetId: findingId, ...(taskId && store.tasks.get(taskId) ? { taskId } : {}),
    });
    if (o) out.push(o);
  };
  for (const id of contradicted) write(id, 'contradicted', {});
  const changed = new Map(input.changedArtifacts.map((c) => [c.prev, c.next]));
  if (changed.size) {
    for (const f of store.findings.list({ runId: input.prev.id })) {
      if (f.workspaceId !== input.prev.workspaceId || f.status === 'superseded') continue;
      const hits = f.evidence.filter((a) => changed.has(a));
      if (hits.length) write(f.id, 'changed', { changedArtifacts: hits.map((a) => ({ prev: a, next: changed.get(a) })) });
    }
  }
  return out;
}
