/**
 * Token usage and cost of agent runs (learning loop WP-B). Every adapter `usage` RunEvent is stored
 * as one `agent_usage` row (see `recordUsage`); everything here aggregates those rows.
 *
 * Public API for later work packages (lessons engine, metrics view, experiments):
 * - `recordUsage` — persist one usage event (the supervisor calls it).
 * - `usageTotals(store, filter)` — totals for a workspace / pipeline / research run / task / run.
 * - `costReport(store, { workspaceId? })` — totals grouped by workspace, task, role, model, prompt version.
 * - `resolveRunScope` — research run + pipeline an agent run belongs to (for budgets).
 */
import type { SQLInputValue } from 'node:sqlite';
import type { RunEvent } from '../harness/adapter.js';
import { computeCost, defaultPricing, priceFor, type PriceTable } from '../harness/pricing.js';
import type { Store } from '../store/db.js';
import { newId } from '../store/repos.js';
import { usageRepos } from '../store/usageRepos.js';
import type { AgentUsage, ModelRef, Role } from '../types.js';

export type UsageRun = {
  agentRunId: string;
  workspaceId: string;
  taskId?: string;
  researchRunId?: string;
  pipelineId?: string;
  role: Role;
  model: ModelRef;
  promptVersion?: string;
};

const nonNeg = (v: number | undefined) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.round(v) : 0);

/**
 * Stores one `usage` event of an agent run. Token columns are disjoint: uncached input =
 * `inputTokens − cacheRead − cacheWrite` (adapters report the total input). `costUsd` is computed
 * from `pricing` when the model has a price; the CLI's own figure goes to `cliReportedCostUsd`.
 */
export function recordUsage(
  store: Store,
  run: UsageRun,
  attempt: number,
  ev: Extract<RunEvent, { t: 'usage' }>,
  pricing: PriceTable = defaultPricing(),
): AgentUsage {
  const cacheRead = nonNeg(ev.cacheReadTokens);
  const cacheWrite = nonNeg(ev.cacheWriteTokens);
  const input = Math.max(0, nonNeg(ev.inputTokens) - cacheRead - cacheWrite);
  const output = nonNeg(ev.outputTokens);
  const row: AgentUsage = {
    id: newId('use'),
    workspaceId: run.workspaceId,
    runId: run.agentRunId,
    role: run.role,
    provider: run.model.provider,
    model: run.model.model,
    attempt,
    inputTokens: input,
    outputTokens: output,
    cacheReadTokens: cacheRead,
    cacheWriteTokens: cacheWrite,
    createdAt: new Date().toISOString(),
  };
  if (run.taskId !== undefined) row.taskId = run.taskId;
  if (run.researchRunId !== undefined) row.researchRunId = run.researchRunId;
  if (run.pipelineId !== undefined) row.pipelineId = run.pipelineId;
  if (run.promptVersion) row.promptVersion = run.promptVersion;
  const price = priceFor(pricing, run.model.provider, run.model.model);
  if (price) {
    row.costUsd = computeCost(price, { input, output, cacheRead, cacheWrite });
    row.priceVersion = pricing.version;
  }
  if (typeof ev.costUsd === 'number' && Number.isFinite(ev.costUsd)) row.cliReportedCostUsd = ev.costUsd;
  usageRepos(store).agentUsage.insert(row);
  return row;
}

/** Aggregated usage. `costUsd` = Σ effective cost (computed, else CLI-reported); `unpriced` = rows with neither. */
export type UsageTotals = {
  /** Distinct agent runs. */
  runs: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** input + output + cache read + cache write. */
  totalTokens: number;
  costUsd: number;
  /** Σ CLI-reported cost (rows that have one). */
  cliReportedCostUsd: number;
  unpriced: number;
};

export type UsageFilter = { workspaceId?: string; pipelineId?: string; researchRunId?: string; taskId?: string; runId?: string };

const FILTER_COLS: Record<keyof UsageFilter, string> = {
  workspaceId: 'workspace_id',
  pipelineId: 'pipeline_id',
  researchRunId: 'research_run_id',
  taskId: 'task_id',
  runId: 'run_id',
};

const SUMS = `
  COUNT(DISTINCT run_id) AS runs,
  COALESCE(SUM(input_tokens), 0) AS inputTokens,
  COALESCE(SUM(output_tokens), 0) AS outputTokens,
  COALESCE(SUM(cache_read_tokens), 0) AS cacheReadTokens,
  COALESCE(SUM(cache_write_tokens), 0) AS cacheWriteTokens,
  COALESCE(SUM(COALESCE(cost_usd, cli_reported_cost_usd, 0)), 0) AS costUsd,
  COALESCE(SUM(cli_reported_cost_usd), 0) AS cliReportedCostUsd,
  COALESCE(SUM(CASE WHEN cost_usd IS NULL AND cli_reported_cost_usd IS NULL THEN 1 ELSE 0 END), 0) AS unpriced`;

const roundUsd = (v: number) => Math.round(v * 1e6) / 1e6;

function totalsOf(r: Record<string, unknown>): UsageTotals {
  const n = (k: string) => Number(r[k] ?? 0);
  const t = {
    runs: n('runs'),
    inputTokens: n('inputTokens'),
    outputTokens: n('outputTokens'),
    cacheReadTokens: n('cacheReadTokens'),
    cacheWriteTokens: n('cacheWriteTokens'),
    totalTokens: 0,
    costUsd: roundUsd(n('costUsd')),
    cliReportedCostUsd: roundUsd(n('cliReportedCostUsd')),
    unpriced: n('unpriced'),
  };
  t.totalTokens = t.inputTokens + t.outputTokens + t.cacheReadTokens + t.cacheWriteTokens;
  return t;
}

function where(filter: UsageFilter): { sql: string; params: SQLInputValue[] } {
  const parts: string[] = [];
  const params: SQLInputValue[] = [];
  for (const [k, col] of Object.entries(FILTER_COLS) as [keyof UsageFilter, string][]) {
    const v = filter[k];
    if (v === undefined) continue;
    parts.push(`${col} = ?`);
    params.push(v);
  }
  return { sql: parts.length ? `WHERE ${parts.join(' AND ')}` : '', params };
}

/** Usage totals over the rows matching `filter` (all rows when empty). */
export function usageTotals(store: Store, filter: UsageFilter = {}): UsageTotals {
  const w = where(filter);
  const row = store.db.prepare(`SELECT ${SUMS} FROM agent_usage ${w.sql}`).get(...w.params) as Record<string, unknown>;
  return totalsOf(row);
}

export type CostGroup = UsageTotals & { key: string; label: string };

export type CostReport = {
  pricing: { version: string; effectiveDate: string; currency: string };
  total: UsageTotals;
  byWorkspace: CostGroup[];
  byTask: CostGroup[];
  byRole: CostGroup[];
  byModel: CostGroup[];
  /** Key `<role>:<promptVersion>` (a prompt version belongs to one role). */
  byPromptVersion: CostGroup[];
};

function grouped(store: Store, keyExpr: string, filter: UsageFilter, extraWhere = ''): Array<UsageTotals & { key: string }> {
  const w = where(filter);
  const clause = [w.sql, extraWhere && (w.sql ? `AND ${extraWhere}` : `WHERE ${extraWhere}`)].filter(Boolean).join(' ');
  const rows = store.db
    .prepare(`SELECT ${keyExpr} AS key, ${SUMS} FROM agent_usage ${clause} GROUP BY key ORDER BY costUsd DESC, key`)
    .all(...w.params) as Array<Record<string, unknown>>;
  return rows.map((r) => ({ key: String(r.key), ...totalsOf(r) }));
}

/**
 * Cost per workspace, task, role, model (`provider/model`) and prompt version (`role:hash`), over
 * all workspaces or one (`workspaceId`). Groups are sorted by cost, highest first.
 */
export function costReport(store: Store, opts: { workspaceId?: string; pricing?: PriceTable } = {}): CostReport {
  const pricing = opts.pricing ?? defaultPricing();
  const filter: UsageFilter = opts.workspaceId ? { workspaceId: opts.workspaceId } : {};
  const label = (key: string) => ({ label: key });
  const workspaceName = (id: string) => store.workspaces.get(id)?.name ?? id;
  const taskLabel = (id: string) => {
    const t = store.tasks.get(id);
    return t ? `${t.type}${t.subject ? `: ${t.subject}` : ''}` : id;
  };
  return {
    pricing: { version: pricing.version, effectiveDate: pricing.effectiveDate, currency: pricing.currency },
    total: usageTotals(store, filter),
    byWorkspace: grouped(store, 'workspace_id', filter).map((g) => ({ ...g, label: workspaceName(g.key) })),
    byTask: grouped(store, 'task_id', filter, 'task_id IS NOT NULL').map((g) => ({ ...g, label: taskLabel(g.key) })),
    byRole: grouped(store, 'role', filter).map((g) => ({ ...g, ...label(g.key) })),
    byModel: grouped(store, "provider || '/' || model", filter).map((g) => ({ ...g, ...label(g.key) })),
    byPromptVersion: grouped(store, "role || ':' || COALESCE(prompt_version, '')", filter).map((g) => ({ ...g, ...label(g.key) })),
  };
}

/**
 * Research run and pipeline an agent run counts against: its task's research run, else the explicit
 * `researchRunId`, else (pipeline roles only — never the interviewer) the workspace's running
 * research run.
 */
export function resolveRunScope(
  store: Store,
  run: { workspaceId: string; taskId?: string; researchRunId?: string; role: Role },
): { researchRunId?: string; pipelineId?: string } {
  let rrId = run.taskId ? store.tasks.get(run.taskId)?.runId : undefined;
  rrId ??= run.researchRunId;
  if (!rrId && run.role !== 'interviewer') {
    rrId = store.researchRuns.list({ workspaceId: run.workspaceId, status: 'running' }).at(-1)?.id;
  }
  if (!rrId) return {};
  const rr = store.researchRuns.get(rrId);
  if (!rr || rr.workspaceId !== run.workspaceId) return {};
  return rr.pipelineId ? { researchRunId: rr.id, pipelineId: rr.pipelineId } : { researchRunId: rr.id };
}
