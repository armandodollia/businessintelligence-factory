import type { ExtraToolHandler } from '../harness/tools/handlers.js';
import type { ToolName } from '../harness/tools/registry.js';
import { proposeTasksHandler } from './orchestrator.js';

export type ResearchToolOptions = Record<string, never>;

/**
 * Section C tool handlers, to pass as (part of) `createToolHandlers({ extraHandlers })`:
 * `propose_tasks`.
 */
export function researchToolHandlers(_opts: ResearchToolOptions = {}): Partial<Record<ToolName, ExtraToolHandler>> {
  return {
    propose_tasks: proposeTasksHandler,
  };
}
