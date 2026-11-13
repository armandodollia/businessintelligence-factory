import { CronExpressionParser } from 'cron-parser';
import type { ResearchDeps } from '../research/deps.js';
import { currentResearchRun, runPipeline } from '../research/orchestrator.js';
import { recordSystemDecision } from '../systemDecision.js';
import type { ResearchRun, Schedule } from '../types.js';
import { isPipelineLocked } from '../research/lock.js';
import { diffRuns } from './diff.js';

/** How often schedules are checked (spec: every 60 s). */
export const SCHEDULER_INTERVAL_MS = 60_000;

export type SchedulerDeps = ResearchDeps & {
  /** Check interval; default 60 s. */
  intervalMs?: number;
};

export type SchedulerHandle = {
  stop(): void;
  /** Checks schedules now (also runs on start and every interval). */
  tick(): Promise<void>;
  /** Settles when every job started so far has finished. */
  idle(): Promise<void>;
};

/** Next cron occurrence strictly after `after` (server local time). Throws on an invalid expression. */
export function nextDue(cron: string, after: Date): Date {
  return CronExpressionParser.parse(cron, { currentDate: after }).next().toDate();
}

/** Throws a readable error when `cron` is not a valid 5/6-field cron expression. */
export function validateCron(cron: string): void {
  try {
    nextDue(cron, new Date());
  } catch (e) {
    throw new Error(`invalid cron expression '${cron}': ${(e as Error).message}`);
  }
}

/**
 * Time after which the next occurrence is due: the later of `lastRunAt` and `activatedAt`
 * (creation / last re-enable), so occurrences before a schedule existed or was re-enabled never
 * run. Schedules with neither (legacy rows) are measured from the scheduler start.
 */
export function scheduleBaseline(s: Pick<Schedule, 'lastRunAt' | 'activatedAt'>, startedAt: number): number {
  const times = [s.lastRunAt, s.activatedAt].filter((x): x is string => !!x).map(Date.parse).filter((n) => !Number.isNaN(n));
  return times.length ? Math.max(...times) : startedAt;
}

/**
 * The latest finished (`done`) run of the same schedule + phase that started before `rr`. Manual
 * runs and other schedules' runs are never the baseline, so "what changed" compares like with like.
 */
export function previousRun(deps: Pick<ResearchDeps, 'store'>, rr: ResearchRun): ResearchRun | undefined {
  if (!rr.scheduleId) return undefined;
  return deps.store.researchRuns
    .list({ workspaceId: rr.workspaceId, phase: rr.phase, status: 'done', scheduleId: rr.scheduleId })
    .filter((r) => r.id !== rr.id && r.startedAt <= rr.startedAt)
    .sort((a, b) => a.startedAt.localeCompare(b.startedAt))
    .at(-1);
}

/** Runs one schedule's pipeline and records a "what changed" Decision per phase that has a predecessor. */
async function runSchedule(schedule: Schedule, deps: ResearchDeps): Promise<void> {
  const runs = await runPipeline(schedule.workspaceId, schedule.phases, deps, { scheduleId: schedule.id });
  for (const rr of runs) {
    if (rr.status !== 'done') continue;
    const prev = previousRun(deps, rr);
    if (!prev) continue;
    const diff = diffRuns(prev.id, rr.id, deps);
    recordSystemDecision(deps, {
      workspaceId: rr.workspaceId,
      actor: 'scheduler',
      payload: {
        tool: 'scheduler',
        event: 'what_changed',
        scheduleId: schedule.id,
        scheduleName: schedule.name,
        phase: rr.phase,
        prevRunId: prev.id,
        nextRunId: rr.id,
        ...diff,
      },
      refs: [rr.id, prev.id, ...diff.newFindings, ...diff.changedArtifacts.map((c) => c.next)],
    });
  }
}

/**
 * Starts the recurring-job loop. Every `intervalMs` (60 s) and once immediately, each enabled
 * schedule whose next cron occurrence after `lastRunAt` is due runs `runPipeline(workspaceId,
 * schedule.phases)`. Missed occurrences (server was down) run once, not once per occurrence.
 * Occurrences are counted from `scheduleBaseline` (later of last run and creation/re-enable), so a
 * new or re-enabled schedule first runs at its next occurrence. A workspace with a running research run (or an in-flight scheduled job) is skipped
 * until a later tick. `lastRunAt` is set when the job starts.
 */
export function startScheduler(deps: SchedulerDeps, now: () => number = Date.now): SchedulerHandle {
  const startedAt = now();
  const busy = new Set<string>();
  const jobs = new Set<Promise<void>>();
  let stopped = false;
  let ticking: Promise<void> = Promise.resolve();

  const check = async (): Promise<void> => {
    if (stopped) return;
    const t = now();
    // Oldest-due first: a schedule that stayed due because its workspace was busy runs before one
    // that became due later, so schedules sharing a workspace cannot starve each other.
    const due: Array<{ s: Schedule; at: number }> = [];
    for (const s of deps.store.schedules.list({ enabled: true })) {
      try {
        const at = nextDue(s.cron, new Date(scheduleBaseline(s, startedAt))).getTime();
        if (at <= t) due.push({ s, at });
      } catch (e) {
        console.warn(`[bif] schedule ${s.id}: ${(e as Error).message}`);
      }
    }
    due.sort((a, b) => a.at - b.at || (a.s.lastRunAt ?? '').localeCompare(b.s.lastRunAt ?? '') || a.s.id.localeCompare(b.s.id));
    for (const { s } of due) {
      if (busy.has(s.workspaceId)) continue;
      if (!deps.store.workspaces.get(s.workspaceId)) continue;
      if (currentResearchRun(deps.store, s.workspaceId)) continue;
      // Held by a manual run (API) or resumed run: keep the schedule due and try on a later tick.
      if (isPipelineLocked(deps.store, s.workspaceId)) continue;
      busy.add(s.workspaceId);
      deps.store.schedules.update(s.id, { lastRunAt: new Date(t).toISOString() });
      const job = runSchedule(s, deps)
        .catch((e) => console.error(`[bif] scheduled job ${s.id} (${s.name}) failed: ${(e as Error).message}`))
        .finally(() => {
          busy.delete(s.workspaceId);
          jobs.delete(job);
        });
      jobs.add(job);
    }
  };

  const tick = () => {
    ticking = ticking.then(check, check);
    return ticking;
  };

  const timer = setInterval(() => void tick(), deps.intervalMs ?? SCHEDULER_INTERVAL_MS);
  timer.unref?.();
  void tick();

  return {
    stop() {
      stopped = true;
      clearInterval(timer);
    },
    tick,
    async idle() {
      await ticking;
      while (jobs.size) await Promise.allSettled([...jobs]);
    },
  };
}
