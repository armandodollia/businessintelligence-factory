/**
 * User persona: the wording of the You page (design 2026-11-15-user-persona-design.md §12). Pure
 * helpers; `useUserPersona` (hooks.ts) holds the state and the user's actions, `views/You.tsx` renders.
 */
import { plural } from './flows.js';
import type { UserInteractionGate, UserInteractionStats, UserPersonaView, UserStance } from './types.js';

/** The payload, or null for anything not shaped like one (e.g. an older server). */
export function asUserPersonaView(data: unknown): UserPersonaView | null {
  const v = data as Partial<UserPersonaView> | null | undefined;
  return v && typeof v === 'object' && typeof v.enabled === 'boolean' && Array.isArray(v.fields) && Array.isArray(v.proposals) && !!v.gate && !!v.stats
    ? (v as UserPersonaView)
    : null;
}

const STANCE_WORDS: Array<[UserStance, string]> = [
  ['accept', 'Accepted'],
  ['reject', 'rejected'],
  ['edit', 'edited'],
  ['neutral', 'other'],
];

/** "Accepted 14 · rejected 9 · edited 3 · other 2 (28 actions)"; stances with no action are left out. */
export function statsLine(stats: UserInteractionStats): string {
  if (!stats.total) return 'Nothing yet.';
  const totals = STANCE_WORDS.map(([stance, word]) => {
    const n = Object.values(stats.byKind).reduce((sum, k) => sum + (k[stance] ?? 0), 0);
    return [word, n] as const;
  }).filter(([, n]) => n > 0);
  const parts = totals.map(([word, n], i) => `${i === 0 ? word.charAt(0).toUpperCase() + word.slice(1) : word.toLowerCase()} ${n}`);
  return `${parts.join(' · ')} (${plural(stats.total, 'action')})`;
}

/** "Next retro: 7 of 12 actions since the last learning run." or "Enough for the next retro." */
export function nextRetroLine(gate: Pick<UserInteractionGate, 'qualifies' | 'missing'>, hasPending: boolean): string {
  if (gate.qualifies) return hasPending ? 'Enough for the next retro, once you have answered the proposals below.' : 'Enough for the next retro.';
  return `Next retro: ${gate.missing.join(', ')} since the last learning run.`;
}

/** "Used by: orchestrator, synthesizer, interviewer". */
export const usedByLine = (v: Pick<UserPersonaView, 'usedBy'>): string => `Used by: ${v.usedBy.join(', ')}`;

/** "Rests on 5 of your actions". */
export const lineEvidenceText = (n: number): string => `Rests on ${n} of your actions`;

/** "1 proposal about you waiting". */
export const aboutYouText = (n: number): string => `${plural(n, 'proposal')} about you waiting`;
