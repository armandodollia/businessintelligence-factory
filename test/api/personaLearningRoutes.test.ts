/**
 * Persona learning routes (design 2026-11-15-persona-learning-design.md §13): the node's persona
 * learning block (gate, active adjustments with their effect, proposals, last run), a persona's
 * signals, and the user's accept / reject / retire. The actor is the configured one, never the body;
 * ids of another business tree answer 404. Each action records its feedback event
 * (`persona_learning_accept`, `persona_learning_reject`, `persona_adjustment_retire`).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/api/routes.js';
import type { BifConfig } from '../../src/core/config/schema.js';
import { listFeedback } from '../../src/core/feedback/events.js';
import { reactToVerdict } from '../../src/core/flows/feedback.js';
import { writeAgentMd } from '../../src/core/market/personas.js';
import { personaLearningRepos } from '../../src/core/personas/store.js';
import type { PersonaProposal } from '../../src/core/personas/types.js';
import type { Store } from '../../src/core/store/db.js';
import { newId } from '../../src/core/store/repos.js';
import type { Persona } from '../../src/core/types.js';
import { flowSetup, T0 } from '../core/flows/flowFixture.js';

const opened: Store[] = [];
afterEach(() => {
  for (const s of opened.splice(0)) s.close();
});

const STATS = { n: 6, agree: 1, disagree: 5, items: 6, lower: 0.44 };

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
  const smb = t.persona('smb');
  const ops = t.persona('ops');
  writeAgentMd(t.store, smb);
  const flows = ['Acme', 'Globex', 'Initech', 'Hooli'].map((n) => t.flow(n));
  const pairs: Array<[number, number]> = [[0, 1], [0, 2], [0, 3], [1, 2], [1, 3], [2, 3]];
  // smb: 5 disagreements and 1 agreement on 6 different pairs (qualifies with the defaults).
  pairs.forEach(([a, b], i) => {
    const v = t.verdict(smb, flows[a]!, flows[b]!);
    reactToVerdict(t.store, 'ana@acme', v.id, i === 0 ? 'agree' : 'disagree', i === 1 ? 'they never read the fine print' : undefined);
  });
  // ops: 2 disagreements on 2 pairs (watching).
  for (const [a, b] of pairs.slice(0, 2)) reactToVerdict(t.store, 'ana@acme', t.verdict(ops, flows[a]!, flows[b]!).id, 'disagree');

  const repos = personaLearningRepos(t.store);
  const proposal = (persona: Persona, extra: Partial<PersonaProposal> = {}): PersonaProposal =>
    repos.proposals.insert({
      id: newId('ppr'), rootWorkspaceId: persona.workspaceId, workspaceId: persona.workspaceId, personaId: persona.id, action: 'add',
      field: 'buying_behavior', text: 'You compare on total yearly cost, not the monthly price.', rationale: 'r', evidence: ['fbk_1'],
      stats: STATS, source: 'retro', status: 'pending', createdAt: T0, ...extra,
    });
  return { ...t, call, smb, ops, repos, proposal };
}

describe('GET /persona-learning', () => {
  it('enabled is true only when persona learning would run: persona learning, lessons and the retro all enabled', async () => {
    for (const [off, expected] of [
      [() => undefined, true],
      [(c: BifConfig) => (c.lessons = { enabled: false }), false],
      [(c: BifConfig) => (c.lessons = { retro: { enabled: false } }), false],
      [(c: BifConfig) => (c.personaLearning = { enabled: false }), false],
    ] as const) {
      const s = setup();
      off(s.config);
      const r = await s.call('GET', `/api/workspaces/ws_a/persona-learning`);
      expect(r.body.enabled).toBe(expected);
    }
  });

  it('serves each persona of the node with its gate, adjustments and effect, proposals (pending first) and last run', async () => {
    const s = setup();
    const decided = s.proposal(s.smb, { status: 'rejected', decidedAt: '2026-11-14T11:00:00.000Z', createdAt: '2026-11-13T00:00:00.000Z' });
    const pending = s.proposal(s.smb, { createdAt: '2026-11-12T00:00:00.000Z' });
    const adjustment = s.repos.adjustments.insert({
      id: 'pad_1', rootWorkspaceId: 'ws_a', workspaceId: 'ws_a', personaId: s.smb.id, marker: 'A-ABCDEF', text: 'You distrust card-first flows.', version: 2,
      status: 'active', source: 'retro', actor: 'ana@acme', stats: { n: 8, disagree: 5 }, internal: false, createdAt: '2026-01-01T00:00:00.000Z',
      changedAt: '2026-01-01T00:00:00.000Z',
    });
    s.repos.adjustments.insert({ ...adjustment, id: 'pad_2', marker: 'A-000000', status: 'retired', endedAt: '2026-01-02T00:00:00.000Z' });
    s.repos.runs.insert({
      id: 'plr_old', rootWorkspaceId: 'ws_a', personaId: s.smb.id, status: 'failed', signalsThrough: '2026-01-01T00:00:00.000Z', shownSignalIds: [],
      stats: STATS, createdAt: '2026-01-01T00:00:00.000Z',
    });
    s.repos.runs.insert({
      id: 'plr_new', rootWorkspaceId: 'ws_a', personaId: s.smb.id, status: 'running', signalsThrough: '2026-01-01T00:00:00.000Z', shownSignalIds: ['x'],
      stats: STATS, assumption: 'Overrates short sign-up forms.', createdAt: '2026-11-10T00:00:00.000Z',
    });

    const r = await s.call('GET', `/api/workspaces/ws_a/persona-learning`);
    expect(r.status).toBe(200);
    expect(r.body.enabled).toBe(true);
    expect(r.body.personas.map((p: any) => p.personaId).sort()).toEqual([s.ops.id, s.smb.id]);
    const smb = r.body.personas.find((p: any) => p.personaId === s.smb.id);
    expect(smb).toMatchObject({ segment: 'smb segment', version: 1 });
    expect(smb.gate).toMatchObject({ n: 6, agree: 1, disagree: 5, items: 6, qualifies: true, missing: [] });
    expect(smb.adjustments).toHaveLength(1);
    expect(smb.adjustments[0]).toMatchObject({ id: 'pad_1', marker: 'A-ABCDEF', effect: { before: { n: 8, disagree: 5 }, since: { n: 6, disagree: 5 } } });
    expect(smb.proposals.map((p: PersonaProposal) => p.id)).toEqual([pending.id, decided.id]);
    expect(smb.lastRun).toEqual({ id: 'plr_new', status: 'running', assumption: 'Overrates short sign-up forms.', createdAt: '2026-11-10T00:00:00.000Z', stats: STATS });
    expect(smb.lastRun.shownSignalIds).toBeUndefined();

    const ops = r.body.personas.find((p: any) => p.personaId === s.ops.id);
    expect(ops.gate).toMatchObject({ n: 2, qualifies: false, missing: ['2 of 6 reactions', '2 of 4 different things'] });
    expect(ops.adjustments).toEqual([]);
    expect(ops.proposals).toEqual([]);
    expect(ops.lastRun).toBeUndefined();
  });

  it('lists at most 20 proposals, decided ones newest first', async () => {
    const s = setup();
    for (let i = 0; i < 25; i++) {
      s.proposal(s.smb, { status: 'rejected', decidedAt: `2026-11-${String(i + 1).padStart(2, '0')}T00:00:00.000Z` });
    }
    const r = await s.call('GET', `/api/workspaces/ws_a/persona-learning`);
    const list = r.body.personas.find((p: any) => p.personaId === s.smb.id).proposals as PersonaProposal[];
    expect(list).toHaveLength(20);
    expect(list[0]!.decidedAt).toBe('2026-11-25T00:00:00.000Z');
    expect(list[19]!.decidedAt).toBe('2026-11-06T00:00:00.000Z');
  });

  it('lastRun is the newest run with an assumption (a later failed run does not hide it); else the newest run', async () => {
    const s = setup();
    const run = (id: string, createdAt: string, extra: Record<string, unknown> = {}) =>
      s.repos.runs.insert({ id, rootWorkspaceId: 'ws_a', personaId: s.smb.id, status: 'failed', signalsThrough: createdAt, shownSignalIds: [], stats: STATS, createdAt, ...extra });
    run('plr_1', '2026-11-01T00:00:00.000Z');
    run('plr_2', '2026-11-02T00:00:00.000Z');
    const lastOf = async () => (await s.call('GET', '/api/workspaces/ws_a/persona-learning')).body.personas.find((p: any) => p.personaId === s.smb.id).lastRun;
    expect((await lastOf()).id).toBe('plr_2');
    run('plr_3', '2026-11-03T00:00:00.000Z', { status: 'proposed', assumption: 'Overrates short forms.' });
    run('plr_4', '2026-11-04T00:00:00.000Z', { failureReason: 'timeout' });
    expect(await lastOf()).toMatchObject({ id: 'plr_3', status: 'proposed', assumption: 'Overrates short forms.' });
  });

  it('pendingInTree counts the pending proposals of the whole business tree, not one node', async () => {
    const s = setup();
    s.store.workspaces.insert({ id: 'ws_a_eu', name: 'Acme EU', sector: 'saas', parentWorkspaceId: 'ws_a', createdAt: T0 });
    const eu = s.persona('eu_buyer', 'ws_a_eu');
    s.proposal(s.smb);
    s.proposal(s.smb, { status: 'rejected' });
    s.proposal(eu, { rootWorkspaceId: 'ws_a' });
    s.otherTree();
    s.proposal(s.persona('beta_buyer', 'ws_b'));
    expect((await s.call('GET', '/api/workspaces/ws_a/persona-learning')).body.pendingInTree).toBe(2);
    expect((await s.call('GET', '/api/workspaces/ws_a_eu/persona-learning')).body.pendingInTree).toBe(2);
    expect((await s.call('GET', '/api/workspaces/ws_b/persona-learning')).body.pendingInTree).toBe(1);
  });

  it('serves personas of the requested node only; an unknown node answers 404', async () => {
    const s = setup();
    s.otherTree();
    s.persona('beta_buyer', 'ws_b');
    const r = await s.call('GET', '/api/workspaces/ws_b/persona-learning');
    expect(r.body.personas.map((p: any) => p.personaId)).toEqual(['per_beta_buyer']);
    expect((await s.call('GET', '/api/workspaces/ws_zzz/persona-learning')).status).toBe(404);
  });
});

describe('GET /personas/:personaId/signals', () => {
  it('serves every signal of the persona, both polarities, newest first', async () => {
    const s = setup();
    const r = await s.call('GET', `/api/workspaces/ws_a/personas/${s.smb.id}/signals`);
    expect(r.status).toBe(200);
    const signals = r.body.signals as Array<{ polarity: string; at: string; reason?: string }>;
    expect(signals).toHaveLength(6);
    expect(signals.filter((x) => x.polarity === 'agree')).toHaveLength(1);
    expect(signals.some((x) => x.reason === 'they never read the fine print')).toBe(true);
    expect([...signals].sort((a, b) => b.at.localeCompare(a.at)).map((x) => x.at)).toEqual(signals.map((x) => x.at));
  });

  it('a persona of another tree, or unknown, answers 404', async () => {
    const s = setup();
    s.otherTree();
    const beta = s.persona('beta_buyer', 'ws_b');
    expect(await s.call('GET', `/api/workspaces/ws_a/personas/${beta.id}/signals`)).toMatchObject({ status: 404, body: { error: expect.any(String) } });
    expect((await s.call('GET', `/api/workspaces/ws_a/personas/per_nope/signals`)).status).toBe(404);
  });
});

describe('decisions', () => {
  it('accept: an active adjustment, the configured actor (not the body), a persona_learning_accept event', async () => {
    const s = setup();
    const p = s.proposal(s.smb);
    const r = await s.call('POST', `/api/workspaces/ws_a/persona-proposals/${p.id}/accept`, { reason: 'yes, yearly bills', actor: 'mallory' });
    expect(r.status).toBe(200);
    expect(r.body.proposal).toMatchObject({ id: p.id, status: 'accepted', actor: 'ana@acme', reason: 'yes, yearly bills' });
    expect(r.body.adjustment).toMatchObject({ status: 'active', text: p.text, actor: 'ana@acme' });
    expect(r.body.persona.version).toBe(2);
    const events = listFeedback(s.store, { workspaceId: 'ws_a', kind: 'persona_learning_accept' });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ actor: 'ana@acme', targetType: 'persona_proposal', targetId: p.id, reason: 'yes, yearly bills' });
  });

  it('edit-accept stores the edited text', async () => {
    const s = setup();
    const p = s.proposal(s.smb);
    const r = await s.call('POST', `/api/workspaces/ws_a/persona-proposals/${p.id}/accept`, { text: 'You look at the yearly total.' });
    expect(r.status).toBe(200);
    expect(r.body.adjustment.text).toBe('You look at the yearly total.');
    expect(r.body.proposal.finalText).toBe('You look at the yearly total.');
  });

  it('an accept text longer than 400 characters answers 400 and changes nothing', async () => {
    const s = setup();
    const p = s.proposal(s.smb);
    const r = await s.call('POST', `/api/workspaces/ws_a/persona-proposals/${p.id}/accept`, { text: 'x'.repeat(401) });
    expect(r).toMatchObject({ status: 400, body: { error: expect.stringMatching(/400/) } });
    expect(s.repos.proposals.get(p.id)!.status).toBe('pending');
    expect((await s.call('POST', `/api/workspaces/ws_a/persona-proposals/${p.id}/accept`, { text: 'y'.repeat(400) })).body.adjustment.text).toBe('y'.repeat(400));
  });

  it('accept with no body works; a second accept answers 409', async () => {
    const s = setup();
    const p = s.proposal(s.smb);
    expect((await s.call('POST', `/api/workspaces/ws_a/persona-proposals/${p.id}/accept`)).status).toBe(200);
    expect(await s.call('POST', `/api/workspaces/ws_a/persona-proposals/${p.id}/accept`, {})).toMatchObject({ status: 409, body: { error: expect.stringMatching(/accepted/) } });
  });

  it('accept honours the configured maxAdjustments', async () => {
    const s = setup();
    s.config.personaLearning = { maxAdjustments: 1 };
    expect((await s.call('POST', `/api/workspaces/ws_a/persona-proposals/${s.proposal(s.smb).id}/accept`, {})).status).toBe(200);
    const r = await s.call('POST', `/api/workspaces/ws_a/persona-proposals/${s.proposal(s.smb).id}/accept`, {});
    expect(r).toMatchObject({ status: 409, body: { error: expect.stringMatching(/max 1/) } });
  });

  it('reject: the proposal is rejected, a persona_learning_reject event with the configured actor', async () => {
    const s = setup();
    const p = s.proposal(s.smb);
    const r = await s.call('POST', `/api/workspaces/ws_a/persona-proposals/${p.id}/reject`, { reason: 'not my audience', actor: 'mallory' });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ id: p.id, status: 'rejected', actor: 'ana@acme', reason: 'not my audience' });
    const events = listFeedback(s.store, { workspaceId: 'ws_a', kind: 'persona_learning_reject' });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ actor: 'ana@acme', targetId: p.id, reason: 'not my audience' });
  });

  it('retire: the adjustment ends, a persona_adjustment_retire event with the configured actor', async () => {
    const s = setup();
    const accepted = await s.call('POST', `/api/workspaces/ws_a/persona-proposals/${s.proposal(s.smb).id}/accept`, {});
    const id = accepted.body.adjustment.id as string;
    const r = await s.call('POST', `/api/workspaces/ws_a/persona-adjustments/${id}/retire`, { reason: 'no longer true', actor: 'mallory' });
    expect(r.status).toBe(200);
    expect(r.body.adjustment).toMatchObject({ id, status: 'retired', actor: 'ana@acme' });
    expect(r.body.persona.version).toBe(3);
    const events = listFeedback(s.store, { workspaceId: 'ws_a', kind: 'persona_adjustment_retire' });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ actor: 'ana@acme', targetType: 'persona_adjustment', targetId: id, reason: 'no longer true' });
    expect((await s.call('POST', `/api/workspaces/ws_a/persona-adjustments/${id}/retire`, {})).status).toBe(409);
  });

  it('a proposal or adjustment of another tree answers 404 and changes nothing', async () => {
    const s = setup();
    s.otherTree();
    const beta = s.persona('beta_buyer', 'ws_b');
    writeAgentMd(s.store, beta);
    const pB = s.proposal(beta);
    expect(await s.call('POST', `/api/workspaces/ws_a/persona-proposals/${pB.id}/accept`, {})).toMatchObject({ status: 404, body: { error: expect.any(String) } });
    expect((await s.call('POST', `/api/workspaces/ws_a/persona-proposals/${pB.id}/reject`, {})).status).toBe(404);
    expect(s.repos.proposals.get(pB.id)!.status).toBe('pending');
    const accepted = await s.call('POST', `/api/workspaces/ws_b/persona-proposals/${s.proposal(beta).id}/accept`, {});
    expect((await s.call('POST', `/api/workspaces/ws_a/persona-adjustments/${accepted.body.adjustment.id}/retire`, {})).status).toBe(404);
    expect((await s.call('POST', `/api/workspaces/ws_a/persona-proposals/ppr_nope/accept`, {})).status).toBe(404);
  });

  it('a bad body answers 400', async () => {
    const s = setup();
    const p = s.proposal(s.smb);
    expect((await s.call('POST', `/api/workspaces/ws_a/persona-proposals/${p.id}/accept`, { text: 7 })).status).toBe(400);
    expect((await s.call('POST', `/api/workspaces/ws_a/persona-proposals/${p.id}/reject`, { reason: 'x'.repeat(2001) })).status).toBe(400);
    expect(s.repos.proposals.get(p.id)!.status).toBe('pending');
  });
});
