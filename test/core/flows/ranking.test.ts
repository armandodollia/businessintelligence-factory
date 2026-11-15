import { describe, expect, it } from 'vitest';
import {
  checklistScore,
  combinedChecklistScore,
  pairPreference,
  personaScores,
  rankFlows,
  type PairVerdict,
  type RankInput,
  type RankOverride,
} from '../../../src/core/flows/ranking.js';
import type { CheckAnswer, ChecklistItem } from '../../../src/core/flows/types.js';

const item = (key: string, extra: Partial<ChecklistItem> = {}): ChecklistItem => ({
  key,
  question: `Question ${key}`,
  kind: 'yes_no',
  pass: { answer: 'yes' },
  weight: 1,
  scored: true,
  answeredBy: 'walkthrough',
  ...extra,
});
const check = (itemKey: string, answer: CheckAnswer) => ({ itemKey, answer });

const verdict = (flowAId: string, flowBId: string, personaId: string, winner: PairVerdict['winner'], strength: PairVerdict['strength'] = 3): PairVerdict => ({
  flowAId,
  flowBId,
  personaId,
  winner,
  strength,
});
const override = (id: string, winnerFlowId: string, loserFlowId: string, createdAt: string): RankOverride => ({ id, winnerFlowId, loserFlowId, createdAt });

const NO_EXTRAS = { coverage: 0.6, tieMargin: 5, verdicts: [] as PairVerdict[], overrides: [] as RankOverride[] };
const order = (r: ReturnType<typeof rankFlows>) => r.ranked.map((f) => f.flowId);
const byId = (r: ReturnType<typeof rankFlows>, id: string) => r.ranked.find((f) => f.flowId === id)!;

describe('checklistScore', () => {
  it('checklistScore: 3 pass, 1 fail, 1 disputed, 1 na, 1 recorded → 70', () => {
    const items = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((k) => item(k));
    const checks = [check('a', 'pass'), check('b', 'pass'), check('c', 'pass'), check('d', 'fail'), check('e', 'disputed'), check('f', 'na'), check('g', 'recorded')];
    expect(checklistScore(items, checks)).toBeCloseTo(70, 10);
  });

  it('checklistScore is undefined when nothing scored applies', () => {
    const items = [item('a'), item('b'), item('c', { scored: false }), item('d')];
    // na, no_signal, unanswered (b), an unscored item and a check matching no item are all left out.
    const checks = [check('a', 'na'), check('c', 'pass'), check('d', 'no_signal'), check('zz', 'pass')];
    expect(checklistScore(items, checks)).toBeUndefined();
    expect(checklistScore([], [])).toBeUndefined();
  });

  it('weights the mean, counts reported_problem as 0 and never counts an unscored item', () => {
    const items = [item('a', { weight: 3 }), item('b'), item('c', { scored: false })];
    expect(checklistScore(items, [check('a', 'pass'), check('b', 'reported_problem'), check('c', 'fail')])).toBeCloseTo(75, 10);
  });

  it('combinedChecklistScore: one weighted mean over two lists, each item scored only against its own list', () => {
    // The general and the specific list both use the key `a`; each list's answer applies to its own item.
    const general = [item('a'), item('b')];
    const specific = [item('a', { weight: 2 }), item('c')];
    const score = combinedChecklistScore([
      { items: general, checks: [check('a', 'fail'), check('b', 'pass')] },
      { items: specific, checks: [check('a', 'pass'), check('c', 'na')] },
    ]);
    // general: a fail (0 × 1), b pass (1 × 1); specific: a pass (1 × 2), c left out → 3 / 4.
    expect(score).toBeCloseTo(75, 10);
    // Without the specific list's answers its items are left out, not matched to the general answer of `a`.
    expect(combinedChecklistScore([
      { items: general, checks: [check('a', 'pass'), check('b', 'pass')] },
      { items: specific, checks: [] },
    ])).toBeCloseTo(100, 10);
    expect(combinedChecklistScore([])).toBeUndefined();
  });
});

describe('personaScores and pairPreference', () => {
  it('personaScores: a strong win is 100 against 0, a tie is 50 each, personas count equally', () => {
    const strong = personaScores(['x', 'y'], [verdict('x', 'y', 'p1', 'a', 3)]);
    expect(strong.get('x')).toBeCloseTo(100, 10);
    expect(strong.get('y')).toBeCloseTo(0, 10);

    const tie = personaScores(['x', 'y'], [verdict('x', 'y', 'p1', 'tie', 2)]);
    expect(tie.get('x')).toBeCloseTo(50, 10);
    expect(tie.get('y')).toBeCloseTo(50, 10);

    // p1 judged x three times (wins strongly each time), p2 once (loses strongly): personas count
    // equally, so x is 50, not 75.
    const many = personaScores(
      ['x', 'y', 'z', 'w'],
      [verdict('x', 'y', 'p1', 'a'), verdict('z', 'x', 'p1', 'b'), verdict('x', 'w', 'p1', 'a'), verdict('x', 'y', 'p2', 'b')],
    );
    expect(many.get('x')).toBeCloseTo(50, 10);
    // y: p1 lost strongly (0), p2 won strongly (100) → 50.
    expect(many.get('y')).toBeCloseTo(50, 10);
  });

  it('personaScores: slight and clear strengths, unknown flows ignored, unjudged flows absent', () => {
    const scores = personaScores(['x', 'y', 'z'], [verdict('x', 'y', 'p1', 'b', 1), verdict('x', 'ghost', 'p1', 'a', 3)]);
    expect(scores.get('x')).toBeCloseTo((0.5 - 1 / 6) * 100, 10);
    expect(scores.get('y')).toBeCloseTo((0.5 + 1 / 6) * 100, 10);
    expect(scores.has('z')).toBe(false);
    expect(scores.has('ghost')).toBe(false);
  });

  it('pairPreference sums ±strength over the verdicts on the pair, either way round', () => {
    const verdicts = [verdict('x', 'y', 'p1', 'a', 2), verdict('y', 'x', 'p2', 'a', 1), verdict('x', 'y', 'p3', 'tie', 3), verdict('x', 'z', 'p1', 'a', 3)];
    expect(pairPreference('x', 'y', verdicts)).toBe(1);
    expect(pairPreference('y', 'x', verdicts)).toBe(-1);
    expect(pairPreference('y', 'z', verdicts)).toBe(0);
  });
});

describe('rankFlows', () => {
  it('blend: checklist 90/60 and persona 40/70 → at coverage 0.7 the checklist leader is first (75 vs 63); at coverage 0.3 the persona favourite is first (55 vs 67)', () => {
    const inputs: RankInput[] = [
      { flowId: 'a', checklist: 90, persona: 40 },
      { flowId: 'b', checklist: 60, persona: 70 },
    ];
    const high = rankFlows(inputs, { ...NO_EXTRAS, coverage: 0.7 });
    expect(order(high)).toEqual(['a', 'b']);
    expect(byId(high, 'a').rankScore).toBeCloseTo(75, 10);
    expect(byId(high, 'b').rankScore).toBeCloseTo(63, 10);
    expect(byId(high, 'a')).toMatchObject({ position: 1, decidedBy: 'blend', checklist: 90, persona: 40 });
    expect(byId(high, 'b').position).toBe(2);

    const low = rankFlows(inputs, { ...NO_EXTRAS, coverage: 0.3 });
    expect(order(low)).toEqual(['b', 'a']);
    expect(byId(low, 'a').rankScore).toBeCloseTo(55, 10);
    expect(byId(low, 'b').rankScore).toBeCloseTo(67, 10);
  });

  it('two flows within the tie margin are ordered by their head-to-head; an even head-to-head shares the position', () => {
    const inputs: RankInput[] = [
      { flowId: 'a', checklist: 80 },
      { flowId: 'b', checklist: 77 },
      { flowId: 'c', checklist: 50 },
    ];
    const won = rankFlows(inputs, { ...NO_EXTRAS, verdicts: [verdict('a', 'b', 'p1', 'b', 2), verdict('b', 'a', 'p2', 'tie', 1)] });
    expect(order(won)).toEqual(['b', 'a', 'c']);
    expect(won.ranked.map((f) => f.position)).toEqual([1, 2, 3]);
    expect(byId(won, 'b').tieBrokenWith).toEqual(['a']);
    expect(byId(won, 'a').tieBrokenWith).toEqual(['b']);
    expect(byId(won, 'c').tieBrokenWith).toBeUndefined();

    const even = rankFlows(inputs, { ...NO_EXTRAS, verdicts: [verdict('a', 'b', 'p1', 'a', 2), verdict('a', 'b', 'p2', 'b', 2)] });
    expect(order(even)).toEqual(['a', 'b', 'c']);
    expect(even.ranked.map((f) => f.position)).toEqual([1, 1, 3]);
    expect(byId(even, 'a').sharedPosition).toBe(true);
    expect(byId(even, 'b').sharedPosition).toBe(true);
    expect(byId(even, 'c').sharedPosition).toBeUndefined();

    // Outside the margin the head-to-head does not reorder.
    const apart = rankFlows(inputs, { ...NO_EXTRAS, tieMargin: 2, verdicts: [verdict('a', 'b', 'p1', 'b', 3)] });
    expect(order(apart)).toEqual(['a', 'b', 'c']);
    expect(byId(apart, 'a').tieBrokenWith).toBeUndefined();
  });

  it('the tie-break pass moves a flow at most one place', () => {
    const inputs: RankInput[] = [
      { flowId: 'a', checklist: 80 },
      { flowId: 'b', checklist: 79 },
      { flowId: 'c', checklist: 78 },
    ];
    // b beats a, c beats a: a drops one place to second and is not compared again.
    const r = rankFlows(inputs, { ...NO_EXTRAS, verdicts: [verdict('a', 'b', 'p1', 'b'), verdict('a', 'c', 'p1', 'b')] });
    expect(order(r)).toEqual(['b', 'a', 'c']);
  });

  it('a flow with no checklist score ranks on its persona score and is never treated as 0', () => {
    const r = rankFlows(
      [
        { flowId: 'a', persona: 80 },
        { flowId: 'b', checklist: 70, persona: 40 },
      ],
      { ...NO_EXTRAS, coverage: 0.7 },
    );
    expect(order(r)).toEqual(['a', 'b']);
    expect(byId(r, 'a')).toMatchObject({ rankScore: 80, decidedBy: 'persona_only', persona: 80 });
    expect(byId(r, 'a').checklist).toBeUndefined();
  });

  it('a single flow has no persona score and is checklist_only', () => {
    const scores = personaScores(['solo'], []);
    expect(scores.has('solo')).toBe(false);
    const r = rankFlows([{ flowId: 'solo', checklist: 64, persona: scores.get('solo') }], NO_EXTRAS);
    expect(r.ranked).toEqual([{ flowId: 'solo', position: 1, rankScore: 64, checklist: 64, decidedBy: 'checklist_only' }]);
    expect(r.ignoredOverrides).toEqual([]);
  });

  it('an override places the winner directly above the loser and marks both', () => {
    const inputs: RankInput[] = [
      { flowId: 'a', checklist: 90 },
      { flowId: 'b', checklist: 70 },
      { flowId: 'c', checklist: 50 },
      { flowId: 'd', checklist: 30 },
    ];
    const r = rankFlows(inputs, { ...NO_EXTRAS, overrides: [override('fov_1', 'd', 'b', '2026-11-14T10:00:00.000Z')] });
    expect(order(r)).toEqual(['a', 'd', 'b', 'c']);
    expect(r.ranked.map((f) => f.position)).toEqual([1, 2, 3, 4]);
    expect(byId(r, 'd').overriddenBy).toEqual(['fov_1']);
    expect(byId(r, 'b').overriddenBy).toEqual(['fov_1']);
    expect(byId(r, 'a').overriddenBy).toBeUndefined();
    expect(byId(r, 'c').overriddenBy).toBeUndefined();
    // The scores are untouched.
    expect(byId(r, 'd').rankScore).toBe(30);
  });

  it('an override undoes a tie-break and a shared position on its pair', () => {
    const inputs: RankInput[] = [
      { flowId: 'a', checklist: 80 },
      { flowId: 'b', checklist: 78 },
    ];
    const swapped = rankFlows(inputs, { ...NO_EXTRAS, verdicts: [verdict('a', 'b', 'p1', 'b')], overrides: [override('fov_1', 'a', 'b', '2026-11-14T10:00:00.000Z')] });
    expect(order(swapped)).toEqual(['a', 'b']);
    expect(byId(swapped, 'a').overriddenBy).toEqual(['fov_1']);

    const shared = rankFlows(inputs, { ...NO_EXTRAS, overrides: [override('fov_1', 'b', 'a', '2026-11-14T10:00:00.000Z')] });
    expect(order(shared)).toEqual(['b', 'a']);
    expect(shared.ranked.map((f) => f.position)).toEqual([1, 2]);
    expect(byId(shared, 'a').sharedPosition).toBeUndefined();
  });

  it('chained overrides are all respected', () => {
    const inputs: RankInput[] = ['a', 'b', 'c', 'd', 'e'].map((flowId, i) => ({ flowId, checklist: 90 - i * 10 }));
    const r = rankFlows(inputs, {
      ...NO_EXTRAS,
      overrides: [override('fov_1', 'e', 'c', '2026-11-14T10:00:00.000Z'), override('fov_2', 'd', 'e', '2026-11-14T11:00:00.000Z'), override('fov_3', 'c', 'a', '2026-11-14T12:00:00.000Z')],
    });
    const at = (id: string) => order(r).indexOf(id);
    expect(at('e')).toBeLessThan(at('c'));
    expect(at('d')).toBeLessThan(at('e'));
    expect(at('c')).toBeLessThan(at('a'));
    expect(r.ignoredOverrides).toEqual([]);
  });

  it('conflicting overrides: the newest wins and the older one is reported as ignored, each with its reason (M1)', () => {
    const inputs: RankInput[] = [
      { flowId: 'a', checklist: 90 },
      { flowId: 'b', checklist: 70 },
      { flowId: 'c', checklist: 50 },
    ];
    // Direct conflict.
    const direct = rankFlows(inputs, {
      ...NO_EXTRAS,
      overrides: [override('fov_old', 'c', 'a', '2026-11-14T10:00:00.000Z'), override('fov_new', 'a', 'c', '2026-11-14T11:00:00.000Z')],
    });
    expect(order(direct)).toEqual(['a', 'b', 'c']);
    expect(direct.ignoredOverrides).toEqual([{ id: 'fov_old', reason: 'conflict' }]);
    expect(byId(direct, 'c').overriddenBy).toBeUndefined();

    // A cycle through three overrides: the oldest closes it and is dropped, whatever the input order.
    const cycle = rankFlows(inputs, {
      ...NO_EXTRAS,
      overrides: [override('fov_3', 'a', 'c', '2026-11-14T12:00:00.000Z'), override('fov_1', 'c', 'b', '2026-11-14T10:00:00.000Z'), override('fov_2', 'b', 'a', '2026-11-14T11:00:00.000Z')],
    });
    expect(cycle.ignoredOverrides).toEqual([{ id: 'fov_1', reason: 'conflict' }]);
    expect(order(cycle)).toEqual(['b', 'a', 'c']);

    // An override naming a flow that is not ranked is ignored too, for that reason (and never counts as a conflict).
    const stray = rankFlows(inputs, {
      ...NO_EXTRAS,
      overrides: [override('fov_x', 'ghost', 'a', '2026-11-14T10:00:00.000Z'), override('fov_y', 'c', 'ghost', '2026-11-14T11:00:00.000Z')],
    });
    expect(stray.ignoredOverrides).toEqual([{ id: 'fov_x', reason: 'not_ranked' }, { id: 'fov_y', reason: 'not_ranked' }]);
    expect(order(stray)).toEqual(['a', 'b', 'c']);
  });

  it('flows with no scores come last', () => {
    const r = rankFlows(
      [
        { flowId: 'z_none' },
        { flowId: 'b', checklist: 10 },
        { flowId: 'a_none' },
        { flowId: 'c', persona: 5 },
      ],
      NO_EXTRAS,
    );
    expect(order(r)).toEqual(['b', 'c', 'a_none', 'z_none']);
    expect(byId(r, 'a_none')).toMatchObject({ rankScore: undefined, decidedBy: 'none', position: 3 });
    expect(byId(r, 'z_none').position).toBe(4);
    // Unscored flows never take part in the tie-break, even with a head-to-head between them.
    const tied = rankFlows([{ flowId: 'a' }, { flowId: 'b' }], { ...NO_EXTRAS, verdicts: [verdict('a', 'b', 'p1', 'b')] });
    expect(order(tied)).toEqual(['a', 'b']);
    expect(tied.ranked.map((f) => f.position)).toEqual([1, 2]);
  });

  it('every accepted override holds for random orders and constraint sets', () => {
    let seed = 7;
    const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
    for (let round = 0; round < 300; round++) {
      const n = 2 + Math.floor(rand() * 8);
      const ids = Array.from({ length: n }, (_, i) => `f${i}`);
      const inputs: RankInput[] = ids.map((flowId) => ({ flowId, checklist: Math.floor(rand() * 100) }));
      const overrides: RankOverride[] = Array.from({ length: Math.floor(rand() * n * 1.5) }, (_, i) => {
        const w = ids[Math.floor(rand() * n)]!;
        let l = ids[Math.floor(rand() * n)]!;
        if (l === w) l = ids[(ids.indexOf(w) + 1) % n]!;
        return override(`fov_${i}`, w, l, `2026-11-14T10:${String(i).padStart(2, '0')}:00.000Z`);
      });
      const r = rankFlows(inputs, { ...NO_EXTRAS, overrides });
      const at = (id: string) => order(r).indexOf(id);
      expect(order(r).slice().sort()).toEqual(ids.slice().sort());
      for (const o of overrides) {
        if (r.ignoredOverrides.some((x) => x.id === o.id)) continue;
        expect(at(o.winnerFlowId)).toBeLessThan(at(o.loserFlowId));
      }
    }
  });
});
