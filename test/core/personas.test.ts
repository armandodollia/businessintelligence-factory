import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { FakeScript } from '../../src/core/harness/adapter.js';
import type { RunContext } from '../../src/core/harness/tokens.js';
import { AGENT_MD_HEADINGS, compileAgentMd } from '../../src/core/market/agentMd.js';
import { panelSummary, personaPanelRunner, runPersonaPanel } from '../../src/core/market/panel.js';
import { marketToolHandlers } from '../../src/core/market/personas.js';
import { startPhase } from '../../src/core/research/orchestrator.js';
import { PERSONA_FIELDS } from '../../src/core/scoring/criteria.js';
import type { Store } from '../../src/core/store/db.js';
import { newId } from '../../src/core/store/repos.js';
import type { Persona, Recommendation } from '../../src/core/types.js';
import { researchSetup } from './helpers/research.js';

const opened: Store[] = [];
afterEach(() => {
  for (const s of opened.splice(0)) s.close();
});

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'bif-personas-'));
  const t = researchSetup(opened, {
    dir,
    extraHandlers: () => marketToolHandlers({ dataDir: dir }),
  });
  t.store.workspaces.insert({
    id: 'ws_a', name: 'Acme', sector: 'saas', createdAt: 'now',
    scope: { level: 'division', name: 'Acme Payments', description: 'payments division' }, audiences: ['external', 'internal'],
  });
  const art = t.artifacts.save({ workspaceId: 'ws_a', kind: 'text', mime: 'text/plain', bytes: 'G2 reviews of Acme' });
  return { ...t, art: art.id };
}

const ctx = (extra: Partial<RunContext> = {}): RunContext => ({
  agentRunId: newId('arun'), workspaceId: 'ws_a', role: 'worker', model: { provider: 'claude', model: 'sonnet' },
  promptVersion: 'pv', ...extra,
});

function profile(evidence: string[], over: Record<string, unknown> = {}) {
  const p: Record<string, unknown> = {};
  for (const f of PERSONA_FIELDS) p[f] = { value: `${f} value`, confidence: 0.6, evidence };
  return { ...p, ...over };
}

const personaInput = (evidence: string[], extra: Record<string, unknown> = {}) => ({
  segment: 'SMB finance lead', audience: 'external', profile: profile(evidence), ...extra,
});

function rec(id: string): Recommendation {
  return {
    id, workspaceId: 'ws_a', title: `Rec ${id}`, summary: `Do ${id}`, criteria: { upside: 4 }, findingIds: [],
    personaFeedback: [], priority: 0, createdAt: new Date().toISOString(),
  };
}

/** Persona script: answers the recommendation named in the prompt with the given appeal score. */
function feedbackScript(prompt: string, appeal: number): FakeScript {
  const recId = /Recommendation id: (\S+)/.exec(prompt)![1]!;
  return async (tools) => {
    await tools.call('submit_persona_feedback', {
      recommendation_id: recId,
      scores: { appeal, adoption: 3, willingness_to_pay: 2, friction: 4 },
      concerns: ['price'],
      reasoning: 'in character',
      would_change_mind: 'a free tier',
    });
  };
}

describe('save_persona', () => {
  it('save_persona rejects missing field', async () => {
    const t = setup();
    const p = profile([t.art]);
    delete p.goals;
    const r = await t.handle(ctx(), 'save_persona', { segment: 'SMB', audience: 'external', profile: p });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toMatch(/goals/);

    const noAudience = await t.handle(ctx(), 'save_persona', { segment: 'SMB', profile: profile([t.art]) });
    expect(noAudience.ok).toBe(false);
    expect(!noAudience.ok && noAudience.error).toMatch(/audience/);

    const noEvidence = await t.handle(ctx(), 'save_persona', {
      segment: 'SMB', audience: 'external', profile: profile([t.art], { needs: { value: 'v', confidence: 0.5, evidence: [] } }),
    });
    expect(noEvidence.ok).toBe(false);
    expect(!noEvidence.ok && noEvidence.error).toMatch(/needs/);

    const unknownArt = await t.handle(ctx(), 'save_persona', personaInput(['art_missing']));
    expect(unknownArt.ok).toBe(false);
    expect(!unknownArt.ok && unknownArt.error).toMatch(/art_missing/);

    const badConfidence = await t.handle(ctx(), 'save_persona', {
      segment: 'SMB', audience: 'external', profile: profile([t.art], { voice: { value: 'v', confidence: 1.5, evidence: [t.art] } }),
    });
    expect(badConfidence.ok).toBe(false);

    expect(t.store.personas.list()).toHaveLength(0);
    expect(t.store.decisions.list()).toHaveLength(0);
  });

  it('personality_values and voice may cite the same artifacts as other fields', async () => {
    const t = setup();
    const r = await t.handle(ctx(), 'save_persona', personaInput([t.art]));
    expect(r.ok).toBe(true);
  });

  it('version bumps on update and file rewritten', async () => {
    const t = setup();
    const first = await t.handle(ctx(), 'save_persona', personaInput([t.art], { slug: 'smb-finance' }));
    expect(first.ok).toBe(true);
    const data = (first as { data: { personaId: string; version: number; agentMdPath: string } }).data;
    expect(data.version).toBe(1);
    expect(data.agentMdPath).toBe(join(t.dir, 'ws_a', 'personas', 'smb-finance.md'));
    const v1 = readFileSync(data.agentMdPath, 'utf8');
    expect(v1).toMatch(/^---\n[\s\S]*version: 1\n/);

    const updated = profile([t.art], { goals: { value: 'close the books in two days', confidence: 0.9, evidence: [t.art] } });
    const second = await t.handle(ctx(), 'save_persona', { segment: 'SMB finance lead', slug: 'smb-finance', audience: 'external', profile: updated });
    expect(second.ok).toBe(true);
    const d2 = (second as { data: { personaId: string; version: number } }).data;
    expect(d2.personaId).toBe(data.personaId);
    expect(d2.version).toBe(2);

    const personas = t.store.personas.list({ workspaceId: 'ws_a' });
    expect(personas).toHaveLength(1);
    expect(personas[0]).toMatchObject({ slug: 'smb-finance', version: 2, audience: 'external', agentMdPath: data.agentMdPath });
    expect(personas[0]!.profile.goals!.value).toBe('close the books in two days');

    const v2 = readFileSync(data.agentMdPath, 'utf8');
    expect(v2).not.toBe(v1);
    expect(v2).toMatch(/version: 2\n/);
    expect(v2).toContain('close the books in two days');

    // One `score` decision per save, referencing the persona and its evidence.
    const ds = t.store.decisions.list({ workspaceId: 'ws_a' });
    expect(ds).toHaveLength(2);
    expect(ds.every((d) => d.kind === 'score' && d.refs.includes(data.personaId) && d.refs.includes(t.art))).toBe(true);
  });

  it('slug defaults to the slugified segment', async () => {
    const t = setup();
    const r = await t.handle(ctx(), 'save_persona', personaInput([t.art], { segment: 'IT Ops Lead (EU)' }));
    expect(r.ok).toBe(true);
    expect(t.store.personas.list()[0]!.slug).toBe('it-ops-lead-eu');
    expect(existsSync(join(t.dir, 'ws_a', 'personas', 'it-ops-lead-eu.md'))).toBe(true);
  });
});

describe('compileAgentMd', () => {
  const persona = (audience: 'external' | 'internal'): Persona => ({
    id: 'per_1', workspaceId: 'ws_a', slug: 'smb-finance', segment: 'SMB finance lead', version: 3, audience,
    agentMdPath: '/x', profile: Object.fromEntries(PERSONA_FIELDS.map((f) => [f, { value: `${f} value`, confidence: 0.7, evidence: ['art_1'] }])),
  });

  it('agentMd has frontmatter simulated: true and all field headings', () => {
    const md = compileAgentMd(persona('external'));
    const fm = /^---\n([\s\S]*?)\n---\n/.exec(md);
    expect(fm).not.toBeNull();
    const lines = fm![1]!.split('\n');
    expect(lines).toContain('name: smb-finance');
    expect(lines).toContain('version: 3');
    expect(lines).toContain('simulated: true');
    expect(lines.some((l) => l.startsWith('description: '))).toBe(true);
    for (const f of PERSONA_FIELDS) {
      expect(md).toContain(`\n## ${AGENT_MD_HEADINGS[f]}\n`);
      expect(md).toContain(`${f} value`);
    }
    // Fixed instructions come after the field sections.
    const instr = md.indexOf('## Instructions');
    expect(instr).toBeGreaterThan(md.indexOf(`## ${AGENT_MD_HEADINGS.segment_size_value}`));
    const tail = md.slice(instr);
    expect(tail).toMatch(/stay in character/i);
    expect(tail).toMatch(/candid/i);
    expect(tail).toMatch(/not agreeable/i);
    expect(tail).toMatch(/irrelevant to you/i);
  });

  it('internal personas are framed as employees / internal users of the scope', () => {
    const ext = compileAgentMd(persona('external'), { scopeName: 'Acme Payments' });
    const int = compileAgentMd(persona('internal'), { scopeName: 'Acme Payments' });
    expect(int).toMatch(/employee|internal user/i);
    expect(int).toContain('Acme Payments');
    expect(int).toMatch(/audience: internal/);
    expect(ext).toMatch(/audience: external/);
    expect(ext).toMatch(/customer/i);
    expect(ext).not.toMatch(/you work (at|in|inside)/i);
  });
});

describe('persona panel', () => {
  async function seeded() {
    const t = setup();
    for (const [segment, audience] of [['SMB finance lead', 'external'], ['Payments ops analyst', 'internal']] as const) {
      const r = await t.handle(ctx(), 'save_persona', personaInput([t.art], { segment, audience }));
      expect(r.ok).toBe(true);
    }
    t.store.recommendations.insert(rec('rec_1'));
    t.store.recommendations.insert(rec('rec_2'));
    t.state.pick = (req) => {
      if (req.role !== 'persona') return undefined;
      return feedbackScript(req.prompt, req.systemPrompt.includes('name: smb-finance-lead') ? 5 : 1);
    };
    return t;
  }

  it('panel stores one feedback per persona per recommendation', async () => {
    const t = await seeded();
    await runPersonaPanel('ws_a', t.deps);

    const personas = t.store.personas.list({ workspaceId: 'ws_a' });
    for (const id of ['rec_1', 'rec_2']) {
      const r = t.store.recommendations.get(id)!;
      expect(r.personaFeedback).toHaveLength(2);
      expect(new Set(r.personaFeedback.map((f) => f.personaId))).toEqual(new Set(personas.map((p) => p.id)));
      for (const f of r.personaFeedback) {
        expect(f.simulated).toBe(true);
        expect(f.scores).toMatchObject({ adoption: 3, willingnessToPay: 2, friction: 4 });
        expect(f.concerns).toEqual(['price']);
        expect(f.wouldChangeMind).toBe('a free tier');
      }
    }
    // Each persona run gets its agent.md as system prompt, role persona.
    const personaReqs = t.requests.filter((r) => r.role === 'persona');
    expect(personaReqs).toHaveLength(4);
    for (const p of personas) {
      expect(personaReqs.filter((r) => r.systemPrompt === readFileSync(p.agentMdPath, 'utf8'))).toHaveLength(2);
    }
    // Exactly one persona_feedback decision per feedback (written by the dispatcher only).
    const pf = t.store.decisions.list({ workspaceId: 'ws_a' }).filter((d) => d.kind === 'persona_feedback');
    expect(pf).toHaveLength(4);

    // Re-running replaces each persona's feedback instead of appending.
    await runPersonaPanel('ws_a', t.deps);
    expect(t.store.recommendations.get('rec_1')!.personaFeedback).toHaveLength(2);
    expect(t.store.decisions.list({ workspaceId: 'ws_a' }).filter((d) => d.kind === 'persona_feedback')).toHaveLength(8);
  });

  it('panel summary highlights segment disagreement', async () => {
    const t = await seeded();
    await runPersonaPanel('ws_a', t.deps);
    const s = panelSummary(t.store.recommendations.get('rec_1')!, t.store.personas.list({ workspaceId: 'ws_a' }));
    expect(s.simulated).toBe(true);
    expect(s.n).toBe(2);
    expect(s.scores.appeal).toMatchObject({ min: 1, max: 5, mean: 3, spread: 4 });
    expect(s.disagreement).toEqual(['appeal']);
    expect(s.scores.adoption.spread).toBe(0);
  });

  it('a persona run that never calls submit_persona_feedback is retried once, then skipped', async () => {
    const t = await seeded();
    let silent = 0;
    t.state.pick = (req) => {
      if (req.role !== 'persona') return undefined;
      if (req.systemPrompt.includes('name: smb-finance-lead') && req.prompt.includes('rec_1')) {
        silent++;
        return async () => {};
      }
      return feedbackScript(req.prompt, 3);
    };
    const report = await runPersonaPanel('ws_a', t.deps);
    expect(silent).toBe(2);
    expect(report.missing).toHaveLength(1);
    expect(t.store.recommendations.get('rec_1')!.personaFeedback).toHaveLength(1);
    expect(t.store.recommendations.get('rec_2')!.personaFeedback).toHaveLength(2);
    expect(t.store.decisions.list({ workspaceId: 'ws_a' }).filter((d) => d.kind === 'persona_feedback')).toHaveLength(3);
  });

  it('submit_persona_feedback rejects a recommendation outside the workspace', async () => {
    const t = await seeded();
    const r = await t.handle(ctx({ role: 'persona' }), 'submit_persona_feedback', {
      recommendation_id: 'rec_nope', scores: { appeal: 3, adoption: 3, willingness_to_pay: 3, friction: 3 },
      concerns: [], reasoning: 'r', would_change_mind: 'w',
    });
    expect(r.ok).toBe(false);
    expect(t.store.decisions.list().filter((d) => d.kind === 'persona_feedback')).toHaveLength(0);
  });

  it('runs as the persona_panel phase runner', async () => {
    const t = await seeded();
    const rr = await startPhase('ws_a', 'persona_panel', { ...t.deps, phaseRunners: { persona_panel: personaPanelRunner } });
    expect(rr.status).toBe('done');
    expect(t.store.recommendations.get('rec_2')!.personaFeedback).toHaveLength(2);
  });
});
