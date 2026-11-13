import type { BifConfig } from '../config/schema.js';
import { AbortError, type EventBus } from '../events.js';
import type { FakeScript } from '../harness/adapter.js';
import type { RunOutcome, Supervisor } from '../harness/supervisor.js';
import type { TokenRegistry } from '../harness/tokens.js';
import { redactIdentitySecrets } from '../identity/identities.js';
import type { Store } from '../store/db.js';
import { newId } from '../store/repos.js';
import type { Decision, ModelRef, Phase, Role, Task } from '../types.js';

/** Which agent step a run is for (used by fake pickers and logs). */
export type AgentKind = 'orchestrate' | 'work' | 'revise' | 'review';

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
   * Agent-less phases: `persona_panel` → `runPersonaPanel` (Task 12), `scoring` →
   * `scoreRecommendations` (Task 13). A phase without a runner fails its ResearchRun.
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
  if (fake) opts.fake = fake;
  if (deps.signal) opts.signal = deps.signal;
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
