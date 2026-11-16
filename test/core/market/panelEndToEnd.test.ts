import { afterEach, describe, expect, it } from 'vitest';
import type { BifConfig } from '../../../src/core/config/schema.js';
import { personaPanelRunner, runPersonaPanel } from '../../../src/core/market/panel.js';
import { panelHistory, textHashOf } from '../../../src/core/market/panelRounds.js';
import { panelViews } from '../../../src/core/market/panelView.js';
import { startPhase } from '../../../src/core/research/orchestrator.js';
import type { Store } from '../../../src/core/store/db.js';
import { BASELINE, CODEX, FIELD, OPS, SMB, SONNET, modelOf, panelFixture, recIdOf, silent, whoOf } from './panelFixture.js';

/**
 * The persona panel from end to end with fake agents (persona panel design §10): two seats, three
 * personas, the baseline, a recommendation that changes, round 2, a persona that is unavailable, and
 * the round limit. Judged from the runs, the store and what the Strategy page is served (`panelViews`).
 */

const opened: Store[] = [];
afterEach(() => {
  for (const s of opened.splice(0)) s.close();
});

/** Seats in turn by slug: FIELD on seat 0, OPS on seat 1, SMB on seat 0. The baseline is on seat 0. Two rounds. */
const panel = (c: BifConfig) => {
  c.personaPanel = { rounds: 2, seats: [SONNET, CODEX] };
};
const SEAT_OF: Record<string, { provider: string; model: string }> = { [FIELD]: SONNET, [OPS]: CODEX, [SMB]: SONNET, [BASELINE]: SONNET };

// Round 1. The baseline, a persona that says the same in other words (SMB), and two that say something of their own.
const GENERAL = { concerns: ['The price is not stated', 'There is no pilot before the contract'], reasoning: 'It reads well but the price and the pilot are missing' };
const ROUND_1: Record<string, Record<string, unknown>> = {
  [BASELINE]: GENERAL,
  [SMB]: {
    concerns: ['The price is not stated', 'There is no pilot before a contract'], reasoning: 'It reads well, but the pilot and the price are missing',
    scores: { appeal: 4, adoption: 5, willingness_to_pay: 2, friction: 4 },
  },
  [FIELD]: {
    scores: { appeal: 4, adoption: 1, willingness_to_pay: 2, friction: 4 },
    concerns: ['I work offline in the field', 'Most customers will refuse a new login'], concern_basis: ['constraints'],
    reasoning: 'My day is spent away from a desk', other_side: 'An offline mode would bring me back',
    instead: 'Send the report by text message', unsure: ['whether my employer pays for it'],
  },
  [OPS]: {
    scores: { appeal: 4, adoption: 4, willingness_to_pay: 2, friction: 4 },
    concerns: ['Reconciliation breaks at month end'], concern_basis: ['pain_points'], reasoning: 'I close the books every month',
  },
};
// Round 2: each rules on its own earlier concerns.
const ROUND_2: Record<string, Record<string, unknown>> = {
  [BASELINE]: { concerns: ['The length of the pilot is not given'], reasoning: 'A reader cannot tell how long the trial runs', rulings: [{ concern: 1, ruling: 'stands', reason: 'Still no price' }, { concern: 2, ruling: 'resolved', reason: 'A pilot is offered now' }] },
  [SMB]: {
    scores: { appeal: 4, adoption: 5, willingness_to_pay: 2, friction: 4 },
    concerns: ['My approval limit is below the yearly fee'], concern_basis: ['buying_behavior'], reasoning: 'I sign small contracts alone and large ones never',
    rulings: [{ concern: 1, ruling: 'stands', reason: 'Still no price' }, { concern: 2, ruling: 'resolved', reason: 'A pilot is offered now' }],
  },
  [FIELD]: {
    scores: { appeal: 4, adoption: 3, willingness_to_pay: 2, friction: 4 },
    concerns: ['Two weeks of pilot do not cover my route'], concern_basis: ['goals'], reasoning: 'A pilot helps me if it lasts a full route',
    rulings: [{ concern: 1, ruling: 'resolved', reason: 'The pilot runs offline' }],
  },
  [OPS]: {
    scores: { appeal: 4, adoption: 4, willingness_to_pay: 2, friction: 4 },
    concerns: ['The pilot ends before month end'], concern_basis: ['pain_points'], reasoning: 'I cannot judge it before a close',
    rulings: [{ concern: 1, ruling: 'stands', reason: 'Month end is still manual' }],
  },
};

describe('the persona panel from end to end', () => {
  it('two seats, three personas, the baseline, a changed recommendation, round 2 and the limit', async () => {
    const t = await panelFixture(opened, panel);
    const view = (recId: string) => panelViews(t.store, t.config, 'ws_a', t.store.recommendations.list({ workspaceId: 'ws_a' })).get(recId)!;
    const id = (slug: string) => t.persona(slug).id;
    const read = () => runPersonaPanel('ws_a', t.deps);

    // --- round 1: every persona reads every recommendation once, on its own seat; one baseline each ---
    t.replies((who) => ROUND_1[who]);
    const first = await read();
    expect(first).toMatchObject({ feedback: 6, missing: [], unavailable: [], rounds: { unchanged: 0, limitReached: [] }, baseline: { stored: 2, unavailable: [] } });
    expect(first.failed).toBeUndefined();
    for (const who of [FIELD, OPS, SMB, BASELINE]) {
      const runs = t.runs(who);
      expect(runs.map(recIdOf).sort(), who).toEqual(['rec_1', 'rec_2']);
      for (const req of runs) {
        expect(modelOf(req), who).toEqual({ provider: SEAT_OF[who]!.provider, model: SEAT_OF[who]!.model });
        expect(req.effort, who).toBe(who === OPS ? 'medium' : undefined);
        expect(req.round).toBe(1);
      }
    }
    for (const recId of ['rec_1', 'rec_2']) {
      const stored = t.store.recommendations.get(recId)!;
      // The baseline is stored apart: three reactions, each of a persona.
      expect(stored.personaFeedback.map((f) => f.personaId).sort()).toEqual([id(FIELD), id(OPS), id(SMB)].sort());
      expect(panelHistory(t.store, recId).baselines).toHaveLength(1);
      expect(t.feedback(recId, FIELD)).toMatchObject({
        round: 1, seat: SONNET, textHash: textHashOf(stored), sameAsBaseline: false, otherSide: 'An offline mode would bring me back',
        instead: 'Send the report by text message', unsure: ['whether my employer pays for it'], concernBasis: ['constraints', ''], ungrounded: [1],
        aboutOthers: [{ field: 'concerns', index: 1, text: 'Most customers will refuse a new login', reason: 'a claim about most, many or all of a group' }],
      });
      expect(t.feedback(recId, OPS)).toMatchObject({ round: 1, seat: CODEX, sameAsBaseline: false, ungrounded: [] });
      expect(t.feedback(recId, SMB)).toMatchObject({ round: 1, seat: SONNET, sameAsBaseline: true });
      // What the page is served: the range where the counted personas disagree (SMB adds nothing beyond a
      // general reader, so its adoption of 5 is not in it), the baseline, and nothing else to report.
      expect(view(recId)).toEqual({
        simulated: true,
        disagreement: [{ scale: 'adoption', min: 1, max: 4 }],
        leftOut: 1,
        earlierRounds: [],
        baseline: { current: true, reaction: expect.objectContaining({ ...GENERAL, round: 1, seat: SONNET }), earlier: [] },
        unavailable: [],
        limitReached: [],
      });
    }

    // --- the same texts: nothing runs ---
    t.forgetRuns();
    expect(await read()).toMatchObject({ feedback: 0, rounds: { unchanged: 6, limitReached: [] }, baseline: { stored: 0, unchanged: 2 } });
    expect(t.runs()).toEqual([]);

    // --- rec_1 changes: round 2 for rec_1 only. OPS gives no answer. ---
    t.edit('rec_1', 'Do rec_1, with a pilot of two weeks first');
    t.replies((who) => (who === OPS ? silent : ROUND_2[who]));
    const second = await read();
    expect(second).toMatchObject({ feedback: 2, rounds: { unchanged: 3, limitReached: [] }, baseline: { stored: 1, unchanged: 1 } });
    expect(second.unavailable).toEqual([
      { recommendationId: 'rec_1', personaId: id(OPS), slug: OPS, seat: { index: 1, ...CODEX }, reason: 'no submit_persona_feedback call' },
    ]);
    expect(t.runs().map(recIdOf)).toEqual(Array.from({ length: t.runs().length }, () => 'rec_1'));
    // One run per reader (OPS: its run and the retry, on its own seat), each as round 2 on the seat of round 1.
    expect(t.runs().map(whoOf).sort()).toEqual([BASELINE, FIELD, OPS, OPS, SMB].sort());
    for (const req of t.runs()) {
      const who = whoOf(req);
      expect(req.round, who).toBe(2);
      expect(modelOf(req), who).toEqual({ provider: SEAT_OF[who]!.provider, model: SEAT_OF[who]!.model });
      // The prompt lists the reader's own earlier concerns, and nothing any other reader said.
      const own = ROUND_1[who]!;
      const text = `${req.systemPrompt}\n${req.prompt}`;
      for (const c of own.concerns as string[]) expect(text, who).toContain(c);
      for (const other of [FIELD, OPS, SMB, BASELINE].filter((o) => o !== who)) {
        const theirs = ROUND_1[other]!;
        for (const said of [...(theirs.concerns as string[]), theirs.reasoning as string]) {
          if (!(own.concerns as string[]).includes(said)) expect(text, `${who} must not read ${other}`).not.toContain(said);
        }
      }
    }
    // FIELD's concerns were listed as 1 and 2; it ruled on the first only.
    expect(t.feedback('rec_1', FIELD)).toMatchObject({
      round: 2, seat: SONNET, earlierConcerns: ROUND_1[FIELD]!.concerns, notRuled: [2], sameAsBaseline: false,
      rulings: [{ concern: 1, ruling: 'resolved', reason: 'The pilot runs offline' }],
    });
    expect(t.feedback('rec_1', SMB)).toMatchObject({ round: 2, earlierConcerns: ROUND_1[SMB]!.concerns, notRuled: [], rulings: ROUND_2[SMB]!.rulings });
    // OPS is unavailable for the new text: its reaction to the earlier text stays its current one.
    expect(t.feedback('rec_1', OPS)).toMatchObject({ round: 1, concerns: ROUND_1[OPS]!.concerns });
    expect(t.feedback('rec_2', FIELD)).toMatchObject({ round: 1 });
    const afterSecond = view('rec_1');
    expect(afterSecond.disagreement).toEqual([{ scale: 'adoption', min: 3, max: 5 }]);
    expect(afterSecond.leftOut).toBe(0);
    expect(afterSecond.earlierRounds.map((e) => [e.personaId, e.round, e.reaction.concerns]).sort()).toEqual(
      [[id(FIELD), 1, ROUND_1[FIELD]!.concerns], [id(SMB), 1, ROUND_1[SMB]!.concerns]].sort(),
    );
    expect(afterSecond.baseline).toEqual({
      current: true,
      reaction: expect.objectContaining({ round: 2, concerns: ROUND_2[BASELINE]!.concerns, earlierConcerns: GENERAL.concerns, rulings: ROUND_2[BASELINE]!.rulings }),
      earlier: [expect.objectContaining({ round: 1, ...GENERAL })],
    });
    expect(afterSecond.unavailable).toEqual([{ personaId: id(OPS), round: 2, seat: { index: 1, ...CODEX }, reason: 'no submit_persona_feedback call' }]);
    expect(afterSecond.limitReached).toEqual([]);
    expect(view('rec_2')).toMatchObject({ earlierRounds: [], unavailable: [], limitReached: [], baseline: { current: true, earlier: [] } });

    // --- the same text again: only OPS reads (a read without an answer was not a round), as a phase ---
    t.forgetRuns();
    t.replies((who) => ROUND_2[who]);
    const phase = await startPhase('ws_a', 'persona_panel', { ...t.deps, phaseRunners: { persona_panel: personaPanelRunner } });
    expect(phase.status).toBe('done');
    expect(t.runs().map((r) => [whoOf(r), recIdOf(r), r.round, modelOf(r).model])).toEqual([[OPS, 'rec_1', 2, CODEX.model]]);
    expect(t.feedback('rec_1', OPS)).toMatchObject({ round: 2, seat: CODEX, earlierConcerns: ROUND_1[OPS]!.concerns, rulings: ROUND_2[OPS]!.rulings });
    expect(view('rec_1').unavailable).toEqual([]);
    expect(view('rec_1').earlierRounds.map((e) => e.personaId).sort()).toEqual([id(FIELD), id(OPS), id(SMB)].sort());

    // --- rec_1 changes again: the two rounds are used up, so nothing runs and the limit is reported ---
    t.forgetRuns();
    t.edit('rec_1', 'Do rec_1, with a pilot of a month first');
    const third = await read();
    expect(t.runs()).toEqual([]);
    expect(third).toMatchObject({ feedback: 0, missing: [], unavailable: [], baseline: { stored: 0, unchanged: 1, limitReached: ['rec_1'] } });
    expect(third.rounds!.unchanged).toBe(3);
    expect(third.rounds!.limitReached.map((l) => [l.recommendationId, l.slug, l.round]).sort()).toEqual([FIELD, OPS, SMB].map((slug) => ['rec_1', slug, 2]).sort());
    const afterThird = view('rec_1');
    expect([...afterThird.limitReached].sort((a, b) => a.personaId.localeCompare(b.personaId))).toEqual(
      [FIELD, OPS, SMB].map((slug) => ({ personaId: id(slug), round: 2 })).sort((a, b) => a.personaId.localeCompare(b.personaId)),
    );
    expect(afterThird).toMatchObject({ baselineLimitReached: true, baseline: { current: false, reaction: { round: 2 } }, unavailable: [] });
    expect(view('rec_2')).toMatchObject({ limitReached: [], baseline: { current: true } });
    expect('baselineLimitReached' in view('rec_2')).toBe(false);
  });

  it('without a personaPanel block the page is served no panel', async () => {
    const t = await panelFixture(opened);
    await runPersonaPanel('ws_a', t.deps);
    const recs = t.store.recommendations.list({ workspaceId: 'ws_a' });
    expect(recs.every((r) => r.personaFeedback.length === 3)).toBe(true);
    expect(panelViews(t.store, t.config, 'ws_a', recs).size).toBe(0);
  });

  it('a baseline that cannot be had is served as unavailable, with the seat and the reason', async () => {
    const t = await panelFixture(opened, panel);
    t.replies((who, recId) => (who === BASELINE && recId === 'rec_1' ? silent : ROUND_1[who]));
    await runPersonaPanel('ws_a', t.deps);
    const views = panelViews(t.store, t.config, 'ws_a', t.store.recommendations.list({ workspaceId: 'ws_a' }));
    expect(views.get('rec_1')).toMatchObject({ baselineUnavailable: { round: 1, seat: { index: 0, ...SONNET }, reason: 'no submit_persona_feedback call' }, leftOut: 0 });
    expect('baseline' in views.get('rec_1')!).toBe(false);
    expect('baselineUnavailable' in views.get('rec_2')!).toBe(false);
    // The next run has it: the record of the earlier run is no longer what the page says.
    t.replies((who) => ROUND_1[who]);
    await runPersonaPanel('ws_a', t.deps);
    const again = panelViews(t.store, t.config, 'ws_a', t.store.recommendations.list({ workspaceId: 'ws_a' })).get('rec_1')!;
    expect('baselineUnavailable' in again).toBe(false);
    expect(again).toMatchObject({ baseline: { current: true }, leftOut: 1 });
  });
});
