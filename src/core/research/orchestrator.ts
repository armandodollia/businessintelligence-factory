import type { BifConfig } from '../config/schema.js';
import { PROVIDER_IDS } from '../config/schema.js';
import { AbortError } from '../events.js';
import { isOurProcessGroup } from '../harness/procinfo.js';
import type { ExtraToolHandler } from '../harness/tools/handlers.js';
import { findReplay } from '../harness/tools/idempotency.js';
import type { ToolInput } from '../harness/tools/registry.js';
import { uploadPromptLines } from '../internal/uploads.js';
import { loadPrompt, promptVersion } from '../prompts/index.js';
import { calibrationScope } from '../scoring/calibration.js';
import type { Store } from '../store/db.js';
import { newId } from '../store/repos.js';
import type { Decision, ModelRef, Phase, Pipeline, ResearchRun, Task, TaskType, Workspace } from '../types.js';
import { recordWhatChanged } from '../scheduler/whatChanged.js';
import { treeContext, treeLines } from '../workspace/businessMap.js';
import { CronExpressionParser } from 'cron-parser'; // KS-5
import { orchestratorBriefing, promptReadsOf } from '../knowledge/briefing.js'; // KS-5
import type { PromptRead } from '../knowledge/promptReads.js'; // KS-5
import { servedLine } from '../knowledge/texts.js'; // KS-5
import { factScope } from '../knowledge/facts.js'; // KS-5
import { previousRun } from '../scheduler/whatChanged.js'; // KS-5
import type { RetrievalResultRef } from '../types.js'; // KS-5
import { estimateTokens } from '../knowledge/budget.js'; // KS-5
import { anyUploadDerived } from '../knowledge/readCommon.js'; // KS-5
import { recordHarnessDecision, runAgent, throwIfAborted, type ResearchDeps } from './deps.js';
import { orderPhases, PHASE_TASK_TYPES, phaseGoal, ALL_PHASES, RUNNER_PHASES } from './phases.js';
import { PipelineBusyError, tryLockPipeline } from './lock.js';
import { failureReason, runTaskWithReview } from './reviewLoop.js';
import { applyTaskStatus } from './outputs.js';
import { recordTaskEndOutcomes } from '../learning/outcomes.js';
import { policyDenialsSection } from '../policy/policyEvents.js'; // WP-D

/** At most this many orchestrator runs per phase (initial plan + one follow-up round). */
export const MAX_ORCHESTRATOR_ROUNDS = 2;
import { isExperimentTask } from '../learning/runTags.js'; // learning loop WP-F
import { retireExperimentOutputs } from './outputs.js'; // learning loop WP-F

/** Tasks currently executing in this process (so the drain loop never runs a task twice). */
const active = new Set<string>();

const isAbort = (err: unknown) => err instanceof AbortError || (err as Error | undefined)?.name === 'AbortError';

/** Every enabled provider's models. */
export function allowedModels(config: BifConfig): ModelRef[] {
  const out: ModelRef[] = [];
  for (const provider of PROVIDER_IDS) {
    const p = config.providers[provider];
    if (p.enabled) for (const model of p.models) out.push({ provider, model });
  }
  return out;
}

/**
 * Configured default model for a task type: `roles.workers[type]`, else `roles.workers.default`;
 * `synthesize_recommendations` runs as the synthesizer, so it defaults to `roles.synthesizer`.
 */
export function defaultTaskModel(config: BifConfig, type: TaskType): ModelRef {
  if (type === 'synthesize_recommendations') return config.roles.workers[type] ?? config.roles.synthesizer;
  return config.roles.workers[type] ?? config.roles.workers.default;
}

const sameModel = (a: ModelRef, b: ModelRef) => a.provider === b.provider && a.model === b.model;
const modelName = (m: ModelRef) => `${m.provider}/${m.model}`;

/** The workspace's running research run (latest), which `propose_tasks` adds tasks to. */
export function currentResearchRun(store: Store, workspaceId: string): ResearchRun | undefined {
  return store.researchRuns.list({ workspaceId, status: 'running' }).at(-1);
}

// ---------------------------------------------------------------------------
// propose_tasks

/** Normalized near-duplicate key of a task within a research run: (type, subject, brief). */
export function taskKey(t: { type: string; subject?: string | undefined; brief: string }): string {
  const norm = (x: string | undefined) => (x ?? '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  return `${t.type}|${norm(t.subject)}|${norm(t.brief)}`;
}

/**
 * `propose_tasks` handler (orchestrator role). Validates each proposed task against the running
 * phase (allowed task types), enabled models, `limits.maxTasksPerRun` (per research run) and
 * near-duplicates already in the run (same type, normalized subject and brief); accepted items
 * become `queued` Tasks.
 *
 * Replay detection, validation, task inserts and the `task_proposal` Decision happen in ONE
 * synchronous transaction, so concurrent identical calls from the same run cannot both insert:
 * an identical replay returns the original outcome with `duplicate: true` (no tasks, no budget, no
 * second Decision). The handler writes the Decision itself (`recorded: true`).
 */
export const proposeTasksHandler: ExtraToolHandler = async (ctx, rawInput, deps) => {
  const input = rawInput as ToolInput<'propose_tasks'>;
  const { store, config, events } = deps;
  const key = JSON.stringify(input);
  const outcome = store.transaction(() => {
    const replay = findReplay(store, ctx, 'propose_tasks', 'run', (p) => JSON.stringify(p.input) === key);
    if (replay) {
      const original = (replay.payload as { result?: Record<string, unknown> }).result ?? {};
      return { ok: true as const, data: { ...original, duplicate: true }, decision: undefined };
    }
    const rr = currentResearchRun(store, ctx.workspaceId);
    if (!rr) return { ok: false as const, error: 'no research phase is running for this workspace' };
    const allowedTypes = PHASE_TASK_TYPES[rr.phase];
    const models = allowedModels(config);
    const existing = store.tasks.list({ runId: rr.id }).filter((t) => t.workspaceId === ctx.workspaceId);
    const keys = new Map(existing.map((t) => [taskKey(t), t.id]));
    let remaining = config.limits.maxTasksPerRun - existing.length;
    const accepted: Array<{
      index: number;
      taskId: string;
      type: string;
      model: ModelRef;
      /** `default`: configured default for the type; `override`: the orchestrator chose another model. */
      modelSource: 'default' | 'override';
      defaultModel: ModelRef;
      /** KS-5: facts the task is asked to re-check (shown with their claims in the worker's prompt). */
      recheckFactIds?: string[];
    }> = [];
    const rejected: Array<{ index: number; type: string; reason: string; duplicateOf?: string }> = [];
    const now = new Date().toISOString();
    input.tasks.forEach((t, index) => {
      let reason: string | undefined;
      const dupOf = keys.get(taskKey(t));
      const defaultModel = defaultTaskModel(config, t.type);
      const model = t.model ?? defaultModel;
      if (!allowedTypes.includes(t.type)) {
        reason = `task type '${t.type}' is not allowed in phase '${rr.phase}' (allowed: ${allowedTypes.join(', ') || 'none'})`;
      } else if (!models.some((m) => sameModel(m, model))) {
        reason = `model '${modelName(model)}' is not enabled (allowed: ${models.map(modelName).join(', ')})`;
      } else if (dupOf) {
        reason = `duplicate of task ${dupOf} already in this phase run (same type, subject and brief)`;
      } else if (remaining <= 0) {
        reason = `exceeds limits.maxTasksPerRun (${config.limits.maxTasksPerRun}) for this phase run`;
      } else {
        reason = recheckProblem(store, ctx.workspaceId, t.recheck_fact_ids); // KS-5
      }
      if (reason) {
        rejected.push(dupOf && reason.startsWith('duplicate') ? { index, type: t.type, reason, duplicateOf: dupOf } : { index, type: t.type, reason });
        return;
      }
      const task: Task = {
        id: newId('tsk'),
        workspaceId: ctx.workspaceId,
        runId: rr.id,
        phase: rr.phase,
        type: t.type,
        brief: t.brief,
        model,
        needsBrowser: t.needs_browser,
        acceptanceCriteria: t.acceptance_criteria,
        status: 'queued',
        step: 'work',
        round: 1,
        createdAt: now,
      };
      if (t.subject !== undefined) task.subject = t.subject;
      store.tasks.insert(task);
      keys.set(taskKey(task), task.id);
      remaining--;
      accepted.push({
        index, taskId: task.id, type: t.type, model, defaultModel,
        modelSource: t.model && !sameModel(t.model, defaultModel) ? 'override' : 'default',
        ...(t.recheck_fact_ids?.length ? { recheckFactIds: [...new Set(t.recheck_fact_ids)] } : {}), // KS-5
      });
    });
    // Explicit model overrides are listed on their own so they are easy to audit and rate.
    const overrides = accepted
      .filter((a) => a.modelSource === 'override')
      .map((a) => ({ index: a.index, taskId: a.taskId, type: a.type, model: a.model, defaultModel: a.defaultModel }));
    const result = { accepted, rejected, remaining: Math.max(0, remaining), modelOverrides: overrides };
    const decision: Decision = {
      id: newId('dec'),
      workspaceId: ctx.workspaceId,
      agentRunId: ctx.agentRunId,
      role: ctx.role,
      model: ctx.model,
      kind: 'task_proposal',
      payload: { tool: 'propose_tasks', input, result },
      refs: [rr.id, ...accepted.map((a) => a.taskId)],
      promptVersion: ctx.promptVersion,
      createdAt: now,
    };
    store.decisions.insert(decision);
    return { ok: true as const, data: result, decision };
  });
  if (!outcome.ok) return { ok: false, error: outcome.error };
  if (outcome.decision) events.emit({ type: 'decision', workspaceId: ctx.workspaceId, decision: outcome.decision });
  return { ok: true, data: outcome.data, recorded: true };
};

// ---------------------------------------------------------------------------
// context

/**
 * Context sections about the workspace itself: name, its own profile and its internal uploads (id,
 * file type, size, upload date — no title: design-thread ruling on §12, KS-5). Symptoms, findings and personas are part of the knowledge briefing since KS-5
 * (`orchestratorBriefing`: node scope, redacted, budgeted and logged as a prompt read).
 */
export function workspaceContext(store: Store, ws: Workspace, dataDir?: string): string[] {
  const profile = store.profiles.get(ws.id)?.data ?? {};
  // Uploads as metadata only (profile.uploads, incl. sha-deduped ones); contents via expand / read_artifact.
  const uploads = uploadPromptLines(ws.id, { store, ...(dataDir ? { dataDir } : {}) });
  return [
    `# Workspace ${ws.id}\nName: ${ws.name}\nSector: ${ws.sector}`,
    `## Profile\n\`\`\`json\n${JSON.stringify(profile, null, 2)}\n\`\`\``,
    `## Internal uploads (cite by id when relevant)\n${uploads.join('\n')}`,
  ];
}

function harnessEvents(store: Store, workspaceId: string, event: string) {
  // Decisions are listed per workspace; harness events are tagged by `payload.event`.
  return store.decisions
    .list({ workspaceId })
    .filter((d) => (d.payload as { tool?: string; event?: string } | null)?.event === event && (d.payload as { tool?: string }).tool === 'harness');
}

type RunHistoryPayload = { event: string; step?: string; round?: number; attempt?: number; reason?: string; willRetry?: boolean };

/**
 * Failed-run history of a task and how each retry ended, e.g.
 * `work r1 attempt 1 failed (run failed (exit 1)) → retried; work r1 attempt 2 succeeded`.
 * Empty when no run of the task failed.
 */
export function runHistory(store: Store, task: Task): string[] {
  const events = store.decisions
    .list({ workspaceId: task.workspaceId })
    .filter((d) => d.refs.includes(task.id))
    .map((d) => d.payload as RunHistoryPayload | null)
    .filter((p): p is RunHistoryPayload => !!p && (p as { tool?: string }).tool === 'harness' && (p.event === 'worker_run_failed' || p.event === 'worker_retry_succeeded'));
  if (!events.some((e) => e.event === 'worker_run_failed')) return [];
  return events.map((e) =>
    e.event === 'worker_retry_succeeded'
      ? `${e.step} r${e.round} attempt ${e.attempt} succeeded`
      : `${e.step} r${e.round} attempt ${e.attempt} failed (${e.reason})${e.willRetry ? ' → retried' : ' → gave up'}`,
  );
}

/** Findings named per task in a results summary (the rest: their count). */
const SUMMARY_FINDINGS = 5;

/**
 * One task of a results summary. KS-5: text is redacted before it is cut, and the findings whose claims
 * are shown are returned as `refs` (the summary is a logged prompt read).
 */
function taskSummary(store: Store, t: Task): { text: string; refs: RetrievalResultRef[] } {
  const line = (s: string, n: number) => servedLine(store, t.workspaceId, s, n);
  const lines = [`- [${t.id}] ${t.type} → ${t.status} (round ${t.round})${t.subject ? `, subject ${line(t.subject, 200)}` : ''}`];
  lines.push(`  brief: ${line(t.brief, 300)}`);
  const history = runHistory(store, t);
  if (t.status === 'failed') {
    lines.push(`  FAILED: ${history.length ? 'all attempts failed' : 'task could not run'}`);
  }
  if (history.length) lines.push(`  run history: ${history.join('; ')}`);
  if (t.result !== undefined) lines.push(`  result: ${line(JSON.stringify(t.result), 1500)}`);
  const findings = store.findings.list({ taskId: t.id }).filter((f) => f.workspaceId === t.workspaceId && f.status !== 'superseded');
  const shown = findings.slice(0, SUMMARY_FINDINGS);
  if (findings.length) {
    lines.push(`  findings: ${shown.map((f) => `[${f.id}] ${line(f.claim, 120)}`).join('; ')}${findings.length > shown.length ? `; … ${findings.length - shown.length} more (search)` : ''}`);
  }
  return { text: lines.join('\n'), refs: shown.map((f) => ({ id: f.id, kind: 'fact' })) };
}

/** Results of a research run's tasks (with failed-run history), for the orchestrator's follow-up round. */
export function resultsSummary(store: Store, rr: ResearchRun): string {
  return resultsSummaryWithRefs(store, rr).text;
}

function resultsSummaryWithRefs(store: Store, rr: ResearchRun): { text: string; refs: RetrievalResultRef[] } {
  const parts = store.tasks
    .list({ runId: rr.id })
    .filter((t) => t.workspaceId === rr.workspaceId)
    .map((t) => taskSummary(store, t));
  return { text: parts.map((p) => p.text).join('\n'), refs: parts.flatMap((p) => p.refs) };
}

/**
 * Tasks of the workspace's previous research run that failed or had failed runs, so the next phase's
 * orchestrator knows about them. Empty string when there were none.
 */
export function previousPhaseProblems(store: Store, rr: ResearchRun): string {
  return previousPhaseProblemsWithRefs(store, rr).text;
}

function previousPhaseProblemsWithRefs(store: Store, rr: ResearchRun): { text: string; refs: RetrievalResultRef[] } {
  const prev = store.researchRuns
    .list({ workspaceId: rr.workspaceId })
    .filter((r) => r.id !== rr.id && r.status !== 'running' && r.startedAt <= rr.startedAt)
    .at(-1);
  if (!prev) return { text: '', refs: [] };
  const affected = store.tasks
    .list({ runId: prev.id })
    .filter((t) => t.workspaceId === rr.workspaceId && (t.status === 'failed' || runHistory(store, t).length > 0));
  if (!affected.length) return { text: '', refs: [] };
  const parts = affected.map((t) => taskSummary(store, t));
  return {
    text: `## Problems in the previous phase (${prev.phase}, ${prev.id})\n${parts.map((p) => p.text).join('\n')}\n\nRe-plan this work in the current phase if it still matters and fits its task types.`,
    refs: parts.flatMap((p) => p.refs),
  };
}

/** Full orchestrator prompt for one round. */
export function orchestratorPrompt(store: Store, config: BifConfig, rr: ResearchRun, round: number): string {
  return orchestratorPromptWithReads(store, config, rr, round).prompt;
}

/**
 * The orchestrator prompt and its prompt reads (KS-5): the knowledge briefing and the task results
 * carry store text, so each is a `PromptRead` logged on the run before it starts.
 */
export function orchestratorPromptWithReads(store: Store, config: BifConfig, rr: ResearchRun, round: number, now: Date = new Date()): { prompt: string; reads: PromptRead[] } {
  const ws = store.workspaces.get(rr.workspaceId) ?? {
    id: rr.workspaceId, name: rr.workspaceId, sector: '', createdAt: rr.startedAt,
  } as Workspace;
  const existing = store.tasks.list({ runId: rr.id });
  const remaining = Math.max(0, config.limits.maxTasksPerRun - existing.length);
  // --- KS-5: the knowledge briefing replaces the "Existing findings" / tree-context lists ---
  const briefing = orchestratorBriefing({ store, config, now }, {
    workspaceId: ws.id,
    provider: config.roles.orchestrator.provider,
    phase: rr.phase,
    ...changesSinceOf(store, rr),
    ...recheckUntilOf(store, rr, now),
    treeLines: store.workspaces.get(ws.id) ? treeLines(store, ws) : [],
  });
  const reads = promptReadsOf(briefing);
  // --- end KS-5 ---
  const parts = [
    ...workspaceContext(store, ws, config.dataDir),
    ...treeContext(store, ws),
    ...(briefing.section ? [briefing.section] : []),
    `## Phase: ${rr.phase} (orchestrator round ${round} of ${MAX_ORCHESTRATOR_ROUNDS})\nGoal: ${phaseGoal(rr.phase, ws)}`,
    `## Allowed task types\n${PHASE_TASK_TYPES[rr.phase].map((t) => `- ${t}`).join('\n') || '- (none)'}`,
    `## Allowed models\n${allowedModels(config).map((m) => `- {"provider":"${m.provider}","model":"${m.model}"}`).join('\n')}`,
    `## Default model per task type (used when you omit \`model\`; set \`model\` only to override)\n${PHASE_TASK_TYPES[rr.phase]
      .map((t) => `- ${t}: ${JSON.stringify(defaultTaskModel(config, t))}`)
      .join('\n') || '- (no task types in this phase)'}`,
    `## Task budget\n${remaining} more task(s) may be proposed in this phase run (limits.maxTasksPerRun = ${config.limits.maxTasksPerRun}).`,
  ];
  const results: RetrievalResultRef[] = [];
  let resultTokens = 0;
  const problems = previousPhaseProblemsWithRefs(store, rr);
  if (problems.text) {
    parts.push(problems.text);
    results.push(...problems.refs);
    resultTokens += estimateTokens(problems.text);
  }
  const denials = policyDenialsSection(store, rr.workspaceId, 'orchestrator'); // WP-D
  if (denials) parts.push(denials);
  if (existing.length) {
    const summary = resultsSummaryWithRefs(store, rr);
    results.push(...summary.refs);
    resultTokens += estimateTokens(summary.text);
    parts.push(
      round > 1
        ? `## Results of this phase's tasks so far\n${summary.text}\n\nPropose follow-up tasks only where they add real value (e.g. retry failed tasks that still matter, fill gaps).`
        : `## Tasks already in this phase run\n${summary.text}`,
    );
  }
  // KS-5: the claims of task findings shown above are a read as well.
  if (results.length) {
    const unique = [...new Map(results.map((r) => [r.id, r])).values()];
    reads.push({ query: `task results ${rr.id}`, scope: 'node', results: unique, tokensReturned: resultTokens, uploadDerived: anyUploadDerived(store, unique) });
  }
  return { prompt: parts.join('\n\n'), reads };
}

// --- knowledge store KS-5: recurring runs ---------------------------------------------------------

/** "Changes since": the previous run of the same schedule and phase, else the node's last finished run. */
function changesSinceOf(store: Store, rr: ResearchRun): { changesSince?: string } {
  const prev =
    previousRun({ store }, rr) ??
    store.researchRuns
      .list({ workspaceId: rr.workspaceId })
      .filter((r) => r.id !== rr.id && r.status === 'done' && r.startedAt <= rr.startedAt)
      .sort((a, b) => a.startedAt.localeCompare(b.startedAt))
      .at(-1);
  return prev ? { changesSince: prev.startedAt } : {};
}

/** Scheduled runs: facts reaching their TTL before the schedule's next run are due (manual runs: stale only). */
function recheckUntilOf(store: Store, rr: ResearchRun, now: Date): { recheckUntil?: Date } {
  const schedule = rr.scheduleId ? store.schedules.get(rr.scheduleId) : undefined;
  if (!schedule) return {};
  try {
    return { recheckUntil: CronExpressionParser.parse(schedule.cron, { currentDate: now }).next().toDate() };
  } catch {
    return {};
  }
}

/**
 * `recheck_fact_ids` of a proposed task: each must be a current fact of the caller's business tree.
 * Unknown and other-tree ids get the same text (design §12). `undefined` when valid.
 */
function recheckProblem(store: Store, workspaceId: string, ids: readonly string[] | undefined): string | undefined {
  if (!ids?.length) return undefined;
  const tree = factScope(store, workspaceId).treeIds;
  for (const id of ids) {
    const f = store.findings.get(id);
    if (!f || !tree.includes(f.workspaceId)) return `recheck_fact_ids: finding '${id}' not found`;
    if ((f.lifecycle ?? 'current') !== 'current') return `recheck_fact_ids: finding '${id}' is ${f.lifecycle} (re-check the current version)`;
  }
  return undefined;
}

// --- end KS-5 -------------------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// phase execution

async function orchestratorRound(deps: ResearchDeps, rr: ResearchRun, round: number): Promise<void> {
  const { store, config } = deps;
  const system = loadPrompt('orchestrator', calibrationScope(store, config, rr.workspaceId)).text;
  const version = promptVersion(system);
  const model = config.roles.orchestrator;
  const before = store.tasks.list({ runId: rr.id }).length;
  // Round-started marker, written BEFORE the agent runs, so a resume after a crash mid-round does
  // not start the same round again. The agent run does not exist yet, so the Decision is attached
  // to a synthetic run id `orchestrator:<researchRunId>:r<round>`.
  recordHarnessDecision(
    store,
    { agentRunId: `orchestrator:${rr.id}:r${round}`, workspaceId: rr.workspaceId, role: 'orchestrator', model, promptVersion: version },
    'decision',
    { event: 'orchestrator_round_started', researchRunId: rr.id, phase: rr.phase, round },
    [rr.id],
  );
  const { prompt, reads } = orchestratorPromptWithReads(store, config, rr, round); // KS-5: briefing reads
  const res = await runAgent(deps, {
    kind: 'orchestrate', role: 'orchestrator', workspaceId: rr.workspaceId, round, attempt: 1,
    prompt, systemPrompt: system,
    model, needsBrowser: false, promptVersion: version, researchRunId: rr.id,
    ...(reads.length ? { promptReads: reads } : {}),
  });
  throwIfAborted(deps.signal);
  const proposed = store.tasks.list({ runId: rr.id }).length - before;
  recordHarnessDecision(
    store,
    { agentRunId: res.agentRunId, workspaceId: rr.workspaceId, role: 'orchestrator', model, promptVersion: version },
    'decision',
    { event: 'orchestrator_round', researchRunId: rr.id, phase: rr.phase, round, runStatus: res.status, tasksAccepted: proposed },
    [rr.id],
  );
  if (res.status === 'failed' && round === 1 && proposed === 0 && before === 0) {
    throw new Error(`orchestrator run failed: ${failureReason(res)}`);
  }
}

/** Orchestrator rounds of a research run that were started (finished or not). */
function orchestratorRounds(store: Store, rr: ResearchRun): number {
  const rounds = new Set<number>();
  for (const event of ['orchestrator_round_started', 'orchestrator_round']) {
    for (const d of harnessEvents(store, rr.workspaceId, event)) {
      const p = d.payload as { researchRunId?: string; round?: number };
      if (p.researchRunId === rr.id) rounds.add(p.round ?? rounds.size + 1);
    }
  }
  return rounds.size;
}

async function runTracked(task: Task, deps: ResearchDeps): Promise<void> {
  if (active.has(task.id)) return;
  active.add(task.id);
  try {
    await runTaskWithReview(task, deps);
  } finally {
    active.delete(task.id);
  }
}

/**
 * Runs the research run's tasks until none is queued or waiting. Tasks left in `waiting_user` by a
 * previous process (no live run) are resumed once their user request is answered.
 */
export async function drainTasks(deps: ResearchDeps, rr: ResearchRun): Promise<void> {
  const { store, events } = deps;
  for (;;) {
    throwIfAborted(deps.signal);
    const tasks = store.tasks.list({ runId: rr.id }).filter((t) => t.workspaceId === rr.workspaceId && !active.has(t.id));
    // A task restored to running/reviewing after its user request was answered, but with no live run.
    for (const t of tasks) {
      if (t.status === 'running' || t.status === 'reviewing') store.tasks.update(t.id, { status: 'queued' });
    }
    const queued = store.tasks.list({ runId: rr.id }).filter((t) => t.status === 'queued' && !active.has(t.id));
    if (queued.length) {
      await Promise.all(queued.map((t) => runTracked(t, deps)));
      continue;
    }
    const waiting = new Set(tasks.filter((t) => t.status === 'waiting_user').map((t) => t.id));
    if (!waiting.size) return;
    const ac = new AbortController();
    const signal = deps.signal ? AbortSignal.any([deps.signal, ac.signal]) : ac.signal;
    const resolved = events.waitFor(
      (e) => e.type === 'user_request_resolved' && e.request.taskId !== undefined && waiting.has(e.request.taskId),
      signal,
    );
    resolved.catch(() => {});
    // Re-check after subscribing so an answer that landed in between is not missed.
    const still = [...waiting].filter((id) => store.tasks.get(id)?.status === 'waiting_user');
    if (still.length < waiting.size) {
      ac.abort();
      continue;
    }
    try {
      await resolved;
    } catch (err) {
      if (deps.signal?.aborted) throw new AbortError('research cancelled');
      throw err;
    }
  }
}

/** Executes (or continues, after a restart) a research run to completion. */
async function executePhase(deps: ResearchDeps, rr: ResearchRun): Promise<ResearchRun> {
  const { store } = deps;
  try {
    if (RUNNER_PHASES.has(rr.phase)) {
      const runner = deps.phaseRunners?.[rr.phase];
      if (!runner) throw new Error(`no runner configured for phase '${rr.phase}'`);
      await runner(rr.workspaceId, deps);
    } else {
      let rounds = orchestratorRounds(store, rr);
      if (rounds === 0) {
        await orchestratorRound(deps, rr, 1);
        rounds = 1;
      }
      await drainTasks(deps, rr);
      if (rounds < MAX_ORCHESTRATOR_ROUNDS && store.tasks.list({ runId: rr.id }).length > 0) {
        await orchestratorRound(deps, rr, rounds + 1);
        await drainTasks(deps, rr);
      }
    }
    return store.researchRuns.update(rr.id, { status: 'done', endedAt: new Date().toISOString() });
  } catch (err) {
    if (isAbort(err) || deps.signal?.aborted) throw err;
    console.error(`[bif] research run ${rr.id} (${rr.phase}) failed: ${(err as Error).message}`);
    return store.researchRuns.update(rr.id, { status: 'failed', endedAt: new Date().toISOString(), failureReason: (err as Error).message });
  }
}

/**
 * Runs one phase for a workspace: a fresh orchestrator run plans tasks (`propose_tasks`), the
 * accepted tasks run through the review loop (concurrency bounded by the supervisor), then the
 * orchestrator gets one follow-up round with the results (failed tasks included). The runner phases
 * (`RUNNER_PHASES`: `flow_ranking`, `persona_panel`, `scoring`) call `deps.phaseRunners` instead. Resolves with the finished ResearchRun
 * (`done` or `failed`). Rejects if the workspace already has a running research run, or with
 * `AbortError` when `deps.signal` aborts.
 */
export async function startPhase(
  workspaceId: string,
  phase: Phase,
  deps: ResearchDeps,
  opts: { scheduleId?: string; pipelineId?: string } = {},
): Promise<ResearchRun> {
  const { store } = deps;
  const running = currentResearchRun(store, workspaceId);
  if (running) throw new Error(`workspace '${workspaceId}' already has a running research run (${running.id}, ${running.phase})`);
  const rr: ResearchRun = {
    id: newId('rrun'),
    workspaceId,
    phase,
    status: 'running',
    startedAt: new Date().toISOString(),
    ...(opts.scheduleId ? { scheduleId: opts.scheduleId } : {}),
    ...(opts.pipelineId ? { pipelineId: opts.pipelineId } : {}),
  };
  store.researchRuns.insert(rr);
  return executePhase(deps, rr);
}

/**
 * Runs (or continues) a persisted pipeline from `nextIndex`: a phase whose run is still `running`
 * (interrupted) is continued, a finished one is reused, a missing one is started. Progress is saved
 * after every phase; the pipeline stops after a failed phase. Scheduled pipelines then record the
 * scheduler's "what changed" step. Returns the pipeline's runs in phase order. The caller holds the
 * workspace's pipeline lock. The first missing ResearchRun is inserted synchronously.
 */
async function continuePipeline(deps: ResearchDeps, pipelineId: string): Promise<ResearchRun[]> {
  const { store } = deps;
  const pipeline = store.pipelines.get(pipelineId)!;
  const runOf = (phase: Phase) =>
    store.researchRuns
      .list({ pipelineId })
      .filter((r) => r.workspaceId === pipeline.workspaceId && r.phase === phase)
      .at(-1);
  let failed = false;
  for (let i = pipeline.nextIndex; i < pipeline.phases.length; i++) {
    const phase = pipeline.phases[i]!;
    const existing = runOf(phase);
    const rr = !existing
      ? await startPhase(pipeline.workspaceId, phase, deps, {
          pipelineId,
          ...(pipeline.scheduleId ? { scheduleId: pipeline.scheduleId } : {}),
        })
      : existing.status === 'running'
        ? await executePhase(deps, existing)
        : existing;
    if (rr.status === 'failed') {
      failed = true;
      break;
    }
    store.pipelines.update(pipelineId, { nextIndex: i + 1 });
  }
  store.pipelines.update(pipelineId, { status: failed ? 'failed' : 'done', endedAt: new Date().toISOString() });
  const runs = pipeline.phases.map(runOf).filter((r): r is ResearchRun => r !== undefined);
  if (pipeline.scheduleId) recordWhatChanged(deps, pipeline.scheduleId, runs);
  return runs;
}

/**
 * Runs phases sequentially in pipeline order; stops after a phase that fails. The pipeline (requested
 * phases, progress, schedule) is persisted, so `resumeInterrupted` continues its remaining phases after
 * a restart. Holds the workspace's pipeline lock for the whole pipeline (taken synchronously, before
 * the first await), and rejects with `PipelineBusyError` when another pipeline holds it. `scheduleId`
 * tags the runs; a scheduled pipeline records "what changed" when it ends.
 */
export async function runPipeline(
  workspaceId: string,
  phases: Phase[] = ALL_PHASES,
  deps: ResearchDeps,
  opts: { scheduleId?: string } = {},
): Promise<ResearchRun[]> {
  const release = tryLockPipeline(deps.store, workspaceId);
  if (!release) throw new PipelineBusyError(workspaceId);
  try {
    const pipeline: Pipeline = {
      id: newId('pipe'),
      workspaceId,
      phases: orderPhases(phases),
      nextIndex: 0,
      status: 'running',
      startedAt: new Date().toISOString(),
      ...(opts.scheduleId ? { scheduleId: opts.scheduleId } : {}),
    };
    deps.store.pipelines.insert(pipeline);
    return await continuePipeline(deps, pipeline.id);
  } finally {
    release();
  }
}

export type ResumeReport = {
  /** AgentRuns that were `running` and are now `failed`. */
  failedRuns: string[];
  /** Tasks moved from running/reviewing back to queued (round kept). */
  requeuedTasks: string[];
  /** Tasks still waiting for a pending user request. */
  waitingTasks: string[];
  /** running/reviewing tasks whose research run is no longer running: marked `failed`, not re-queued. */
  abandonedTasks: string[];
  /** Research runs being continued. */
  continuedRuns: string[];
  /** Pipelines whose remaining phases are being continued. */
  continuedPipelines: string[];
  /** Settles when every continued research run has finished. */
  done: Promise<ResearchRun[]>;
};

/**
 * SIGKILLs an orphaned CLI process group, but only after verifying it is still ours (recorded start
 * time, no reboot since, leader start time unchanged; see `isOurProcessGroup`). A vanished group
 * (ESRCH) is ignored. Returns whether a kill signal was sent.
 */
export function killOrphanGroup(pid: number, startedAt?: string): boolean {
  if (process.platform === 'win32' || !Number.isInteger(pid) || pid <= 1) return false;
  const check = isOurProcessGroup(pid, startedAt);
  if (!check.ours) {
    if (check.reason !== 'process group is gone') console.warn(`[bif] not killing process group ${pid}: ${check.reason}`);
    return false;
  }
  try {
    process.kill(-pid, 'SIGKILL');
    return true;
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code !== 'ESRCH') console.warn(`[bif] could not kill orphan process group ${pid}: ${code ?? (e as Error).message}`);
    return false;
  }
}

/**
 * Startup recovery. AgentRuns left `running` by a dead process are marked `failed`, their tokens
 * revoked and their orphaned process groups killed (`AgentRun.pid`). Tasks in `running|reviewing`
 * are re-queued with the same round when their research run is still `running` (otherwise they are
 * marked `failed`: nothing would run them); tasks in `waiting_user` keep their pending request and resume
 * when it is answered. Pipelines still `running` continue their interrupted phase and remaining phases
 * (and a scheduled pipeline's "what changed" step); research runs `running` outside a pipeline are
 * continued alone. All of this runs in the background (`done`).
 */
export function resumeInterrupted(deps: ResearchDeps): ResumeReport {
  const { store, tokens } = deps;
  const now = new Date().toISOString();
  const failedRuns: string[] = [];
  for (const run of store.agentRuns.list({ status: 'running' })) {
    if (run.pid !== undefined) killOrphanGroup(run.pid, run.pidStartedAt);
    if (tokens) tokens.revoke(run.token);
    else if (!run.token.startsWith('revoked:')) store.agentRuns.update(run.id, { token: `revoked:${run.token}` });
    store.agentRuns.update(run.id, { status: 'failed', endedAt: now });
    failedRuns.push(run.id);
  }
  const requeuedTasks: string[] = [];
  const waitingTasks: string[] = [];
  const abandonedTasks: string[] = [];
  const liveRuns = new Set(store.researchRuns.list({ status: 'running' }).map((r) => r.id));
  for (const t of store.tasks.list()) {
    if (active.has(t.id)) continue;
    if (t.status === 'running' || t.status === 'reviewing') {
      if (liveRuns.has(t.runId)) {
        store.tasks.update(t.id, { status: 'queued' });
        requeuedTasks.push(t.id);
      } else {
        // Its research run is over (or unknown): nothing will run it again.
        // Its outputs take the failed status too (same rule as the review loop), and live views reload.
        const experiment = isExperimentTask(store, t.id); // learning loop WP-F: an interrupted experiment arm
        const failed = store.transaction(() => {
          const task = store.tasks.update(t.id, { status: 'failed', failureReason: 'interrupted: its research run ended while the task was running' });
          if (experiment) retireExperimentOutputs(store, task); // WP-F
          else applyTaskStatus(store, task, 'failed');
          return task;
        });
        deps.events.emit({ type: 'task_status', workspaceId: failed.workspaceId, taskId: failed.id, status: 'failed' });
        if (!experiment) recordTaskEndOutcomes(store, failed); // learning loop WP-C
        abandonedTasks.push(t.id);
      }
    } else if (t.status === 'waiting_user') {
      waitingTasks.push(t.id);
    }
  }
  const runs = store.researchRuns.list({ status: 'running' });
  const pipelines = store.pipelines.list({ status: 'running' });
  const piped = new Set(pipelines.map((p) => p.id));
  const loose = runs.filter((rr) => !rr.pipelineId || !piped.has(rr.pipelineId));
  // Continue on a later tick so callers (server boot) can finish their own setup first.
  // Continued runs hold their workspace's pipeline lock until they finish.
  const workspaces = [...new Set([...pipelines.map((p) => p.workspaceId), ...loose.map((r) => r.workspaceId)])];
  const releases = workspaces.map((id) => tryLockPipeline(store, id));
  const done = new Promise<void>((r) => setImmediate(r))
    .then(() =>
      Promise.all([
        ...pipelines.map((p) => continuePipeline(deps, p.id)),
        ...loose.map((rr) => executePhase(deps, rr).then((r) => [r])),
      ]),
    )
    .then((lists) => lists.flat())
    .finally(() => {
      for (const r of releases) r?.();
    });
  done.catch(() => {});
  return {
    failedRuns, requeuedTasks, waitingTasks, abandonedTasks,
    continuedRuns: runs.map((r) => r.id),
    continuedPipelines: pipelines.map((p) => p.id),
    done,
  };
}

// ---------------------------------------------------------------------------
// WP-D: escalation re-runs

/**
 * Runs one task through the review loop outside the drain loop (a re-run after an answered
 * escalation), tracked like drained tasks so no drain loop runs it at the same time. Resolves with
 * the task's final state, or `undefined` when it is already running.
 */
export async function runTaskTracked(task: Task, deps: ResearchDeps): Promise<Task | undefined> {
  if (active.has(task.id)) return undefined;
  active.add(task.id);
  try {
    return await runTaskWithReview(task, deps);
  } finally {
    active.delete(task.id);
  }
}
