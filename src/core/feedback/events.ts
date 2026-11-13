/**
 * Feedback events (learning loop WP-A, migration 14): an append-only log of every human-in-the-loop
 * action on agent output — who, when, what (before → after), why, and which agent run / prompt
 * version produced the thing acted on. The table refuses UPDATE / DELETE (triggers).
 *
 * Public API (other work packages consume this module):
 * - `recordFeedback(store, input)`: append one event; resolves the agent run + prompt version of
 *   the target's judgment when not given (`targetProvenance`). Runs listeners (`onFeedback`)
 *   synchronously after the insert, inside the caller's transaction when there is one.
 * - `listFeedback(store, filter)`: events in log order, filtered by workspace / kind / target.
 * - `latestFeedback(store, filter)`: the most recent matching event (e.g. the current include override).
 * - `onFeedback(listener)`: subscribe to new events (e.g. WP-C `recordOutcome` on
 *   `include_override` false / `proposal_reject`); returns an unsubscribe function.
 * - `actorOf(config)`: the acting user id (`config.user.id`, default `local-user`). The API takes the
 *   actor from config, never from a request body.
 */
import type { DatabaseSync } from 'node:sqlite';
import type { BifConfig } from '../config/schema.js';
import type { Store } from '../store/db.js';
import { Repo, newId, type TableSpec } from '../store/repos.js';
import { targetProvenance } from './provenance.js';

/** Actor of human actions when `config.user.id` is not set (BIF is single-user locally). */
export const DEFAULT_ACTOR = 'local-user';

export const FEEDBACK_KINDS = [
  /** Use / don't use an agent output (finding, recommendation, persona, competitor, hypothesis). */
  'include_override',
  /** The user edited the workspace profile directly. */
  'profile_edit',
  /** Unit proposal accepted unchanged. */
  'proposal_accept',
  /** Unit proposal accepted with edits (a correction signal; `beforeJson` = agent's proposal). */
  'proposal_edit',
  'proposal_reject',
  /** The user corrected a symptom hypothesis (distinct from agent revisions, which are Decisions). */
  'hypothesis_correction',
  /** The user resolved or denied an agent's user request. */
  'request_answer',
  /** Priority weights / persona weight changed. */
  'weights_change',
  /** A prompt calibration patch was approved and applied. */
  'prompt_patch_apply',
  /** A role's calibration appendix was reverted to an earlier version (integration: WP-B history). */
  'prompt_patch_revert',
  // --- knowledge store KS-2: human fact actions (target type `finding`) ---
  /** The user changed the nodes a fact applies to (`item_scopes`, source `user`). */
  'fact_scope_change',
  /** The user retracted a current fact. */
  'fact_retract',
  /** The user applied an unverified replacement (include override on a `candidate` version). */
  'fact_replacement_accept',
  // --- end KS-2 ---
] as const;
export type FeedbackKind = (typeof FEEDBACK_KINDS)[number];

/** What a feedback event acts on. `targetId`: the item id; workspace id (`profile`); role (`prompt`); `scoring` (`scoring_weights`). */
export type FeedbackTargetType =
  | 'finding'
  | 'recommendation'
  | 'persona'
  | 'competitor'
  | 'hypothesis'
  | 'profile'
  | 'unit_proposal'
  | 'user_request'
  | 'scoring_weights'
  | 'prompt';

export interface FeedbackEvent {
  id: string;
  workspaceId: string;
  /** Who acted (`config.user.id`). */
  actor: string;
  createdAt: string;
  kind: FeedbackKind;
  targetType: FeedbackTargetType;
  targetId: string;
  /** State before the action (JSON); absent when there was none. */
  beforeJson?: unknown;
  /** State after the action (JSON). */
  afterJson?: unknown;
  reason?: string;
  /** Agent run that produced the target (its judgment), when known. */
  agentRunId?: string;
  /** Prompt version of that run / judgment; for `prompt_patch_apply`, the patched role's new version. */
  promptVersion?: string;
}

export type FeedbackInput = Omit<FeedbackEvent, 'id' | 'createdAt' | 'actor'> & { actor?: string; createdAt?: string };

export type FeedbackFilter = {
  workspaceId?: string;
  kind?: FeedbackKind;
  targetType?: FeedbackTargetType;
  targetId?: string;
  actor?: string;
};

export type FeedbackListener = (store: Store, event: FeedbackEvent) => void;

const spec = {
  table: 'feedback_events',
  key: 'id',
  fields: {
    id: 'text', workspaceId: 'text', actor: 'text', createdAt: 'text', kind: 'text', targetType: 'text', targetId: 'text',
    beforeJson: 'json', afterJson: 'json', reason: 'text', agentRunId: 'text', promptVersion: 'text',
  },
} satisfies TableSpec<FeedbackEvent>;

const repos = new WeakMap<DatabaseSync, Repo<FeedbackEvent, 'id'>>();

function repo(store: Store): Repo<FeedbackEvent, 'id'> {
  let r = repos.get(store.db);
  if (!r) {
    r = new Repo<FeedbackEvent, 'id'>(store.db, spec);
    repos.set(store.db, r);
  }
  return r;
}

const listeners = new Set<FeedbackListener>();

/** Subscribes to every new feedback event (any store). Returns the unsubscribe function. */
export function onFeedback(listener: FeedbackListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The acting user: `config.user.id`, default `local-user`. */
export function actorOf(config: Pick<BifConfig, 'user'> | undefined): string {
  return config?.user?.id?.trim() || DEFAULT_ACTOR;
}

/** Target types whose provenance is an agent judgment (resolved when the caller does not give one). */
const AGENT_TARGETS: ReadonlySet<FeedbackTargetType> = new Set([
  'finding', 'recommendation', 'persona', 'competitor', 'hypothesis', 'unit_proposal', 'user_request',
]);

/** Appends one feedback event (never updated or deleted afterwards). */
export function recordFeedback(store: Store, input: FeedbackInput): FeedbackEvent {
  if (!(FEEDBACK_KINDS as readonly string[]).includes(input.kind)) throw new Error(`unknown feedback kind '${input.kind}'`);
  const event: FeedbackEvent = {
    id: newId('fbk'),
    workspaceId: input.workspaceId,
    actor: input.actor?.trim() || DEFAULT_ACTOR,
    createdAt: input.createdAt ?? new Date().toISOString(),
    kind: input.kind,
    targetType: input.targetType,
    targetId: input.targetId,
  };
  if (input.beforeJson !== undefined) event.beforeJson = input.beforeJson;
  if (input.afterJson !== undefined) event.afterJson = input.afterJson;
  if (input.reason?.trim()) event.reason = input.reason.trim();
  let { agentRunId, promptVersion } = input;
  if (agentRunId === undefined && promptVersion === undefined && AGENT_TARGETS.has(input.targetType)) {
    ({ agentRunId, promptVersion } = targetProvenance(store, input.workspaceId, input.targetType, input.targetId));
  }
  if (agentRunId !== undefined) event.agentRunId = agentRunId;
  if (promptVersion !== undefined) event.promptVersion = promptVersion;
  repo(store).insert(event);
  for (const l of listeners) l(store, event);
  return event;
}

/** Feedback events in log order (oldest first). */
export function listFeedback(store: Store, filter: FeedbackFilter = {}): FeedbackEvent[] {
  return repo(store).list(filter);
}

/** The most recent event matching `filter`, if any. */
export function latestFeedback(store: Store, filter: FeedbackFilter): FeedbackEvent | undefined {
  return listFeedback(store, filter).at(-1);
}
