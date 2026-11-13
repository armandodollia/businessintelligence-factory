/**
 * KS-7 routes (design §17): reads through `knowledgeRead` as the user with a node / tree scope toggle,
 * tree isolation (an other-tree id answers exactly like an unknown one), human actions through
 * feedback/actions.ts with the actor from config, upload-derived items explained, gc and prune.
 *
 * Fixture (ks4): tree A — ws_a "Acme" → ws_c "Acme Payments" → ws_g, and ws_d "Acme Labs"; tree B ws_b.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/api/routes.js';
import { listFeedback } from '../../src/core/feedback/events.js';
import { resolveEntity } from '../../src/core/knowledge/entities.js';
import { scopeFor } from '../../src/core/knowledge/scope.js';
import type { Store } from '../../src/core/store/db.js';
import { knowledgeRepos } from '../../src/core/store/repos.js';
import { ks4 } from '../core/knowledge/ks4fixture.js';

const opened: Store[] = [];
afterEach(() => {
  for (const s of opened.splice(0)) s.close();
});

function setup() {
  const t = ks4(opened, (c) => (c.user = { id: 'ana@acme' }));
  const app = createApp({ store: t.store, artifacts: t.artifacts, events: t.events, config: t.config, research: {} as never });
  const call = async (method: string, path: string, body?: unknown) => {
    const init: RequestInit = { method };
    if (body !== undefined) {
      init.body = JSON.stringify(body);
      init.headers = { 'content-type': 'application/json' };
    }
    const res = await app.request(path, init);
    const text = await res.text();
    return { status: res.status, body: text ? (JSON.parse(text) as any) : undefined };
  };
  const get = (path: string) => call('GET', path);
  const k = (ws: string, rest: string) => `/api/workspaces/${ws}/knowledge${rest}`;
  const sa = scopeFor(t.store, 'ws_a');
  const globex = resolveEntity(t.store, sa, { kind: 'competitor', name: 'Globex' }, { workspaceId: 'ws_a' });
  const payments = t.fact('ws_c', 'Globex undercuts Payments on card fees', { entityId: globex.id });
  const labs = t.fact('ws_d', 'Globex offers loans to Labs customers', { entityId: globex.id });
  const sb = scopeFor(t.store, 'ws_b');
  const betaGlobex = resolveEntity(t.store, sb, { kind: 'competitor', name: 'Globex' }, { workspaceId: 'ws_b' });
  const beta = t.fact('ws_b', 'Globex is Beta\'s main rival', { entityId: betaGlobex.id });
  return { t, app, call, get, k, globex, payments, labs, betaGlobex, beta };
}

const ids = (hits: Array<{ id: string }>) => hits.map((h) => h.id);

describe('scope toggle: node by default, tree when asked', () => {
  it('search', async () => {
    const s = setup();
    const node = await s.get(s.k('ws_c', '/search?q=Globex&kinds=fact'));
    expect(node.status).toBe(200);
    expect(ids(node.body.hits)).toEqual([s.payments.id]);
    expect(node.body.notes.join(' ')).toMatch(/elsewhere in the business \(outside node scope\): fact 1;/);
    const tree = await s.get(s.k('ws_c', '/search?q=Globex&kinds=fact&scope=tree'));
    expect(ids(tree.body.hits).sort()).toEqual([s.payments.id, s.labs.id].sort());
    expect(tree.body.hits.find((h: { id: string }) => h.id === s.labs.id).source).toBe('ws_d');
    expect(JSON.stringify(tree.body)).not.toContain(s.beta.id);
    // Logged as a user read (no agent run).
    const row = knowledgeRepos(s.t.store).retrievalEvents.get(tree.body.retrievalEventId)!;
    expect(row).toMatchObject({ role: 'user', tool: 'search', scope: 'tree', workspaceId: 'ws_c' });
    expect(row.agentRunId).toBeUndefined();
  });

  it('entity card, node card and stats', async () => {
    const s = setup();
    const card = await s.get(s.k('ws_c', `/entities/${s.globex.id}`));
    expect(card.body.lines.join('\n')).toContain(s.payments.id);
    expect(card.body.lines.join('\n')).not.toContain(s.labs.id);
    const tree = await s.get(s.k('ws_c', `/entities/${s.globex.id}?scope=tree`));
    expect(tree.body.lines.join('\n')).toContain(s.labs.id);
    const stats = await s.get(s.k('ws_c', '/stats'));
    expect(stats.body.facts.current).toBe(1);
    expect((await s.get(s.k('ws_c', '/stats?scope=tree'))).body.facts.current).toBe(2);
    const sib = await s.get(s.k('ws_c', '/node?workspace_id=ws_d'));
    expect(sib.body).toMatchObject({ node: { id: 'ws_d' }, source: 'ws_d' });
  });

  it('entity list', async () => {
    const s = setup();
    const sa = scopeFor(s.t.store, 'ws_a');
    const loans = resolveEntity(s.t.store, sa, { kind: 'product', name: 'Labs Loans' }, { workspaceId: 'ws_d' });
    s.t.fact('ws_d', 'Labs Loans launched', { entityId: loans.id });
    const node = await s.get(s.k('ws_c', '/entities'));
    expect(ids(node.body)).toContain(s.globex.id);
    expect(ids(node.body)).not.toContain(loans.id);
    const tree = await s.get(s.k('ws_c', '/entities?scope=tree'));
    expect(tree.body.find((e: { id: string }) => e.id === loans.id)).toMatchObject({ source: 'ws_d', facts: 1 });
    expect(ids(tree.body)).not.toContain(s.betaGlobex.id);
    expect((await s.get(s.k('ws_c', '/entities?kind=nope'))).status).toBe(400);
  });

  it('by id: the named item is returned from any node of the tree, labelled', async () => {
    const s = setup();
    const r = await s.get(s.k('ws_c', `/items/${s.labs.id}`));
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ id: s.labs.id, source: 'ws_d', claim: 'Globex offers loans to Labs customers', content_trust: 'untrusted' });
  });

  it('a bad scope value is a 400; an unknown node a 404', async () => {
    const s = setup();
    expect((await s.get(s.k('ws_c', '/search?q=x&scope=all'))).status).toBe(400);
    expect((await s.get(s.k('ws_nope', '/stats'))).status).toBe(404);
  });
});

describe('isolation: another tree reads exactly like unknown', () => {
  it('reads', async () => {
    const s = setup();
    for (const [path, unknown] of [
      [`/items/${s.beta.id}`, '/items/fnd_unknown'],
      [`/entities/${s.betaGlobex.id}`, '/entities/ent_unknown'],
      ['/node?workspace_id=ws_b', '/node?workspace_id=ws_unknown'],
    ] as const) {
      const other = await s.get(s.k('ws_c', path));
      const none = await s.get(s.k('ws_c', unknown));
      expect(other.status).toBe(404);
      expect(none.status).toBe(404);
      expect(other.body.error.replace(/'[^']+'/, "'X'")).toBe(none.body.error.replace(/'[^']+'/, "'X'"));
      expect(JSON.stringify(other.body)).not.toContain('Beta');
    }
  });

  it('actions', async () => {
    const s = setup();
    const other = await s.call('POST', s.k('ws_c', `/facts/${s.beta.id}/retract`), {});
    const none = await s.call('POST', s.k('ws_c', '/facts/fnd_unknown/retract'), {});
    expect([other.status, none.status]).toEqual([404, 404]);
    expect(other.body.error).toBe(`finding '${s.beta.id}' not found`);
    expect(s.t.store.findings.get(s.beta.id)!.lifecycle ?? 'current').toBe('current');
    const rename = await s.call('POST', s.k('ws_c', `/entities/${s.betaGlobex.id}/rename`), { name: 'Hijacked' });
    expect(rename.status).toBe(404);
    const merge = await s.call('POST', s.k('ws_c', '/entities/merge'), { survivorId: s.globex.id, loserId: s.betaGlobex.id });
    expect(merge.status).toBe(404);
    const scopes = await s.call('PUT', s.k('ws_c', `/facts/${s.payments.id}/scopes`), { workspaceIds: ['ws_b'] });
    expect(scopes.status).toBe(404);
    expect(listFeedback(s.t.store)).toEqual([]);
  });
});

describe('human actions go through feedback/actions.ts with the configured actor', () => {
  it('retract, scope change and the actor never comes from the body', async () => {
    const s = setup();
    const r = await s.call('POST', s.k('ws_c', `/facts/${s.payments.id}/retract`), { reason: 'fees changed', actor: 'mallory' });
    expect(r.status).toBe(200);
    expect(r.body.lifecycle).toBe('retracted');
    const again = await s.call('POST', s.k('ws_c', `/facts/${s.payments.id}/retract`), {});
    expect(again.status).toBe(409);
    const sc = await s.call('PUT', s.k('ws_c', `/facts/${s.labs.id}/scopes`), { workspaceIds: ['ws_c', 'ws_d'] });
    expect(sc.body.workspaceIds.sort()).toEqual(['ws_c', 'ws_d']);
    const fb = listFeedback(s.t.store);
    expect(fb.map((e) => [e.kind, e.actor])).toEqual([['fact_retract', 'ana@acme'], ['fact_scope_change', 'ana@acme']]);
    expect(fb[0]!.reason).toBe('fees changed');
    expect((await s.call('POST', s.k('ws_c', `/facts/${s.labs.id}/accept-replacement`), {})).status).toBe(409);
  });

  it('merge suggestions: listed in scope, accepted (entity_merge) or rejected', async () => {
    const s = setup();
    const sa = scopeFor(s.t.store, 'ws_a');
    const globexInc = resolveEntity(s.t.store, sa, { kind: 'competitor', name: 'Globex Inc' }, { workspaceId: 'ws_c' });
    s.t.fact('ws_c', 'Globex Inc raised prices', { entityId: globexInc.id });
    const list = await s.get(s.k('ws_c', '/merge-suggestions'));
    expect(list.body).toHaveLength(1);
    expect(list.body[0]).toMatchObject({ entity: { id: globexInc.id }, candidate: { id: s.globex.id } });
    expect((await s.get(s.k('ws_b', '/merge-suggestions'))).body).toEqual([]);
    expect((await s.call('POST', s.k('ws_b', `/merge-suggestions/${list.body[0].id}/accept`), {})).status).toBe(404);
    const ok = await s.call('POST', s.k('ws_c', `/merge-suggestions/${list.body[0].id}/accept`), {});
    expect(ok.status).toBe(200);
    expect(ok.body.survivor.id).toBe(s.globex.id);
    expect(listFeedback(s.t.store, { kind: 'entity_merge' })[0]).toMatchObject({ actor: 'ana@acme', targetId: s.globex.id });
    expect((await s.call('POST', s.k('ws_c', `/merge-suggestions/${list.body[0].id}/reject`), {})).status).toBe(409);
  });

  it('rejecting a suggestion writes entity_merge_reject with the configured actor; other trees get 404', async () => {
    const s = setup();
    const sa = scopeFor(s.t.store, 'ws_a');
    const globexInc = resolveEntity(s.t.store, sa, { kind: 'competitor', name: 'Globex Inc' }, { workspaceId: 'ws_c' });
    s.t.fact('ws_c', 'Globex Inc raised prices', { entityId: globexInc.id });
    const sid = (await s.get(s.k('ws_c', '/merge-suggestions'))).body[0].id as string;
    expect((await s.call('POST', s.k('ws_b', `/merge-suggestions/${sid}/reject`), {})).status).toBe(404);
    expect(listFeedback(s.t.store)).toEqual([]);
    const r = await s.call('POST', s.k('ws_c', `/merge-suggestions/${sid}/reject`), { reason: 'different companies', actor: 'mallory' });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ status: 'rejected', actor: 'ana@acme' });
    const fb = listFeedback(s.t.store, { kind: 'entity_merge_reject' });
    expect(fb).toHaveLength(1);
    expect(fb[0]).toMatchObject({
      actor: 'ana@acme', targetType: 'entity', targetId: globexInc.id, workspaceId: 'ws_c', reason: 'different companies',
      beforeJson: { suggestionId: sid, candidate: { id: s.globex.id } }, afterJson: { status: 'rejected' },
    });
    expect((await s.get(s.k('ws_c', '/merge-suggestions'))).body).toEqual([]);
  });
});

describe('upload-derived items are marked and explained', () => {
  it('search hits and items carry the reason the export leaves them out', async () => {
    const s = setup();
    const up = s.t.artifacts.save({ workspaceId: 'ws_c', kind: 'upload', mime: 'text/plain', bytes: 'board memo' });
    const f = s.t.fact('ws_c', 'Globex margin is thin per the board memo', { evidence: [up.id] });
    const hits = (await s.get(s.k('ws_c', '/search?q=margin&kinds=fact'))).body.hits;
    expect(hits[0]).toMatchObject({ id: f.id, flags: expect.arrayContaining(['upload']) });
    expect(hits[0].uploadWhy).toContain(up.id);
    const item = await s.get(s.k('ws_c', `/items/${f.id}`));
    expect(item.body.upload).toBe(true);
    expect(item.body.uploadWhy).toMatch(/is an internal upload/);
  });
});

describe('gc report and prune', () => {
  it('reports, refuses referenced or other-tree ids with 409, prunes the rest with a log', async () => {
    const s = setup();
    const old = '2026-01-01T00:00:00.000Z';
    const free = await s.t.page('ws_c', 'Old page nobody cites.');
    const cited = await s.t.page('ws_c', 'Old page a replaced version cites.');
    const betaPage = await s.t.page('ws_b', 'Old beta page.');
    for (const a of [free, cited, betaPage]) {
      s.t.store.db.prepare('UPDATE artifacts SET captured_at = ? WHERE id = ?').run(old, a.id);
      s.t.store.db.prepare('UPDATE artifact_captures SET captured_at = ? WHERE artifact_id = ?').run(old, a.id);
    }
    s.t.fact('ws_c', 'Old claim', { lifecycle: 'replaced', evidence: [cited.id] });
    const report = await s.get(s.k('ws_c', '/gc'));
    expect(report.body.candidates.map((x: { artifactId: string }) => x.artifactId)).toEqual([free.id]);
    expect(report.body.minAgeDays).toBe(90);
    expect((await s.get(s.k('ws_c', '/gc?minAgeDays=5'))).status).toBe(400);
    const refused = await s.call('POST', s.k('ws_c', '/gc/prune'), { artifactIds: [free.id, cited.id, betaPage.id] });
    expect(refused.status).toBe(409);
    expect(refused.body.refused.map((r: { reason: string }) => r.reason)).toEqual(['referenced', 'not_found']);
    expect(listFeedback(s.t.store, { kind: 'artifact_prune' })).toEqual([]);
    const ok = await s.call('POST', s.k('ws_c', '/gc/prune'), { artifactIds: [free.id], actor: 'mallory' });
    expect(ok.status).toBe(200);
    expect(ok.body.pruned).toEqual([free.id]);
    expect(listFeedback(s.t.store, { kind: 'artifact_prune' })[0]).toMatchObject({ actor: 'ana@acme', targetType: 'artifact', targetId: free.id });
    // The bytes route says the file is gone; the row and its text remain readable.
    expect((await s.get(`/api/artifacts/${free.id}`)).status).toBe(410);
    expect((await s.get(s.k('ws_c', `/artifacts/${free.id}?mode=text`))).status).toBe(200);
    // The feedback log accepts the new target type.
    expect((await s.get(`/api/workspaces/ws_c/feedback?targetType=artifact`)).body).toHaveLength(1);
  });
});

