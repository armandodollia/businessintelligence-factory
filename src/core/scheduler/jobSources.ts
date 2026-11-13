/**
 * The scheduler's built-in non-pipeline job sources (learning-loop wave 2 integration): ONE mechanism,
 * `ScheduledJobSource`, for every recurring job that is not a research pipeline.
 * - `reviewer-audit` (WP-F): the enabled audit schedules of every business tree;
 * - `retro` (WP-E): the weekly retro of every business tree on `lessons.retro.cron`.
 * `startScheduler` always includes them (plus any `SchedulerDeps.jobs`).
 */
import { retroJobSource } from '../learning/lessons/retro.js';
import { auditJobSource } from '../learning/reviewerAudit.js';
import type { ResearchDeps } from '../research/deps.js';
import type { ScheduledJobSource } from './scheduler.js';

export function builtInJobSources(deps: ResearchDeps): ScheduledJobSource[] {
  return [auditJobSource(deps), retroJobSource(deps)];
}
