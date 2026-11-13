import type { SQLInputValue } from 'node:sqlite';
import type { BusEvent } from '../events.js';
import type { Store } from '../store/db.js';
import { redactSecrets } from '../store/redact.js';

/**
 * Persisted bus events (WP-D, migration 17): append-only `bus_events`, so tool-call validation
 * errors, run / task status changes and user-request traffic that used to exist only on the SSE
 * stream stay queryable. `run_event` (already in each run's `events.jsonl`) and `decision` (the
 * `decisions` table) are not duplicated. User requests are kept as ids + kind + status only (their
 * text lives in `user_requests`). Identity secrets are redacted.
 */

/** Bus event types written to `bus_events`. */
export const PERSISTED_BUS_EVENT_TYPES = ['tool_call', 'run_status', 'task_status', 'user_request', 'user_request_resolved'] as const;
export type PersistedBusEventType = (typeof PERSISTED_BUS_EVENT_TYPES)[number];

export interface StoredBusEvent {
  seq: number;
  workspaceId: string;
  type: PersistedBusEventType;
  agentRunId?: string;
  taskId?: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

const PERSISTED: ReadonlySet<string> = new Set(PERSISTED_BUS_EVENT_TYPES);

function slim(e: BusEvent): { payload: Record<string, unknown>; agentRunId?: string; taskId?: string } | undefined {
  switch (e.type) {
    case 'tool_call':
      return { payload: { ...e }, agentRunId: e.agentRunId };
    case 'run_status': {
      const out: ReturnType<typeof slim> = { payload: { ...e }, agentRunId: e.agentRunId };
      if (e.taskId !== undefined) out.taskId = e.taskId;
      return out;
    }
    case 'task_status':
      return { payload: { ...e }, taskId: e.taskId };
    case 'user_request':
    case 'user_request_resolved': {
      const r = e.request;
      const out: ReturnType<typeof slim> = {
        payload: { type: e.type, workspaceId: e.workspaceId, requestId: r.id, kind: r.kind, status: r.status },
        agentRunId: r.agentRunId,
      };
      if (r.taskId !== undefined) out.taskId = r.taskId;
      return out;
    }
    default:
      return undefined;
  }
}

/** Appends `e` when its type is persisted; returns its sequence number (`undefined` when skipped). */
export function persistBusEvent(store: Store, e: BusEvent, at: Date = new Date()): number | undefined {
  if (!PERSISTED.has(e.type)) return undefined;
  const s = slim(e);
  if (!s) return undefined;
  const payload = redactSecrets(store, e.workspaceId, s.payload);
  const res = store.db
    .prepare('INSERT INTO bus_events (workspace_id, type, agent_run_id, task_id, payload, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(e.workspaceId, e.type, s.agentRunId ?? null, s.taskId ?? null, JSON.stringify(payload), at.toISOString());
  return Number(res.lastInsertRowid);
}

export type BusEventQuery = {
  workspaceId: string;
  type?: PersistedBusEventType;
  agentRunId?: string;
  taskId?: string;
  /** Only events with `seq > afterSeq` (paging). */
  afterSeq?: number;
  /** Default 200, max 1000. */
  limit?: number;
};

type Row = {
  seq: number | bigint;
  workspace_id: string;
  type: string;
  agent_run_id: string | null;
  task_id: string | null;
  payload: string;
  created_at: string;
};

/** Persisted bus events of a workspace in sequence order (oldest first). */
export function listBusEvents(store: Store, q: BusEventQuery): StoredBusEvent[] {
  const where = ['workspace_id = ?'];
  const params: SQLInputValue[] = [q.workspaceId];
  if (q.type) {
    where.push('type = ?');
    params.push(q.type);
  }
  if (q.agentRunId) {
    where.push('agent_run_id = ?');
    params.push(q.agentRunId);
  }
  if (q.taskId) {
    where.push('task_id = ?');
    params.push(q.taskId);
  }
  if (q.afterSeq !== undefined) {
    where.push('seq > ?');
    params.push(q.afterSeq);
  }
  const limit = Math.min(Math.max(1, Math.floor(q.limit ?? 200)), 1000);
  params.push(limit);
  const rows = store.db
    .prepare(`SELECT * FROM bus_events WHERE ${where.join(' AND ')} ORDER BY seq LIMIT ?`)
    .all(...params) as Row[];
  return rows.map((r) => {
    const e: StoredBusEvent = {
      seq: Number(r.seq),
      workspaceId: r.workspace_id,
      type: r.type as PersistedBusEventType,
      payload: JSON.parse(r.payload) as Record<string, unknown>,
      createdAt: r.created_at,
    };
    if (r.agent_run_id !== null) e.agentRunId = r.agent_run_id;
    if (r.task_id !== null) e.taskId = r.task_id;
    return e;
  });
}

/** Deletes rows older than `retentionDays` (0 keeps everything). Returns the number deleted. */
export function pruneBusEvents(store: Store, retentionDays: number, now: Date = new Date()): number {
  if (!(retentionDays > 0)) return 0;
  const cutoff = new Date(now.getTime() - retentionDays * 86_400_000).toISOString();
  return Number(store.db.prepare('DELETE FROM bus_events WHERE created_at < ?').run(cutoff).changes);
}
