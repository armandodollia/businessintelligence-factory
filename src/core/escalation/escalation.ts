import type { BifConfig, ModelRef } from '../config/schema.js';
import type { EventBus } from '../events.js';
import {
  getRunOutputs,
  resolveUserRequest,
  type ExtraToolHandler,
  type ReviewIssue,
  type ToolResult,
} from '../harness/tools/handlers.js';
import { findReplay } from '../harness/tools/idempotency.js';
import type { ToolInput, ToolName } from '../harness/tools/registry.js';
import { policyPrompt } from '../policy/actionPolicy.js';
import { loadPrompt, promptVersion, type CalibrationScope } from '../prompts/index.js';
import { recordHarnessDecision, runAgent, type ResearchDeps } from '../research/deps.js';
import { runHistory, runTaskTracked } from '../research/orchestrator.js';
import { loopSettings, reviewContext, roleForTask } from '../research/reviewLoop.js';
import { defaultConfig } from '../config/schema.js'; // KS-5
import type { PromptRead } from '../knowledge/promptReads.js'; // KS-5
import { servedLine } from '../knowledge/texts.js'; // KS-5
import { calibrationScope } from '../scoring/calibration.js';
import type { Store } from '../store/db.js';
import { newId } from '../store/repos.js';
import type { AgentRun, Decision, Task, UserRequest } from '../types.js';
import {
  answerLine,
  ESCALATION_KIND,
  ESCALATION_RERUN_EVENT,
  escalationRequests,
  type EscalationRerunPayload,
} from './context.js';

/**
 * Structured escalations (WP-D). When a task ends `unverified` or `failed`, the `escalation` agent
 * writes 0–3 multiple-choice questions (one recommended option each), stored as `user_requests` of
 * kind `escalation` with `optionsJson`. Once every question of that escalation is answered (at
 * least one not dismissed), the task re-runs through the normal review loop / supervisor, with the
 * answers and a summary of the previous attempt in its prompt (`escalationRerunSection`).
 */

export { ESCALATION_KIND, escalationRerunSection } from './context.js';

/** Task statuses that trigger an escalation. */
const ESCALATABLE: ReadonlySet<Task['status']> = new Set(['unverified', 'failed']);

/** Effective `config.escalation` with defaults applied. */
export function escalationSettings(config: Pick<BifConfig, 'escalation' | 'roles'>): {
  enabled: boolean;
  model: ModelRef;
  maxQuestions: number;
  maxPerTask: number;
} {
  const e = config.escalation ?? {};
  return {
    enabled: e.enabled ?? true,
    model: e.model ?? config.roles.orchestrator,
    maxQuestions: e.maxQuestions ?? 3,
    maxPerTask: e.maxPerTask ?? 2,
  };
}

// ---------------------------------------------------------------------------
// submit_escalation

const fail = (error: string): ToolResult => ({ ok: false, error });

/**
 * `submit_escalation` (escalation role): validates the questions against `escalation.maxQuestions`,
 * stores each as a pending `escalation` user request of the run's task (the task keeps its final
 * status: nothing blocks on these) and records one Decision. A replay from the same run returns
 * the original request ids.
 */
export const submitEscalationHandler: ExtraToolHandler = async (ctx, raw, deps) => {
  const input = raw as ToolInput<'submit_escalation'>;
  const { store, events, config } = deps;
  const max = escalationSettings(config).maxQuestions;
  if (input.questions.length > max) return fail(`at most ${max} question(s) per escalation (escalation.maxQuestions)`);
  const task = ctx.taskId ? store.tasks.get(ctx.taskId) : undefined;
  if (!task || task.workspaceId !== ctx.workspaceId) return fail('submit_escalation needs a task in this workspace');
  const outcome = store.transaction(() => {
    const replay = findReplay(store, ctx, 'submit_escalation', 'run', () => true);
    if (replay) {
      const ids = (replay.payload as { requestIds?: string[] }).requestIds ?? [];
      return { data: { requestIds: ids, duplicate: true }, requests: [] as UserRequest[], decision: undefined };
    }
    const now = new Date().toISOString();
    const requests = input.questions.map((q): UserRequest => {
      const r: UserRequest = {
        id: newId('ureq'),
        workspaceId: ctx.workspaceId,
        agentRunId: ctx.agentRunId,
        taskId: task.id,
        kind: ESCALATION_KIND,
        details: q.question,
        status: 'pending',
        createdAt: now,
        optionsJson: { options: q.options, recommended: q.recommended, rationale: q.why },
      };
      store.userRequests.insert(r);
      return r;
    });
    const decision: Decision = {
      id: newId('dec'),
      workspaceId: ctx.workspaceId,
      agentRunId: ctx.agentRunId,
      role: ctx.role,
      model: ctx.model,
      kind: 'decision',
      payload: { tool: 'submit_escalation', questions: input.questions, requestIds: requests.map((r) => r.id), taskStatus: task.status },
      refs: [task.id, ...requests.map((r) => r.id)],
      promptVersion: ctx.promptVersion,
      createdAt: now,
    };
    store.decisions.insert(decision);
    return { data: { requestIds: requests.map((r) => r.id) }, requests, decision };
  });
  if (outcome.decision) events.emit({ type: 'decision', workspaceId: ctx.workspaceId, decision: outcome.decision });
  for (const request of outcome.requests) events.emit({ type: 'user_request', workspaceId: ctx.workspaceId, request });
  return { ok: true, data: outcome.data, recorded: true };
};

/** Extra tool handlers to pass to `createToolHandlers({ extraHandlers })`. */
export function escalationToolHandlers(): Partial<Record<ToolName, ExtraToolHandler>> {
  return { submit_escalation: submitEscalationHandler };
}

// ---------------------------------------------------------------------------
// prompts

/** The latest valid review of a task (last reviewer run that submitted one). */
function lastReviewOf(store: Store, task: Task): { score: number; issues: ReviewIssue[] } | undefined {
  const runs = store.agentRuns.list({ taskId: task.id, role: 'reviewer' }).filter((r) => r.workspaceId === task.workspaceId);
  for (const run of runs.reverse()) {
    const review = getRunOutputs(store, run.id).review;
    if (review) return { score: review.score, issues: review.issues };
  }
  return undefined;
}

function lastWorkerRun(store: Store, task: Task): AgentRun | undefined {
  const role = roleForTask(task);
  return store.agentRuns
    .list({ taskId: task.id })
    .filter((r) => r.workspaceId === task.workspaceId && r.role === role)
    .at(-1);
}

/** Escalation agent system prompt: `escalation.md` (+ the business's calibration) + the action policy. */
export function escalationSystemPrompt(config: BifConfig, scope?: CalibrationScope): string {
  return [loadPrompt('escalation', scope).text.trimEnd(), policyPrompt(config)].join('\n\n');
}

/** Escalation agent task prompt: the task, how it ended, its last review / failures and earlier answers. */
export function escalationPrompt(store: Store, task: Task, maxQuestions = 3, config: Pick<BifConfig, 'knowledge'> = defaultConfig): string {
  return escalationPromptWithReads(store, task, maxQuestions, config).prompt;
}

/**
 * `escalationPrompt` and its prompt reads (KS-5): stored text (review issues, the deliverable, the task's
 * outputs) is redacted before it is cut; the task's outputs are a reviewer-style briefing (escalation
 * budget, fenced) whose read is logged on the run before it starts.
 */
export function escalationPromptWithReads(
  store: Store,
  task: Task,
  maxQuestions = 3,
  config: Pick<BifConfig, 'knowledge'> = defaultConfig,
): { prompt: string; reads: PromptRead[] } {
  const clip = (s: string, n: number) => servedLine(store, task.workspaceId, s, n);
  const parts = [
    [`Task id: ${task.id}`, `Task type: ${task.type}`, ...(task.subject ? [`Subject: ${task.subject}`] : [])].join('\n'),
    `## Brief\n${task.brief}`,
    `## Acceptance criteria\n${task.acceptanceCriteria.map((c) => `- ${c}`).join('\n') || '- (none)'}`,
    `## Outcome\nThe task ended **${task.status}** after review round ${task.round}.`,
  ];
  const review = lastReviewOf(store, task);
  if (review) {
    parts.push(
      `## Last review (score ${review.score})\n${
        review.issues.map((i) => `- [${i.id}] (${i.class}) ${clip(i.description, 500)}`).join('\n') || '- (no issues listed)'
      }`,
    );
  }
  const history = runHistory(store, task);
  if (history.length) parts.push(`## Run failures\n${history.map((h) => `- ${clip(h, 400)}`).join('\n')}`);
  if (task.result !== undefined) parts.push(`## Final deliverable\n\`\`\`json\n${clip(JSON.stringify(task.result, null, 2), 3000)}\n\`\`\``);
  // KS-5: the task's outputs, as the reviewer sees them (escalation budget; its slice allows expand).
  const context = reviewContext({ store, config: config as BifConfig }, task, 'escalation');
  if (context.outputs) parts.push(context.outputs);
  const earlier = escalationRequests(store, task).filter((r) => r.status !== 'pending');
  if (earlier.length) parts.push(`## Earlier escalations for this task (already answered)\n${earlier.map(answerLine).join('\n')}`);
  parts.push(`Call \`submit_escalation\` exactly once with at most ${maxQuestions} question(s) (or none).`);
  const reads: PromptRead[] = [];
  if (context.outputsRead) reads.push(context.outputsRead);
  const k = context.knowledge;
  if (k) reads.push({ query: `review context: task ${task.id}`, scope: 'tree', results: k.results, tokensReturned: k.tokens, truncated: k.truncated, uploadDerived: k.uploadDerived });
  return { prompt: parts.join('\n\n'), reads };
}

// ---------------------------------------------------------------------------
// running, answering, re-running

/**
 * Runs the escalation agent for a task that ended `unverified` / `failed` and returns the questions
 * it asked. Does nothing (returns `[]`) when escalations are disabled, the task is not in such a
 * state, it still has unanswered escalation questions, or `escalation.maxPerTask` is reached.
 */
export async function runEscalation(deps: ResearchDeps, taskId: string): Promise<UserRequest[]> {
  const { store, config } = deps;
  const settings = escalationSettings(config);
  if (!settings.enabled || settings.maxQuestions === 0) return [];
  const task = store.tasks.get(taskId);
  if (!task || !ESCALATABLE.has(task.status)) return [];
  if (escalationRequests(store, task).some((r) => r.status === 'pending')) return [];
  const runs = store.agentRuns.list({ taskId, role: 'escalation' }).filter((r) => r.workspaceId === task.workspaceId);
  if (runs.length >= settings.maxPerTask) return [];
  const system = escalationSystemPrompt(config, calibrationScope(store, config.dataDir, task.workspaceId));
  const { prompt, reads } = escalationPromptWithReads(store, task, settings.maxQuestions, config); // KS-5
  const res = await runAgent(deps, {
    kind: 'escalate', role: 'escalation', workspaceId: task.workspaceId, task, round: task.round, attempt: 1,
    prompt, systemPrompt: system,
    model: settings.model, needsBrowser: false, promptVersion: promptVersion(system),
    ...(reads.length ? { promptReads: reads } : {}),
  });
  return store.userRequests.list({ agentRunId: res.agentRunId, kind: ESCALATION_KIND });
}

export class EscalationError extends Error {
  constructor(
    readonly code: 'not_found' | 'conflict' | 'invalid',
    message: string,
  ) {
    super(message);
    this.name = 'EscalationError';
  }
}

/**
 * Answers one escalation question with option `choice` (0-based) and an optional note: stores the
 * choice in `optionsJson.choice`, resolves the request (response: the option text, marked when it
 * was the recommended one, plus the note) and wakes listeners (`user_request_resolved`).
 */
export function answerEscalation(
  deps: { store: Store; events: EventBus },
  id: string,
  input: { choice: number; note?: string },
): UserRequest {
  const { store } = deps;
  const req = store.userRequests.get(id);
  if (!req) throw new EscalationError('not_found', `user request '${id}' not found`);
  if (req.kind !== ESCALATION_KIND || !req.optionsJson) throw new EscalationError('invalid', `user request '${id}' is not an escalation question`);
  if (req.status !== 'pending') throw new EscalationError('conflict', `user request '${id}' is already ${req.status}`);
  const opts = req.optionsJson;
  if (!Number.isInteger(input.choice) || input.choice < 0 || input.choice >= opts.options.length) {
    throw new EscalationError('invalid', `choice must be an option index 0–${opts.options.length - 1}`);
  }
  const note = input.note?.trim();
  const response =
    `${opts.options[input.choice]}${input.choice === opts.recommended ? ' (the recommended option)' : ''}` +
    `${note ? ` — note: ${note}` : ''}`;
  store.userRequests.update(id, { optionsJson: { ...opts, choice: input.choice } });
  return resolveUserRequest(deps, id, 'resolved', response);
}

/** Copy of `config` whose loop gives `type` a review budget up to round `maxRounds`. */
function withRoundBudget(config: BifConfig, type: Task['type'], maxRounds: number): BifConfig {
  const perTaskType = { ...config.loop.perTaskType, [type]: { ...config.loop.perTaskType[type], maxRounds } };
  return { ...config, loop: { ...config.loop, perTaskType } };
}

/**
 * Re-runs a task after its latest escalation was fully answered (no question pending, at least one
 * answered rather than dismissed), once per escalation. The previous outcome is recorded as an
 * `escalation_rerun` harness Decision on the escalation run (read back by `escalationRerunSection`);
 * the task then goes through the review loop again with a fresh round budget — as a revision of its
 * deliverable when the last review raised issues, else as new work. Resolves with the final task,
 * or `undefined` when nothing was re-run.
 */
export async function rerunAfterEscalation(deps: ResearchDeps, taskId: string): Promise<Task | undefined> {
  const { store, config } = deps;
  const task = store.tasks.get(taskId);
  if (!task || !ESCALATABLE.has(task.status)) return undefined;
  const requests = escalationRequests(store, task);
  const runId = requests.at(-1)?.agentRunId;
  if (!runId) return undefined;
  const batch = requests.filter((r) => r.agentRunId === runId);
  if (batch.some((r) => r.status === 'pending') || !batch.some((r) => r.status === 'resolved')) return undefined;
  const already = store.decisions
    .list({ agentRunId: runId })
    .some((d) => (d.payload as { tool?: string; event?: string } | null)?.event === ESCALATION_RERUN_EVENT);
  if (already) return undefined;
  const escRun = store.agentRuns.get(runId);
  const review = lastReviewOf(store, task);
  const worker = lastWorkerRun(store, task);
  const failures = runHistory(store, task);
  const payload: Omit<EscalationRerunPayload, 'tool'> = {
    event: ESCALATION_RERUN_EVENT,
    previousStatus: task.status,
    previousRound: task.round,
    requestIds: batch.map((r) => r.id),
  };
  if (review) payload.lastReview = { score: review.score, issues: review.issues.map(({ id, class: cls, description }) => ({ id, class: cls, description })) };
  if (failures.length) payload.failureReasons = failures;
  if (worker) payload.lastWorkerRunId = worker.id;
  const startRound = task.round + 1;
  const asRevision = task.result !== undefined && !!review?.issues.length;
  store.transaction(() => {
    recordHarnessDecision(
      store,
      {
        agentRunId: runId, workspaceId: task.workspaceId, role: 'escalation',
        model: escRun?.model ?? escalationSettings(config).model, promptVersion: escRun?.promptVersion ?? '',
      },
      'decision',
      payload,
      [task.id, ...payload.requestIds],
    );
    store.tasks.update(
      task.id,
      asRevision
        ? { status: 'queued', step: 'revise', round: startRound, reviewIssues: review!.issues }
        : { status: 'queued', step: 'work', round: startRound },
    );
  });
  const { maxRounds } = loopSettings(task.type, config);
  return runTaskTracked(store.tasks.get(taskId)!, { ...deps, config: withRoundBudget(config, task.type, startRound + maxRounds - 1) });
}

export type EscalationService = {
  /** Unsubscribes (work already started finishes). */
  stop(): void;
  /** Resolves once no escalation or re-run started by this service is in flight. */
  idle(): Promise<void>;
};

/**
 * Wires escalations to the event bus: a `task_status` of `unverified` / `failed` runs the
 * escalation agent; an answered escalation question re-runs its task once every question of that
 * escalation is answered. On start, re-runs tasks whose escalation was answered while the server
 * was down. Work is deduplicated per task and never throws into the bus.
 */
export function startEscalations(deps: ResearchDeps): EscalationService {
  const inflight = new Set<Promise<unknown>>();
  const busy = new Set<string>();
  const track = (key: string, fn: () => Promise<unknown>) => {
    if (busy.has(key)) return;
    busy.add(key);
    // Deferred: never run agent work synchronously inside an event emit.
    const p: Promise<unknown> = Promise.resolve()
      .then(fn)
      .catch((err: unknown) => console.error(`[bif] ${key} failed: ${(err as Error).message}`))
      .finally(() => {
        busy.delete(key);
        inflight.delete(p);
      });
    inflight.add(p);
  };
  const off = deps.events.on((e) => {
    if (e.type === 'task_status' && ESCALATABLE.has(e.status)) {
      track(`escalation:${e.taskId}`, () => runEscalation(deps, e.taskId));
    } else if (e.type === 'user_request_resolved' && e.request.kind === ESCALATION_KIND && e.request.taskId) {
      const taskId = e.request.taskId;
      track(`rerun:${taskId}`, () => rerunAfterEscalation(deps, taskId));
    }
  });
  const answeredTasks = new Set(
    deps.store.userRequests.list({ kind: ESCALATION_KIND }).flatMap((r) => (r.taskId && r.status !== 'pending' ? [r.taskId] : [])),
  );
  for (const taskId of answeredTasks) track(`rerun:${taskId}`, () => rerunAfterEscalation(deps, taskId));
  return {
    stop: off,
    async idle() {
      while (inflight.size) await Promise.allSettled([...inflight]);
    },
  };
}
