/** Pure display helpers shared by views (no state, no I/O). */
import type { BusEvent, Criteria, Decision, WorkspaceNode } from './types.js';

export function formatValue(v: unknown): string {
  if (v === null || v === undefined || v === '') return '—';
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : v.toFixed(2);
  if (typeof v === 'string') return v;
  return JSON.stringify(v);
}

export function shortDate(iso: string | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

export function toggle<T>(list: readonly T[], item: T): T[] {
  return list.includes(item) ? list.filter((x) => x !== item) : [...list, item];
}

export function summarize(payload: unknown, max = 240): string {
  const s = typeof payload === 'string' ? payload : JSON.stringify(payload);
  if (!s) return '';
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

export function workspaceLabel(w: WorkspaceNode): string {
  const scope = w.scope ? ` · ${w.scope.level}${w.scope.name && w.scope.name !== w.name ? `: ${w.scope.name}` : ''}` : '';
  const aud = w.audiences?.length ? ` · ${w.audiences.join('+')}` : '';
  return `${w.name}${scope}${aud}`;
}

/** Indents a flat workspace list by tree depth (parents first). */
export function orderAsTree(list: WorkspaceNode[]): Array<{ workspace: WorkspaceNode; depth: number }> {
  const ids = new Set(list.map((w) => w.id));
  const kids = new Map<string, WorkspaceNode[]>();
  const roots: WorkspaceNode[] = [];
  for (const w of list) {
    if (w.parentWorkspaceId && ids.has(w.parentWorkspaceId)) {
      kids.set(w.parentWorkspaceId, [...(kids.get(w.parentWorkspaceId) ?? []), w]);
    } else roots.push(w);
  }
  const out: Array<{ workspace: WorkspaceNode; depth: number }> = [];
  const seen = new Set<string>();
  const walk = (w: WorkspaceNode, depth: number) => {
    if (seen.has(w.id)) return;
    seen.add(w.id);
    out.push({ workspace: w, depth });
    for (const c of kids.get(w.id) ?? []) walk(c, depth + 1);
  };
  roots.forEach((r) => walk(r, 0));
  return out;
}

export function describeEvent(e: BusEvent): string {
  switch (e.type) {
    case 'run_event': {
      const ev = e.event;
      switch (ev.t) {
        case 'message':
          return ev.text;
        case 'tool_call':
          return `→ ${ev.name} ${summarize(ev.input, 120)}`;
        case 'tool_result':
          return `← ${ev.name} ${ev.ok ? 'ok' : 'failed'}`;
        case 'usage':
          return `usage in=${ev.inputTokens ?? '?'} out=${ev.outputTokens ?? '?'}`;
        case 'error':
          return `error${ev.rateLimited ? ' (rate limited)' : ''}: ${ev.message}`;
        case 'done':
          return `done (exit ${ev.exitCode})`;
      }
      return summarize(ev);
    }
    case 'run_status':
      return `run ${e.status}${e.exitCode !== undefined ? ` (exit ${e.exitCode})` : ''}${e.reason ? `: ${e.reason}` : ''}`;
    case 'tool_call':
      return `tool ${e.tool} ${e.ok ? 'accepted' : `rejected: ${e.error ?? ''}`}`;
    case 'decision':
      return `${e.decision.kind} by ${e.decision.role}: ${summarize(e.decision.payload, 160)}`;
    case 'user_request':
      return `user action requested: ${e.request.kind} ${e.request.site ?? ''}`;
    case 'user_request_resolved':
      return `user action ${e.request.status}: ${e.request.kind}`;
  }
}

export function eventRunId(e: BusEvent): string | undefined {
  return 'agentRunId' in e ? e.agentRunId : undefined;
}

/** Ratable decision criteria (mirrors core `CRITERIA.decision`). */
export const DECISION_CRITERIA = ['confidence', 'score'] as const;

/**
 * Agent values on a decision the user can rate: `confidence` (log_decision) and `score`
 * (review). Empty for user / scheduler decisions.
 */
export function decisionCriteria(d: Pick<Decision, 'payload'>): Criteria {
  const p = (d.payload ?? {}) as Record<string, unknown>;
  const out: Criteria = {};
  for (const k of DECISION_CRITERIA) if (typeof p[k] === 'number') out[k] = p[k] as number;
  return out;
}
