/**
 * Budgets (learning loop WP-B; spec §5 "budgets"): optional per-workspace and per-pipeline
 * token / cost caps (`config.budgets`). The supervisor calls `enforceBudget` before every run.
 *
 * Past a cap: a pending `user_request` (kind `approval`, site `budget:<scope>:<id>`, agent run id
 * `budget`) asks the user to extend; the run waits for the answer. Approving extends that scope by
 * one more cap (effective cap = cap × (1 + approvals)); denying refuses the run
 * (`BudgetExceededError`) and every later run of that scope while the configured cap is unchanged.
 */
import type { BifConfig, BudgetCap } from '../config/schema.js';
import { AbortError, type EventBus } from '../events.js';
import { usageTotals, type UsageTotals } from '../metrics/usage.js';
import type { Store } from '../store/db.js';
import { newId } from '../store/repos.js';
import type { UserRequest } from '../types.js';

export class BudgetExceededError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BudgetExceededError';
  }
}

export type BudgetScopeKind = 'workspace' | 'pipeline';

export type BudgetStatus = {
  kind: BudgetScopeKind;
  id: string;
  cap: BudgetCap;
  /** Approved extensions (each adds one cap). */
  extensions: number;
  effectiveCap: BudgetCap;
  spent: { tokens: number; costUsd: number };
  exceeded: boolean;
  /** A denial for the current cap stops new runs of this scope. */
  denied: boolean;
  pendingRequestId?: string;
};

/** Agent run id of budget requests (they are raised before any run starts). */
export const BUDGET_RUN_ID = 'budget';

const siteOf = (kind: BudgetScopeKind, id: string) => `budget:${kind}:${id}`;
const capTag = (cap: BudgetCap) => `[budget-cap tokens=${cap.maxTokens ?? '-'} cost=${cap.maxCostUsd ?? '-'}]`;

function requestsOf(store: Store, workspaceId: string, kind: BudgetScopeKind, id: string): UserRequest[] {
  return store.userRequests.list({ workspaceId, agentRunId: BUDGET_RUN_ID, site: siteOf(kind, id) });
}

function statusOf(store: Store, workspaceId: string, kind: BudgetScopeKind, id: string, cap: BudgetCap, spentTotals: UsageTotals): BudgetStatus {
  const reqs = requestsOf(store, workspaceId, kind, id);
  const tag = capTag(cap);
  // Only answers given for the currently configured cap count.
  const forCap = reqs.filter((r) => r.details.includes(tag));
  const extensions = forCap.filter((r) => r.status === 'resolved').length;
  const lastAnswered = forCap.filter((r) => r.status !== 'pending').at(-1);
  const factor = 1 + extensions;
  const effectiveCap: BudgetCap = {};
  if (cap.maxTokens !== undefined) effectiveCap.maxTokens = cap.maxTokens * factor;
  if (cap.maxCostUsd !== undefined) effectiveCap.maxCostUsd = cap.maxCostUsd * factor;
  const spent = { tokens: spentTotals.totalTokens, costUsd: spentTotals.costUsd };
  const exceeded =
    (effectiveCap.maxTokens !== undefined && spent.tokens >= effectiveCap.maxTokens) ||
    (effectiveCap.maxCostUsd !== undefined && spent.costUsd >= effectiveCap.maxCostUsd);
  const status: BudgetStatus = {
    kind, id, cap, extensions, effectiveCap, spent, exceeded, denied: lastAnswered?.status === 'denied',
  };
  const pending = reqs.find((r) => r.status === 'pending');
  if (pending) status.pendingRequestId = pending.id;
  return status;
}

/** Budget status of every configured scope that applies to a run of `workspaceId` (in `pipelineId`). */
export function budgetStatus(store: Store, config: BifConfig, workspaceId: string, pipelineId?: string): BudgetStatus[] {
  const out: BudgetStatus[] = [];
  const b = config.budgets;
  if (b?.workspace) out.push(statusOf(store, workspaceId, 'workspace', workspaceId, b.workspace, usageTotals(store, { workspaceId })));
  if (b?.pipeline && pipelineId) out.push(statusOf(store, workspaceId, 'pipeline', pipelineId, b.pipeline, usageTotals(store, { pipelineId })));
  return out;
}

const fmtCap = (c: BudgetCap) =>
  [c.maxTokens !== undefined ? `${c.maxTokens.toLocaleString('en-US')} tokens` : '', c.maxCostUsd !== undefined ? `$${c.maxCostUsd.toFixed(2)}` : '']
    .filter(Boolean)
    .join(' / ');

function raiseRequest(deps: { store: Store; events: EventBus }, workspaceId: string, s: BudgetStatus): UserRequest {
  const label = s.kind === 'workspace' ? 'Workspace' : `Pipeline ${s.id}`;
  const request: UserRequest = {
    id: newId('req'),
    workspaceId,
    agentRunId: BUDGET_RUN_ID,
    kind: 'approval',
    site: siteOf(s.kind, s.id),
    details:
      `${label} budget reached: ${s.spent.tokens.toLocaleString('en-US')} tokens / $${s.spent.costUsd.toFixed(2)} spent, ` +
      `cap ${fmtCap(s.effectiveCap)}. Approve to extend by ${fmtCap(s.cap)}; deny to stop new agent runs. ${capTag(s.cap)}`,
    status: 'pending',
    createdAt: new Date().toISOString(),
  };
  deps.store.userRequests.insert(request);
  deps.events.emit({ type: 'user_request', workspaceId, request });
  return request;
}

/**
 * Resolves when a new run of `workspaceId` (in `pipelineId`) is within every configured cap. Past a
 * cap it raises (or reuses) a budget request and waits for the user: approval re-checks with the
 * extension, denial (now or earlier, for the same cap) throws `BudgetExceededError`. Aborting
 * `signal` while waiting throws `AbortError`. No-op without `config.budgets`.
 */
export async function enforceBudget(
  deps: { store: Store; config: BifConfig; events: EventBus },
  scope: { workspaceId: string; pipelineId?: string },
  signal?: AbortSignal,
): Promise<void> {
  if (!deps.config.budgets) return;
  for (;;) {
    if (signal?.aborted) throw new AbortError('run cancelled before start');
    const over = budgetStatus(deps.store, deps.config, scope.workspaceId, scope.pipelineId).find((s) => s.exceeded);
    if (!over) return;
    if (over.denied && !over.pendingRequestId) {
      throw new BudgetExceededError(
        `${over.kind} budget exceeded (${fmtCap(over.effectiveCap)}); extension denied — raise budgets.${over.kind} in config to continue`,
      );
    }
    const requestId = over.pendingRequestId ?? raiseRequest(deps, scope.workspaceId, over).id;
    const stop = new AbortController();
    const answered = deps.events.waitFor(
      (e) => e.type === 'user_request_resolved' && e.request.id === requestId,
      signal ? AbortSignal.any([signal, stop.signal]) : stop.signal,
    );
    // Answered between the status read and subscribing: re-check right away.
    if (deps.store.userRequests.get(requestId)?.status !== 'pending') {
      answered.catch(() => {});
      stop.abort();
      continue;
    }
    await answered;
  }
}
