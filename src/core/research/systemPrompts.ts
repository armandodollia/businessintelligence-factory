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
/** Flow records (design 2026-11-14 §8, §9): the prompt of each flow task type. */
const FLOW_TASK_PROMPTS: Partial<Record<TaskType, string>> = { flow_walkthrough: 'flow_walkthrough', flow_reviews: 'flow_reviews' };
/** Stakeholder personas (design 2026-11-15 §6): the prompt of each stakeholder task type. */
const STAKEHOLDER_TASK_PROMPTS: Partial<Record<TaskType, string>> = {
  own_stakeholders: 'own_stakeholders',
  competitor_stakeholders: 'competitor_stakeholders',
};
/** One-line notes for task types without a prompt of their own (stakeholder design §6: pages the stakeholder tasks read). */
const TASK_TYPE_NOTES: Partial<Record<TaskType, string>> = {
  own_company_audit:
    'For this task: capture the public leadership, ownership and investor pages of the own company when they exist, as artifacts. ' +
    'Stakeholders are built from them in the stakeholders phase, not here.',
  public_filings:
    'For this task: capture the public leadership, ownership and investor pages of the company when they exist, as artifacts. ' +
    'Stakeholders are built from them in the stakeholders phase, not here.',
};

/**
 * Notes for the reviewer (and the reviewer audit, which reuses its input) of a task type. Own-stakeholder
 * research may use the web (user ruling 2026-11-15), so its reviewer may too, under the worker's rule.
 */
const REVIEWER_TASK_NOTES: Partial<Record<TaskType, string>> = {
  own_stakeholders:
    'For this task (own_stakeholders): never put text, names, figures or other details from internal uploads or the interview ' +
    "into a search query, a web form or any web request. Check public claims by the company's public name only.",
};

/**
 * System prompt of worker / synthesizer runs: `worker.md` + `synthesizer.md` (synthesizer role:
 * recommendation criteria and accepted cost formats) + `persona_profile.md` (persona task
 * types only) + `competitors.md` (competitor discovery / flow walkthroughs) + `hypotheses.md`
 * (symptom hypotheses) + `flow_walkthrough.md` / `flow_reviews.md` and `own_stakeholders.md` /
 * `competitor_stakeholders.md` (those task types) + a one-line note (company audit, public filings) + the action
 * policy rendered from config (always) + the browser note (browser-using tasks only) + the business
 * tree's approved calibration appendix for the role
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
  const flowPrompt = taskType && FLOW_TASK_PROMPTS[taskType];
  if (flowPrompt) parts.push(promptTemplate(flowPrompt).trimEnd());
  const stakeholderPrompt = taskType && STAKEHOLDER_TASK_PROMPTS[taskType];
  if (stakeholderPrompt) parts.push(promptTemplate(stakeholderPrompt).trimEnd());
  const note = taskType && TASK_TYPE_NOTES[taskType];
  if (note) parts.push(note);
  parts.push(policyPrompt(config));
  if (needsBrowser) parts.push(browserPromptNote(config));
  return withCalibration(parts.join('\n\n'), role, scope);
}

/** System prompt of reviewer runs: `reviewer.md` (+ the business's reviewer calibration) + the note for `taskType`, if any + the action policy. */
export function reviewerSystemPrompt(config: BifConfig, scope?: CalibrationScope, taskType?: TaskType): string {
  const note = taskType && REVIEWER_TASK_NOTES[taskType];
  return [loadPrompt('reviewer', scope).text.trimEnd(), ...(note ? [note] : []), policyPrompt(config)].join('\n\n');
}
