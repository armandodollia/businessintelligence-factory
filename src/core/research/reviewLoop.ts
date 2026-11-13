import type { BifConfig } from '../config/schema.js';
import { reviewerFor } from '../config/load.js';
import { AbortError } from '../events.js';
import type { RunOutcome } from '../harness/supervisor.js';
import { getRunOutputs, type ReviewIssue } from '../harness/tools/handlers.js';
import { loadPrompt, promptVersion } from '../prompts/index.js';
import type { Role, Task, TaskType } from '../types.js';
import { recordHarnessDecision, runAgent, throwIfAborted, type AgentKind, type ResearchDeps } from './deps.js';
import { workerSystemPrompt, reviewerSystemPrompt } from './systemPrompts.js';

/** Issue description used when a reviewer run produced no valid `submit_review`. */
export const MALFORMED_REVIEW_ISSUE = 'reviewer produced no valid review';

/** Worker steps (initial work or a revision) are attempted at most this many times. */
export const WORKER_STEP_ATTEMPTS = 2;

/** Effective loop settings for a task type (per-task-type overrides win). */
export function loopSettings(type: TaskType, config: BifConfig): { maxRounds: number; passThreshold: number } {
  const o = config.loop.perTaskType[type];
  return {
    maxRounds: o?.maxRounds ?? config.loop.maxRounds,
    passThreshold: o?.passThreshold ?? config.loop.passThreshold,
  };
}

/** The role that executes a task: synthesis tasks need `save_recommendation`. */
export function roleForTask(task: Pick<Task, 'type'>): Role {
  return task.type === 'synthesize_recommendations' ? 'synthesizer' : 'worker';
}

const ARTIFACT_ID = /\bart_[0-9A-Z]{26}\b/g;

/** Evidence artifact ids of a task: its findings' evidence plus artifact ids cited in the deliverable. */
export function evidenceIds(deps: Pick<ResearchDeps, 'store'>, task: Task): string[] {
  const ids = new Set<string>();
  for (const f of deps.store.findings.list({ taskId: task.id })) {
    if (f.workspaceId === task.workspaceId) for (const a of f.evidence) ids.add(a);
  }
  if (task.result !== undefined) for (const m of JSON.stringify(task.result).matchAll(ARTIFACT_ID)) ids.add(m[0]);
  return [...ids];
}

function bullets(items: string[]): string {
  return items.length ? items.map((s) => `- ${s}`).join('\n') : '- (none)';
}

function taskHeader(task: Task): string {
  const lines = [`Task id: ${task.id}`, `Task type: ${task.type}`];
  if (task.subject) lines.push(`Subject: ${task.subject}`);
  return lines.join('\n');
}

/** Prompt for the initial worker run. Includes answers to the task's earlier user requests (after a restart). */
export function workPrompt(deps: Pick<ResearchDeps, 'store'>, task: Task): string {
  const parts = [
    taskHeader(task),
    `## Brief\n${task.brief}`,
    `## Acceptance criteria\n${bullets(task.acceptanceCriteria)}`,
  ];
  const answered = deps.store.userRequests
    .list({ taskId: task.id })
    .filter((r) => r.workspaceId === task.workspaceId && r.status !== 'pending');
  if (answered.length) {
    parts.push(
      '## Earlier requests to the user (from a previous, interrupted run of this task)\n' +
        answered
          .map((r) => `- ${r.kind}${r.site ? ` on ${r.site}` : ''}: ${r.details}\n  → ${r.status}${r.response ? `: ${r.response}` : ''}`)
          .join('\n') +
        '\nContinue from there; the research browser profile keeps any session the user set up.',
    );
  }
  parts.push('Finish by calling `submit_result` with your deliverable.');
  return parts.join('\n\n');
}

/** Prompt for a revision run: brief, criteria, current deliverable and the reviewer's issues. */
export function revisePrompt(task: Task, issues: ReviewIssue[]): string {
  const issueLines = issues.map((i) => {
    const ev = i.evidence?.length ? ` (evidence: ${i.evidence.join(', ')})` : '';
    return `- [${i.id}] (${i.class}) ${i.description}${ev}`;
  });
  return [
    loadPrompt('revise').text,
    taskHeader(task),
    `## Brief\n${task.brief}`,
    `## Acceptance criteria\n${bullets(task.acceptanceCriteria)}`,
    `## Your current deliverable\n\`\`\`json\n${JSON.stringify(task.result ?? null, null, 2)}\n\`\`\``,
    `## Review issues\n${issueLines.join('\n') || '- (none)'}`,
  ].join('\n\n');
}

/**
 * Reviewer prompt: ONLY the task brief, acceptance criteria, the current deliverable and its
 * evidence artifact ids (spec §7.2: no worker transcript, other tasks, or prior review rounds).
 */
export function reviewPrompt(task: Task, evidence: string[]): string {
  return [
    taskHeader(task),
    `## Brief\n${task.brief}`,
    `## Acceptance criteria\n${bullets(task.acceptanceCriteria)}`,
    `## Deliverable\n\`\`\`json\n${JSON.stringify(task.result ?? null, null, 2)}\n\`\`\``,
    `## Evidence artifact ids (inspect with read_artifact)\n${bullets(evidence)}`,
    'Call `submit_review` exactly once.',
  ].join('\n\n');
}

/** Human-readable failure of a run: exit code, supervisor reason, last error event. */
export function failureReason(res: RunOutcome): string {
  const lastError = [...res.events].reverse().find((e) => e.t === 'error');
  const parts = [`exit ${res.exitCode}`];
  if (res.reason) parts.push(res.reason);
  if (lastError?.t === 'error' && lastError.message !== res.reason) parts.push(lastError.message.slice(0, 500));
  return `run failed (${parts.join('; ')})`;
}

type StepOutcome = { ok: true } | { ok: false; reason: string };

/** One worker step (initial work or a revision), retried once with a fresh run on failure. */
async function workerStep(
  deps: ResearchDeps,
  taskId: string,
  kind: Extract<AgentKind, 'work' | 'revise'>,
  round: number,
  issues: ReviewIssue[],
): Promise<StepOutcome> {
  const { store, config } = deps;
  const role = roleForTask(store.tasks.get(taskId)!);
  const system = workerSystemPrompt(config, role);
  const version = promptVersion(system);
  let reason = '';
  for (let attempt = 1; attempt <= WORKER_STEP_ATTEMPTS; attempt++) {
    throwIfAborted(deps.signal);
    const task = store.tasks.get(taskId)!;
    const prompt = kind === 'work' ? workPrompt(deps, task) : revisePrompt(task, issues);
    const res = await runAgent(deps, {
      kind, role, workspaceId: task.workspaceId, task, round, attempt, prompt, systemPrompt: system,
      model: task.model, needsBrowser: task.needsBrowser, promptVersion: version,
    });
    throwIfAborted(deps.signal);
    const outputs = getRunOutputs(store, res.agentRunId);
    if (res.status === 'done' && outputs.result !== undefined) return { ok: true };
    reason = res.status === 'failed' ? failureReason(res) : 'run ended without submit_result';
    // The failed run (AgentRun row + events.jsonl) is kept; this decision makes the failure visible.
    recordHarnessDecision(
      store,
      { agentRunId: res.agentRunId, workspaceId: task.workspaceId, role, model: task.model, promptVersion: version },
      'decision',
      { event: 'worker_run_failed', step: kind, round, attempt, reason, exitCode: res.exitCode, willRetry: attempt < WORKER_STEP_ATTEMPTS },
      [task.id],
    );
  }
  return { ok: false, reason };
}

/** One reviewer run (always a NEW run). Malformed or failed reviews become score 0 + a blocking issue. */
async function reviewStep(
  deps: ResearchDeps,
  taskId: string,
  round: number,
): Promise<{ score: number; issues: ReviewIssue[] }> {
  const { store, config } = deps;
  const task = store.tasks.get(taskId)!;
  const system = reviewerSystemPrompt(config);
  const version = promptVersion(system);
  const model = reviewerFor(task.model, config);
  const res = await runAgent(deps, {
    kind: 'review', role: 'reviewer', workspaceId: task.workspaceId, task, round, attempt: 1,
    prompt: reviewPrompt(task, evidenceIds(deps, task)), systemPrompt: system,
    model, needsBrowser: false, promptVersion: version,
  });
  throwIfAborted(deps.signal);
  const review = getRunOutputs(store, res.agentRunId).review;
  if (review && Number.isFinite(review.score) && review.score >= 0 && review.score <= 10) {
    return { score: review.score, issues: review.issues };
  }
  const issues: ReviewIssue[] = [{ id: 'I1', class: 'blocking', description: MALFORMED_REVIEW_ISSUE }];
  recordHarnessDecision(
    store,
    { agentRunId: res.agentRunId, workspaceId: task.workspaceId, role: 'reviewer', model, promptVersion: version },
    'review',
    { event: 'synthetic_review', round, score: 0, issues, runStatus: res.status },
    [task.id],
  );
  return { score: 0, issues };
}

function finish(deps: ResearchDeps, taskId: string, status: 'verified' | 'unverified' | 'failed', round: number): Task {
  const { store } = deps;
  return store.transaction(() => {
    const task = store.tasks.update(taskId, { status, round });
    if (status !== 'failed') {
      for (const f of store.findings.list({ taskId })) {
        if (f.workspaceId === task.workspaceId) store.findings.update(f.id, { status });
      }
    }
    return task;
  });
}

/**
 * Runs one task through the adversarial review loop (spec §7.2):
 * worker → `submit_result`; then per round a NEW reviewer run; `score >= passThreshold` →
 * `verified`; `round == maxRounds` → `unverified` (the task's findings take the same status);
 * otherwise a revision run answers the issues (`respond_to_review`) and resubmits.
 *
 * A worker step whose run fails (non-zero exit, idle kill) or ends without `submit_result` is retried
 * once with a new run; a second failure marks the task `failed`. Failed runs are kept and logged as
 * harness Decisions (`payload.event = 'worker_run_failed'`).
 *
 * Resume: a task that already has a deliverable (`result`) starts at review of `task.round`.
 * Throws `AbortError` when `deps.signal` aborts (task state is then left as is).
 */
export async function runTaskWithReview(task: Task, deps: ResearchDeps): Promise<Task> {
  const { store, config } = deps;
  const { maxRounds, passThreshold } = loopSettings(task.type, config);
  const id = task.id;
  let round = Math.max(1, store.tasks.get(id)?.round ?? task.round);
  try {
    if (store.tasks.get(id)?.result === undefined) {
      store.tasks.update(id, { status: 'running', round });
      const step = await workerStep(deps, id, 'work', round, []);
      if (!step.ok) return finish(deps, id, 'failed', round);
    }
    for (;;) {
      store.tasks.update(id, { status: 'reviewing', round });
      const review = await reviewStep(deps, id, round);
      if (review.score >= passThreshold) return finish(deps, id, 'verified', round);
      if (round >= maxRounds) return finish(deps, id, 'unverified', round);
      round++;
      store.tasks.update(id, { status: 'running', round });
      const step = await workerStep(deps, id, 'revise', round, review.issues);
      if (!step.ok) return finish(deps, id, 'failed', round);
    }
  } catch (err) {
    if (err instanceof AbortError || (err as Error).name === 'AbortError') throw err;
    // Non-agent error (e.g. needs a browser but maxBrowserRuns is 0): the task cannot run.
    console.error(`[bif] task ${id} failed: ${(err as Error).message}`);
    return finish(deps, id, 'failed', round);
  }
}
