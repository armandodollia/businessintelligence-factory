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
  // --- knowledge store KS-3 (design §13; wave-1 hook 1) ---
  /** The user merged two entities (target: the survivor). */
  'entity_merge',
  /** The user renamed an entity. */
  'entity_rename',
  // --- end knowledge store KS-3 ---
  // --- knowledge store KS-6 / KS-7 (design §13, §14; wave-1 hook 1) ---
  /** The user pruned an artifact's stored file (target type `artifact`; row, hash and text stay). */
  'artifact_prune',
  /** The user rejected an entity merge suggestion (target: the suggested entity). */
  'entity_merge_reject',
  // --- end knowledge store KS-6 / KS-7 ---
  // --- learning loop WP-E: lesson proposals (target type `lesson`, target id = the proposal) ---
  /** The user accepted a lesson proposal (rule added / strengthened / retired / reverted, or a retro edit applied). */
  'lesson_accept',
  /** The user rejected a lesson proposal (nothing changed). */
  'lesson_reject',
  // --- end learning loop WP-E ---
  // --- KS-8 final gate (Opus finding 5): every human action has an actor ---
  /** The user asked to retire an active rule (target type `lesson`, target id = the retire proposal). */
  'lesson_retire_request',
  /** The user ran the lessons engine now (target type `lessons`, target id = the business-tree root). */
  'lessons_evaluate',
  /** The user enabled / disabled or changed an audit schedule (target type `audit_schedule`). */
  'audit_schedule_change',
  /**
   * Re-gate (Opus 4): any other human-triggered change that has no record of its own — creating a
   * workspace, an interview message, an upload, starting research, a schedule change, a config change,
   * running the retro. `afterJson.action` names it; ids only (no user text, no file names).
   */
  'user_action',
  // --- end KS-8 final gate ---
  // --- flow records and ranking (flow design §10.4, §11): the user's reactions (`src/core/flows/feedback.ts`) ---
  /** Agree / disagree with a flow's ranking position (target type `flow`). */
  'flow_rank_reaction',
  /** Agree / disagree with a persona's head-to-head verdict (target type `flow_verdict`). */
  'flow_verdict_reaction',
  /** The user corrected a check's answer (target type `flow_check`, id `<flowId>:<checklistId>:<itemKey>`). */
  'flow_check_correction',
  /** The user ruled on a pair, kept or dropped a ruling after a new version, or revoked it (target type `flow`: the winner). */
  'flow_override',
  /** Accept, edit, reject or merge of a flow type (target type `flow_type`). */
  'flow_type_decision',
  /** Accept or reject of a checklist proposal (target type `checklist`). */
  'checklist_decision',
  /** The user changed a review mention's flow type / check (target type `review_mention`). */
  'review_attribution_correction',
  // --- end flow records and ranking ---
  // --- persona learning (design 2026-11-15-persona-learning-design.md) ---
  /** The user accepted a persona proposal, possibly edited (target type `persona_proposal`). */
  'persona_learning_accept',
  /** The user rejected a persona proposal (target type `persona_proposal`). */
  'persona_learning_reject',
  /** The user retired an active persona adjustment (target type `persona_adjustment`). */
  'persona_adjustment_retire',
  // --- end persona learning ---
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
  | 'prompt'
  // knowledge store KS-3: an entity (`entity_merge`, `entity_rename`)
  | 'entity'
  // knowledge store KS-6 / KS-7: an artifact (`artifact_prune`)
  | 'artifact'
  // learning loop WP-E: a lesson proposal (`lesson_accept`, `lesson_reject`, `lesson_retire_request`)
  | 'lesson'
  // KS-8 final gate: the lessons engine of a tree (`lessons_evaluate`), an audit schedule (`audit_schedule_change`)
  | 'lessons'
  | 'audit_schedule'
  // re-gate (Opus 4): `user_action` targets
  | 'workspace'
  | 'schedule'
  | 'config'
  // flow records and ranking: a flow version, a persona's verdict, a check answer, a flow type, a checklist, a review mention
  | 'flow'
  | 'flow_verdict'
  | 'flow_check'
  | 'flow_type'
  | 'checklist'
  | 'review_mention'
  // persona learning: a persona proposal (accept / reject), a persona adjustment (retire)
  | 'persona_proposal'
  | 'persona_adjustment';

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
  'flow', 'flow_verdict', 'flow_check', 'flow_type', 'review_mention',
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
