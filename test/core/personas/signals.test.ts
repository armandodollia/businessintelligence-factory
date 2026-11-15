/**
 * Persona signals (design §5): the user's reactions to a persona, read from the feedback log and the
 * ratings — verdict reactions, rulings on pairs, ratings of the persona's panel feedback and profile,
 * and include overrides — and the open ones a learning run has not consumed yet.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setIncludeOverride } from '../../../src/core/feedback/actions.js';
import { listFeedback } from '../../../src/core/feedback/events.js';
import { confirmOverride, overridePair, reactToPosition, reactToVerdict, revokeOverride } from '../../../src/core/flows/feedback.js';
import type { Flow } from '../../../src/core/flows/types.js';
import { personaLearningSettings } from '../../../src/core/personas/settings.js';
import { collectPersonaSignals, decisionPolarity, openSignals } from '../../../src/core/personas/signals.js';
import { personaLearningRepos } from '../../../src/core/personas/store.js';
import type { LearningRunStatus, PersonaSignal } from '../../../src/core/personas/types.js';
import { rateCriterion } from '../../../src/core/scoring/ratings.js';
import { reactToRead } from '../../../src/core/stakeholders/reads.js';
import { recordDecision } from '../../../src/core/stakeholders/statements.js';
import { stakeholderRepos } from '../../../src/core/stakeholders/store.js';
import type { Store } from '../../../src/core/store/db.js';
import type { Persona, Recommendation } from '../../../src/core/types.js';
import { flowSetup, T0 } from '../flows/flowFixture.js';

const opened: Store[] = [];
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(T0));
});
afterEach(() => {
  vi.useRealTimers();
  for (const s of opened.splice(0)) s.close();
});

/** Moves the clock `minutes` after T0. */
const clock = (minutes: number) => vi.setSystemTime(new Date(Date.parse(T0) + minutes * 60_000));
const iso = (minutes: number) => new Date(Date.parse(T0) + minutes * 60_000).toISOString();
const pairKey = (x: Flow, y: Flow) => [x.lineageId, y.lineageId].sort().join('|');

function seed() {
  const t = flowSetup(opened);
  const smb = t.persona('smb');
  const ent = t.persona('ent');
  const acme = t.flow('Acme');
  const globex = t.flow('Globex');
  const initech = t.flow('Initech');
  const rec: Recommendation = t.store.recommendations.insert({
    id: 'rec_1', workspaceId: 'ws_a', title: 'Offer Google sign-up', summary: 's', criteria: {}, findingIds: [], priority: 3, createdAt: T0,
    personaFeedback: [smb, ent].map((p) => ({
      personaId: p.id, scores: { appeal: 4, adoption: 3, willingnessToPay: 2, friction: 2 }, concerns: [], reasoning: 'r', wouldChangeMind: 'w', simulated: true as const,
    })),
  });
  return { ...t, smb, ent, acme, globex, initech, rec };
}

const only = (signals: PersonaSignal[], source: PersonaSignal['source']) => signals.filter((s) => s.source === source);

describe('collectPersonaSignals', () => {
  it('reads one signal per source with the polarity, item key and topic of the table', () => {
    const t = seed();
    const v1 = t.verdict(t.smb, t.acme, t.globex);
    const v2 = t.verdict(t.smb, t.initech, t.acme);
    clock(1);
    reactToVerdict(t.store, 'local-user', v1.id, 'disagree', 'Globex is simpler');
    clock(2);
    overridePair(t.store, 'local-user', 'ws_a', t.typeId, t.acme.id, t.initech.id, 'Initech asks too much');
    clock(3);
    rateCriterion({ workspaceId: 'ws_a', targetType: 'persona_feedback', targetId: `rec_1:${t.smb.id}`, criterion: 'appeal', verdict: 'disagree', userValue: 2, reason: 'too keen' }, t);
    clock(4);
    rateCriterion({ workspaceId: 'ws_a', targetType: 'persona', targetId: t.smb.id, criterion: 'goals', verdict: 'agree' }, t);
    clock(5);
    setIncludeOverride(t.store, 'persona', t.smb.id, false, { reason: 'not our buyer' });
    clock(6);
    reactToPosition(t.store, 'local-user', 'ws_a', t.acme.id, t.typeId, 'disagree'); // not a persona signal

    const signals = collectPersonaSignals(t.store, t.smb.id);
    expect(signals.map((s) => s.source)).toEqual(['verdict_reaction', 'override', 'feedback_rating', 'profile_rating', 'include']);
    expect(signals.map((s) => s.at)).toEqual([iso(1), iso(2), iso(3), iso(4), iso(5)]);
    for (const s of signals) expect(s.personaId).toBe(t.smb.id);

    const [reaction, override, fbRating, profile, include] = signals as [PersonaSignal, PersonaSignal, PersonaSignal, PersonaSignal, PersonaSignal];
    expect(reaction).toMatchObject({
      polarity: 'disagree', itemKey: pairKey(t.acme, t.globex), topic: 'flow:sign_up', personaVersion: 1, reason: 'Globex is simpler',
      detail: 'picked Acme sign-up over Globex sign-up (strength 2); you disagreed',
    });
    expect(reaction.refs).toEqual([v1.id, v1.flowAId, v1.flowBId]);
    // The persona picked Initech; the user ruled Acme over Initech.
    expect(override).toMatchObject({
      polarity: 'disagree', itemKey: pairKey(t.acme, t.initech), topic: 'flow:sign_up', personaVersion: 1, reason: 'Initech asks too much',
      detail: 'picked Initech sign-up over Acme sign-up (strength 2); you ruled Acme sign-up over Initech sign-up',
    });
    expect(override.refs).toEqual([v2.id, t.acme.id, t.initech.id]);
    expect(fbRating).toMatchObject({
      polarity: 'disagree', itemKey: 'rec:rec_1', topic: 'recommendation:appeal', reason: 'too keen', refs: ['rec_1'],
      detail: 'rated appeal 4 for rec_1; you set 2',
    });
    expect(profile).toMatchObject({
      polarity: 'agree', itemKey: 'field:goals', topic: 'profile:goals', refs: [t.smb.id], detail: 'rated goals confidence 0.7; you agreed',
    });
    expect(profile.reason).toBeUndefined();
    expect(include).toMatchObject({ polarity: 'disagree', itemKey: 'persona', topic: 'persona', reason: 'not our buyer', refs: [t.smb.id] });
  });

  it('the latest reaction to a verdict decides: disagree then agree is one agree signal', () => {
    const t = seed();
    const v = t.verdict(t.smb, t.acme, t.globex);
    clock(1);
    reactToVerdict(t.store, 'local-user', v.id, 'disagree', 'wrong');
    clock(2);
    const agree = reactToVerdict(t.store, 'local-user', v.id, 'agree');
    const signals = collectPersonaSignals(t.store, t.smb.id);
    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({ id: agree.id, polarity: 'agree', at: iso(2), detail: 'picked Acme sign-up over Globex sign-up (strength 2); you agreed' });
    expect(signals[0]!.reason).toBeUndefined();
  });

  it('a ruling on a pair whose verdict also has a reaction gives no override signal for that verdict', () => {
    const t = seed();
    const v = t.verdict(t.smb, t.initech, t.acme);
    clock(1);
    reactToVerdict(t.store, 'local-user', v.id, 'disagree');
    clock(2);
    overridePair(t.store, 'local-user', 'ws_a', t.typeId, t.acme.id, t.initech.id);
    const signals = collectPersonaSignals(t.store, t.smb.id);
    expect(signals.map((s) => s.source)).toEqual(['verdict_reaction']);
  });

  it('a ruling against a tie disagrees; a ruling matching the verdict agrees', () => {
    const t = seed();
    t.verdict(t.smb, t.acme, t.globex, { winner: 'tie' });
    t.verdict(t.smb, t.acme, t.initech);
    clock(1);
    overridePair(t.store, 'local-user', 'ws_a', t.typeId, t.globex.id, t.acme.id);
    clock(2);
    overridePair(t.store, 'local-user', 'ws_a', t.typeId, t.acme.id, t.initech.id);
    const signals = collectPersonaSignals(t.store, t.smb.id);
    expect(signals.map((s) => [s.source, s.polarity])).toEqual([['override', 'disagree'], ['override', 'agree']]);
    expect(signals[0]!.detail).toMatch(/^called (Acme sign-up and Globex sign-up|Globex sign-up and Acme sign-up) a tie; you ruled Globex sign-up over Acme sign-up$/);
  });

  it('an override signal id is <event id>:<verdict id>, unique across the verdicts of one ruling', () => {
    const t = seed();
    const mine = t.verdict(t.smb, t.initech, t.acme);
    const theirs = t.verdict(t.ent, t.initech, t.acme);
    clock(1);
    overridePair(t.store, 'local-user', 'ws_a', t.typeId, t.acme.id, t.initech.id);
    const event = listFeedback(t.store, { workspaceId: 'ws_a', kind: 'flow_override' }).at(-1)!;
    const smb = only(collectPersonaSignals(t.store, t.smb.id), 'override');
    const ent = only(collectPersonaSignals(t.store, t.ent.id), 'override');
    expect(smb.map((s) => s.id)).toEqual([`${event.id}:${mine.id}`]);
    expect(ent.map((s) => s.id)).toEqual([`${event.id}:${theirs.id}`]);
  });

  it('two rulings on one pair: only the later one gives override signals', () => {
    const t = seed();
    const v = t.verdict(t.smb, t.initech, t.acme);
    clock(1);
    overridePair(t.store, 'local-user', 'ws_a', t.typeId, t.acme.id, t.initech.id, 'first');
    clock(2);
    overridePair(t.store, 'local-user', 'ws_a', t.typeId, t.initech.id, t.acme.id, 'second');
    const later = listFeedback(t.store, { workspaceId: 'ws_a', kind: 'flow_override' }).at(-1)!;
    expect(only(collectPersonaSignals(t.store, t.smb.id), 'override')).toEqual([
      expect.objectContaining({ id: `${later.id}:${v.id}`, polarity: 'agree', reason: 'second', at: iso(2) }),
    ]);
  });

  it('a revoked or dropped ruling gives no override signal', () => {
    const t = seed();
    t.verdict(t.smb, t.initech, t.acme);
    clock(1);
    const o = overridePair(t.store, 'local-user', 'ws_a', t.typeId, t.acme.id, t.initech.id);
    expect(only(collectPersonaSignals(t.store, t.smb.id), 'override')).toHaveLength(1);
    clock(2);
    revokeOverride(t.store, 'local-user', o.id);
    expect(only(collectPersonaSignals(t.store, t.smb.id), 'override')).toEqual([]);

    // A ruling dropped after a new version gives none; a standing one on another pair still counts.
    t.verdict(t.smb, t.globex, t.acme);
    t.verdict(t.smb, t.initech, t.globex);
    clock(3);
    overridePair(t.store, 'local-user', 'ws_a', t.typeId, t.acme.id, t.globex.id);
    const dropped = overridePair(t.store, 'local-user', 'ws_a', t.typeId, t.globex.id, t.initech.id);
    expect(only(collectPersonaSignals(t.store, t.smb.id), 'override')).toHaveLength(2);
    t.newVersion(t.initech);
    clock(4);
    confirmOverride(t.store, 'local-user', dropped.id, false);
    expect(only(collectPersonaSignals(t.store, t.smb.id), 'override').map((s) => s.refs.slice(1))).toEqual([[t.acme.id, t.globex.id]]);
  });

  it('drops a rating of the panel feedback made before the persona revised it', () => {
    const t = seed();
    rateCriterion({ workspaceId: 'ws_a', targetType: 'persona_feedback', targetId: `rec_1:${t.smb.id}`, criterion: 'friction', verdict: 'agree' }, t);
    expect(only(collectPersonaSignals(t.store, t.smb.id), 'feedback_rating')).toHaveLength(1);
    // A later persona_feedback judgment of the same item: the rated revision is no longer current.
    t.store.agentRuns.insert({ id: 'arun_p', workspaceId: 'ws_a', role: 'persona', model: { provider: 'claude', model: 'sonnet' }, token: 'tok_p', status: 'done', startedAt: iso(5) });
    t.store.decisions.insert({
      id: 'dec_pf', workspaceId: 'ws_a', agentRunId: 'arun_p', role: 'persona', model: { provider: 'claude', model: 'sonnet' }, kind: 'persona_feedback',
      payload: { personaId: t.smb.id, input: { recommendation_id: 'rec_1' } }, refs: [], promptVersion: 'pv_1', createdAt: iso(5),
    });
    expect(only(collectPersonaSignals(t.store, t.smb.id), 'feedback_rating')).toEqual([]);
  });

  it('keeps the latest rating per target and criterion', () => {
    const t = seed();
    const rate = (verdict: 'agree' | 'disagree') =>
      rateCriterion({ workspaceId: 'ws_a', targetType: 'persona', targetId: t.smb.id, criterion: 'needs', verdict, ...(verdict === 'disagree' ? { userValue: 0.3 } : {}) }, t);
    rate('disagree');
    clock(1);
    const last = rate('agree');
    expect(only(collectPersonaSignals(t.store, t.smb.id), 'profile_rating')).toEqual([expect.objectContaining({ id: last.id, polarity: 'agree' })]);
  });

  it('an include override reset to none gives no signal; including agrees', () => {
    const t = seed();
    setIncludeOverride(t.store, 'persona', t.smb.id, false);
    clock(1);
    setIncludeOverride(t.store, 'persona', t.smb.id, null);
    expect(only(collectPersonaSignals(t.store, t.smb.id), 'include')).toEqual([]);
    clock(2);
    setIncludeOverride(t.store, 'persona', t.smb.id, true);
    expect(only(collectPersonaSignals(t.store, t.smb.id), 'include')).toEqual([expect.objectContaining({ polarity: 'agree', detail: 'you included the persona' })]);
  });

  it('returns only the persona’s own signals', () => {
    const t = seed();
    const mine = t.verdict(t.smb, t.acme, t.globex);
    const theirs = t.verdict(t.ent, t.acme, t.globex);
    reactToVerdict(t.store, 'local-user', theirs.id, 'disagree');
    overridePair(t.store, 'local-user', 'ws_a', t.typeId, t.globex.id, t.acme.id);
    rateCriterion({ workspaceId: 'ws_a', targetType: 'persona_feedback', targetId: `rec_1:${t.ent.id}`, criterion: 'appeal', verdict: 'agree' }, t);
    rateCriterion({ workspaceId: 'ws_a', targetType: 'persona', targetId: t.ent.id, criterion: 'goals', verdict: 'agree' }, t);
    setIncludeOverride(t.store, 'persona', t.ent.id, true);

    const smb = collectPersonaSignals(t.store, t.smb.id);
    expect(smb.map((s) => s.source)).toEqual(['override']);
    expect(smb[0]!.refs[0]).toBe(mine.id);
    // ent reacted to its verdict, so only its other sources remain.
    expect(collectPersonaSignals(t.store, t.ent.id).map((s) => s.source)).toEqual(['verdict_reaction', 'feedback_rating', 'profile_rating', 'include']);
    expect(collectPersonaSignals(t.store, 'per_unknown')).toEqual([]);
  });

  it('applies the window: after `since`, up to and including `until`', () => {
    const t = seed();
    const verdicts = [t.verdict(t.smb, t.acme, t.globex), t.verdict(t.smb, t.acme, t.initech), t.verdict(t.smb, t.globex, t.initech)];
    verdicts.forEach((v, i) => {
      clock(i + 1);
      reactToVerdict(t.store, 'local-user', v.id, 'disagree');
    });
    expect(collectPersonaSignals(t.store, t.smb.id, { since: iso(1), until: iso(2) }).map((s) => s.at)).toEqual([iso(2)]);
  });
});

describe('openSignals', () => {
  const settings = (t: ReturnType<typeof seed>) => personaLearningSettings(t.config);
  const run = (t: ReturnType<typeof seed>, persona: Persona, status: LearningRunStatus, signalsThrough: string) =>
    personaLearningRepos(t.store).runs.insert({
      id: `plr_${status}_${signalsThrough}`, rootWorkspaceId: 'ws_a', personaId: persona.id, status, signalsThrough, shownSignalIds: [], shownStatementIds: [],
      stats: { n: 0, agree: 0, disagree: 0, items: 0, lower: 0 }, createdAt: signalsThrough,
    });
  /** Three disagreements, at minutes 1, 2 and 3. */
  function threeReactions() {
    const t = seed();
    const verdicts = [t.verdict(t.smb, t.acme, t.globex), t.verdict(t.smb, t.acme, t.initech), t.verdict(t.smb, t.globex, t.initech)];
    verdicts.forEach((v, i) => {
      clock(i + 1);
      reactToVerdict(t.store, 'local-user', v.id, 'disagree');
    });
    return t;
  }
  const now = new Date(iso(10));

  it('drops signals at or before the latest proposed / no_change run’s signalsThrough', () => {
    const t = threeReactions();
    expect(openSignals(t.store, settings(t), t.smb.id, now)).toHaveLength(3);
    run(t, t.smb, 'proposed', iso(1));
    expect(openSignals(t.store, settings(t), t.smb.id, now).map((s) => s.at)).toEqual([iso(2), iso(3)]);
    run(t, t.smb, 'no_change', iso(2));
    expect(openSignals(t.store, settings(t), t.smb.id, now).map((s) => s.at)).toEqual([iso(3)]);
  });

  it('a failed run consumes nothing; another persona’s run does not count', () => {
    const t = threeReactions();
    run(t, t.smb, 'failed', iso(3));
    run(t, t.ent, 'proposed', iso(3));
    expect(openSignals(t.store, settings(t), t.smb.id, now)).toHaveLength(3);
  });

  it('drops signals older than windowDays', () => {
    const t = threeReactions();
    const day = 24 * 60 * 60_000;
    const s = { ...settings(t), windowDays: 180 };
    // The window starts 180 days before now: minute 2 is its first instant.
    expect(openSignals(t.store, s, t.smb.id, new Date(Date.parse(iso(2)) + 180 * day)).map((x) => x.at)).toEqual([iso(2), iso(3)]);
    expect(openSignals(t.store, s, t.smb.id, new Date(Date.parse(iso(3)) + 181 * day))).toEqual([]);
  });
});

describe('stakeholder signals (stakeholder design §11)', () => {
  function stakeholderSeed() {
    const t = seed();
    const cfo = t.store.personas.insert({
      id: 'per_stk_cfo', workspaceId: 'ws_a', slug: 'stk-cfo', segment: 'Chief financial officer', profile: {}, version: 2, status: 'verified',
      agentMdPath: 'stk-cfo.md', kind: 'stakeholder', stakeholderType: 'leader', subjectKind: 'own', relation: 'Approves budgets', disclosure: 'open',
    });
    const recs = ['rec_a', 'rec_b', 'rec_c', 'rec_d', 'rec_e'].map((id) =>
      t.store.recommendations.insert({ id, workspaceId: 'ws_a', title: id, summary: 's', criteria: {}, findingIds: [], priority: 3, personaFeedback: [], createdAt: T0 }),
    );
    const read = (recommendationId: string, stance: string) =>
      stakeholderRepos(t.store).reads.insert({
        id: `srd_${recommendationId}`, rootWorkspaceId: 'ws_a', workspaceId: 'ws_a', recommendationId, personaId: cfo.id, personaVersion: 2, stance,
        conditions: [], concerns: [], reasoning: 'r', wouldChangeMind: 'w', agentRunId: 'arun_read', simulated: true, createdAt: T0,
      });
    const decide = (recommendationId: string, decision: 'approved' | 'approved_with_conditions' | 'rejected' | 'deferred') =>
      recordDecision(t.store, 'local-user', 'ws_a', { recommendationId, personaId: cfo.id, decision, reasoning: `why ${decision}` });
    return { ...t, cfo, recs, read, decide };
  }

  it('read_reaction: the latest reaction per read; item rec:<id>, topic read, the read\'s persona version', () => {
    const t = stakeholderSeed();
    const r = t.read('rec_a', 'approve');
    clock(1);
    reactToRead(t.store, 'local-user', 'ws_a', r.id, 'agree');
    clock(2);
    const e = reactToRead(t.store, 'local-user', 'ws_a', r.id, 'disagree', 'she would refuse');
    const signals = only(collectPersonaSignals(t.store, t.cfo.id), 'read_reaction');
    expect(signals).toEqual([{
      id: e.id, source: 'read_reaction', personaId: t.cfo.id, personaVersion: 2, polarity: 'disagree', itemKey: 'rec:rec_a', topic: 'read',
      detail: 'read rec_a: approve; you disagreed', reason: 'she would refuse', refs: [r.id, 'rec_a'], at: iso(2),
    }]);
  });

  it('decision_record: rejected against approve disagrees, approved against approve_with_conditions agrees; deferred and a missing read give none', () => {
    const t = stakeholderSeed();
    const a = t.read('rec_a', 'approve');
    const b = t.read('rec_b', 'approve_with_conditions');
    t.read('rec_c', 'reject');
    clock(1);
    const sa = t.decide('rec_a', 'rejected');
    clock(2);
    const sb = t.decide('rec_b', 'approved');
    clock(3);
    t.decide('rec_c', 'deferred');
    clock(4);
    t.decide('rec_d', 'approved'); // no read of rec_d
    const signals = only(collectPersonaSignals(t.store, t.cfo.id), 'decision_record');
    expect(signals).toEqual([
      {
        id: `${sa.id}:${a.id}`, source: 'decision_record', personaId: t.cfo.id, personaVersion: 2, polarity: 'disagree', itemKey: 'rec:rec_a', topic: 'decision',
        detail: 'read rec_a: approve; the real decision: rejected', refs: [a.id, 'rec_a'], at: iso(1),
      },
      expect.objectContaining({ id: `${sb.id}:${b.id}`, polarity: 'agree', itemKey: 'rec:rec_b', at: iso(2) }),
    ]);
    // The statement's text is never the signal's reason.
    for (const s of signals) expect(s.reason).toBeUndefined();
  });

  it('decision_record: the latest record per recommendation counts (a later deferred one ends the signal)', () => {
    const t = stakeholderSeed();
    t.read('rec_a', 'reject');
    clock(1);
    t.decide('rec_a', 'rejected');
    expect(only(collectPersonaSignals(t.store, t.cfo.id), 'decision_record').map((s) => s.polarity)).toEqual(['agree']);
    clock(2);
    t.decide('rec_a', 'deferred');
    expect(only(collectPersonaSignals(t.store, t.cfo.id), 'decision_record')).toEqual([]);
  });

  it('decisionPolarity follows the table of §11', () => {
    expect(decisionPolarity('approved', 'approve')).toBe('agree');
    expect(decisionPolarity('approved_with_conditions', 'approve')).toBe('agree');
    expect(decisionPolarity('approved_with_conditions', 'approve_with_conditions')).toBe('agree');
    expect(decisionPolarity('rejected', 'reject')).toBe('agree');
    expect(decisionPolarity('approved', 'reject')).toBe('disagree');
    expect(decisionPolarity('rejected', 'approve_with_conditions')).toBe('disagree');
    expect(decisionPolarity('deferred', 'approve')).toBeUndefined();
    expect(decisionPolarity('approved', 'not_my_call')).toBeUndefined();
  });
});
