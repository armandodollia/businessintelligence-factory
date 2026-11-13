import type { BifConfig } from '../config/schema.js';
import { browserPromptNote } from '../harness/browser.js';
import { policyPrompt } from '../policy/actionPolicy.js';
import { loadPrompt, promptTemplate, withCalibration, type CalibrationScope } from '../prompts/index.js';
import type { Role, TaskType } from '../types.js';

/** Task types whose workers also get `persona_profile.md` (they build / save personas). */
const PERSONA_TASK_TYPES: ReadonlySet<TaskType> = new Set(['persona_profile', 'audience_segments']);
/** Task types whose workers also get `competitors.md` (they save rated competitors, spec §9). */
const COMPETITOR_TASK_TYPES: ReadonlySet<TaskType> = new Set(['discover_competitors', 'flow_walkthrough']);
/** Task types whose workers also get `hypotheses.md` (they save symptom hypotheses, spec §8). */
const HYPOTHESIS_TASK_TYPES: ReadonlySet<TaskType> = new Set(['symptom_hypotheses']);

/**
 * System prompt of worker / synthesizer runs: `worker.md` + `synthesizer.md` (synthesizer role:
 * recommendation criteria and accepted cost formats) + `persona_profile.md` (persona task
 * types only) + `competitors.md` (competitor discovery / flow walkthroughs) + `hypotheses.md`
 * (symptom hypotheses) + the action policy rendered from config (always) + the browser note
 * (browser-using tasks only) + the business tree's approved calibration appendix for the role
 * (`<dataDir>/<root>/calibration/<role>.md`, when `scope` is given), so applying a calibration
 * patch changes the prompt version of that business's worker and synthesizer runs alike.
 */
export function workerSystemPrompt(
  config: BifConfig,
  role: Role = 'worker',
  needsBrowser = false,
  taskType?: TaskType,
  scope?: CalibrationScope,
): string {
  const parts = [promptTemplate('worker').trimEnd()];
  if (role === 'synthesizer') parts.push(promptTemplate('synthesizer').trimEnd());
  if (taskType && PERSONA_TASK_TYPES.has(taskType)) parts.push(promptTemplate('persona_profile').trimEnd());
  if (taskType && COMPETITOR_TASK_TYPES.has(taskType)) parts.push(promptTemplate('competitors').trimEnd());
  if (taskType && HYPOTHESIS_TASK_TYPES.has(taskType)) parts.push(promptTemplate('hypotheses').trimEnd());
  parts.push(policyPrompt(config));
  if (needsBrowser) parts.push(browserPromptNote(config));
  return withCalibration(parts.join('\n\n'), role, scope);
}

/** System prompt of reviewer runs: `reviewer.md` (+ the business's reviewer calibration) + the action policy. */
export function reviewerSystemPrompt(config: BifConfig, scope?: CalibrationScope): string {
  return [loadPrompt('reviewer', scope).text.trimEnd(), policyPrompt(config)].join('\n\n');
}
