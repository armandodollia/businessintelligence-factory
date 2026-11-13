import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { defaultConfig } from '../../src/core/config/schema.js';
import { EventBus } from '../../src/core/events.js';
import { ArtifactStore } from '../../src/core/evidence/artifacts.js';
import { createToolHandlers } from '../../src/core/harness/tools/handlers.js';
import { interviewToolHandlers } from '../../src/core/interview/interview.js';
import { uploadInternal } from '../../src/core/internal/uploads.js';
import { workspaceContext } from '../../src/core/research/orchestrator.js';
import { projectSimplex, proposeWeights, simplexLeastSquares } from '../../src/core/scoring/calibration.js';
import { criterionDef, normalizedDelta } from '../../src/core/scoring/criteria.js';
import { exportTrainingData } from '../../src/core/scoring/export.js';
import { checkRecommendationCriteria, computePriority, costScore, normalizeCriterion } from '../../src/core/scoring/priority.js';
import { rateCriterion } from '../../src/core/scoring/ratings.js';
import { openStore, type Store } from '../../src/core/store/db.js';
import type { Criteria, Decision, Recommendation } from '../../src/core/types.js';

const opened: Store[] = [];
afterEach(() => {
  for (const s of opened.splice(0)) s.close();
});

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'bif-r2-'));
  const store = openStore(join(dir, 'bif.db'));
  opened.push(store);
  const config = structuredClone(defaultConfig);
  const artifacts = new ArtifactStore(store, dir);
  store.workspaces.insert({ id: 'ws_a', name: 'Acme', sector: 'saas', createdAt: 'now' });
  return { dir, store, config, artifacts };
}

const NOW = new Date().toISOString();
const rec = (id: string, criteria: Criteria): Recommendation => ({
  id, workspaceId: 'ws_a', title: id, summary: 's', criteria, findingIds: [], personaFeedback: [], priority: 0, createdAt: NOW,
});
const decision = (over: Partial<Decision>): Decision => ({
  id: 'dec_x', workspaceId: 'ws_a', agentRunId: 'run_1', role: 'worker', model: { provider: 'claude', model: 'sonnet' },
  kind: 'decision', payload: {}, refs: [], promptVersion: 'pv', createdAt: NOW, ...over,
});
const finding = (id: string, evidence: string[], subject = 'Acme') => ({
  id, workspaceId: 'ws_a', runId: 'r', taskId: 't', subject, claim: `claim ${id}`, criteria: {}, evidence,
  status: 'verified' as const, createdAt: NOW,
});
const ids = (jsonl: string) => jsonl.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l).decision.id as string);

describe('proposeWeights fits the weighted-mean model', () => {
  function overrides(t: ReturnType<typeof setup>, rows: Array<{ criteria: Criteria; y: number }>) {
    rows.forEach(({ criteria, y }, i) => {
      t.store.recommendations.insert(rec(`rec_${i}`, criteria));
      rateCriterion({ workspaceId: 'ws_a', targetType: 'recommendation', targetId: `rec_${i}`, criterion: 'priority', verdict: 'disagree', userValue: y }, t);
    });
  }

  it('user priority = upside, risk = 2×upside → proposed weights reproduce user priorities', () => {
    const t = setup();
    const rows = Array.from({ length: 8 }, (_, i) => {
      const upside = (i % 2) + 1; // 1 or 2, so risk = 2×upside stays within 1–5
      return { criteria: { upside, risk: 2 * upside }, y: upside };
    });
    overrides(t, rows);
    const w = proposeWeights('ws_a', t);
    expect(w.risk).toBeCloseTo(0, 2);
    expect(w.upside).toBeGreaterThan(0);
    for (const r of rows) expect(computePriority({ criteria: r.criteria, personaFeedback: [] }, { weights: w, personaWeight: 0 })).toBeCloseTo(r.y, 1);
  });

  it('a 2:1 mix of two criteria is recovered as a 2:1 weight ratio and reproduces priorities', () => {
    const t = setup();
    const rows = Array.from({ length: 10 }, (_, i) => {
      const upside = (i % 5) + 1;
      const strategicFit = ((i * 3) % 5) + 1;
      return { criteria: { upside, strategicFit }, y: (2 * upside + strategicFit) / 3 };
    });
    overrides(t, rows);
    const w = proposeWeights('ws_a', t);
    expect(w.upside! / w.strategicFit!).toBeCloseTo(2, 1);
    for (const r of rows) expect(computePriority({ criteria: r.criteria, personaFeedback: [] }, { weights: w, personaWeight: 0 })).toBeCloseTo(r.y, 1);
  });

  it('beats "unconstrained fit then rescale" when the user scale is not a convex combination', () => {
    const t = setup();
    // y = 1.2·upside + 0.3·strategicFit: unconstrained LS gives β = (1.2, 0.3) → rescaled 4:1, which is
    // not the best weighted-mean fit; the simplex fit pushes weight toward upside and lowers the error.
    const rows = Array.from({ length: 10 }, (_, i) => {
      const upside = (i % 5) + 1;
      const strategicFit = ((i * 3) % 5) + 1;
      return { criteria: { upside, strategicFit }, y: 1.2 * upside + 0.3 * strategicFit };
    });
    overrides(t, rows);
    const w = proposeWeights('ws_a', t);
    const sse = (weights: Record<string, number>) =>
      rows.reduce((s, r) => s + (computePriority({ criteria: r.criteria, personaFeedback: [] }, { weights, personaWeight: 0 }) - r.y) ** 2, 0);
    const oldRescaled = { ...w, upside: 1.6, strategicFit: 0.4 };
    expect(sse(w)).toBeLessThan(sse(oldRescaled) - 0.1);
  });

  it('simplex helpers', () => {
    expect(projectSimplex([0.5, 0.5])).toEqual([0.5, 0.5]);
    expect(projectSimplex([2, 0])).toEqual([1, 0]);
    const a = simplexLeastSquares([[1, 5], [5, 1], [3, 3]], [1, 5, 3]);
    expect(a[0]).toBeCloseTo(1, 3);
    expect(a[1]).toBeCloseTo(0, 3);
  });
});

describe('pct units are declared per criterion', () => {
  it('percent criteria: 0%, 1%, 2% boundaries (1%→2% is +0.01 on the fraction scale)', () => {
    const conf = criterionDef('recommendation', 'confidence')!;
    expect(conf.unit).toBe('percent');
    expect(normalizedDelta(conf, 1, 2)).toBeCloseTo(0.01, 10);
    expect(normalizedDelta(conf, 0, 1)).toBeCloseTo(0.01, 10);
    expect(normalizedDelta(conf, 0, 2)).toBeCloseTo(0.02, 10);
    const cause = criterionDef('symptom', 'causeConfidence')!;
    expect(cause.unit).toBe('percent');
    expect(normalizedDelta(cause, 1, 2)).toBeCloseTo(0.01, 10);
    expect(normalizeCriterion('confidence', 0)).toBe(0);
    expect(normalizeCriterion('confidence', 1)).toBeCloseTo(0.05, 10);
    expect(normalizeCriterion('confidence', 2)).toBeCloseTo(0.1, 10);
    expect(checkRecommendationCriteria({ confidence: 0 })).toBeUndefined();
    expect(checkRecommendationCriteria({ confidence: 1 })).toBeUndefined();
  });

  it('fraction criteria: decision confidence and persona fields are 0–1', () => {
    const dec = criterionDef('decision', 'confidence')!;
    expect(dec.unit).toBe('fraction');
    expect(normalizedDelta(dec, 0.01, 0.02)).toBeCloseTo(0.01, 10);
    expect(normalizedDelta(dec, 0, 1)).toBeCloseTo(1, 10);
    const persona = criterionDef('persona', 'pain_points')!;
    expect(persona.unit).toBe('fraction');
    expect(normalizedDelta(persona, 0.5, 0.6)).toBeCloseTo(0.1, 10);
  });
});

describe('cost formats', () => {
  const amount = (n: number) => Math.log10(n) - 2;
  it('parses money words and ISO codes; rejects non-money units', () => {
    expect(costScore('$2 million')).toBeCloseTo(amount(2e6), 6);
    expect(costScore('2 million USD')).toBeCloseTo(amount(2e6), 6);
    expect(costScore('€500k–€1M')).toBeCloseTo(amount(750_000), 6);
    expect(costScore('EUR 40,000')).toBeCloseTo(amount(40_000), 6);
    expect(costScore('GBP 2-3 thousand')).toBeCloseTo(amount(2_500), 6);
    expect(costScore('1.5 billion')).toBe(5);
    for (const bad of ['3 months', '6 weeks', '2 FTE', '40 hours', '3 engineers', '1-2 sprints']) {
      expect(costScore(bad)).toBeUndefined();
      expect(checkRecommendationCriteria({ cost: bad })).toMatch(/cost/);
    }
    expect(checkRecommendationCriteria({ cost: '$2 million' })).toBeUndefined();
    expect(checkRecommendationCriteria({ cost: '2 million USD' })).toBeUndefined();
    expect(checkRecommendationCriteria({ cost: '€500k–€1M' })).toBeUndefined();
  });
});

describe('export r2', () => {
  it('excludes decisions referencing a finding or symptom whose evidence includes an upload (one hop)', () => {
    const t = setup();
    const up = uploadInternal('ws_a', { name: 'kpi.csv', bytes: new TextEncoder().encode('secret kpis'), mime: 'text/csv' }, t);
    const pub = t.artifacts.save({ workspaceId: 'ws_a', kind: 'text', mime: 'text/plain', bytes: 'public' });
    t.store.findings.insert(finding('fnd_up', [pub.id, up.id]));
    t.store.findings.insert(finding('fnd_pub', [pub.id]));
    t.store.symptoms.insert({ id: 'sym_up', workspaceId: 'ws_a', kind: 'symptom', title: 's', detail: 'd', criteria: {}, evidence: [up.id] });
    t.store.decisions.insert(decision({ id: 'dec_f_up', refs: ['fnd_up'] }));
    t.store.decisions.insert(decision({ id: 'dec_s_up', refs: ['sym_up'] }));
    t.store.decisions.insert(decision({ id: 'dec_f_pub', refs: ['fnd_pub'] }));
    expect(ids(exportTrainingData('ws_a', t))).toEqual(['dec_f_pub']);
    expect(ids(exportTrainingData('ws_a', t, true))).toEqual(['dec_f_up', 'dec_s_up', 'dec_f_pub']);
  });

  it('non-persona decisions join ratings of their primary subject only', () => {
    const t = setup();
    t.store.findings.insert(finding('fnd_1', []));
    t.store.recommendations.insert(rec('rec_1', { upside: 4 }));
    t.store.decisions.insert(decision({ id: 'dec_f', kind: 'score', payload: { tool: 'save_finding', findingId: 'fnd_1' }, refs: ['fnd_1'] }));
    t.store.decisions.insert(decision({ id: 'dec_r', kind: 'score', payload: { tool: 'save_recommendation', recommendationId: 'rec_1' }, refs: ['rec_1', 'fnd_1'] }));
    t.store.decisions.insert(decision({ id: 'dec_log', refs: ['fnd_1', 'rec_1'] }));
    rateCriterion({ workspaceId: 'ws_a', targetType: 'finding', targetId: 'fnd_1', criterion: 'relevance', verdict: 'disagree', userValue: 2 }, t);
    rateCriterion({ workspaceId: 'ws_a', targetType: 'recommendation', targetId: 'rec_1', criterion: 'upside', verdict: 'agree' }, t);
    const rows = exportTrainingData('ws_a', t).trim().split('\n').map((l) => JSON.parse(l));
    const crits = (id: string) => rows.find((r) => r.decision.id === id).ratings.map((x: { criterion: string }) => x.criterion).sort();
    expect(crits('dec_f')).toEqual(['relevance']);
    expect(crits('dec_r')).toEqual(['upside']); // not the finding it cites
    expect(crits('dec_log')).toEqual(['relevance', 'upside']); // no primary subject → refs
  });
});

describe('competitor ratings', () => {
  it('require at least one finding with that subject', () => {
    const t = setup();
    expect(() => rateCriterion({ workspaceId: 'ws_a', targetType: 'competitor', targetId: 'Globex', criterion: 'threat', verdict: 'agree' }, t)).toThrow(/not found/);
    t.store.findings.insert(finding('fnd_g', [], 'Globex'));
    expect(rateCriterion({ workspaceId: 'ws_a', targetType: 'competitor', targetId: 'Globex', criterion: 'threat', verdict: 'agree' }, t).agentValue).toBeNull();
  });
});

describe('profile uploads key', () => {
  it('update_profile cannot set, replace or delete uploads', async () => {
    const t = setup();
    const up = uploadInternal('ws_a', { name: 'deck.pdf', bytes: new Uint8Array([1, 2]), mime: 'application/pdf' }, t);
    const handle = createToolHandlers({ ...t, events: new EventBus(), extraHandlers: interviewToolHandlers() });
    const ctx = { agentRunId: 'run_x', workspaceId: 'ws_a', role: 'interviewer' as const, model: t.config.roles.interviewer, promptVersion: 'pv' };
    for (const patch of [{ uploads: null, sector: 'saas' }, { uploads: ['art_fake'] }, { uploads: { x: 1 } }]) {
      const r = await handle(ctx, 'update_profile', { patch });
      expect(r.ok).toBe(true);
      expect(t.store.profiles.get('ws_a')!.data.uploads).toEqual([up.id]);
    }
    expect(t.store.profiles.get('ws_a')!.data.sector).toBe('saas');
  });
});

describe('orchestrator upload context', () => {
  it('lists uploads via listUploads (id + title), including sha-deduped ones', () => {
    const t = setup();
    const doc = t.artifacts.save({ workspaceId: 'ws_a', kind: 'document', mime: 'text/plain', bytes: 'board deck' });
    uploadInternal('ws_a', { name: 'board-deck.txt', bytes: new TextEncoder().encode('board deck'), mime: 'text/plain' }, t);
    const up = uploadInternal('ws_a', { name: 'kpis.csv', bytes: new TextEncoder().encode('a,b'), mime: 'text/csv' }, t);
    const ctx = workspaceContext(t.store, t.store.workspaces.get('ws_a')!).join('\n');
    const section = ctx.slice(ctx.indexOf('## Internal uploads'));
    expect(section).toContain(`[${doc.id}]`);
    expect(section).toContain(`[${up.id}] kpis.csv`);
    expect(section).not.toContain('a,b');
  });
});
