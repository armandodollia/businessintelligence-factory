/**
 * The user's reactions to flow rankings (design 2026-11-14-flow-records-and-ranking-design.md §10.4,
 * §11): agree / disagree with a position or a persona's verdict, rule on a pair (override), correct a
 * check's answer, decide a flow type or checklist proposal, edit an active checklist, correct a review
 * mention's attribution.
 *
 * - Every action records exactly one `feedback_events` row naming what it reacts to, with the user's
 *   optional reason (trimmed, at most `REASON_MAX`, stored redacted and fence-stripped: the user may
 *   paste third-party text). Agreement is stored exactly like disagreement. These rows are the
 *   signals a later project uses to improve personas.
 * - Nothing here changes a persona or a verdict. A disagreement only makes the pair eligible for a
 *   focused re-judgment in the next ranking round (`disagreedPairs`, read by the round).
 * - Overrides apply to flow lineages: the stored ids are the versions the user ruled on; the ranking
 *   maps them to the current versions (`nodeRanking`). Once either lineage has a newer version,
 *   `refreshOverrides` marks the override `needsConfirm` (still applied) until the user keeps it
 *   (re-pointed at the current versions) or drops it (`confirmOverride`).
 * - Isolation: an id outside the caller's business tree is refused exactly like an unknown id
 *   (`FlowFeedbackError` 404). `reactToVerdict`, `revokeOverride` and `confirmOverride` take no
 *   workspace: callers check the id first with `ownVerdict` / `ownOverride`.
 */
import type { BifConfig } from '../config/schema.js';
import { listFeedback, recordFeedback, type FeedbackEvent } from '../feedback/events.js';
import { redactServed, stripFences } from '../knowledge/trust.js';
import type { Store } from '../store/db.js';
import { newId } from '../store/repos.js';
import { rootOf } from '../workspace/tree.js';
import { activeChecklists, decideChecklistDetailed, decideFlowType, editChecklist, flowTypeByKey, type ChecklistItemEdit } from './catalog.js';
import { applyReviewChecks, correctCheck } from './checks.js';
import { flowsSettings } from './config.js';
import { currentOfLineage, isPrimaryVariant } from './flows.js';
import { nodeRanking } from './rankings.js';
import { flowRepos } from './repos.js';
import type { CheckAnswer, Checklist, Flow, FlowCheck, FlowOverride, FlowType, FlowVerdict, ReviewMention } from './types.js';
import { liveVerdicts } from './verdicts.js';

export type Reaction = 'agree' | 'disagree';

/** Longest reason the user can give (characters, after trimming). */
export const REASON_MAX = 2000;

/** Refusal of a user action; `status` is the HTTP status the API answers with. */
export class FlowFeedbackError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409 = 400,
  ) {
    super(message);
    this.name = 'FlowFeedbackError';
  }
}

const REACTIONS: readonly Reaction[] = ['agree', 'disagree'];

function checkReaction(reaction: Reaction): void {
  if (!REACTIONS.includes(reaction)) throw new FlowFeedbackError("reaction must be 'agree' or 'disagree'");
}

/** The reason as stored: trimmed, at most `REASON_MAX`, identity secrets redacted, fences removed; undefined when empty. */
export function cleanReason(store: Store, workspaceId: string, reason: string | undefined): string | undefined {
  if (reason === undefined || reason === null) return undefined;
  if (typeof reason !== 'string') throw new FlowFeedbackError('reason must be a text');
  const trimmed = reason.trim();
  if (trimmed.length > REASON_MAX) throw new FlowFeedbackError(`reason is at most ${REASON_MAX.toLocaleString('en-US')} characters`);
  return stripFences(redactServed(store, workspaceId, trimmed)).trim() || undefined;
}

const sameTree = (store: Store, workspaceId: string, otherWorkspaceId: string) => rootOf(store, otherWorkspaceId) === rootOf(store, workspaceId);

/** The flow, of the caller's tree; 404 otherwise. */
export function ownFlow(store: Store, workspaceId: string, flowId: string): Flow {
  const f = typeof flowId === 'string' ? flowRepos(store).flows.get(flowId) : undefined;
  if (!f || f.rootWorkspaceId !== rootOf(store, workspaceId)) throw new FlowFeedbackError(`flow '${flowId}' not found`, 404);
  return f;
}

/** The flow type, of the caller's tree; 404 otherwise. */
export function ownFlowType(store: Store, workspaceId: string, flowTypeId: string): FlowType {
  const t = typeof flowTypeId === 'string' ? flowRepos(store).flowTypes.get(flowTypeId) : undefined;
  if (!t || t.rootWorkspaceId !== rootOf(store, workspaceId)) throw new FlowFeedbackError(`flow type '${flowTypeId}' not found`, 404);
  return t;
}

/** The verdict, of the caller's tree; 404 otherwise. */
export function ownVerdict(store: Store, workspaceId: string, verdictId: string): FlowVerdict {
  const v = typeof verdictId === 'string' ? flowRepos(store).flowVerdicts.get(verdictId) : undefined;
  if (!v || !sameTree(store, workspaceId, v.workspaceId)) throw new FlowFeedbackError(`verdict '${verdictId}' not found`, 404);
  return v;
}

/** The override, of the caller's tree; 404 otherwise. */
export function ownOverride(store: Store, workspaceId: string, overrideId: string): FlowOverride {
  const o = typeof overrideId === 'string' ? flowRepos(store).flowOverrides.get(overrideId) : undefined;
  if (!o || !sameTree(store, workspaceId, o.workspaceId)) throw new FlowFeedbackError(`override '${overrideId}' not found`, 404);
  return o;
}

function ownChecklist(store: Store, workspaceId: string, checklistId: string): Checklist {
  const c = typeof checklistId === 'string' ? flowRepos(store).checklists.get(checklistId) : undefined;
  if (!c || c.rootWorkspaceId !== rootOf(store, workspaceId)) throw new FlowFeedbackError(`checklist '${checklistId}' not found`, 404);
  return c;
}

function ownMention(store: Store, workspaceId: string, mentionId: string): ReviewMention {
  const m = typeof mentionId === 'string' ? flowRepos(store).reviewMentions.get(mentionId) : undefined;
  if (!m || m.rootWorkspaceId !== rootOf(store, workspaceId)) throw new FlowFeedbackError(`review mention '${mentionId}' not found`, 404);
  return m;
}

const withReason = (reason: string | undefined) => (reason !== undefined ? { reason } : {});

// ---------------------------------------------------------------------------
// reactions

/**
 * Agree / disagree with a flow's position in the node's ranking of `flowTypeId`. With `config`, the
 * position as the user saw it is recorded too (position, scores, what decided it), from the ranking
 * the flow takes part in (every variant when the flow is not its subject's primary, `isPrimaryVariant`);
 * `ranked: false` when it is in none (a proposed flow type is not ranked).
 */
export function reactToPosition(
  store: Store,
  actor: string,
  workspaceId: string,
  flowId: string,
  flowTypeId: string,
  reaction: Reaction,
  reason?: string,
  config?: Pick<BifConfig, 'flows'>,
): FeedbackEvent {
  checkReaction(reaction);
  const flow = ownFlow(store, workspaceId, flowId);
  const type = ownFlowType(store, workspaceId, flowTypeId);
  if (flow.flowTypeId !== type.id) throw new FlowFeedbackError(`flow '${flowId}' is not a ${type.key} flow`);
  const why = cleanReason(store, workspaceId, reason);
  return store.transaction(() => {
    const after: Record<string, unknown> = { reaction, flowTypeId: type.id, flowId: flow.id, flowVersion: flow.version, lineageId: flow.lineageId };
    if (config) {
      const ranking = nodeRanking(store, config, workspaceId, type.id, { allVariants: !isPrimaryVariant(store, flow) });
      const ranked = ranking.isRanked ? ranking.ranked.find((f) => f.flowId === flow.id) : undefined;
      if (ranked) {
        after.position = ranked.position;
        for (const k of ['rankScore', 'checklist', 'persona'] as const) if (ranked[k] !== undefined) after[k] = ranked[k];
        after.decidedBy = ranked.decidedBy;
        if (ranked.overriddenBy) after.overriddenBy = ranked.overriddenBy;
      } else {
        after.ranked = false;
      }
    }
    return recordFeedback(store, {
      workspaceId, actor, kind: 'flow_rank_reaction', targetType: 'flow', targetId: flow.id, afterJson: after, ...withReason(why),
    });
  });
}

/**
 * Agree / disagree with one persona's verdict. The event carries the persona, its version, the stage
 * and both flow versions (`afterJson`), and the persona run that gave the verdict (provenance). The
 * verdict and the persona are left untouched; a disagreement on a still-live verdict makes the pair
 * eligible for a focused re-judgment in the next round (`disagreedPairs`).
 */
export function reactToVerdict(store: Store, actor: string, verdictId: string, reaction: Reaction, reason?: string): FeedbackEvent {
  checkReaction(reaction);
  const r = flowRepos(store);
  const v = r.flowVerdicts.get(verdictId);
  if (!v) throw new FlowFeedbackError(`verdict '${verdictId}' not found`, 404);
  const why = cleanReason(store, v.workspaceId, reason);
  const versionOf = (id: string) => r.flows.get(id)?.version ?? null;
  return recordFeedback(store, {
    workspaceId: v.workspaceId,
    actor,
    kind: 'flow_verdict_reaction',
    targetType: 'flow_verdict',
    targetId: v.id,
    afterJson: {
      reaction, personaId: v.personaId, personaVersion: v.personaVersion, stage: v.stage, flowAId: v.flowAId, flowBId: v.flowBId,
      flowAVersion: versionOf(v.flowAId), flowBVersion: versionOf(v.flowBId), winner: v.winner,
    },
    ...withReason(why),
  });
}

/**
 * The (persona, pair) combinations the user disagreed on, for `focusedPairs`' `user_disagreed`: the
 * latest reaction per verdict decides (a later agree cancels a disagree), and only verdicts that are
 * still the live one for their persona and pair count, so once a focused re-judgment replaced the
 * verdict the pair is not returned again. `since` keeps reactions made at or after it. Pairs a < b.
 */
export function disagreedPairs(store: Store, workspaceId: string, flowTypeId: string, since?: string): Array<{ personaId: string; a: string; b: string }> {
  const latest = new Map<string, FeedbackEvent>();
  for (const e of listFeedback(store, { workspaceId, kind: 'flow_verdict_reaction', targetType: 'flow_verdict' })) latest.set(e.targetId, e);
  const live = new Map(liveVerdicts(store, workspaceId, flowTypeId).map((v) => [v.id, v]));
  const out: Array<{ personaId: string; a: string; b: string }> = [];
  const seen = new Set<string>();
  for (const [verdictId, e] of latest) {
    if ((e.afterJson as { reaction?: unknown } | undefined)?.reaction !== 'disagree') continue;
    if (since !== undefined && e.createdAt < since) continue;
    const v = live.get(verdictId);
    if (!v) continue;
    const k = `${v.personaId}\u0000${v.flowAId}\u0000${v.flowBId}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({ personaId: v.personaId, a: v.flowAId, b: v.flowBId });
  }
  return out;
}

// ---------------------------------------------------------------------------
// overrides

const lineagePair = (store: Store, o: Pick<FlowOverride, 'winnerFlowId' | 'loserFlowId'>) => {
  const r = flowRepos(store);
  return [r.flows.get(o.winnerFlowId)?.lineageId, r.flows.get(o.loserFlowId)?.lineageId].sort().join('\u0000');
};

/** The live verdicts on the pair of current flows, as recorded with an override (persona verdict vs the user's ruling). */
function verdictsOnPair(store: Store, workspaceId: string, flowTypeId: string, x: string, y: string) {
  return liveVerdicts(store, workspaceId, flowTypeId)
    .filter((v) => (v.flowAId === x && v.flowBId === y) || (v.flowAId === y && v.flowBId === x))
    .map((v) => ({
      id: v.id, personaId: v.personaId, personaVersion: v.personaVersion, stage: v.stage,
      winnerFlowId: v.winner === 'tie' ? null : v.winner === 'a' ? v.flowAId : v.flowBId,
    }));
}

/**
 * The user's ruling that `winnerFlowId` is better than `loserFlowId` for the node's ranking of the
 * type: a hard constraint on the order, applied to the two flows' lineages. An earlier ruling of the
 * node on the same two lineages (either way) is revoked by it. The event records the live verdicts on
 * the pair at that moment, so a persona's verdict can later be compared with the ruling.
 */
export function overridePair(
  store: Store,
  actor: string,
  workspaceId: string,
  flowTypeId: string,
  winnerFlowId: string,
  loserFlowId: string,
  reason?: string,
): FlowOverride {
  const type = ownFlowType(store, workspaceId, flowTypeId);
  if (type.status === 'merged' || type.status === 'rejected') throw new FlowFeedbackError(`flow type ${type.key} is ${type.status}`, 409);
  const winner = ownFlow(store, workspaceId, winnerFlowId);
  const loser = ownFlow(store, workspaceId, loserFlowId);
  for (const f of [winner, loser]) if (f.flowTypeId !== type.id) throw new FlowFeedbackError(`flow '${f.id}' is not a ${type.key} flow`);
  if (winner.lineageId === loser.lineageId) throw new FlowFeedbackError('a ruling needs two different flows');
  const why = cleanReason(store, workspaceId, reason);
  const r = flowRepos(store);
  return store.transaction(() => {
    const now = new Date().toISOString();
    const key = lineagePair(store, { winnerFlowId: winner.id, loserFlowId: loser.id });
    const replaced = r.flowOverrides
      .list({ workspaceId, flowTypeId: type.id })
      .filter((o) => !o.revokedAt && lineagePair(store, o) === key);
    for (const o of replaced) r.flowOverrides.update(o.id, { revokedAt: now });
    const override: FlowOverride = {
      id: newId('fov'), workspaceId, flowTypeId: type.id, winnerFlowId: winner.id, loserFlowId: loser.id, actor, needsConfirm: false, createdAt: now,
    };
    if (why !== undefined) override.reason = why;
    r.flowOverrides.insert(override);
    const current = (f: Flow) => currentOfLineage(store, f.id)?.id ?? f.id;
    recordFeedback(store, {
      workspaceId,
      actor,
      kind: 'flow_override',
      targetType: 'flow',
      targetId: winner.id,
      ...(replaced.length ? { beforeJson: { overrides: replaced.map((o) => ({ id: o.id, winnerFlowId: o.winnerFlowId, loserFlowId: o.loserFlowId })) } } : {}),
      afterJson: {
        action: 'create', overrideId: override.id, flowTypeId: type.id, winnerFlowId: winner.id, loserFlowId: loser.id,
        winnerVersion: winner.version, loserVersion: loser.version,
        verdicts: verdictsOnPair(store, workspaceId, type.id, current(winner), current(loser)),
      },
      ...withReason(why),
    });
    return r.flowOverrides.get(override.id)!;
  });
}

/** Ends a ruling (it no longer constrains the ranking). 409 when it was already revoked. */
export function revokeOverride(store: Store, actor: string, overrideId: string, reason?: string): FlowOverride {
  return endOverride(store, actor, overrideId, 'revoke', reason);
}

function endOverride(store: Store, actor: string, overrideId: string, action: 'revoke' | 'drop', reason?: string): FlowOverride {
  const r = flowRepos(store);
  const o = r.flowOverrides.get(overrideId);
  if (!o) throw new FlowFeedbackError(`override '${overrideId}' not found`, 404);
  if (o.revokedAt) throw new FlowFeedbackError(`override '${overrideId}' is already revoked`, 409);
  const why = cleanReason(store, o.workspaceId, reason);
  return store.transaction(() => {
    const updated = r.flowOverrides.update(o.id, { revokedAt: new Date().toISOString(), needsConfirm: false });
    recordFeedback(store, {
      workspaceId: o.workspaceId,
      actor,
      kind: 'flow_override',
      targetType: 'flow',
      targetId: o.winnerFlowId,
      beforeJson: { winnerFlowId: o.winnerFlowId, loserFlowId: o.loserFlowId, needsConfirm: o.needsConfirm },
      afterJson: { action, overrideId: o.id, flowTypeId: o.flowTypeId },
      ...withReason(why),
    });
    return updated;
  });
}

/** True when the ruled winner or loser is no longer the current version of its lineage. */
function isStale(store: Store, o: FlowOverride): boolean {
  return currentOfLineage(store, o.winnerFlowId)?.id !== o.winnerFlowId || currentOfLineage(store, o.loserFlowId)?.id !== o.loserFlowId;
}

/**
 * Marks the node's rulings whose winner or loser was replaced by a new version (or has no current
 * version any more) as `needsConfirm`; they keep applying to the lineages' current flows. A system
 * step (the ranking round, the API's reads), so no feedback event. Returns how many were marked.
 */
export function refreshOverrides(store: Store, workspaceId: string): number {
  const r = flowRepos(store);
  return store.transaction(() => {
    let marked = 0;
    for (const o of r.flowOverrides.list({ workspaceId })) {
      if (o.revokedAt || o.needsConfirm || !isStale(store, o)) continue;
      r.flowOverrides.update(o.id, { needsConfirm: true });
      marked++;
    }
    return marked;
  });
}

/**
 * The user's answer to "does this ruling still hold?" after a new version: `keep` re-points it at the
 * current versions of both lineages and clears the flag; otherwise it is revoked. 409 when the ruling
 * is revoked, needs no confirming, or (keep) a lineage has no current version left.
 */
export function confirmOverride(store: Store, actor: string, overrideId: string, keep: boolean, reason?: string): FlowOverride {
  const r = flowRepos(store);
  const o = r.flowOverrides.get(overrideId);
  if (!o) throw new FlowFeedbackError(`override '${overrideId}' not found`, 404);
  if (o.revokedAt) throw new FlowFeedbackError(`override '${overrideId}' is already revoked`, 409);
  if (!o.needsConfirm && !isStale(store, o)) throw new FlowFeedbackError(`override '${overrideId}' needs no confirming: neither flow has a new version`, 409);
  if (!keep) return endOverride(store, actor, overrideId, 'drop', reason);
  const winner = currentOfLineage(store, o.winnerFlowId);
  const loser = currentOfLineage(store, o.loserFlowId);
  if (!winner || !loser) throw new FlowFeedbackError(`override '${overrideId}' names a flow with no current version; drop it instead`, 409);
  const why = cleanReason(store, o.workspaceId, reason);
  return store.transaction(() => {
    const updated = r.flowOverrides.update(o.id, { winnerFlowId: winner.id, loserFlowId: loser.id, needsConfirm: false });
    recordFeedback(store, {
      workspaceId: o.workspaceId,
      actor,
      kind: 'flow_override',
      targetType: 'flow',
      targetId: winner.id,
      beforeJson: { winnerFlowId: o.winnerFlowId, loserFlowId: o.loserFlowId, needsConfirm: o.needsConfirm },
      afterJson: {
        action: 'keep', overrideId: o.id, flowTypeId: o.flowTypeId, winnerFlowId: winner.id, loserFlowId: loser.id,
        winnerVersion: winner.version, loserVersion: loser.version,
        verdicts: verdictsOnPair(store, o.workspaceId, o.flowTypeId, winner.id, loser.id),
      },
      ...withReason(why),
    });
    return updated;
  });
}

// ---------------------------------------------------------------------------
// corrections and decisions (thin wrappers that record the event)

/**
 * The user's correction of a check's answer (`correctCheck`, origin 'user'), for a flow of the caller's
 * tree. The flow's checklist score follows on the next read. Event target id: `<flowId>:<checklistId>:<itemKey>`.
 */
export function correctCheckAs(
  store: Store,
  actor: string,
  workspaceId: string,
  flowId: string,
  input: { checklistId: string; itemKey: string; answer: CheckAnswer; note?: string },
  reason?: string,
): FlowCheck {
  const flow = ownFlow(store, workspaceId, flowId);
  ownChecklist(store, workspaceId, input.checklistId);
  const why = cleanReason(store, workspaceId, reason);
  return store.transaction(() => {
    const prior = flowRepos(store).flowChecks.list({ flowId: flow.id, checklistId: input.checklistId, itemKey: input.itemKey })[0];
    const row = correctCheck(store, flow.id, input.checklistId, input.itemKey, input.answer, input.note);
    recordFeedback(store, {
      workspaceId,
      actor,
      kind: 'flow_check_correction',
      targetType: 'flow_check',
      targetId: `${flow.id}:${input.checklistId}:${input.itemKey}`,
      ...(prior ? { beforeJson: { answer: prior.answer, origin: prior.origin, ...(prior.value !== undefined ? { value: prior.value } : {}) } } : {}),
      afterJson: { flowId: flow.id, flowVersion: flow.version, checklistId: input.checklistId, itemKey: input.itemKey, answer: row.answer },
      ...withReason(why),
    });
    return row;
  });
}

export type FlowTypeDecision =
  | { action: 'accept' }
  | { action: 'reject' }
  | { action: 'merge'; intoId: string }
  | { action: 'edit'; name?: string; definition?: string };

/** The user's decision on a flow type of the caller's tree (`decideFlowType`; its refusals pass through). */
export function decideFlowTypeAs(store: Store, actor: string, workspaceId: string, flowTypeId: string, decision: FlowTypeDecision, reason?: string): FlowType {
  const before = ownFlowType(store, workspaceId, flowTypeId);
  const why = cleanReason(store, workspaceId, reason);
  return store.transaction(() => {
    const after = decideFlowType(store, flowTypeId, decision);
    const detail: Record<string, unknown> = { action: decision.action, status: after.status };
    if (decision.action === 'merge') detail.intoId = after.mergedIntoId;
    if (decision.action === 'edit') Object.assign(detail, { name: after.name, definition: after.definition });
    recordFeedback(store, {
      workspaceId, actor, kind: 'flow_type_decision', targetType: 'flow_type', targetId: before.id,
      beforeJson: { status: before.status, name: before.name, definition: before.definition }, afterJson: detail, ...withReason(why),
    });
    return after;
  });
}

/**
 * The user's decision on a checklist proposal of the caller's tree (`decideChecklistDetailed`): the
 * checklist and the flows the accepted version leaves needing a re-walk.
 */
export function decideChecklistAs(
  store: Store,
  actor: string,
  workspaceId: string,
  checklistId: string,
  decision: { action: 'accept'; coverage?: number } | { action: 'reject' },
  reason?: string,
): { checklist: Checklist; needRewalk: string[] } {
  const before = ownChecklist(store, workspaceId, checklistId);
  const why = cleanReason(store, workspaceId, reason);
  return store.transaction(() => {
    const out = decideChecklistDetailed(store, checklistId, decision);
    recordFeedback(store, {
      workspaceId, actor, kind: 'checklist_decision', targetType: 'checklist', targetId: before.id,
      beforeJson: { status: before.status, coverage: before.coverage, version: before.version, origin: before.origin },
      afterJson: {
        action: decision.action, status: out.checklist.status, coverage: out.checklist.coverage,
        ...(before.flowTypeId !== undefined ? { flowTypeId: before.flowTypeId } : {}), needRewalk: out.needRewalk,
      },
      ...withReason(why),
    });
    return out;
  });
}

/**
 * The user's edit of an active checklist of the caller's tree (`editChecklist`: coverage, item
 * weights and questions, removals; a new active version of origin `user`): the new checklist and the
 * flows needing a re-walk. One `checklist_decision` event targets the edited version, with its state
 * before and, after, the new version, what changed per item and the re-walk list.
 */
export function editChecklistAs(
  store: Store,
  actor: string,
  workspaceId: string,
  input: { checklistId: string; coverage?: number; items: ChecklistItemEdit[] },
  reason?: string,
): { checklist: Checklist; needRewalk: string[] } {
  const before = ownChecklist(store, workspaceId, input.checklistId);
  const why = cleanReason(store, workspaceId, reason);
  return store.transaction(() => {
    const { checklist, needRewalk } = editChecklist(store, workspaceId, input);
    const after = new Map(checklist.items.map((i) => [i.key, i]));
    const changes = {
      removed: before.items.filter((i) => !after.has(i.key)).map((i) => i.key),
      weights: before.items.flatMap((i) => {
        const a = after.get(i.key);
        return a && a.weight !== i.weight ? [{ key: i.key, before: i.weight, after: a.weight }] : [];
      }),
      questions: before.items.flatMap((i) => {
        const a = after.get(i.key);
        return a && a.question !== i.question ? [{ key: i.key, before: i.question, after: a.question }] : [];
      }),
    };
    recordFeedback(store, {
      workspaceId, actor, kind: 'checklist_decision', targetType: 'checklist', targetId: before.id,
      beforeJson: { checklistId: before.id, status: before.status, coverage: before.coverage, version: before.version, origin: before.origin },
      afterJson: {
        action: 'edit', checklistId: checklist.id, status: checklist.status, coverage: checklist.coverage, version: checklist.version,
        ...(before.flowTypeId !== undefined ? { flowTypeId: before.flowTypeId } : {}), changes, needRewalk,
      },
      ...withReason(why),
    });
    return { checklist, needRewalk };
  });
}

/**
 * The user's correction of a review mention's attribution: another flow type (by key) and optionally
 * one of its checks, or none (`flowTypeKey` left out: the mention stays on its subject only). The
 * user's attribution has confidence 1. The review-answered checks of the subject's current flows of
 * the old and new type are recomputed at once.
 */
export function correctAttributionAs(
  store: Store,
  config: Pick<BifConfig, 'flows'>,
  actor: string,
  workspaceId: string,
  mentionId: string,
  input: { flowTypeKey?: string; checkKey?: string },
  reason?: string,
): ReviewMention {
  const m = ownMention(store, workspaceId, mentionId);
  const why = cleanReason(store, workspaceId, reason);
  let flowTypeId: string | undefined;
  let checkKey: string | undefined;
  if (input.flowTypeKey === undefined) {
    if (input.checkKey !== undefined) throw new FlowFeedbackError('checkKey needs flowTypeKey: name the flow type the check belongs to');
  } else {
    const type = flowTypeByKey(store, workspaceId, input.flowTypeKey);
    if (!type) throw new FlowFeedbackError(`unknown flow type '${input.flowTypeKey}'`, 404);
    if (type.status === 'rejected') throw new FlowFeedbackError(`flow type '${type.key}' was rejected; choose another type`, 409);
    flowTypeId = type.id;
    if (input.checkKey !== undefined) {
      const { general, specific } = activeChecklists(store, workspaceId, type.id);
      const keys = [...general.items, ...(specific?.items ?? [])].map((i) => i.key);
      if (!keys.includes(input.checkKey)) throw new FlowFeedbackError(`unknown check '${input.checkKey}' for flow type '${type.key}'`);
      checkKey = input.checkKey;
    }
  }
  const r = flowRepos(store);
  const settings = flowsSettings(config);
  return store.transaction(() => {
    const updated = r.reviewMentions.update(m.id, { flowTypeId, checkKey, attributionConfidence: flowTypeId === undefined ? 0 : 1 });
    recordFeedback(store, {
      workspaceId,
      actor,
      kind: 'review_attribution_correction',
      targetType: 'review_mention',
      targetId: m.id,
      beforeJson: { flowTypeId: m.flowTypeId ?? null, checkKey: m.checkKey ?? null, confidence: m.attributionConfidence },
      afterJson: { flowTypeId: flowTypeId ?? null, checkKey: checkKey ?? null, confidence: updated.attributionConfidence },
      ...withReason(why),
    });
    const types = new Set([m.flowTypeId, flowTypeId].filter((t): t is string => t !== undefined));
    for (const t of types) {
      for (const f of r.flows.list({ rootWorkspaceId: m.rootWorkspaceId, subjectEntityId: m.subjectEntityId, flowTypeId: t, lifecycle: 'current' })) {
        applyReviewChecks(store, workspaceId, f.id, settings);
      }
    }
    return updated;
  });
}
