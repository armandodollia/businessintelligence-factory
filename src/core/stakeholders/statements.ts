/**
 * Statements (stakeholder design §9): everything the user says about a stakeholder, append-only.
 *
 * - `addNote`: "Add a note" on a stakeholder (or node-wide, about someone not yet known). Allowed on a
 *   hidden stakeholder (the user may tell the tool things before answering); it reveals nothing. Allowed
 *   on a former colleague too, at a competitor or parked (positions design §6).
 * - `recordDecision`: "Record the real decision" on a recommendation, by an own stakeholder of the
 *   recommendation's node that has not left; refused (409) while that stakeholder is hidden.
 * - `noteStakeholderHandler`: the interviewer's `note_stakeholder` tool; the quote must be text the
 *   user typed in this node's interview.
 *
 * Storing a statement changes no persona (only the retro's learning run does). The text can never be
 * updated afterwards, so it is redacted (identity redaction) and capped at `STATEMENT_TEXT_MAX` before
 * the insert. The user actions record one feedback event each, holding ids and the decision enum,
 * never the text; the interviewer tool records a Decision (it is not a user action in the UI).
 */
import { actorOf, recordFeedback } from '../feedback/events.js';
import { cleanReason, FlowFeedbackError } from '../flows/feedback.js';
import type { ExtraToolHandler, ToolResult } from '../harness/tools/handlers.js';
import { findReplay } from '../harness/tools/idempotency.js';
import type { ToolInput } from '../harness/tools/registry.js';
import { capText } from '../knowledge/texts.js';
import { redactServed } from '../knowledge/trust.js';
import { STAKEHOLDER_FIELDS } from '../scoring/criteria.js';
import type { Store } from '../store/db.js';
import { newId } from '../store/repos.js';
import type { Decision, Persona } from '../types.js';
import { rootOf, sameTree } from '../workspace/tree.js';
import { isCurrentOwn, isHidden } from './personas.js';
import { stakeholderRepos } from './store.js';
import { REAL_DECISIONS, type StakeholderStatement } from './types.js';

/** Longest statement text (characters, after redaction): answers, notes and interview quotes. */
export const STATEMENT_TEXT_MAX = 4000;

/** Refusal of a stakeholder action; `status` is the HTTP status the API answers with. */
export class StakeholderError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409,
  ) {
    super(message);
    this.name = 'StakeholderError';
  }
}

/** Trimmed, identity secrets redacted, at most `STATEMENT_TEXT_MAX` characters; '' when empty. */
export function statementText(store: Store, workspaceId: string, text: string): string {
  const redacted = redactServed(store, workspaceId, text.trim()).trim();
  return redacted.length > STATEMENT_TEXT_MAX ? capText(redacted, STATEMENT_TEXT_MAX - 1) : redacted;
}

/** A stakeholder persona of the caller's business tree (own, a competitor's or a former colleague); 404 (as for an unknown id) otherwise. */
export function ownStakeholder(store: Store, workspaceId: string, personaId: unknown): Persona {
  const p = typeof personaId === 'string' ? store.personas.get(personaId) : undefined;
  if (!p || p.kind !== 'stakeholder' || !sameTree(store, workspaceId, p.workspaceId)) {
    throw new StakeholderError(`stakeholder '${String(personaId)}' not found`, 404);
  }
  return p;
}

/** Inserts one statement (id `sst_`, tree root and time filled in). */
export function insertStatement(
  store: Store,
  s: Omit<StakeholderStatement, 'id' | 'rootWorkspaceId' | 'createdAt'> & { createdAt?: string },
): StakeholderStatement {
  return stakeholderRepos(store).statements.insert({
    ...s,
    id: newId('sst'),
    rootWorkspaceId: rootOf(store, s.workspaceId),
    createdAt: s.createdAt ?? new Date().toISOString(),
  });
}

/** "Add a note": a statement on a stakeholder of the tree (hidden ones and former colleagues too, revealing nothing), or node-wide without `personaId`. */
export function addNote(store: Store, actor: string, workspaceId: string, input: { personaId?: string; text: string; field?: string }): StakeholderStatement {
  if (!store.workspaces.get(workspaceId)) throw new StakeholderError(`workspace '${workspaceId}' not found`, 404);
  if (typeof input.text !== 'string') throw new StakeholderError('text must be a text', 400);
  if (input.field !== undefined && !(STAKEHOLDER_FIELDS as readonly string[]).includes(input.field)) {
    throw new StakeholderError(`field must be one of ${STAKEHOLDER_FIELDS.join(', ')}`, 400);
  }
  const persona = input.personaId !== undefined ? ownStakeholder(store, workspaceId, input.personaId) : undefined;
  const nodeId = persona?.workspaceId ?? workspaceId;
  const text = statementText(store, nodeId, input.text);
  if (!text) throw new StakeholderError('text is empty', 400);
  return store.transaction(() => {
    const statement = insertStatement(store, {
      workspaceId: nodeId,
      ...(persona ? { personaId: persona.id } : {}),
      source: 'note',
      ...(input.field !== undefined ? { field: input.field } : {}),
      text,
      actor,
    });
    recordFeedback(store, {
      workspaceId: nodeId,
      actor,
      kind: 'stakeholder_note',
      targetType: 'stakeholder',
      targetId: persona?.id ?? nodeId,
      afterJson: { statementId: statement.id, ...(persona ? { personaId: persona.id } : {}), ...(input.field !== undefined ? { field: input.field } : {}) },
    });
    return statement;
  });
}

/**
 * "Record the real decision" of an own stakeholder of the recommendation's node (never a former colleague's): a `decision_record`
 * statement whose text is the reasoning (cleaned like reasons: at most 2,000 characters). 404 for an
 * unknown or foreign recommendation or persona, 409 while the stakeholder is hidden, 400 otherwise.
 */
export function recordDecision(
  store: Store,
  actor: string,
  workspaceId: string,
  input: { recommendationId: string; personaId: string; decision: (typeof REAL_DECISIONS)[number]; reasoning: string },
): StakeholderStatement {
  if (!(REAL_DECISIONS as readonly string[]).includes(input.decision)) {
    throw new StakeholderError(`decision must be one of ${REAL_DECISIONS.join(', ')}`, 400);
  }
  const rec = typeof input.recommendationId === 'string' ? store.recommendations.get(input.recommendationId) : undefined;
  if (!rec || !sameTree(store, workspaceId, rec.workspaceId)) throw new StakeholderError(`recommendation '${input.recommendationId}' not found`, 404);
  const persona = ownStakeholder(store, workspaceId, input.personaId);
  if (!isCurrentOwn(persona) || persona.workspaceId !== rec.workspaceId) {
    throw new StakeholderError(`stakeholder '${persona.id}' is not an own stakeholder of the recommendation's node`, 400);
  }
  if (isHidden(persona)) throw new StakeholderError(`stakeholder '${persona.id}' is hidden: answer or skip its questions first`, 409);
  let reasoning: string | undefined;
  try {
    reasoning = cleanReason(store, rec.workspaceId, input.reasoning);
  } catch (e) {
    if (e instanceof FlowFeedbackError) throw new StakeholderError(e.message.replace(/^reason/, 'reasoning'), 400);
    throw e;
  }
  if (!reasoning) throw new StakeholderError('reasoning is empty', 400);
  return store.transaction(() => {
    const statement = insertStatement(store, {
      workspaceId: rec.workspaceId,
      personaId: persona.id,
      source: 'decision_record',
      text: reasoning,
      recommendationId: rec.id,
      decision: input.decision,
      actor,
    });
    recordFeedback(store, {
      workspaceId: rec.workspaceId,
      actor,
      kind: 'stakeholder_decision_record',
      targetType: 'stakeholder',
      targetId: persona.id,
      afterJson: { statementId: statement.id, personaId: persona.id, recommendationId: rec.id, decision: input.decision },
    });
    return statement;
  });
}

/** The persona's statements not yet consumed by a learning run, oldest first. */
export function openStatements(store: Store, personaId: string): StakeholderStatement[] {
  return stakeholderRepos(store)
    .statements.list({ personaId })
    .filter((s) => !s.consumedByRunId)
    .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** Shortest `note_stakeholder` quote (characters, whitespace-normalised): enough words to mean something. */
export const QUOTE_MIN = 12;

const normalise = (s: string) => s.replace(/\s+/g, ' ').trim();
const fail = (error: string): ToolResult => ({ ok: false, error });

/**
 * `note_stakeholder` (interviewer): stores what the user said about a stakeholder, quoted. The quote,
 * whitespace-normalised, must occur (case-sensitive) in one of the user's own messages of this node's
 * interview; `persona_id`, when given, must be a stakeholder of this node. Source `interview`; a
 * Decision carrying ids and the field only. A replayed call of the same run returns the stored statement.
 */
export const noteStakeholderHandler: ExtraToolHandler = async (ctx, raw, deps) => {
  const input = raw as ToolInput<'note_stakeholder'>;
  const { store, events, config } = deps;
  const quote = normalise(input.quote);
  if (quote.length < QUOTE_MIN) return fail(`quote needs at least ${QUOTE_MIN} characters`);
  let persona: Persona | undefined;
  if (input.persona_id !== undefined) {
    persona = store.personas.get(input.persona_id);
    if (!persona || persona.kind !== 'stakeholder' || persona.workspaceId !== ctx.workspaceId) {
      return fail(`persona_id '${input.persona_id}' is not a stakeholder of this node: omit it when the stakeholder is not listed`);
    }
  }
  const said = store.interview
    .list({ workspaceId: ctx.workspaceId })
    .some((t) => t.role === 'user' && normalise(t.text).includes(quote));
  if (!said) return fail('quote must be text the user typed in this interview, copied exactly (only whitespace may differ)');
  const text = statementText(store, ctx.workspaceId, quote);

  const replay = findReplay(store, ctx, 'note_stakeholder', 'run', (p) => {
    const prior = typeof p.statementId === 'string' ? stakeholderRepos(store).statements.get(p.statementId) : undefined;
    return !!prior && prior.text === text && (prior.personaId ?? undefined) === persona?.id && (prior.field ?? undefined) === input.field;
  });
  if (replay) return { ok: true, data: { statementId: (replay.payload as { statementId: string }).statementId, duplicate: true } };

  const decision = store.transaction(() => {
    const statement = insertStatement(store, {
      workspaceId: ctx.workspaceId,
      ...(persona ? { personaId: persona.id } : {}),
      source: 'interview',
      ...(input.field !== undefined ? { field: input.field } : {}),
      text,
      actor: actorOf(config),
    });
    const d: Decision = {
      id: newId('dec'),
      workspaceId: ctx.workspaceId,
      agentRunId: ctx.agentRunId,
      role: ctx.role,
      model: ctx.model,
      kind: 'decision',
      payload: {
        tool: 'note_stakeholder', statementId: statement.id,
        ...(persona ? { personaId: persona.id } : {}), ...(input.field !== undefined ? { field: input.field } : {}),
      },
      refs: [statement.id, ...(persona ? [persona.id] : [])],
      promptVersion: ctx.promptVersion,
      createdAt: new Date().toISOString(),
    };
    store.decisions.insert(d);
    return d;
  });
  events.emit({ type: 'decision', workspaceId: ctx.workspaceId, decision });
  return { ok: true, data: { statementId: (decision.payload as { statementId: string }).statementId } };
};
