/**
 * The persona learning gate (design 2026-11-15-persona-learning-design.md §6): a persona qualifies for
 * a learning run when it has enough reactions, on enough different things, and the user's disagreement
 * rate is clearly above the floor (lower bound of the 95% Wilson interval). Agreements count against a
 * change. Pure arithmetic over the persona's open signals.
 */
import type { PersonaLearningSettings } from './settings.js';
import type { GateResult, GateStats, PersonaSignal } from './types.js';

/** Lower bound of the Wilson score interval of `k / n` (z 1.96: 95%); 0 when `n` is 0. */
export function wilsonLower(k: number, n: number, z = 1.96): number {
  if (n <= 0) return 0;
  const p = k / n;
  const z2 = z * z;
  const centre = p + z2 / (2 * n);
  const spread = z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));
  return Math.max(0, (centre - spread) / (1 + z2 / n));
}

/** Gate numbers of signals: count, agreements, disagreements, distinct items, Wilson lower bound of the disagree rate. */
export function gateStats(signals: PersonaSignal[]): GateStats {
  const disagree = signals.filter((s) => s.polarity === 'disagree').length;
  return {
    n: signals.length,
    agree: signals.length - disagree,
    disagree,
    items: new Set(signals.map((s) => s.itemKey)).size,
    lower: wilsonLower(disagree, signals.length),
  };
}

/** Whether the signals qualify the persona for a learning run, and what is missing when they do not. */
export function personaGate(signals: PersonaSignal[], settings: PersonaLearningSettings): GateResult {
  const stats = gateStats(signals);
  const missing: string[] = [];
  if (stats.n < settings.minSignals) missing.push(`${stats.n} of ${settings.minSignals} reactions`);
  if (stats.items < settings.minDistinctItems) missing.push(`${stats.items} of ${settings.minDistinctItems} different things`);
  if (stats.lower < settings.disagreeFloor) missing.push(`disagreement not clearly above ${Math.round(settings.disagreeFloor * 100)}%`);
  return { ...stats, qualifies: missing.length === 0, missing };
}
