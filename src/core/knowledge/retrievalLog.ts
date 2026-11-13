/**
 * Retrieval log (design §13, §12 "Upload exposure"). `recordRetrieval` is the one function that
 * logs a knowledge read: the dispatcher calls it for every read tool (KS-4) and prompt assembly for
 * every briefing (`prompt_context`, KS-5). It appends a `retrieval_events` row (query redacted) and
 * emits a `retrieval` bus event that carries only the row id.
 *
 * A run that was shown upload-derived text is upload-exposed: `runIsUploadExposed` is what the
 * export (KS-6) uses to exclude that run's judgments by default.
 */
import type { ModelRef } from '../config/schema.js';
import type { EventBus } from '../events.js';
import type { Store } from '../store/db.js';
import { knowledgeRepos, newId } from '../store/repos.js';
import type { RetrievalEvent, RetrievalResultRef, RetrievalRole, RetrievalTool } from '../types.js';
import { rootOf } from '../workspace/tree.js';
import { redactServed } from './trust.js';

/** Who read: an agent run (a `RunContext` fits) or the user through the API (`role: 'user'`). */
export type RetrievalContext = {
  workspaceId: string;
  agentRunId?: string;
  taskId?: string;
  role: RetrievalRole;
  model?: ModelRef;
  promptVersion?: string;
};

export type RetrievalEntry = {
  tool: RetrievalTool;
  /** The query text (search) or a compact form of the input (other tools). Redacted and capped here. */
  query: string;
  /** `node` | `tree`, or `node:<workspaceId>` when narrowed. */
  scope: string;
  /** Returned items in response order. */
  results: RetrievalResultRef[];
  tokensReturned: number;
  truncated?: boolean;
  relaxed?: boolean;
  latencyMs: number;
  /** The response contained upload-derived text (any hit, line or chunk flagged). */
  uploadDerived: boolean;
};

/** Longest query text stored. */
export const MAX_LOGGED_QUERY_CHARS = 2000;

export function recordRetrieval(
  deps: { store: Store; events?: EventBus },
  ctx: RetrievalContext,
  entry: RetrievalEntry,
  now: Date = new Date(),
): RetrievalEvent {
  const { store } = deps;
  const ev: RetrievalEvent = {
    id: newId('ret'),
    workspaceId: ctx.workspaceId,
    rootWorkspaceId: rootOf(store, ctx.workspaceId),
    role: ctx.role,
    tool: entry.tool,
    query: redactServed(store, ctx.workspaceId, entry.query).slice(0, MAX_LOGGED_QUERY_CHARS),
    scope: entry.scope,
    resultIds: entry.results.map((r) => ({ id: r.id, kind: r.kind })),
    resultCount: entry.results.length,
    tokensReturned: Math.max(0, Math.round(entry.tokensReturned)),
    truncated: entry.truncated ?? false,
    relaxed: entry.relaxed ?? false,
    latencyMs: Math.max(0, Math.round(entry.latencyMs)),
    uploadDerived: entry.uploadDerived,
    createdAt: now.toISOString(),
  };
  if (ctx.agentRunId !== undefined) ev.agentRunId = ctx.agentRunId;
  if (ctx.taskId !== undefined) ev.taskId = ctx.taskId;
  if (ctx.model) {
    ev.provider = ctx.model.provider;
    ev.model = ctx.model.model;
  }
  if (ctx.promptVersion !== undefined) ev.promptVersion = ctx.promptVersion;
  knowledgeRepos(store).retrievalEvents.insert(ev);
  deps.events?.emit({
    type: 'retrieval',
    workspaceId: ev.workspaceId,
    retrievalEventId: ev.id,
    ...(ev.agentRunId !== undefined ? { agentRunId: ev.agentRunId } : {}),
    ...(ev.taskId !== undefined ? { taskId: ev.taskId } : {}),
  });
  return ev;
}

/** True when any logged read of the agent run returned upload-derived text. */
export function runIsUploadExposed(store: Store, agentRunId: string): boolean {
  return (
    store.db.prepare('SELECT 1 FROM retrieval_events WHERE agent_run_id = ? AND upload_derived = 1 LIMIT 1').get(agentRunId) !==
    undefined
  );
}
