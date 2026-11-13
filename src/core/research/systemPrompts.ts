import type { BifConfig } from '../config/schema.js';
import { loadPrompt } from '../prompts/index.js';
import type { Role } from '../types.js';

/** System prompt of worker / synthesizer runs. */
export function workerSystemPrompt(_config: BifConfig, _role: Role = 'worker'): string {
  return loadPrompt('worker').text;
}

/** System prompt of reviewer runs. */
export function reviewerSystemPrompt(_config: BifConfig): string {
  return loadPrompt('reviewer').text;
}
