import type { BifConfig } from '../config/schema.js';
import { browserPromptNote } from '../harness/browser.js';
import { policyPrompt } from '../policy/actionPolicy.js';
import { loadPrompt, promptTemplate, withCalibration } from '../prompts/index.js';
import type { Role, TaskType } from '../types.js';

/** Task types whose workers also get `persona_profile.md` (they build / save personas). */
const PERSONA_TASK_TYPES: ReadonlySet<TaskType> = new Set(['persona_profile', 'audience_segments']);

/**
 * System prompt of worker / synthesizer runs: `worker.md` + `persona_profile.md` (persona task
 * types only) + the action policy rendered from config (always) + the browser note (browser-using
 * tasks only) + the role's approved calibration appendix (`calibration/<role>.md`), so applying a
 * calibration patch changes the prompt version of worker and synthesizer runs alike.
 */
export function workerSystemPrompt(config: BifConfig, role: Role = 'worker', needsBrowser = false, taskType?: TaskType): string {
  const parts = [promptTemplate('worker').trimEnd()];
  if (taskType && PERSONA_TASK_TYPES.has(taskType)) parts.push(promptTemplate('persona_profile').trimEnd());
  parts.push(policyPrompt(config));
  if (needsBrowser) parts.push(browserPromptNote(config));
  return withCalibration(parts.join('\n\n'), role);
}

/** System prompt of reviewer runs: `reviewer.md` + the action policy (walkthroughs are checked against it). */
export function reviewerSystemPrompt(config: BifConfig): string {
  return [loadPrompt('reviewer').text.trimEnd(), policyPrompt(config)].join('\n\n');
}
