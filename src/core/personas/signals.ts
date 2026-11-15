/**
 * Persona signals (design 2026-11-15-persona-learning-design.md §5): the user's reactions to what a
 * persona said, computed on read from the persona's own workspace (feedback events and ratings);
 * nothing is stored for them.
 *
 * - `verdict_reaction`: the latest `flow_verdict_reaction` per verdict of the persona.
 * - `override`: each persona verdict recorded with a ruling that still stands (`flow_override`, action
 *   `create`: per lineage pair the latest one, unless a later `revoke` or `drop` ended it); agrees when
 *   the persona's winner is the user's, else disagrees (a tie disagrees). Id `<event id>:<verdict id>`.
 *   Dropped for a verdict the user also reacted to (the explicit reaction counts).
 * - `feedback_rating`: the latest rating per criterion of the persona's panel feedback
 *   (`<recId>:<personaId>`), unless the persona revised that feedback since (stale).
 * - `profile_rating`: the latest rating per profile field.
 * - `include`: the latest include override of the persona; a cleared one gives none.
 * - `read_reaction` (stakeholder personas, stakeholder design §11): the latest
 *   `stakeholder_read_reaction` per read of the persona; item `rec:<id>`, topic `read`.
 * - `decision_record` (stakeholder personas): the latest recorded real decision per recommendation,
 *   compared with the persona's read of it (`decisionPolarity`); none without a read, for `deferred`
 *   or for `not_my_call`. Id `<statement id>:<read id>`; item `rec:<id>`, topic `decision`. The
 *   statement's text is not a reason here (the run is shown it as a statement); refs hold the read
 *   and the recommendation, never the statement.
 *
 * `flow_rank_reaction` events judge a ranking position, not a persona: never a signal. `detail` lines
 * are built from titles, ids, enums and numbers only, never evidence text.
 */
import { listFeedback, type FeedbackEvent } from '../feedback/events.js';
import { isRatingStale, judgmentIndex } from '../feedback/provenance.js';
import { flowRepos } from '../flows/repos.js';
import { PERSONA_FEEDBACK_KEYS } from '../scoring/criteria.js';
import { stakeholderRepos } from '../stakeholders/store.js';
import type { StakeholderStatement } from '../stakeholders/types.js';
import type { Store } from '../store/db.js';
import type { Rating } from '../types.js';
import type { PersonaLearningSettings } from './settings.js';
import { personaLearningRepos } from './store.js';
import type { PersonaSignal } from './types.js';

type Window = { since?: string; until?: string };

type VerdictReaction = { reaction?: unknown; personaId?: unknown; personaVersion?: unknown; flowAId?: unknown; flowBId?: unknown; winner?: unknown };
type RecordedVerdict = { id: string; personaId: string; personaVersion?: number; winnerFlowId: string | null };
type OverrideEvent = { action?: unknown; overrideId?: unknown; flowTypeId?: unknown; winnerFlowId?: unknown; loserFlowId?: unknown; verdicts?: unknown };
type OverrideCreate = OverrideEvent & { action: 'create'; winnerFlowId: string; loserFlowId: string; verdicts: unknown[] };

const DAY_MS = 24 * 60 * 60 * 1000;
const FEEDBACK_CRITERIA: ReadonlySet<string> = new Set(PERSONA_FEEDBACK_KEYS);

const withReason = (reason: string | undefined) => (reason ? { reason } : {});
const reacted = (polarity: PersonaSignal['polarity']) => (polarity === 'agree' ? 'you agreed' : 'you disagreed');

/** Last item per key, in the order given (logs are oldest first). */
function latestBy<T>(items: T[], key: (x: T) => string): T[] {
  const out = new Map<string, T>();
  for (const x of items) out.set(key(x), x);
  return [...out.values()];
}

/** Flow lookups for pair keys, topics and detail lines (cached per call). */
function flowInfo(store: Store) {
  const r = flowRepos(store);
  const flows = new Map<string, ReturnType<typeof r.flows.get>>();
  const flow = (id: string) => {
    if (!flows.has(id)) flows.set(id, r.flows.get(id));
    return flows.get(id);
  };
  const lineage = (id: string) => flow(id)?.lineageId ?? id;
  return {
    /** The flow's name, or its id when the row is gone. */
    title: (id: string) => flow(id)?.name ?? id,
    /** The flow's lineage id (its id when the row is gone). */
    lineage,
    /** The two flows' lineage ids, sorted, joined with `|`. */
    pairKey: (x: string, y: string) => [lineage(x), lineage(y)].sort().join('|'),
    /** `flow:<flow type key>` (the type id when the type row is gone). */
    topic: (flowTypeId: string | undefined) => `flow:${(flowTypeId && r.flowTypes.get(flowTypeId)?.key) ?? flowTypeId ?? 'unknown'}`,
    verdict: (id: string) => r.flowVerdicts.get(id),
    flow,
  };
}

/** "picked A over B (strength 2)" / "called A and B a tie" for a persona verdict. */
function verdictLine(info: ReturnType<typeof flowInfo>, a: string, b: string, winnerFlowId: string | null, strength?: number): string {
  if (winnerFlowId === null) return `called ${info.title(a)} and ${info.title(b)} a tie`;
  const loser = info.lineage(winnerFlowId) === info.lineage(a) ? b : a;
  return `picked ${info.title(winnerFlowId)} over ${info.title(loser)}${strength ? ` (strength ${strength})` : ''}`;
}

function verdictReactions(store: Store, workspaceId: string, personaId: string, info: ReturnType<typeof flowInfo>): PersonaSignal[] {
  const events = listFeedback(store, { workspaceId, kind: 'flow_verdict_reaction', targetType: 'flow_verdict' })
    .filter((e) => (e.afterJson as VerdictReaction | undefined)?.personaId === personaId);
  const out: PersonaSignal[] = [];
  for (const e of latestBy(events, (x) => x.targetId)) {
    const a = e.afterJson as VerdictReaction;
    if ((a.reaction !== 'agree' && a.reaction !== 'disagree') || typeof a.flowAId !== 'string' || typeof a.flowBId !== 'string') continue;
    const v = info.verdict(e.targetId);
    const winnerFlowId = a.winner === 'a' ? a.flowAId : a.winner === 'b' ? a.flowBId : null;
    out.push({
      id: e.id,
      source: 'verdict_reaction',
      personaId,
      ...(typeof a.personaVersion === 'number' ? { personaVersion: a.personaVersion } : {}),
      polarity: a.reaction,
      itemKey: info.pairKey(a.flowAId, a.flowBId),
      topic: info.topic(v?.flowTypeId ?? info.flow(a.flowAId)?.flowTypeId),
      detail: `${verdictLine(info, a.flowAId, a.flowBId, winnerFlowId, v?.strength)}; ${reacted(a.reaction)}`,
      ...withReason(e.reason),
      refs: [e.targetId, a.flowAId, a.flowBId],
      at: e.createdAt,
    });
  }
  return out;
}

function isRecordedVerdict(x: unknown): x is RecordedVerdict {
  const v = x as RecordedVerdict | null;
  return !!v && typeof v.id === 'string' && typeof v.personaId === 'string' && (typeof v.winnerFlowId === 'string' || v.winnerFlowId === null);
}

const isCreate = (a: OverrideEvent | undefined): a is OverrideCreate =>
  a?.action === 'create' && typeof a.winnerFlowId === 'string' && typeof a.loserFlowId === 'string' && Array.isArray(a.verdicts);

/** The `create` events of the rulings that still stand: the latest per lineage pair, unless revoked or dropped since. */
function standingRulings(store: Store, workspaceId: string, info: ReturnType<typeof flowInfo>): Array<{ e: FeedbackEvent; a: OverrideCreate }> {
  const latest = new Map<string, { e: FeedbackEvent; a: OverrideCreate }>();
  const ended = new Set<string>();
  for (const e of listFeedback(store, { workspaceId, kind: 'flow_override' })) {
    const a = e.afterJson as OverrideEvent | undefined;
    if (isCreate(a)) latest.set(info.pairKey(a.winnerFlowId, a.loserFlowId), { e, a });
    else if ((a?.action === 'revoke' || a?.action === 'drop') && typeof a.overrideId === 'string') ended.add(a.overrideId);
  }
  return [...latest.values()].filter(({ a }) => typeof a.overrideId !== 'string' || !ended.has(a.overrideId));
}

function overrides(store: Store, workspaceId: string, personaId: string, info: ReturnType<typeof flowInfo>, reactedTo: Set<string>): PersonaSignal[] {
  const out: PersonaSignal[] = [];
  for (const { e, a } of standingRulings(store, workspaceId, info)) {
    const { winnerFlowId, loserFlowId } = a;
    for (const v of a.verdicts) {
      if (!isRecordedVerdict(v) || v.personaId !== personaId || reactedTo.has(v.id)) continue;
      // Verdicts are on the lineages' current versions; the ruling may name older ones.
      const polarity = v.winnerFlowId !== null && info.lineage(v.winnerFlowId) === info.lineage(winnerFlowId) ? 'agree' : 'disagree';
      const row = info.verdict(v.id);
      const [x, y] = row ? [row.flowAId, row.flowBId] : [winnerFlowId, loserFlowId];
      out.push({
        id: `${e.id}:${v.id}`,
        source: 'override',
        personaId,
        ...(typeof v.personaVersion === 'number' ? { personaVersion: v.personaVersion } : {}),
        polarity,
        itemKey: info.pairKey(winnerFlowId, loserFlowId),
        topic: info.topic(typeof a.flowTypeId === 'string' ? a.flowTypeId : undefined),
        detail: `${verdictLine(info, x, y, v.winnerFlowId, row?.strength)}; you ruled ${info.title(winnerFlowId)} over ${info.title(loserFlowId)}`,
        ...withReason(e.reason),
        refs: [v.id, winnerFlowId, loserFlowId],
        at: e.createdAt,
      });
    }
  }
  return out;
}

const ratingAnswer = (r: Rating) => (r.verdict === 'agree' ? 'you agreed' : `you set ${String(r.userValue)}`);

function ratings(store: Store, workspaceId: string, personaId: string): PersonaSignal[] {
  const all = store.ratings.list({ workspaceId });
  const out: PersonaSignal[] = [];
  const suffix = `:${personaId}`;
  const panel = all.filter((r) => r.targetType === 'persona_feedback' && r.targetId.endsWith(suffix) && FEEDBACK_CRITERIA.has(r.criterion));
  const index = panel.length ? judgmentIndex(store, workspaceId) : undefined;
  for (const r of latestBy(panel, (x) => `${x.targetId}|${x.criterion}`)) {
    if (isRatingStale(r, index!)) continue;
    const recId = r.targetId.slice(0, -suffix.length);
    out.push({
      id: r.id, source: 'feedback_rating', personaId, polarity: r.verdict, itemKey: `rec:${recId}`, topic: `recommendation:${r.criterion}`,
      detail: `rated ${r.criterion} ${String(r.agentValue)} for ${recId}; ${ratingAnswer(r)}`, ...withReason(r.reason), refs: [recId], at: r.createdAt,
    });
  }
  const profile = all.filter((r) => r.targetType === 'persona' && r.targetId === personaId);
  for (const r of latestBy(profile, (x) => x.criterion)) {
    out.push({
      id: r.id, source: 'profile_rating', personaId, polarity: r.verdict, itemKey: `field:${r.criterion}`, topic: `profile:${r.criterion}`,
      detail: `rated ${r.criterion} confidence ${String(r.agentValue)}; ${ratingAnswer(r)}`, ...withReason(r.reason), refs: [personaId], at: r.createdAt,
    });
  }
  return out;
}

function include(store: Store, workspaceId: string, personaId: string): PersonaSignal[] {
  const e: FeedbackEvent | undefined = listFeedback(store, { workspaceId, kind: 'include_override', targetType: 'persona', targetId: personaId }).at(-1);
  const value = (e?.afterJson as { include?: unknown } | undefined)?.include;
  if (!e || typeof value !== 'boolean') return [];
  return [{
    id: e.id, source: 'include', personaId, polarity: value ? 'agree' : 'disagree', itemKey: 'persona', topic: 'persona',
    detail: value ? 'you included the persona' : 'you left the persona out', ...withReason(e.reason), refs: [personaId], at: e.createdAt,
  }];
}

type ReadReaction = { reaction?: unknown; personaId?: unknown; personaVersion?: unknown; recommendationId?: unknown; stance?: unknown };

function readReactions(store: Store, workspaceId: string, personaId: string): PersonaSignal[] {
  const events = listFeedback(store, { workspaceId, kind: 'stakeholder_read_reaction', targetType: 'stakeholder_read' })
    .filter((e) => (e.afterJson as ReadReaction | undefined)?.personaId === personaId);
  const out: PersonaSignal[] = [];
  for (const e of latestBy(events, (x) => x.targetId)) {
    const a = e.afterJson as ReadReaction;
    if ((a.reaction !== 'agree' && a.reaction !== 'disagree') || typeof a.recommendationId !== 'string') continue;
    const stance = typeof a.stance === 'string' ? a.stance : 'unknown';
    out.push({
      id: e.id, source: 'read_reaction', personaId, ...(typeof a.personaVersion === 'number' ? { personaVersion: a.personaVersion } : {}),
      polarity: a.reaction, itemKey: `rec:${a.recommendationId}`, topic: 'read',
      detail: `read ${a.recommendationId}: ${stance}; ${reacted(a.reaction)}`, ...withReason(e.reason), refs: [e.targetId, a.recommendationId], at: e.createdAt,
    });
  }
  return out;
}

/** Read stances a real decision agrees with (stakeholder design §11); `deferred` is in none. */
const AGREEING_STANCES: Readonly<Record<string, readonly string[]>> = {
  approved: ['approve', 'approve_with_conditions'],
  approved_with_conditions: ['approve', 'approve_with_conditions'],
  rejected: ['reject'],
};

/**
 * A recorded real decision against the persona's read of the same recommendation: `agree` when the
 * decision matches the stance (`AGREEING_STANCES`), else `disagree`; undefined (no signal) for a
 * `deferred` decision or a `not_my_call` read.
 */
export function decisionPolarity(decision: string, stance: string): PersonaSignal['polarity'] | undefined {
  if (decision === 'deferred' || stance === 'not_my_call') return undefined;
  return AGREEING_STANCES[decision]?.includes(stance) ? 'agree' : 'disagree';
}

function decisionRecords(store: Store, personaId: string): PersonaSignal[] {
  const repos = stakeholderRepos(store);
  const records = repos.statements
    .list({ personaId, source: 'decision_record' })
    .filter((s): s is StakeholderStatement & { recommendationId: string; decision: string } => !!s.recommendationId && !!s.decision)
    .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const out: PersonaSignal[] = [];
  for (const s of latestBy(records, (x) => x.recommendationId)) {
    const read = repos.reads.list({ recommendationId: s.recommendationId, personaId })[0];
    const polarity = read ? decisionPolarity(s.decision, read.stance) : undefined;
    if (!read || !polarity) continue;
    out.push({
      id: `${s.id}:${read.id}`, source: 'decision_record', personaId, personaVersion: read.personaVersion, polarity,
      itemKey: `rec:${s.recommendationId}`, topic: 'decision',
      detail: `read ${s.recommendationId}: ${read.stance}; the real decision: ${s.decision}`, refs: [read.id, s.recommendationId], at: s.createdAt,
    });
  }
  return out;
}

/**
 * All signals of a persona, oldest first; `since` keeps those after it, `until` those at or before it.
 * The latest-per-item rules apply to the whole log, then the window. Empty for an unknown persona.
 */
export function collectPersonaSignals(store: Store, personaId: string, window: Window = {}): PersonaSignal[] {
  const persona = store.personas.get(personaId);
  if (!persona) return [];
  const ws = persona.workspaceId;
  const info = flowInfo(store);
  const reactions = verdictReactions(store, ws, personaId, info);
  const reactedTo = new Set(reactions.map((s) => s.refs[0]!));
  const all = [
    ...reactions, ...overrides(store, ws, personaId, info, reactedTo), ...ratings(store, ws, personaId), ...include(store, ws, personaId),
    ...readReactions(store, ws, personaId), ...decisionRecords(store, personaId),
  ];
  return all
    .filter((s) => (window.since === undefined || s.at > window.since) && (window.until === undefined || s.at <= window.until))
    .sort((x, y) => (x.at < y.at ? -1 : x.at > y.at ? 1 : 0));
}

/** The `signalsThrough` of the persona's latest learning run that ended `proposed` or `no_change`, if any (signals up to it are consumed). */
export function consumedThrough(store: Store, personaId: string): string | undefined {
  return personaLearningRepos(store)
    .runs.list({ personaId })
    .filter((r) => (r.status === 'proposed' || r.status === 'no_change') && r.signalsThrough)
    .reduce<string | undefined>((max, r) => (max === undefined || r.signalsThrough > max ? r.signalsThrough : max), undefined);
}

/**
 * Open signals of a persona: newer than the `signalsThrough` of its latest learning run that ended
 * `proposed` or `no_change` (a failed run consumes nothing), and not older than `windowDays` before `now`.
 */
export function openSignals(store: Store, settings: PersonaLearningSettings, personaId: string, now: Date): PersonaSignal[] {
  const consumed = consumedThrough(store, personaId);
  const cutoff = new Date(now.getTime() - settings.windowDays * DAY_MS).toISOString();
  return collectPersonaSignals(store, personaId, consumed !== undefined ? { since: consumed } : {}).filter((s) => s.at >= cutoff);
}
