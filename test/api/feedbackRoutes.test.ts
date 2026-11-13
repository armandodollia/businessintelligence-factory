import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/api/routes.js';
import { listFeedback } from '../../src/core/feedback/events.js';
import { registerFeedbackOutcomes } from '../../src/core/learning/feedbackOutcomes.js';
import { listOutcomes } from '../../src/core/learning/outcomes.js';
import type { Store } from '../../src/core/store/db.js';
import { newId } from '../../src/core/store/repos.js';
import { createWorkspace } from '../../src/core/workspace/tree.js';
import { researchSetup } from '../core/helpers/research.js';

const opened: Store[] = [];
afterEach(() => {
  for (const s of opened.splice(0)) s.close();
});

const NOW = '2026-11-13T10:00:00.000Z';

function setup() {
  const t = researchSetup(opened, { config: (c) => (c.user = { id: 'ana@acme' }) });
  const app = createApp({ store: t.store, artifacts: t.artifacts, events: t.events, config: t.config, research: t.deps, configPath: join(t.dir, 'bif.config.json') });
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
  t.store.agentRuns.insert({
    id: 'arun_w', workspaceId: ws.id, taskId: 'tsk_1', role: 'worker', model: { provider: 'claude', model: 'sonnet' },
    token: 'tok_w', status: 'done', startedAt: NOW, promptVersion: 'pv_w1',
  });
  return { ...t, app, json, ws };
}

function addFinding(t: ReturnType<typeof setup>) {
  const id = newId('fnd');
  t.store.findings.insert({
    id, workspaceId: t.ws.id, runId: 'r', taskId: 'tsk_1', subject: 'Acme', claim: 'c', criteria: { relevance: 4 }, evidence: [], status: 'verified', createdAt: NOW,
  });
  t.store.decisions.insert({
    id: newId('dec'), workspaceId: t.ws.id, agentRunId: 'arun_w', role: 'worker', model: { provider: 'claude', model: 'sonnet' },
    kind: 'decision', payload: { tool: 'save_finding', findingId: id }, refs: [id], promptVersion: 'pv_w1', createdAt: NOW,
  });
  return id;
}

function addHypothesis(t: ReturnType<typeof setup>) {
  t.store.symptoms.insert({ id: 'sym_1', workspaceId: t.ws.id, kind: 'symptom', title: 'Churn', detail: 'd', criteria: {}, evidence: [] });
  t.store.symptomHypotheses.insert({
    id: 'hyp_1', workspaceId: t.ws.id, symptomId: 'sym_1', hypothesis: 'Price', confidence: 50, evidence: [], taskId: 'tsk_1', createdAt: NOW, status: 'unverified',
  });
}

describe('WP-A routes: actor and feedback events', () => {
  it('ratings take the actor from config.user.id, never from the body', async () => {
    const t = setup();
    const fid = addFinding(t);
    const r = await t.json('POST', '/api/ratings', {
      workspaceId: t.ws.id, targetType: 'finding', targetId: fid, criterion: 'relevance', verdict: 'agree', actor: 'mallory', agentRunId: 'fake',
    });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ actor: 'ana@acme', agentRunId: 'arun_w', promptVersion: 'pv_w1' });
  });

  it('include overrides record feedback events; GET /feedback filters them', async () => {
    const t = setup();
    const fid = addFinding(t);
    expect((await t.json('POST', `/api/findings/${fid}/include`, { include: false })).status).toBe(200);
    const all = await t.json('GET', `/api/workspaces/${t.ws.id}/feedback`);
    expect(all.body).toEqual([expect.objectContaining({ kind: 'include_override', actor: 'ana@acme', targetType: 'finding', targetId: fid, agentRunId: 'arun_w' })]);
    expect((await t.json('GET', `/api/workspaces/${t.ws.id}/feedback?kind=profile_edit`)).body).toEqual([]);
    expect((await t.json('GET', `/api/workspaces/${t.ws.id}/feedback?targetId=${fid}`)).body).toHaveLength(1);
    expect((await t.json('GET', `/api/workspaces/${t.ws.id}/feedback?kind=bogus`)).status).toBe(400);
    expect((await t.json('GET', `/api/workspaces/ws_nope/feedback`)).status).toBe(404);
  });

  it('hypothesis include override and user correction', async () => {
    const t = setup();
    addHypothesis(t);
    const inc = await t.json('POST', '/api/hypotheses/hyp_1/include', { include: true });
    expect(inc.status).toBe(200);
    expect(inc.body.includeOverride).toBe(true);
    const fix = await t.json('POST', '/api/hypotheses/hyp_1/correct', { confidence: 10, reason: 'tickets say otherwise' });
    expect(fix.status).toBe(200);
    expect(fix.body).toMatchObject({ confidence: 10, hypothesis: 'Price' });
    expect(listFeedback(t.store, { workspaceId: t.ws.id }).map((e) => [e.kind, e.actor])).toEqual([
      ['include_override', 'ana@acme'],
      ['hypothesis_correction', 'ana@acme'],
    ]);
    expect((await t.json('POST', '/api/hypotheses/hyp_1/correct', {})).status).toBe(400);
    expect((await t.json('POST', '/api/hypotheses/hyp_1/correct', { confidence: 10 })).status).toBe(400);
    expect((await t.json('POST', '/api/hypotheses/hyp_nope/correct', { confidence: 10 })).status).toBe(404);
    expect((await t.json('POST', '/api/hypotheses/hyp_nope/include', { include: false })).status).toBe(404);
  });

  it('profile edits', async () => {
    const t = setup();
    const r = await t.json('PATCH', `/api/workspaces/${t.ws.id}/profile`, { patch: { pricing: 'per seat' }, reason: 'fix' });
    expect(r.status).toBe(200);
    expect(r.body.data).toEqual({ pricing: 'per seat' });
    expect((await t.json('PATCH', `/api/workspaces/${t.ws.id}/profile`, { patch: { uploads: [] } })).status).toBe(400);
    expect((await t.json('PATCH', `/api/workspaces/ws_nope/profile`, { patch: { a: 1 } })).status).toBe(404);
    expect(listFeedback(t.store, { kind: 'profile_edit' })).toHaveLength(1);
  });

  it('unit proposal accept-with-edit keeps the original and links the feedback event', async () => {
    const t = setup();
    t.store.unitProposals.insert({
      id: 'unit_1', workspaceId: t.ws.id, name: 'Platform', description: 'd', level: 'slice', audiences: ['internal'], evidence: [],
      reasoning: 'r', status: 'proposed', createdAt: NOW,
    });
    const r = await t.json('POST', '/api/unit-proposals/unit_1', { action: 'accept', edits: { name: 'Dev Platform' }, reason: 'real name' });
    expect(r.status).toBe(200);
    expect(r.body.proposal).toMatchObject({ actor: 'ana@acme', decisionReason: 'real name', originalPayload: { name: 'Platform' } });
    expect(r.body.workspace.name).toBe('Dev Platform');
    expect(listFeedback(t.store, { workspaceId: t.ws.id })[0]).toMatchObject({ id: r.body.feedbackEventId, kind: 'proposal_edit' });
    expect((await t.json('POST', '/api/unit-proposals/unit_1', { action: 'reject' })).status).toBe(409);
  });

  it('request answers store resolvedAt and the actor', async () => {
    const t = setup();
    t.store.userRequests.insert({ id: 'ureq_1', workspaceId: t.ws.id, agentRunId: 'arun_w', kind: 'approval', details: 'demo?', status: 'pending', createdAt: NOW });
    const r = await t.json('POST', '/api/requests/ureq_1', { status: 'resolved', response: 'ok' });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ status: 'resolved', actor: 'ana@acme' });
    expect(r.body.resolvedAt).toBeTruthy();
    expect(listFeedback(t.store, { kind: 'request_answer' })).toEqual([expect.objectContaining({ actor: 'ana@acme', targetId: 'ureq_1', agentRunId: 'arun_w' })]);
  });

  it('weight changes and prompt patch approvals record feedback with the real actor', async () => {
    const t = setup();
    const w = await t.json('PUT', `/api/workspaces/${t.ws.id}/scoring-weights`, { weights: { upside: 2 } });
    expect(w.status).toBe(200);
    expect(listFeedback(t.store, { kind: 'weights_change' })).toEqual([
      expect.objectContaining({ actor: 'ana@acme', targetType: 'scoring_weights', afterJson: expect.objectContaining({ weights: { upside: 2 }, decisionId: w.body.decisionId }) }),
    ]);
    const a = await t.json('POST', `/api/workspaces/${t.ws.id}/calibration/prompt-patch/apply`, { role: 'reviewer', patchText: '1. be strict\n' });
    expect(a.status).toBe(200);
    const d = t.store.decisions.get(a.body.decisionId)!;
    expect(d.agentRunId).toBe('ana@acme');
    expect(d.promptVersion).toBe(a.body.promptVersion);
    expect(a.body.promptVersion).not.toBe(a.body.previousPromptVersion);
    expect(listFeedback(t.store, { kind: 'prompt_patch_apply' })).toEqual([
      expect.objectContaining({ actor: 'ana@acme', targetId: 'reviewer', promptVersion: a.body.promptVersion }),
    ]);
  });

  it('integration: weights, apply and revert are logged by the real actor, never the `user` pseudo run id', async () => {
    const t = setup();
    const w = await t.json('PUT', `/api/workspaces/${t.ws.id}/scoring-weights`, { weights: { upside: 2 } });
    expect(t.store.decisions.get(w.body.decisionId)!.agentRunId).toBe('ana@acme');

    // One apply path: a calibration version (WP-B) AND a prompt_patch_apply feedback event (WP-A).
    const a = await t.json('POST', `/api/workspaces/${t.ws.id}/calibration/prompt-patch/apply`, { role: 'worker', patchText: '1. cite sources\n' });
    expect(a.status).toBe(200);
    expect(a.body).toMatchObject({ decisionId: expect.any(String), versionId: expect.any(String), promptVersion: expect.any(String), previousPromptVersion: expect.any(String) });
    const versions = (await t.json('GET', `/api/workspaces/${t.ws.id}/calibration/versions?role=worker`)).body;
    expect(versions.map((v: { source: string }) => v.source)).toEqual(['import', 'apply']);
    expect(versions[1]).toMatchObject({ id: a.body.versionId, decisionId: a.body.decisionId, actor: 'ana@acme' });
    expect(listFeedback(t.store, { kind: 'prompt_patch_apply' })).toEqual([
      expect.objectContaining({ actor: 'ana@acme', targetId: 'worker', afterJson: expect.objectContaining({ decisionId: a.body.decisionId, versionId: a.body.versionId }) }),
    ]);

    const r = await t.json('POST', `/api/workspaces/${t.ws.id}/calibration/versions/${versions[0].id}/revert`, {});
    expect(r.status).toBe(200);
    const rd = t.store.decisions.get(r.body.decisionId)!;
    expect(rd).toMatchObject({ agentRunId: 'ana@acme', payload: { tool: 'revert_calibration', actor: 'user', actorId: 'ana@acme' } });
    expect(rd.promptVersion).toBe(a.body.previousPromptVersion);
    expect(listFeedback(t.store, { kind: 'prompt_patch_revert' })).toEqual([
      expect.objectContaining({
        actor: 'ana@acme', targetType: 'prompt', targetId: 'worker', promptVersion: a.body.previousPromptVersion,
        beforeJson: expect.objectContaining({ promptVersion: a.body.promptVersion }),
        afterJson: expect.objectContaining({ promptVersion: a.body.previousPromptVersion, decisionId: r.body.decisionId, versionId: r.body.version.id }),
      }),
    ]);
    expect(t.store.decisions.list().filter((d) => d.agentRunId === 'user')).toEqual([]);
  });
});

describe('integration: one outcome per human action through the API (feedback → onFeedback → recordOutcome)', () => {
  let release: () => void = () => {};
  beforeAll(() => {
    release = registerFeedbackOutcomes(); // what boot (createRuntime) does
  });
  afterAll(() => release());

  it('finding exclude, hypothesis include and unit-proposal reject each write their outcomes once, by the configured actor', async () => {
    const t = setup();
    const fid = addFinding(t);
    addHypothesis(t);
    t.store.decisions.insert({
      id: 'dec_hyp', workspaceId: t.ws.id, agentRunId: 'arun_w', role: 'worker', model: { provider: 'claude', model: 'sonnet' },
      kind: 'score', payload: { tool: 'save_hypothesis', hypothesisId: 'hyp_1', symptomId: 'sym_1' }, refs: ['hyp_1'], promptVersion: 'pv_w1', createdAt: NOW,
    });
    t.store.decisions.insert({
      id: 'dec_unit', workspaceId: t.ws.id, agentRunId: 'arun_w', role: 'orchestrator', model: { provider: 'claude', model: 'sonnet' },
      kind: 'decision', payload: { tool: 'propose_business_unit', name: 'Platform' }, refs: [], promptVersion: 'pv_o', createdAt: NOW,
    });
    t.store.unitProposals.insert({
      id: 'unit_1', workspaceId: t.ws.id, name: 'Platform', description: 'd', level: 'slice', audiences: ['internal'], evidence: [],
      reasoning: 'r', status: 'proposed', decisionId: 'dec_unit', createdAt: NOW,
    });

    expect((await t.json('POST', `/api/findings/${fid}/include`, { include: false })).status).toBe(200);
    expect((await t.json('POST', `/api/findings/${fid}/include`, { include: false })).status).toBe(200); // unchanged: no action
    expect((await t.json('POST', '/api/hypotheses/hyp_1/include', { include: true })).status).toBe(200);
    expect((await t.json('POST', '/api/unit-proposals/unit_1', { action: 'reject', reason: 'no' })).status).toBe(200);

    const user = listOutcomes(t.store, { workspaceIds: [t.ws.id] }).filter((o) => o.source.startsWith('user_'));
    expect(user.map((o) => [o.targetType, o.targetId, o.outcome, o.label, o.actor])).toEqual([
      ['finding', fid, 'excluded', 'user-rejected', 'ana@acme'],
      ['hypothesis', 'hyp_1', 'included', 'confirmed', 'ana@acme'],
      ['unit_proposal', 'unit_1', 'rejected', 'user-rejected', 'ana@acme'],
    ]);
    const events = listFeedback(t.store, { workspaceId: t.ws.id });
    expect(user.map((o) => o.evidenceJson.feedbackEventId)).toEqual(events.map((e) => e.id));
  });
});
