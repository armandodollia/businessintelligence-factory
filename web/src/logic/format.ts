/** Pure display helpers shared by views (no state, no I/O). */
import type { BusEvent, Criteria, Decision, WorkspaceNode } from './types.js';
import { isWithheld, WITHHELD_TEXT } from './stakeholders.js';

export function formatValue(v: unknown): string {
  if (v === null || v === undefined || v === '') return '—';
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : v.toFixed(2);
  if (typeof v === 'string') return v;
  return JSON.stringify(v);
}

/**
 * The address when it is safe to put in an `href`: only `http:` and `https:` URLs. Anything else
 * (`javascript:`, `data:`, unparseable) is undefined, so the view shows it as plain text. React 18
 * does not block `javascript:` URLs, and served addresses can come from scraped third-party pages.
 */
export function safeHref(url: string | undefined | null): string | undefined {
  if (!url) return undefined;
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : undefined;
  } catch {
    return undefined;
  }
}

export function shortDate(iso: string | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

export function toggle<T>(list: readonly T[], item: T): T[] {
  return list.includes(item) ? list.filter((x) => x !== item) : [...list, item];
}

/** A Decision payload as one line; a withheld one (own-stakeholder research while hidden) says so. */
export function payloadText(payload: unknown, max = 240): string {
  return isWithheld(payload) ? WITHHELD_TEXT : summarize(payload, max);
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
      return `${e.decision.kind} by ${e.decision.role}: ${payloadText(e.decision.payload, 160)}`;
    case 'user_request':
      return `user action requested: ${e.request.kind} ${e.request.site ?? ''}`;
    case 'user_request_resolved':
      return `user action ${e.request.status}: ${e.request.kind}`;
    case 'task_status':
      return `task ${e.taskId} ${e.status}`;
    case 'retrieval': // knowledge store (KS-0)
      return `knowledge read ${e.retrievalEventId}`;
    case 'policy_blocked': // knowledge store (KS-4)
      return `knowledge read blocked: ${e.tool} ${e.itemId} (${e.reason === 'out_of_slice' ? 'outside the review slice' : 'outside this business'})`;
  }
}

export function eventRunId(e: BusEvent): string | undefined {
  return 'agentRunId' in e ? e.agentRunId : undefined;
}

/** "Globex · signup step 1" (subject omitted on diffs recorded before subjects were tracked). */
export function changedArtifactLabel(a: { subject?: string; flow: string; step: number }): string {
  return `${a.subject ? `${a.subject} · ` : ''}${a.flow} step ${a.step}`;
}

/** Ratable decision criteria (mirrors core `CRITERIA.decision`; `pushback` is derived from the kind). */
export const DECISION_CRITERIA = ['confidence', 'score'] as const;

/**
 * Agent values on a decision the user can rate: `confidence` (log_decision), `score` (review) and
 * `pushback` (worker pushbacks). Empty for user / scheduler decisions.
 */
export function decisionCriteria(d: Pick<Decision, 'payload'> & Partial<Pick<Decision, 'kind'>>): Criteria {
  const p = (d.payload ?? {}) as Record<string, unknown>;
  const out: Criteria = {};
  for (const k of DECISION_CRITERIA) if (typeof p[k] === 'number') out[k] = p[k] as number;
  // learning loop WP-C: a worker pushback is ratable (agent value 1: "the issue needs no change").
  if (d.kind === 'pushback') out.pushback = 1;
  return out;
}
