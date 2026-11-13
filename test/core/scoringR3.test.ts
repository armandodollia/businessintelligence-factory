import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { defaultConfig } from '../../src/core/config/schema.js';
import { EventBus } from '../../src/core/events.js';
import { ArtifactStore } from '../../src/core/evidence/artifacts.js';
import type { RunContext } from '../../src/core/harness/tokens.js';
import { createToolHandlers } from '../../src/core/harness/tools/handlers.js';
import { interviewToolHandlers } from '../../src/core/interview/interview.js';
import { uploadInternal } from '../../src/core/internal/uploads.js';
import { proposePromptPatch, proposeWeights } from '../../src/core/scoring/calibration.js';
import { exportTrainingData } from '../../src/core/scoring/export.js';
import { computePriority, scoringToolHandlers } from '../../src/core/scoring/priority.js';
import { rateCriterion } from '../../src/core/scoring/ratings.js';
import { openStore, type Store } from '../../src/core/store/db.js';
import type { Criteria, Decision, PersonaFeedback, Recommendation } from '../../src/core/types.js';

const opened: Store[] = [];
afterEach(() => {
  for (const s of opened.splice(0)) s.close();
});

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'bif-r3-'));
  const store = openStore(join(dir, 'bif.db'));
  opened.push(store);
  const config = structuredClone(defaultConfig);
  const artifacts = new ArtifactStore(store, dir);
  const events = new EventBus();
  store.workspaces.insert({ id: 'ws_a', name: 'Acme', sector: 'saas', createdAt: 'now' });
  const handle = createToolHandlers({
    store, artifacts, config, events, extraHandlers: { ...interviewToolHandlers(), ...scoringToolHandlers() },
  });
  return { dir, store, config, artifacts, events, handle };
}

const NOW = new Date().toISOString();
const tick = () => new Promise((r) => setTimeout(r, 5));
const ctx = (role: RunContext['role'], t: ReturnType<typeof setup>): RunContext => ({
  agentRunId: 'run_1', workspaceId: 'ws_a', role, model: t.config.roles[role === 'interviewer' ? 'interviewer' : 'synthesizer'], promptVersion: 'pv',
});
const finding = (id: string, evidence: string[]) => ({
  id, workspaceId: 'ws_a', runId: 'r', taskId: 't', subject: 'Acme', claim: `claim ${id}`, criteria: {}, evidence,
  status: 'verified' as const, createdAt: NOW,
});
const rec = (id: string, criteria: Criteria, personaFeedback: PersonaFeedback[] = []): Recommendation => ({
  id, workspaceId: 'ws_a', title: id, summary: 's', criteria, findingIds: [], personaFeedback, priority: 0, createdAt: NOW,
});
const fb = (personaId: string, appeal: number, friction: number): PersonaFeedback => ({
  personaId, scores: { appeal, adoption: appeal, willingnessToPay: appeal, friction }, concerns: [], reasoning: 'r',
  wouldChangeMind: 'w', simulated: true,
});
const decision = (over: Partial<Decision>): Decision => ({
  id: 'dec_x', workspaceId: 'ws_a', agentRunId: 'run_1', role: 'worker', model: { provider: 'claude', model: 'sonnet' },
  kind: 'decision', payload: {}, refs: [], promptVersion: 'pv', createdAt: NOW, ...over,
});

describe('save_recommendation revisions', () => {
  it('upside 1 → 5 creates a second score Decision; ratings join the judgment current at rating time', async () => {
    const t = setup();
    t.store.findings.insert(finding('fnd_1', []));
    const save = (upside: number, summary = 'S') =>
      t.handle(ctx('synthesizer', t), 'save_recommendation', { title: 'Cut prices', summary, criteria: { upside }, finding_ids: ['fnd_1'] });
    const first = await save(1);
    expect(first.ok).toBe(true);
    const recId = (first as { data: { recommendationId: string } }).data.recommendationId;
    await tick();
    rateCriterion({ workspaceId: 'ws_a', targetType: 'recommendation', targetId: recId, criterion: 'upside', verdict: 'disagree', userValue: 3 }, t);
    await tick();
    expect((await save(5)).ok).toBe(true);
    const scores = t.store.decisions.list({ kind: 'score' });
    expect(scores).toHaveLength(2);
    expect((scores[1]!.payload as { criteria: Criteria; revisionOf: string }).criteria).toEqual({ upside: 5 });
    expect((scores[1]!.payload as { revisionOf: string }).revisionOf).toBe(scores[0]!.id);
    // identical replay → deduped
    expect((await save(5)).ok).toBe(true);
    expect(t.store.decisions.list({ kind: 'score' })).toHaveLength(2);
    await tick();
    rateCriterion({ workspaceId: 'ws_a', targetType: 'recommendation', targetId: recId, criterion: 'upside', verdict: 'agree' }, t);

    const rows = exportTrainingData('ws_a', t).trim().split('\n').map((l) => JSON.parse(l));
    const ratingsOf = (id: string) => rows.find((r) => r.decision.id === id).ratings as Array<{ verdict: string; agentValue: number }>;
    expect(ratingsOf(scores[0]!.id).map((r) => [r.verdict, r.agentValue])).toEqual([['disagree', 1]]);
    expect(ratingsOf(scores[1]!.id).map((r) => [r.verdict, r.agentValue])).toEqual([['agree', 5]]);
  });
});

describe('proposeWeights: complete formula', () => {
  it('personaWeight = 3 dataset → proposed weights reproduce user priorities', () => {
    const t = setup();
    t.config.scoring.personaWeight = 3;
    const truth = { personaWeight: 3, weights: { upside: 2, risk: 1 } };
    const rows = Array.from({ length: 10 }, (_, i) => {
      const criteria = { upside: (i % 5) + 1, risk: ((i * 2) % 5) + 1 };
      const feedback = i % 3 === 0 ? [] : [fb(`per_${i}`, ((i * 7) % 5) + 1, ((i * 3) % 5) + 1)];
      const r = rec(`rec_${i}`, criteria, feedback);
      return { r, y: computePriority(r, truth) };
    });
    for (const { r, y } of rows) {
      t.store.recommendations.insert(r);
      rateCriterion({ workspaceId: 'ws_a', targetType: 'recommendation', targetId: r.id, criterion: 'priority', verdict: 'disagree', userValue: y }, t);
    }
    const w = proposeWeights('ws_a', t);
    for (const { r, y } of rows) {
      expect(Math.abs(computePriority(r, { personaWeight: 3, weights: w }) - y)).toBeLessThanOrEqual(0.03);
    }
    expect(w.upside! / w.risk!).toBeCloseTo(2, 0);
  });

  it('agree priority ratings count as samples (y = agentValue)', () => {
    const t = setup();
    const crit = (i: number) => ({ upside: (i % 5) + 1, strategicFit: ((i * 3) % 5) + 1 });
    // 3 disagreements alone are too few; 2 agreements make 5 samples.
    for (let i = 0; i < 5; i++) {
      const r = rec(`rec_${i}`, crit(i));
      r.priority = computePriority(r, { weights: { upside: 1, strategicFit: 0 }, personaWeight: 0 }); // agent priority = upside
      t.store.recommendations.insert(r);
    }
    for (let i = 0; i < 3; i++) {
      rateCriterion({ workspaceId: 'ws_a', targetType: 'recommendation', targetId: `rec_${i}`, criterion: 'priority', verdict: 'disagree', userValue: crit(i).upside }, t);
    }
    expect(proposeWeights('ws_a', t)).toMatchObject({ upside: 1, strategicFit: 1 }); // n = 3 → current
    for (let i = 3; i < 5; i++) {
      rateCriterion({ workspaceId: 'ws_a', targetType: 'recommendation', targetId: `rec_${i}`, criterion: 'priority', verdict: 'agree' }, t);
    }
    const w = proposeWeights('ws_a', t);
    expect(w.strategicFit).toBeCloseTo(0, 2);
    expect(w.upside).toBeGreaterThan(1);
  });
});

describe('proposePromptPatch', () => {
  it('excludes priority and uses only the latest rating per (target, criterion)', () => {
    const t = setup();
    t.store.recommendations.insert(rec('rec_1', { upside: 5, risk: 1, strategicFit: 5 }));
    const r = (criterion: string, verdict: 'agree' | 'disagree', userValue?: number) =>
      rateCriterion({ workspaceId: 'ws_a', targetType: 'recommendation', targetId: 'rec_1', criterion, verdict, ...(userValue !== undefined && { userValue }) }, t);
    r('priority', 'disagree', 1);
    r('upside', 'disagree', 1);
    r('upside', 'agree'); // the user changed their mind
    r('risk', 'disagree', 5);
    r('risk', 'disagree', 2); // latest value wins
    r('strategicFit', 'disagree', 4);
    const patch = proposePromptPatch('ws_a', 'synthesizer', t);
    const got = patch.examples.map((e) => [e.criterion, e.userValue]);
    expect(got).toHaveLength(2);
    expect(got).toEqual(expect.arrayContaining([['strategicFit', 4], ['risk', 2]]));
    expect(patch.patchText).not.toContain('`priority`');
  });
});

describe('rateCriterion validates userValue by scale and unit', () => {
  it('rejects out-of-scale values and accepts valid ones', () => {
    const t = setup();
    t.store.recommendations.insert(rec('rec_1', { upside: 3, confidence: 50, cost: '$10k' }, [fb('per_1', 3, 3)]));
    t.store.symptoms.insert({ id: 'sym_1', workspaceId: 'ws_a', kind: 'symptom', title: 's', detail: 'd', criteria: { severity: 3, trend: '↓', causeConfidence: 40 }, evidence: [] });
    t.store.personas.insert({ id: 'per_1', workspaceId: 'ws_a', slug: 'p', segment: 'P', agentMdPath: 'x', version: 1, profile: { goals: { value: 'v', confidence: 0.5, evidence: [] } } });
    t.store.decisions.insert(decision({ id: 'dec_r', kind: 'review', payload: { tool: 'submit_review', score: 7 } }));
    const bad: Array<[string, string, string, unknown]> = [
      ['recommendation', 'rec_1', 'upside', 7],
      ['recommendation', 'rec_1', 'upside', 'great'],
      ['recommendation', 'rec_1', 'confidence', 150],
      ['recommendation', 'rec_1', 'cost', '3 months'],
      ['recommendation', 'rec_1', 'priority', 6],
      ['symptom', 'sym_1', 'trend', 'sideways'],
      ['symptom', 'sym_1', 'causeConfidence', -5],
      ['persona', 'per_1', 'goals', 1.5],
      ['persona_feedback', 'rec_1:per_1', 'friction', 0],
      ['decision', 'dec_r', 'score', 11],
    ];
    for (const [targetType, targetId, criterion, userValue] of bad) {
      expect(() => rateCriterion({ workspaceId: 'ws_a', targetType, targetId, criterion, verdict: 'disagree', userValue } as never, t)).toThrow(/userValue/);
    }
    expect(t.store.ratings.list()).toHaveLength(0);
    const good: Array<[string, string, string, unknown]> = [
      ['recommendation', 'rec_1', 'upside', 2],
      ['recommendation', 'rec_1', 'confidence', 1],
      ['recommendation', 'rec_1', 'cost', '$2 million'],
      ['recommendation', 'rec_1', 'priority', 4.5],
      ['symptom', 'sym_1', 'trend', 'up'],
      ['persona', 'per_1', 'goals', 0.9],
      ['decision', 'dec_r', 'score', 9],
    ];
    for (const [targetType, targetId, criterion, userValue] of good) {
      rateCriterion({ workspaceId: 'ws_a', targetType, targetId, criterion, verdict: 'disagree', userValue } as never, t);
    }
    expect(t.store.ratings.list()).toHaveLength(good.length);
  });
});

describe('interviewer can read uploads', () => {
  it('read_artifact is in the interviewer role and returns the upload', async () => {
    const t = setup();
    const up = uploadInternal('ws_a', { name: 'kpis.csv', bytes: new TextEncoder().encode('renewals,-12%'), mime: 'text/csv' }, t);
    const r = await t.handle(ctx('interviewer', t), 'read_artifact', { artifact_id: up.id });
    expect(r.ok).toBe(true);
    expect((r as { data: { text: string } }).data.text).toContain('renewals,-12%');
  });
});

describe('export: recommendation → findings → evidence', () => {
  it('excludes decisions about a recommendation whose findings cite an upload', () => {
    const t = setup();
    const up = uploadInternal('ws_a', { name: 'kpi.csv', bytes: new TextEncoder().encode('secret'), mime: 'text/csv' }, t);
    t.store.findings.insert(finding('fnd_up', [up.id]));
    t.store.findings.insert(finding('fnd_pub', []));
    t.store.recommendations.insert({ ...rec('rec_up', { upside: 4 }), findingIds: ['fnd_up'] });
    t.store.recommendations.insert({ ...rec('rec_pub', { upside: 4 }), findingIds: ['fnd_pub'] });
    t.store.decisions.insert(decision({ id: 'dec_pf_up', kind: 'persona_feedback', refs: ['rec_up'] }));
    t.store.decisions.insert(decision({ id: 'dec_log_up', refs: ['rec_up'] }));
    t.store.decisions.insert(decision({ id: 'dec_pf_pub', kind: 'persona_feedback', refs: ['rec_pub'] }));
    const ids = (s: string) => s.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l).decision.id);
    expect(ids(exportTrainingData('ws_a', t))).toEqual(['dec_pf_pub']);
    expect(ids(exportTrainingData('ws_a', t, true))).toEqual(['dec_pf_up', 'dec_log_up', 'dec_pf_pub']);
  });
});
