/**
 * What kind of stakeholder persona a persona is (positions design 2026-11-15 §3, §6). The predicates
 * depend on the persona's own fields only and this module imports nothing but types, so every layer
 * (the agent.md compiler, the knowledge read paths, reads, learning, the position actions) can ask the
 * same question without an import cycle. `positions.ts` re-exports them.
 */
import type { Persona, TaskType } from '../types.js';

/** A former colleague: a stakeholder persona with a leaving date (at a competitor, or parked). */
export function isFormerColleague(p: Pick<Persona, 'kind' | 'leftAt'>): boolean {
  return p.kind === 'stakeholder' && !!p.leftAt;
}

/**
 * Parked: a former colleague who went somewhere that is no competitor of the tree (`subjectKind:
 * 'former'`). Takes part in no read and no question round, and learns from the user's notes only.
 */
export function isParked(p: Pick<Persona, 'kind' | 'subjectKind'>): boolean {
  return p.kind === 'stakeholder' && p.subjectKind === 'former';
}

/**
 * Whether the persona's text (agent.md, learning prompt, layers) is internal: true for every stakeholder
 * persona except a competitor's stakeholder that never worked here. An own stakeholder, a parked former
 * colleague and a former colleague at a competitor all hold what the company knew from inside.
 */
export function holdsInternal(p: Pick<Persona, 'kind' | 'subjectKind' | 'leftAt'>): boolean {
  return p.kind === 'stakeholder' && !(p.subjectKind === 'competitor' && !p.leftAt);
}

/**
 * Task types whose runs follow former colleagues on the web (positions design §7.1). Their prompt names
 * former colleagues by id, so the two layers are kept apart for them: such a run is served no internal
 * text of a persona (`holdsInternal`) by the knowledge read paths, only its label and type, as for a
 * hidden stakeholder.
 */
export const FOLLOW_TASK_TYPES: ReadonlySet<TaskType> = new Set(['competitor_stakeholders']);
