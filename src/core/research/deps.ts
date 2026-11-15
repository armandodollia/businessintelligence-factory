import type { BifConfig } from '../config/schema.js';
import { AbortError, type EventBus } from '../events.js';
import type { FakeScript } from '../harness/adapter.js';
import type { RunOutcome, Supervisor } from '../harness/supervisor.js';
import type { RunContext, TokenRegistry } from '../harness/tokens.js';
import { redactIdentitySecrets } from '../identity/identities.js';
import type { Store } from '../store/db.js';
import { newId } from '../store/repos.js';
import type { Decision, ModelRef, Phase, Role, Task } from '../types.js';
import { recordPromptReads, type PromptRead } from '../knowledge/promptReads.js'; // KS-4
import { lessonsOff, tagRun } from '../learning/runTags.js'; // learning loop WP-F
import { lessonsMode } from '../learning/lessons/mode.js'; // wave-2 integration: withLessons marks runs
import { taskIsOffline } from './phases.js'; // stakeholder personas

/** Which agent step a run is for (used by fake pickers and logs). */
export type AgentKind = 'orchestrate' | 'work' | 'revise' | 'review' | 'escalate' | 'retro' | 'audit'; // escalate: WP-D; retro: learning loop WP-E; audit: WP-F

export type AgentRequest = {
  kind: AgentKind;
  role: Role;
  workspaceId: string;
  task?: Task;
  /** Review round (orchestrator: orchestrator round). */
  round: number;
  /** 1-based attempt of this step (worker steps are retried once). */
  attempt: number;
  prompt: string;
  systemPrompt: string;
  /** Learning loop WP-B: research run a task-less run belongs to (orchestrator), for usage/budgets. */
  researchRunId?: string;
  /**
   * Knowledge store KS-4: store text the prompt carries (reviewer context, KS-5 briefings). Logged as
   * `prompt_context` retrieval rows on the run before it starts (`recordPromptReads`).
   */
  promptReads?: PromptRead[];
  /**
   * Learning loop WP-F: tags written on the run once its id exists and before the agent starts (before
   * the prompt reads), e.g. a reviewer audit's `auditId`. Decisions of the run inherit them.
   */
  runTags?: { auditId?: string; lessonsOff?: boolean };
  /**
   * Stakeholder personas: the run must not reach the web (`RunOptions.offline`). Every run of a task
   * whose type is offline (worker, reviewer, escalation, reviewer audit) is offline whatever this says:
   * `runAgent` sets it from `task.type` too.
   */
  offline?: boolean;
  /**
   * Stakeholder personas: called with the run's context once its id exists and before the agent
   * starts (after `runTags` and `promptReads`), e.g. to tell a tool handler what the run was asked.
   */
  onStart?: (ctx: RunContext) => void;
};

/** Returns an in-process script for a run (tests / dry runs); `undefined` → spawn the real CLI. */
export type FakePicker = (req: AgentRequest) => FakeScript | undefined;

/** Runs a phase that has no orchestrator (persona_panel → Task 12, scoring → Task 13). */
export type PhaseRunner = (workspaceId: string, deps: ResearchDeps) => Promise<void>;

export type ResearchDeps = {
  store: Store;
  config: BifConfig;
  supervisor: Supervisor;
  events: EventBus;
  /** Needed by `resumeInterrupted` to revoke tokens of interrupted runs. */
  tokens?: TokenRegistry;
  fake?: FakePicker;
  /** Aborting stops every run started through these deps (no task state is changed afterwards). */
  signal?: AbortSignal;
  /**
   * Agent-less phases: `flow_ranking` → `runFlowRanking` (flows/round.ts), `persona_panel` →
   * `runPersonaPanel` (Task 12), `scoring` → `scoreRecommendations` (Task 13). A phase without a
   * runner fails its ResearchRun.
   */
  phaseRunners?: Partial<Record<Phase, PhaseRunner>>;
};

/** Starts one agent run through the supervisor, picking a fake script when configured. */
export async function runAgent(
  deps: ResearchDeps,
  req: AgentRequest & { model: ModelRef; needsBrowser: boolean; promptVersion: string },
): Promise<RunOutcome> {
  const fake = deps.fake?.(req);
  const ctx: Parameters<Supervisor['run']>[0]['ctx'] = {
    workspaceId: req.workspaceId,
    role: req.role,
    model: req.model,
    promptVersion: req.promptVersion,
  };
  if (req.task) ctx.taskId = req.task.id;
  const opts: Parameters<Supervisor['run']>[0] = {
    ctx,
    prompt: req.prompt,
    systemPrompt: req.systemPrompt,
    needsBrowser: req.needsBrowser,
  };
  if (req.offline || (req.task && taskIsOffline(req.task.type))) opts.offline = true;
  if (fake) opts.fake = fake;
  if (deps.signal) opts.signal = deps.signal;
  // Learning loop WP-B: round / task type on the AgentRun, research run for usage and budgets.
  const meta: NonNullable<typeof opts.meta> = { round: req.round };
  if (req.task) meta.taskType = req.task.type;
  const researchRunId = req.task?.runId ?? req.researchRunId;
  if (researchRunId) meta.researchRunId = researchRunId;
  opts.meta = meta;
  // KS-4: prompt reads are logged once the run id exists and before the agent starts.
  const reads = req.promptReads ?? [];
  // Learning loop WP-F tags. Wave-2 integration: a run started inside `withLessons('off')`, or for a
  // task whose stored flag is lessons-off, is stored with `lessons_off = 1` (prompt assembly reads it).
  const off = lessonsMode() === 'off' || (req.task ? lessonsOff(deps.store, { taskId: req.task.id }) : false);
  const tags = off && !req.runTags?.lessonsOff ? { ...req.runTags, lessonsOff: true } : req.runTags;
  if (reads.length || tags || req.onStart) {
    opts.beforeStart = (runCtx) => {
      if (tags) tagRun(deps.store, runCtx.agentRunId, tags);
      if (reads.length) recordPromptReads({ store: deps.store, events: deps.events }, runCtx, reads);
      req.onStart?.(runCtx);
    };
  }
  return deps.supervisor.run(opts);
}

/**
 * Records a harness-originated Decision (payload `tool: 'harness'`) on an agent run, e.g. a failed
 * worker run or a synthetic review. `getRunOutputs` ignores these.
 */
export function recordHarnessDecision(
  store: Store,
  run: { agentRunId: string; workspaceId: string; role: Role; model: ModelRef; promptVersion: string },
  kind: Decision['kind'],
  payload: Record<string, unknown>,
  refs: string[],
): Decision {
  const d: Decision = {
    id: newId('dec'),
    workspaceId: run.workspaceId,
    agentRunId: run.agentRunId,
    role: run.role,
    model: run.model,
    kind,
    payload: redactIdentitySecrets(store, run.workspaceId, { tool: 'harness', ...payload }),
    refs: [...new Set(refs)],
    promptVersion: run.promptVersion,
    createdAt: new Date().toISOString(),
  };
  store.decisions.insert(d);
  return d;
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new AbortError('research cancelled');
}
