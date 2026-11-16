/**
 * The question round (stakeholder design §7, §8): fixed templates filled with a stakeholder's label
 * only (no model writes or selects questions), asked before the user sees what research found, so the
 * answers are the user's own.
 *
 * - `ensureQuestions` (when the `stakeholders` phase ends): four questions for every hidden, usable own
 *   stakeholder of the node that has none, plus the two node-wide questions once per batch. A former
 *   colleague (at a competitor or parked) is never asked about (positions design §6).
 * - `answerQuestions`: a stakeholder is touched when one of its questions gets a non-empty answer, it is
 *   in `skip`, or `skipAll`; a touched stakeholder opens and its still-open questions become `skipped`.
 *   A non-empty answer becomes a `question_answer` statement (a blank one counts as not sent). When a
 *   call leaves no hidden stakeholder of the node with open questions, the node-wide questions still
 *   open become `skipped`. One `stakeholder_answers` event (target: the node) per call.
 * - `revealStakeholder` ("Show what the tool found"): opens it and skips its open questions; the node-wide
 *   questions close by the same rule as in `answerQuestions`.
 *
 * Opening changes the persona's `disclosure` and nothing else (no version bump, no agent.md write);
 * it is one-way (a later `save_stakeholder` keeps the stored disclosure).
 */
import { recordFeedback } from '../feedback/events.js';
import type { Store } from '../store/db.js';
import { newId } from '../store/repos.js';
import type { Persona } from '../types.js';
import { rootOf } from '../workspace/tree.js';
import { isCurrentOwn, isHidden, stakeholderPersonas } from './personas.js';
import { insertStatement, ownStakeholder, StakeholderError, statementText } from './statements.js';
import { stakeholderRepos } from './store.js';
import type { StakeholderQuestion, StakeholderStatement, StakeholderType } from './types.js';

/** Questions for a person (`leader`, `manager`, `investor`, `board`, `owner`, `regulator`, `partner`, `other`); spec §8 copy. */
export const PEOPLE_TEMPLATES: ReadonlyArray<{ field: string; text: string }> = [
  { field: 'decision_criteria', text: 'When {label} decides on something you bring to them, what matters most to them?' },
  { field: 'dependencies', text: 'What do you need from {label} (approval, budget, people, information), and what do they need from you?' },
  { field: 'known_positions', text: 'Think of the last time {label} said yes or no to something you proposed. What was it, and what reason did they give?' },
  { field: 'objections', text: 'What usually makes {label} hesitate or push back?' },
];

/** Questions for a `team` or a `system`; spec §8 copy. */
export const SYSTEM_TEMPLATES: ReadonlyArray<{ field: string; text: string }> = [
  { field: 'dependencies', text: 'What does {label} provide to you, and what do you have to ask them for?' },
  { field: 'decision_criteria', text: 'When you ask {label} for a change or for access, what decides whether you get it?' },
  { field: 'known_positions', text: 'Think of the last request {label} accepted or turned down. What was it, and why?' },
  { field: 'constraints', text: 'What limits what {label} can do for you (their roadmap, capacity, rules)?' },
];

/** The two questions for the node as a whole (no persona); spec §8 copy. */
export const NODE_QUESTIONS: ReadonlyArray<{ field: 'missing' | 'not_relevant'; text: string }> = [
  { field: 'missing', text: 'Is anyone missing from this list whose approval, budget or data you depend on?' },
  { field: 'not_relevant', text: 'Is anyone on this list not relevant to your work?' },
];

/** The template with its one `{label}` replaced by the label, literally (no `$` patterns, no second substitution). */
export function questionText(template: string, label: string): string {
  const at = template.indexOf('{label}');
  if (at < 0) return template;
  return template.slice(0, at) + label + template.slice(at + '{label}'.length);
}

const templatesFor = (type: StakeholderType | undefined) => (type === 'team' || type === 'system' ? SYSTEM_TEMPLATES : PEOPLE_TEMPLATES);

/** A hidden stakeholder gets questions whatever its review status, unless research replaced or failed it. */
const askable = (p: Persona) => p.status !== 'superseded' && p.status !== 'failed';

/**
 * Creates the question round for the node's hidden own stakeholders that have no questions yet (four
 * each), and the two node questions when at least one stakeholder got questions. Review status does not
 * matter (the user cannot include a hidden stakeholder, so questions cannot wait for that), except that a
 * `superseded` or `failed` stakeholder gets none. Returns what it created (nothing on a second call).
 */
export function ensureQuestions(store: Store, workspaceId: string): StakeholderQuestion[] {
  const repo = stakeholderRepos(store).questions;
  return store.transaction(() => {
    const due = stakeholderPersonas(store, workspaceId).filter(
      (p) => isHidden(p) && isCurrentOwn(p) && askable(p) && repo.list({ personaId: p.id }).length === 0,
    );
    if (!due.length) return [];
    const root = rootOf(store, workspaceId);
    const createdAt = new Date().toISOString();
    const make = (field: string, text: string, personaId?: string): StakeholderQuestion =>
      repo.insert({
        id: newId('stq'), rootWorkspaceId: root, workspaceId, ...(personaId ? { personaId } : {}), field, text, status: 'open', createdAt,
      });
    const out: StakeholderQuestion[] = [];
    for (const p of due) {
      for (const t of templatesFor(p.stakeholderType)) out.push(make(t.field, questionText(t.text, p.segment), p.id));
    }
    for (const t of NODE_QUESTIONS) out.push(make(t.field, t.text));
    return out;
  });
}

/**
 * The node's open questions grouped by stakeholder (its id, label and type only: §7), in creation
 * order; the node-wide questions last, as one group without a persona.
 */
export function openQuestions(
  store: Store,
  workspaceId: string,
): Array<{ persona?: { id: string; label: string; stakeholderType: StakeholderType }; questions: StakeholderQuestion[] }> {
  const open = stakeholderRepos(store).questions.list({ workspaceId, status: 'open' });
  const groups = new Map<string, StakeholderQuestion[]>();
  const node: StakeholderQuestion[] = [];
  for (const q of open) {
    if (!q.personaId) node.push(q);
    else groups.set(q.personaId, [...(groups.get(q.personaId) ?? []), q]);
  }
  const out: Array<{ persona?: { id: string; label: string; stakeholderType: StakeholderType }; questions: StakeholderQuestion[] }> = [];
  for (const [personaId, questions] of groups) {
    const p = store.personas.get(personaId);
    if (!p) continue;
    out.push({ persona: { id: p.id, label: p.segment, stakeholderType: p.stakeholderType ?? 'other' }, questions });
  }
  if (node.length) out.push({ questions: node });
  return out;
}

/** Opens a hidden stakeholder (disclosure only) and skips its open questions; whether it was hidden. */
function open(store: Store, persona: Persona, now: string): boolean {
  const repo = stakeholderRepos(store).questions;
  for (const q of repo.list({ personaId: persona.id, status: 'open' })) repo.update(q.id, { status: 'skipped' });
  if (!isHidden(persona)) return false;
  store.personas.update(persona.id, { disclosure: 'open' });
  return true;
}

/** The node questions close with the round: once no hidden stakeholder of the node has open questions, its open node-wide questions become `skipped`. */
function closeNodeQuestionsIfRoundDone(store: Store, workspaceId: string): void {
  const repo = stakeholderRepos(store).questions;
  const open = repo.list({ workspaceId, status: 'open' });
  const roundOpen = open.some((q) => {
    const p = q.personaId ? store.personas.get(q.personaId) : undefined;
    return !!p && isHidden(p);
  });
  if (roundOpen) return;
  for (const q of open) if (!q.personaId) repo.update(q.id, { status: 'skipped' });
}

/**
 * The user's answers to the round (all optional) and skips. Refuses, before any change: a question
 * that is not of the node the call names (404), one that is not open (409), the same question twice (400), a
 * skip naming no stakeholder of the tree (404). Returns the personas opened and the statements stored.
 */
export function answerQuestions(
  store: Store,
  actor: string,
  workspaceId: string,
  input: { answers: Array<{ questionId: string; text: string }>; skip?: string[]; skipAll?: boolean },
): { opened: string[]; statements: StakeholderStatement[] } {
  const repos = stakeholderRepos(store);
  const root = rootOf(store, workspaceId);
  const answers = Array.isArray(input.answers) ? input.answers : [];
  const seen = new Set<string>();
  const given: Array<{ q: StakeholderQuestion; text: string }> = [];
  for (const a of answers) {
    // A blank answer is not an answer: it is ignored as if it had not been sent.
    if (typeof a?.text === 'string' && !a.text.trim()) continue;
    const q = typeof a?.questionId === 'string' ? repos.questions.get(a.questionId) : undefined;
    if (!q || q.rootWorkspaceId !== root || q.workspaceId !== workspaceId) {
      throw new StakeholderError(`question '${String(a?.questionId)}' not found`, 404);
    }
    if (seen.has(q.id)) throw new StakeholderError(`question '${q.id}' is answered twice`, 400);
    seen.add(q.id);
    if (q.status !== 'open') throw new StakeholderError(`question '${q.id}' is ${q.status}`, 409);
    if (typeof a.text !== 'string') throw new StakeholderError(`answer to '${q.id}' must be a text`, 400);
    const text = statementText(store, q.workspaceId, a.text);
    if (text) given.push({ q, text });
  }
  const skipped = (Array.isArray(input.skip) ? input.skip : []).map((id) => ownStakeholder(store, workspaceId, id));

  return store.transaction(() => {
    const now = new Date().toISOString();
    const touched = new Map<string, Persona>();
    const touch = (id: string | undefined) => {
      const p = id ? store.personas.get(id) : undefined;
      if (p) touched.set(p.id, p);
    };
    for (const p of skipped) touched.set(p.id, p);
    if (input.skipAll === true) {
      for (const q of repos.questions.list({ workspaceId, status: 'open' })) touch(q.personaId);
    }
    const statements: StakeholderStatement[] = [];
    for (const { q, text } of given) {
      const s = insertStatement(store, {
        workspaceId: q.workspaceId,
        ...(q.personaId ? { personaId: q.personaId } : {}),
        source: 'question_answer',
        field: q.field,
        text,
        questionId: q.id,
        actor,
        createdAt: now,
      });
      repos.questions.update(q.id, { status: 'answered', statementId: s.id, answeredAt: now });
      statements.push(s);
      touch(q.personaId);
    }
    const opened = [...touched.values()].filter((p) => open(store, p, now)).map((p) => p.id);
    if (input.skipAll === true) {
      for (const q of repos.questions.list({ workspaceId, status: 'open' })) repos.questions.update(q.id, { status: 'skipped' });
    }
    if (given.length || touched.size || input.skipAll === true) {
      closeNodeQuestionsIfRoundDone(store, workspaceId);
      recordFeedback(store, {
        workspaceId,
        actor,
        kind: 'stakeholder_answers',
        targetType: 'workspace',
        targetId: workspaceId,
        afterJson: { answered: given.map((g) => g.q.id), opened },
      });
    }
    return { opened, statements };
  });
}

/** "Show what the tool found": opens the stakeholder (a skip of its open questions) and records `stakeholder_reveal`; no change when open already. */
export function revealStakeholder(store: Store, actor: string, workspaceId: string, personaId: string): Persona {
  const persona = ownStakeholder(store, workspaceId, personaId);
  if (!isHidden(persona)) return persona;
  return store.transaction(() => {
    const now = new Date().toISOString();
    const skipped = stakeholderRepos(store).questions.list({ personaId: persona.id, status: 'open' }).map((q) => q.id);
    open(store, persona, now);
    const nodes = new Set(stakeholderRepos(store).questions.list({ personaId: persona.id }).map((q) => q.workspaceId));
    for (const node of nodes) closeNodeQuestionsIfRoundDone(store, node);
    recordFeedback(store, {
      workspaceId: persona.workspaceId,
      actor,
      kind: 'stakeholder_reveal',
      targetType: 'stakeholder',
      targetId: persona.id,
      afterJson: { personaId: persona.id, skipped },
    });
    return store.personas.get(persona.id)!;
  });
}
