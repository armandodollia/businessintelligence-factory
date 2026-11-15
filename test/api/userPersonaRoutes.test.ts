/**
 * User persona, task 3 (design 2026-11-15-user-persona-design.md §11, §13, §16): the You page's routes,
 * the persona learning routes for a user persona, and the generic persona routes that must never serve
 * one. Routes act for the configured actor only; another person's user persona and another tree answer
 * 404; no response carries the actor id.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/api/routes.js';
import { recordFeedback } from '../../src/core/feedback/events.js';
import { personaLearningRepos } from '../../src/core/personas/store.js';
import type { PersonaProposal } from '../../src/core/personas/types.js';
import type { Store } from '../../src/core/store/db.js';
import { newId } from '../../src/core/store/repos.js';
import { collectInteractions } from '../../src/core/userPersona/interactions.js';
import { ensureUserPersona, userPersonaOf } from '../../src/core/userPersona/persona.js';
import { flowSetup, T0 } from '../core/flows/flowFixture.js';

const opened: Store[] = [];
afterEach(() => {
  for (const s of opened.splice(0)) s.close();
});

const ANA = 'ana-actor';
const BOB = 'bob-actor';
const STATS = { n: 12, agree: 4, disagree: 8, items: 6, lower: 0.4 };

function setup() {
  const t = flowSetup(opened, (c) => (c.user = { id: ANA }));
  t.store.workspaces.insert({ id: 'ws_a_eu', name: 'Acme EU', sector: 'saas', parentWorkspaceId: 'ws_a', createdAt: T0 });
  const app = createApp({ store: t.store, artifacts: t.artifacts, events: t.events, config: t.config, research: t.deps });
  const call = async (method: string, path: string, body?: unknown) => {
    const init: RequestInit = { method, headers: { 'content-type': 'application/json' } };
    if (body !== undefined) init.body = JSON.stringify(body);
    const res = await app.request(path, init);
    const text = await res.text();
    return { status: res.status, text, body: text ? (JSON.parse(text) as any) : undefined };
  };
  let seq = 0;
  /** `n` exclusions of findings by `actor`, round robin over `targets` findings, in node `ws`. */
  const act = (n: number, opts: { actor?: string; targets?: number; ws?: string; prefix?: string; reason?: string } = {}) => {
    for (let i = 0; i < n; i++) {
      seq++;
      recordFeedback(t.store, {
        workspaceId: opts.ws ?? 'ws_a', actor: opts.actor ?? ANA, kind: 'include_override', targetType: 'finding',
        targetId: `${opts.prefix ?? 'fnd'}_${i % (opts.targets ?? 6)}`, afterJson: { include: false }, ...(opts.reason ? { reason: opts.reason } : {}),
      });
    }
  };
  const repos = personaLearningRepos(t.store);
  /** A pending proposal of `actor`'s user persona in tree ws_a (persona created when missing), with a run carrying an assumption. */
  const proposal = (actor: string, extra: Partial<PersonaProposal> = {}, root = 'ws_a'): PersonaProposal => {
    const persona = ensureUserPersona(t.store, root, actor);
    const evidence = collectInteractions(t.store, root, actor).slice(0, 3).map((x) => x.id);
    const run = repos.runs.insert({
      id: newId('plr'), rootWorkspaceId: root, personaId: persona.id, status: 'proposed', signalsThrough: T0, shownSignalIds: evidence, shownStatementIds: [],
      stats: STATS, assumption: 'Wants claims to rest on several sources.', createdAt: new Date().toISOString(),
    });
    return repos.proposals.insert({
      id: newId('ppr'), rootWorkspaceId: root, workspaceId: root, personaId: persona.id, runId: run.id, action: 'add', field: 'evidence_standards',
      text: 'Does not act on a claim backed by one source.', rationale: 'Several exclusions point the same way.', evidence, stats: STATS, source: 'retro',
      status: 'pending', createdAt: new Date().toISOString(), ...extra,
    });
  };
  return { ...t, call, act, repos, proposal };
}

describe('GET /user-persona', () => {
  it('before any persona exists: no persona, no fields, the gate numbers and statistics; reading creates nothing', async () => {
    const s = setup();
    s.act(5, { targets: 5, reason: 'one source only' });
    const r = await s.call('GET', '/api/workspaces/ws_a/user-persona');
    expect(r.status).toBe(200);
    expect(r.body).toEqual({
      enabled: true,
      usedBy: ['orchestrator', 'synthesizer', 'interviewer'],
      useInPrompts: true,
      gate: { n: 5, targets: 5, qualifies: false, missing: ['5 of 12 actions', '5 of 6 different things'] },
      stats: { byKind: { include_override: { reject: 5 } }, total: 5 },
      fields: [],
      proposals: [],
    });
    expect(s.store.personas.list({ kind: 'user' })).toEqual([]);
  });

  it('enabled is false when the user persona, lessons or the retro is off; useInPrompts follows the config', async () => {
    const s = setup();
    s.config.userPersona = { useInPrompts: false };
    expect((await s.call('GET', '/api/workspaces/ws_a/user-persona')).body).toMatchObject({ enabled: true, useInPrompts: false });
    s.config.userPersona = { enabled: false };
    // switched off: the brief is out of the prompts too, so the page must not say it is used
    expect((await s.call('GET', '/api/workspaces/ws_a/user-persona')).body).toMatchObject({ enabled: false, useInPrompts: false });
    s.config.userPersona = {};
    s.config.lessons = { retro: { enabled: false } };
    expect((await s.call('GET', '/api/workspaces/ws_a/user-persona')).body.enabled).toBe(false);
  });

  it('Review Focus 4: a child node gets the tree persona; accept and retire through a child node work; lines carry their evidence', async () => {
    const s = setup();
    s.act(6, { ws: 'ws_a_eu', prefix: 'eu' });
    s.act(6);
    const p = s.proposal(ANA);
    const before = await s.call('GET', '/api/workspaces/ws_a_eu/user-persona');
    expect(before.body.gate).toMatchObject({ n: 12, targets: 12, qualifies: true });
    expect(before.body.proposals.map((x: PersonaProposal) => x.id)).toEqual([p.id]);
    expect(before.body.lastRun).toMatchObject({ status: 'proposed', assumption: 'Wants claims to rest on several sources.' });
    expect(Object.keys(before.body.lastRun).sort()).toEqual(['assumption', 'createdAt', 'id', 'status']);

    const accepted = await s.call('POST', `/api/workspaces/ws_a_eu/persona-proposals/${p.id}/accept`, { text: 'Wants two sources for a claim.', reason: 'yes' });
    expect(accepted.status).toBe(200);
    expect(accepted.text).not.toContain(ANA);
    expect(accepted.body.persona.subjectId).toBeUndefined();
    expect(accepted.body.adjustment.actor).toBeUndefined();
    expect(accepted.body.proposal.actor).toBeUndefined();

    const r = await s.call('GET', '/api/workspaces/ws_a_eu/user-persona');
    const persona = userPersonaOf(s.store, 'ws_a', ANA)!;
    expect(r.body.persona).toEqual({ id: persona.id, version: 2 });
    expect(r.body.fields).toHaveLength(1);
    expect(r.body.fields[0].field).toBe('evidence_standards');
    expect(r.body.fields[0].lines).toEqual([expect.objectContaining({ text: 'Wants two sources for a claim.', status: 'active', version: 1, evidence: 3 })]);
    expect(r.body.fields[0].lines[0].actor).toBeUndefined();
    expect(r.body.proposals).toEqual([expect.objectContaining({ id: p.id, status: 'accepted', finalText: 'Wants two sources for a claim.' })]);
    expect(r.text).not.toContain(ANA);

    const lineId = r.body.fields[0].lines[0].id as string;
    const evidence = await s.call('GET', `/api/workspaces/ws_a_eu/user-persona/interactions?line=${lineId}`);
    expect(evidence.status).toBe(200);
    expect(evidence.body.interactions.map((x: { id: string }) => x.id).sort()).toEqual([...p.evidence].sort());

    const retired = await s.call('POST', `/api/workspaces/ws_a_eu/persona-adjustments/${lineId}/retire`, { reason: 'not any more' });
    expect(retired.status).toBe(200);
    expect(retired.text).not.toContain(ANA);
    expect(retired.body.persona.version).toBe(3);
    expect((await s.call('GET', '/api/workspaces/ws_a/user-persona')).body.fields).toEqual([]);
  });

  it('reject through a child node works and names no actor', async () => {
    const s = setup();
    s.act(3);
    const p = s.proposal(ANA);
    const r = await s.call('POST', `/api/workspaces/ws_a_eu/persona-proposals/${p.id}/reject`, { reason: 'too strict' });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ id: p.id, status: 'rejected', reason: 'too strict' });
    expect(r.text).not.toContain(ANA);
  });

  it('acts for the configured actor: another person\'s interactions, persona and proposals are neither shown nor decided (404)', async () => {
    const s = setup();
    s.act(4);
    s.act(9, { actor: BOB, prefix: 'b' });
    const bobs = s.proposal(BOB);
    const r = await s.call('GET', '/api/workspaces/ws_a/user-persona');
    expect(r.body.gate.n).toBe(4);
    expect(r.body.persona).toBeUndefined();
    expect(r.body.proposals).toEqual([]);
    expect((await s.call('GET', '/api/workspaces/ws_a/user-persona/interactions')).body.interactions).toHaveLength(4);

    for (const path of [`persona-proposals/${bobs.id}/accept`, `persona-proposals/${bobs.id}/reject`]) {
      const res = await s.call('POST', `/api/workspaces/ws_a/${path}`, {});
      expect(res).toMatchObject({ status: 404, body: { error: `persona proposal '${bobs.id}' not found` } });
    }
    expect(s.repos.proposals.get(bobs.id)!.status).toBe('pending');

    // Bob's own session accepts it; Ana cannot retire the line or see its evidence.
    s.config.user = { id: BOB };
    const accepted = await s.call('POST', `/api/workspaces/ws_a/persona-proposals/${bobs.id}/accept`, {});
    expect(accepted.status).toBe(200);
    expect(accepted.text).not.toContain(BOB);
    const bobView = await s.call('GET', '/api/workspaces/ws_a/user-persona');
    expect(bobView.body.gate.n).toBe(10); // 9 + the accept
    expect(bobView.text).not.toContain(BOB);
    s.config.user = { id: ANA };
    const lineId = accepted.body.adjustment.id as string;
    expect(await s.call('POST', `/api/workspaces/ws_a/persona-adjustments/${lineId}/retire`, {})).toMatchObject({
      status: 404, body: { error: `persona adjustment '${lineId}' not found` },
    });
    expect((await s.call('GET', `/api/workspaces/ws_a/user-persona/interactions?line=${lineId}`)).status).toBe(404);
    expect(s.repos.adjustments.get(lineId)!.status).toBe('active');
  });

  it('another tree answers 404 for proposals, lines and line evidence; an unknown node answers 404', async () => {
    const s = setup();
    s.otherTree();
    s.act(3);
    const p = s.proposal(ANA);
    expect((await s.call('POST', `/api/workspaces/ws_b/persona-proposals/${p.id}/accept`, {})).status).toBe(404);
    expect((await s.call('POST', `/api/workspaces/ws_b/persona-proposals/${p.id}/reject`, {})).status).toBe(404);
    const accepted = await s.call('POST', `/api/workspaces/ws_a/persona-proposals/${p.id}/accept`, {});
    const lineId = accepted.body.adjustment.id as string;
    expect((await s.call('POST', `/api/workspaces/ws_b/persona-adjustments/${lineId}/retire`, {})).status).toBe(404);
    expect((await s.call('GET', `/api/workspaces/ws_b/user-persona/interactions?line=${lineId}`)).status).toBe(404);
    const other = await s.call('GET', '/api/workspaces/ws_b/user-persona');
    expect(other.body).toMatchObject({ fields: [], proposals: [], gate: { n: 0 } });
    expect(other.body.persona).toBeUndefined();
    expect((await s.call('GET', '/api/workspaces/ws_zzz/user-persona')).status).toBe(404);
    expect((await s.call('GET', '/api/workspaces/ws_zzz/user-persona/interactions')).status).toBe(404);
  });
});

describe('GET /user-persona/interactions', () => {
  it('newest first, paged with next / before; 50 by default, at most 200', async () => {
    const s = setup();
    s.act(7, { reason: 'one source only' });
    const all = collectInteractions(s.store, 'ws_a', ANA).reverse().map((x) => x.id);
    const seen: string[] = [];
    let path = '/api/workspaces/ws_a/user-persona/interactions?limit=3';
    for (const size of [3, 3, 1]) {
      const r = await s.call('GET', path);
      expect(r.status).toBe(200);
      expect(r.body.interactions).toHaveLength(size);
      seen.push(...r.body.interactions.map((x: { id: string }) => x.id));
      if (size === 3) path = `/api/workspaces/ws_a/user-persona/interactions?limit=3&before=${r.body.next}`;
      else expect(r.body.next).toBeUndefined();
    }
    expect(seen).toEqual(all);
    const first = (await s.call('GET', '/api/workspaces/ws_a/user-persona/interactions')).body.interactions[0];
    expect(first).toMatchObject({ kind: 'include_override', stance: 'reject', reason: 'one source only' });
    expect(first.detail).toMatch(/^include_override on finding fnd_/);

    s.act(250, { prefix: 'many' });
    const def = await s.call('GET', '/api/workspaces/ws_a/user-persona/interactions');
    expect(def.body.interactions).toHaveLength(50);
    expect(def.body.next).toBe(def.body.interactions[49].id);
    expect((await s.call('GET', '/api/workspaces/ws_a/user-persona/interactions?limit=1000')).body.interactions).toHaveLength(200);
  });

  it('a bad limit, an unknown cursor or an unknown line answers 400 / 404', async () => {
    const s = setup();
    s.act(2);
    for (const q of ['limit=0', 'limit=abc', 'limit=-3', 'before=fbk_nope']) {
      expect((await s.call('GET', `/api/workspaces/ws_a/user-persona/interactions?${q}`)).status).toBe(400);
    }
    expect((await s.call('GET', '/api/workspaces/ws_a/user-persona/interactions?line=pad_nope')).status).toBe(404);
  });
});

describe('accepting a user persona line', () => {
  it('edited text naming the configured person or holding an email answers 400 and changes nothing', async () => {
    const s = setup();
    s.act(3);
    const p = s.proposal(ANA);
    for (const text of [`Copies the ${ANA} team on summaries.`, 'Copies someone@example.com on summaries.']) {
      const r = await s.call('POST', `/api/workspaces/ws_a/persona-proposals/${p.id}/accept`, { text, reason: 'ok' });
      expect(r).toMatchObject({ status: 400, body: { error: expect.stringMatching(/names or identifies the person/) } });
    }
    expect(s.repos.proposals.get(p.id)!.status).toBe('pending');
    expect(s.repos.adjustments.list({ personaId: p.personaId })).toEqual([]);
  });

  it('honours userPersona.maxAdjustments (not persona learning\'s) and maxPerField at accept time', async () => {
    const s = setup();
    s.act(3);
    s.config.userPersona = { maxAdjustments: 2, maxPerField: 1 };
    s.config.personaLearning = { maxAdjustments: 1 };
    const accept = (p: PersonaProposal) => s.call('POST', `/api/workspaces/ws_a/persona-proposals/${p.id}/accept`, {});
    expect((await accept(s.proposal(ANA, { field: 'priorities' }))).status).toBe(200);
    const sameField = await accept(s.proposal(ANA, { field: 'priorities' }));
    expect(sameField).toMatchObject({ status: 409, body: { error: expect.stringMatching(/field 'priorities'.*max 1/) } });
    expect((await accept(s.proposal(ANA, { field: 'communication' }))).status).toBe(200);
    const total = await accept(s.proposal(ANA, { field: 'quality_bar' }));
    expect(total).toMatchObject({ status: 409, body: { error: expect.stringMatching(/max 2/) } });
    expect(total.text).not.toContain(ANA);
  });
});

describe('the Lessons pending count', () => {
  it('pendingInTree counts the configured person\'s pending user persona proposal (and pendingUser says how many), not another person\'s', async () => {
    const s = setup();
    s.act(3);
    s.act(3, { actor: BOB, prefix: 'b' });
    s.proposal(ANA);
    s.proposal(BOB);
    const smb = s.persona('smb');
    s.repos.proposals.insert({
      id: newId('ppr'), rootWorkspaceId: 'ws_a', workspaceId: 'ws_a', personaId: smb.id, action: 'add', field: 'buying_behavior', text: 'You x.', rationale: 'r',
      evidence: [], stats: STATS, source: 'retro', status: 'pending', createdAt: T0,
    });
    for (const ws of ['ws_a', 'ws_a_eu']) {
      const r = await s.call('GET', `/api/workspaces/${ws}/persona-learning`);
      expect(r.body).toMatchObject({ pendingInTree: 2, pendingUser: 1 });
      expect(r.body.personas.map((p: { personaId: string }) => p.personaId)).not.toContain(userPersonaOf(s.store, 'ws_a', ANA)!.id);
    }
  });
});

describe('generic persona routes never serve a user persona', () => {
  it('lists, include, signals, stakeholders, ratings and flow rankings answer as for an unknown persona', async () => {
    const s = setup();
    s.act(3);
    const user = ensureUserPersona(s.store, 'ws_a', ANA);
    const smb = s.persona('smb');
    const list = await s.call('GET', '/api/workspaces/ws_a/personas');
    expect(list.body.map((p: { id: string }) => p.id)).toEqual([smb.id]);
    expect((await s.call('POST', `/api/personas/${user.id}/include`, { include: true })).status).toBe(404);
    expect(s.store.personas.get(user.id)!.includeOverride).toBeUndefined();
    expect((await s.call('GET', `/api/workspaces/ws_a/personas/${user.id}/signals`)).status).toBe(404);
    const learning = await s.call('GET', '/api/workspaces/ws_a/persona-learning');
    expect(learning.body.personas.map((p: { personaId: string }) => p.personaId)).toEqual([smb.id]);
    const stakeholders = await s.call('GET', '/api/workspaces/ws_a/stakeholders');
    expect(stakeholders.text).not.toContain(user.id);
    expect((await s.call('GET', `/api/workspaces/ws_a/stakeholders/${user.id}/statements`)).status).toBe(404);
    expect((await s.call('POST', `/api/workspaces/ws_a/stakeholders/${user.id}/reveal`)).status).toBe(404);
    expect((await s.call('POST', `/api/workspaces/ws_a/stakeholders/${user.id}/notes`, { text: 'note' })).status).toBe(404);
    const rating = await s.call('POST', '/api/ratings', { workspaceId: 'ws_a', targetType: 'persona', targetId: user.id, criterion: 'demographics', verdict: 'agree' });
    expect(rating.status).toBe(400);
    expect(s.store.ratings.list({ workspaceId: 'ws_a' })).toEqual([]);
    expect((await s.call('GET', `/api/workspaces/ws_a/flows/rankings/${s.typeId}?persona=${user.id}`)).status).toBe(404);
  });
});
