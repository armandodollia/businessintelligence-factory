import type { ExtraToolHandler } from '../harness/tools/handlers.js';
import type { ToolName } from '../harness/tools/registry.js';
import { createEmailProvider, type EmailProvider } from '../identity/email.js';
import { getIdentityHandler } from '../identity/identities.js';
import { saveHypothesisHandler } from '../interview/hypotheses.js';
import { saveCompetitorHandler } from '../market/competitors.js';
import { proposeBusinessUnitHandler } from '../workspace/businessMap.js';
import { proposeTasksHandler } from './orchestrator.js';

export type ResearchToolOptions = {
  /** Inbox provider for `get_identity`; default: from `config.identity` (created on first use). */
  emailProvider?: EmailProvider;
};

/**
 * Section C tool handlers, to pass as (part of) `createToolHandlers({ extraHandlers })`:
 * `propose_tasks`, `get_identity`, `propose_business_unit`, `save_competitor`, `save_hypothesis`.
 * (`read_workspace` is a knowledge read tool since KS-4: harness/tools/handlers.ts.)
 */
export function researchToolHandlers(opts: ResearchToolOptions = {}): Partial<Record<ToolName, ExtraToolHandler>> {
  let identity: ExtraToolHandler | undefined = opts.emailProvider ? getIdentityHandler(opts.emailProvider) : undefined;
  return {
    propose_tasks: proposeTasksHandler,
    propose_business_unit: proposeBusinessUnitHandler,
    save_competitor: saveCompetitorHandler,
    save_hypothesis: saveHypothesisHandler,
    get_identity: (ctx, input, deps, callOpts) => {
      identity ??= getIdentityHandler(
        createEmailProvider(deps.config, {
          passwordFor: (address) => deps.store.identities.list({ email: address })[0]?.emailPassword,
        }),
      );
      return identity(ctx, input, deps, callOpts);
    },
  };
}
