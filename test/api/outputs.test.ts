import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/api/routes.js';
import type { Store } from '../../src/core/store/db.js';
import { newId } from '../../src/core/store/repos.js';
import { createWorkspace } from '../../src/core/workspace/tree.js';
import { researchSetup } from '../core/helpers/research.js';

const opened: Store[] = [];
afterEach(() => {
  for (const s of opened.splice(0)) s.close();
});

function setup() {
  const t = researchSetup(opened);
  const app = createApp({ store: t.store, artifacts: t.artifacts, events: t.events, config: t.config, research: t.deps });
  const json = async (method: string, path: string, body?: unknown) => {
    const init: RequestInit = { method };
    if (body !== undefined) {
      init.body = JSON.stringify(body);
      init.headers = { 'content-type': 'application/json' };
    }
    const res = await app.request(path, init);
    const text = await res.text();
    return { status: res.status, body: text ? (JSON.parse(text) as any) : undefined };
  };
  const ws = createWorkspace(t.store, { name: 'Acme', sector: 'saas' });
  return { ...t, json, ws };
}

/** A finished reviewer run on `taskId` with a submitted review. */
function addReview(store: Store, workspaceId: string, taskId: string, score: number, description: string) {
  const runId = newId('arun');
  store.agentRuns.insert({
    id: runId, workspaceId, taskId, role: 'reviewer', model: { provider: 'codex', model: 'gpt-6.1-sol' }, token: newId('tok'),
    status: 'done', startedAt: new Date().toISOString(),
  });
  store.decisions.insert({
    id: newId('dec'), workspaceId, agentRunId: runId, role: 'reviewer', model: { provider: 'codex', model: 'gpt-6.1-sol' }, kind: 'review',
    payload: { tool: 'submit_review', score, issues: [{ id: 'I1', class: 'substantive', description }] }, refs: [taskId],
    promptVersion: 'v', createdAt: new Date().toISOString(),
  });
}

describe('output status API', () => {
  it('recommendations and personas carry status + lastReview; include overrides set / reset', async () => {
    const t = setup();
    const rec = t.store.recommendations.insert({
      id: 'rec_u', workspaceId: t.ws.id, title: 'Raise prices', summary: 's', criteria: {}, findingIds: [], personaFeedback: [],
      priority: 2, createdAt: 'now', taskId: 'tsk_syn', status: 'unverified',
    });
    t.store.personas.insert({
      id: 'per_u', workspaceId: t.ws.id, slug: 'sam', segment: 'SMB', profile: {}, agentMdPath: 'x.md', version: 1,
      taskId: 'tsk_per', status: 'unverified',
    });
    addReview(t.store, t.ws.id, 'tsk_syn', 6, 'NO_EVIDENCE_FOR_UPSIDE');
    addReview(t.store, t.ws.id, 'tsk_per', 5, 'THIN_PERSONA');

    const recs = await t.json('GET', `/api/workspaces/${t.ws.id}/recommendations`);
    expect(recs.body[0]).toMatchObject({ id: 'rec_u', status: 'unverified', lastReview: { score: 6, issues: [{ description: 'NO_EVIDENCE_FOR_UPSIDE' }] } });
    const personas = await t.json('GET', `/api/workspaces/${t.ws.id}/personas`);
    expect(personas.body[0]).toMatchObject({ id: 'per_u', status: 'unverified', lastReview: { score: 5 } });

    expect(await t.json('POST', `/api/recommendations/${rec.id}/include`, { include: true })).toMatchObject({ status: 200, body: { includeOverride: true } });
    expect(t.store.recommendations.get(rec.id)!.includeOverride).toBe(true);
    expect((await t.json('POST', `/api/recommendations/${rec.id}/include`, { include: null })).body.includeOverride).toBeUndefined();
    expect(await t.json('POST', '/api/personas/per_u/include', { include: true })).toMatchObject({ status: 200, body: { includeOverride: true } });
    expect((await t.json('POST', '/api/personas/per_nope/include', { include: true })).status).toBe(404);
    expect((await t.json('POST', '/api/recommendations/rec_u/include', { include: 'yes' })).status).toBe(400);
  });

  it('the personas list serves segment personas only (a stakeholder persona is left out)', async () => {
    const t = setup();
    const base = { workspaceId: t.ws.id, profile: {}, agentMdPath: 'x.md', version: 1, status: 'verified' as const };
    t.store.personas.insert({ ...base, id: 'per_seg', slug: 'sam', segment: 'SMB' });
    t.store.personas.insert({
      ...base, id: 'per_stk', slug: 'stk-cfo', segment: 'Chief financial officer', kind: 'stakeholder', stakeholderType: 'leader',
      subjectKind: 'own', relation: 'Approves budgets', disclosure: 'hidden',
    });
    const personas = await t.json('GET', `/api/workspaces/${t.ws.id}/personas`);
    expect(personas.body.map((p: { id: string }) => p.id)).toEqual(['per_seg']);
  });

  it('competitors carry status + lastReview; include override sets / resets', async () => {
    const t = setup();
    t.store.competitors.insert({
      id: 'cmp_u', workspaceId: t.ws.id, name: 'Globex', threat: 4, directness: 3, comparison: { pricing: 2, onboarding: 5, ux: 4, features: 3 },
      evidence: [], createdAt: 'now', updatedAt: 'now', taskId: 'tsk_cmp', status: 'unverified',
    });
    addReview(t.store, t.ws.id, 'tsk_cmp', 5, 'NOT_A_COMPETITOR');
    const list = await t.json('GET', `/api/workspaces/${t.ws.id}/competitors`);
    expect(list.body[0]).toMatchObject({ id: 'cmp_u', status: 'unverified', lastReview: { score: 5 } });
    expect(await t.json('POST', '/api/competitors/cmp_u/include', { include: true })).toMatchObject({ status: 200, body: { includeOverride: true } });
    const q = await t.json('GET', `/api/workspaces/${t.ws.id}/review-queue`);
    expect(q.body.some((i: { targetId: string }) => i.targetId === 'cmp_u')).toBe(true);
    expect((await t.json('POST', '/api/competitors/cmp_u/include', { include: null })).body.includeOverride).toBeUndefined();
    expect((await t.json('POST', '/api/competitors/cmp_nope/include', { include: true })).status).toBe(404);
  });

  it('findings ?scope=tree returns same-tree findings tagged with their source node', async () => {
    const t = setup();
    const child = createWorkspace(t.store, { name: 'Payments', sector: 'saas', parentWorkspaceId: t.ws.id });
    const other = createWorkspace(t.store, { name: 'Globex', sector: 'retail' });
    const f = (id: string, workspaceId: string) =>
      t.store.findings.insert({ id, workspaceId, runId: 'r', taskId: 't', subject: 's', claim: id, criteria: {}, evidence: [], status: 'verified', createdAt: 'now' });
    f('fnd_parent', t.ws.id);
    f('fnd_child', child.id);
    f('fnd_other', other.id);
    const own = await t.json('GET', `/api/workspaces/${child.id}/findings`);
    expect(own.body.map((x: { id: string }) => x.id)).toEqual(['fnd_child']);
    const tree = await t.json('GET', `/api/workspaces/${child.id}/findings?scope=tree`);
    expect(tree.body.map((x: { id: string; sourceWorkspaceId: string }) => [x.id, x.sourceWorkspaceId])).toEqual([
      ['fnd_child', child.id],
      ['fnd_parent', t.ws.id],
    ]);
  });
});
