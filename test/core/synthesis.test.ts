import { afterEach, describe, expect, it } from 'vitest';
import { isSynthesisEligible, setIncludeInSynthesis } from '../../src/core/evidence/synthesis.js';
import type { RunContext } from '../../src/core/harness/tokens.js';
import { orchestratorPrompt } from '../../src/core/research/orchestrator.js';
import { workPrompt } from '../../src/core/research/reviewLoop.js';
import { researchToolHandlers } from '../../src/core/research/tools.js';
import { scoringToolHandlers } from '../../src/core/scoring/priority.js';
import type { Store } from '../../src/core/store/db.js';
import { newId } from '../../src/core/store/repos.js';
import type { Finding } from '../../src/core/types.js';
import { addTask, researchSetup } from './helpers/research.js';

const opened: Store[] = [];
afterEach(() => {
  for (const s of opened.splice(0)) s.close();
});

function setup() {
  const s = researchSetup(opened, { extraHandlers: () => ({ ...researchToolHandlers(), ...scoringToolHandlers() }) });
  s.store.workspaces.insert({ id: 'ws_a', name: 'Acme', sector: 'saas', createdAt: '' });
  const finding = (id: string, status: Finding['status'], claim: string) =>
    s.store.findings.insert({
      id, workspaceId: 'ws_a', runId: 'r', taskId: 't', subject: 'Rival', claim, criteria: {}, evidence: [], status,
      createdAt: '',
    });
  finding('fnd_ver', 'verified', 'VERIFIED_CLAIM');
  finding('fnd_unv', 'unverified', 'UNVERIFIED_CLAIM');
  finding('fnd_pen', 'pending', 'PENDING_CLAIM');
  return s;
}

const synth = (extra: Partial<RunContext> = {}): RunContext => ({
  agentRunId: newId('arun'), workspaceId: 'ws_a', role: 'synthesizer', model: { provider: 'claude', model: 'opus' },
  promptVersion: 'p', ...extra,
});

const rec = (findingIds: string[], title = 'Match rival pricing') => ({
  title, summary: 's', criteria: { upside: 4 }, finding_ids: findingIds,
});

describe('unverified results are excluded from synthesis (spec §7.2)', () => {
  it('eligibility: verified by default, user override wins both ways', () => {
    expect(isSynthesisEligible({ status: 'verified' })).toBe(true);
    expect(isSynthesisEligible({ status: 'unverified' })).toBe(false);
    expect(isSynthesisEligible({ status: 'pending' })).toBe(false);
    expect(isSynthesisEligible({ status: 'unverified', includeInSynthesis: true })).toBe(true);
    expect(isSynthesisEligible({ status: 'verified', includeInSynthesis: false })).toBe(false);
  });

  it('save_recommendation rejects unverified refs unless overridden', async () => {
    const s = setup();
    const bad = await s.handle(synth(), 'save_recommendation', rec(['fnd_ver', 'fnd_unv', 'fnd_pen']));
    expect(bad).toMatchObject({ ok: false, error: expect.stringMatching(/not verified.*fnd_unv, fnd_pen/) });
    expect(s.store.recommendations.list()).toHaveLength(0);

    expect((await s.handle(synth(), 'save_recommendation', rec(['fnd_ver']))).ok).toBe(true);

    setIncludeInSynthesis(s.store, 'fnd_unv', true);
    expect((await s.handle(synth(), 'save_recommendation', rec(['fnd_unv'], 'Second'))).ok).toBe(true);

    setIncludeInSynthesis(s.store, 'fnd_ver', false);
    expect((await s.handle(synth(), 'save_recommendation', rec(['fnd_ver'], 'Third'))).ok).toBe(false);
    expect(s.store.findings.get('fnd_ver')!.includeInSynthesis).toBe(false);
  });

  it('synthesis orchestrator and worker context list only usable findings', () => {
    const s = setup();
    setIncludeInSynthesis(s.store, 'fnd_pen', true);
    const rr = { id: 'rrun_s', workspaceId: 'ws_a', phase: 'synthesis' as const, status: 'running' as const, startedAt: '' };
    const p = orchestratorPrompt(s.store, s.config, rr, 1);
    expect(p).toContain('Findings usable for synthesis');
    expect(p).toContain('VERIFIED_CLAIM');
    expect(p).toContain('PENDING_CLAIM'); // user override
    expect(p).not.toContain('UNVERIFIED_CLAIM');
    expect(p).toMatch(/1 other finding\(s\) are unverified/);
    // KS-5: other phases list usable facts too (design §7.2) and count the rest, which the orchestrator
    // can still read with search + include_unverified.
    const deep = orchestratorPrompt(s.store, s.config, { ...rr, phase: 'deep_dives' }, 1);
    expect(deep).not.toContain('UNVERIFIED_CLAIM');
    expect(deep).toContain('VERIFIED_CLAIM');
    expect(deep).toMatch(/1 unverified \/ pending \/ excluded/);
    expect(deep).toContain('include_unverified');

    const task = addTask(s.store, { phase: 'synthesis', type: 'synthesize_recommendations' });
    const w = workPrompt(s, task);
    expect(w).toContain('VERIFIED_CLAIM');
    expect(w).not.toContain('UNVERIFIED_CLAIM');
    expect(workPrompt(s, addTask(s.store))).not.toContain('Findings usable for synthesis');
  });
});
