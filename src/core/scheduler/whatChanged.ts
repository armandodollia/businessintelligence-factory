import type { BifConfig } from '../config/schema.js';
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
 * pipeline was resumed after a restart. Phases that already have a what_changed Decision get no
 * second one; their outcomes are recorded again, which writes only what is missing (each outcome is
 * keyed, so a stop between the Decision and its outcomes is repaired and a replay adds nothing).
 * `config` (the scheduled run's) lets the outcomes record the lazy `stale` lineage outcome.
 */
export function recordWhatChanged(
  deps: { store: Store; events?: EventBus; config?: Pick<BifConfig, 'knowledge'>; now?: Date },
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
      .find((d) => {
        const p = d.payload as { event?: string; nextRunId?: string } | null;
        return p?.event === 'what_changed' && p.nextRunId === rr.id;
      });
    const diff = diffRuns(prev.id, rr.id, deps);
    let decision = already;
    if (!decision) {
      decision = recordSystemDecision(deps, {
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
        // KS-5: replaced (new versions) and retracted facts are referenced too; flow records: new flows and versions.
        refs: [...new Set([
          rr.id, prev.id, ...diff.newFindings, ...diff.changedArtifacts.map((c) => c.next), ...diff.replaced.map((r) => r.to), ...diff.retracted,
          ...diff.flows.newFlows, ...diff.flows.newVersions.map((v) => v.to),
        ])],
      });
      out.push(decision);
    }
    // Outcomes (design §13, KS-6): lineage outcomes of the run, the text fallback (`contradictedFindings`,
    // the diff's), changed cited screenshots and, with the run's config, `stale`. Idempotent.
    recordWhatChangedOutcomes(store, {
      whatChangedDecisionId: decision.id, prev, next: rr, changedArtifacts: diff.changedArtifacts,
      ...(deps.config ? { config: deps.config } : {}),
      ...(deps.now ? { now: deps.now } : {}),
    });
  }
  return out;
}
