import type { ResearchRun } from './types.js';

/** What "Stop research" does, shown before the person confirms. */
export const STOP_RESEARCH_NOTE = 'Running agents are stopped. You can start again later; finished work is kept.';

/** The answer of `POST /api/workspaces/:id/research/stop`. */
export type StopResearchReport = {
  /** False when nothing was running. */
  stopped: boolean;
  researchRuns: string[];
  pipelines: string[];
  requeuedTasks: string[];
  /** Requests to the person that were closed with the stop: their tasks no longer wait for an answer. */
  closedRequests: string[];
};

/** True while a research run of the business is running: "Stop research" is offered. */
export function researchRunning(runs: Pick<ResearchRun, 'status'>[]): boolean {
  return runs.some((r) => r.status === 'running');
}
