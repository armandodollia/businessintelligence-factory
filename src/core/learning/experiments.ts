/**
 * Learning loop WP-F (migration 20): A/B experiments.
 *
 * An experiment re-runs one finished task as arm A and arm B (each `repeats` times). An arm sets the
 * worker's model and / or its system prompt (a stored prompt version of the task's role). Each arm
 * task is a clone of the source task, tagged `experiment_id` / `arm`, in a research run created `done`
 * (no drain loop, resume or scheduler ever runs it). It goes through the normal review loop
 * (`runTaskWithReview`: same pass threshold, rounds, malformed-review rule and minimal reviewer
 * context). Because the task is tagged:
 * - its runs are tagged with `lessons_off = 1` (WP-E reads `lessonsOff`), its decisions inherit the tags;
 * - its outputs are retired at the end (`retireExperimentOutputs`: superseded, observations not applied),
 *   it writes no decision outcomes and never escalates to the user;
 * - normal metrics (prompt-version metrics, outcomes) leave it out; WP-G filters with `NORMAL_*_SQL`.
 * Its runs follow the usual upload-exposure, export and budget rules (they are ordinary runs of the
 * workspace).
 *
 * Public API: `startExperiment`, `runExperiment`, `compareExperiment`, `listExperiments`,
 * `getExperiment`, `recoverExperiments` (boot).
 */
import type { ModelRef } from '../config/schema.js';
import { getRunOutputs } from '../harness/tools/handlers.js';
import { usageTotals, type UsageTotals } from '../metrics/usage.js';
import { getPromptText, recordPromptVersion } from '../prompts/store.js';
import type { ResearchDeps } from '../research/deps.js';
import { roleForTask, runTaskWithReview } from '../research/reviewLoop.js';
import { taskOutputs } from '../research/outputs.js';
import type { Store } from '../store/db.js';
import { newId, Repo, type TableSpec } from '../store/repos.js';
import type { Task } from '../types.js';
import { rootOf } from '../workspace/tree.js';
import { isExperimentTask } from './runTags.js';
import { EXPERIMENT_ARMS, type ArmResult, type Experiment, type ExperimentArmSpec, type ExperimentComparison } from './wpfTypes.js';

export type { ArmResult, Experiment, ExperimentComparison } from './wpfTypes.js';

/** Most repeats per arm. */
export const MAX_REPEATS = 5;

export class ExperimentError extends Error {
  constructor(
    readonly code: 'not_found' | 'invalid',
    message: string,
  ) {
    super(message);
    this.name = 'ExperimentError';
  }
}

const spec = {
  table: 'experiments',
  key: 'id',
  fields: {
    id: 'text', workspaceId: 'text', rootWorkspaceId: 'text', sourceTaskId: 'text', researchRunId: 'text', name: 'text', arms: 'json',
    repeats: 'int', status: 'text', failureReason: 'text', actor: 'text', createdAt: 'text', endedAt: 'text',
  },
} satisfies TableSpec<Experiment>;

const cache = new WeakMap<object, Repo<Experiment, 'id'>>();
function repo(store: Pick<Store, 'db'>): Repo<Experiment, 'id'> {
  let r = cache.get(store.db);
  if (!r) {
    r = new Repo<Experiment, 'id'>(store.db, spec);
    cache.set(store.db, r);
  }
  return r;
}

/** One arm as asked for: model (default: the source task's), prompt version or prompt text (default: current prompt). */
export type ArmInput = { model?: ModelRef; promptVersion?: string; promptText?: string };

export type ExperimentInput = {
  taskId: string;
  /** Arm A, arm B. */
  arms: [ArmInput, ArmInput];
  /** Tasks per arm (1–5, default 1). */
  repeats?: number;
  name?: string;
  /** The configured user (`config.user.id`). */
  actor?: string;
};

const FINISHED = new Set<Task['status']>(['verified', 'unverified', 'failed']);

/**
 * Creates the experiment (validated), its research run and its arm tasks, and starts every arm task
 * in the background (`done` resolves with the final experiment). Throws `ExperimentError` on bad input.
 */
export function startExperiment(deps: ResearchDeps, input: ExperimentInput): { experiment: Experiment; done: Promise<Experiment> } {
  const { store, config } = deps;
  const source = store.tasks.get(input.taskId);
  if (!source) throw new ExperimentError('not_found', `task '${input.taskId}' not found`);
  if (!FINISHED.has(source.status)) throw new ExperimentError('invalid', `task '${source.id}' has not finished (status ${source.status})`);
  if (isExperimentTask(store, source.id)) throw new ExperimentError('invalid', `task '${source.id}' is itself an experiment arm task`);
  if (!store.workspaces.get(source.workspaceId)) throw new ExperimentError('not_found', `workspace '${source.workspaceId}' not found`);
  const repeats = input.repeats ?? 1;
  if (!Number.isInteger(repeats) || repeats < 1 || repeats > MAX_REPEATS) throw new ExperimentError('invalid', `repeats must be 1–${MAX_REPEATS}`);
  if (input.arms.length !== 2) throw new ExperimentError('invalid', 'an experiment has exactly two arms (A and B)');
  const role = roleForTask(source);

  const arms = input.arms.map((a, i): Omit<ExperimentArmSpec, 'taskIds'> => {
    const arm = EXPERIMENT_ARMS[i]!;
    const model = a.model ?? source.model;
    const p = config.providers[model.provider];
    if (!p?.enabled) throw new ExperimentError('invalid', `arm ${arm}: provider '${model.provider}' is not enabled`);
    if (!p.models.includes(model.model)) throw new ExperimentError('invalid', `arm ${arm}: model '${model.model}' is not in providers.${model.provider}.models`);
    let promptVersion = a.promptVersion;
    if (a.promptText !== undefined) {
      if (!a.promptText.trim()) throw new ExperimentError('invalid', `arm ${arm}: promptText must not be empty`);
      promptVersion = recordPromptVersion(store, role, a.promptText);
    } else if (promptVersion !== undefined) {
      const stored = getPromptText(store, promptVersion);
      if (!stored) throw new ExperimentError('invalid', `arm ${arm}: unknown prompt version '${promptVersion}'`);
      if (stored.role !== role) throw new ExperimentError('invalid', `arm ${arm}: prompt version '${promptVersion}' is a ${stored.role} prompt, not ${role}`);
    }
    return { arm, model, ...(promptVersion ? { promptVersion } : {}) };
  });

  const now = new Date().toISOString();
  const id = newId('exp');
  const experiment = store.transaction(() => {
    // Created `done`: it only holds the arm tasks, so no drain loop, resume or scheduler runs them.
    const run = store.researchRuns.insert({ id: newId('rrun'), workspaceId: source.workspaceId, phase: source.phase, status: 'done', startedAt: now, endedAt: now });
    const withTasks = arms.map((a): ExperimentArmSpec => {
      const taskIds: string[] = [];
      for (let i = 0; i < repeats; i++) {
        const task: Task = {
          id: newId('tsk'), workspaceId: source.workspaceId, runId: run.id, phase: source.phase, type: source.type, brief: source.brief,
          model: a.model, needsBrowser: source.needsBrowser, acceptanceCriteria: [...source.acceptanceCriteria], status: 'queued',
          round: 1, step: 'work', createdAt: now,
        };
        if (source.subject !== undefined) task.subject = source.subject;
        store.tasks.insert(task);
        store.db.prepare('UPDATE tasks SET experiment_id = ?, arm = ? WHERE id = ?').run(id, a.arm, task.id);
        taskIds.push(task.id);
      }
      return { ...a, taskIds };
    });
    const row: Experiment = {
      id, workspaceId: source.workspaceId, rootWorkspaceId: rootOf(store, source.workspaceId), sourceTaskId: source.id, researchRunId: run.id,
      arms: withTasks, repeats, status: 'running', actor: input.actor ?? 'local-user', createdAt: now,
    };
    if (input.name?.trim()) row.name = input.name.trim();
    return repo(store).insert(row);
  });

  const tasks = experiment.arms.flatMap((a) => a.taskIds).map((tid) => store.tasks.get(tid)!);
  const finish = (patch: Partial<Experiment>) => {
    // Only a running experiment is closed (one marked `interrupted` at boot stays so).
    store.db
      .prepare(`UPDATE experiments SET status = ?, failure_reason = ?, ended_at = ? WHERE id = ? AND status = 'running'`)
      .run(patch.status!, patch.failureReason ?? null, new Date().toISOString(), id);
    return getExperiment(store, id)!;
  };
  const done = Promise.all(tasks.map((t) => runTaskWithReview(t, deps))).then(
    () => finish({ status: 'done' }),
    (err: unknown) => finish({ status: 'failed', failureReason: (err as Error).message }),
  );
  return { experiment, done };
}

/** `startExperiment` and wait for both arms. */
export async function runExperiment(deps: ResearchDeps, input: ExperimentInput): Promise<Experiment> {
  return startExperiment(deps, input).done;
}

export function getExperiment(store: Store, id: string): Experiment | undefined {
  return repo(store).get(id);
}

/** Experiments of a workspace, newest first. */
export function listExperiments(store: Store, workspaceId: string): Experiment[] {
  return repo(store)
    .list({ workspaceId })
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** Boot: experiments still `running` (the server stopped under them) become `interrupted`. Returns their ids. */
export function recoverExperiments(store: Store): string[] {
  const ids = repo(store)
    .list({ status: 'running' })
    .map((e) => e.id);
  const now = new Date().toISOString();
  for (const id of ids) repo(store).update(id, { status: 'interrupted', endedAt: now });
  return ids;
}

// ---------------------------------------------------------------------------
// comparison

const round3 = (v: number) => Math.round(v * 1000) / 1000;
const mean = (xs: number[]) => (xs.length ? round3(xs.reduce((s, x) => s + x, 0) / xs.length) : null);
const modelKey = (m: ModelRef) => `${m.provider}/${m.model}`;

function addTotals(a: UsageTotals, b: UsageTotals): UsageTotals {
  const out = { ...a };
  for (const k of Object.keys(b) as Array<keyof UsageTotals>) out[k] = a[k] + b[k];
  out.costUsd = Math.round(out.costUsd * 1e6) / 1e6;
  out.cliReportedCostUsd = Math.round(out.cliReportedCostUsd * 1e6) / 1e6;
  return out;
}

/** Review scores of a task in order: valid `submit_review`s of finished reviewer runs, and the loop's synthetic 0s. */
function reviewScores(store: Store, task: Task): number[] {
  const out: number[] = [];
  for (const run of store.agentRuns.list({ taskId: task.id, role: 'reviewer' })) {
    const review = getRunOutputs(store, run.id).review;
    if (run.status === 'done' && review && Number.isFinite(review.score) && review.score >= 0 && review.score <= 10) out.push(review.score);
    else if (store.decisions.list({ agentRunId: run.id }).some((d) => (d.payload as { event?: unknown } | null)?.event === 'synthetic_review')) out.push(0);
  }
  return out;
}

function armResult(store: Store, exp: Experiment, arm: ExperimentArmSpec): ArmResult {
  const tasks = arm.taskIds.map((id) => store.tasks.get(id)).filter((t): t is Task => t !== undefined);
  const runs = tasks.flatMap((t) => store.agentRuns.list({ taskId: t.id }));
  const runIds = new Set(runs.map((r) => r.id));
  const finished = tasks.filter((t) => FINISHED.has(t.status));
  const verified = finished.filter((t) => t.status === 'verified');
  const scoresByTask = new Map(tasks.map((t) => [t.id, reviewScores(store, t)]));
  const scores = tasks.flatMap((t) => scoresByTask.get(t.id) ?? []);

  // User ratings of the arm's decisions, its outputs, or values its runs produced.
  const targets = new Set<string>();
  for (const r of runs) for (const d of store.decisions.list({ agentRunId: r.id })) targets.add(d.id);
  for (const t of tasks) {
    const o = taskOutputs(store, t);
    for (const x of [...o.findings, ...o.recommendations, ...o.personas, ...o.competitors, ...o.hypotheses]) targets.add(x.id);
  }
  const ratings = store.ratings
    .list({ workspaceId: exp.workspaceId })
    .filter((r) => (r.agentRunId !== undefined && runIds.has(r.agentRunId)) || targets.has(r.targetId));
  const agree = ratings.filter((r) => r.verdict === 'agree').length;

  const zero = usageTotals(store, { taskId: '\u0000none' });
  const cost = tasks.reduce((acc, t) => addTotals(acc, usageTotals(store, { taskId: t.id })), zero);

  const distinct = <T>(xs: T[], key: (x: T) => string) => [...new Map(xs.map((x) => [key(x), x])).values()];
  return {
    arm: arm.arm,
    model: arm.model,
    ...(arm.promptVersion ? { promptVersion: arm.promptVersion } : {}),
    workerPromptVersions: distinct(
      runs.filter((r) => r.role !== 'reviewer' && r.promptVersion).map((r) => r.promptVersion!),
      (v) => v,
    ),
    reviewerModels: distinct(runs.filter((r) => r.role === 'reviewer').map((r) => r.model), modelKey),
    tasks: tasks.map((t) => {
      const s = scoresByTask.get(t.id) ?? [];
      return { taskId: t.id, status: t.status, round: t.round, finalScore: s.length ? s[s.length - 1]! : null, ...(t.failureReason ? { failureReason: t.failureReason } : {}) };
    }),
    finished: finished.length,
    verified: verified.length,
    passRate: finished.length ? round3(verified.length / finished.length) : null,
    firstRoundPassRate: finished.length ? round3(verified.filter((t) => t.round === 1).length / finished.length) : null,
    meanRounds: mean(finished.filter((t) => t.status !== 'failed').map((t) => t.round)),
    reviewScores: scores,
    meanReviewScore: mean(scores),
    userRatings: { count: ratings.length, agree, agreeRate: ratings.length ? round3(agree / ratings.length) : null },
    cost,
    costPerTask: finished.length ? Math.round((cost.costUsd / finished.length) * 1e6) / 1e6 : null,
  };
}

/** Per-arm comparison: pass rate, rounds, review scores, user ratings and cost (`agent_usage`). */
export function compareExperiment(store: Store, id: string): ExperimentComparison | undefined {
  const experiment = getExperiment(store, id);
  if (!experiment) return undefined;
  return { experiment, arms: experiment.arms.map((a) => armResult(store, experiment, a)) };
}
