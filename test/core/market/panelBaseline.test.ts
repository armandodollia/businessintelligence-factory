import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BifConfig } from '../../../src/core/config/schema.js';
import { REPEAT_SIMILARITY, issueSimilarity } from '../../../src/core/learning/reviewIssues.js';
import { PANEL_ACTOR, panelSummary, personaPanelRunner, runPersonaPanel } from '../../../src/core/market/panel.js';
import { BASELINE_SYSTEM_PROMPT, panelHistory, sameAsBaseline, textHashOf } from '../../../src/core/market/panelRounds.js';
import { promptTemplate, promptVersion } from '../../../src/core/prompts/index.js';
import { getPromptText } from '../../../src/core/prompts/store.js';
import type { AgentRequest } from '../../../src/core/research/deps.js';
import { startPhase } from '../../../src/core/research/orchestrator.js';
import { exportTrainingData } from '../../../src/core/scoring/export.js';
import { computePriority, personaScore } from '../../../src/core/scoring/priority.js';
import { rateCriterion } from '../../../src/core/scoring/ratings.js';
import { reviewQueue } from '../../../src/core/scoring/reviewQueue.js';
import type { Store } from '../../../src/core/store/db.js';
import type { Decision, PanelBaseline, Persona, PersonaFeedback } from '../../../src/core/types.js';
import { BASELINE, CODEX, FIELD, OPENCODE, OPS, SMB, SONNET, ctx, modelOf, panelFixture, recIdOf, silent, whoOf } from './panelFixture.js';

const opened: Store[] = [];
afterEach(() => {
  for (const s of opened.splice(0)) s.close();
  vi.restoreAllMocks();
});

/** Seat 0 is the seat with an effort, so a run on it is told apart; the baseline is on by default. */
const panel = (extra: Partial<NonNullable<BifConfig['personaPanel']>> = {}) => (c: BifConfig) => {
  c.personaPanel = { seats: [CODEX, SONNET], ...extra };
};

const PAIRS = 6;
const rulesPrompt = () => `${promptTemplate('persona_panel').trimEnd()}\n\n${promptTemplate('persona_panel_rules')}`;
const baselineOf = (t: { store: Store }, recId: string) => panelHistory(t.store, recId).baselines.at(-1);

/** What a general reader says, and a persona that says the same in other words, and one that says something of its own. */
const GENERAL = { concerns: ['The price is not stated', 'There is no pilot before the contract'], reasoning: 'It reads well but the price and the pilot are missing' };
const ECHO = { concerns: ['The price is not stated', 'There is no pilot before a contract'], reasoning: 'It reads well, but the pilot and the price are missing' };
const OWN = { concerns: ['My auditors need an export to our ledger every month'], reasoning: 'Month-end close is my job and this adds a manual step to it' };
const generalReader = (who: string) => (who === BASELINE ? GENERAL : who === SMB ? ECHO : OWN);

describe('the baseline run', () => {
  it('one run with no persona per recommendation: seat 0, a neutral system prompt, the same prompt and tool', async () => {
    const t = await panelFixture(opened, panel());
    const report = await runPersonaPanel('ws_a', t.deps);

    const runs = t.runs(BASELINE);
    expect(runs.map(recIdOf).sort()).toEqual(['rec_1', 'rec_2']);
    expect(t.runs()).toHaveLength(PAIRS + 2);
    for (const req of runs) {
      // Seat 0: its model and its effort.
      expect(modelOf(req)).toEqual({ provider: 'codex', model: 'gpt-6.1-sol' });
      expect(req.effort).toBe('medium');
      expect(req).toMatchObject({ role: 'persona', kind: 'work', round: 1, attempt: 1, needsBrowser: false });
      // No persona: a neutral system prompt, with nothing of any persona's profile in it.
      expect(req.systemPrompt).toBe(BASELINE_SYSTEM_PROMPT);
      expect(req.systemPrompt).toContain('a general reader with no particular stake');
      for (const slug of [FIELD, OPS, SMB]) expect(`${req.systemPrompt}\n${req.prompt}`).not.toContain(slug);
      // The same panel prompt a persona gets for that recommendation.
      const personaRun = t.runs(FIELD).find((r) => recIdOf(r) === recIdOf(req))!;
      expect(req.prompt).toBe(personaRun.prompt);
      const version = (req as AgentRequest & { promptVersion: string }).promptVersion;
      expect(version).toBe(promptVersion(`${BASELINE_SYSTEM_PROMPT}\n${rulesPrompt()}`));
      expect(getPromptText(t.store, version)!.text).toBe(`${BASELINE_SYSTEM_PROMPT}\n${rulesPrompt()}`);
    }
    expect(report.baseline).toEqual({ stored: 2, unchanged: 0, limitReached: [], unavailable: [] });
    // The same tool: its answer is a `submit_persona_feedback` call of a persona-role run.
    for (const run of t.store.agentRuns.list({ role: 'persona' }).filter((r) => r.promptVersion === promptVersion(`${BASELINE_SYSTEM_PROMPT}\n${rulesPrompt()}`))) {
      const [d, ...more] = t.store.decisions.list({ agentRunId: run.id, kind: 'persona_feedback' });
      expect(more).toEqual([]);
      expect(d!.payload).toMatchObject({ tool: 'submit_persona_feedback', baseline: true });
    }
  });

  it('its answer is stored apart: never a persona\'s feedback, never in a summary or a count of reactions', async () => {
    const t = await panelFixture(opened, panel());
    // The personas say something of their own, so each of them is counted (a reaction that says what the baseline says is not).
    t.replies((who) => (who === BASELINE ? { scores: { appeal: 1, adoption: 1, willingness_to_pay: 1, friction: 5 }, other_side: 'a lower price' } : OWN));
    const report = await runPersonaPanel('ws_a', t.deps);

    // Six reactions were stored; the two baselines are not among them.
    expect(report.feedback).toBe(PAIRS);
    const personaIds = [FIELD, OPS, SMB].map((s) => t.persona(s).id).sort();
    for (const id of ['rec_1', 'rec_2']) {
      const recommendation = t.store.recommendations.get(id)!;
      expect(recommendation.personaFeedback.map((f) => f.personaId).sort()).toEqual(personaIds);
      // The baseline's scores (1, 1, 1, 5) are in no summary and no score of the panel.
      const summary = panelSummary(recommendation, t.store.personas.list({ workspaceId: 'ws_a' }));
      expect(summary).toMatchObject({ n: 3, leftOut: 0 });
      expect(summary.scores.appeal).toMatchObject({ min: 4, max: 4, mean: 4, spread: 0 });
      expect(summary.disagreement).toEqual([]);
      expect(personaScore(recommendation)).toBe((4 + 3 + 2 + 2) / 4);

      const { baselines, earlierRounds } = panelHistory(t.store, id);
      expect(earlierRounds).toEqual([]);
      expect(baselines).toHaveLength(1);
      expect(baselines[0]).toMatchObject({ kind: 'baseline', workspaceId: 'ws_a', recommendationId: id, round: 1, textHash: textHashOf(recommendation) });
      expect('personaId' in baselines[0]!).toBe(false);
      expect(t.store.agentRuns.get(baselines[0]!.agentRunId!)).toMatchObject({ role: 'persona', model: { provider: 'codex', model: 'gpt-6.1-sol' } });
      const reaction = baselines[0]!.reaction as PanelBaseline;
      expect(reaction).toEqual({
        scores: { appeal: 1, adoption: 1, willingnessToPay: 1, friction: 5 },
        concerns: [`concern of ${BASELINE} about ${id}`], reasoning: `reasoning of ${BASELINE} about ${id}`, wouldChangeMind: 'a free tier', simulated: true,
        seat: CODEX, concernBasis: [''], ungrounded: [0], aboutOthers: [], otherSide: 'a lower price', round: 1, textHash: textHashOf(recommendation),
        textRead: { title: `Rec ${id}`, summary: `Do ${id}` },
      });
    }
    // Nothing to rate, and no rating can name it: the review queue holds the six reactions only.
    const queued = reviewQueue('ws_a', t).filter((i) => i.targetType === 'persona_feedback');
    expect(queued.map((i) => i.targetId).sort()).toEqual(['rec_1', 'rec_2'].flatMap((id) => personaIds.map((p) => `${id}:${p}`)).sort());
    // Its decision names no persona and no rating target; a persona's does.
    const decisions = t.store.decisions.list({ workspaceId: 'ws_a', kind: 'persona_feedback' });
    expect(decisions).toHaveLength(PAIRS + 2);
    const ofBaseline = decisions.filter((d) => (d.payload as { baseline?: boolean }).baseline === true);
    expect(ofBaseline).toHaveLength(2);
    for (const d of ofBaseline) {
      expect('personaId' in (d.payload as object)).toBe(false);
      expect('targetId' in (d.payload as object)).toBe(false);
    }
    for (const d of decisions.filter((x) => !ofBaseline.includes(x))) expect(personaIds).toContain((d.payload as { personaId: string }).personaId);
    expect(t.recorded('persona_unavailable')).toEqual([]);
  });

  it('baseline: false: no run with no persona, nothing stored, nothing marked', async () => {
    const t = await panelFixture(opened, panel({ baseline: false }));
    t.replies(generalReader);
    const report = await runPersonaPanel('ws_a', t.deps);
    expect(t.runs(BASELINE)).toEqual([]);
    expect(t.runs()).toHaveLength(PAIRS);
    expect('baseline' in report).toBe(false);
    expect(t.store.personaPanelReads.list()).toEqual([]);
    for (const slug of [FIELD, OPS, SMB]) expect('sameAsBaseline' in t.feedback('rec_1', slug)!).toBe(false);
  });
});

describe('sameAsBaseline', () => {
  it('is the word similarity of concerns plus reasoning, at the threshold at which a review issue repeats', () => {
    const text = (r: { concerns: string[]; reasoning: string }) => [...r.concerns, r.reasoning].join('\n');
    expect(issueSimilarity(text(ECHO), text(GENERAL))).toBeGreaterThanOrEqual(REPEAT_SIMILARITY);
    expect(sameAsBaseline(ECHO, GENERAL)).toBe(true);
    expect(issueSimilarity(text(OWN), text(GENERAL))).toBeLessThan(REPEAT_SIMILARITY);
    expect(sameAsBaseline(OWN, GENERAL)).toBe(false);
    // Exactly at the threshold: 6 of 10 words shared.
    const base = { concerns: ['one two three four five six'], reasoning: 'seven eight' };
    const at = { concerns: ['one two three four five six'], reasoning: 'nine ten' };
    expect(issueSimilarity(text(at), text(base))).toBe(REPEAT_SIMILARITY);
    expect(sameAsBaseline(at, base)).toBe(true);
    expect(sameAsBaseline({ concerns: ['one two three four five'], reasoning: 'nine ten eleven' }, base)).toBe(false);
    // Scores, and what would change its mind, are not part of it.
    expect(sameAsBaseline({ ...ECHO, scores: { appeal: 1 }, wouldChangeMind: 'x' } as never, { ...GENERAL, scores: { appeal: 5 }, wouldChangeMind: 'y' } as never)).toBe(true);
  });

  it('a reaction that says what the baseline says is marked; one that says something of its own is not', async () => {
    const t = await panelFixture(opened, panel());
    t.replies(generalReader);
    await runPersonaPanel('ws_a', t.deps);
    for (const id of ['rec_1', 'rec_2']) {
      expect(t.feedback(id, SMB)!.sameAsBaseline).toBe(true);
      expect(t.feedback(id, FIELD)!.sameAsBaseline).toBe(false);
      expect(t.feedback(id, OPS)!.sameAsBaseline).toBe(false);
      // A mark, nothing else: the reaction is whole and still one of three.
      expect(t.feedback(id, SMB)).toMatchObject({ ...ECHO, scores: { appeal: 4 } });
      expect(t.store.recommendations.get(id)!.personaFeedback).toHaveLength(3);
    }
  });

  it('a baseline without an answer is reported; reactions are stored unmarked and the panel does not fail for it', async () => {
    const t = await panelFixture(opened, panel({ onUnavailable: 'fail' }));
    t.replies((who, recId) => (who === BASELINE && recId === 'rec_1' ? silent : generalReader(who)));
    const report = await runPersonaPanel('ws_a', t.deps);

    // Retried once, on seat 0.
    const tries = t.runs(BASELINE).filter((r) => recIdOf(r) === 'rec_1');
    expect(tries.map((r) => r.attempt)).toEqual([1, 2]);
    for (const req of tries) expect(modelOf(req)).toEqual({ provider: 'codex', model: 'gpt-6.1-sol' });
    expect(report.baseline).toEqual({
      stored: 1, unchanged: 0, limitReached: [],
      unavailable: [{ recommendationId: 'rec_1', round: 1, seat: { index: 0, ...CODEX }, reason: 'no submit_persona_feedback call' }],
    });
    // Not a persona that is unavailable: the panel goes on, also under `fail`.
    expect(report).toMatchObject({ feedback: PAIRS, missing: [], unavailable: [] });
    expect(report.failed).toBeUndefined();
    expect(t.recorded('persona_unavailable')).toEqual([]);
    expect(t.recorded('persona_feedback_missing')).toEqual([]);

    expect(panelHistory(t.store, 'rec_1').baselines).toEqual([]);
    for (const slug of [FIELD, OPS, SMB]) {
      expect('sameAsBaseline' in t.feedback('rec_1', slug)!, slug).toBe(false);
      expect(typeof t.feedback('rec_2', slug)!.sameAsBaseline, slug).toBe('boolean');
    }
    // Recorded once, on the last run that gave no answer.
    const [recorded, ...more] = t.recorded('baseline_unavailable');
    expect(more).toEqual([]);
    expect(recorded!.payload).toMatchObject({ tool: 'harness', baseline: true, recommendation: 'rec_1', round: 1, seat: { index: 0, ...CODEX }, reason: 'no submit_persona_feedback call' });
    expect(t.store.agentRuns.get(recorded!.agentRunId)).toMatchObject({ role: 'persona', model: { provider: 'codex', model: 'gpt-6.1-sol' } });

    const rr = await startPhase('ws_a', 'persona_panel', { ...t.deps, phaseRunners: { persona_panel: personaPanelRunner } });
    expect(rr.status).toBe('done');
  });

  it('seat 0 cannot be started: the baseline is reported unavailable, nothing is marked, and no other seat runs it', async () => {
    const t = await panelFixture(opened, (c) => {
      c.personaPanel = { seats: [OPENCODE, SONNET] };
    });
    t.replies(generalReader);
    const report = await runPersonaPanel('ws_a', t.deps);

    expect(t.runs(BASELINE)).toEqual([]);
    // The persona on seat 1 runs; the two on seat 0 are unavailable, as before.
    expect(t.runs().map(whoOf).sort()).toEqual([OPS, OPS]);
    expect(report.feedback).toBe(2);
    expect(report.baseline).toEqual({
      stored: 0, unchanged: 0, limitReached: [],
      unavailable: ['rec_1', 'rec_2'].map((recommendationId) => ({ recommendationId, round: 1, seat: { index: 0, ...OPENCODE }, reason: "provider 'opencode' is not enabled" })),
    });
    expect(t.store.personaPanelReads.list()).toEqual([]);
    for (const id of ['rec_1', 'rec_2']) expect('sameAsBaseline' in t.feedback(id, OPS)!).toBe(false);
    const recorded = t.recorded('baseline_unavailable');
    expect(recorded).toHaveLength(2);
    for (const d of recorded) expect(d).toMatchObject({ agentRunId: PANEL_ACTOR, role: 'persona', model: OPENCODE, promptVersion: 'n/a' });
  });

  it('a baseline that arrives later marks the reactions to the same text that are already stored', async () => {
    const t = await panelFixture(opened, panel());
    t.replies((who) => (who === BASELINE ? silent : generalReader(who)));
    await runPersonaPanel('ws_a', t.deps);
    expect('sameAsBaseline' in t.feedback('rec_1', SMB)!).toBe(false);
    t.forgetRuns();
    t.replies(generalReader);

    const report = await runPersonaPanel('ws_a', t.deps);
    // Only the baseline had something to read.
    expect(t.runs().map((r) => `${whoOf(r)} ${recIdOf(r)}`).sort()).toEqual([`${BASELINE} rec_1`, `${BASELINE} rec_2`]);
    expect(report).toMatchObject({ feedback: 0, rounds: { unchanged: PAIRS }, baseline: { stored: 2, unavailable: [] } });
    expect(t.feedback('rec_1', SMB)!.sameAsBaseline).toBe(true);
    expect(t.feedback('rec_1', FIELD)!.sameAsBaseline).toBe(false);
  });
});

describe('the baseline follows the rounds', () => {
  it('the same text: no run. A changed text: its next round, with its own earlier concerns. Rounds used up: no run, reported', async () => {
    const t = await panelFixture(opened, panel({ rounds: 2 }));
    await runPersonaPanel('ws_a', t.deps);
    t.forgetRuns();

    const same = await runPersonaPanel('ws_a', t.deps);
    expect(t.runs()).toEqual([]);
    expect(same.baseline).toEqual({ stored: 0, unchanged: 2, limitReached: [], unavailable: [] });

    t.edit('rec_1', 'Do rec_1, with a pilot first');
    t.replies((who, recId) => ({ concerns: [], rulings: [{ concern: 1, ruling: 'resolved', reason: `ruling of ${who} about ${recId}` }] }));
    const changed = await runPersonaPanel('ws_a', t.deps);
    expect(changed.baseline).toEqual({ stored: 1, unchanged: 1, limitReached: [], unavailable: [] });
    const [run, ...more] = t.runs(BASELINE);
    expect(more).toEqual([]);
    expect(run).toMatchObject({ round: 2, systemPrompt: BASELINE_SYSTEM_PROMPT });
    expect(run!.prompt).toContain('Do rec_1, with a pilot first');
    expect(run!.prompt).toContain('## Round 2: you read this recommendation before');
    expect(run!.prompt).toContain(`1. concern of ${BASELINE} about rec_1`);
    for (const slug of [FIELD, OPS, SMB]) expect(run!.prompt).not.toContain(slug);
    // The same prompt as a persona's but for the earlier concerns, which are each reader's own.
    const personaRun = t.runs(FIELD)[0]!;
    expect(run!.prompt.replaceAll(BASELINE, FIELD)).toBe(personaRun.prompt);
    // Both baselines are kept; the later one is the baseline of the text as it is now.
    const { baselines } = panelHistory(t.store, 'rec_1');
    expect(baselines.map((b) => b.round)).toEqual([1, 2]);
    expect(baselines[1]).toMatchObject({ textHash: textHashOf(t.store.recommendations.get('rec_1')!) });
    expect(baselines[1]!.reaction).toMatchObject({
      round: 2, earlierConcerns: [`concern of ${BASELINE} about rec_1`], notRuled: [],
      rulings: [{ concern: 1, ruling: 'resolved', reason: `ruling of ${BASELINE} about rec_1` }],
    });
    expect(panelHistory(t.store, 'rec_2').baselines.map((b) => b.round)).toEqual([1]);
    expect(t.store.recommendations.get('rec_1')!.personaFeedback).toHaveLength(3);

    t.forgetRuns();
    t.edit('rec_1', 'Do rec_1, with a pilot and a price cap');
    const used = await runPersonaPanel('ws_a', t.deps);
    expect(t.runs()).toEqual([]);
    expect(used.baseline).toEqual({ stored: 0, unchanged: 1, limitReached: ['rec_1'], unavailable: [] });
    expect(used.rounds!.limitReached).toHaveLength(3);
    expect(panelHistory(t.store, 'rec_1').baselines).toHaveLength(2);
  });

  it('a reaction is compared with the baseline of the text it read, never with one of another text', async () => {
    const t = await panelFixture(opened, panel({ rounds: 2 }));
    t.replies(generalReader);
    await runPersonaPanel('ws_a', t.deps);
    expect(t.feedback('rec_1', SMB)!.sameAsBaseline).toBe(true);
    // The text changes; the baseline reads it and now says what FIELD said before. FIELD gives no answer this time.
    t.edit('rec_1', 'Do rec_1, with a pilot first');
    t.replies((who) => (who === BASELINE ? OWN : who === FIELD ? silent : { concerns: ['The pilot is too short for me'], reasoning: 'Two weeks do not cover a month-end' }));
    await runPersonaPanel('ws_a', t.deps);
    // FIELD's reaction is still the one to the earlier text: its mark is the one it got then.
    expect(t.feedback('rec_1', FIELD)).toMatchObject({ round: 1, sameAsBaseline: false, ...OWN });
    expect(t.feedback('rec_1', SMB)).toMatchObject({ round: 2, sameAsBaseline: false });
  });
});

describe('a marked reaction is not counted as agreement', () => {
  const reaction = (personaId: string, scores: [number, number, number, number], sameAsBaseline?: boolean): PersonaFeedback => ({
    personaId, scores: { appeal: scores[0], adoption: scores[1], willingnessToPay: scores[2], friction: scores[3] },
    concerns: [], reasoning: '', wouldChangeMind: '', simulated: true, ...(sameAsBaseline !== undefined ? { sameAsBaseline } : {}),
  });
  /** The score of one reaction as `personaScore` counts it. */
  const scoreOf = (appeal: number, adoption: number, pay: number, friction: number) => (appeal + adoption + pay + (6 - friction)) / 4;
  const criteria = { upside: 2 };

  it('personaScore leaves a marked reaction out; with every reaction marked there is no persona score', () => {
    const own = reaction('per_a', [5, 5, 5, 1], false);
    const unmarked = reaction('per_b', [3, 3, 3, 3]);
    const echo = reaction('per_c', [1, 1, 1, 5], true);
    expect(personaScore({ personaFeedback: [own, unmarked, echo] })).toBe((scoreOf(5, 5, 5, 1) + scoreOf(3, 3, 3, 3)) / 2);
    expect(personaScore({ personaFeedback: [echo, reaction('per_d', [5, 5, 5, 1], true)] })).toBeUndefined();
    expect(personaScore({ personaFeedback: [] })).toBeUndefined();
    // So in a priority that counts persona feedback (personaWeight above 0, never the default):
    const weighted = { personaWeight: 1 };
    expect(computePriority({ criteria, personaFeedback: [own, echo] }, weighted)).toBe(computePriority({ criteria, personaFeedback: [own] }, weighted));
    expect(computePriority({ criteria, personaFeedback: [echo] }, weighted)).toBe(computePriority({ criteria, personaFeedback: [] }, weighted));
    expect(computePriority({ criteria, personaFeedback: [own, echo] }, {})).toBe(computePriority({ criteria, personaFeedback: [] }, {}));
  });

  it('panelSummary leaves marked reactions out of its numbers and says how many it left out', () => {
    const personas = [{ id: 'per_a', audience: 'external' }, { id: 'per_b', audience: 'internal' }, { id: 'per_c', audience: 'internal' }] as Persona[];
    const feedback = [reaction('per_a', [4, 4, 2, 2], false), reaction('per_b', [3, 4, 2, 2], false), reaction('per_c', [1, 1, 5, 5], true)];
    const summary = panelSummary({ personaFeedback: feedback }, personas);
    expect(summary).toMatchObject({ simulated: true, n: 2, leftOut: 1, disagreement: [] });
    expect(summary.scores.appeal).toEqual({ mean: 3.5, min: 3, max: 4, spread: 1 });
    expect(summary.scores.friction).toEqual({ mean: 2, min: 2, max: 2, spread: 0 });
    expect(summary.byAudience).toEqual({
      external: { appeal: 4, adoption: 4, willingnessToPay: 2, friction: 2 },
      internal: { appeal: 3, adoption: 4, willingnessToPay: 2, friction: 2 },
    });
    // Every reaction marked: nothing is counted, and no audience has a number.
    const none = panelSummary({ personaFeedback: [reaction('per_c', [1, 1, 5, 5], true)] }, personas);
    expect(none).toMatchObject({ n: 0, leftOut: 1, disagreement: [], byAudience: {} });
    expect(none.scores.appeal).toEqual({ mean: 0, min: 0, max: 0, spread: 0 });
  });

  it('a reaction without the mark counts as before: unmarked, or marked as saying something of its own', () => {
    const feedback = [reaction('per_a', [5, 5, 5, 1]), reaction('per_b', [1, 3, 3, 3], false)];
    expect(personaScore({ personaFeedback: feedback })).toBe((scoreOf(5, 5, 5, 1) + scoreOf(1, 3, 3, 3)) / 2);
    const summary = panelSummary({ personaFeedback: feedback });
    expect(summary).toMatchObject({ n: 2, leftOut: 0, disagreement: ['appeal', 'adoption', 'willingnessToPay', 'friction'] });
    expect(summary.scores.appeal).toEqual({ mean: 3, min: 1, max: 5, spread: 4 });
  });

  it('with no personaPanel block no reaction is marked, so every reaction is counted as before', async () => {
    const t = await panelFixture(opened);
    t.replies(generalReader);
    await runPersonaPanel('ws_a', t.deps);
    const recommendation = t.store.recommendations.get('rec_1')!;
    expect(recommendation.personaFeedback).toHaveLength(3);
    for (const f of recommendation.personaFeedback) expect('sameAsBaseline' in f).toBe(false);
    expect(panelSummary(recommendation)).toMatchObject({ n: 3, leftOut: 0 });
    expect(personaScore(recommendation)).toBe(scoreOf(4, 3, 2, 4));
  });

  it('in a configured panel the reaction that says what the baseline says is the one left out', async () => {
    const t = await panelFixture(opened, panel());
    t.replies((who) => ({ ...generalReader(who), scores: who === SMB ? { appeal: 1, adoption: 1, willingness_to_pay: 1, friction: 5 } : { appeal: 4, adoption: 3, willingness_to_pay: 2, friction: 4 } }));
    await runPersonaPanel('ws_a', t.deps);
    const recommendation = t.store.recommendations.get('rec_1')!;
    expect(recommendation.personaFeedback.filter((f) => f.sameAsBaseline).map((f) => f.personaId)).toEqual([t.persona(SMB).id]);
    const summary = panelSummary(recommendation);
    expect(summary).toMatchObject({ n: 2, leftOut: 1, disagreement: [] });
    expect(summary.scores.appeal).toEqual({ mean: 4, min: 4, max: 4, spread: 0 });
    expect(personaScore(recommendation)).toBe(scoreOf(4, 3, 2, 4));
  });
});

describe('the export and the knowledge store', () => {
  /** The decision lines of the training export. */
  const decisionLines = (jsonl: string) =>
    jsonl.trim().split('\n').map((l) => JSON.parse(l) as { type: string; decision: Decision; ratings: Array<{ id: string }> }).filter((l) => l.type === 'decision');

  it('the baseline is exported as simulated persona output that judges nothing and joins no rating', async () => {
    const t = await panelFixture(opened, panel());
    // What saved each recommendation: its judgment, which its ratings join.
    const saved = Object.fromEntries(['rec_1', 'rec_2'].map((id) => [id, t.store.decisions.insert({
      id: `dec_saved_${id}`, workspaceId: 'ws_a', agentRunId: 'arun_syn', role: 'synthesizer', model: SONNET, kind: 'decision',
      payload: { tool: 'save_recommendation', recommendationId: id }, refs: [id], promptVersion: 'pv', createdAt: '2020-01-01T00:00:00.000Z',
    })]));
    // The baseline answers for rec_1 and gives no answer for rec_2.
    t.replies((who, recId) => (who === BASELINE && recId === 'rec_2' ? silent : who === BASELINE ? { ...GENERAL, other_side: 'zebrafish' } : { other_side: 'quokka', unsure: ['my budget'], concern_basis: ['goals'] }));
    await runPersonaPanel('ws_a', t.deps);
    const smb = t.persona(SMB).id;
    const ofRec = Object.fromEntries(['rec_1', 'rec_2'].map((id) => [id, rateCriterion({ workspaceId: 'ws_a', targetType: 'recommendation', targetId: id, criterion: 'upside', verdict: 'agree' }, t)]));
    const ofFeedback = rateCriterion({ workspaceId: 'ws_a', targetType: 'persona_feedback', targetId: `rec_1:${smb}`, criterion: 'appeal', verdict: 'agree' }, t);

    const jsonl = exportTrainingData('ws_a', t);
    const exported = decisionLines(jsonl);
    const feedback = exported.filter((l) => l.decision.kind === 'persona_feedback');
    expect(feedback).toHaveLength(PAIRS + 1);
    // The baseline: a persona_feedback decision of a persona-role run, marked, with no persona and no rating.
    const [baseline, ...more] = feedback.filter((l) => (l.decision.payload as { baseline?: boolean }).baseline === true);
    expect(more).toEqual([]);
    expect(baseline!.decision).toMatchObject({ role: 'persona', kind: 'persona_feedback', refs: ['rec_1'] });
    expect(baseline!.decision.payload).toMatchObject({ tool: 'submit_persona_feedback', input: { recommendation_id: 'rec_1', other_side: 'zebrafish' } });
    expect(baseline!.ratings).toEqual([]);
    // Its text is in that line and in no other: the table of baselines and earlier rounds is no source of lines.
    expect(jsonl.trim().split('\n').filter((l) => l.includes('zebrafish'))).toHaveLength(1);
    // A persona's reaction, new fields and all, is exported as before: its decision, joined by the ratings of exactly that reaction.
    const ofSmb = feedback.find((l) => (l.decision.payload as { targetId?: string }).targetId === `rec_1:${smb}`)!;
    expect(ofSmb.decision.payload).toMatchObject({ personaId: smb, input: { other_side: 'quokka', unsure: ['my budget'], concern_basis: ['goals'] } });
    expect(ofSmb.ratings.map((r) => r.id)).toEqual([ofFeedback.id]);
    for (const l of feedback.filter((x) => x !== ofSmb)) expect(l.ratings).toEqual([]);
    // The record that a baseline was unavailable joins no rating and is no judgment of its recommendation:
    // a recommendation's rating joins the decision that saved it, and that line only.
    const unavailable = exported.filter((l) => (l.decision.payload as { event?: string }).event === 'baseline_unavailable');
    expect(unavailable).toHaveLength(1);
    expect(unavailable[0]!.decision.payload).toMatchObject({ recommendation: 'rec_2' });
    expect(unavailable[0]!.ratings).toEqual([]);
    for (const id of ['rec_1', 'rec_2']) {
      expect(exported.filter((l) => l.ratings.some((r) => r.id === ofRec[id]!.id)).map((l) => l.decision.id), id).toEqual([saved[id]!.id]);
    }
  });

  it('the knowledge store serves a recommendation without its panel: no reaction, no baseline, no earlier round', async () => {
    const t = await panelFixture(opened, panel());
    t.replies((who) => ({
      concerns: [`${who === BASELINE ? 'zebrafish' : 'quokka'} concern`], reasoning: `${who === BASELINE ? 'zebrafish' : 'quokka'} reasoning`,
      other_side: 'axolotl', instead: 'axolotl', unsure: ['axolotl'],
    }));
    await runPersonaPanel('ws_a', t.deps);
    t.edit('rec_1', 'Do rec_1, with a pilot first');
    await runPersonaPanel('ws_a', t.deps);
    expect(panelHistory(t.store, 'rec_1').baselines).toHaveLength(2);
    expect(panelHistory(t.store, 'rec_1').earlierRounds).toHaveLength(3);

    const reader = ctx({ role: 'worker' });
    const expanded = await t.handle(reader, 'expand', { id: 'rec_1' });
    expect(expanded.ok).toBe(true);
    const served = JSON.stringify(expanded);
    expect(served).toContain('with a pilot first');
    for (const word of ['zebrafish', 'quokka', 'axolotl', 'sameAsBaseline', 'earlierConcerns']) expect(served, word).not.toContain(word);
    // Search finds the recommendation by its text, and nothing by the panel's.
    const found = await t.handle(reader, 'search', { query: 'pilot' });
    expect(JSON.stringify(found)).toContain('rec_1');
    for (const word of ['zebrafish', 'quokka', 'axolotl']) {
      const hit = await t.handle(reader, 'search', { query: word });
      expect(hit.ok, word).toBe(true);
      expect(JSON.stringify(hit), word).not.toContain('rec_');
    }
  });
});
