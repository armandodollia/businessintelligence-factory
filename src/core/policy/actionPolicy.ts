import type { BifConfig } from '../config/schema.js';
import { loadPrompt, renderTemplate } from '../prompts/index.js';

export type ActionPolicy = BifConfig['actionPolicy'];

const list = (items: string[]) => (items.length ? items.map((s) => `- ${s}`).join('\n') : '- (none)');

/**
 * The action policy (spec §6.6) rendered from config for agent system prompts. Every configured
 * action appears verbatim as a bullet. Appended to every worker system prompt (and the reviewer's,
 * which checks walkthroughs against it).
 */
export function policyPrompt(config: Pick<BifConfig, 'actionPolicy'>): string {
  const p = config.actionPolicy;
  return renderTemplate(loadPrompt('policy').text.trimEnd(), {
    allowed: list(p.allowed),
    approvalRequired: list(p.approvalRequired),
    never: list(p.never),
  });
}
