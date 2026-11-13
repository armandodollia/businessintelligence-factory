/**
 * Prompt-context reads (design §12 "Upload exposure", §13; KS-4 design-thread ruling): store text an
 * agent run is SHOWN in its assembled prompt (the reviewer's knowledge context today, KS-5 briefings
 * next) is a read like any tool call. Its `retrieval_events` row (`tool: 'prompt_context'`) is written
 * once the run id exists and BEFORE the run starts — never after — so a crash mid-run cannot lose
 * the row that makes the run upload-exposed.
 *
 * Seam: `AgentRequest.promptReads` (research/deps.ts) → `RunOptions.beforeStart` (supervisor) →
 * `recordPromptReads`. KS-5 builds its briefing, passes the briefing's `PromptRead` with the request,
 * and gets the same guarantee.
 */
import type { EventBus } from '../events.js';
import type { RunContext } from '../harness/tokens.js';
import type { Store } from '../store/db.js';
import type { RetrievalEvent } from '../types.js';
import { recordRetrieval, type RetrievalEntry } from './retrievalLog.js';

/** One prompt section that carries store text: what `recordRetrieval` needs except the tool and latency. */
export type PromptRead = Omit<RetrievalEntry, 'tool' | 'latencyMs'> & { latencyMs?: number };

/** Logs every prompt read of a run that is about to start (called from `RunOptions.beforeStart`). */
export function recordPromptReads(
  deps: { store: Store; events?: EventBus },
  ctx: RunContext,
  reads: readonly PromptRead[],
): RetrievalEvent[] {
  return reads.map((r) =>
    recordRetrieval(
      deps,
      {
        workspaceId: ctx.workspaceId,
        agentRunId: ctx.agentRunId,
        ...(ctx.taskId !== undefined ? { taskId: ctx.taskId } : {}),
        role: ctx.role,
        model: ctx.model,
        promptVersion: ctx.promptVersion,
      },
      { ...r, tool: 'prompt_context', latencyMs: r.latencyMs ?? 0 },
    ),
  );
}
