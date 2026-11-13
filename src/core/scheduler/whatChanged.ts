import type { EventBus } from '../events.js';
import type { Store } from '../store/db.js';
import { recordSystemDecision } from '../systemDecision.js';
import type { Decision, ResearchRun } from '../types.js';
import { diffRuns } from './diff.js';
import { recordWhatChangedOutcomes } from '../learning/whatChangedOutcomes.js';

/**
 * The latest finished (`done`) run of the same schedule + phase that started before `rr`. Manual
 * runs and other schedules' runs are never the baseline, so "what changed" compares like with like.
 */
export function previousRun(deps: { store: Store }, rr: ResearchRun): ResearchRun | undefined {
  if (!rr.scheduleId) return undefined;
  return deps.store.researchRuns
    .list({ workspaceId: rr.workspaceId, phase: rr.phase, status: 'done', scheduleId: rr.scheduleId })
    .filter((r) => r.id !== rr.id && r.startedAt <= rr.startedAt)
    .sort((a, b) => a.startedAt.localeCompare(b.startedAt))
    .at(-1);
}

/**
 * The scheduler's "what changed" step: one Decision per finished phase run of a scheduled pipeline
 * that has a predecessor (same schedule + phase). Runs after a pipeline finishes, also when the
 * pipeline was resumed after a restart. Phases that already have a what_changed Decision are skipped.
 */
export function recordWhatChanged(
  deps: { store: Store; events?: EventBus },
  scheduleId: string,
  runs: ResearchRun[],
): Decision[] {
  const { store } = deps;
  const schedule = store.schedules.get(scheduleId);
  const out: Decision[] = [];
  for (const rr of runs) {
    if (rr.status !== 'done') continue;
    const prev = previousRun(deps, rr);
    if (!prev) continue;
    const already = store.decisions
      .list({ workspaceId: rr.workspaceId, agentRunId: 'scheduler' })
      .some((d) => {
        const p = d.payload as { event?: string; nextRunId?: string } | null;
        return p?.event === 'what_changed' && p.nextRunId === rr.id;
      });
    if (already) continue;
    const diff = diffRuns(prev.id, rr.id, deps);
    out.push(
      recordSystemDecision(deps, {
        workspaceId: rr.workspaceId,
        actor: 'scheduler',
        payload: {
          tool: 'scheduler',
          event: 'what_changed',
          scheduleId,
          scheduleName: schedule?.name ?? scheduleId,
          phase: rr.phase,
          prevRunId: prev.id,
          nextRunId: rr.id,
          ...diff,
        },
        refs: [rr.id, prev.id, ...diff.newFindings, ...diff.changedArtifacts.map((c) => c.next)],
      }),
    );
    // learning loop WP-C: findings the diff contradicts or changes get a `stale` outcome (one hook).
    recordWhatChangedOutcomes(store, { whatChangedDecisionId: out.at(-1)!.id, prev, next: rr, changedArtifacts: diff.changedArtifacts });
  }
  return out;
}
