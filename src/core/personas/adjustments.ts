/**
 * Persona adjustments (design 2026-11-15-persona-learning-design.md §9, §10): the user's decision on a
 * persona proposal, the direct retirement of an adjustment, and the effect numbers of an adjustment.
 *
 * - Accept (`add` / `replace` / `retire`) and retire change the adjustment, bump the persona's version
 *   and recompile its agent.md (`writeAgentMd` carries the active adjustments), with one feedback event
 *   and one Decision, all in one transaction. A new persona version makes its flow verdicts stale and
 *   its panel feedback replaced at the next panel (intended).
 * - When an adjustment is retired or replaced, every other pending proposal of that adjustment becomes
 *   `superseded` in the same transaction (it no longer applies; a pending proposal would keep the
 *   persona out of learning runs).
 * - An accepted `add` or `replace` records the persona version it made (`personaVersion`) and a
 *   `replace` the replace proposal's gate numbers (`stats`), so the effect compares like with like.
 * - Reject changes nothing but the proposal; one feedback event and one Decision record it.
 * - Isolation: a proposal or adjustment whose persona is outside the caller's business tree is refused
 *   exactly like an unknown id (404). Reasons are cleaned like flow reactions (`cleanReason`).
 * - The feedback event and the Decision are recorded in the persona's own workspace (where its signals
 *   are read).
 */
import { randomBytes } from 'node:crypto';
import { recordFeedback } from '../feedback/events.js';
import { cleanReason, FlowFeedbackError } from '../flows/feedback.js';
import { capText } from '../knowledge/texts.js';
import { redactServed } from '../knowledge/trust.js';
import { writeAgentMd } from '../market/personas.js';
import type { Store } from '../store/db.js';
import { newId } from '../store/repos.js';
import { recordSystemDecision } from '../systemDecision.js';
import type { Persona } from '../types.js';
import { sameTree } from '../workspace/tree.js';
import { gateStats } from './gate.js';
import { collectPersonaSignals } from './signals.js';
import { activeAdjustments, personaLearningRepos } from './store.js';
import type { GateStats, PersonaAdjustment, PersonaProposal, PersonaSignal } from './types.js';

export { activeAdjustments };

/** Longest adjustment text the user can accept (characters, after redaction). */
export const ADJUSTMENT_TEXT_MAX = 400;
const DEFAULT_MAX_ADJUSTMENTS = 8;

/** Refusal of a persona learning action; `status` is the HTTP status the API answers with. */
export class PersonaLearningError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409,
  ) {
    super(message);
    this.name = 'PersonaLearningError';
  }
}

/** `A-` plus six upper-case hex characters, unique across all trees (retries on a collision). */
export function newMarker(store: Store, random: (n: number) => Uint8Array = randomBytes): string {
  const repo = personaLearningRepos(store).adjustments;
  for (;;) {
    const m = `A-${Buffer.from(random(3)).toString('hex').toUpperCase()}`;
    if (!repo.list({ marker: m }).length) return m;
  }
}

function reasonOf(store: Store, workspaceId: string, reason: string | undefined): string | undefined {
  try {
    return cleanReason(store, workspaceId, reason);
  } catch (e) {
    if (e instanceof FlowFeedbackError) throw new PersonaLearningError(e.message, e.status);
    throw e;
  }
}

/** The persona, when it is in the caller's tree; 404 (as for an unknown id) otherwise. */
function ownPersona(store: Store, workspaceId: string, personaId: string, what: string): Persona {
  const persona = store.personas.get(personaId);
  if (!persona || !sameTree(store, workspaceId, persona.workspaceId)) throw new PersonaLearningError(`${what} not found`, 404);
  return persona;
}

/** The proposal and its persona, of the caller's tree (404 otherwise); 409 unless it is pending. */
function ownPendingProposal(store: Store, workspaceId: string, proposalId: string): { p: PersonaProposal; persona: Persona } {
  const p = typeof proposalId === 'string' ? personaLearningRepos(store).proposals.get(proposalId) : undefined;
  const what = `persona proposal '${proposalId}'`;
  if (!p) throw new PersonaLearningError(`${what} not found`, 404);
  const persona = ownPersona(store, workspaceId, p.personaId, what);
  if (p.status !== 'pending') throw new PersonaLearningError(`${what} is ${p.status}`, 409);
  return { p, persona };
}

/** The accepted text: the user's edit when given (redacted, at most `ADJUSTMENT_TEXT_MAX` characters with the ellipsis of a cut), else the proposal's. */
function acceptedText(store: Store, workspaceId: string, p: PersonaProposal, text: string | undefined): string {
  if (text === undefined || text === null) return p.text;
  if (typeof text !== 'string') throw new PersonaLearningError('text must be a text', 400);
  // At most ADJUSTMENT_TEXT_MAX characters including the ellipsis of a cut.
  const redacted = redactServed(store, workspaceId, text.trim());
  const out = (redacted.length <= ADJUSTMENT_TEXT_MAX ? redacted : capText(redacted, ADJUSTMENT_TEXT_MAX - 1)).trim();
  if (!out) throw new PersonaLearningError('text must not be empty', 400);
  return out;
}

/** Bumps the persona's version and recompiles its agent.md (inside the caller's transaction). */
function bumpPersona(store: Store, persona: Persona): Persona {
  const updated = store.personas.update(persona.id, { version: persona.version + 1 });
  writeAgentMd(store, updated);
  return updated;
}

/** Every other pending proposal of the adjustment becomes `superseded` (inside the caller's transaction). */
function supersedeOthers(store: Store, adjustmentId: string, except: string | undefined, now: string): void {
  const proposals = personaLearningRepos(store).proposals;
  for (const q of proposals.list({ adjustmentId, status: 'pending' })) {
    if (q.id !== except) proposals.update(q.id, { status: 'superseded', decidedAt: now });
  }
}

const adjustmentState = (a: PersonaAdjustment) => ({ adjustmentId: a.id, marker: a.marker, version: a.version, status: a.status, text: a.text });

/**
 * The user accepts a pending proposal: `add` creates an active adjustment (409 when the persona already
 * has `maxAdjustments` active ones, default 8), `replace` changes its text and bumps its version,
 * `retire` ends it. `text` replaces the proposed text (stored as `finalText` when it differs; ignored
 * for `retire`). A `replace` / `retire` of an adjustment that is no longer active is refused (409) and
 * the proposal becomes `superseded`.
 */
export function acceptPersonaProposal(
  store: Store,
  actor: string,
  workspaceId: string,
  proposalId: string,
  opts: { text?: string; reason?: string; maxAdjustments?: number } = {},
): { proposal: PersonaProposal; adjustment: PersonaAdjustment; persona: Persona } {
  const repos = personaLearningRepos(store);
  const { p, persona } = ownPendingProposal(store, workspaceId, proposalId);
  const why = reasonOf(store, persona.workspaceId, opts.reason);
  const text = p.action === 'retire' ? p.text : acceptedText(store, persona.workspaceId, p, opts.text);
  const now = new Date().toISOString();

  let before: PersonaAdjustment | undefined;
  if (p.action === 'add') {
    const max = opts.maxAdjustments ?? DEFAULT_MAX_ADJUSTMENTS;
    const active = activeAdjustments(store, persona.id).length;
    if (active >= max) throw new PersonaLearningError(`persona '${persona.slug}' already has ${active} active adjustments (max ${max}); retire one first`, 409);
  } else {
    before = p.adjustmentId ? repos.adjustments.get(p.adjustmentId) : undefined;
    if (!before || before.personaId !== persona.id || before.status !== 'active') {
      repos.proposals.update(p.id, { status: 'superseded', decidedAt: now });
      throw new PersonaLearningError(`persona adjustment '${p.adjustmentId}' is not active; the proposal is superseded`, 409);
    }
  }

  return store.transaction(() => {
    let adjustment: PersonaAdjustment;
    if (p.action === 'add') {
      adjustment = repos.adjustments.insert({
        id: newId('pad'), rootWorkspaceId: p.rootWorkspaceId, workspaceId: persona.workspaceId, personaId: persona.id,
        ...(p.field !== undefined ? { field: p.field } : {}), marker: newMarker(store), text, version: 1, status: 'active', source: p.source,
        proposalId: p.id, actor, stats: p.stats, internal: false, createdAt: now, changedAt: now, personaVersion: persona.version + 1,
      });
    } else if (p.action === 'replace') {
      adjustment = repos.adjustments.update(before!.id, {
        text, version: before!.version + 1, actor, stats: p.stats, changedAt: now, personaVersion: persona.version + 1,
      });
    } else {
      adjustment = repos.adjustments.update(before!.id, { status: 'retired', actor, changedAt: now, endedAt: now });
    }
    if (p.action !== 'add') supersedeOthers(store, adjustment.id, p.id, now);
    const updated = bumpPersona(store, persona);
    const decision = recordSystemDecision({ store }, {
      workspaceId: persona.workspaceId,
      actor: 'user',
      actorId: actor,
      payload: { tool: 'persona_learning', action: p.action, personaId: persona.id, proposalId: p.id, adjustmentId: adjustment.id, personaVersion: updated.version },
      refs: [p.id, adjustment.id, persona.id],
    });
    const feedback = recordFeedback(store, {
      workspaceId: persona.workspaceId,
      actor,
      kind: 'persona_learning_accept',
      targetType: 'persona_proposal',
      targetId: p.id,
      beforeJson: { status: 'pending', personaVersion: persona.version, text: p.text, ...(before ? { adjustment: adjustmentState(before) } : {}) },
      afterJson: {
        status: 'accepted', action: p.action, personaId: persona.id, personaVersion: updated.version, decisionId: decision.id,
        ...(text !== p.text ? { finalText: text } : {}), adjustment: adjustmentState(adjustment),
      },
      ...(why !== undefined ? { reason: why } : {}),
    });
    const proposal = repos.proposals.update(p.id, {
      status: 'accepted', decidedAt: now, actor, decisionId: decision.id, feedbackEventId: feedback.id,
      ...(text !== p.text ? { finalText: text } : {}), ...(why !== undefined ? { reason: why } : {}),
      ...(p.action === 'add' ? { adjustmentId: adjustment.id } : {}),
    });
    return { proposal, adjustment, persona: updated };
  });
}

/** The user rejects a pending proposal: nothing changes but the proposal; a `persona_learning_reject` event and a Decision record it. */
export function rejectPersonaProposal(store: Store, actor: string, workspaceId: string, proposalId: string, opts: { reason?: string } = {}): PersonaProposal {
  const { p, persona } = ownPendingProposal(store, workspaceId, proposalId);
  const why = reasonOf(store, persona.workspaceId, opts.reason);
  return store.transaction(() => {
    const decision = recordSystemDecision({ store }, {
      workspaceId: persona.workspaceId,
      actor: 'user',
      actorId: actor,
      payload: { tool: 'persona_learning', action: 'reject', personaId: persona.id, proposalId: p.id, proposalAction: p.action },
      refs: [p.id, persona.id],
    });
    const feedback = recordFeedback(store, {
      workspaceId: persona.workspaceId,
      actor,
      kind: 'persona_learning_reject',
      targetType: 'persona_proposal',
      targetId: p.id,
      beforeJson: { status: 'pending' },
      afterJson: {
        status: 'rejected', action: p.action, personaId: persona.id, personaVersion: persona.version, decisionId: decision.id,
        ...(p.adjustmentId !== undefined ? { adjustmentId: p.adjustmentId } : {}),
      },
      ...(why !== undefined ? { reason: why } : {}),
    });
    return personaLearningRepos(store).proposals.update(p.id, {
      status: 'rejected', decidedAt: new Date().toISOString(), actor, decisionId: decision.id, feedbackEventId: feedback.id, ...(why !== undefined ? { reason: why } : {}),
    });
  });
}

/** The user retires an active adjustment directly (same effect as an accepted `retire`). 409 when it is not active. */
export function retireAdjustment(
  store: Store,
  actor: string,
  workspaceId: string,
  adjustmentId: string,
  opts: { reason?: string } = {},
): { adjustment: PersonaAdjustment; persona: Persona } {
  const repos = personaLearningRepos(store);
  const before = typeof adjustmentId === 'string' ? repos.adjustments.get(adjustmentId) : undefined;
  const what = `persona adjustment '${adjustmentId}'`;
  if (!before) throw new PersonaLearningError(`${what} not found`, 404);
  const persona = ownPersona(store, workspaceId, before.personaId, what);
  if (before.status !== 'active') throw new PersonaLearningError(`${what} is ${before.status}`, 409);
  const why = reasonOf(store, persona.workspaceId, opts.reason);
  return store.transaction(() => {
    const now = new Date().toISOString();
    const adjustment = repos.adjustments.update(before.id, { status: 'retired', actor, changedAt: now, endedAt: now });
    supersedeOthers(store, adjustment.id, undefined, now);
    const updated = bumpPersona(store, persona);
    const decision = recordSystemDecision({ store }, {
      workspaceId: persona.workspaceId,
      actor: 'user',
      actorId: actor,
      payload: { tool: 'persona_learning', action: 'retire', personaId: persona.id, adjustmentId: adjustment.id, personaVersion: updated.version },
      refs: [adjustment.id, persona.id],
    });
    recordFeedback(store, {
      workspaceId: persona.workspaceId,
      actor,
      kind: 'persona_adjustment_retire',
      targetType: 'persona_adjustment',
      targetId: adjustment.id,
      beforeJson: { personaVersion: persona.version, adjustment: adjustmentState(before) },
      afterJson: { personaId: persona.id, personaVersion: updated.version, decisionId: decision.id, adjustment: adjustmentState(adjustment) },
      ...(why !== undefined ? { reason: why } : {}),
    });
    return { adjustment, persona: updated };
  });
}

export type AdjustmentEffect = { before: Partial<GateStats>; since: GateStats };

/**
 * The persona's signals after the adjustment last changed, leaving out reactions to output of a
 * persona version older than the one the adjustment made (output it did not influence). A signal of an
 * unknown version, or an adjustment without one, counts.
 */
export function signalsSinceChange(store: Store, adjustment: PersonaAdjustment): PersonaSignal[] {
  const made = adjustment.personaVersion;
  return collectPersonaSignals(store, adjustment.personaId, { since: adjustment.changedAt })
    .filter((s) => made === undefined || s.personaVersion === undefined || s.personaVersion >= made);
}

/** Gate numbers when the adjustment was proposed or replaced (`before`) and of its signals since (`since`, `signalsSinceChange`). */
export function adjustmentEffect(store: Store, adjustment: PersonaAdjustment): AdjustmentEffect {
  return { before: adjustment.stats, since: gateStats(signalsSinceChange(store, adjustment)) };
}
