import type { BifConfig } from '../config/schema.js';
import { PROVIDER_IDS } from '../config/schema.js';
import { AbortError } from '../events.js';
import { isOurProcessGroup } from '../harness/procinfo.js';
import type { ExtraToolHandler } from '../harness/tools/handlers.js';
import type { ToolInput } from '../harness/tools/registry.js';
import { loadPrompt, promptVersion } from '../prompts/index.js';
import type { Store } from '../store/db.js';
import { newId } from '../store/repos.js';
import type { ModelRef, Phase, ResearchRun, Task, Workspace } from '../types.js';
import { treeContext } from '../workspace/businessMap.js';
import { recordHarnessDecision, runAgent, throwIfAborted, type ResearchDeps } from './deps.js';
import { orderPhases, PHASE_TASK_TYPES, phaseGoal, ALL_PHASES, RUNNER_PHASES } from './phases.js';
import { failureReason, runTaskWithReview } from './reviewLoop.js';

/** At most this many orchestrator runs per phase (initial plan + one follow-up round). */
export const MAX_ORCHESTRATOR_ROUNDS = 2;

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

/** The workspace's running research run (latest), which `propose_tasks` adds tasks to. */
export function currentResearchRun(store: Store, workspaceId: string): ResearchRun | undefined {
  return store.researchRuns.list({ workspaceId, status: 'running' }).at(-1);
}

// ---------------------------------------------------------------------------
// propose_tasks

/**
 * `propose_tasks` handler (orchestrator role). Validates each proposed task against the running
 * phase (allowed task types), enabled models and `limits.maxTasksPerRun` (per research run);
 * accepted items become `queued` Tasks. The Decision (`task_proposal`) is written by the dispatcher.
 */
export const proposeTasksHandler: ExtraToolHandler = async (ctx, rawInput, deps) => {
  const input = rawInput as ToolInput<'propose_tasks'>;
  const { store, config } = deps;
  const rr = currentResearchRun(store, ctx.workspaceId);
  if (!rr) return { ok: false, error: 'no research phase is running for this workspace' };
  const allowedTypes = PHASE_TASK_TYPES[rr.phase];
  const models = allowedModels(config);
  let remaining = config.limits.maxTasksPerRun - store.tasks.list({ runId: rr.id }).length;
  const accepted: Array<{ index: number; taskId: string; type: string }> = [];
  const rejected: Array<{ index: number; type: string; reason: string }> = [];
  const now = new Date().toISOString();
  store.transaction(() => {
    input.tasks.forEach((t, index) => {
      let reason: string | undefined;
      if (!allowedTypes.includes(t.type)) {
        reason = `task type '${t.type}' is not allowed in phase '${rr.phase}' (allowed: ${allowedTypes.join(', ') || 'none'})`;
      } else if (!models.some((m) => m.provider === t.model.provider && m.model === t.model.model)) {
        reason = `model '${t.model.provider}/${t.model.model}' is not enabled (allowed: ${models.map((m) => `${m.provider}/${m.model}`).join(', ')})`;
      } else if (remaining <= 0) {
        reason = `exceeds limits.maxTasksPerRun (${config.limits.maxTasksPerRun}) for this phase run`;
      }
      if (reason) {
        rejected.push({ index, type: t.type, reason });
        return;
      }
      const task: Task = {
        id: newId('tsk'),
        workspaceId: ctx.workspaceId,
        runId: rr.id,
        phase: rr.phase,
        type: t.type,
        brief: t.brief,
        model: t.model,
        needsBrowser: t.needs_browser,
        acceptanceCriteria: t.acceptance_criteria,
        status: 'queued',
        round: 1,
        createdAt: now,
      };
      if (t.subject !== undefined) task.subject = t.subject;
      store.tasks.insert(task);
      remaining--;
      accepted.push({ index, taskId: task.id, type: t.type });
    });
  });
  return { ok: true, data: { accepted, rejected, remaining: Math.max(0, remaining) } };
};

// ---------------------------------------------------------------------------
// context

function trunc(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

/** Context sections about the workspace itself (profile, symptoms, findings, personas). */
export function workspaceContext(store: Store, ws: Workspace): string[] {
  const profile = store.profiles.get(ws.id)?.data ?? {};
  const symptoms = store.symptoms.list({ workspaceId: ws.id });
  const findings = store.findings.list({ workspaceId: ws.id });
  const personas = store.personas.list({ workspaceId: ws.id });
  const uploads = store.artifacts.list({ workspaceId: ws.id, kind: 'upload' });
  return [
    `# Workspace ${ws.id}\nName: ${ws.name}\nSector: ${ws.sector}`,
    `## Profile\n\`\`\`json\n${JSON.stringify(profile, null, 2)}\n\`\`\``,
    `## Symptoms and strengths\n${
      symptoms.map((s) => `- [${s.id}] (${s.kind}) ${s.title}: ${trunc(s.detail, 300)}`).join('\n') || '- (none yet)'
    }`,
    `## Existing findings\n${
      findings.map((f) => `- [${f.id}] (${f.status}) ${f.subject}: ${trunc(f.claim, 200)}`).join('\n') || '- (none yet)'
    }`,
    `## Internal uploads (cite by id when relevant)\n${
      uploads.map((a) => `- [${a.id}] ${a.title ?? a.mime}`).join('\n') || '- (none)'
    }`,
    `## Personas\n${personas.map((p) => `- [${p.id}] ${p.slug} (${p.segment})`).join('\n') || '- (none yet)'}`,
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

function taskSummary(store: Store, t: Task): string {
  const lines = [`- [${t.id}] ${t.type} → ${t.status} (round ${t.round})${t.subject ? `, subject ${t.subject}` : ''}`];
  lines.push(`  brief: ${trunc(t.brief, 300)}`);
  const history = runHistory(store, t);
  if (t.status === 'failed') {
    lines.push(`  FAILED: ${history.length ? 'all attempts failed' : 'task could not run'}`);
  }
  if (history.length) lines.push(`  run history: ${history.join('; ')}`);
  if (t.result !== undefined) lines.push(`  result: ${trunc(JSON.stringify(t.result), 1500)}`);
  const findings = store.findings.list({ taskId: t.id });
  if (findings.length) lines.push(`  findings: ${findings.map((f) => `[${f.id}] ${trunc(f.claim, 120)}`).join('; ')}`);
  return lines.join('\n');
}

/** Results of a research run's tasks (with failed-run history), for the orchestrator's follow-up round. */
export function resultsSummary(store: Store, rr: ResearchRun): string {
  return store.tasks
    .list({ runId: rr.id })
    .filter((t) => t.workspaceId === rr.workspaceId)
    .map((t) => taskSummary(store, t))
    .join('\n');
}

/**
 * Tasks of the workspace's previous research run that failed or had failed runs, so the next phase's
 * orchestrator knows about them. Empty string when there were none.
 */
export function previousPhaseProblems(store: Store, rr: ResearchRun): string {
  const prev = store.researchRuns
    .list({ workspaceId: rr.workspaceId })
    .filter((r) => r.id !== rr.id && r.status !== 'running' && r.startedAt <= rr.startedAt)
    .at(-1);
  if (!prev) return '';
  const affected = store.tasks
    .list({ runId: prev.id })
    .filter((t) => t.workspaceId === rr.workspaceId && (t.status === 'failed' || runHistory(store, t).length > 0));
  if (!affected.length) return '';
  return `## Problems in the previous phase (${prev.phase}, ${prev.id})\n${affected.map((t) => taskSummary(store, t)).join('\n')}\n\nRe-plan this work in the current phase if it still matters and fits its task types.`;
}

/** Full orchestrator prompt for one round. */
export function orchestratorPrompt(store: Store, config: BifConfig, rr: ResearchRun, round: number): string {
  const ws = store.workspaces.get(rr.workspaceId) ?? {
    id: rr.workspaceId, name: rr.workspaceId, sector: '', createdAt: rr.startedAt,
  } as Workspace;
  const existing = store.tasks.list({ runId: rr.id });
  const remaining = Math.max(0, config.limits.maxTasksPerRun - existing.length);
  const parts = [
    ...workspaceContext(store, ws),
    ...treeContext(store, ws),
    `## Phase: ${rr.phase} (orchestrator round ${round} of ${MAX_ORCHESTRATOR_ROUNDS})\nGoal: ${phaseGoal(rr.phase, ws)}`,
    `## Allowed task types\n${PHASE_TASK_TYPES[rr.phase].map((t) => `- ${t}`).join('\n') || '- (none)'}`,
    `## Allowed models\n${allowedModels(config).map((m) => `- {"provider":"${m.provider}","model":"${m.model}"}`).join('\n')}`,
    `## Task budget\n${remaining} more task(s) may be proposed in this phase run (limits.maxTasksPerRun = ${config.limits.maxTasksPerRun}).`,
  ];
  const problems = previousPhaseProblems(store, rr);
  if (problems) parts.push(problems);
  if (existing.length) {
    parts.push(
      round > 1
        ? `## Results of this phase's tasks so far\n${resultsSummary(store, rr)}\n\nPropose follow-up tasks only where they add real value (e.g. retry failed tasks that still matter, fill gaps).`
        : `## Tasks already in this phase run\n${resultsSummary(store, rr)}`,
    );
  }
  return parts.join('\n\n');
}

// ---------------------------------------------------------------------------
// phase execution

async function orchestratorRound(deps: ResearchDeps, rr: ResearchRun, round: number): Promise<void> {
  const { store, config } = deps;
  const system = loadPrompt('orchestrator').text;
  const version = promptVersion(system);
  const model = config.roles.orchestrator;
  const before = store.tasks.list({ runId: rr.id }).length;
  const res = await runAgent(deps, {
    kind: 'orchestrate', role: 'orchestrator', workspaceId: rr.workspaceId, round, attempt: 1,
    prompt: orchestratorPrompt(store, config, rr, round), systemPrompt: system,
    model, needsBrowser: false, promptVersion: version,
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

function orchestratorRounds(store: Store, rr: ResearchRun): number {
  return harnessEvents(store, rr.workspaceId, 'orchestrator_round').filter(
    (d) => (d.payload as { researchRunId?: string }).researchRunId === rr.id,
  ).length;
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
    return store.researchRuns.update(rr.id, { status: 'failed', endedAt: new Date().toISOString() });
  }
}

/**
 * Runs one phase for a workspace: a fresh orchestrator run plans tasks (`propose_tasks`), the
 * accepted tasks run through the review loop (concurrency bounded by the supervisor), then the
 * orchestrator gets one follow-up round with the results (failed tasks included). `persona_panel`
 * and `scoring` call `deps.phaseRunners` instead. Resolves with the finished ResearchRun
 * (`done` or `failed`). Rejects if the workspace already has a running research run, or with
 * `AbortError` when `deps.signal` aborts.
 */
export async function startPhase(workspaceId: string, phase: Phase, deps: ResearchDeps): Promise<ResearchRun> {
  const { store } = deps;
  const running = currentResearchRun(store, workspaceId);
  if (running) throw new Error(`workspace '${workspaceId}' already has a running research run (${running.id}, ${running.phase})`);
  const rr: ResearchRun = {
    id: newId('rrun'),
    workspaceId,
    phase,
    status: 'running',
    startedAt: new Date().toISOString(),
  };
  store.researchRuns.insert(rr);
  return executePhase(deps, rr);
}

/** Runs phases sequentially in pipeline order; stops after a phase that fails. */
export async function runPipeline(
  workspaceId: string,
  phases: Phase[] = ALL_PHASES,
  deps: ResearchDeps,
): Promise<ResearchRun[]> {
  const out: ResearchRun[] = [];
  for (const phase of orderPhases(phases)) {
    const rr = await startPhase(workspaceId, phase, deps);
    out.push(rr);
    if (rr.status === 'failed') break;
  }
  return out;
}

export type ResumeReport = {
  /** AgentRuns that were `running` and are now `failed`. */
  failedRuns: string[];
  /** Tasks moved from running/reviewing back to queued (round kept). */
  requeuedTasks: string[];
  /** Tasks still waiting for a pending user request. */
  waitingTasks: string[];
  /** Research runs being continued. */
  continuedRuns: string[];
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
 * are re-queued with the same round; tasks in `waiting_user` keep their pending request and resume
 * when it is answered. Research runs still `running` are continued in the background (`done`).
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
  for (const t of store.tasks.list()) {
    if (active.has(t.id)) continue;
    if (t.status === 'running' || t.status === 'reviewing') {
      store.tasks.update(t.id, { status: 'queued' });
      requeuedTasks.push(t.id);
    } else if (t.status === 'waiting_user') {
      waitingTasks.push(t.id);
    }
  }
  const runs = store.researchRuns.list({ status: 'running' });
  // Continue on a later tick so callers (server boot) can finish their own setup first.
  const done = new Promise<void>((r) => setImmediate(r)).then(() =>
    Promise.all(runs.map((rr) => executePhase(deps, rr))),
  );
  done.catch(() => {});
  return { failedRuns, requeuedTasks, waitingTasks, continuedRuns: runs.map((r) => r.id), done };
}
