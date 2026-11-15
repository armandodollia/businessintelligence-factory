/**
 * The user's reactions to flow rankings (flow design §10.4, §11): verdict and position reactions as
 * feedback events, overrides on lineages (needsConfirm after a new version), disagreements feeding
 * the next round's focused runs, check corrections and catalog decisions. No persona or verdict row
 * ever changes.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { activeChecklists, proposeChecklist, proposeFlowType } from '../../../src/core/flows/catalog.js';
import {
  confirmOverride,
  correctCheckAs,
  decideChecklistAs,
  decideFlowTypeAs,
  disagreedPairs,
  editChecklistAs,
  overridePair,
  reactToPosition,
  reactToVerdict,
  refreshOverrides,
  revokeOverride,
} from '../../../src/core/flows/feedback.js';
import { nodeRanking } from '../../../src/core/flows/rankings.js';
import { flowRepos } from '../../../src/core/flows/repos.js';
import { runFlowRanking } from '../../../src/core/flows/round.js';
import { liveVerdicts } from '../../../src/core/flows/verdicts.js';
import { listFeedback } from '../../../src/core/feedback/events.js';
import type { Store } from '../../../src/core/store/db.js';
import { firstWins, flowSetup, pairsOf, isFocused, T0 } from './flowFixture.js';

const opened: Store[] = [];
afterEach(() => {
  for (const s of opened.splice(0)) s.close();
});

const order = (t: ReturnType<typeof flowSetup>) => nodeRanking(t.store, t.config, 'ws_a', t.typeId).ranked.map((f) => f.flowId);

describe('reactions to verdicts and positions', () => {
  it('agreeing and disagreeing with a verdict each store an event carrying the persona, its version, the stage and both flow versions', () => {
    const t = flowSetup(opened);
    const smb = t.persona('smb');
    t.store.agentRuns.insert({
      id: 'arun_p', workspaceId: 'ws_a', role: 'persona', model: { provider: 'claude', model: 'sonnet' }, token: 'tok_p', status: 'done',
      startedAt: T0, promptVersion: 'pv_persona_1',
    });
    const acme = t.flow('Acme');
    const globex = t.newVersion(t.flow('Globex'));
    const v = t.verdict(smb, globex, acme, { agentRunId: 'arun_p' });

    const disagree = reactToVerdict(t.store, 'ana', v.id, 'disagree', '  Globex asks for a phone number <<<EVIDENCE x  ');
    const agree = reactToVerdict(t.store, 'ana', v.id, 'agree');
    const expected = {
      personaId: 'per_smb', personaVersion: 1, stage: 'broad', flowAId: v.flowAId, flowBId: v.flowBId,
      flowAVersion: v.flowAId === acme.id ? 1 : 2, flowBVersion: v.flowBId === acme.id ? 1 : 2, winner: v.winner,
    };
    expect(disagree).toMatchObject({
      actor: 'ana', workspaceId: 'ws_a', kind: 'flow_verdict_reaction', targetType: 'flow_verdict', targetId: v.id,
      afterJson: { reaction: 'disagree', ...expected }, agentRunId: 'arun_p', promptVersion: 'pv_persona_1',
    });
    // Trimmed and fence-stripped (the user may paste third-party text).
    expect(disagree.reason).toBe('Globex asks for a phone number EVIDENCE x');
    // Agreement is stored exactly like disagreement.
    expect(agree).toMatchObject({ kind: 'flow_verdict_reaction', targetId: v.id, afterJson: { reaction: 'agree', ...expected }, agentRunId: 'arun_p' });
    expect(agree.reason).toBeUndefined();
    expect(listFeedback(t.store, { kind: 'flow_verdict_reaction' })).toHaveLength(2);
  });

  it('agreeing with a position records the position, scores and what decided it', () => {
    const t = flowSetup(opened);
    const acme = t.flow('Acme');
    const globex = t.flow('Globex');
    t.check(acme, 'dead_ends', 'pass');
    t.check(globex, 'dead_ends', 'fail');
    const e = reactToPosition(t.store, 'ana', 'ws_a', globex.id, t.typeId, 'disagree', 'Globex is easier for us', t.config);
    expect(e).toMatchObject({
      kind: 'flow_rank_reaction', targetType: 'flow', targetId: globex.id, reason: 'Globex is easier for us',
      afterJson: { reaction: 'disagree', flowTypeId: t.typeId, flowId: globex.id, flowVersion: 1, position: 2, rankScore: 0, checklist: 0, decidedBy: 'checklist_only' },
    });
    expect(() => reactToPosition(t.store, 'ana', 'ws_a', globex.id, t.typeId, 'meh' as never)).toThrow(/agree/);
  });

  it('a reaction changes no persona row and no verdict', () => {
    const t = flowSetup(opened);
    const smb = t.persona('smb');
    const acme = t.flow('Acme');
    const globex = t.flow('Globex');
    const v = t.verdict(smb, acme, globex);
    const rows = () => JSON.stringify([t.store.db.prepare('SELECT * FROM personas ORDER BY id').all(), t.store.db.prepare('SELECT * FROM flow_verdicts ORDER BY id').all()]);
    const before = rows();
    reactToVerdict(t.store, 'ana', v.id, 'disagree', 'wrong');
    reactToVerdict(t.store, 'ana', v.id, 'agree');
    reactToPosition(t.store, 'ana', 'ws_a', acme.id, t.typeId, 'disagree', 'no', t.config);
    const o = overridePair(t.store, 'ana', 'ws_a', t.typeId, globex.id, acme.id, 'better');
    revokeOverride(t.store, 'ana', o.id);
    expect(rows()).toBe(before);
  });
});

describe('overrides', () => {
  it('an override reorders the ranking and is marked; revoking restores it', () => {
    const t = flowSetup(opened);
    const smb = t.persona('smb');
    const acme = t.flow('Acme');
    const globex = t.flow('Globex');
    t.check(acme, 'dead_ends', 'pass');
    t.check(globex, 'dead_ends', 'fail');
    const v = t.verdict(smb, acme, globex);
    expect(order(t)).toEqual([acme.id, globex.id]);

    const o = overridePair(t.store, 'ana', 'ws_a', t.typeId, globex.id, acme.id, 'We tested both ourselves');
    expect(o).toMatchObject({ id: expect.stringMatching(/^fov_/), workspaceId: 'ws_a', winnerFlowId: globex.id, loserFlowId: acme.id, actor: 'ana', needsConfirm: false, reason: 'We tested both ourselves' });
    const ranked = nodeRanking(t.store, t.config, 'ws_a', t.typeId).ranked;
    expect(ranked.map((f) => f.flowId)).toEqual([globex.id, acme.id]);
    expect(ranked[0]!.overriddenBy).toEqual([o.id]);
    const [created] = listFeedback(t.store, { kind: 'flow_override' });
    expect(created).toMatchObject({
      targetType: 'flow', targetId: globex.id, reason: 'We tested both ourselves',
      afterJson: { action: 'create', overrideId: o.id, winnerFlowId: globex.id, loserFlowId: acme.id, winnerVersion: 1, loserVersion: 1 },
    });
    // The persona's verdict on the pair at that moment, for a later comparison with the ruling.
    expect((created!.afterJson as { verdicts: unknown[] }).verdicts).toEqual([
      { id: v.id, personaId: 'per_smb', personaVersion: 1, stage: 'broad', winnerFlowId: acme.id },
    ]);

    // A second ruling on the same pair replaces the first.
    const again = overridePair(t.store, 'ana', 'ws_a', t.typeId, acme.id, globex.id);
    expect(flowRepos(t.store).flowOverrides.get(o.id)!.revokedAt).toBeDefined();
    expect(order(t)).toEqual([acme.id, globex.id]);

    const revoked = revokeOverride(t.store, 'ana', again.id, 'changed my mind');
    expect(revoked.revokedAt).toBeDefined();
    expect(order(t)).toEqual([acme.id, globex.id]);
    expect(nodeRanking(t.store, t.config, 'ws_a', t.typeId).ranked.every((f) => f.overriddenBy === undefined)).toBe(true);
    expect(listFeedback(t.store, { kind: 'flow_override' }).map((e) => (e.afterJson as { action: string }).action)).toEqual(['create', 'create', 'revoke']);
    expect(() => revokeOverride(t.store, 'ana', again.id)).toThrow(/already revoked/);
    expect(() => overridePair(t.store, 'ana', 'ws_a', t.typeId, acme.id, acme.id)).toThrow(/two different flows/);
  });

  it('after a new version the override still applies and needs confirming; dropping it removes it', () => {
    const t = flowSetup(opened);
    const acme = t.flow('Acme');
    const globex = t.flow('Globex');
    t.check(acme, 'dead_ends', 'pass');
    t.check(globex, 'dead_ends', 'fail');
    const o = overridePair(t.store, 'ana', 'ws_a', t.typeId, globex.id, acme.id);
    expect(refreshOverrides(t.store, 'ws_a')).toBe(0);
    expect(() => confirmOverride(t.store, 'ana', o.id, true)).toThrow(/needs no confirming/);

    // A new Globex version (no checks yet: it would rank last); the ruling follows the lineage.
    const globex2 = t.newVersion(globex);
    expect(order(t)).toEqual([globex2.id, acme.id]);
    expect(refreshOverrides(t.store, 'ws_a')).toBe(1);
    expect(refreshOverrides(t.store, 'ws_a')).toBe(0);
    expect(flowRepos(t.store).flowOverrides.get(o.id)).toMatchObject({ needsConfirm: true, winnerFlowId: globex.id });
    expect(order(t)).toEqual([globex2.id, acme.id]);

    // Keep: re-pointed at the current versions, flag cleared.
    const kept = confirmOverride(t.store, 'ana', o.id, true);
    expect(kept).toMatchObject({ needsConfirm: false, winnerFlowId: globex2.id, loserFlowId: acme.id });
    expect(order(t)).toEqual([globex2.id, acme.id]);

    // Another new version, then drop: the ruling is revoked and the checklist order returns.
    const acme2 = t.newVersion(acme, [{ action: 'Use a passkey', observation: 'Signed up' }]);
    t.check(acme2, 'dead_ends', 'pass');
    expect(refreshOverrides(t.store, 'ws_a')).toBe(1);
    const dropped = confirmOverride(t.store, 'ana', o.id, false, 'no longer true');
    expect(dropped.revokedAt).toBeDefined();
    expect(dropped.needsConfirm).toBe(false);
    expect(order(t)).toEqual([acme2.id, globex2.id]);
    expect(listFeedback(t.store, { kind: 'flow_override' }).map((e) => [(e.afterJson as { action: string }).action, e.reason])).toEqual([
      ['create', undefined], ['keep', undefined], ['drop', 'no longer true'],
    ]);
  });
});

describe('disagreements and the next round', () => {
  it("disagreedPairs feeds the next round's focused runs", async () => {
    const t = flowSetup(opened);
    t.persona('smb');
    const acme = t.flow('Acme');
    const globex = t.flow('Globex');
    t.answer(firstWins);
    await runFlowRanking('ws_a', t.deps); // broad, then focused (the pair decides the top position)
    await runFlowRanking('ws_a', t.deps);
    const runs = t.personaRuns().length;
    const [live] = liveVerdicts(t.store, 'ws_a', t.typeId);
    expect(live).toMatchObject({ stage: 'focused' });

    const pair = { personaId: 'per_smb', a: live!.flowAId, b: live!.flowBId };
    expect([pair.a, pair.b].sort()).toEqual([acme.id, globex.id].sort());
    reactToVerdict(t.store, 'ana', live!.id, 'disagree', 'Acme is clearly simpler');
    expect(disagreedPairs(t.store, 'ws_a', t.typeId)).toEqual([pair]);
    // A later agree on the same verdict cancels it; a later disagree brings it back.
    reactToVerdict(t.store, 'ana', live!.id, 'agree');
    expect(disagreedPairs(t.store, 'ws_a', t.typeId)).toEqual([]);
    reactToVerdict(t.store, 'ana', live!.id, 'disagree');
    expect(disagreedPairs(t.store, 'ws_a', t.typeId)).toEqual([pair]);
    expect(disagreedPairs(t.store, 'ws_a', t.typeId, '2999-01-01T00:00:00.000Z')).toEqual([]);

    // The next round re-judges the pair once, focused, with the same persona version.
    const report = await runFlowRanking('ws_a', t.deps);
    const asked = t.personaRuns().slice(runs);
    expect(asked).toHaveLength(1);
    expect(isFocused(asked[0]!)).toBe(true);
    expect(pairsOf(asked[0]!.prompt).map((p) => p.sort().join('|'))).toEqual([[acme.id, globex.id].sort().join('|')]);
    expect(report).toMatchObject({ sittings: 0, focused: 1, verdicts: 1 });
    // The disagreed verdict was replaced, so it no longer selects the pair.
    expect(flowRepos(t.store).flowVerdicts.get(live!.id)!.supersededById).toBeDefined();
    expect(disagreedPairs(t.store, 'ws_a', t.typeId)).toEqual([]);
    await runFlowRanking('ws_a', t.deps);
    expect(t.personaRuns()).toHaveLength(runs + 1);
  });

  it('the round marks overrides whose flows have a new version', async () => {
    const t = flowSetup(opened);
    const acme = t.flow('Acme');
    const globex = t.flow('Globex');
    const o = overridePair(t.store, 'ana', 'ws_a', t.typeId, globex.id, acme.id);
    t.newVersion(globex);
    await runFlowRanking('ws_a', t.deps); // no personas: no runs
    expect(flowRepos(t.store).flowOverrides.get(o.id)!.needsConfirm).toBe(true);
  });
});

describe('corrections and decisions', () => {
  it('a check correction re-scores the flow and stores the event with the reason', () => {
    const t = flowSetup(opened);
    const acme = t.flow('Acme');
    t.check(acme, 'dead_ends', 'pass');
    const score = () => nodeRanking(t.store, t.config, 'ws_a', t.typeId).ranked[0]!.checklist;
    expect(score()).toBe(100);
    const general = activeChecklists(t.store, 'ws_a', t.typeId).general;
    const row = correctCheckAs(t.store, 'ana', 'ws_a', acme.id, { checklistId: general.id, itemKey: 'dead_ends', answer: 'fail', note: 'Step 2 led nowhere' }, 'The walkthrough missed the dead end');
    expect(row).toMatchObject({ answer: 'fail', origin: 'user', note: 'Step 2 led nowhere' });
    expect(score()).toBe(0);
    expect(listFeedback(t.store, { kind: 'flow_check_correction' })).toEqual([
      expect.objectContaining({
        actor: 'ana', workspaceId: 'ws_a', targetType: 'flow_check', targetId: `${acme.id}:${general.id}:dead_ends`,
        reason: 'The walkthrough missed the dead end', beforeJson: { answer: 'pass', origin: 'walkthrough' },
        afterJson: { flowId: acme.id, flowVersion: 1, checklistId: general.id, itemKey: 'dead_ends', answer: 'fail' },
      }),
    ]);
  });

  it('accepting a flow type and a checklist records events', () => {
    const t = flowSetup(opened);
    const { flowType } = proposeFlowType(t.store, 'ws_a', { key: 'export_data', name: 'Export data', definition: 'Get your data out.' });
    const accepted = decideFlowTypeAs(t.store, 'ana', 'ws_a', flowType.id, { action: 'accept' }, 'A real job for our users');
    expect(accepted.status).toBe('active');
    expect(listFeedback(t.store, { kind: 'flow_type_decision' })).toEqual([
      expect.objectContaining({
        targetType: 'flow_type', targetId: flowType.id, reason: 'A real job for our users',
        beforeJson: { status: 'proposed', name: 'Export data', definition: 'Get your data out.' }, afterJson: { action: 'accept', status: 'active' },
      }),
    ]);

    // A new sign-up checklist version: the flow answered on the old one needs a re-walk.
    const acme = t.flow('Acme');
    const old = activeChecklists(t.store, 'ws_a', t.typeId).specific!;
    flowRepos(t.store).flowChecks.insert({
      flowId: acme.id, checklistId: old.id, itemKey: old.items[0]!.key, answer: 'pass', stepRefs: [1], mentionRefs: [], origin: 'walkthrough', updatedAt: T0,
    });
    const draft = proposeChecklist(t.store, 'ws_a', {
      flowTypeId: t.typeId, coverage: 0.6, origin: 'user',
      items: [...old.items, { key: 'passkey_offered', question: 'Is a passkey offered?', kind: 'yes_no', pass: { answer: 'yes' }, weight: 1, scored: true, answeredBy: 'walkthrough' }],
    });
    const out = decideChecklistAs(t.store, 'ana', 'ws_a', draft.id, { action: 'accept', coverage: 0.7 });
    expect(out.checklist).toMatchObject({ id: draft.id, status: 'active', coverage: 0.7 });
    expect(out.needRewalk).toEqual([acme.id]);
    expect(listFeedback(t.store, { kind: 'checklist_decision' })).toEqual([
      expect.objectContaining({
        targetType: 'checklist', targetId: draft.id, beforeJson: expect.objectContaining({ status: 'proposed', coverage: 0.6 }),
        afterJson: { action: 'accept', status: 'active', coverage: 0.7, flowTypeId: t.typeId, needRewalk: [acme.id] },
      }),
    ]);
  });

  it("editing a checklist records one checklist_decision event with before, after and the reason; the score follows the new weights (F4)", () => {
    const t = flowSetup(opened);
    const acme = t.flow('Acme');
    t.check(acme, 'dead_ends', 'pass');
    t.check(acme, 'deceptive_patterns', 'fail');
    const score = () => nodeRanking(t.store, t.config, 'ws_a', t.typeId).ranked[0]!.checklist;
    expect(score()).toBe(50);
    const general = activeChecklists(t.store, 'ws_a', t.typeId).general;
    const removed = general.items.find((i) => i.key !== 'dead_ends' && i.key !== 'deceptive_patterns')!;
    const out = editChecklistAs(t.store, 'ana', 'ws_a', {
      checklistId: general.id,
      coverage: 0.25,
      items: [{ key: 'dead_ends', weight: 3 }, { key: removed.key, remove: true }, { key: 'deceptive_patterns', question: 'Tricks that push you to agree' }],
    }, '  Dead ends matter most to us  ');
    expect(out.checklist).toMatchObject({ origin: 'user', status: 'active', version: 2, coverage: 0.25 });
    expect(score()).toBe(75); // pass weighs 3, fail weighs 1
    const events = listFeedback(t.store, { kind: 'checklist_decision' });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      actor: 'ana', workspaceId: 'ws_a', targetType: 'checklist', targetId: general.id, reason: 'Dead ends matter most to us',
      beforeJson: { checklistId: general.id, version: 1, coverage: 0.3, origin: 'builtin', status: 'active' },
      afterJson: {
        action: 'edit', checklistId: out.checklist.id, version: 2, coverage: 0.25, status: 'active', needRewalk: out.needRewalk,
        changes: {
          removed: [removed.key],
          weights: [{ key: 'dead_ends', before: 1, after: 3 }],
          questions: [{ key: 'deceptive_patterns', before: general.items.find((i) => i.key === 'deceptive_patterns')!.question, after: 'Tricks that push you to agree' }],
        },
      },
    });
    expect((events[0]!.afterJson as Record<string, unknown>).flowTypeId).toBeUndefined();
    // A refused edit records nothing; another tree's checklist answers like an unknown one.
    expect(() => editChecklistAs(t.store, 'ana', 'ws_a', { checklistId: out.checklist.id, items: [{ key: 'new_one', question: 'x' }] })).toThrow(/adding items/);
    t.otherTree();
    const foreign = activeChecklists(t.store, 'ws_b', flowRepos(t.store).flowTypes.list({ rootWorkspaceId: 'ws_b', key: 'sign_up' })[0]!.id).general;
    expect(() => editChecklistAs(t.store, 'ana', 'ws_a', { checklistId: foreign.id, items: [{ key: 'dead_ends', weight: 2 }] })).toThrow(`checklist '${foreign.id}' not found`);
    expect(listFeedback(t.store, { kind: 'checklist_decision' })).toHaveLength(1);
  });

  it('ids of another business tree are refused like unknown ones', () => {
    const t = flowSetup(opened);
    t.otherTree();
    const beta = t.flow('Beta', 'ws_b');
    const initech = t.flow('Initech', 'ws_b');
    expect(() => reactToPosition(t.store, 'ana', 'ws_a', beta.id, beta.flowTypeId, 'agree')).toThrow(`flow '${beta.id}' not found`);
    expect(() => overridePair(t.store, 'ana', 'ws_a', beta.flowTypeId, beta.id, initech.id)).toThrow(/not found/);
    expect(() => decideFlowTypeAs(t.store, 'ana', 'ws_a', beta.flowTypeId, { action: 'accept' })).toThrow(/not found/);
    expect(listFeedback(t.store)).toEqual([]);
  });
});
