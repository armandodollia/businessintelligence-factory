import type { BifConfig } from '../config/schema.js';
import { browserPromptNote } from '../harness/browser.js';
import { policyPrompt } from '../policy/actionPolicy.js';
import { loadPrompt } from '../prompts/index.js';
import type { Role } from '../types.js';

/**
 * System prompt of worker / synthesizer runs: `worker.md` + the action policy rendered from config
 * (always) + the browser note (browser-using tasks only).
 */
export function workerSystemPrompt(config: BifConfig, _role: Role = 'worker', needsBrowser = false): string {
  const parts = [loadPrompt('worker').text.trimEnd(), policyPrompt(config)];
  if (needsBrowser) parts.push(browserPromptNote(config));
  return parts.join('\n\n');
}

/** System prompt of reviewer runs: `reviewer.md` + the action policy (walkthroughs are checked against it). */
export function reviewerSystemPrompt(config: BifConfig): string {
  return [loadPrompt('reviewer').text.trimEnd(), policyPrompt(config)].join('\n\n');
}
