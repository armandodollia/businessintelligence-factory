import type { Store } from '../../store/db.js';
import type { Decision } from '../../types.js';
import type { RunContext } from '../tokens.js';

/**
 * Agent runs whose earlier tool calls count as replays of a call from `ctx`:
 * - `run`: the run itself (a rate-limit retry restarts the agent on the same run);
 * - `task`: every run of the run's task (also covers a task-level retry with a new run); falls back to
 *   the run itself when there is no task.
 */
export function replayRunIds(store: Store, ctx: RunContext, scope: 'run' | 'task'): string[] {
  if (scope === 'task' && ctx.taskId) {
    const ids = store.agentRuns
      .list({ taskId: ctx.taskId })
      .filter((r) => r.workspaceId === ctx.workspaceId)
      .map((r) => r.id);
    return ids.includes(ctx.agentRunId) ? ids : [...ids, ctx.agentRunId];
  }
  return [ctx.agentRunId];
}

/** The earliest Decision of `tool` within the replay scope whose payload matches, if any. */
export function findReplay(
  store: Store,
  ctx: RunContext,
  tool: string,
  scope: 'run' | 'task',
  match: (payload: Record<string, unknown>) => boolean,
): Decision | undefined {
  for (const runId of replayRunIds(store, ctx, scope)) {
    for (const d of store.decisions.list({ agentRunId: runId })) {
      const p = d.payload as Record<string, unknown> | null;
      if (d.workspaceId === ctx.workspaceId && p && typeof p === 'object' && p.tool === tool && match(p)) return d;
    }
  }
  return undefined;
}

/** Content key for titles: lowercase, collapsed whitespace. */
export const titleKey = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');
