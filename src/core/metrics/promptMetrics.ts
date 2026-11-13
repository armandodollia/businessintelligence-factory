/**
 * Per-prompt-version metrics (learning loop WP-B): calibration agreement and review pass rates
 * grouped by the prompt version of the agent run that produced the rated value / did the task, so
 * a prompt change (calibration patch, lesson rule) can be judged by its trend.
 *
 * Public API (WP-E lessons engine, WP-F experiments, WP-G metrics view):
 * - `promptVersionMetrics(store, workspaceId, { role? })` — one row per (role, prompt version),
 *   ordered by role, then first use (the per-version trend).
 * - `originRunOfRating(store, workspaceId, rating)` — the agent run that produced a rated value.
 */
import type { Store } from '../store/db.js';
import type { AgentRun, Rating, Role } from '../types.js';
import { criterionDef, normalizedDelta } from '../scoring/criteria.js';

export type PromptVersionMetrics = {
  role: Role;
  promptVersion: string;
  /** First / last start of a run with this version (trend axis). */
  firstSeen: string;
  lastSeen: string;
  runs: number;
  failedRuns: number;
  /** Ratings of values produced by runs of this version. */
  ratings: number;
  /** Share of those ratings that agreed; null without ratings. */
  agreeRate: number | null;
  /** Mean normalized user − agent delta (agree = 0); null without comparable ratings. */
  meanDelta: number | null;
  /** Finished tasks (verified / unverified / failed) whose first worker run used this version. */
  tasks: number;
  verified: number;
  unverified: number;
  failed: number;
  /** verified / tasks; null without tasks. */
  passRate: number | null;
  /** Verified in review round 1 / tasks; null without tasks. */
  firstRoundPassRate: number | null;
  /** Mean review rounds of verified + unverified tasks; null without such tasks. */
  meanRounds: number | null;
  costUsd: number;
  totalTokens: number;
};

const SUBJECT_KEYS = ['findingId', 'symptomId', 'recommendationId', 'personaId', 'competitorId', 'hypothesisId'] as const;
const FINAL = new Set(['verified', 'unverified', 'failed']);
const round3 = (v: number) => Math.round(v * 1000) / 1000;

/** Item id → agent run of the first Decision that saved/judged it; persona feedback by `targetId`. */
function originIndex(store: Store, workspaceId: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const d of store.decisions.list({ workspaceId })) {
    const p = d.payload as Record<string, unknown> | null;
    if (!p || typeof p !== 'object') continue;
    if (d.kind === 'persona_feedback' && typeof p.targetId === 'string') {
      out.set(`pf:${p.targetId}`, d.agentRunId); // latest feedback wins
      continue;
    }
    for (const k of SUBJECT_KEYS) {
      const v = p[k];
      if (typeof v === 'string' && !out.has(v)) out.set(v, d.agentRunId);
    }
  }
  return out;
}

/**
 * Agent run that produced the value a rating judges: the rating's own `agentRunId` when recorded
 * (WP-A provenance), else the run of the rated Decision, else the run that first saved the item.
 */
export function originRunOfRating(store: Store, workspaceId: string, r: Rating, index?: Map<string, string>): AgentRun | undefined {
  const own = (r as Rating & { agentRunId?: unknown }).agentRunId;
  let runId: string | undefined = typeof own === 'string' && own ? own : undefined;
  if (!runId && r.targetType === 'decision') runId = store.decisions.get(r.targetId)?.agentRunId;
  if (!runId) {
    const idx = index ?? originIndex(store, workspaceId);
    runId = r.targetType === 'persona_feedback' ? idx.get(`pf:${r.targetId}`) : idx.get(r.targetId);
  }
  const run = runId ? store.agentRuns.get(runId) : undefined;
  return run && run.workspaceId === workspaceId ? run : undefined;
}

type Acc = {
  role: Role;
  version: string;
  first: string;
  last: string;
  runs: number;
  failedRuns: number;
  ratings: number;
  agrees: number;
  deltas: number[];
  tasks: number;
  verified: number;
  unverified: number;
  failed: number;
  firstRound: number;
  rounds: number[];
};

/** Metrics per (role, prompt version) of one workspace; see `PromptVersionMetrics`. */
export function promptVersionMetrics(store: Store, workspaceId: string, opts: { role?: Role } = {}): PromptVersionMetrics[] {
  const groups = new Map<string, Acc>();
  const runs = store.agentRuns.list({ workspaceId }).filter((r) => r.promptVersion && (!opts.role || r.role === opts.role));
  const accOf = (run: AgentRun): Acc => {
    const key = `${run.role}\u0000${run.promptVersion}`;
    let a = groups.get(key);
    if (!a) {
      a = {
        role: run.role, version: run.promptVersion!, first: run.startedAt, last: run.startedAt, runs: 0, failedRuns: 0, ratings: 0,
        agrees: 0, deltas: [], tasks: 0, verified: 0, unverified: 0, failed: 0, firstRound: 0, rounds: [],
      };
      groups.set(key, a);
    }
    return a;
  };
  for (const run of runs) {
    const a = accOf(run);
    a.runs++;
    if (run.status === 'failed') a.failedRuns++;
    if (run.startedAt < a.first) a.first = run.startedAt;
    if (run.startedAt > a.last) a.last = run.startedAt;
  }

  // Calibration agreement by the producing run's version.
  const index = originIndex(store, workspaceId);
  for (const r of store.ratings.list({ workspaceId })) {
    if (r.targetType === 'recommendation' && r.criterion === 'priority') continue; // computed from weights, not judged
    const run = originRunOfRating(store, workspaceId, r, index);
    if (!run?.promptVersion || (opts.role && run.role !== opts.role)) continue;
    const a = accOf(run);
    a.ratings++;
    if (r.verdict === 'agree') a.agrees++;
    const def = criterionDef(r.targetType, r.criterion);
    const d = def ? normalizedDelta(def, r.agentValue, r.verdict === 'agree' ? r.agentValue : r.userValue) : undefined;
    if (d !== undefined) a.deltas.push(d);
  }

  // Review outcomes by the version of the task's first worker run.
  const firstWorker = new Map<string, AgentRun>();
  for (const run of store.agentRuns.list({ workspaceId })) {
    if (!run.taskId || run.role === 'reviewer' || !run.promptVersion || firstWorker.has(run.taskId)) continue;
    firstWorker.set(run.taskId, run);
  }
  for (const t of store.tasks.list({ workspaceId })) {
    if (!FINAL.has(t.status)) continue;
    const run = firstWorker.get(t.id);
    if (!run || (opts.role && run.role !== opts.role)) continue;
    const a = accOf(run);
    a.tasks++;
    if (t.status === 'verified') {
      a.verified++;
      if (t.round === 1) a.firstRound++;
    } else if (t.status === 'unverified') a.unverified++;
    else a.failed++;
    if (t.status !== 'failed') a.rounds.push(t.round);
  }

  const out = [...groups.values()].map((a): PromptVersionMetrics => {
    const cost = store.db
      .prepare(
        `SELECT COALESCE(SUM(COALESCE(cost_usd, cli_reported_cost_usd, 0)), 0) AS c,
                COALESCE(SUM(input_tokens + output_tokens + cache_read_tokens + cache_write_tokens), 0) AS t
         FROM agent_usage WHERE workspace_id = ? AND role = ? AND prompt_version = ?`,
      )
      .get(workspaceId, a.role, a.version) as { c: number; t: number };
    const mean = (xs: number[]) => (xs.length ? round3(xs.reduce((s, x) => s + x, 0) / xs.length) : null);
    return {
      role: a.role,
      promptVersion: a.version,
      firstSeen: a.first,
      lastSeen: a.last,
      runs: a.runs,
      failedRuns: a.failedRuns,
      ratings: a.ratings,
      agreeRate: a.ratings ? round3(a.agrees / a.ratings) : null,
      meanDelta: mean(a.deltas),
      tasks: a.tasks,
      verified: a.verified,
      unverified: a.unverified,
      failed: a.failed,
      passRate: a.tasks ? round3(a.verified / a.tasks) : null,
      firstRoundPassRate: a.tasks ? round3(a.firstRound / a.tasks) : null,
      meanRounds: mean(a.rounds),
      costUsd: Math.round(Number(cost.c) * 1e6) / 1e6,
      totalTokens: Number(cost.t),
    };
  });
  out.sort((x, y) => x.role.localeCompare(y.role) || x.firstSeen.localeCompare(y.firstSeen) || x.promptVersion.localeCompare(y.promptVersion));
  return out;
}
