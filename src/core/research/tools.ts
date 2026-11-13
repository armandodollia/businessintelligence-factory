import type { ExtraToolHandler } from '../harness/tools/handlers.js';
import type { ToolName } from '../harness/tools/registry.js';
import { createEmailProvider, type EmailProvider } from '../identity/email.js';
import { getIdentityHandler } from '../identity/identities.js';
import { proposeBusinessUnitHandler, readWorkspaceHandler } from '../workspace/businessMap.js';
import { proposeTasksHandler } from './orchestrator.js';

export type ResearchToolOptions = {
  /** Inbox provider for `get_identity`; default: from `config.identity` (created on first use). */
  emailProvider?: EmailProvider;
};

/**
 * Section C tool handlers, to pass as (part of) `createToolHandlers({ extraHandlers })`:
 * `propose_tasks`, `get_identity`, `read_workspace`, `propose_business_unit`.
 */
export function researchToolHandlers(opts: ResearchToolOptions = {}): Partial<Record<ToolName, ExtraToolHandler>> {
  let identity: ExtraToolHandler | undefined = opts.emailProvider ? getIdentityHandler(opts.emailProvider) : undefined;
  return {
    propose_tasks: proposeTasksHandler,
    read_workspace: readWorkspaceHandler,
    propose_business_unit: proposeBusinessUnitHandler,
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
