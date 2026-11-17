import type { SQLInputValue } from 'node:sqlite';
import type { BifConfig } from '../config/schema.js';
import type { BusEvent } from '../events.js';
import { STOPPED_REQUEST_RESPONSE } from '../research/stop.js';
import type { Store } from '../store/db.js';
import { newId } from '../store/repos.js';
import type { Role } from '../types.js';
import { rootOf } from '../workspace/tree.js';

/**
 * Action-policy history (WP-D, migration 17): every approval requested / granted / denied and every
 * blocked attempt (a tool call rejected by role scope, or an approval request for a `never` action),
 * append-only in `policy_events`. Each row carries the business-tree root it happened in, so reads
 * (prompt context, lessons) never cross trees.
 */

export const POLICY_EVENT_KINDS = ['approval_requested', 'approval_granted', 'approval_denied', 'blocked'] as const;
export type PolicyEventKind = (typeof POLICY_EVENT_KINDS)[number];
/** Kinds that count as a denial for the requesting role (prompt context, lessons). */
export const DENIAL_KINDS: readonly PolicyEventKind[] = ['approval_denied', 'blocked'];

export interface PolicyEvent {
  id: string;
  workspaceId: string;
  /** Root of the workspace's business tree at write time. */
  rootWorkspaceId: string;
  agentRunId?: string;
  taskId?: string;
  role?: Role;
  kind: PolicyEventKind;
  /** The gated action (approval requests) or the rejected tool (blocks). */
  action?: string;
  site?: string;
  /** User's answer on a resolved approval, or the rejection message of a block. */
  detail?: string;
  /** The user request this event belongs to (approvals). */
  requestId?: string;
  createdAt: string;
}

export type NewPolicyEvent = Omit<PolicyEvent, 'id' | 'rootWorkspaceId' | 'createdAt'> & { createdAt?: string };

type Row = {
  id: string;
  workspace_id: string;
  root_workspace_id: string;
  agent_run_id: string | null;
  task_id: string | null;
  role: string | null;
  kind: string;
  action: string | null;
  site: string | null;
  detail: string | null;
  request_id: string | null;
  created_at: string;
};

function fromRow(r: Row): PolicyEvent {
  const e: PolicyEvent = {
    id: r.id,
    workspaceId: r.workspace_id,
    rootWorkspaceId: r.root_workspace_id,
    kind: r.kind as PolicyEventKind,
    createdAt: r.created_at,
  };
  if (r.agent_run_id !== null) e.agentRunId = r.agent_run_id;
  if (r.task_id !== null) e.taskId = r.task_id;
  if (r.role !== null) e.role = r.role as Role;
  if (r.action !== null) e.action = r.action;
  if (r.site !== null) e.site = r.site;
  if (r.detail !== null) e.detail = r.detail;
  if (r.request_id !== null) e.requestId = r.request_id;
  return e;
}

/** Appends one policy event (root resolved now, from the workspace tree). */
export function recordPolicyEvent(store: Store, input: NewPolicyEvent): PolicyEvent {
  const e: PolicyEvent = {
    ...input,
    id: newId('pev'),
    rootWorkspaceId: rootOf(store, input.workspaceId),
    createdAt: input.createdAt ?? new Date().toISOString(),
  };
  store.db
    .prepare(
      `INSERT INTO policy_events (id, workspace_id, root_workspace_id, agent_run_id, task_id, role, kind, action, site, detail, request_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      e.id, e.workspaceId, e.rootWorkspaceId, e.agentRunId ?? null, e.taskId ?? null, e.role ?? null, e.kind,
      e.action ?? null, e.site ?? null, e.detail ?? null, e.requestId ?? null, e.createdAt,
    );
  return e;
}

export type PolicyEventFilter = {
  /** Any workspace of the tree. */
  workspaceId: string;
  /** `tree` (default): every workspace of its business tree; `workspace`: that workspace only. */
  scope?: 'tree' | 'workspace';
  role?: Role;
  kinds?: readonly PolicyEventKind[];
  /** ISO timestamp; only events at or after it. */
  since?: string;
  /** Newest `limit` events (still returned oldest first). */
  limit?: number;
  /** KS-6: leave out events with these `site` values. */
  excludeSites?: readonly string[];
};

/**
 * Policy events, oldest first. Query function for consumers such as the lessons engine (WP-E):
 * tree-scoped by default, so one business never sees another's history.
 */
export function listPolicyEvents(store: Store, filter: PolicyEventFilter): PolicyEvent[] {
  const where: string[] = [];
  const params: SQLInputValue[] = [];
  if (filter.scope === 'workspace') {
    where.push('workspace_id = ?');
    params.push(filter.workspaceId);
  } else {
    where.push('root_workspace_id = ?');
    params.push(rootOf(store, filter.workspaceId));
  }
  if (filter.role) {
    where.push('role = ?');
    params.push(filter.role);
  }
  if (filter.kinds?.length) {
    where.push(`kind IN (${filter.kinds.map(() => '?').join(', ')})`);
    params.push(...filter.kinds);
  }
  if (filter.since) {
    where.push('created_at >= ?');
    params.push(filter.since);
  }
  if (filter.excludeSites?.length) {
    where.push(`(site IS NULL OR site NOT IN (${filter.excludeSites.map(() => '?').join(', ')}))`);
    params.push(...filter.excludeSites);
  }
  let sql = `SELECT * FROM policy_events WHERE ${where.join(' AND ')} ORDER BY created_at DESC, rowid DESC`;
  if (filter.limit !== undefined) {
    sql += ' LIMIT ?';
    params.push(Math.max(0, Math.floor(filter.limit)));
  }
  return (store.db.prepare(sql).all(...params) as Row[]).map(fromRow).reverse();
}

/** The role's most recent denials (denied approvals, blocks) in the workspace's business tree, newest first. */
export function recentPolicyDenials(
  store: Store,
  opts: { workspaceId: string; role: Role; limit?: number; excludeSites?: readonly string[] },
): PolicyEvent[] {
  return listPolicyEvents(store, {
    workspaceId: opts.workspaceId,
    role: opts.role,
    kinds: DENIAL_KINDS,
    limit: opts.limit ?? 5,
    ...(opts.excludeSites ? { excludeSites: opts.excludeSites } : {}),
  }).reverse();
}

const clip = (s: string, n: number) => {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > n ? `${one.slice(0, n)}…` : one;
};

/**
 * Short prompt section with the role's recent policy denials in this business tree (at most `limit`
 * lines of ≤ 200 chars), so the agent does not retry what the user or the harness refused. Empty
 * string when there are none.
 */
export function policyDenialsSection(store: Store, workspaceId: string, role: Role, limit = 5): string {
  // KS-6: out-of-tree knowledge blocks are never shown to agents (see `KNOWLEDGE_BLOCK_SITE`).
  const denials = recentPolicyDenials(store, { workspaceId, role, limit, excludeSites: [KNOWLEDGE_BLOCK_SITE.out_of_tree] });
  if (!denials.length) return '';
  const lines = denials.map((d) => {
    const what = d.kind === 'blocked' ? 'blocked' : 'approval denied';
    const target = `${d.action ?? '(unspecified)'}${d.site ? ` on ${d.site}` : ''}`;
    return `- ${d.createdAt.slice(0, 10)} ${what}: ${clip(`${target}${d.detail ? ` (${d.detail})` : ''}`, 180)}`;
  });
  return (
    '## Recent policy denials for your role (this business)\n' +
    `${lines.join('\n')}\n` +
    'Do not retry these actions or ask again for the same approval; work around them or report the gap.'
  );
}

/** Parses the action out of a `request_approval` request's details (`Action: <action>\n\n...`). */
function approvalAction(details: string): string {
  const m = /^Action:\s*(.+)$/m.exec(details);
  return (m?.[1] ?? details).trim();
}

const ROLE_SCOPE = /is not available to role '/;

/** True when an approval request's action matches a `never` item of the action policy (case-insensitive). */
function isNeverAction(action: string, config?: Pick<BifConfig, 'actionPolicy'>): boolean {
  const a = action.toLowerCase();
  return !!config?.actionPolicy.never.some((n) => n.trim() && a.includes(n.trim().toLowerCase()));
}

/**
 * Derives policy events from a bus event: approval `user_request` → `approval_requested` (plus
 * `blocked` when the action is on the `never` list), resolved approvals → `approval_granted` /
 * `approval_denied`, a `tool_call` rejected by role scope → `blocked`. Returns the recorded events.
 */
export function recordPolicyEventsFromBus(
  store: Store,
  e: BusEvent,
  config?: Pick<BifConfig, 'actionPolicy'>,
): PolicyEvent[] {
  const runOf = (agentRunId: string) => store.agentRuns.get(agentRunId);
  const base = (agentRunId: string, workspaceId: string, taskId?: string): NewPolicyEvent => {
    const run = runOf(agentRunId);
    const out: NewPolicyEvent = { workspaceId, agentRunId, kind: 'blocked' };
    const t = taskId ?? run?.taskId;
    if (t !== undefined) out.taskId = t;
    if (run) out.role = run.role;
    return out;
  };
  const out: PolicyEvent[] = [];
  if ((e.type === 'user_request' || e.type === 'user_request_resolved') && e.request.kind === 'approval') {
    const r = e.request;
    const ev: NewPolicyEvent = { ...base(r.agentRunId, r.workspaceId, r.taskId), action: approvalAction(r.details), requestId: r.id };
    if (r.site !== undefined) ev.site = r.site;
    if (e.type === 'user_request') {
      if (r.status !== 'pending') return out;
      out.push(recordPolicyEvent(store, { ...ev, kind: 'approval_requested' }));
      if (isNeverAction(ev.action!, config)) {
        out.push(recordPolicyEvent(store, { ...ev, kind: 'blocked', detail: 'approval requested for an action the policy never allows' }));
      }
    } else {
      // Closed because research was stopped (`stopResearch`): the person denied nothing.
      if (r.status === 'denied' && r.response === STOPPED_REQUEST_RESPONSE) return out;
      const done: NewPolicyEvent = { ...ev, kind: r.status === 'resolved' ? 'approval_granted' : 'approval_denied' };
      if (r.response) done.detail = r.response;
      out.push(recordPolicyEvent(store, done));
    }
  } else if (e.type === 'tool_call' && !e.ok && e.error && ROLE_SCOPE.test(e.error)) {
    out.push(recordPolicyEvent(store, { ...base(e.agentRunId, e.workspaceId), kind: 'blocked', action: e.tool, detail: e.error }));
  } else if (e.type === 'policy_blocked') {
    out.push(recordPolicyEvent(store, knowledgeBlockedEvent(e, base))); // knowledge store KS-6
  }
  return out;
}

// ---------------------------------------------------------------------------
// Knowledge store KS-6 (design §9, §12, §13): a knowledge read that named an id outside the caller's
// reach (outside the reviewer's / escalation's review slice, or of another business tree) is a
// blocked attempt. `site` carries the reason (`knowledge:out_of_slice` | `knowledge:out_of_tree`).
// The agent was answered "not found" exactly as for an unknown id, so out-of-tree blocks are never
// shown back to agents (`policyDenialsSection`): the line would confirm that the id exists elsewhere.

export const KNOWLEDGE_BLOCK_SITE = { out_of_slice: 'knowledge:out_of_slice', out_of_tree: 'knowledge:out_of_tree' } as const;

function knowledgeBlockedEvent(
  e: Extract<BusEvent, { type: 'policy_blocked' }>,
  base: (agentRunId: string, workspaceId: string, taskId?: string) => NewPolicyEvent,
): NewPolicyEvent {
  const ev: NewPolicyEvent = e.agentRunId !== undefined ? base(e.agentRunId, e.workspaceId, e.taskId) : { workspaceId: e.workspaceId, kind: 'blocked' };
  if (e.agentRunId === undefined && e.taskId !== undefined) ev.taskId = e.taskId;
  return {
    ...ev,
    kind: 'blocked',
    action: e.tool,
    site: KNOWLEDGE_BLOCK_SITE[e.reason],
    detail: e.reason === 'out_of_slice' ? `${e.itemId} is outside the task's review slice` : `${e.itemId} belongs to another business tree`,
  };
}
// --- end knowledge store KS-6 --------------------------------------------------------------------
