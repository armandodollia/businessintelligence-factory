/**
 * Persona learning: the wording of the "What the tool has learned" block on each persona card (design
 * 2026-11-15-persona-learning-design.md §14). Pure helpers; `usePersonaLearning` (hooks.ts) holds the
 * state and the user's actions, `views/personas/Learning.tsx` renders.
 */
import { plural } from './flows.js';
import type { AdjustmentEffect, GateResult, GateStats, PersonaLearningEntry, PersonaLearningView, PersonaProposal, PersonaSignal } from './types.js';

/** The payload, or null for anything not shaped like one (e.g. an older server). */
export function asPersonaLearningView(data: unknown): PersonaLearningView | null {
  const v = data as Partial<PersonaLearningView> | null | undefined;
  return v && typeof v === 'object' && typeof v.enabled === 'boolean' && Array.isArray(v.personas) ? (v as PersonaLearningView) : null;
}

/** "Reactions not yet used by a retro: 9 (4 agree, 5 disagree) on 6 different things." (the gate's open signals) */
export function reactionsLine(gate: Pick<GateStats, 'n' | 'agree' | 'disagree' | 'items'>): string {
  return `Reactions not yet used by a retro: ${gate.n} (${gate.agree} agree, ${gate.disagree} disagree) on ${plural(gate.items, 'different thing')}.`;
}

/** What the gate says: enough for a change, waiting on the user, or what is missing (one line each). */
export function gateLines(gate: Pick<GateResult, 'qualifies' | 'missing'>, hasPending: boolean): string[] {
  if (gate.qualifies) return [hasPending ? 'Enough for a change; the proposals below wait for your answer.' : 'Enough for a change at the next retro.'];
  return gate.missing.map((m) => `Not enough for a change yet: ${m}.`);
}

/** "62% of 8"; `—` without numbers. */
export function rateOf(s: Partial<GateStats>): string {
  if (!s.n || s.disagree === undefined) return '—';
  return `${Math.round((s.disagree / s.n) * 100)}% of ${s.n}`;
}

/** "Disagreement before 62% of 8 · since 20% of 5". */
export function effectLine(e: AdjustmentEffect): string {
  return `Disagreement before ${rateOf(e.before)} · since ${rateOf(e.since)}`;
}

/** "Rests on 4 reactions", with the polarities once the persona's signals are loaded. */
export function evidenceLine(p: Pick<PersonaProposal, 'evidence'>, signals?: PersonaSignal[]): string {
  const base = `Rests on ${plural(p.evidence.length, 'reaction')}`;
  if (!signals) return base;
  const cited = signals.filter((s) => p.evidence.includes(s.id));
  const disagree = cited.filter((s) => s.polarity === 'disagree').length;
  return `${base} (${disagree} disagree, ${cited.length - disagree} agree)`;
}

/** The signals a proposal cites, in the order given (newest first from the API). */
export const citedSignals = (p: Pick<PersonaProposal, 'evidence'>, signals: PersonaSignal[]): PersonaSignal[] =>
  signals.filter((s) => p.evidence.includes(s.id));

/** "add (buying_behavior)". */
export const proposalLabel = (p: Pick<PersonaProposal, 'action' | 'field'>): string => (p.field ? `${p.action} (${p.field})` : p.action);

/** Whether the user can edit a proposal's text before accepting it (a retire has no text of its own). */
export const editable = (p: Pick<PersonaProposal, 'action'>): boolean => p.action !== 'retire';

/** Pending proposals across the whole business tree (`pendingInTree`); an older server: across the node's personas. */
export const pendingProposals = (v: PersonaLearningView | null): number =>
  v?.pendingInTree ?? (v?.personas ?? []).reduce((n, p: PersonaLearningEntry) => n + p.proposals.filter((x) => x.status === 'pending').length, 0);

/** "2 persona proposals waiting". */
export const waitingText = (n: number): string => `${plural(n, 'persona proposal')} waiting`;
