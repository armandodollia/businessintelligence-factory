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

/**
 * Answers to the task's earlier user requests (registrations, approvals, ...), for every worker
 * prompt (initial work and revisions, also after a restart). Empty string when there are none.
 */
export function answeredRequestsSection(deps: Pick<ResearchDeps, 'store'>, task: Task): string {
  const answered = deps.store.userRequests
    .list({ taskId: task.id })
    .filter((r) => r.workspaceId === task.workspaceId && r.status !== 'pending');
  if (!answered.length) return '';
  return (
    '## Earlier requests to the user for this task (already answered)\n' +
    answered
      .map((r) => `- ${r.kind}${r.site ? ` on ${r.site}` : ''}: ${r.details}\n  → ${r.status}${r.response ? `: ${r.response}` : ''}`)
      .join('\n') +
    '\nUse these answers; do not ask again. The research browser profile keeps any session the user set up.'
  );
}

/** Prompt for the initial worker run. Includes answers to the task's earlier user requests (after a restart). */
export function workPrompt(deps: Pick<ResearchDeps, 'store'>, task: Task): string {
  const parts = [
    taskHeader(task),
    `## Brief\n${task.brief}`,
    `## Acceptance criteria\n${bullets(task.acceptanceCriteria)}`,
  ];
  const answered = answeredRequestsSection(deps, task);
  if (answered) parts.push(answered);
  parts.push('Finish by calling `submit_result` with your deliverable.');
  return parts.join('\n\n');
}

/** Prompt for a revision run: brief, criteria, current deliverable and the reviewer's issues. */
export function revisePrompt(task: Task, issues: ReviewIssue[], deps?: Pick<ResearchDeps, 'store'>): string {
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
    deps ? answeredRequestsSection(deps, task) : '',
  ]
    .filter(Boolean)
    .join('\n\n');
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
  const initial = store.tasks.get(taskId)!;
  const role = roleForTask(initial);
  const system = workerSystemPrompt(config, role, initial.needsBrowser, initial.type);
  const version = promptVersion(system);
  let reason = '';
  for (let attempt = 1; attempt <= WORKER_STEP_ATTEMPTS; attempt++) {
    throwIfAborted(deps.signal);
    const task = store.tasks.get(taskId)!;
    const prompt = kind === 'work' ? workPrompt(deps, task) : revisePrompt(task, issues, deps);
    const res = await runAgent(deps, {
      kind, role, workspaceId: task.workspaceId, task, round, attempt, prompt, systemPrompt: system,
      model: task.model, needsBrowser: task.needsBrowser, promptVersion: version,
    });
    throwIfAborted(deps.signal);
    const outputs = getRunOutputs(store, res.agentRunId);
    // A revision only counts when every issue got a respond_to_review (fix | pushback).
    const answered = new Set(outputs.responses.map((r) => r.issueId));
    const unanswered = kind === 'revise' ? issues.map((i) => i.id).filter((i) => !answered.has(i)) : [];
    if (res.status === 'done' && outputs.result !== undefined && unanswered.length === 0) {
      if (attempt > 1) {
        recordHarnessDecision(
          store,
          { agentRunId: res.agentRunId, workspaceId: task.workspaceId, role, model: task.model, promptVersion: version },
          'decision',
          { event: 'worker_retry_succeeded', step: kind, round, attempt },
          [task.id],
        );
      }
      return { ok: true };
    }
    reason =
      res.status === 'failed'
        ? failureReason(res)
        : outputs.result === undefined
          ? 'run ended without submit_result'
          : `run did not respond_to_review for issue(s) ${unanswered.join(', ')}`;
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
): Promise<{ valid: boolean; score: number; issues: ReviewIssue[] }> {
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
  // A review counts only if the reviewer run itself finished successfully.
  if (res.status === 'done' && review && Number.isFinite(review.score) && review.score >= 0 && review.score <= 10) {
    return { valid: true, score: review.score, issues: review.issues };
  }
  const issues: ReviewIssue[] = [{ id: 'I1', class: 'blocking', description: MALFORMED_REVIEW_ISSUE }];
  recordHarnessDecision(
    store,
    { agentRunId: res.agentRunId, workspaceId: task.workspaceId, role: 'reviewer', model, promptVersion: version },
    'review',
    { event: 'synthetic_review', round, score: 0, issues, runStatus: res.status },
    [task.id],
  );
  return { valid: false, score: 0, issues };
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
 * otherwise a revision run answers EVERY issue (`respond_to_review`) and resubmits.
 *
 * A worker step whose run fails (non-zero exit, idle kill), ends without `submit_result` or (revise)
 * leaves an issue unanswered is retried once with a new run; a second failure marks the task
 * `failed`. Failed runs are kept and logged as harness Decisions (`worker_run_failed`, and
 * `worker_retry_succeeded` when the retry worked).
 *
 * The current step (`work | review | revise`), the round, the last submitted round and the last
 * review's issues are persisted on the Task, so a resumed task continues exactly where it stopped
 * (an interrupted revise is re-run as a revise with the same issues).
 * Throws `AbortError` when `deps.signal` aborts (task state is then left as is).
 */
export async function runTaskWithReview(task: Task, deps: ResearchDeps): Promise<Task> {
  const { store, config } = deps;
  const { maxRounds, passThreshold } = loopSettings(task.type, config);
  const id = task.id;
  const current = store.tasks.get(id) ?? task;
  let round = Math.max(1, current.round);
  // Tasks created before migration 7 have no step: a deliverable means it awaits review.
  let step: NonNullable<Task['step']> = current.step ?? (current.result === undefined ? 'work' : 'review');
  try {
    for (;;) {
      if (step === 'work' || step === 'revise') {
        const latest = store.tasks.get(id)!;
        const issues = step === 'revise' ? (latest.reviewIssues ?? []) : [];
        store.tasks.update(id, { status: 'running', round, step });
        const res = await workerStep(deps, id, step, round, issues);
        if (!res.ok) return finish(deps, id, 'failed', round);
        step = 'review';
        store.tasks.update(id, { step, submittedRound: round });
        continue;
      }
      store.tasks.update(id, { status: 'reviewing', round, step: 'review' });
      const review = await reviewStep(deps, id, round);
      // Only a valid review from a successful reviewer run can pass (even with passThreshold 0).
      if (review.valid && review.score >= passThreshold) return finish(deps, id, 'verified', round);
      if (round >= maxRounds) return finish(deps, id, 'unverified', round);
      round++;
      step = 'revise';
      store.tasks.update(id, { status: 'running', round, step, reviewIssues: review.issues });
    }
  } catch (err) {
    if (err instanceof AbortError || (err as Error).name === 'AbortError') throw err;
    // Non-agent error (e.g. needs a browser but maxBrowserRuns is 0): the task cannot run.
    console.error(`[bif] task ${id} failed: ${(err as Error).message}`);
    return finish(deps, id, 'failed', round);
  }
}
