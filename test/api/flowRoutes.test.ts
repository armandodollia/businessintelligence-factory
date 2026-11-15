/**
 * Flow routes (flow design §10.4, §10.5, §11, §12.2, §14): the Flows page's reads and the user's
 * actions, each recording a feedback event with the configured actor (`config.user.id`, never the
 * body). Ids of another business tree answer exactly like unknown ones (404). Verdicts are served
 * with `simulated: true`.
 *
 * Fixture: tree A — ws_a "Acme" with personas smb / ops and sign-up flows of Acme, Globex (plus a
 * non-primary "Google" variant) and Initech; tree B — ws_b "Beta" with its own flows, verdict,
 * override, mention and proposals.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/api/routes.js';
import { listFeedback } from '../../src/core/feedback/events.js';
import { activeChecklists, proposeChecklist, proposeFlowType } from '../../src/core/flows/catalog.js';
import { overridePair } from '../../src/core/flows/feedback.js';
import { flowRepos } from '../../src/core/flows/repos.js';
import type { ReviewMention } from '../../src/core/flows/types.js';
import type { Store } from '../../src/core/store/db.js';
import { flowSetup, T0 } from '../core/flows/flowFixture.js';

const opened: Store[] = [];
afterEach(() => {
  for (const s of opened.splice(0)) s.close();
});

function setup() {
  const t = flowSetup(opened, (c) => (c.user = { id: 'ana@acme' }));
  const app = createApp({ store: t.store, artifacts: t.artifacts, events: t.events, config: t.config, research: t.deps });
  const call = async (method: string, path: string, body?: unknown) => {
    const init: RequestInit = { method, headers: { 'content-type': 'application/json' } };
    if (body !== undefined) init.body = JSON.stringify(body);
    const res = await app.request(path, init);
    const text = await res.text();
    return { status: res.status, body: text ? (JSON.parse(text) as any) : undefined };
  };
  const get = (path: string) => call('GET', path);

  const smb = t.persona('smb');
  const ops = t.persona('ops');
  const acme = t.flow('Acme');
  const globex = t.flow('Globex');
  const initech = t.flow('Initech');
  const globexGoogle = t.flow('Globex', 'ws_a', { variant: 'Google', primary: false, name: 'Globex sign-up with Google' });
  t.check(acme, 'dead_ends', 'pass');
  t.check(globex, 'dead_ends', 'fail');
  const v = t.verdict(smb, acme, globex);
  t.verdict(ops, globex, acme);
  const vOffRanking = t.verdict(smb, acme, globexGoogle);
  const mention = (ws: string, subjectEntityId: string, extra: Partial<ReviewMention> = {}): ReviewMention =>
    flowRepos(t.store).reviewMentions.insert({
      id: `rvm_${Math.random().toString(36).slice(2, 10)}`, workspaceId: ws, rootWorkspaceId: ws, subjectEntityId, sourceType: 'app_store',
      artifactId: 'art_reviews', quote: 'Sign-up kept asking for my phone number', quoteHash: Math.random().toString(36), polarity: 'negative',
      flowTypeId: t.typeId, attributionConfidence: 0.9, publishedAt: '2026-10-01T00:00:00.000Z', createdAt: T0, ...extra,
    });
  const m = mention('ws_a', globex.subjectEntityId);

  // Tree B: the same names, its own records.
  const typeB = t.otherTree();
  const persB = t.persona('beta_buyer', 'ws_b');
  const betaOwn = t.flow('Beta', 'ws_b');
  const betaGlobex = t.flow('Globex', 'ws_b');
  const vB = t.verdict(persB, betaOwn, betaGlobex);
  const oB = overridePair(t.store, 'bob', 'ws_b', typeB, betaGlobex.id, betaOwn.id);
  const mB = mention('ws_b', betaGlobex.subjectEntityId, { flowTypeId: typeB });
  const { flowType: proposedB } = proposeFlowType(t.store, 'ws_b', { key: 'secret_flow', name: 'Secret flow', definition: 'Only Beta has it.' });
  const checklistB = proposeChecklist(t.store, 'ws_b', { flowTypeId: typeB, coverage: 0.5, origin: 'user', items: activeChecklists(t.store, 'ws_b', typeB).specific!.items });

  const f = (rest: string) => `/api/workspaces/ws_a/flows${rest}`;
  return {
    ...t, call, get, f, smb, ops, acme, globex, initech, globexGoogle, v, vOffRanking, m,
    b: { typeB, betaOwn, betaGlobex, vB, oB, mB, proposedB, checklistB },
  };
}

const ids = (flows: Array<{ flowId: string }>) => flows.map((x) => x.flowId);

describe('reads', () => {
  it('GET /flows/types lists flow types with status and flow counts, and the proposals waiting on the user', async () => {
    const s = setup();
    const { flowType } = proposeFlowType(s.store, 'ws_a', { key: 'export_data', name: 'Export data', definition: 'Get your data out.' });
    const res = await s.get(s.f('/types'));
    expect(res.status).toBe(200);
    const signUp = res.body.flowTypes.find((x: { id: string }) => x.id === s.typeId);
    expect(signUp).toMatchObject({ key: 'sign_up', status: 'active', flowCount: 3, variantCount: 4 });
    expect(res.body.flowTypes.find((x: { id: string }) => x.id === flowType.id)).toMatchObject({ status: 'proposed', flowCount: 0 });
    expect(res.body.proposals.flowTypes.map((x: { id: string }) => x.id)).toEqual([flowType.id]);
    expect(res.body.proposals.checklists).toEqual([]);
    expect(JSON.stringify(res.body)).not.toContain('Secret flow');
  });

  it('GET /flows/rankings/:flowTypeId answers the node ranking, per persona and with every variant on request', async () => {
    const s = setup();
    const res = await s.get(s.f(`/rankings/${s.typeId}`));
    expect(res.status).toBe(200);
    expect(ids(res.body.ranked)).toEqual([s.acme.id, s.globex.id, s.initech.id]);
    expect(res.body.ranked[0]).toMatchObject({ position: 1, subject: { name: 'Acme' }, wins: 1, comparisons: 2, partial: false, reviews: { total: 0 } });
    expect(res.body.ranked[1]).toMatchObject({ subject: { name: 'Globex' }, reviews: { total: 1, negative: 1 } });
    expect(res.body).toMatchObject({ coverage: expect.any(Number), noPersonas: false, overrides: [] });
    expect(res.body.personas.map((p: { id: string }) => p.id).sort()).toEqual(['per_ops', 'per_smb']);
    const one = await s.get(s.f(`/rankings/${s.typeId}?persona=per_smb`));
    expect(one.body.ranked[0]).toMatchObject({ flowId: s.acme.id, wins: 1, comparisons: 1 });
    const all = await s.get(s.f(`/rankings/${s.typeId}?variants=all`));
    expect(ids(all.body.ranked)).toContain(s.globexGoogle.id);
    expect((await s.get(s.f(`/rankings/${s.typeId}?variants=some`))).status).toBe(400);
    expect((await s.get(s.f(`/rankings/${s.typeId}?persona=per_beta_buyer`))).status).toBe(404);
  });

  it('a subject with no flagged primary still ranks; every read says which variant is primary by the same rule (F2)', async () => {
    const s = setup();
    flowRepos(s.store).flows.update(s.initech.id, { isPrimary: false });
    const res = await s.get(s.f(`/rankings/${s.typeId}`));
    expect(ids(res.body.ranked)).toEqual([s.acme.id, s.globex.id, s.initech.id]);
    expect(res.body.ranked.map((r: { primary: boolean }) => r.primary)).toEqual([true, true, true]);
    const all = await s.get(s.f(`/rankings/${s.typeId}?variants=all`));
    const primaryOf = new Map(all.body.ranked.map((r: { flowId: string; primary: boolean }) => [r.flowId, r.primary]));
    expect(primaryOf.get(s.initech.id)).toBe(true);
    expect(primaryOf.get(s.globexGoogle.id)).toBe(false);
    expect((await s.get(s.f(`/${s.initech.id}`))).body).toMatchObject({ primary: true, flow: { isPrimary: false } });
    expect((await s.get(s.f(`/${s.globexGoogle.id}`))).body.primary).toBe(false);
    const cmp = await s.get(s.f(`/compare?a=${s.initech.id}&b=${s.globexGoogle.id}`));
    expect([cmp.body.a.primary, cmp.body.b.primary]).toEqual([true, false]);
    // The position reaction records the default ranking's position (the flow is in it).
    const r = await s.call('POST', s.f(`/${s.initech.id}/reaction`), { flowTypeId: s.typeId, reaction: 'agree' });
    expect(r.body.afterJson).toMatchObject({ position: 3 });
  });

  it('GET /flows/rankings/:flowTypeId of a proposed type lists its flows unranked (M2)', async () => {
    const s = setup();
    const { flowType } = proposeFlowType(s.store, 'ws_a', { key: 'export_data', name: 'Export data', definition: 'Get your data out.' });
    flowRepos(s.store).flows.update(s.initech.id, { flowTypeId: flowType.id });
    const res = await s.get(s.f(`/rankings/${flowType.id}`));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ isRanked: false, ignoredOverrides: [] });
    expect(res.body.ranked).toEqual([expect.objectContaining({ flowId: s.initech.id, position: 0, comparisons: 0 })]);
    expect(res.body.ranked[0].rankScore).toBeUndefined();
    expect((await s.get(s.f(`/rankings/${s.typeId}`))).body.isRanked).toBe(true);
  });

  it('an ignored ruling is served with its reason: not ranked (a flow outside the list) or a conflict with a newer one (M1)', async () => {
    const s = setup();
    const offList = overridePair(s.store, 'ana@acme', 'ws_a', s.typeId, s.globexGoogle.id, s.acme.id);
    const older = overridePair(s.store, 'ana@acme', 'ws_a', s.typeId, s.initech.id, s.acme.id);
    flowRepos(s.store).flowOverrides.update(older.id, { createdAt: '2000-01-01T00:00:00.000Z' });
    overridePair(s.store, 'ana@acme', 'ws_a', s.typeId, s.acme.id, s.globex.id);
    const newer = overridePair(s.store, 'ana@acme', 'ws_a', s.typeId, s.globex.id, s.initech.id); // acme > globex > initech > acme: the oldest closes the loop
    expect(newer.id).toBeTruthy();
    const res = await s.get(s.f(`/rankings/${s.typeId}`));
    expect(res.body.ignoredOverrides).toEqual(
      expect.arrayContaining([{ id: offList.id, reason: 'not_ranked' }, { id: older.id, reason: 'conflict' }]),
    );
    expect(res.body.ignoredOverrides).toHaveLength(2);
    // With every variant shown, the Google variant is in the list: that ruling applies.
    const all = await s.get(s.f(`/rankings/${s.typeId}?variants=all`));
    expect(all.body.ignoredOverrides.map((x: { id: string }) => x.id)).not.toContain(offList.id);
  });

  it('GET /flows/:flowId answers the flow, its steps, checks, mentions, verdicts (simulated, counted or not), overrides and upload flag', async () => {
    const s = setup();
    const o = overridePair(s.store, 'ana@acme', 'ws_a', s.typeId, s.initech.id, s.globex.id, 'Initech is quicker');
    const res = await s.get(s.f(`/${s.acme.id}`));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ flow: { id: s.acme.id }, subject: { name: 'Acme' }, partial: false, upload: false, current: true, checklist: 100 });
    expect(res.body.steps.map((x: { seq: number; action: string }) => [x.seq, x.action])).toEqual([[1, 'Open the sign-up page'], [2, 'Submit the form']]);
    expect(res.body.checks).toEqual([expect.objectContaining({ itemKey: 'dead_ends', answer: 'pass', question: expect.any(String), scored: true })]);
    expect(res.body.verdicts).toHaveLength(3);
    for (const verdict of res.body.verdicts) expect(verdict.simulated).toBe(true);
    const byId = new Map(res.body.verdicts.map((x: { id: string }) => [x.id, x]));
    expect(byId.get(s.v.id)).toMatchObject({ counted: true, persona: { slug: 'smb' }, opponent: { id: s.globex.id, subject: { name: 'Globex' } } });
    // The verdict against a non-primary variant is not part of the node's ranking, so not of the score.
    expect(byId.get(s.vOffRanking.id)).toMatchObject({ counted: false, opponent: { id: s.globexGoogle.id } });
    expect(res.body.overrides).toEqual([]);

    const g = await s.get(s.f(`/${s.globex.id}`));
    expect(g.body.mentions).toEqual([expect.objectContaining({ id: s.m.id, quote: 'Sign-up kept asking for my phone number', counted: true })]);
    expect(g.body.overrides.map((x: { id: string }) => x.id)).toEqual([o.id]);
    // each ruling carries the names of its two flows (subject — variant)
    expect(g.body.overrides[0]).toMatchObject({ winnerName: 'Initech — Email', loserName: 'Globex — Email' });
  });

  it('GET /flows/compare answers both flows step by step, the live verdicts on the pair and the rulings on it', async () => {
    const s = setup();
    const o = overridePair(s.store, 'ana@acme', 'ws_a', s.typeId, s.globex.id, s.acme.id);
    overridePair(s.store, 'ana@acme', 'ws_a', s.typeId, s.initech.id, s.acme.id); // another pair: not listed
    const res = await s.get(s.f(`/compare?a=${s.acme.id}&b=${s.globex.id}`));
    expect(res.status).toBe(200);
    expect(res.body.a).toMatchObject({ flow: { id: s.acme.id }, subject: { name: 'Acme' } });
    expect(res.body.b.steps).toHaveLength(2);
    expect(res.body.verdicts.map((x: { personaId: string; simulated: boolean }) => [x.personaId, x.simulated]).sort()).toEqual([
      ['per_ops', true], ['per_smb', true],
    ]);
    expect(res.body.overrides.map((x: { id: string }) => x.id)).toEqual([o.id]);
    expect(res.body.overrides[0]).toMatchObject({ winnerName: 'Globex — Email', loserName: 'Acme — Email' });
    expect((await s.get(s.f('/compare?a=' + s.acme.id))).status).toBe(400);
    const { flowType } = proposeFlowType(s.store, 'ws_a', { key: 'checkout', name: 'Checkout', definition: 'Pay.' });
    const other = flowRepos(s.store).flows.update(s.initech.id, { flowTypeId: flowType.id });
    expect((await s.get(s.f(`/compare?a=${s.acme.id}&b=${other.id}`))).status).toBe(400);
  });
});

describe('actions record a feedback event with the configured actor', () => {
  it('POST /flows/:flowId/reaction', async () => {
    const s = setup();
    const res = await s.call('POST', `/api/workspaces/ws_a/flows/${s.globex.id}/reaction`, { flowTypeId: s.typeId, reaction: 'disagree', reason: 'Globex is fine', actor: 'mallory' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      actor: 'ana@acme', kind: 'flow_rank_reaction', targetType: 'flow', targetId: s.globex.id, reason: 'Globex is fine',
      afterJson: { reaction: 'disagree', position: 2 },
    });
    expect((await s.call('POST', `/api/workspaces/ws_a/flows/${s.globex.id}/reaction`, { flowTypeId: s.typeId, reaction: 'maybe' })).status).toBe(400);
  });

  it('POST /flows/verdicts/:verdictId/reaction', async () => {
    const s = setup();
    const res = await s.call('POST', `/api/workspaces/ws_a/flows/verdicts/${s.v.id}/reaction`, { reaction: 'agree' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      actor: 'ana@acme', kind: 'flow_verdict_reaction', targetId: s.v.id,
      afterJson: { reaction: 'agree', personaId: 'per_smb', personaVersion: 1, stage: 'broad', flowAVersion: 1, flowBVersion: 1 },
    });
    expect(res.body.reason).toBeUndefined();
  });

  it('POST /flows/overrides, DELETE /flows/overrides/:overrideId and POST /flows/overrides/:overrideId/confirm', async () => {
    const s = setup();
    const created = await s.call('POST', `/api/workspaces/ws_a/flows/overrides`, {
      flowTypeId: s.typeId, winnerFlowId: s.globex.id, loserFlowId: s.acme.id, reason: 'We use both daily',
    });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ actor: 'ana@acme', winnerFlowId: s.globex.id, loserFlowId: s.acme.id, reason: 'We use both daily', needsConfirm: false });
    let ranking = (await s.get(s.f(`/rankings/${s.typeId}`))).body;
    expect(ids(ranking.ranked).slice(0, 2)).toEqual([s.globex.id, s.acme.id]);
    expect(ranking.ranked[0].overriddenBy).toEqual([created.body.id]);

    // A new version: the reading marks the ruling, which still applies; the user keeps it.
    const globex2 = s.newVersion(s.globex);
    ranking = (await s.get(s.f(`/rankings/${s.typeId}`))).body;
    // the ruling still names the earlier version it was made on, with the flow names served
    expect(ranking.overrides).toEqual([
      expect.objectContaining({ id: created.body.id, needsConfirm: true, winnerFlowId: s.globex.id, winnerName: 'Globex — Email', loserName: 'Acme — Email' }),
    ]);
    expect(ids(ranking.ranked).indexOf(globex2.id)).toBeLessThan(ids(ranking.ranked).indexOf(s.acme.id));
    const kept = await s.call('POST', `/api/workspaces/ws_a/flows/overrides/${created.body.id}/confirm`, { keep: true });
    expect(kept.status).toBe(200);
    expect(kept.body).toMatchObject({ needsConfirm: false, winnerFlowId: globex2.id });
    expect((await s.call('POST', `/api/workspaces/ws_a/flows/overrides/${created.body.id}/confirm`, { keep: true })).status).toBe(409);

    const del = await s.call('DELETE', `/api/workspaces/ws_a/flows/overrides/${created.body.id}`);
    expect(del.status).toBe(200);
    expect(del.body.revokedAt).toBeDefined();
    expect((await s.call('DELETE', `/api/workspaces/ws_a/flows/overrides/${created.body.id}`, { reason: 'again' })).status).toBe(409);
    expect(listFeedback(s.store, { workspaceId: 'ws_a', kind: 'flow_override' }).map((e) => [e.actor, (e.afterJson as { action: string }).action])).toEqual([
      ['ana@acme', 'create'], ['ana@acme', 'keep'], ['ana@acme', 'revoke'],
    ]);
  });

  it('POST /flows/:flowId/checks', async () => {
    const s = setup();
    const general = activeChecklists(s.store, 'ws_a', s.typeId).general;
    const res = await s.call('POST', `/api/workspaces/ws_a/flows/${s.acme.id}/checks`, { checklistId: general.id, itemKey: 'dead_ends', answer: 'fail', reason: 'Step 2 is a dead end' });
    expect(res.status).toBe(200);
    expect(res.body.check).toMatchObject({ answer: 'fail', origin: 'user' });
    expect((await s.get(s.f(`/${s.acme.id}`))).body.checklist).toBe(0);
    expect(listFeedback(s.store, { kind: 'flow_check_correction' })[0]).toMatchObject({ actor: 'ana@acme', reason: 'Step 2 is a dead end' });
    expect((await s.call('POST', `/api/workspaces/ws_a/flows/${s.acme.id}/checks`, { checklistId: general.id, itemKey: 'nope', answer: 'fail' })).status).toBe(400);
  });

  it('POST /flows/types/:typeId/decision (a reject of a type with flows answers 409: merge instead)', async () => {
    const s = setup();
    const { flowType } = proposeFlowType(s.store, 'ws_a', { key: 'export_data', name: 'Export data', definition: 'Get your data out.' });
    const edited = await s.call('POST', `/api/workspaces/ws_a/flows/types/${flowType.id}/decision`, { action: 'edit', name: 'Export your data', reason: 'clearer' });
    expect(edited.status).toBe(200);
    expect(edited.body).toMatchObject({ name: 'Export your data', status: 'proposed' });
    flowRepos(s.store).flows.update(s.initech.id, { flowTypeId: flowType.id });
    const refused = await s.call('POST', `/api/workspaces/ws_a/flows/types/${flowType.id}/decision`, { action: 'reject' });
    expect(refused.status).toBe(409);
    expect(refused.body.error).toMatch(/has 1 flow\(s\); merge it into another type instead/);
    const merged = await s.call('POST', `/api/workspaces/ws_a/flows/types/${flowType.id}/decision`, { action: 'merge', intoId: s.typeId });
    expect(merged.body).toMatchObject({ status: 'merged', mergedIntoId: s.typeId });
    expect(listFeedback(s.store, { kind: 'flow_type_decision' }).map((e) => [e.actor, (e.afterJson as { action: string }).action, e.reason])).toEqual([
      ['ana@acme', 'edit', 'clearer'], ['ana@acme', 'merge', undefined],
    ]);
  });

  it('POST /flows/checklists/:checklistId/decision', async () => {
    const s = setup();
    const old = activeChecklists(s.store, 'ws_a', s.typeId).specific!;
    flowRepos(s.store).flowChecks.insert({ flowId: s.acme.id, checklistId: old.id, itemKey: old.items[0]!.key, answer: 'pass', stepRefs: [1], mentionRefs: [], origin: 'walkthrough', updatedAt: T0 });
    const draft = proposeChecklist(s.store, 'ws_a', { flowTypeId: s.typeId, coverage: 0.5, origin: 'agent', items: old.items });
    expect((await s.get(s.f('/types'))).body.proposals.checklists.map((c: { id: string }) => c.id)).toEqual([draft.id]);
    const res = await s.call('POST', `/api/workspaces/ws_a/flows/checklists/${draft.id}/decision`, { action: 'accept', coverage: 0.8, reason: 'Matches our standards' });
    expect(res.status).toBe(200);
    expect(res.body.checklist).toMatchObject({ id: draft.id, status: 'active', coverage: 0.8 });
    expect(res.body.needRewalk).toEqual([s.acme.id]);
    expect(listFeedback(s.store, { kind: 'checklist_decision' })[0]).toMatchObject({ actor: 'ana@acme', targetId: draft.id, reason: 'Matches our standards' });
    expect((await s.call('POST', `/api/workspaces/ws_a/flows/checklists/${draft.id}/decision`, { action: 'reject' })).status).toBe(409);
  });

  it('GET /flows/checklists answers the active checklists; POST /flows/checklists/:checklistId/edit saves a new version (F4)', async () => {
    const s = setup();
    const res = await s.get(s.f(`/checklists?flowTypeId=${s.typeId}`));
    expect(res.status).toBe(200);
    const { general, specific } = activeChecklists(s.store, 'ws_a', s.typeId);
    expect(res.body.general).toMatchObject({ id: general.id, version: 1, origin: 'builtin', coverage: 0.3, status: 'active' });
    expect(res.body.general.items).toHaveLength(general.items.length);
    expect(res.body.specific).toMatchObject({ id: specific!.id, flowTypeId: s.typeId, coverage: 0.6 });
    expect(res.body.specific.items[0]).toMatchObject({ key: specific!.items[0]!.key, question: expect.any(String), scored: expect.any(Boolean), weight: 1 });
    // Without a flow type: the general checklist only.
    const plain = await s.get(s.f('/checklists'));
    expect(plain.body.general.id).toBe(general.id);
    expect(plain.body.specific).toBeUndefined();

    const key = specific!.items[0]!.key;
    const edited = await s.call('POST', `/api/workspaces/ws_a/flows/checklists/${specific!.id}/edit`, {
      coverage: 0.7, items: [{ key, weight: 2, question: 'Short enough?' }], reason: 'This matters more', actor: 'mallory',
    });
    expect(edited.status).toBe(200);
    expect(edited.body.checklist).toMatchObject({ version: 2, origin: 'user', status: 'active', coverage: 0.7 });
    expect(edited.body.checklist.items[0]).toMatchObject({ key, weight: 2, question: 'Short enough?' });
    expect(edited.body.needRewalk).toEqual(expect.any(Array));
    expect(listFeedback(s.store, { kind: 'checklist_decision' })[0]).toMatchObject({ actor: 'ana@acme', reason: 'This matters more', afterJson: { action: 'edit' } });
    expect((await s.get(s.f(`/checklists?flowTypeId=${s.typeId}`))).body.specific.id).toBe(edited.body.checklist.id);

    // Refused: the old version, a new item, a kind change, a bad weight.
    expect((await s.call('POST', s.f(`/checklists/${specific!.id}/edit`), { items: [{ key, weight: 3 }] })).status).toBe(409);
    const now = edited.body.checklist.id;
    expect((await s.call('POST', s.f(`/checklists/${now}/edit`), { items: [{ key: 'brand_new', question: 'New?' }] })).status).toBe(400);
    expect((await s.call('POST', s.f(`/checklists/${now}/edit`), { items: [{ key, kind: 'count' }] })).status).toBe(400);
    expect((await s.call('POST', s.f(`/checklists/${now}/edit`), { items: [{ key, weight: -1 }] })).status).toBe(400);
    expect((await s.call('POST', s.f(`/checklists/${now}/edit`), { items: [] })).status).toBe(400);
    expect(listFeedback(s.store, { kind: 'checklist_decision' })).toHaveLength(1);
  });

  it('POST /flows/mentions/:mentionId/attribution', async () => {
    const s = setup();
    const res = await s.call('POST', `/api/workspaces/ws_a/flows/mentions/${s.m.id}/attribution`, { flowTypeKey: 'sign_up', checkKey: 'dead_ends', reason: 'It is about a dead end' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: s.m.id, flowTypeId: s.typeId, checkKey: 'dead_ends', attributionConfidence: 1 });
    expect(listFeedback(s.store, { kind: 'review_attribution_correction' })[0]).toMatchObject({
      actor: 'ana@acme', targetType: 'review_mention', targetId: s.m.id, beforeJson: { flowTypeId: s.typeId, checkKey: null, confidence: 0.9 },
      afterJson: { flowTypeId: s.typeId, checkKey: 'dead_ends', confidence: 1 },
    });
    const off = await s.call('POST', `/api/workspaces/ws_a/flows/mentions/${s.m.id}/attribution`, {});
    expect(off.body).toMatchObject({ attributionConfidence: 0 });
    expect(off.body.flowTypeId).toBeUndefined();
    expect((await s.call('POST', `/api/workspaces/ws_a/flows/mentions/${s.m.id}/attribution`, { checkKey: 'dead_ends' })).status).toBe(400);
  });
});

describe('isolation and validation', () => {
  it("another tree's ids answer 404", async () => {
    const s = setup();
    const { b } = s;
    const general = activeChecklists(s.store, 'ws_b', b.typeB).general;
    const answers = [
      await s.get(s.f(`/rankings/${b.typeB}`)),
      await s.get(s.f(`/${b.betaOwn.id}`)),
      await s.get(s.f(`/compare?a=${s.acme.id}&b=${b.betaGlobex.id}`)),
      await s.call('POST', s.f(`/${b.betaOwn.id}/reaction`), { flowTypeId: b.typeB, reaction: 'agree' }),
      await s.call('POST', s.f(`/verdicts/${b.vB.id}/reaction`), { reaction: 'disagree' }),
      await s.call('POST', s.f('/overrides'), { flowTypeId: b.typeB, winnerFlowId: b.betaOwn.id, loserFlowId: b.betaGlobex.id }),
      await s.call('POST', s.f('/overrides'), { flowTypeId: s.typeId, winnerFlowId: s.acme.id, loserFlowId: b.betaGlobex.id }),
      await s.call('DELETE', s.f(`/overrides/${b.oB.id}`), {}),
      await s.call('POST', s.f(`/overrides/${b.oB.id}/confirm`), { keep: false }),
      await s.call('POST', s.f(`/${b.betaOwn.id}/checks`), { checklistId: general.id, itemKey: 'dead_ends', answer: 'fail' }),
      await s.call('POST', s.f(`/types/${b.proposedB.id}/decision`), { action: 'accept' }),
      await s.call('POST', s.f(`/checklists/${b.checklistB.id}/decision`), { action: 'accept' }),
      await s.get(s.f(`/checklists?flowTypeId=${b.typeB}`)),
      await s.call('POST', s.f(`/checklists/${activeChecklists(s.store, 'ws_b', b.typeB).general.id}/edit`), { items: [{ key: 'dead_ends', weight: 2 }] }),
      await s.call('POST', s.f(`/mentions/${b.mB.id}/attribution`), { flowTypeKey: 'sign_up' }),
      await s.get(`/api/workspaces/ws_missing/flows/types`),
    ];
    for (const res of answers) {
      expect(res.status).toBe(404);
      // Nothing about tree B: no name, no other id than the one asked about.
      expect(JSON.stringify(res.body)).not.toMatch(/Beta|ws_b|Secret|beta_buyer/);
    }
    expect(listFeedback(s.store, { workspaceId: 'ws_a' })).toEqual([]);
    expect(flowRepos(s.store).flowOverrides.get(b.oB.id)!.revokedAt).toBeUndefined();
    expect(flowRepos(s.store).flowTypes.get(b.proposedB.id)!.status).toBe('proposed');
    // The unknown-id answer is the same as for another tree's id.
    const unknown = await s.get(s.f('/flw_UNKNOWN'));
    expect(unknown).toEqual({ status: 404, body: { error: "flow 'flw_UNKNOWN' not found" } });
  });

  it('a reason longer than 2,000 characters is refused', async () => {
    const s = setup();
    const long = 'x'.repeat(2001);
    const answers = [
      await s.call('POST', s.f(`/${s.acme.id}/reaction`), { flowTypeId: s.typeId, reaction: 'agree', reason: long }),
      await s.call('POST', s.f(`/verdicts/${s.v.id}/reaction`), { reaction: 'disagree', reason: long }),
      await s.call('POST', s.f('/overrides'), { flowTypeId: s.typeId, winnerFlowId: s.globex.id, loserFlowId: s.acme.id, reason: long }),
    ];
    for (const res of answers) {
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/2,000 characters/);
    }
    expect(listFeedback(s.store)).toEqual(listFeedback(s.store, { workspaceId: 'ws_b' }));
    // Exactly 2,000 is accepted.
    expect((await s.call('POST', s.f(`/verdicts/${s.v.id}/reaction`), { reaction: 'disagree', reason: 'y'.repeat(2000) })).status).toBe(200);
  });
});
