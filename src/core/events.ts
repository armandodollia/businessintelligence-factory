import type { RunEvent } from './harness/adapter.js';
import type { AgentRun, Decision, Task, UserRequest } from './types.js';

/**
 * Process-wide events (consumed by SSE in the API and by waiters in core). Later sections may
 * add variants; keep every variant tagged by `type` and carrying `workspaceId`.
 */
export type BusEvent =
  | { type: 'run_event'; workspaceId: string; agentRunId: string; taskId?: string; event: RunEvent }
  | {
      type: 'run_status';
      workspaceId: string;
      agentRunId: string;
      taskId?: string;
      status: AgentRun['status'];
      exitCode?: number;
      reason?: string;
    }
  | {
      /** Every harness tool call, accepted or rejected (`error` set when rejected/failed). */
      type: 'tool_call';
      workspaceId: string;
      agentRunId: string;
      tool: string;
      ok: boolean;
      error?: string;
    }
  | { type: 'decision'; workspaceId: string; decision: Decision }
  | { type: 'user_request'; workspaceId: string; request: UserRequest }
  | { type: 'user_request_resolved'; workspaceId: string; request: UserRequest }
  | {
      /**
       * A task's review loop ended: the task and its outputs (findings, recommendations, personas,
       * competitors, hypotheses) now carry their final status. Views listing outputs reload on it.
       */
      type: 'task_status';
      workspaceId: string;
      taskId: string;
      status: Task['status'];
    }
  // --- knowledge store KS-0 ---
  | {
      /**
       * A knowledge read was logged (`retrieval_events`, design §13). Carries only the row id: the
       * payload lives in the table (no second copy). Emitted by `recordRetrieval`.
       */
      type: 'retrieval';
      workspaceId: string;
      retrievalEventId: string;
      agentRunId?: string;
      taskId?: string;
    }
  // --- knowledge store KS-4 ---
  | {
      /**
       * A knowledge read named an id outside the caller's reach: outside the reviewer's / escalation's
       * review slice, or of another business tree (design §9, §12). The caller got the same "not found"
       * as for an unknown id. KS-6 persists it as a `policy_events` row (blocked attempt).
       */
      type: 'policy_blocked';
      workspaceId: string;
      agentRunId?: string;
      taskId?: string;
      tool: string;
      itemId: string;
      reason: 'out_of_slice' | 'out_of_tree';
    };

export class AbortError extends Error {
  constructor(message = 'aborted') {
    super(message);
    this.name = 'AbortError';
  }
}

/** Minimal synchronous pub/sub. Listener errors are isolated (logged, not rethrown). */
export class EventBus {
  private readonly listeners = new Set<(e: BusEvent) => void>();

  emit(e: BusEvent): void {
    for (const fn of [...this.listeners]) {
      try {
        fn(e);
      } catch (err) {
        console.error('[bif] event listener failed:', err);
      }
    }
  }

  /** Subscribes; returns the unsubscribe function. */
  on(fn: (e: BusEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Resolves with the first event matching `pred`; rejects with `AbortError` on abort. */
  waitFor(pred: (e: BusEvent) => boolean, signal?: AbortSignal): Promise<BusEvent> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(new AbortError());
      const onAbort = () => {
        off();
        reject(new AbortError());
      };
      const off = this.on((e) => {
        if (!pred(e)) return;
        off();
        signal?.removeEventListener('abort', onAbort);
        resolve(e);
      });
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }
}
