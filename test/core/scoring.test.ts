import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { defaultConfig } from '../../src/core/config/schema.js';
import { EventBus } from '../../src/core/events.js';
import { ArtifactStore } from '../../src/core/evidence/artifacts.js';
import { Supervisor } from '../../src/core/harness/supervisor.js';
import { TokenRegistry } from '../../src/core/harness/tokens.js';
import { createToolHandlers } from '../../src/core/harness/tools/handlers.js';
import { uploadInternal } from '../../src/core/internal/uploads.js';
import { loadPrompt } from '../../src/core/prompts/index.js';
import { applyPromptPatch, calibrationReport, proposePromptPatch, proposeWeights } from '../../src/core/scoring/calibration.js';
import { CRITERIA, PERSONA_FIELDS, RECOMMENDATION_KEYS } from '../../src/core/scoring/criteria.js';
import { exportTrainingData } from '../../src/core/scoring/export.js';
import { checkRecommendationCriteria, computePriority, costScore, scoreRecommendations, scoringToolHandlers } from '../../src/core/scoring/priority.js';
import { rateCriterion } from '../../src/core/scoring/ratings.js';
import { openStore, type Store } from '../../src/core/store/db.js';
import type { Decision, Finding, PersonaFeedback, Recommendation } from '../../src/core/types.js';

const opened: Store[] = [];
let prevCalDir: string | undefined;
beforeEach(() => {
  prevCalDir = process.env.BIF_CALIBRATION_DIR;
  process.env.BIF_CALIBRATION_DIR = mkdtempSync(join(tmpdir(), 'bif-cal-'));
});
afterEach(() => {
  for (const s of opened.splice(0)) s.close();
  if (prevCalDir === undefined) delete process.env.BIF_CALIBRATION_DIR;
  else process.env.BIF_CALIBRATION_DIR = prevCalDir;
});

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'bif-score-'));
  const store = openStore(join(dir, 'bif.db'));
  opened.push(store);
  const config = structuredClone(defaultConfig);
  const artifacts = new ArtifactStore(store, dir);
  store.workspaces.insert({ id: 'ws_a', name: 'Acme', sector: 'saas', createdAt: 'now' });
  return { dir, store, config, artifacts };
}

const NOW = new Date().toISOString();
const crit = { upside: 4, difficulty: 2, cost: 2, timeToValue: 2, risk: 2, confidence: 80, strategicFit: 4, competitiveUrgency: 3 };

function rec(over: Partial<Recommendation> = {}): Recommendation {
  return {
    id: over.id ?? 'rec_1', workspaceId: 'ws_a', title: 'Fix onboarding', summary: 's', criteria: crit,
    findingIds: [], personaFeedback: [], priority: 0, createdAt: NOW, ...over,
  };
}

const fb = (personaId: string, n: number): PersonaFeedback => ({
  personaId, scores: { appeal: n, adoption: n, willingnessToPay: n, friction: 6 - n }, concerns: [], reasoning: 'r',
  wouldChangeMind: 'w', simulated: true,
});

function decision(over: Partial<Decision>): Decision {
  return {
    id: 'dec_x', workspaceId: 'ws_a', agentRunId: 'run_1', role: 'worker', model: { provider: 'claude', model: 'sonnet' },
    kind: 'decision', payload: {}, refs: [], promptVersion: 'pv', createdAt: NOW, ...over,
  };
}

describe('criteria', () => {
  it('covers spec §9 targets', () => {
    expect(RECOMMENDATION_KEYS).toEqual(['upside', 'difficulty', 'cost', 'timeToValue', 'risk', 'confidence', 'strategicFit', 'competitiveUrgency']);
    expect(CRITERIA.persona.map((c) => c.key)).toEqual([...PERSONA_FIELDS]);
    expect(CRITERIA.persona_feedback.map((c) => c.key)).toEqual(['appeal', 'adoption', 'willingnessToPay', 'friction']);
    expect(CRITERIA.symptom.map((c) => c.key)).toEqual(['severity', 'trend', 'causeConfidence']);
  });
});

describe('priority', () => {
  it('persona weight 0 → priority unaffected by persona scores', () => {
    const cfg = { personaWeight: 0, weights: {} };
    const base = computePriority(rec(), cfg);
    expect(computePriority(rec({ personaFeedback: [fb('p1', 5), fb('p2', 5)] }), cfg)).toBe(base);
    expect(computePriority(rec({ personaFeedback: [fb('p1', 1)] }), cfg)).toBe(base);
    const weighted = { personaWeight: 1, weights: {} };
    expect(computePriority(rec({ personaFeedback: [fb('p1', 5)] }), weighted)).toBeGreaterThan(base);
  });

  it('difficulty inverted', () => {
    const cfg = { personaWeight: 0, weights: {} };
    const only = (difficulty: number) => computePriority(rec({ criteria: { difficulty } }), cfg);
    expect(only(1)).toBe(5);
    expect(only(5)).toBe(1);
    expect(computePriority(rec({ criteria: { upside: 5 } }), cfg)).toBe(5);
    expect(computePriority(rec({ criteria: { ...crit, difficulty: 5 } }), cfg)).toBeLessThan(computePriority(rec(), cfg));
  });

  it('weights, pct confidence, range in 0–5 with 2 decimals', () => {
    // confidence is a percent 0–100 for recommendations: 20 → 1 on the 0–5 scale.
    const p = computePriority(rec({ criteria: { upside: 5, confidence: 20 } }), { personaWeight: 0, weights: { upside: 3 } });
    expect(p).toBe(Math.round(((3 * 5 + 1 * 1) / 4) * 100) / 100);
    expect(computePriority(rec({ criteria: {} }), { personaWeight: 0, weights: {} })).toBe(0);
    const any = computePriority(rec({ criteria: { ...crit, cost: '$10k-$50k' } }), { personaWeight: 0, weights: {} });
    expect(any).toBeGreaterThanOrEqual(0);
    expect(any).toBeLessThanOrEqual(5);
  });

  it('cost ranges parse to a midpoint on a log scale; higher cost → lower priority', () => {
    expect(costScore('$1k')).toBe(1);
    expect(costScore('$500')).toBe(1);
    expect(costScore('10k-50k')).toBeCloseTo(Math.log10(30_000) - 2, 6);
    expect(costScore('$10–$50')).toBe(1);
    expect(costScore('$1M–$5M')).toBeCloseTo(Math.log10(3_000_000) - 2, 6);
    expect(costScore('$1-5M')).toBeCloseTo(Math.log10(3_000_000) - 2, 6);
    expect(costScore('$20M+')).toBe(5);
    expect(costScore(250_000)).toBeCloseTo(Math.log10(250_000) - 2, 6);
    expect(costScore(3)).toBe(3);
    expect(costScore('2-3')).toBe(2.5);
    expect(costScore('high')).toBe(4);
    expect(costScore('a lot')).toBeUndefined();

    const cfg = { personaWeight: 0, weights: {} };
    const at = (cost: string | number) => computePriority(rec({ criteria: { upside: 4, cost } }), cfg);
    const ladder = ['$5k', '10k-50k', '$200k', '$1M–$5M', '$50M'].map(at);
    for (let i = 1; i < ladder.length; i++) expect(ladder[i]!).toBeLessThan(ladder[i - 1]!);
    expect(at('$1M–$5M')).toBeLessThan(at('$10k–$50k'));
  });

  it('save_recommendation validates criteria scales (pct 0–100, 1–5, parseable cost)', () => {
    expect(checkRecommendationCriteria(crit)).toBeUndefined();
    expect(checkRecommendationCriteria({ ...crit, cost: '$10k–$50k' })).toBeUndefined();
    expect(checkRecommendationCriteria({ confidence: 140 })).toMatch(/0–100/);
    expect(checkRecommendationCriteria({ upside: 7 })).toMatch(/1–5/);
    expect(checkRecommendationCriteria({ cost: 'pricey' })).toMatch(/cost/);
  });

  it('scoreRecommendations stores priority', () => {
    const t = setup();
    t.store.recommendations.insert(rec());
    scoreRecommendations('ws_a', t);
    expect(t.store.recommendations.get('rec_1')!.priority).toBe(computePriority(rec(), t.config.scoring));
  });

  it('save_recommendation handler stores rec with computed priority + score decision', async () => {
    const t = setup();
    const finding: Finding = {
      id: 'fnd_1', workspaceId: 'ws_a', runId: 'r', taskId: 't', subject: 'x', claim: 'c', criteria: {}, evidence: [],
      status: 'verified', createdAt: NOW,
    };
    t.store.findings.insert(finding);
    const events = new EventBus();
    const handle = createToolHandlers({ ...t, events, extraHandlers: scoringToolHandlers() });
    const sup = new Supervisor({ store: t.store, config: t.config, tokens: new TokenRegistry(t.store), events, handle, dataDir: t.dir, mcpBaseUrl: 'http://127.0.0.1:1' });
    const errors: string[] = [];
    const out = await sup.run({
      ctx: { workspaceId: 'ws_a', role: 'synthesizer', model: t.config.roles.synthesizer, promptVersion: 'pv' },
      prompt: 'p', systemPrompt: 's', needsBrowser: false,
      fake: async (tools) => {
        await tools.call('save_recommendation', { title: 'T', summary: 'S', criteria: crit, finding_ids: ['fnd_1'] });
        await tools.call('save_recommendation', { title: 'T', summary: 'S', criteria: crit, finding_ids: ['fnd_nope'] }).catch((e: Error) => errors.push(e.message));
        await tools.call('save_recommendation', { title: 'T', summary: 'S', criteria: { bogus: 1 }, finding_ids: ['fnd_1'] }).catch((e: Error) => errors.push(e.message));
      },
    });
    expect(out.status).toBe('done');
    expect(errors).toHaveLength(2);
    const recs = t.store.recommendations.list({ workspaceId: 'ws_a' });
    expect(recs).toHaveLength(1);
    expect(recs[0]!.priority).toBe(computePriority(recs[0]!, t.config.scoring));
    expect(t.store.decisions.list({ kind: 'score' })[0]!.refs).toEqual([recs[0]!.id, 'fnd_1']);
  });
});

describe('ratings', () => {
  it('rateCriterion stores agentValue snapshot', () => {
    const t = setup();
    t.store.recommendations.insert(rec({ personaFeedback: [fb('per_1', 4)] }));
    const r = rateCriterion({ workspaceId: 'ws_a', targetType: 'recommendation', targetId: 'rec_1', criterion: 'upside', verdict: 'disagree', userValue: 2, reason: 'small market' }, t);
    expect(r).toMatchObject({ agentValue: 4, userValue: 2, verdict: 'disagree' });
    t.store.recommendations.update('rec_1', { criteria: { ...crit, upside: 1 } });
    expect(t.store.ratings.get(r.id)!.agentValue).toBe(4);

    const pf = rateCriterion({ workspaceId: 'ws_a', targetType: 'persona_feedback', targetId: 'rec_1:per_1', criterion: 'willingnessToPay', verdict: 'agree' }, t);
    expect(pf.agentValue).toBe(4);

    t.store.personas.insert({
      id: 'per_1', workspaceId: 'ws_a', slug: 'it-lead', segment: 'IT', agentMdPath: 'x', version: 1,
      profile: { pain_points: { value: 'v', confidence: 0.7, evidence: [] } },
    });
    expect(rateCriterion({ workspaceId: 'ws_a', targetType: 'persona', targetId: 'per_1', criterion: 'pain_points', verdict: 'agree' }, t).agentValue).toBe(0.7);
    expect(rateCriterion({ workspaceId: 'ws_a', targetType: 'persona', targetId: 'per_1', criterion: 'voice', verdict: 'agree' }, t).agentValue).toBeNull();
    expect(rateCriterion({ workspaceId: 'ws_a', targetType: 'recommendation', targetId: 'rec_1', criterion: 'priority', verdict: 'disagree', userValue: 1 }, t).agentValue).toBe(0);
  });

  it('rejects unknown criterion', () => {
    const t = setup();
    t.store.recommendations.insert(rec());
    expect(() => rateCriterion({ workspaceId: 'ws_a', targetType: 'recommendation', targetId: 'rec_1', criterion: 'vibes', verdict: 'agree' }, t)).toThrow(/criterion/);
    expect(() => rateCriterion({ workspaceId: 'ws_a', targetType: 'persona_feedback', targetId: 'rec_1:p', criterion: 'upside', verdict: 'agree' }, t)).toThrow(/criterion/);
    expect(() => rateCriterion({ workspaceId: 'ws_a', targetType: 'recommendation', targetId: 'rec_nope', criterion: 'upside', verdict: 'agree' }, t)).toThrow(/not found/);
    expect(() => rateCriterion({ workspaceId: 'ws_a', targetType: 'recommendation', targetId: 'rec_1', criterion: 'upside', verdict: 'disagree' }, t)).toThrow(/userValue/);
    expect(t.store.ratings.list()).toHaveLength(0);
  });
});

describe('calibration', () => {
  it('calibrationReport groups by targetType + criterion', () => {
    const t = setup();
    t.store.recommendations.insert(rec());
    const base = { workspaceId: 'ws_a', targetType: 'recommendation' as const, targetId: 'rec_1', criterion: 'upside' };
    rateCriterion({ ...base, verdict: 'agree' }, t);
    rateCriterion({ ...base, verdict: 'disagree', userValue: 2 }, t);
    const rep = calibrationReport('ws_a', t);
    // meanDelta is normalized per scale: (2 − 4)/4 = −0.5 and an agree counts 0 → −0.25.
    expect(rep.byCriterion).toEqual([{ targetType: 'recommendation', criterion: 'upside', n: 2, agreeRate: 0.5, meanDelta: -0.25 }]);
  });

  it('proposeWeights returns current when n<5', () => {
    const t = setup();
    t.config.scoring.weights = { upside: 2 };
    for (let i = 0; i < 4; i++) {
      t.store.recommendations.insert(rec({ id: `rec_${i}` }));
      rateCriterion({ workspaceId: 'ws_a', targetType: 'recommendation', targetId: `rec_${i}`, criterion: 'priority', verdict: 'disagree', userValue: 3 }, t);
    }
    const w = proposeWeights('ws_a', t);
    expect(w.upside).toBe(2);
    for (const k of RECOMMENDATION_KEYS.filter((k) => k !== 'upside')) expect(w[k]).toBe(1);
  });

  it('proposeWeights fits user priorities when n>=5', () => {
    const t = setup();
    for (let i = 0; i < 8; i++) {
      const upside = (i % 5) + 1;
      t.store.recommendations.insert(rec({ id: `rec_${i}`, criteria: { upside, risk: ((i * 3) % 5) + 1 } }));
      rateCriterion({ workspaceId: 'ws_a', targetType: 'recommendation', targetId: `rec_${i}`, criterion: 'priority', verdict: 'disagree', userValue: upside }, t);
    }
    const w = proposeWeights('ws_a', t);
    expect(w.upside!).toBeGreaterThan(w.risk!);
  });

  it('proposePromptPatch + applyPromptPatch change the prompt version', () => {
    const t = setup();
    t.store.symptoms.insert({ id: 'sym_1', workspaceId: 'ws_a', kind: 'symptom', title: 'renewals down', detail: 'd', criteria: { severity: 5, trend: '↓', causeConfidence: 90 }, evidence: [] });
    rateCriterion({ workspaceId: 'ws_a', targetType: 'symptom', targetId: 'sym_1', criterion: 'severity', verdict: 'disagree', userValue: 2, reason: 'only one account churned' }, t);
    rateCriterion({ workspaceId: 'ws_a', targetType: 'symptom', targetId: 'sym_1', criterion: 'causeConfidence', verdict: 'disagree', userValue: 30 }, t);
    rateCriterion({ workspaceId: 'ws_a', targetType: 'symptom', targetId: 'sym_1', criterion: 'trend', verdict: 'agree' }, t);
    const patch = proposePromptPatch('ws_a', 'interviewer', t);
    expect(patch.role).toBe('interviewer');
    expect(patch.examples.map((e) => e.criterion)).toEqual(['severity', 'causeConfidence']);
    expect(patch.examples[0]).toEqual({ criterion: 'severity', agentValue: 5, userValue: 2, reason: 'only one account churned' });
    expect(patch.patchText).toContain('Calibration examples');
    expect(patch.patchText).toContain('renewals down');
    expect(proposePromptPatch('ws_a', 'worker', t).examples).toHaveLength(0);

    const before = loadPrompt('interviewer').version;
    const { path } = applyPromptPatch(patch);
    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path, 'utf8')).toContain('only one account churned');
    const after = loadPrompt('interviewer');
    expect(after.version).not.toBe(before);
    expect(after.text).toContain('only one account churned');
  });
});

describe('export', () => {
  it('export excludes upload-linked decisions by default', () => {
    const t = setup();
    const up = uploadInternal('ws_a', { name: 'kpi.csv', bytes: new TextEncoder().encode('x'), mime: 'text/csv' }, t);
    const doc = t.artifacts.save({ workspaceId: 'ws_a', kind: 'document', mime: 'text/plain', bytes: 'public page' });
    t.store.decisions.insert(decision({ id: 'dec_pub', refs: [doc.id] }));
    t.store.decisions.insert(decision({ id: 'dec_up', refs: ['sym_1', up.id] }));
    t.store.decisions.insert(decision({ id: 'dec_other', workspaceId: 'ws_b' }));
    rateCriterion({ workspaceId: 'ws_a', targetType: 'decision', targetId: 'dec_pub', criterion: 'confidence', verdict: 'agree' }, t);

    const rows = exportTrainingData('ws_a', t).trim().split('\n').map((l) => JSON.parse(l));
    expect(rows.map((r) => r.decision.id)).toEqual(['dec_pub']);
    expect(rows[0].ratings).toHaveLength(1);
    expect(rows[0].ratings[0]).toMatchObject({ targetId: 'dec_pub', criterion: 'confidence' });

    const all = exportTrainingData('ws_a', t, true).trim().split('\n').map((l) => JSON.parse(l));
    expect(all.map((r) => r.decision.id)).toEqual(['dec_pub', 'dec_up']);
  });

  it('export joins ratings on payload ids; persona feedback ratings join only their persona', () => {
    const t = setup();
    t.store.recommendations.insert(rec({ personaFeedback: [fb('per_1', 3), fb('per_2', 4)] }));
    t.store.decisions.insert(decision({ id: 'dec_rec', kind: 'score', payload: { tool: 'save_recommendation', recommendationId: 'rec_1' }, refs: ['rec_1'] }));
    const pf = (id: string, personaId: string) =>
      decision({
        id, kind: 'persona_feedback', role: 'persona',
        payload: { tool: 'submit_persona_feedback', input: { recommendation_id: 'rec_1' }, personaId, targetId: `rec_1:${personaId}` },
        refs: ['rec_1', personaId],
      });
    t.store.decisions.insert(pf('dec_pf1', 'per_1'));
    t.store.decisions.insert(pf('dec_pf2', 'per_2'));
    rateCriterion({ workspaceId: 'ws_a', targetType: 'recommendation', targetId: 'rec_1', criterion: 'risk', verdict: 'agree' }, t);
    rateCriterion({ workspaceId: 'ws_a', targetType: 'persona_feedback', targetId: 'rec_1:per_1', criterion: 'appeal', verdict: 'agree' }, t);
    rateCriterion({ workspaceId: 'ws_a', targetType: 'persona_feedback', targetId: 'rec_1:per_2', criterion: 'friction', verdict: 'disagree', userValue: 5 }, t);
    const rows = exportTrainingData('ws_a', t).trim().split('\n').map((l) => JSON.parse(l));
    const crits = (id: string) => rows.find((r) => r.decision.id === id).ratings.map((x: { criterion: string }) => x.criterion);
    expect(crits('dec_rec')).toEqual(['risk']);
    expect(crits('dec_pf1')).toEqual(['appeal']);
    expect(crits('dec_pf2')).toEqual(['friction']);
  });

  it('export excludes decisions citing an ancestor workspace upload, or an artifact listed in profile.uploads', () => {
    const t = setup();
    t.store.workspaces.insert({ id: 'ws_child', name: 'Child', sector: 'saas', createdAt: 'now', parentWorkspaceId: 'ws_a' });
    const parentUpload = uploadInternal('ws_a', { name: 'financials.xlsx', bytes: new TextEncoder().encode('secret'), mime: 'text/csv' }, t);
    // Same bytes saved first as a 'document' → upload sha-dedupes onto it (kind stays document).
    const doc = t.artifacts.save({ workspaceId: 'ws_child', kind: 'document', mime: 'text/plain', bytes: 'board deck' });
    const deduped = uploadInternal('ws_child', { name: 'deck.txt', bytes: new TextEncoder().encode('board deck'), mime: 'text/plain' }, t);
    expect(deduped.id).toBe(doc.id);
    expect(deduped.kind).toBe('document');
    const pub = t.artifacts.save({ workspaceId: 'ws_child', kind: 'text', mime: 'text/plain', bytes: 'public' });
    t.store.decisions.insert(decision({ id: 'dec_parent_up', workspaceId: 'ws_child', refs: [parentUpload.id] }));
    t.store.decisions.insert(decision({ id: 'dec_dedup_up', workspaceId: 'ws_child', refs: [doc.id] }));
    t.store.decisions.insert(decision({ id: 'dec_pub', workspaceId: 'ws_child', refs: [pub.id] }));
    const ids = (s: string) => s.trim().split('\n').map((l) => JSON.parse(l).decision.id);
    expect(ids(exportTrainingData('ws_child', t))).toEqual(['dec_pub']);
    expect(ids(exportTrainingData('ws_child', t, true))).toEqual(['dec_parent_up', 'dec_dedup_up', 'dec_pub']);
  });
});
