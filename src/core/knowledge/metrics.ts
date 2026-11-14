/**
 * Knowledge-store metrics and learning signals (design §13 "WP-B / WP-E / WP-G"; build plan KS-6).
 *
 * Public API (consumed by the API route now, by the lessons engine WP-E and the metrics view WP-G later):
 * - `knowledgeMetrics(store, filter)` — store size, freshness, retrieval (hit rate, zero-result rate,
 *   retrieved and used tokens per run grouped by role / task type / prompt version / model), the share
 *   of input tokens that was retrieved knowledge (joined with WP-B's `agent_usage`), the cost report
 *   groups with retrieval tokens next to usage, and `signals`.
 * - `knowledgeSignals(store, filter)` — the WP-E machine signals per role and prompt version, each
 *   with the distinct tasks it recurred in: `zero_result`, `unused_tokens`, `duplicate_saved`,
 *   `missing_caption`, `rejected_quote`.
 *
 * Every figure is for ONE business tree (the filter's workspace's tree, or that node alone) and never
 * mixes trees. Signals carry counts and ids only — no query or agent text.
 *
 * Definitions:
 * - a retrieval = one `retrieval_events` row of an agent run; `prompt_context` rows (briefings, reviewer
 *   context) count. Human reads (`role: 'user'`, KS-7's web routes; no agent run) are NOT agent context
 *   (design-thread ruling): they never enter hit rate, zero-result rate, tokens per run, the usage
 *   share or the signals, and are reported apart in `retrieval.user`.
 * - hit rate = retrievals with ≥ 1 used result (`retrieval_uses`) / retrievals.
 * - zero-result rate = `search` calls with no result / `search` calls.
 * - used tokens (estimate; no per-item token count is stored) = Σ tokens_returned × min(1, distinct used
 *   items / result_count); unused = retrieved − used.
 * - input tokens = `agent_usage` input + cache read + cache write (the columns are disjoint), so the
 *   retrieved share is retrieved tokens / input tokens of the same runs. Tool responses are re-read as
 *   cached input on later turns, so the share is a lower bound of retrieval's weight in the bill.
 */
import { statSync } from 'node:fs';
import { ocrArtifactStates, ocrTotals, type OcrTotals } from './ocr/totals.js';
import { join } from 'node:path';
import type { SQLInputValue } from 'node:sqlite';
import type { BifConfig } from '../config/schema.js';
import { defaultConfig } from '../config/schema.js';
import { treeWorkspaceIds } from '../evidence/synthesis.js';
import type { Store } from '../store/db.js';
import type { Finding } from '../types.js';
import { rootOf } from '../workspace/tree.js';
import { factFreshness } from './facts.js';
import { NO_TEXT_ERROR } from './factTools.js';

export type KnowledgeMetricsFilter = {
  /** Any node of the business tree. */
  workspaceId: string;
  /** `tree` (default): every node of its business tree; `node`: that workspace's rows only. */
  scope?: 'tree' | 'node';
  /** ISO times bounding retrievals, usage and signals (store size and freshness are "now"). */
  since?: string;
  until?: string;
  /** Freshness TTLs (default config otherwise). */
  config?: Pick<BifConfig, 'knowledge'>;
  /** Artifact data dir: when given, `store.fileBytes` sums the stored files (distinct paths). */
  dataDir?: string;
  now?: Date;
};

export type RetrievalGroup = {
  role: string;
  taskType: string | null;
  promptVersion: string | null;
  /** `provider/model`, or null when the run's model is unknown. */
  model: string | null;
  runs: number;
  retrievals: number;
  withUse: number;
  hitRate: number | null;
  searches: number;
  zeroResultSearches: number;
  zeroResultRate: number | null;
  retrievedTokens: number;
  usedTokens: number;
  unusedTokens: number;
  retrievedTokensPerRun: number | null;
  usedTokensPerRun: number | null;
};

export type UsageGroup = {
  key: string;
  runs: number;
  /** input + cache read + cache write (agent_usage). */
  inputTokens: number;
  totalTokens: number;
  costUsd: number;
  retrievedTokens: number;
  /** retrievedTokens / inputTokens; null without input tokens. */
  retrievedShare: number | null;
};

export const KNOWLEDGE_SIGNAL_KINDS = ['zero_result', 'unused_tokens', 'duplicate_saved', 'missing_caption', 'rejected_quote'] as const;
export type KnowledgeSignalKind = (typeof KNOWLEDGE_SIGNAL_KINDS)[number];

/** One WP-E machine signal for a role (and prompt version) in one business tree. */
export type KnowledgeSignal = {
  kind: KnowledgeSignalKind;
  rootWorkspaceId: string;
  role: string;
  promptVersion: string | null;
  /** Occurrences: zero-result searches, retrievals with no used result, outcomes, rejected saves. */
  count: number;
  /** Denominator when the signal is a rate (searches, retrievals); null otherwise. */
  total: number | null;
  rate: number | null;
  /** `unused_tokens` only: retrieved-but-unused tokens. */
  tokens?: number;
  /** Distinct tasks it occurred in (WP-E: a rule needs ≥ 3). */
  taskIds: string[];
  /** Up to 10 ids for drill-down: retrieval events, fact versions or agent runs. */
  examples: string[];
};

export type KnowledgeMetrics = {
  rootWorkspaceId: string;
  workspaceIds: string[];
  window: { since: string | null; until: string | null };
  /**
   * Two-pass OCR: model calls of pass 2 in the window (pages, tokens, cost), and the artifacts of
   * the scope by OCR state now (`pending`: waiting for the model; `skipped`: a rule forbids sending).
   */
  ocr: OcrTotals & { artifacts: { pending: number; done: number; failed: number; skipped: number } };
  store: {
    facts: { candidate: number; current: number; replaced: number; retracted: number; total: number };
    observations: number;
    artifacts: number;
    /** Images (screenshot kind or image/* mime) without a description. */
    imagesWithoutDescription: number;
    chunks: number;
    /** Σ extracted characters. */
    textChars: number;
    /** Σ stored file sizes (distinct files); null without `dataDir`. */
    fileBytes: number | null;
    entities: number;
    relations: number;
  };
  freshness: { currentFacts: number; stale: number; staleShare: number | null };
  retrieval: {
    retrievals: number;
    /** Human reads (`role: 'user'`), never mixed into the agent figures. */
    user: { reads: number; searches: number; zeroResultSearches: number; tokensReturned: number };
    runs: number;
    withUse: number;
    hitRate: number | null;
    searches: number;
    zeroResultSearches: number;
    zeroResultRate: number | null;
    retrievedTokens: number;
    usedTokens: number;
    byTool: Array<{ tool: string; retrievals: number; retrievedTokens: number; withUse: number }>;
    byGroup: RetrievalGroup[];
  };
  /** WP-B join: share of input tokens that was retrieved knowledge (runs with usage rows). */
  usage: {
    total: UsageGroup;
    byRole: UsageGroup[];
    byModel: UsageGroup[];
    /** Key `<role>:<promptVersion>`, like `costReport`. */
    byPromptVersion: UsageGroup[];
    byTask: UsageGroup[];
  };
  signals: KnowledgeSignal[];
};

const ratio = (n: number, d: number): number | null => (d > 0 ? Math.round((n / d) * 1000) / 1000 : null);
const inList = (ids: readonly string[]) => ids.map(() => '?').join(', ');

type Scope = { root: string; ids: string[]; window: { since: string | null; until: string | null } };

function scopeOf(store: Store, filter: KnowledgeMetricsFilter): Scope {
  const ids = filter.scope === 'node' ? [filter.workspaceId] : treeWorkspaceIds(store, filter.workspaceId);
  const root = store.workspaces.get(filter.workspaceId) ? rootOf(store, filter.workspaceId) : filter.workspaceId;
  return { root, ids, window: { since: filter.since ?? null, until: filter.until ?? null } };
}

/** `AND created_at >= ? AND created_at <= ?` for the window (column name given). */
function windowSql(s: Scope, col = 'created_at'): { sql: string; params: SQLInputValue[] } {
  const parts: string[] = [];
  const params: SQLInputValue[] = [];
  if (s.window.since) {
    parts.push(`${col} >= ?`);
    params.push(s.window.since);
  }
  if (s.window.until) {
    parts.push(`${col} <= ?`);
    params.push(s.window.until);
  }
  return { sql: parts.map((p) => ` AND ${p}`).join(''), params };
}

type RetrievalRow = {
  id: string;
  agentRunId: string | null;
  taskId: string | null;
  role: string;
  provider: string | null;
  model: string | null;
  promptVersion: string | null;
  tool: string;
  resultCount: number;
  tokens: number;
  used: number;
  taskType: string | null;
};

/** Retrieval rows of the scope with their distinct used items and task type. */
function retrievalRows(store: Store, s: Scope): RetrievalRow[] {
  const w = windowSql(s, 'e.created_at');
  return store.db
    .prepare(
      `SELECT e.id AS id, e.agent_run_id AS agentRunId, e.task_id AS taskId, e.role AS role, e.provider AS provider,
              e.model AS model, e.prompt_version AS promptVersion, e.tool AS tool, e.result_count AS resultCount,
              e.tokens_returned AS tokens,
              (SELECT COUNT(DISTINCT u.item_id) FROM retrieval_uses u WHERE u.retrieval_event_id = e.id) AS used,
              t.type AS taskType
       FROM retrieval_events e LEFT JOIN tasks t ON t.id = e.task_id
       WHERE e.workspace_id IN (${inList(s.ids)})${w.sql}
       ORDER BY e.rowid`,
    )
    .all(...s.ids, ...w.params) as RetrievalRow[];
}

/** An agent's retrieval (not a human read through the API). */
const isAgentRead = (r: RetrievalRow): boolean => r.agentRunId !== null && r.role !== 'user';

const usedTokensOf = (r: RetrievalRow) => (r.used > 0 && r.resultCount > 0 ? Math.round(r.tokens * Math.min(1, r.used / r.resultCount)) : 0);

function storeSize(store: Store, s: Scope, dataDir?: string): KnowledgeMetrics['store'] {
  const q = (sql: string, ...p: SQLInputValue[]) => store.db.prepare(sql).get(...p) as Record<string, number | null>;
  const ids = s.ids;
  const facts = { candidate: 0, current: 0, replaced: 0, retracted: 0, total: 0 };
  for (const r of store.db
    .prepare(`SELECT lifecycle AS l, COUNT(*) AS n FROM findings WHERE workspace_id IN (${inList(ids)}) AND status != 'superseded' GROUP BY lifecycle`)
    .all(...ids) as Array<{ l: keyof typeof facts; n: number }>) {
    if (r.l in facts) facts[r.l] = Number(r.n);
    facts.total += Number(r.n);
  }
  const art = q(
    `SELECT COUNT(*) AS n,
            SUM(CASE WHEN (kind = 'screenshot' OR mime LIKE 'image/%') AND (description IS NULL OR TRIM(description) = '') THEN 1 ELSE 0 END) AS noDesc
     FROM artifacts WHERE workspace_id IN (${inList(ids)})`,
    ...ids,
  );
  let fileBytes: number | null = null;
  if (dataDir) {
    fileBytes = 0;
    const paths = store.db.prepare(`SELECT DISTINCT path AS p FROM artifacts WHERE workspace_id IN (${inList(ids)})`).all(...ids) as Array<{ p: string }>;
    for (const { p } of paths) {
      try {
        fileBytes += statSync(join(dataDir, p)).size;
      } catch {
        // A missing (pruned) file counts 0.
      }
    }
  }
  const entityWhere = s.ids.length === 1 && s.ids[0] !== s.root ? 'workspace_id = ?' : 'root_workspace_id = ?';
  const entityParam = entityWhere.startsWith('workspace') ? s.ids[0]! : s.root;
  return {
    facts,
    observations: Number(q(`SELECT COUNT(*) AS n FROM fact_observations WHERE workspace_id IN (${inList(ids)})`, ...ids).n ?? 0),
    artifacts: Number(art.n ?? 0),
    imagesWithoutDescription: Number(art.noDesc ?? 0),
    chunks: Number(q(`SELECT COUNT(*) AS n FROM chunks WHERE workspace_id IN (${inList(ids)})`, ...ids).n ?? 0),
    textChars: Number(q(`SELECT COALESCE(SUM(char_count), 0) AS n FROM artifact_texts WHERE workspace_id IN (${inList(ids)})`, ...ids).n ?? 0),
    fileBytes,
    entities: Number(q(`SELECT COUNT(*) AS n FROM entities WHERE ${entityWhere} AND merged_into_id IS NULL`, entityParam).n ?? 0),
    relations: Number(
      q(
        entityWhere.startsWith('workspace')
          ? `SELECT COUNT(*) AS n FROM relations r JOIN entities e ON e.id = r.from_entity_id WHERE e.workspace_id = ?`
          : `SELECT COUNT(*) AS n FROM relations WHERE root_workspace_id = ?`,
        entityParam,
      ).n ?? 0,
    ),
  };
}

function freshnessOf(store: Store, s: Scope, config: Pick<BifConfig, 'knowledge'>, now: Date): KnowledgeMetrics['freshness'] {
  const current = s.ids.flatMap((workspaceId) => store.findings.list({ workspaceId, lifecycle: 'current' })).filter((f: Finding) => f.status !== 'superseded');
  const stale = current.filter((f) => factFreshness(store, f, config, now).stale).length;
  return { currentFacts: current.length, stale, staleShare: ratio(stale, current.length) };
}

function retrievalOf(rows: RetrievalRow[]): KnowledgeMetrics['retrieval'] {
  const agent = rows.filter(isAgentRead);
  const human = rows.filter((r) => r.role === 'user');
  const searches = agent.filter((r) => r.tool === 'search');
  const zero = searches.filter((r) => r.resultCount === 0).length;
  const withUse = agent.filter((r) => r.used > 0).length;
  const byTool = new Map<string, { tool: string; retrievals: number; retrievedTokens: number; withUse: number }>();
  for (const r of agent) {
    const g = byTool.get(r.tool) ?? { tool: r.tool, retrievals: 0, retrievedTokens: 0, withUse: 0 };
    g.retrievals++;
    g.retrievedTokens += r.tokens;
    if (r.used > 0) g.withUse++;
    byTool.set(r.tool, g);
  }
  const groups = new Map<string, RetrievalGroup & { runSet: Set<string> }>();
  for (const r of agent) {
    const model = r.provider && r.model ? `${r.provider}/${r.model}` : null;
    const key = JSON.stringify([r.role, r.taskType, r.promptVersion, model]);
    let g = groups.get(key);
    if (!g) {
      g = {
        role: r.role, taskType: r.taskType, promptVersion: r.promptVersion, model, runs: 0, retrievals: 0, withUse: 0, hitRate: null,
        searches: 0, zeroResultSearches: 0, zeroResultRate: null, retrievedTokens: 0, usedTokens: 0, unusedTokens: 0,
        retrievedTokensPerRun: null, usedTokensPerRun: null, runSet: new Set(),
      };
      groups.set(key, g);
    }
    g.runSet.add(r.agentRunId!);
    g.retrievals++;
    if (r.used > 0) g.withUse++;
    if (r.tool === 'search') {
      g.searches++;
      if (r.resultCount === 0) g.zeroResultSearches++;
    }
    g.retrievedTokens += r.tokens;
    g.usedTokens += usedTokensOf(r);
  }
  const byGroup = [...groups.values()]
    .map(({ runSet, ...g }) => ({
      ...g,
      runs: runSet.size,
      hitRate: ratio(g.withUse, g.retrievals),
      zeroResultRate: ratio(g.zeroResultSearches, g.searches),
      unusedTokens: g.retrievedTokens - g.usedTokens,
      retrievedTokensPerRun: ratio(g.retrievedTokens, runSet.size),
      usedTokensPerRun: ratio(g.usedTokens, runSet.size),
    }))
    .sort(
      (a, b) =>
        a.role.localeCompare(b.role) ||
        (a.taskType ?? '').localeCompare(b.taskType ?? '') ||
        (a.promptVersion ?? '').localeCompare(b.promptVersion ?? '') ||
        (a.model ?? '').localeCompare(b.model ?? ''),
    );
  return {
    retrievals: agent.length,
    user: {
      reads: human.length,
      searches: human.filter((r) => r.tool === 'search').length,
      zeroResultSearches: human.filter((r) => r.tool === 'search' && r.resultCount === 0).length,
      tokensReturned: human.reduce((n, r) => n + r.tokens, 0),
    },
    runs: new Set(agent.map((r) => r.agentRunId)).size,
    withUse,
    hitRate: ratio(withUse, agent.length),
    searches: searches.length,
    zeroResultSearches: zero,
    zeroResultRate: ratio(zero, searches.length),
    retrievedTokens: agent.reduce((n, r) => n + r.tokens, 0),
    usedTokens: agent.reduce((n, r) => n + usedTokensOf(r), 0),
    byTool: [...byTool.values()].sort((a, b) => a.tool.localeCompare(b.tool)),
    byGroup,
  };
}

/** `agent_usage` joined with retrieved tokens per run, grouped like WP-B's `costReport`. */
function usageOf(store: Store, s: Scope, rows: RetrievalRow[]): KnowledgeMetrics['usage'] {
  const w = windowSql(s);
  const usage = store.db
    .prepare(
      `SELECT run_id AS runId, role, provider || '/' || model AS model, COALESCE(prompt_version, '') AS pv, task_id AS taskId,
              SUM(input_tokens + cache_read_tokens + cache_write_tokens) AS input,
              SUM(input_tokens + output_tokens + cache_read_tokens + cache_write_tokens) AS total,
              SUM(COALESCE(cost_usd, cli_reported_cost_usd, 0)) AS cost
       FROM agent_usage WHERE workspace_id IN (${inList(s.ids)})${w.sql}
       GROUP BY run_id, role, provider, model, prompt_version, task_id`,
    )
    .all(...s.ids, ...w.params) as Array<{ runId: string; role: string; model: string; pv: string; taskId: string | null; input: number; total: number; cost: number }>;
  const retrieved = new Map<string, number>();
  for (const r of rows) if (isAgentRead(r)) retrieved.set(r.agentRunId!, (retrieved.get(r.agentRunId!) ?? 0) + r.tokens);
  const groups = (keyOf: (u: (typeof usage)[number]) => string | null) => {
    const m = new Map<string, UsageGroup & { runSet: Set<string> }>();
    for (const u of usage) {
      const key = keyOf(u);
      if (key === null) continue;
      const g = m.get(key) ?? { key, runs: 0, inputTokens: 0, totalTokens: 0, costUsd: 0, retrievedTokens: 0, retrievedShare: null, runSet: new Set<string>() };
      g.inputTokens += Number(u.input);
      g.totalTokens += Number(u.total);
      g.costUsd += Number(u.cost);
      if (!g.runSet.has(u.runId)) {
        g.runSet.add(u.runId);
        g.retrievedTokens += retrieved.get(u.runId) ?? 0;
      }
      m.set(key, g);
    }
    return [...m.values()]
      .map(({ runSet, ...g }) => ({ ...g, runs: runSet.size, costUsd: Math.round(g.costUsd * 1e6) / 1e6, retrievedShare: ratio(g.retrievedTokens, g.inputTokens) }))
      .sort((a, b) => b.inputTokens - a.inputTokens || a.key.localeCompare(b.key));
  };
  const total = groups(() => 'total')[0] ?? { key: 'total', runs: 0, inputTokens: 0, totalTokens: 0, costUsd: 0, retrievedTokens: 0, retrievedShare: null };
  return {
    total,
    byRole: groups((u) => u.role),
    byModel: groups((u) => u.model),
    byPromptVersion: groups((u) => `${u.role}:${u.pv}`),
    byTask: groups((u) => u.taskId),
  };
}

// ---------------------------------------------------------------------------
// WP-E signals

type SignalAcc = { count: number; total: number; tokens: number; tasks: Set<string>; examples: string[] };

function accumulate(
  m: Map<string, SignalAcc & { role: string; pv: string | null }>,
  role: string,
  pv: string | null,
  f: (a: SignalAcc) => void,
): void {
  const key = JSON.stringify([role, pv]);
  let a = m.get(key);
  if (!a) {
    a = { role, pv, count: 0, total: 0, tokens: 0, tasks: new Set(), examples: [] };
    m.set(key, a);
  }
  f(a);
}

const CAPTION_ERROR = /^description (is required for screenshots|must be at least)/;
const escapeRe = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** Quote rejections of `save_finding` (`factTools.ts`): no match in the text, or no text to match. */
const QUOTE_ERROR = new RegExp(`^evidence_refs: (quote not found|artifact '[^']*': ${escapeRe(NO_TEXT_ERROR)})`);

function signalsOf(store: Store, s: Scope, rows: RetrievalRow[]): KnowledgeSignal[] {
  const out: KnowledgeSignal[] = [];
  const emit = (kind: KnowledgeSignalKind, m: Map<string, SignalAcc & { role: string; pv: string | null }>, rate: boolean) => {
    for (const a of m.values()) {
      if (!a.count) continue;
      const sig: KnowledgeSignal = {
        kind, rootWorkspaceId: s.root, role: a.role, promptVersion: a.pv, count: a.count,
        total: rate ? a.total : null, rate: rate ? ratio(a.count, a.total) : null,
        taskIds: [...a.tasks].sort(), examples: a.examples.slice(0, 10),
      };
      if (kind === 'unused_tokens') sig.tokens = a.tokens;
      out.push(sig);
    }
  };
  const agent = rows.filter(isAgentRead);

  const zero = new Map<string, SignalAcc & { role: string; pv: string | null }>();
  for (const r of agent.filter((x) => x.tool === 'search')) {
    accumulate(zero, r.role, r.promptVersion, (a) => {
      a.total++;
      if (r.resultCount === 0) {
        a.count++;
        if (r.taskId) a.tasks.add(r.taskId);
        a.examples.push(r.id);
      }
    });
  }
  emit('zero_result', zero, true);

  const unused = new Map<string, SignalAcc & { role: string; pv: string | null }>();
  for (const r of agent.filter((x) => x.resultCount > 0)) {
    accumulate(unused, r.role, r.promptVersion, (a) => {
      a.total++;
      a.tokens += r.tokens - usedTokensOf(r);
      if (r.used === 0) {
        a.count++;
        if (r.taskId) a.tasks.add(r.taskId);
        a.examples.push(r.id);
      }
    });
  }
  emit('unused_tokens', unused, true);

  const dup = new Map<string, SignalAcc & { role: string; pv: string | null }>();
  const w = windowSql(s);
  for (const o of store.db
    .prepare(
      `SELECT subject_id AS id, role, prompt_version AS pv, task_id AS taskId FROM decision_outcomes
       WHERE label = 'duplicate-saved' AND workspace_id IN (${inList(s.ids)})${w.sql} ORDER BY rowid`,
    )
    .all(...s.ids, ...w.params) as Array<{ id: string; role: string | null; pv: string | null; taskId: string | null }>) {
    accumulate(dup, o.role ?? 'unknown', o.pv, (a) => {
      a.count++;
      if (o.taskId) a.tasks.add(o.taskId);
      a.examples.push(o.id);
    });
  }
  emit('duplicate_saved', dup, false);

  // Rejected saves (`tool_call` bus events persisted by WP-D; kept `telemetry.busEventRetentionDays`).
  const rejected = (tool: string, pattern: RegExp, kind: KnowledgeSignalKind) => {
    const m = new Map<string, SignalAcc & { role: string; pv: string | null }>();
    const wb = windowSql(s, 'b.created_at');
    const calls = store.db
      .prepare(
        `SELECT b.agent_run_id AS runId, json_extract(b.payload, '$.error') AS error, r.role AS role, r.prompt_version AS pv, r.task_id AS taskId
         FROM bus_events b LEFT JOIN agent_runs r ON r.id = b.agent_run_id
         WHERE b.type = 'tool_call' AND b.workspace_id IN (${inList(s.ids)})
           AND json_extract(b.payload, '$.tool') = ? AND json_extract(b.payload, '$.ok') = 0${wb.sql}
         ORDER BY b.seq`,
      )
      .all(...s.ids, tool, ...wb.params) as Array<{ runId: string | null; error: string | null; role: string | null; pv: string | null; taskId: string | null }>;
    for (const c of calls) {
      if (!c.error || !pattern.test(c.error)) continue;
      accumulate(m, c.role ?? 'unknown', c.pv, (a) => {
        a.count++;
        if (c.taskId) a.tasks.add(c.taskId);
        if (c.runId && !a.examples.includes(c.runId)) a.examples.push(c.runId);
      });
    }
    emit(kind, m, false);
  };
  rejected('save_artifact', CAPTION_ERROR, 'missing_caption');
  rejected('save_finding', QUOTE_ERROR, 'rejected_quote');
  return out;
}

/** The WP-E machine signals of one business tree (see module doc). */
export function knowledgeSignals(store: Store, filter: KnowledgeMetricsFilter): KnowledgeSignal[] {
  const s = scopeOf(store, filter);
  return signalsOf(store, s, retrievalRows(store, s));
}

/** Knowledge-store metrics of one business tree or node (see module doc). */
export function knowledgeMetrics(store: Store, filter: KnowledgeMetricsFilter): KnowledgeMetrics {
  const s = scopeOf(store, filter);
  const rows = retrievalRows(store, s);
  return {
    rootWorkspaceId: s.root,
    workspaceIds: s.ids,
    window: s.window,
    store: storeSize(store, s, filter.dataDir),
    freshness: freshnessOf(store, s, filter.config ?? defaultConfig, filter.now ?? new Date()),
    retrieval: retrievalOf(rows),
    usage: usageOf(store, s, rows),
    signals: signalsOf(store, s, rows),
    ocr: { ...ocrTotals(store, { workspaceIds: s.ids, since: s.window.since, until: s.window.until }), artifacts: ocrArtifactStates(store, s.ids) },
  };
}
