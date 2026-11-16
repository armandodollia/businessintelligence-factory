/**
 * The user's interactions (user persona design §6, §7, §16): one person's actions in a business tree,
 * computed on read from the feedback log and the ratings of every node of the tree; nothing is stored.
 *
 * - Only the events and ratings whose `actor` is the given person count; a row with no actor counts for
 *   the default actor (`actorOf(undefined)`).
 * - `stance` per feedback kind is decided in `STANCE_BY_KIND` (every kind has an entry). Ratings:
 *   `agree` is `accept`, `disagree` is `edit` (the user set another value). The rating a unit proposal
 *   decision writes beside its `proposal_*` event is left out (the event counts).
 * - `target` is `<targetType>:<targetId>`; `topic` the feedback kind, or `rating:<targetType>`.
 * - `detail` is built from the kind, the target, enums, numbers and ids only (never a reason, a name or
 *   evidence text); `reason` is the user's typed reason as stored; `refs` the ids it rests on (for the
 *   upload check).
 * - Open: newer than the `signalsThrough` of the person's user persona's latest run that ended
 *   `proposed` or `no_change`, not older than `windowDays`, and not `neutral`.
 */
import { actorOf, listFeedback, type FeedbackEvent, type FeedbackKind } from '../feedback/events.js';
import { UNIT_PROPOSAL_CRITERION } from '../feedback/signals.js';
import { consumedThrough } from '../personas/signals.js';
import type { Store } from '../store/db.js';
import type { Rating } from '../types.js';
import { descendants, rootOf } from '../workspace/tree.js';
import { userPersonaOf } from './persona.js';
import type { UserPersonaSettings } from './settings.js';

export type Stance = 'accept' | 'reject' | 'edit' | 'neutral';

export type Interaction = {
  /** Feedback event id or rating id. */
  id: string;
  /** The feedback kind, or `rating`. */
  kind: string;
  stance: Stance;
  /** `<targetType>:<targetId>`: the thing acted on. */
  target: string;
  /** The feedback kind, or `rating:<targetType>`. */
  topic: string;
  /** One line from the kind, ids, enums and numbers; never evidence text. */
  detail: string;
  /** The user's typed reason, as stored. */
  reason?: string;
  /** Ids it rests on (for the upload check). */
  refs: string[];
  at: string;
};

type Window = { since?: string; until?: string };

const DAY_MS = 24 * 60 * 60 * 1000;

const after = (e: Pick<FeedbackEvent, 'afterJson'>): Record<string, unknown> =>
  e.afterJson && typeof e.afterJson === 'object' ? (e.afterJson as Record<string, unknown>) : {};

/** `agree` / `disagree` reactions (flow ranks, persona verdicts, stakeholder reads); a cleared one is neutral. */
const byReaction = (e: FeedbackEvent): Stance => {
  const r = after(e).reaction;
  return r === 'agree' ? 'accept' : r === 'disagree' ? 'reject' : 'neutral';
};

/** Decisions with an `action` field (flow types, checklists): accept, reject, or anything changed is an edit. */
const byAction = (e: FeedbackEvent): Stance => {
  const a = after(e).action;
  return a === 'accept' ? 'accept' : a === 'reject' ? 'reject' : a === 'edit' || a === 'merge' ? 'edit' : 'neutral';
};

/**
 * The stance of each feedback kind (design §6): accepting, agreeing, including and applying are `accept`;
 * rejecting, disagreeing, excluding, retracting, retiring and reverting are `reject`; anything accepted
 * with changes, a correction, an override or an edit is `edit`; the rest (housekeeping, schedules,
 * config, information the user gives) is `neutral`. A kind that covers more than one outcome reads it
 * from the event.
 */
export const STANCE_BY_KIND: Record<FeedbackKind, Stance | ((e: FeedbackEvent) => Stance)> = {
  include_override: (e) => {
    const v = after(e).include;
    return v === true ? 'accept' : v === false ? 'reject' : 'neutral';
  },
  profile_edit: 'edit',
  proposal_accept: 'accept',
  proposal_edit: 'edit',
  proposal_reject: 'reject',
  hypothesis_correction: 'edit',
  // Only an `approval` request asks for a judgement (resolved: accept, denied: reject); answering a
  // register, login, captcha, other or escalation request is service to the run (neutral).
  request_answer: (e) => {
    const kind = (e.beforeJson && typeof e.beforeJson === 'object' ? (e.beforeJson as Record<string, unknown>) : {}).kind;
    if (kind !== 'approval') return 'neutral';
    const status = after(e).status;
    return status === 'resolved' ? 'accept' : status === 'denied' ? 'reject' : 'neutral';
  },
  // The user changed what the scoring weighs: a correction of the tool's priorities.
  weights_change: 'edit',
  prompt_patch_apply: 'accept',
  prompt_patch_revert: 'reject',
  fact_scope_change: 'edit',
  fact_retract: 'reject',
  fact_replacement_accept: 'accept',
  entity_merge: 'edit',
  entity_rename: 'edit',
  // Pruning a stored file is housekeeping, not a judgment of agent output.
  artifact_prune: 'neutral',
  entity_merge_reject: 'reject',
  lesson_accept: 'accept',
  lesson_reject: 'reject',
  lesson_retire_request: 'reject',
  lessons_evaluate: 'neutral',
  audit_schedule_change: 'neutral',
  user_action: 'neutral',
  flow_rank_reaction: byReaction,
  flow_verdict_reaction: byReaction,
  flow_check_correction: 'edit',
  // `create`: a ruling over the tool's order; `keep`: the ruling still holds; `revoke` / `drop`: withdrawn.
  flow_override: (e) => {
    const a = after(e).action;
    return a === 'create' ? 'edit' : a === 'keep' ? 'accept' : a === 'revoke' || a === 'drop' ? 'reject' : 'neutral';
  },
  flow_type_decision: byAction,
  checklist_decision: byAction,
  review_attribution_correction: 'edit',
  persona_learning_accept: (e) => (after(e).finalText !== undefined ? 'edit' : 'accept'),
  persona_learning_reject: 'reject',
  persona_adjustment_retire: 'reject',
  // What the user tells about stakeholders is information, not a judgment of the tool's output.
  stakeholder_answers: 'neutral',
  stakeholder_reveal: 'neutral',
  stakeholder_note: 'neutral',
  stakeholder_decision_record: 'neutral',
  stakeholder_read_reaction: byReaction,
  // Recording that someone left, moved or returned is information about the world, not a judgment.
  stakeholder_position_change: 'neutral',
};

/** Fields of `afterJson` shown in a detail line, when their value is an enum, a number or a boolean. */
const DETAIL_KEYS = ['action', 'reaction', 'include', 'status', 'stage', 'position', 'choice', 'coverage'] as const;
const ENUM = /^[a-z][a-z0-9_]{0,31}$/;

function shown(v: unknown): string | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  if (typeof v === 'boolean' || v === null) return String(v);
  if (typeof v === 'string' && ENUM.test(v)) return v;
  return undefined;
}

/** A rating value: a number, or a short value of digits, signs and units (never free text). */
function ratingValue(v: unknown): string {
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  if (typeof v === 'string' && (ENUM.test(v) || /^[0-9$€£%.,kKmM~+\-–↑→↓ ]{1,24}$/.test(v))) return v;
  return '(value)';
}

/** Id-like strings an event rests on: the target id's parts and `…Id` fields of `afterJson`. */
function eventRefs(e: FeedbackEvent): string[] {
  const out = new Set(e.targetId.split(':').filter(Boolean));
  for (const [k, v] of Object.entries(after(e))) if (k.endsWith('Id') && typeof v === 'string' && v) out.add(v);
  return [...out];
}

const withReason = (reason: string | undefined) => (reason ? { reason } : {});

function fromEvent(e: FeedbackEvent): Interaction {
  const rule = STANCE_BY_KIND[e.kind];
  const stance = typeof rule === 'function' ? rule(e) : (rule ?? 'neutral');
  const a = after(e);
  const bits = DETAIL_KEYS.flatMap((k) => {
    const v = shown(a[k]);
    return v === undefined ? [] : [`${k}=${v}`];
  });
  return {
    id: e.id, kind: e.kind, stance, target: `${e.targetType}:${e.targetId}`, topic: e.kind,
    detail: `${e.kind} on ${e.targetType} ${e.targetId}${bits.length ? `: ${bits.join(', ')}` : ''}`,
    ...withReason(e.reason), refs: eventRefs(e), at: e.createdAt,
  };
}

/** An enum-shaped label (target type, criterion), else a placeholder: never stored free text. */
const label = (v: unknown): string => (typeof v === 'string' && ENUM.test(v) ? v : '(label)');

function fromRating(r: Rating): Interaction {
  const answer = r.verdict === 'agree' ? 'you agreed' : `you set ${ratingValue(r.userValue)}`;
  return {
    // The target type is checked like every other label before it can reach a prompt (topic heading, target).
    id: r.id, kind: 'rating', stance: r.verdict === 'agree' ? 'accept' : 'edit', target: `${label(r.targetType)}:${r.targetId}`, topic: `rating:${label(r.targetType)}`,
    detail: `rated ${label(r.targetType)} ${r.targetId} ${label(r.criterion)}: tool said ${ratingValue(r.agentValue)}; ${answer}`,
    ...withReason(r.reason), refs: r.targetId.split(':').filter(Boolean), at: r.createdAt,
  };
}

/** The acting person of a stored row (no actor: the default actor). */
const actorOfRow = (actor: string | undefined) => actor?.trim() || actorOf(undefined);

/**
 * One person's interactions in the business tree of `rootWorkspaceId` (every node), oldest first;
 * `since` keeps those after it, `until` those at or before it.
 */
export function collectInteractions(store: Store, rootWorkspaceId: string, actor: string, window: Window = {}): Interaction[] {
  const root = rootOf(store, rootWorkspaceId);
  const nodes = [root, ...descendants(store, root).map((w) => w.id)];
  const out: Interaction[] = [];
  for (const ws of nodes) {
    for (const e of listFeedback(store, { workspaceId: ws })) if (actorOfRow(e.actor) === actor) out.push(fromEvent(e));
    for (const r of store.ratings.list({ workspaceId: ws })) {
      // The rating of a unit proposal decision mirrors its `proposal_*` event: the event counts.
      if (r.targetType === 'decision' && r.criterion === UNIT_PROPOSAL_CRITERION) continue;
      if (actorOfRow(r.actor) === actor) out.push(fromRating(r));
    }
  }
  return out
    .filter((x) => (window.since === undefined || x.at > window.since) && (window.until === undefined || x.at <= window.until))
    .sort((x, y) => (x.at < y.at ? -1 : x.at > y.at ? 1 : x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
}

/** The actors with feedback events or ratings anywhere in the business tree of `rootWorkspaceId`, in id order (no actor: the default actor). */
export function interactionActors(store: Store, rootWorkspaceId: string): string[] {
  const root = rootOf(store, rootWorkspaceId);
  const actors = new Set<string>();
  for (const ws of [root, ...descendants(store, root).map((w) => w.id)]) {
    for (const e of listFeedback(store, { workspaceId: ws })) actors.add(actorOfRow(e.actor));
    for (const r of store.ratings.list({ workspaceId: ws })) actors.add(actorOfRow(r.actor));
  }
  return [...actors].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * One person's open interactions: newer than what their user persona's latest finished learning run
 * read (`proposed` or `no_change`; a failed run consumes nothing), not older than `windowDays` before
 * `now`, and not `neutral`.
 */
export function openInteractions(store: Store, settings: UserPersonaSettings, rootWorkspaceId: string, actor: string, now: Date): Interaction[] {
  const persona = userPersonaOf(store, rootWorkspaceId, actor);
  const consumed = persona ? consumedThrough(store, persona.id) : undefined;
  const cutoff = new Date(now.getTime() - settings.windowDays * DAY_MS).toISOString();
  return collectInteractions(store, rootWorkspaceId, actor, consumed !== undefined ? { since: consumed } : {}).filter(
    (x) => x.at >= cutoff && x.stance !== 'neutral',
  );
}

export type InteractionStats = { byKind: Record<string, Partial<Record<Stance, number>>>; total: number };

/** Counts by kind and stance (neutral ones included). */
export function interactionStats(interactions: Interaction[]): InteractionStats {
  const byKind: InteractionStats['byKind'] = {};
  for (const x of interactions) {
    const k = (byKind[x.kind] ??= {});
    k[x.stance] = (k[x.stance] ?? 0) + 1;
  }
  return { byKind, total: interactions.length };
}

export type InteractionGate = { n: number; targets: number; qualifies: boolean; missing: string[] };

/**
 * The gate (design §7): at least `minInteractions` open actions (neutral ones do not count) on at least
 * `minDistinctTargets` different targets. `missing` says what is short, actions first.
 */
export function interactionGate(open: Interaction[], settings: UserPersonaSettings): InteractionGate {
  const counted = open.filter((x) => x.stance !== 'neutral');
  const n = counted.length;
  const targets = new Set(counted.map((x) => x.target)).size;
  const missing: string[] = [];
  if (n < settings.minInteractions) missing.push(`${n} of ${settings.minInteractions} actions`);
  if (targets < settings.minDistinctTargets) missing.push(`${targets} of ${settings.minDistinctTargets} different things`);
  return { n, targets, qualifies: missing.length === 0, missing };
}
