import type { EventBus } from './events.js';
import type { Store } from './store/db.js';
import { newId } from './store/repos.js';
import type { Decision } from './types.js';

/** Who made a non-agent Decision. */
export type SystemActor = 'user' | 'scheduler';

/**
 * Records a Decision that no agent run made: a user action (priority weights changed, prompt patch
 * approved) or a scheduler outcome ("what changed"). `agentRunId` is the actor name, `role` is
 * `orchestrator` (the closest system-level role), `model` is `{ provider: 'claude', model: 'none' }`
 * and `promptVersion` is `'n/a'`; `payload.actor` names the actor so consumers can tell these apart.
 */
export function recordSystemDecision(
  deps: { store: Store; events?: EventBus },
  input: {
    workspaceId: string;
    actor: SystemActor;
    kind?: Decision['kind'];
    payload: Record<string, unknown>;
    refs?: string[];
  },
): Decision {
  const decision: Decision = {
    id: newId('dec'),
    workspaceId: input.workspaceId,
    agentRunId: input.actor,
    role: 'orchestrator',
    model: { provider: 'claude', model: 'none' },
    kind: input.kind ?? 'decision',
    payload: { actor: input.actor, ...input.payload },
    refs: input.refs ?? [],
    promptVersion: 'n/a',
    createdAt: new Date().toISOString(),
  };
  deps.store.decisions.insert(decision);
  deps.events?.emit({ type: 'decision', workspaceId: decision.workspaceId, decision });
  return decision;
}
