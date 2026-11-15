/**
 * The persona learning gate (design §6): enough reactions, on enough different things, with the
 * disagreement rate clearly above the floor (lower bound of the 95% Wilson interval).
 */
import { describe, expect, it } from 'vitest';
import { defaultConfig } from '../../../src/core/config/schema.js';
import { gateStats, personaGate, wilsonLower } from '../../../src/core/personas/gate.js';
import { personaLearningSettings } from '../../../src/core/personas/settings.js';
import type { PersonaSignal } from '../../../src/core/personas/types.js';

const settings = personaLearningSettings(defaultConfig);

/** `disagree` disagreements out of `n` signals, spread over `items` distinct items. */
function signals(disagree: number, n: number, items = 6): PersonaSignal[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `fbk_${i}`, source: 'verdict_reaction', personaId: 'per_smb', polarity: i < disagree ? 'disagree' : 'agree',
    itemKey: `item_${i % items}`, topic: 'flow:sign_up', detail: 'x', refs: [], at: `2026-11-15T10:00:${String(i).padStart(2, '0')}.000Z`,
  }));
}

describe('wilsonLower', () => {
  it('is the lower bound of the 95% Wilson interval, 0 for no observations', () => {
    expect(wilsonLower(5, 6)).toBeCloseTo(0.436, 2);
    expect(Math.abs(wilsonLower(5, 6) - 0.436)).toBeLessThan(0.005);
    expect(wilsonLower(0, 0)).toBe(0);
    expect(wilsonLower(0, 10)).toBe(0);
    expect(wilsonLower(5, 6, 1)).toBeGreaterThan(wilsonLower(5, 6));
  });
});

describe('gateStats', () => {
  it('counts signals, agreements, disagreements and distinct items, with the Wilson lower bound of the disagree rate', () => {
    const s = gateStats(signals(5, 8, 3));
    expect(s).toEqual({ n: 8, agree: 3, disagree: 5, items: 3, lower: wilsonLower(5, 8) });
    expect(gateStats([])).toEqual({ n: 0, agree: 0, disagree: 0, items: 0, lower: 0 });
  });
});

describe('personaGate', () => {
  it.each([
    [5, 6, true],
    [4, 6, false],
    [5, 8, true],
    [10, 20, false],
    [11, 20, true],
  ])('with the defaults, %i disagreements of %i qualifies: %s', (d, n, qualifies) => {
    const g = personaGate(signals(d, n), settings);
    expect(g.qualifies).toBe(qualifies);
    expect(g).toMatchObject({ n, disagree: d, agree: n - d, items: 6 });
    expect(g.missing).toEqual(qualifies ? [] : ['disagreement not clearly above 30%']);
  });

  it('6 disagreements on 3 things are not enough different things', () => {
    const g = personaGate(signals(6, 6, 3), settings);
    expect(g.qualifies).toBe(false);
    expect(g.missing).toEqual(['3 of 4 different things']);
  });

  it('no signals: every line is missing', () => {
    const g = personaGate([], settings);
    expect(g).toEqual({
      n: 0, agree: 0, disagree: 0, items: 0, lower: 0, qualifies: false,
      missing: ['0 of 6 reactions', '0 of 4 different things', 'disagreement not clearly above 30%'],
    });
  });
});
