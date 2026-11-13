import { afterEach, describe, expect, it } from 'vitest';
import type { RunContext } from '../../src/core/harness/tokens.js';
import { buildInterviewPrompt } from '../../src/core/interview/interview.js';
import { runTaskWithReview } from '../../src/core/research/reviewLoop.js';
import { researchToolHandlers } from '../../src/core/research/tools.js';
import { calibrationReport } from '../../src/core/scoring/calibration.js';
import { exportTrainingData } from '../../src/core/scoring/export.js';
import { rateCriterion } from '../../src/core/scoring/ratings.js';
import { reviewQueue } from '../../src/core/scoring/reviewQueue.js';
import type { Store } from '../../src/core/store/db.js';
import { newId } from '../../src/core/store/repos.js';
import { addTask, researchSetup, review } from './helpers/research.js';

const opened: Store[] = [];
afterEach(() => {
  for (const s of opened.splice(0)) s.close();
});

function setup() {
  const t = researchSetup(opened, { extraHandlers: () => researchToolHandlers() });
  t.store.workspaces.insert({ id: 'ws_a', name: 'Acme', sector: 'saas', createdAt: 'now' });
  t.store.workspaces.insert({ id: 'ws_b', name: 'Beta', sector: 'retail', createdAt: 'now' });
  const art = t.artifacts.save({ workspaceId: 'ws_a', kind: 'text', mime: 'text/plain', bytes: 'Globex pricing page' });
  return { ...t, art: art.id };
}

const ctx = (extra: Partial<RunContext> = {}): RunContext => ({
  agentRunId: newId('arun'), workspaceId: 'ws_a', role: 'worker', model: { provider: 'claude', model: 'sonnet' }, promptVersion: 'pv', ...extra,
});

const competitor = (evidence: string[], extra: Record<string, unknown> = {}) => ({
  name: 'Globex', site: 'globex.com', threat: 4, directness: 5, comparison: { pricing: 2, onboarding: 4, ux: 3, features: 5 }, evidence, ...extra,
});

describe('save_competitor (final review C4)', () => {
  it('creates a rated competitor with a score Decision; same name updates it', async () => {
    const t = setup();
    const task = addTask(t.store, { type: 'discover_competitors', phase: 'competitor_discovery' });
    const c1 = ctx({ taskId: task.id });
    const r = await t.handle(c1, 'save_competitor', competitor([t.art]));
    expect(r.ok).toBe(true);
    const id = (r as { data: { competitorId: string } }).data.competitorId;
    expect(t.store.competitors.get(id)).toMatchObject({
      workspaceId: 'ws_a', name: 'Globex', site: 'globex.com', threat: 4, directness: 5, taskId: task.id,
      comparison: { pricing: 2, onboarding: 4, ux: 3, features: 5 }, evidence: [t.art],
    });
    const d = t.store.decisions.list({ agentRunId: c1.agentRunId });
    expect(d).toHaveLength(1);
    expect(d[0]).toMatchObject({ kind: 'score', payload: { tool: 'save_competitor', competitorId: id }, refs: [id, t.art] });

    // Replay: nothing new.
    expect(await t.handle(c1, 'save_competitor', competitor([t.art]))).toMatchObject({ ok: true, data: { competitorId: id, duplicate: true } });
    // Same name (case/space-insensitive), new values → update in place + revision Decision.
    const r2 = await t.handle(ctx(), 'save_competitor', competitor([t.art], { name: ' globex ', threat: 2 }));
    expect((r2 as { data: { competitorId: string } }).data.competitorId).toBe(id);
    expect(t.store.competitors.list({ workspaceId: 'ws_a' })).toHaveLength(1);
    expect(t.store.competitors.get(id)!.threat).toBe(2);
    expect(t.store.decisions.list({ workspaceId: 'ws_a', kind: 'score' })).toHaveLength(2);
  });

  it('validates scales and evidence; only workers have the tool', async () => {
    const t = setup();
    expect((await t.handle(ctx(), 'save_competitor', competitor([t.art], { threat: 6 }))).ok).toBe(false);
    expect((await t.handle(ctx(), 'save_competitor', competitor([]))).ok).toBe(false);
    const foreign = t.artifacts.save({ workspaceId: 'ws_b', kind: 'text', mime: 'text/plain', bytes: 'beta' });
    const bad = await t.handle(ctx(), 'save_competitor', competitor([foreign.id]));
    expect(bad.ok).toBe(false);
    expect((await t.handle(ctx({ role: 'reviewer' }), 'save_competitor', competitor([t.art]))).ok).toBe(false);
    expect(t.store.competitors.list()).toHaveLength(0);
  });

  it('competitor criteria are ratable, queued for review, joined in export and calibrated per task type', async () => {
    const t = setup();
    const task = addTask(t.store, { type: 'flow_walkthrough' });
    const run = t.store.agentRuns.insert({
      id: newId('arun'), workspaceId: 'ws_a', taskId: task.id, role: 'worker', model: { provider: 'claude', model: 'sonnet' }, token: 'tok',
      status: 'done', startedAt: 'now',
    });
    const r = await t.handle(ctx({ agentRunId: run.id, taskId: task.id }), 'save_competitor', competitor([t.art]));
    const id = (r as { data: { competitorId: string } }).data.competitorId;

    const q = reviewQueue('ws_a', t).find((i) => i.targetType === 'competitor')!;
    expect(q).toMatchObject({ targetId: id, title: 'Globex', criteria: { threat: 4, directness: 5, pricing: 2, onboarding: 4, ux: 3, features: 5 } });
    expect(q.unrated.sort()).toEqual(['directness', 'features', 'onboarding', 'pricing', 'threat', 'ux']);

    const rating = rateCriterion({ workspaceId: 'ws_a', targetType: 'competitor', targetId: id, criterion: 'pricing', verdict: 'disagree', userValue: 4 }, t);
    expect(rating.agentValue).toBe(2);
    expect(reviewQueue('ws_a', t).find((i) => i.targetType === 'competitor')!.unrated).not.toContain('pricing');

    const rows = exportTrainingData('ws_a', t).trim().split('\n').map((l) => JSON.parse(l));
    const row = rows.find((x) => x.decision.payload.tool === 'save_competitor');
    expect(row.ratings.map((x: { id: string }) => x.id)).toEqual([rating.id]);

    expect(calibrationReport('ws_a', t).byRoleTask).toEqual([
      { role: 'worker', taskType: 'flow_walkthrough', targetType: 'competitor', criterion: 'pricing', n: 1, agreeRate: 0, meanDelta: 0.5 },
    ]);
  });
});

describe('save_hypothesis + interview drill-down (final review C6)', () => {
  it('persists hypotheses; the interviewer prompt includes them and verified finding titles', async () => {
    const t = setup();
    t.store.symptoms.insert({
      id: 'sym_1', workspaceId: 'ws_a', kind: 'symptom', title: 'enterprise renewals down', detail: 'd',
      criteria: { severity: 4, trend: '↓', causeConfidence: 40 }, evidence: [],
    });
    const fnd = (id: string, status: 'verified' | 'unverified', claim: string) =>
      t.store.findings.insert({
        id, workspaceId: 'ws_a', runId: 'rr', taskId: 'tsk_x', subject: 'Acme', claim, criteria: {}, evidence: [t.art], status, createdAt: 'now',
      });
    fnd('fnd_v', 'verified', 'Acme raised enterprise prices 20% in March');
    fnd('fnd_u', 'unverified', 'UNVERIFIED rumour about churn');
    const task = addTask(t.store, { type: 'symptom_hypotheses', phase: 'synthesis' });
    const c = ctx({ taskId: task.id });

    const r = await t.handle(c, 'save_hypothesis', {
      symptom_id: 'sym_1', hypothesis: 'Renewals fell after the March enterprise price increase', confidence: 70, evidence: ['fnd_v', 'fnd_u'],
    });
    expect(r.ok).toBe(true);
    const hid = (r as { data: { hypothesisId: string } }).data.hypothesisId;
    expect(t.store.symptomHypotheses.get(hid)).toMatchObject({ symptomId: 'sym_1', confidence: 70, taskId: task.id, evidence: ['fnd_v', 'fnd_u'] });
    expect(t.store.decisions.list({ agentRunId: c.agentRunId })[0]).toMatchObject({ kind: 'score', payload: { tool: 'save_hypothesis', hypothesisId: hid } });
    // Replay is idempotent; unknown symptom / evidence rejected.
    expect(await t.handle(c, 'save_hypothesis', { symptom_id: 'sym_1', hypothesis: 'renewals fell after the march enterprise price increase', confidence: 70, evidence: ['fnd_v'] }))
      .toMatchObject({ ok: true, data: { hypothesisId: hid, duplicate: true } });
    expect((await t.handle(c, 'save_hypothesis', { symptom_id: 'sym_nope', hypothesis: 'h', confidence: 10, evidence: ['fnd_v'] })).ok).toBe(false);
    expect((await t.handle(c, 'save_hypothesis', { symptom_id: 'sym_1', hypothesis: 'h', confidence: 10, evidence: ['art_nope'] })).ok).toBe(false);
    expect(t.store.symptomHypotheses.list()).toHaveLength(1);

    const prompt = buildInterviewPrompt(t.store.workspaces.get('ws_a')!, t.store);
    expect(prompt).toContain('Research hypotheses per symptom');
    expect(prompt).toContain('enterprise renewals down');
    expect(prompt).toContain('Hypothesis (70% confidence): Renewals fell after the March enterprise price increase');
    expect(prompt).toContain('verified finding: Acme: Acme raised enterprise prices 20% in March');
    expect(prompt).toContain('## Verified research findings');
    expect(prompt).not.toContain('UNVERIFIED rumour');
  });

  it('symptom_hypotheses workers see the symptom ids and the save_hypothesis instructions', async () => {
    const t = setup();
    t.store.symptoms.insert({
      id: 'sym_1', workspaceId: 'ws_a', kind: 'symptom', title: 'enterprise renewals down', detail: 'd',
      criteria: { severity: 4, trend: '↓', causeConfidence: 40 }, evidence: [],
    });
    const task = addTask(t.store, { type: 'symptom_hypotheses', phase: 'synthesis' });
    t.state.pick = (req) =>
      req.kind === 'review'
        ? review(9)
        : async (tools) => {
            await tools.call('save_hypothesis', { symptom_id: 'sym_1', hypothesis: 'price change', confidence: 60, evidence: [t.art] });
            await tools.call('submit_result', { hypotheses: 1 });
          };
    await runTaskWithReview(task, t.deps);
    const work = t.requests.find((r) => r.kind === 'work')!;
    expect(work.prompt).toContain('[sym_1] enterprise renewals down');
    expect(work.systemPrompt).toContain('save_hypothesis');
    expect(t.store.symptomHypotheses.list({ workspaceId: 'ws_a' })).toHaveLength(1);
  });
});
