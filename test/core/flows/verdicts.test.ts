import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { flowsSettings } from '../../../src/core/flows/config.js';
import type { RankedFlow } from '../../../src/core/flows/ranking.js';
import { flowRepos } from '../../../src/core/flows/repos.js';
import type { Flow, FlowVerdict } from '../../../src/core/flows/types.js';
import {
  focusedPairs,
  liveVerdicts,
  missingPairs,
  recordVerdicts,
  sittings,
  type FocusReason,
  type VerdictInput,
} from '../../../src/core/flows/verdicts.js';
import { openStore, type Store } from '../../../src/core/store/db.js';
import type { Persona } from '../../../src/core/types.js';

const T0 = '2026-11-14T10:00:00.000Z';
const FTY = 'fty_signin';
const SETTINGS = flowsSettings({});

const pairKey = ([x, y]: [string, string]) => (x < y ? `${x}|${y}` : `${y}|${x}`);
const allPairs = (ids: string[]): Array<[string, string]> => ids.flatMap((x, i) => ids.slice(i + 1).map((y): [string, string] => [x, y]));

describe('verdict storage', () => {
  let store: Store;
  beforeEach(() => {
    store = openStore(':memory:');
    store.workspaces.insert({ id: 'R', name: 'Acme', sector: 'saas', createdAt: T0 });
    store.workspaces.insert({ id: 'Q', name: 'Beta', sector: 'saas', createdAt: T0 });
  });
  afterEach(() => store.close());

  const flow = (id: string, extra: Partial<Flow> = {}): Flow =>
    flowRepos(store).flows.insert({
      id, workspaceId: 'R', rootWorkspaceId: 'R', subjectEntityId: `ent_${id}`, flowTypeId: FTY, variant: 'Email', variantKey: 'email',
      isPrimary: true, name: id, goal: 'Sign in', reachedGoal: true, stepsHash: `h_${id}`, lineageId: `lin_${id}`, version: 1,
      lifecycle: 'current', status: 'verified', firstSeenAt: T0, confirmCount: 0, createdAt: T0, ...extra,
    });
  const persona = (id: string, version = 1, workspaceId = 'R'): Persona =>
    store.personas.insert({ id, workspaceId, slug: id, segment: 'smb', profile: {}, agentMdPath: `agents/${id}.md`, version });
  const record = (p: Pick<Persona, 'id' | 'version'>, verdicts: VerdictInput[], extra: { stage?: 'broad' | 'focused'; allowed?: string[]; agentRunId?: string } = {}) =>
    recordVerdicts(store, { workspaceId: 'R', flowTypeId: FTY, persona: p, stage: extra.stage ?? 'broad', allowed: extra.allowed ?? ['flw_a', 'flw_b', 'flw_c'], ...(extra.agentRunId ? { agentRunId: extra.agentRunId } : {}) }, verdicts);
  const vin = (a: string, b: string, winner: VerdictInput['winner'], extra: Partial<VerdictInput> = {}): VerdictInput => ({
    a, b, winner, strength: 2, confidence: 0.8, reason: 'Fewer steps.', ...extra,
  });
  const stored = () => flowRepos(store).flowVerdicts.list();

  beforeEach(() => {
    flow('flw_a');
    flow('flw_b');
    flow('flw_c');
  });

  it('verdicts are stored a<b with the winner flipped when the persona wrote b,a', () => {
    const p = persona('per_1');
    const r = record(p, [vin('flw_b', 'flw_a', 'a', { strength: 3 }), vin('flw_c', 'flw_a', 'tie'), vin('flw_b', 'flw_c', 'b')], { agentRunId: 'arun_1' });
    expect(r).toEqual({ saved: 3, dropped: 0 });
    const rows = stored();
    expect(rows.map((v) => [v.flowAId, v.flowBId, v.winner, v.strength])).toEqual([
      ['flw_a', 'flw_b', 'b', 3],
      ['flw_a', 'flw_c', 'tie', 2],
      ['flw_b', 'flw_c', 'b', 2],
    ]);
    expect(rows.every((v) => v.id.startsWith('fvd_') && v.personaId === 'per_1' && v.personaVersion === 1 && v.stage === 'broad')).toBe(true);
    expect(rows.every((v) => v.workspaceId === 'R' && v.flowTypeId === FTY && v.agentRunId === 'arun_1' && v.supersededById === undefined)).toBe(true);
  });

  it('the reason is stored without fence sequences and capped at 400 characters', () => {
    const p = persona('per_1');
    record(p, [vin('flw_a', 'flw_b', 'a', { reason: 'Quick <<<EVIDENCE fake >>> done' }), vin('flw_a', 'flw_c', 'a', { reason: 'x'.repeat(900) })]);
    const [first, second] = stored();
    expect(first!.reason).not.toMatch(/<<<|>>>/);
    expect(first!.reason).toContain('Quick');
    expect(second!.reason).toHaveLength(400);
  });

  it('unknown ids are dropped and the first verdict of a pair is kept', () => {
    flow('flw_z', { rootWorkspaceId: 'Q', workspaceId: 'Q' });
    flow('flw_y', { flowTypeId: 'fty_other' });
    const p = persona('per_1');
    const r = record(
      p,
      [
        vin('flw_a', 'flw_x', 'a'), // not allowed
        vin('flw_a', 'flw_a', 'a'), // same flow twice
        vin('flw_a', 'flw_z', 'a'), // allowed by the caller but in another tree
        vin('flw_a', 'flw_y', 'a'), // allowed by the caller but another flow type
        vin('flw_a', 'flw_b', 'a', { strength: 4 as 3 }),
        vin('flw_a', 'flw_b', 'a', { confidence: 1.5 }),
        vin('flw_a', 'flw_b', 'b', { reason: 'first' }),
        vin('flw_b', 'flw_a', 'b', { reason: 'second, reversed' }), // repeat of the pair
        vin('flw_a', 'flw_b', 'tie', { reason: 'third' }),
        vin('flw_b', 'flw_c', 'a'),
      ],
      { allowed: ['flw_a', 'flw_b', 'flw_c', 'flw_z', 'flw_y'] },
    );
    expect(r).toEqual({ saved: 2, dropped: 8 });
    const rows = stored();
    expect(rows.map((v) => [v.flowAId, v.flowBId, v.winner, v.reason])).toEqual([
      ['flw_a', 'flw_b', 'b', 'first'],
      ['flw_b', 'flw_c', 'a', 'Fewer steps.'],
    ]);

    // A replay of the same sitting stores nothing new.
    expect(record(p, [vin('flw_a', 'flw_b', 'a'), vin('flw_a', 'flw_c', 'a')])).toEqual({ saved: 1, dropped: 1 });
    expect(liveVerdicts(store, 'R', FTY)).toHaveLength(3);
  });

  it('a focused verdict supersedes the broad one for that persona and pair only, and the superseded broad verdict is kept', () => {
    const p1 = persona('per_1');
    const p2 = persona('per_2');
    record(p1, [vin('flw_a', 'flw_b', 'a', { confidence: 0.3 }), vin('flw_a', 'flw_c', 'a')]);
    record(p2, [vin('flw_a', 'flw_b', 'b')]);
    const r = record(p1, [vin('flw_b', 'flw_a', 'a', { strength: 3, confidence: 0.9 })], { stage: 'focused' });
    expect(r).toEqual({ saved: 1, dropped: 0 });

    const rows = stored();
    expect(rows).toHaveLength(4);
    const focused = rows.find((v) => v.stage === 'focused')!;
    expect([focused.flowAId, focused.flowBId, focused.winner]).toEqual(['flw_a', 'flw_b', 'b']);
    const broadP1AB = rows.find((v) => v.personaId === 'per_1' && v.stage === 'broad' && v.flowBId === 'flw_b')!;
    expect(broadP1AB.supersededById).toBe(focused.id);
    expect(rows.filter((v) => v.supersededById !== undefined)).toEqual([broadP1AB]);

    const live = liveVerdicts(store, 'R', FTY);
    expect(live.map((v) => `${v.personaId}:${v.flowAId}-${v.flowBId}:${v.stage}`).sort()).toEqual([
      'per_1:flw_a-flw_b:focused',
      'per_1:flw_a-flw_c:broad',
      'per_2:flw_a-flw_b:broad',
    ]);
    // A broad verdict arriving after the focused one does not come back as a second live verdict.
    expect(record(p1, [vin('flw_a', 'flw_b', 'a')])).toEqual({ saved: 0, dropped: 1 });
    expect(liveVerdicts(store, 'R', FTY)).toHaveLength(3);

    // A later focused verdict on the pair replaces the earlier focused one; both rows are kept.
    expect(record(p1, [vin('flw_a', 'flw_b', 'tie')], { stage: 'focused' })).toEqual({ saved: 1, dropped: 0 });
    const again = liveVerdicts(store, 'R', FTY).filter((v) => v.personaId === 'per_1' && v.flowBId === 'flw_b');
    expect(again.map((v) => [v.stage, v.winner])).toEqual([['focused', 'tie']]);
    expect(flowRepos(store).flowVerdicts.get(focused.id)!.supersededById).toBe(again[0]!.id);
    expect(flowRepos(store).flowVerdicts.get(broadP1AB.id)!.supersededById).toBe(focused.id);
    expect(stored()).toHaveLength(5);
  });

  it('a verdict is stale after a new flow version or a new persona version', () => {
    const p1 = persona('per_1');
    const p2 = persona('per_2');
    const p3 = persona('per_3');
    record(p1, [vin('flw_a', 'flw_b', 'a'), vin('flw_a', 'flw_c', 'a'), vin('flw_b', 'flw_c', 'a')]);
    record(p2, [vin('flw_b', 'flw_c', 'a')]);
    record(p3, [vin('flw_b', 'flw_c', 'a')]);
    expect(liveVerdicts(store, 'R', FTY)).toHaveLength(5);

    // flw_a gets a new version: verdicts naming the old one are stale.
    flowRepos(store).flows.update('flw_a', { lifecycle: 'replaced' });
    flow('flw_a2', { lineageId: 'lin_flw_a', version: 2, replacesId: 'flw_a' });
    // per_2 gets a new version; per_3 no longer exists.
    store.personas.update('per_2', { version: 2 });
    store.db.prepare('DELETE FROM personas WHERE id = ?').run('per_3');

    const live = liveVerdicts(store, 'R', FTY);
    expect(live.map((v) => `${v.personaId}:${v.flowAId}-${v.flowBId}`)).toEqual(['per_1:flw_b-flw_c']);
    expect(liveVerdicts(store, 'Q', FTY)).toEqual([]);
    expect(liveVerdicts(store, 'R', 'fty_other')).toEqual([]);

    // The new persona version may judge the pair again.
    expect(record({ id: 'per_2', version: 2 }, [vin('flw_b', 'flw_c', 'b')])).toEqual({ saved: 1, dropped: 0 });
    expect(liveVerdicts(store, 'R', FTY)).toHaveLength(2);
  });

  it('missingPairs lists exactly the pairs without a live verdict', () => {
    flow('flw_d');
    const p1 = persona('per_1');
    const p2 = persona('per_2');
    const ids = ['flw_d', 'flw_a', 'flw_c', 'flw_b'];
    record(p1, [vin('flw_a', 'flw_b', 'a'), vin('flw_d', 'flw_c', 'tie')], { allowed: ids });
    record(p2, [vin('flw_a', 'flw_c', 'a')], { allowed: ids });
    flowRepos(store).flows.update('flw_b', { lifecycle: 'replaced' });
    flow('flw_b2', { lineageId: 'lin_flw_b', version: 2 });

    const ids2 = ['flw_d', 'flw_a', 'flw_c', 'flw_b2'];
    const missing = missingPairs(store, 'R', FTY, p1, ids2);
    expect(missing.every(([x, y]) => x < y)).toBe(true);
    expect(missing.map(pairKey).sort()).toEqual(
      allPairs(ids2).map(pairKey).filter((k) => k !== 'flw_c|flw_d').sort(),
    );
    expect(missingPairs(store, 'R', FTY, p2, ids2).map(pairKey).sort()).toEqual(allPairs(ids2).map(pairKey).filter((k) => k !== 'flw_a|flw_c').sort());
    expect(missingPairs(store, 'R', FTY, persona('per_3'), ['flw_a'])).toEqual([]);
  });
});

describe('sittings', () => {
  const ids = (n: number) => Array.from({ length: n }, (_, i) => `flw_${String(i).padStart(2, '0')}`);

  it('sittings: 5 flows, max 8 → one sitting with all 10 pairs', () => {
    const flowIds = ids(5);
    const out = sittings(flowIds, allPairs(flowIds), 8);
    expect(out).toHaveLength(1);
    expect(out[0]!.flowIds).toEqual(flowIds);
    expect(out[0]!.pairs.map(pairKey).sort()).toEqual(allPairs(flowIds).map(pairKey).sort());
  });

  it('sittings: 12 flows, max 8 → every one of the 66 pairs is asked exactly once and no sitting has more than 8 flows', () => {
    const flowIds = ids(12);
    // Missing pairs in either order of ids.
    const missing = allPairs(flowIds).map(([x, y], i): [string, string] => (i % 2 ? [y, x] : [x, y]));
    const out = sittings(flowIds, missing, 8);
    const asked = out.flatMap((s) => s.pairs.map(pairKey));
    expect(asked).toHaveLength(66);
    expect(new Set(asked).size).toBe(66);
    for (const s of out) {
      expect(s.flowIds.length).toBeLessThanOrEqual(8);
      expect(s.pairs.length).toBeGreaterThan(0);
      for (const [x, y] of s.pairs) expect(s.flowIds).toEqual(expect.arrayContaining([x, y]));
    }
    expect(sittings(flowIds, missing, 8)).toEqual(out);
  });

  it('sittings ask only missing pairs when most are already judged', () => {
    const flowIds = ids(12);
    const missing: Array<[string, string]> = [['flw_00', 'flw_11'], ['flw_05', 'flw_04'], ['flw_10', 'flw_09']];
    const out = sittings(flowIds, missing, 8);
    expect(out.flatMap((s) => s.pairs.map(pairKey)).sort()).toEqual(missing.map(pairKey).sort());
    expect(out.length).toBeLessThanOrEqual(3);
    for (const s of out) expect(s.flowIds.length).toBeLessThanOrEqual(8);

    const small = ids(4);
    expect(sittings(small, [['flw_02', 'flw_01']], 8)).toEqual([{ flowIds: small, pairs: [['flw_01', 'flw_02']] }]);
    expect(sittings(small, [], 8)).toEqual([]);
  });
});

describe('focusedPairs', () => {
  let n = 0;
  const v = (personaId: string, a: string, b: string, winner: FlowVerdict['winner'], extra: Partial<FlowVerdict> = {}): FlowVerdict => ({
    id: `fvd_${++n}`, workspaceId: 'R', flowTypeId: FTY, flowAId: a, flowBId: b, personaId, personaVersion: 1, stage: 'broad',
    winner, strength: 2, confidence: 0.9, reason: 'r', createdAt: T0, ...extra,
  });
  /** Ranked flows far apart in score, so no close_in_ranking unless asked for. */
  const ranked = (...entries: Array<[string, number | undefined]>): RankedFlow[] =>
    entries.map(([flowId, rankScore], i) => ({ flowId, position: i + 1, rankScore, decidedBy: rankScore === undefined ? 'none' : 'blend' }));
  const select = (input: Partial<Parameters<typeof focusedPairs>[0]>) =>
    focusedPairs({ verdicts: [], ranked: [], checklist: new Map(), disagreed: [], settings: SETTINGS, ...input });
  const items = (out: ReturnType<typeof focusedPairs>) => out.map((o) => `${o.personaId}:${o.a}-${o.b}:${o.reasons.join(',')}`);
  /** f4..f7 sit below the top three and far apart. */
  const LOW = ranked(['f1', 90], ['f2', 80], ['f3', 70], ['f4', 60], ['f5', 50], ['f6', 40], ['f7', 30]);

  it('low_confidence: a broad verdict below lowConfidence', () => {
    const out = select({ ranked: LOW, verdicts: [v('p1', 'f5', 'f7', 'a', { confidence: 0.4 }), v('p1', 'f4', 'f6', 'a', { confidence: 0.5 })] });
    expect(items(out)).toEqual(['p1:f5-f7:low_confidence']);
  });

  it('personas_split: winners differ across personas, ties ignored, every persona on the pair', () => {
    const out = select({
      ranked: LOW,
      verdicts: [v('p1', 'f5', 'f7', 'a'), v('p2', 'f5', 'f7', 'b'), v('p3', 'f5', 'f7', 'tie'), v('p1', 'f4', 'f6', 'a'), v('p2', 'f4', 'f6', 'tie')],
    });
    expect(items(out)).toEqual(['p1:f5-f7:personas_split', 'p2:f5-f7:personas_split', 'p3:f5-f7:personas_split']);
  });

  it("loop: a persona's broad verdicts contain a 3-cycle → the cycle's pairs", () => {
    const out = select({
      ranked: LOW,
      // f4 > f5, f5 > f6, f6 > f4 (p1); p2 agrees on two pairs and has no loop.
      verdicts: [v('p1', 'f4', 'f5', 'a'), v('p1', 'f5', 'f6', 'a'), v('p1', 'f4', 'f6', 'b'), v('p2', 'f4', 'f5', 'a'), v('p2', 'f5', 'f6', 'a'), v('p2', 'f5', 'f7', 'a')],
    });
    expect(items(out).sort()).toEqual(['p1:f4-f5:loop', 'p1:f4-f6:loop', 'p1:f5-f6:loop']);
  });

  it('close_in_ranking: adjacent flows within tieMargin, for the personas with a broad verdict on the pair', () => {
    const out = select({
      ranked: ranked(['f1', 90], ['f2', 80], ['f3', 70], ['f4', 60], ['f5', 56], ['f6', 51], ['f7', undefined]),
      verdicts: [v('p1', 'f4', 'f5', 'a'), v('p1', 'f5', 'f6', 'a'), v('p2', 'f6', 'f7', 'a')],
    });
    // f5–f6 differ by exactly 5 (not within); f7 has no rank score.
    expect(items(out)).toEqual(['p1:f4-f5:close_in_ranking']);
  });

  it('top_three: adjacent pairs with a flow in position ≤ 3', () => {
    const out = select({
      ranked: LOW,
      verdicts: [v('p1', 'f1', 'f2', 'a'), v('p1', 'f3', 'f4', 'a'), v('p2', 'f3', 'f4', 'a'), v('p1', 'f1', 'f3', 'a'), v('p1', 'f4', 'f5', 'a')],
    });
    expect(items(out)).toEqual(['p1:f1-f2:top_three', 'p1:f3-f4:top_three', 'p2:f3-f4:top_three']);
  });

  it('contradicts_checklist: strength 3 for the flow whose checklist score is lower by more than 20', () => {
    const checklist = new Map<string, number | undefined>([['f4', 40], ['f5', 70], ['f6', 50], ['f7', undefined]]);
    const out = select({
      ranked: LOW,
      checklist,
      verdicts: [
        v('p1', 'f4', 'f5', 'a', { strength: 3 }), // f4 lower by 30 → selected
        v('p2', 'f4', 'f5', 'a', { strength: 2 }), // not strong
        v('p1', 'f5', 'f6', 'b', { strength: 3 }), // f6 lower by 20 exactly
        v('p1', 'f6', 'f7', 'a', { strength: 3 }), // f7 has no score
        v('p2', 'f4', 'f6', 'b', { strength: 3 }), // the higher scored flow won
      ],
    });
    expect(items(out)).toEqual(['p1:f4-f5:contradicts_checklist']);
  });

  it('user_disagreed: returned even without a verdict, in either order of ids', () => {
    const out = select({ ranked: LOW, disagreed: [{ personaId: 'p1', a: 'f7', b: 'f5' }, { personaId: 'p2', a: 'f4', b: 'f4' }] });
    expect(out).toEqual([{ personaId: 'p1', a: 'f5', b: 'f7', reasons: ['user_disagreed'] }]);
  });

  it('a pair with a live focused verdict is not selected again', () => {
    const out = select({
      ranked: LOW,
      verdicts: [
        v('p1', 'f1', 'f2', 'a', { stage: 'focused', confidence: 0.2, strength: 3 }),
        v('p2', 'f1', 'f2', 'b', { confidence: 0.2 }),
        // A broad verdict alongside a focused one (not live in practice) does not bring the pair back either.
        v('p1', 'f1', 'f2', 'a', { confidence: 0.1 }),
      ],
      checklist: new Map([['f1', 10], ['f2', 90]]),
    });
    expect(items(out)).toEqual(['p2:f1-f2:top_three,personas_split,low_confidence']);
  });

  it('a user disagreement re-selects a pair that already has a live focused verdict', () => {
    const out = select({
      ranked: LOW,
      verdicts: [
        v('p1', 'f1', 'f2', 'a', { stage: 'focused', confidence: 0.2 }),
        v('p2', 'f1', 'f2', 'b', { confidence: 0.2 }),
        v('p3', 'f5', 'f6', 'a', { stage: 'focused' }),
      ],
      disagreed: [{ personaId: 'p1', a: 'f2', b: 'f1' }, { personaId: 'p3', a: 'f5', b: 'f6' }],
    });
    expect(items(out)).toEqual([
      'p1:f1-f2:user_disagreed',
      'p3:f5-f6:user_disagreed',
      'p2:f1-f2:top_three,personas_split,low_confidence',
    ]);
  });

  it('focusedPairs is capped and ordered', () => {
    const verdicts = [
      v('p1', 'f6', 'f7', 'a', { confidence: 0.1 }), // low_confidence, positions 6/7
      v('p1', 'f4', 'f5', 'a', { confidence: 0.1 }), // low_confidence, positions 4/5
      v('p1', 'f5', 'f6', 'a'), v('p2', 'f5', 'f6', 'b'), // personas_split
      v('p1', 'f2', 'f3', 'a'), // top_three
      v('p1', 'f3', 'f4', 'b', { strength: 3 }), // top_three + contradicts_checklist
    ];
    const checklist = new Map<string, number | undefined>([['f3', 90], ['f4', 10]]);
    const disagreed = [{ personaId: 'p3', a: 'f6', b: 'f7' }];
    const all = select({ ranked: LOW, verdicts, checklist, disagreed });
    expect(items(all)).toEqual([
      'p3:f6-f7:user_disagreed',
      'p1:f2-f3:top_three',
      'p1:f3-f4:top_three,contradicts_checklist',
      'p1:f5-f6:personas_split',
      'p2:f5-f6:personas_split',
      'p1:f4-f5:low_confidence',
      'p1:f6-f7:low_confidence',
    ]);
    const capped = select({ ranked: LOW, verdicts, checklist, disagreed, settings: { ...SETTINGS, maxFocusedComparisons: 3 } });
    expect(capped).toEqual(all.slice(0, 3));
    const reasons: FocusReason[] = all.flatMap((o) => o.reasons);
    expect(new Set(reasons).size).toBe(5);
  });
});
