/**
 * Experiment-run filter for the metrics view (learning loop WP-G). WP-F tags the runs of an
 * experiment with `experiment_id` / `arm`; metrics leave those runs (and everything attributed to
 * them: tasks they started, ratings and outcomes of what they produced, usage) out by default so an
 * A/B arm does not skew the production trend.
 *
 * INTEGRATION SEAM (WP-F): this is the only place that decides what an experiment run is. It reads
 * `experimentId` off the run object, so once WP-F maps `agent_runs.experiment_id` to
 * `AgentRun.experimentId` in the repo spec it works with no change here. If WP-F names the field
 * differently (or tags decisions only), change this function alone.
 */
import type { AgentRun } from '../types.js';

/** True when the run belongs to an experiment arm (WP-F tag present and non-empty). */
export function isExperimentRun(run: AgentRun): boolean {
  const id = (run as AgentRun & { experimentId?: unknown }).experimentId;
  return typeof id === 'string' && id !== '';
}
