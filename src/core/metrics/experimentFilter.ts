/**
 * Experiment / audit run filter for the metrics view (learning loop WP-G, wired to WP-F at the wave-2
 * integration). WP-F tags experiment arm runs (`agent_runs.experiment_id` / `arm`) and reviewer-audit
 * runs (`agent_runs.audit_id`); metrics leave those runs (and everything attributed to them: tasks
 * they started, ratings and outcomes of what they produced, usage) out by default so an A/B arm or an
 * audit does not skew the production trend. `includeExperiments` brings both back.
 *
 * This is the only place the metrics view decides what an experiment run is; it reads WP-F's own
 * predicate (`taggedRunIds` / `isTaggedRun`, i.e. NOT `NORMAL_RUN_SQL`).
 */
import { isTaggedRun, taggedRunIds } from '../learning/runTags.js';
import type { Store } from '../store/db.js';
import type { AgentRun } from '../types.js';

/** True when the run is an experiment arm run or a reviewer-audit run (WP-F tags). */
export function isExperimentRun(store: Pick<Store, 'db'>, run: Pick<AgentRun, 'id'>): boolean {
  return isTaggedRun(store, run.id);
}

/** The same predicate for many runs (one query). */
export function experimentRunFilter(store: Pick<Store, 'db'>): (run: Pick<AgentRun, 'id'>) => boolean {
  const tagged = taggedRunIds(store);
  return (run) => tagged.has(run.id);
}
