/**
 * Learning loop WP-F (migration 20): tags that set experiment and audit runs apart.
 *
 * Columns: `agent_runs.experiment_id / arm / audit_id / lessons_off`, `decisions.experiment_id / arm /
 * audit_id`, `tasks.experiment_id / arm`. Runs of an experiment task get their tags (and
 * `lessons_off = 1`) by trigger at insert; decisions copy their run's tags by trigger at insert. An
 * audit run is tagged by `tagRun` from the run's `beforeStart` hook, i.e. before the agent starts.
 *
 * Public API:
 * - WP-E (lessons engine): `lessonsOff(store, { taskId?, agentRunId? })` — true for experiment tasks /
 *   runs: leave lessons out of their prompts (the run-level flag is `agent_runs.lessons_off`).
 * - WP-G (metrics view): `NORMAL_RUN_SQL(alias)` / `NORMAL_DECISION_SQL(alias)` / `NORMAL_TASK_SQL(alias)`
 *   — SQL predicates for "not an experiment or audit row"; `taggedRunIds(store, workspaceId?)`,
 *   `experimentTaskIds(store, workspaceId?)`, `isTaggedRun`, `isTaggedDecision`, `runTags`.
 * - Review loop / consumers: `isAuditRun`, `isExperimentTask`, `taskExperiment`, `experimentWorkerPrompt`.
 */
import type { Store } from '../store/db.js';
import { usageRepos } from '../store/usageRepos.js';

export type RunTags = { experimentId?: string; arm?: string; auditId?: string; lessonsOff: boolean };

/** SQL predicate: the `agent_runs` row (alias) is neither an experiment nor an audit run. */
export const NORMAL_RUN_SQL = (alias = 'agent_runs') => `(${alias}.experiment_id IS NULL AND ${alias}.audit_id IS NULL)`;
/** SQL predicate: the `decisions` row (alias) was not made by an experiment or audit run. */
export const NORMAL_DECISION_SQL = (alias = 'decisions') => `(${alias}.experiment_id IS NULL AND ${alias}.audit_id IS NULL)`;
/** SQL predicate: the `tasks` row (alias) is not an experiment arm task. */
export const NORMAL_TASK_SQL = (alias = 'tasks') => `(${alias}.experiment_id IS NULL)`;

/**
 * Tags an existing agent run (audit runs, council member runs; called before the agent starts). A council
 * member run (`councilRoundId`, `councilMember`; migration 29) stays a normal run for metrics, usage and
 * cost: see `council/store.ts` for what the tag means.
 */
export function tagRun(
  store: Pick<Store, 'db'>,
  agentRunId: string,
  tags: { auditId?: string; lessonsOff?: boolean; councilRoundId?: string; councilMember?: string },
): void {
  const sets: string[] = [];
  const params: Array<string | number> = [];
  if (tags.auditId !== undefined) {
    sets.push('audit_id = ?');
    params.push(tags.auditId);
  }
  if (tags.councilRoundId !== undefined) {
    sets.push('council_round_id = ?');
    params.push(tags.councilRoundId);
  }
  if (tags.councilMember !== undefined) {
    sets.push('council_member = ?');
    params.push(tags.councilMember);
  }
  if (tags.lessonsOff !== undefined) {
    sets.push('lessons_off = ?');
    params.push(tags.lessonsOff ? 1 : 0);
  }
  if (!sets.length) return;
  store.db.prepare(`UPDATE agent_runs SET ${sets.join(', ')} WHERE id = ?`).run(...params, agentRunId);
}

/** Tags of a run, or undefined for an unknown run. */
export function runTags(store: Pick<Store, 'db'>, agentRunId: string): RunTags | undefined {
  const r = store.db
    .prepare('SELECT experiment_id AS e, arm AS a, audit_id AS u, lessons_off AS l FROM agent_runs WHERE id = ?')
    .get(agentRunId) as { e: string | null; a: string | null; u: string | null; l: number } | undefined;
  if (!r) return undefined;
  return {
    ...(r.e !== null ? { experimentId: r.e } : {}),
    ...(r.a !== null ? { arm: r.a } : {}),
    ...(r.u !== null ? { auditId: r.u } : {}),
    lessonsOff: Number(r.l) === 1,
  };
}

export function isAuditRun(store: Pick<Store, 'db'>, agentRunId: string): boolean {
  return runTags(store, agentRunId)?.auditId !== undefined;
}

export function isTaggedRun(store: Pick<Store, 'db'>, agentRunId: string): boolean {
  const t = runTags(store, agentRunId);
  return !!t && (t.experimentId !== undefined || t.auditId !== undefined);
}

export function isTaggedDecision(store: Pick<Store, 'db'>, decisionId: string): boolean {
  const r = store.db.prepare('SELECT experiment_id AS e, audit_id AS u FROM decisions WHERE id = ?').get(decisionId) as
    | { e: string | null; u: string | null }
    | undefined;
  return !!r && (r.e !== null || r.u !== null);
}

/** Tags of a decision (for export lines), empty for a normal decision. */
export function decisionTags(store: Pick<Store, 'db'>, decisionId: string): { experimentId?: string; arm?: string; auditId?: string } {
  const r = store.db.prepare('SELECT experiment_id AS e, arm AS a, audit_id AS u FROM decisions WHERE id = ?').get(decisionId) as
    | { e: string | null; a: string | null; u: string | null }
    | undefined;
  if (!r) return {};
  return { ...(r.e !== null ? { experimentId: r.e } : {}), ...(r.a !== null ? { arm: r.a } : {}), ...(r.u !== null ? { auditId: r.u } : {}) };
}

/** Ids of experiment and audit runs (of one workspace, or all). */
export function taggedRunIds(store: Pick<Store, 'db'>, workspaceId?: string): Set<string> {
  const rows = store.db
    .prepare(`SELECT id FROM agent_runs WHERE NOT ${NORMAL_RUN_SQL()}${workspaceId !== undefined ? ' AND workspace_id = ?' : ''}`)
    .all(...(workspaceId !== undefined ? [workspaceId] : [])) as Array<{ id: string }>;
  return new Set(rows.map((r) => r.id));
}

/** Ids of experiment arm tasks (of one workspace, or all). */
export function experimentTaskIds(store: Pick<Store, 'db'>, workspaceId?: string): Set<string> {
  const rows = store.db
    .prepare(`SELECT id FROM tasks WHERE experiment_id IS NOT NULL${workspaceId !== undefined ? ' AND workspace_id = ?' : ''}`)
    .all(...(workspaceId !== undefined ? [workspaceId] : [])) as Array<{ id: string }>;
  return new Set(rows.map((r) => r.id));
}

/** The experiment and arm of an experiment arm task. */
export function taskExperiment(store: Pick<Store, 'db'>, taskId: string): { experimentId: string; arm: string } | undefined {
  const r = store.db.prepare('SELECT experiment_id AS e, arm AS a FROM tasks WHERE id = ?').get(taskId) as
    | { e: string | null; a: string | null }
    | undefined;
  return r && r.e !== null ? { experimentId: r.e, arm: r.a ?? '' } : undefined;
}

export function isExperimentTask(store: Pick<Store, 'db'>, taskId: string): boolean {
  return taskExperiment(store, taskId) !== undefined;
}

/**
 * WP-E: whether lessons must be left out of a prompt. Read from the store by prompt assembly, so it
 * holds after a restart or resume. True for an experiment task (known before its runs exist, so
 * prompt assembly can ask by task), for a run flagged `lessons_off`, and (wave-2 integration) for a
 * task that already has a non-audit run flagged `lessons_off` (e.g. one started inside
 * `withLessons('off', …)`): a task keeps the lessons mode it started with. Audit runs are left out
 * of the task rule: an auditor runs without lessons (ruling R5) without changing the audited task.
 */
export function lessonsOff(store: Pick<Store, 'db'>, input: { taskId?: string; agentRunId?: string }): boolean {
  if (input.taskId !== undefined) {
    if (isExperimentTask(store, input.taskId)) return true;
    const flagged = store.db
      .prepare('SELECT 1 FROM agent_runs WHERE task_id = ? AND lessons_off = 1 AND audit_id IS NULL LIMIT 1')
      .get(input.taskId);
    if (flagged) return true;
  }
  return input.agentRunId !== undefined && runTags(store, input.agentRunId)?.lessonsOff === true;
}

/**
 * The worker system prompt an experiment arm task must use (its arm's stored prompt version), or
 * undefined (not an experiment task, or the arm keeps the current prompt).
 */
export function experimentWorkerPrompt(store: Store, taskId: string): string | undefined {
  const tag = taskExperiment(store, taskId);
  if (!tag) return undefined;
  const row = store.db.prepare('SELECT arms FROM experiments WHERE id = ?').get(tag.experimentId) as { arms: string } | undefined;
  if (!row) return undefined;
  const arms = JSON.parse(row.arms) as Array<{ arm: string; promptVersion?: string }>;
  const hash = arms.find((a) => a.arm === tag.arm)?.promptVersion;
  return hash ? usageRepos(store).promptVersions.get(hash)?.text : undefined;
}
