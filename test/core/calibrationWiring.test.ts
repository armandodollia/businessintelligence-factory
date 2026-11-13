import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { FakeScript } from '../../src/core/harness/adapter.js';
import type { RunContext } from '../../src/core/harness/tokens.js';
import { runPersonaPanel } from '../../src/core/market/panel.js';
import { marketToolHandlers } from '../../src/core/market/personas.js';
import { loadPrompt, PROMPTS_DIR, promptTemplate } from '../../src/core/prompts/index.js';
import { runTaskWithReview } from '../../src/core/research/reviewLoop.js';
import { reviewerSystemPrompt, workerSystemPrompt } from '../../src/core/research/systemPrompts.js';
import { applyPromptPatch, calibrationScope } from '../../src/core/scoring/calibration.js';
import { PERSONA_FIELDS } from '../../src/core/scoring/criteria.js';
import { exportTrainingData } from '../../src/core/scoring/export.js';
import { rateCriterion } from '../../src/core/scoring/ratings.js';
import type { Store } from '../../src/core/store/db.js';
import { newId } from '../../src/core/store/repos.js';
import type { Decision, Rating, Recommendation } from '../../src/core/types.js';
import { addTask, researchSetup, review, submitWork } from './helpers/research.js';

const opened: Store[] = [];
afterEach(() => {
  for (const s of opened.splice(0)) s.close();
});

const scopeOf = (t: { dir: string }, rootWorkspaceId = 'ws_a') => ({ dataDir: t.dir, rootWorkspaceId });

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'bif-calwire-'));
  const t = researchSetup(opened, { dir, extraHandlers: () => marketToolHandlers({ dataDir: dir }) });
  t.store.workspaces.insert({
    id: 'ws_a', name: 'Acme', sector: 'saas', createdAt: 'now',
    scope: { level: 'company', name: 'Acme', description: '' }, audiences: ['external', 'internal'],
  });
  const art = t.artifacts.save({ workspaceId: 'ws_a', kind: 'text', mime: 'text/plain', bytes: 'G2 reviews of Acme' });
  return { ...t, art: art.id };
}

const ctx = (extra: Partial<RunContext> = {}): RunContext => ({
  agentRunId: newId('arun'), workspaceId: 'ws_a', role: 'worker', model: { provider: 'claude', model: 'sonnet' },
  promptVersion: 'pv', ...extra,
});

function personaInput(evidence: string[], extra: Record<string, unknown> = {}) {
  const profile: Record<string, unknown> = {};
  for (const f of PERSONA_FIELDS) profile[f] = { value: `${f} value`, confidence: 0.6, evidence };
  return { segment: 'SMB finance lead', audience: 'external', profile, ...extra };
}

function rec(id: string): Recommendation {
  return {
    id, workspaceId: 'ws_a', title: `Rec ${id}`, summary: `Do ${id}`, criteria: { upside: 4 }, findingIds: [],
    personaFeedback: [], priority: 0, createdAt: new Date().toISOString(), status: 'verified',
  };
}

function feedbackScript(prompt: string, appeal: number): FakeScript {
  const recId = /Recommendation id: (\S+)/.exec(prompt)![1]!;
  return async (tools) => {
    await tools.call('submit_persona_feedback', {
      recommendation_id: recId, scores: { appeal, adoption: 3, willingness_to_pay: 2, friction: 4 },
      concerns: ['price'], reasoning: 'in character', would_change_mind: 'a free tier',
    });
  };
}

async function panelSeeded() {
  const t = setup();
  for (const [segment, audience] of [['SMB finance lead', 'external'], ['Payments ops analyst', 'internal']] as const) {
    expect((await t.handle(ctx(), 'save_persona', personaInput([t.art], { segment, audience }))).ok).toBe(true);
  }
  for (const p of t.store.personas.list({ workspaceId: 'ws_a' })) t.store.personas.update(p.id, { status: 'verified' });
  t.store.recommendations.insert(rec('rec_1'));
  t.state.pick = (req) =>
    req.role === 'persona' ? feedbackScript(req.prompt, req.systemPrompt.includes('name: smb-finance-lead') ? 5 : 1) : undefined;
  return t;
}

describe('save_persona audience', () => {
  it('rejects an audience the workspace does not declare', async () => {
    const t = setup();
    t.store.workspaces.insert({ id: 'ws_ext', name: 'Ext', sector: 'saas', createdAt: 'now', audiences: ['external'] });
    const art = t.artifacts.save({ workspaceId: 'ws_ext', kind: 'text', mime: 'text/plain', bytes: 'reviews' });
    const bad = await t.handle(ctx({ workspaceId: 'ws_ext' }), 'save_persona', personaInput([art.id], { audience: 'internal' }));
    expect(bad.ok).toBe(false);
    expect(!bad.ok && bad.error).toMatch(/audience 'internal'/);
    expect(t.store.personas.list({ workspaceId: 'ws_ext' })).toHaveLength(0);
    const good = await t.handle(ctx({ workspaceId: 'ws_ext' }), 'save_persona', personaInput([art.id], { audience: 'external' }));
    expect(good.ok).toBe(true);
  });
});

describe('persona feedback identity', () => {
  it('persona_feedback decisions carry the persona; export joins ratings to the exact persona', async () => {
    const t = await panelSeeded();
    await runPersonaPanel('ws_a', t.deps);
    const [p1, p2] = t.store.personas.list({ workspaceId: 'ws_a' });
    const pf = t.store.decisions.list({ workspaceId: 'ws_a', kind: 'persona_feedback' });
    expect(pf).toHaveLength(2);
    for (const p of [p1!, p2!]) {
      const d = pf.filter((x) => (x.payload as { personaId?: string }).personaId === p.id);
      expect(d).toHaveLength(1);
      expect(d[0]!.refs).toEqual(expect.arrayContaining(['rec_1', p.id]));
      expect((d[0]!.payload as { targetId: string }).targetId).toBe(`rec_1:${p.id}`);
    }
    rateCriterion({ workspaceId: 'ws_a', targetType: 'persona_feedback', targetId: `rec_1:${p1!.id}`, criterion: 'appeal', verdict: 'disagree', userValue: 2 }, t);
    const rows = exportTrainingData('ws_a', t).trim().split('\n').map((l) => JSON.parse(l) as { decision: Decision; ratings: Rating[] });
    const forPersona = (id: string) =>
      rows.find((r) => r.decision.kind === 'persona_feedback' && (r.decision.payload as { personaId: string }).personaId === id)!;
    expect(forPersona(p1!.id).ratings.map((r) => r.targetId)).toEqual([`rec_1:${p1!.id}`]);
    expect(forPersona(p2!.id).ratings).toEqual([]);
  });

  it('every persona_feedback decision of a run is stamped (repeat and off-target submissions too)', async () => {
    const t = await panelSeeded();
    t.store.recommendations.insert(rec('rec_2'));
    const one = (recommendation_id: string, appeal: number) => ({
      recommendation_id, scores: { appeal, adoption: 3, willingness_to_pay: 2, friction: 4 },
      concerns: [], reasoning: 'r', would_change_mind: 'w',
    });
    // Each run answers its own recommendation twice and also the other one.
    t.state.pick = (req) => {
      if (req.role !== 'persona') return undefined;
      const recId = /Recommendation id: (\S+)/.exec(req.prompt)![1]!;
      const other = recId === 'rec_1' ? 'rec_2' : 'rec_1';
      return async (tools) => {
        await tools.call('submit_persona_feedback', one(recId, 2));
        await tools.call('submit_persona_feedback', one(other, 3));
        await tools.call('submit_persona_feedback', one(recId, 4));
      };
    };
    await runPersonaPanel('ws_a', t.deps);
    const personaOfRun = new Map(t.store.agentRuns.list({ workspaceId: 'ws_a', role: 'persona' }).map((r) => [r.id, r]));
    const pf = t.store.decisions.list({ workspaceId: 'ws_a', kind: 'persona_feedback' });
    expect(pf).toHaveLength(2 * 2 * 3); // 2 personas × 2 recs × 3 submissions
    for (const d of pf) {
      const p = d.payload as { personaId?: string; targetId?: string; input: { recommendation_id: string } };
      expect(p.personaId).toBeDefined();
      expect(p.targetId).toBe(`${p.input.recommendation_id}:${p.personaId}`);
      expect(d.refs).toEqual(expect.arrayContaining([p.input.recommendation_id, p.personaId]));
      expect(personaOfRun.has(d.agentRunId)).toBe(true);
    }
    // All decisions of one run carry the same persona.
    const byRun = new Map<string, Set<string>>();
    for (const d of pf) {
      const s = byRun.get(d.agentRunId) ?? new Set();
      s.add((d.payload as { personaId: string }).personaId);
      byRun.set(d.agentRunId, s);
    }
    for (const s of byRun.values()) expect(s.size).toBe(1);
  });
});

describe('calibration reaches loaded prompts', () => {
  it('persona: panel runs get calibration/persona.md and a new prompt version', async () => {
    const t = await panelSeeded();
    await runPersonaPanel('ws_a', t.deps);
    const before = new Set(t.store.agentRuns.list({ workspaceId: 'ws_a', role: 'persona' }).map((r) => r.promptVersion));
    expect(before.size).toBeGreaterThan(0);
    applyPromptPatch({ role: 'persona', examples: [], patchText: '## Calibration examples\n\n1. appeal: you said 5; the user says 2.' }, scopeOf(t));
    t.requests.length = 0;
    await runPersonaPanel('ws_a', t.deps);
    const reqs = t.requests.filter((r) => r.role === 'persona');
    expect(reqs).toHaveLength(2);
    for (const r of reqs) expect(r.systemPrompt).toContain('you said 5; the user says 2');
    const after = t.store.agentRuns.list({ workspaceId: 'ws_a', role: 'persona' }).slice(2);
    expect(after).toHaveLength(2);
    for (const r of after) expect(before.has(r.promptVersion)).toBe(false);
  });

  it('synthesizer: worker system prompt gets calibration/synthesizer.md (not the worker one) and runs record a new version', async () => {
    const t = setup();
    const base = workerSystemPrompt(t.config, 'synthesizer', false, undefined, scopeOf(t));
    applyPromptPatch({ role: 'synthesizer', examples: [], patchText: '## Calibration examples\n\n1. upside: you said 5; the user says 3.' }, scopeOf(t));
    applyPromptPatch({ role: 'worker', examples: [], patchText: '## Calibration examples\n\n1. relevance: WORKER-ONLY.' }, scopeOf(t));
    const synth = workerSystemPrompt(t.config, 'synthesizer', false, undefined, scopeOf(t));
    expect(synth).not.toBe(base);
    expect(synth).toContain('you said 5; the user says 3');
    expect(synth).not.toContain('WORKER-ONLY');
    expect(workerSystemPrompt(t.config, 'worker', false, undefined, scopeOf(t))).toContain('WORKER-ONLY');

    // A real synthesize task run records the calibrated prompt's version.
    const task = addTask(t.store, { phase: 'synthesis', type: 'synthesize_recommendations' });
    t.state.pick = (req) => (req.kind === 'review' ? review(9) : submitWork());
    await runTaskWithReview(task, t.deps);
    const synthRuns = t.store.agentRuns.list({ workspaceId: 'ws_a', role: 'synthesizer' });
    expect(synthRuns.length).toBeGreaterThan(0);
    const req = t.requests.find((r) => r.role === 'synthesizer')!;
    expect(req.systemPrompt).toContain('you said 5; the user says 3');
  });
});

describe('persona_profile instructions reach workers', () => {
  it('persona_profile and audience_segments tasks get persona_profile.md; others do not', () => {
    const t = setup();
    const marker = promptTemplate('persona_profile').split('\n')[0]!;
    expect(workerSystemPrompt(t.config, 'worker', false, 'persona_profile')).toContain(marker);
    expect(workerSystemPrompt(t.config, 'worker', false, 'audience_segments')).toContain(marker);
    expect(workerSystemPrompt(t.config, 'worker', false, 'news_scan')).not.toContain(marker);
  });

  it('review loop passes the task type: a persona_profile task run sees the instructions', async () => {
    const t = setup();
    const task = addTask(t.store, { phase: 'market_research', type: 'persona_profile' });
    t.state.pick = (req) => (req.kind === 'review' ? review(9) : submitWork());
    await runTaskWithReview(task, t.deps);
    const work = t.requests.find((r) => r.kind === 'work')!;
    expect(work.systemPrompt).toContain(promptTemplate('persona_profile').split('\n')[0]!);
  });
});

describe('calibration isolation per business tree (final review C1)', () => {
  const patchA = '## Calibration examples (approved by the user)\n\n1. finding "A churn" — `relevance`: you said 5; the user says 2. COMPANY-A-ONLY\n';

  it('company A patch never reaches company B prompts; A descendants share it', async () => {
    const t = setup();
    t.store.workspaces.insert({ id: 'ws_b', name: 'Beta', sector: 'retail', createdAt: 'now' });
    t.store.workspaces.insert({ id: 'ws_a_child', name: 'Acme EU', sector: 'saas', createdAt: 'now', parentWorkspaceId: 'ws_a' });
    for (const role of ['worker', 'reviewer', 'synthesizer', 'orchestrator', 'interviewer', 'persona'] as const) {
      applyPromptPatch({ role, examples: [], patchText: patchA }, calibrationScope(t.store, t.dir, 'ws_a_child'));
    }
    // Stored under the tree root, inside the data dir — never under src/.
    expect(existsSync(join(t.dir, 'ws_a', 'calibration', 'worker.md'))).toBe(true);
    expect(existsSync(join(PROMPTS_DIR, 'calibration', 'worker.md'))).toBe(false);

    const a = calibrationScope(t.store, t.dir, 'ws_a');
    const b = calibrationScope(t.store, t.dir, 'ws_b');
    expect(workerSystemPrompt(t.config, 'worker', false, undefined, a)).toContain('COMPANY-A-ONLY');
    expect(workerSystemPrompt(t.config, 'worker', false, undefined, b)).not.toContain('COMPANY-A-ONLY');
    expect(reviewerSystemPrompt(t.config, b)).not.toContain('COMPANY-A-ONLY');
    expect(loadPrompt('interviewer', b).text).not.toContain('COMPANY-A-ONLY');
    expect(loadPrompt('interviewer', calibrationScope(t.store, t.dir, 'ws_a_child')).text).toContain('COMPANY-A-ONLY');

    // Real runs: a task in B sees no A calibration; a task in A does.
    t.state.pick = (req) => (req.kind === 'review' ? review(9) : submitWork());
    await runTaskWithReview(addTask(t.store, { workspaceId: 'ws_b' }), t.deps);
    await runTaskWithReview(addTask(t.store, { workspaceId: 'ws_a' }), t.deps);
    const bReqs = t.requests.filter((r) => r.workspaceId === 'ws_b');
    const aReqs = t.requests.filter((r) => r.workspaceId === 'ws_a');
    expect(bReqs.length).toBeGreaterThan(1);
    for (const r of bReqs) expect(r.systemPrompt).not.toContain('COMPANY-A-ONLY');
    for (const r of aReqs) expect(r.systemPrompt).toContain('COMPANY-A-ONLY');
  });

  it('applying merges (append + dedupe) instead of overwriting', () => {
    const t = setup();
    const s = calibrationScope(t.store, t.dir, 'ws_a');
    const head = '## Calibration examples (approved by the user)\n\n';
    applyPromptPatch({ role: 'worker', examples: [], patchText: `${head}1. finding "X" — \`relevance\`: you said 5; the user says 2.\n2. finding "Y" — \`novelty\`: you said 4; the user says 1.\n` }, s);
    const { text } = applyPromptPatch(
      { role: 'worker', examples: [], patchText: `${head}1. finding "Y" — \`novelty\`: you said 4; the user says 3.\n2. finding "Z" — \`reliability\`: you said 1; the user says 4.\n` },
      s,
    );
    expect(text.match(/Calibration examples/g)).toHaveLength(1);
    expect(text).toContain('1. finding "X" — `relevance`: you said 5; the user says 2.');
    // Same item + criterion: the newer correction replaces the older one (moved to the end).
    expect(text).not.toContain('the user says 1.');
    expect(text).toContain('2. finding "Y" — `novelty`: you said 4; the user says 3.');
    expect(text).toContain('3. finding "Z"');
    // Re-applying an example already present changes nothing.
    expect(applyPromptPatch({ role: 'worker', examples: [], patchText: `${head}1. finding "Z" — \`reliability\`: you said 1; the user says 4.\n` }, s).text).toBe(text);
  });
});

describe('competitor / hypothesis instructions reach workers', () => {
  it('discover_competitors and flow_walkthrough get competitors.md; symptom_hypotheses gets hypotheses.md', () => {
    const t = setup();
    const comp = promptTemplate('competitors').split('\n')[0]!;
    const hyp = promptTemplate('hypotheses').split('\n')[0]!;
    expect(workerSystemPrompt(t.config, 'worker', false, 'discover_competitors')).toContain(comp);
    expect(workerSystemPrompt(t.config, 'worker', false, 'flow_walkthrough')).toContain(comp);
    expect(workerSystemPrompt(t.config, 'worker', false, 'news_scan')).not.toContain(comp);
    expect(workerSystemPrompt(t.config, 'worker', false, 'symptom_hypotheses')).toContain(hyp);
    expect(promptTemplate('competitors')).toContain('save_competitor');
    expect(promptTemplate('hypotheses')).toContain('save_hypothesis');
  });
});
