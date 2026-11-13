import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp, type AppDeps } from '../../src/api/routes.js';
import type { RunContext } from '../../src/core/harness/tokens.js';
import type { Store } from '../../src/core/store/db.js';
import { newId } from '../../src/core/store/repos.js';
import type { Decision, Recommendation, Schedule, UnitProposal, Workspace } from '../../src/core/types.js';
import { createWorkspace } from '../../src/core/workspace/tree.js';
import { researchSetup, tick } from '../core/helpers/research.js';

const opened: Store[] = [];
let calibration: string;
beforeEach(() => {
  calibration = mkdtempSync(join(tmpdir(), 'bif-calib-'));
  process.env.BIF_CALIBRATION_DIR = calibration;
});
afterEach(() => {
  delete process.env.BIF_CALIBRATION_DIR;
  for (const s of opened.splice(0)) s.close();
});

function setup(extra: Partial<AppDeps> = {}) {
  const t = researchSetup(opened);
  const configPath = join(t.dir, 'bif.config.json');
  const app = createApp({
    store: t.store,
    artifacts: t.artifacts,
    events: t.events,
    config: t.config,
    research: t.deps,
    configPath,
    sseHeartbeatMs: 50,
    ...extra,
  });
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
  return { ...t, app, json, ws, configPath };
}

const ctx = (workspaceId: string, extra: Partial<RunContext> = {}): RunContext => ({
  agentRunId: newId('arun'), workspaceId, role: 'worker', model: { provider: 'claude', model: 'sonnet' }, promptVersion: 'v1', ...extra,
});

function addRec(store: Store, workspaceId: string, extra: Partial<Recommendation> = {}): Recommendation {
  return store.recommendations.insert({
    id: newId('rec'), workspaceId, title: 'Cut onboarding steps', summary: 's', criteria: { upside: 4, difficulty: 2 },
    findingIds: [], personaFeedback: [], priority: 3, createdAt: new Date().toISOString(), ...extra,
  });
}

describe('workspaces', () => {
  it('create workspace → list contains it', async () => {
    const t = setup();
    const created = await t.json('POST', '/api/workspaces', {
      name: 'Acme EU', sector: 'saas', scope: { level: 'division', name: 'EU', description: 'Europe' },
      audiences: ['internal', 'external'], parentWorkspaceId: t.ws.id,
    });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ name: 'Acme EU', parentWorkspaceId: t.ws.id, audiences: ['internal', 'external'] });
    const list = await t.json('GET', '/api/workspaces');
    expect(list.status).toBe(200);
    expect((list.body as Workspace[]).map((w) => w.id)).toEqual([t.ws.id, created.body.id]);
  });

  it('rejects invalid input and unknown parent with 400; unknown workspace 404', async () => {
    const t = setup();
    expect((await t.json('POST', '/api/workspaces', { sector: 'x' })).status).toBe(400);
    const bad = await t.json('POST', '/api/workspaces', { name: 'x', sector: 'y', parentWorkspaceId: 'ws_nope' });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toContain('not found');
    expect((await t.json('GET', '/api/workspaces/ws_nope/profile')).status).toBe(404);
  });

  it('tree, rollup with crossCutting, and profile', async () => {
    const t = setup();
    const a = createWorkspace(t.store, { name: 'A', sector: 'saas', parentWorkspaceId: t.ws.id });
    const b = createWorkspace(t.store, { name: 'B', sector: 'saas', parentWorkspaceId: t.ws.id });
    for (const w of [a, b]) {
      t.store.symptoms.insert({ id: newId('sym'), workspaceId: w.id, kind: 'symptom', title: 'Slow onboarding', detail: '', criteria: {}, evidence: [] });
    }
    const tree = await t.json('GET', `/api/workspaces/${t.ws.id}/tree`);
    expect(tree.body.workspace.id).toBe(t.ws.id);
    expect(tree.body.children.map((c: { workspace: Workspace }) => c.workspace.id)).toEqual([a.id, b.id]);
    const rollup = await t.json('GET', `/api/workspaces/${t.ws.id}/rollup`);
    expect(rollup.body.symptoms).toHaveLength(2);
    expect(rollup.body.crossCutting).toHaveLength(1);
    expect(rollup.body.crossCutting[0].sourceWorkspaceIds).toEqual([a.id, b.id]);
    const profile = await t.json('GET', `/api/workspaces/${t.ws.id}/profile`);
    expect(profile.body).toEqual({ workspaceId: t.ws.id, data: {} });
  });

  it('unit proposals: list, accept with edits, reject, double decision 409', async () => {
    const t = setup();
    const mk = (name: string): UnitProposal =>
      t.store.unitProposals.insert({
        id: newId('unit'), workspaceId: t.ws.id, name, description: 'd', level: 'division', audiences: ['external'],
        evidence: [], reasoning: 'r', status: 'proposed', createdAt: new Date().toISOString(),
      });
    const p1 = mk('Payments');
    const p2 = mk('Hardware');
    const list = await t.json('GET', `/api/workspaces/${t.ws.id}/unit-proposals`);
    expect(list.body).toHaveLength(2);
    const acc = await t.json('POST', `/api/unit-proposals/${p1.id}`, { action: 'accept', edits: { name: 'Payments EU' } });
    expect(acc.status).toBe(200);
    expect(acc.body.workspace).toMatchObject({ name: 'Payments EU', parentWorkspaceId: t.ws.id });
    const rej = await t.json('POST', `/api/unit-proposals/${p2.id}`, { action: 'reject', reason: 'not a unit' });
    expect(rej.status).toBe(200);
    expect(rej.body.rating).toMatchObject({ verdict: 'disagree', reason: 'not a unit' });
    expect((await t.json('POST', `/api/unit-proposals/${p2.id}`, { action: 'reject' })).status).toBe(409);
    expect((await t.json('POST', '/api/unit-proposals/unit_nope', { action: 'reject' })).status).toBe(404);
  });
});

describe('findings synthesis override', () => {
  it('POST /api/findings/:id/include sets the override', async () => {
    const t = setup();
    t.store.findings.insert({
      id: 'fnd_u', workspaceId: t.ws.id, runId: 'r', taskId: 't', subject: 's', claim: 'c', criteria: {}, evidence: [],
      status: 'unverified', createdAt: '',
    });
    const on = await t.json('POST', '/api/findings/fnd_u/include', { include: true });
    expect(on).toMatchObject({ status: 200, body: { id: 'fnd_u', includeInSynthesis: true } });
    expect(t.store.findings.get('fnd_u')!.includeInSynthesis).toBe(true);
    const off = await t.json('POST', '/api/findings/fnd_u/include', { include: false });
    expect(off.body.includeInSynthesis).toBe(false);
    expect((await t.json('POST', '/api/findings/fnd_u/include', { include: 'yes' })).status).toBe(400);
    expect((await t.json('POST', '/api/findings/fnd_nope/include', { include: true })).status).toBe(404);
    const reset = await t.json('POST', '/api/findings/fnd_u/include', { include: null });
    expect(reset.status).toBe(200);
    expect(reset.body.includeInSynthesis).toBeUndefined();
    expect(t.store.findings.get('fnd_u')!.includeInSynthesis).toBeUndefined();
  });

  it('GET findings carries the last review (score + issues) of the finding task', async () => {
    const t = setup();
    t.store.findings.insert({
      id: 'fnd_u', workspaceId: t.ws.id, runId: 'r', taskId: 'tsk_1', subject: 's', claim: 'c', criteria: {}, evidence: [],
      status: 'unverified', createdAt: '',
    });
    t.store.findings.insert({
      id: 'fnd_v', workspaceId: t.ws.id, runId: 'r', taskId: 'tsk_2', subject: 's', claim: 'c2', criteria: {}, evidence: [],
      status: 'verified', createdAt: '',
    });
    const review = (score: number, at: string, issues: unknown[]) =>
      t.store.decisions.insert({
        id: newId('dec'), workspaceId: t.ws.id, agentRunId: newId('arun'), role: 'reviewer', model: { provider: 'codex', model: 'x' },
        promptVersion: 'v1', kind: 'review', payload: { tool: 'submit_review', score, issues }, refs: ['tsk_1'], createdAt: at,
      });
    review(4, '2026-11-12T00:00:00.000Z', [{ id: 'I1', class: 'blocking', description: 'no source' }]);
    const last = review(6, '2026-11-12T01:00:00.000Z', [{ id: 'I1', class: 'substantive', description: 'pricing outdated' }]);
    const r = await t.json('GET', `/api/workspaces/${t.ws.id}/findings`);
    const u = r.body.find((f: { id: string }) => f.id === 'fnd_u');
    expect(u.lastReview).toMatchObject({ score: 6, decisionId: last.id, issues: [{ class: 'substantive', description: 'pricing outdated' }] });
    expect(r.body.find((f: { id: string }) => f.id === 'fnd_v').lastReview).toBeUndefined();
  });
});

describe('current ratings', () => {
  it('GET ratings returns the latest rating per target + criterion (history kept)', async () => {
    const t = setup();
    const rec = addRec(t.store, t.ws.id);
    const rate = (b: Record<string, unknown>) =>
      t.json('POST', '/api/ratings', { workspaceId: t.ws.id, targetType: 'recommendation', targetId: rec.id, ...b });
    await rate({ criterion: 'upside', verdict: 'agree' });
    await new Promise((r) => setTimeout(r, 5));
    await rate({ criterion: 'upside', verdict: 'disagree', userValue: 1 });
    await rate({ criterion: 'difficulty', verdict: 'agree' });
    const r = await t.json('GET', `/api/workspaces/${t.ws.id}/ratings`);
    expect(r.status).toBe(200);
    expect(r.body).toHaveLength(2);
    expect(r.body.find((x: { criterion: string }) => x.criterion === 'upside')).toMatchObject({ verdict: 'disagree', userValue: 1 });
    expect(t.store.ratings.list({ workspaceId: t.ws.id })).toHaveLength(3);
  });
});

describe('ratings and review', () => {
  it('POST /api/ratings with unknown criterion → 400', async () => {
    const t = setup();
    const rec = addRec(t.store, t.ws.id);
    const r = await t.json('POST', '/api/ratings', {
      workspaceId: t.ws.id, targetType: 'recommendation', targetId: rec.id, criterion: 'vibes', verdict: 'agree',
    });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/criterion/);
  });

  it('accepts persona_feedback ratings with <recId>:<personaId> and drops them from the review queue', async () => {
    const t = setup();
    const rec = addRec(t.store, t.ws.id, {
      personaFeedback: [{
        personaId: 'per_1', scores: { appeal: 4, adoption: 3, willingnessToPay: 2, friction: 3 },
        concerns: [], reasoning: '', wouldChangeMind: '', simulated: true,
      }],
    });
    const q1 = await t.json('GET', `/api/workspaces/${t.ws.id}/review-queue`);
    const fbItem = q1.body.find((i: { targetType: string }) => i.targetType === 'persona_feedback');
    expect(fbItem).toMatchObject({ targetId: `${rec.id}:per_1`, unrated: ['appeal', 'adoption', 'willingnessToPay', 'friction'] });
    const r = await t.json('POST', '/api/ratings', {
      workspaceId: t.ws.id, targetType: 'persona_feedback', targetId: `${rec.id}:per_1`, criterion: 'appeal',
      verdict: 'disagree', userValue: 2, reason: 'too optimistic',
    });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ agentValue: 4, userValue: 2 });
    const q2 = await t.json('GET', `/api/workspaces/${t.ws.id}/review-queue`);
    expect(q2.body.find((i: { targetType: string }) => i.targetType === 'persona_feedback').unrated).not.toContain('appeal');
    const cal = await t.json('GET', `/api/workspaces/${t.ws.id}/calibration`);
    expect(cal.body.byCriterion).toEqual([expect.objectContaining({ targetType: 'persona_feedback', criterion: 'appeal', n: 1 })]);
  });

  it('prompt patch: propose does not write, apply writes and logs a Decision', async () => {
    const t = setup();
    const rec = addRec(t.store, t.ws.id);
    await t.json('POST', '/api/ratings', {
      workspaceId: t.ws.id, targetType: 'recommendation', targetId: rec.id, criterion: 'upside', verdict: 'disagree', userValue: 1,
    });
    const p = await t.json('POST', `/api/workspaces/${t.ws.id}/calibration/prompt-patch`, { role: 'synthesizer' });
    expect(p.status).toBe(200);
    expect(p.body.patchText).toContain('Calibration examples');
    expect(existsSync(join(calibration, 'synthesizer.md'))).toBe(false);
    const a = await t.json('POST', `/api/workspaces/${t.ws.id}/calibration/prompt-patch/apply`, p.body);
    expect(a.status).toBe(200);
    expect(readFileSync(join(calibration, 'synthesizer.md'), 'utf8')).toBe(p.body.patchText);
    const d = t.store.decisions.get(a.body.decisionId)!;
    expect(d.payload).toMatchObject({ actor: 'user', tool: 'apply_prompt_patch', role: 'synthesizer' });
    expect((await t.json('POST', `/api/workspaces/${t.ws.id}/calibration/prompt-patch`, { role: 'nobody' })).status).toBe(400);
  });

  it('PUT scoring-weights updates config, rescores and logs a Decision', async () => {
    const t = setup();
    const rec = addRec(t.store, t.ws.id, { priority: 0 });
    const r = await t.json('PUT', `/api/workspaces/${t.ws.id}/scoring-weights`, { weights: { upside: 3 }, personaWeight: 0.5 });
    expect(r.status).toBe(200);
    expect(t.config.scoring).toEqual({ weights: { upside: 3 }, personaWeight: 0.5 });
    expect(t.store.recommendations.get(rec.id)!.priority).toBeGreaterThan(0);
    const decisions = await t.json('GET', `/api/workspaces/${t.ws.id}/decisions?kind=decision`);
    expect((decisions.body as Decision[]).map((d) => (d.payload as { tool: string }).tool)).toContain('set_scoring_weights');
    expect(JSON.parse(readFileSync(t.configPath, 'utf8')).scoring.weights).toEqual({ upside: 3 });
    expect((await t.json('PUT', `/api/workspaces/${t.ws.id}/scoring-weights`, { weights: { vibes: 1 } })).status).toBe(400);
  });

  it('review queue includes unrated decision confidence and review score; rating drops them', async () => {
    const t = setup();
    const c1 = ctx(t.ws.id);
    const logged = t.store.decisions.insert({
      id: newId('dec'), workspaceId: t.ws.id, agentRunId: c1.agentRunId, role: 'worker', model: c1.model, promptVersion: 'v1',
      kind: 'decision', payload: { tool: 'log_decision', what: 'Focus on pricing', why: 'w', confidence: 0.6 }, refs: [],
      createdAt: new Date().toISOString(),
    });
    const review = t.store.decisions.insert({
      ...logged, id: newId('dec'), role: 'reviewer', kind: 'review', payload: { tool: 'submit_review', score: 6, issues: [] },
    });
    // System decisions carry no agent values and are not queued.
    t.store.decisions.insert({ ...logged, id: newId('dec'), agentRunId: 'user', payload: { actor: 'user', tool: 'set_scoring_weights' } });
    const q1 = await t.json('GET', `/api/workspaces/${t.ws.id}/review-queue`);
    const decisionItems = q1.body.filter((i: { targetType: string }) => i.targetType === 'decision');
    expect(decisionItems).toEqual([
      { targetType: 'decision', targetId: logged.id, title: 'Focus on pricing', criteria: { confidence: 0.6 }, unrated: ['confidence'] },
      expect.objectContaining({ targetId: review.id, criteria: { score: 6 }, unrated: ['score'] }),
    ]);
    const r = await t.json('POST', '/api/ratings', {
      workspaceId: t.ws.id, targetType: 'decision', targetId: logged.id, criterion: 'confidence', verdict: 'agree',
    });
    expect(r.status).toBe(201);
    const q2 = await t.json('GET', `/api/workspaces/${t.ws.id}/review-queue`);
    expect(q2.body.filter((i: { targetType: string }) => i.targetType === 'decision').map((i: { targetId: string }) => i.targetId)).toEqual([review.id]);
  });

  it('export downloads JSONL', async () => {
    const t = setup();
    const res = await t.app.request(`/api/workspaces/${t.ws.id}/export`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('ndjson');
    expect(res.headers.get('content-disposition')).toContain('attachment');
  });
});

describe('user requests', () => {
  it('resolving a request unblocks a pending request_approval', async () => {
    const t = setup();
    const c = ctx(t.ws.id);
    let settled = false;
    const call = t.handle(c, 'request_approval', { action: 'request a demo', site: 'acme.test', details: 'demo form' }).then((r) => {
      settled = true;
      return r;
    });
    await tick();
    const pending = await t.json('GET', `/api/workspaces/${t.ws.id}/requests?status=pending`);
    expect(pending.body).toHaveLength(1);
    expect(settled).toBe(false);
    const res = await t.json('POST', `/api/requests/${pending.body[0].id}`, { status: 'resolved', response: 'go ahead' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'resolved', response: 'go ahead' });
    expect(await call).toMatchObject({ ok: true, data: { approved: true, response: 'go ahead' } });
    expect((await t.json('GET', `/api/workspaces/${t.ws.id}/requests?status=pending`)).body).toEqual([]);
    expect((await t.json('POST', `/api/requests/${pending.body[0].id}`, { status: 'denied' })).status).toBe(409);
    expect((await t.json('POST', '/api/requests/ureq_nope', { status: 'denied' })).status).toBe(404);
    expect((await t.json('POST', `/api/requests/${pending.body[0].id}`, { status: 'maybe' })).status).toBe(400);
  });
});

describe('artifacts and uploads', () => {
  it('artifact bytes served with mime, and meta as JSON', async () => {
    const t = setup();
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
    const a = t.artifacts.save({ workspaceId: t.ws.id, kind: 'screenshot', mime: 'image/png', flow: 'signup', step: 1, bytes: png });
    const res = await t.app.request(`/api/artifacts/${a.id}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(png);
    const meta = await t.json('GET', `/api/artifacts/${a.id}/meta`);
    expect(meta.body).toMatchObject({ id: a.id, kind: 'screenshot', flow: 'signup', step: 1 });
    expect((await t.app.request('/api/artifacts/art_nope')).status).toBe(404);
  });

  it('multipart upload stores an upload artifact', async () => {
    const t = setup();
    const form = new FormData();
    form.append('file', new File(['kpi,1\n'], 'kpis.csv', { type: 'text/csv' }));
    const res = await t.app.request(`/api/workspaces/${t.ws.id}/uploads`, { method: 'POST', body: form });
    expect(res.status).toBe(201);
    const art = (await res.json()) as { id: string; kind: string; title: string };
    expect(art).toMatchObject({ kind: 'upload', title: 'kpis.csv' });
    expect(t.store.profiles.get(t.ws.id)!.data.uploads).toEqual([art.id]);
    const none = await t.app.request(`/api/workspaces/${t.ws.id}/uploads`, { method: 'POST', body: new FormData() });
    expect(none.status).toBe(400);
  });
});

describe('interview', () => {
  it('POST stores both turns and returns turns + coverage', async () => {
    const t = setup({ interviewFake: async () => 'What do you sell?' });
    const r = await t.json('POST', `/api/workspaces/${t.ws.id}/interview`, { text: 'Hi, we are Acme' });
    expect(r.status).toBe(200);
    expect(r.body.turns.map((x: { role: string }) => x.role)).toEqual(['user', 'agent']);
    expect(r.body.turn).toMatchObject({ role: 'agent', text: 'What do you sell?' });
    expect(r.body.coverage).toHaveProperty('basics', false);
    const g = await t.json('GET', `/api/workspaces/${t.ws.id}/interview`);
    expect(g.body.turns).toHaveLength(2);
    expect((await t.json('POST', `/api/workspaces/${t.ws.id}/interview`, { text: '  ' })).status).toBe(400);
  });
});

describe('research', () => {
  it('starts a pipeline in the background, 409 while one is running', async () => {
    const t = setup();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    t.deps.phaseRunners = { scoring: () => gate };
    const r = await t.json('POST', `/api/workspaces/${t.ws.id}/research`, { phases: ['scoring'] });
    expect(r.status).toBe(202);
    expect(r.body).toMatchObject({ phase: 'scoring', status: 'running' });
    expect((await t.json('POST', `/api/workspaces/${t.ws.id}/research`, { phases: ['scoring'] })).status).toBe(409);
    expect((await t.json('POST', `/api/workspaces/${t.ws.id}/research`, { phases: ['nope'] })).status).toBe(400);
    release();
    await tick();
    const runs = await t.json('GET', `/api/workspaces/${t.ws.id}/runs`);
    expect(runs.body).toEqual([expect.objectContaining({ id: r.body.id, status: 'done' })]);
    const tasks = await t.json('GET', `/api/workspaces/${t.ws.id}/tasks?runId=${r.body.id}`);
    expect(tasks.body).toEqual([]);
  });
});

describe('schedules and config', () => {
  it('create, list and patch (id in body); invalid cron 400', async () => {
    const t = setup();
    const c = await t.json('POST', `/api/workspaces/${t.ws.id}/schedules`, { name: 'weekly', cron: '0 9 * * 1', phases: ['deep_dives'] });
    expect(c.status).toBe(201);
    expect(c.body).toMatchObject({ enabled: true, phases: ['deep_dives'] });
    expect((await t.json('POST', `/api/workspaces/${t.ws.id}/schedules`, { name: 'x', cron: 'every day', phases: ['deep_dives'] })).status).toBe(400);
    const p = await t.json('PATCH', `/api/workspaces/${t.ws.id}/schedules`, { id: c.body.id, enabled: false });
    expect(p.status).toBe(200);
    expect(p.body.enabled).toBe(false);
    const list = await t.json('GET', `/api/workspaces/${t.ws.id}/schedules`);
    expect((list.body as Schedule[]).map((s) => s.enabled)).toEqual([false]);
    expect((await t.json('PATCH', `/api/workspaces/${t.ws.id}/schedules`, { id: 'sch_nope', enabled: true })).status).toBe(404);
  });

  it('schedules get an activation baseline on create and on re-enable only', async () => {
    const t = setup();
    const c = await t.json('POST', `/api/workspaces/${t.ws.id}/schedules`, { name: 'daily', cron: '0 9 * * *', phases: ['scoring'] });
    const created = Date.parse(c.body.activatedAt);
    expect(Math.abs(created - Date.now())).toBeLessThan(5000);
    t.store.schedules.update(c.body.id, { activatedAt: '2026-01-01T00:00:00.000Z' });
    const renamed = await t.json('PATCH', `/api/workspaces/${t.ws.id}/schedules`, { id: c.body.id, name: 'daily 2', enabled: true });
    expect(renamed.body.activatedAt).toBe('2026-01-01T00:00:00.000Z'); // already enabled: unchanged
    await t.json('PATCH', `/api/workspaces/${t.ws.id}/schedules`, { id: c.body.id, enabled: false });
    const re = await t.json('PATCH', `/api/workspaces/${t.ws.id}/schedules`, { id: c.body.id, enabled: true });
    expect(Date.parse(re.body.activatedAt)).toBeGreaterThan(Date.parse('2026-01-01T00:00:00.000Z'));
  });

  it('PUT config with changed scoring rescores and logs a Decision in every workspace', async () => {
    const t = setup();
    const other = createWorkspace(t.store, { name: 'Beta', sector: 'retail' });
    const rec = addRec(t.store, other.id, { priority: 0 });
    const g = await t.json('GET', '/api/config');
    const p = await t.json('PUT', '/api/config', { ...g.body, scoring: { personaWeight: 0, weights: { upside: 2 } } });
    expect(p.status).toBe(200);
    expect(t.store.recommendations.get(rec.id)!.priority).toBeGreaterThan(0);
    for (const id of [t.ws.id, other.id]) {
      const ds = t.store.decisions.list({ workspaceId: id }).map((d) => d.payload as Record<string, unknown>);
      expect(ds).toEqual([expect.objectContaining({ tool: 'set_scoring_weights', source: 'config', actor: 'user' })]);
    }
    // Unchanged scoring: nothing logged.
    await t.json('PUT', '/api/config', { ...p.body, loop: { ...p.body.loop, maxRounds: 4 } });
    expect(t.store.decisions.list({ workspaceId: t.ws.id })).toHaveLength(1);
  });

  it('persisting config keeps boot-time dataDir/port overrides out of the file', async () => {
    const t = researchSetup(opened);
    const configPath = join(t.dir, 'bif.config.json');
    t.config.dataDir = '/tmp/override-data';
    t.config.server.port = 5555;
    const app = createApp({
      store: t.store, artifacts: t.artifacts, events: t.events, config: t.config, research: t.deps, configPath,
      fileValues: { dataDir: 'data', port: 4317 },
    });
    const put = (b: unknown) => app.request('/api/config', { method: 'PUT', body: JSON.stringify(b), headers: { 'content-type': 'application/json' } });
    const current = (await (await app.request('/api/config')).json()) as any;
    expect((await put({ ...current, loop: { ...current.loop, maxRounds: 4 } })).status).toBe(200);
    let file = JSON.parse(readFileSync(configPath, 'utf8'));
    expect(file.dataDir).toBe('data');
    expect(file.server.port).toBe(4317);
    expect(file.loop.maxRounds).toBe(4);
    expect(t.config.dataDir).toBe('/tmp/override-data'); // runtime keeps the override
    // A value the user changes explicitly is persisted.
    expect((await put({ ...current, server: { ...current.server, port: 6000 } })).status).toBe(200);
    file = JSON.parse(readFileSync(configPath, 'utf8'));
    expect(file.server.port).toBe(6000);
  });

  it('GET/PUT config validates, applies in place and persists', async () => {
    const t = setup();
    const g = await t.json('GET', '/api/config');
    expect(g.body.server.port).toBe(4317);
    const next = { ...g.body, scoring: { personaWeight: 0.25, weights: {} } };
    const p = await t.json('PUT', '/api/config', next);
    expect(p.status).toBe(200);
    expect(t.config.scoring.personaWeight).toBe(0.25);
    expect(JSON.parse(readFileSync(t.configPath, 'utf8')).scoring.personaWeight).toBe(0.25);
    const bad = await t.json('PUT', '/api/config', { ...g.body, loop: { ...g.body.loop, maxRounds: 0 } });
    expect(bad.status).toBe(400);
    expect(bad.body.issues[0].path).toBe('loop.maxRounds');
    expect(t.config.loop.maxRounds).toBe(3);
  });
});

describe('events', () => {
  it('SSE emits run_event for the workspace only', async () => {
    const t = setup();
    const ac = new AbortController();
    const res = await t.app.request(`/api/events?workspaceId=${t.ws.id}`, { signal: ac.signal });
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let text = dec.decode((await reader.read()).value); // connection comment
    t.events.emit({ type: 'run_event', workspaceId: 'ws_other', agentRunId: 'arun_x', event: { t: 'message', text: 'other' } });
    t.events.emit({ type: 'run_event', workspaceId: t.ws.id, agentRunId: 'arun_1', event: { t: 'message', text: 'hello' } });
    while (!text.includes('hello')) text += dec.decode((await reader.read()).value);
    const data = text.split('\n').filter((l) => l.startsWith('data: ')).map((l) => JSON.parse(l.slice(6)));
    expect(data).toEqual([{ type: 'run_event', workspaceId: t.ws.id, agentRunId: 'arun_1', event: { t: 'message', text: 'hello' } }]);
    await reader.cancel();
    ac.abort();
  });
});
