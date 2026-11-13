import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { isSynthesisEligible } from '../../src/core/evidence/synthesis.js';
import type { FakeScript } from '../../src/core/harness/adapter.js';
import { runPersonaPanel } from '../../src/core/market/panel.js';
import { marketToolHandlers } from '../../src/core/market/personas.js';
import { isOutputUsable, isRecommendationShown, setOutputInclude } from '../../src/core/research/outputs.js';
import { runTaskWithReview } from '../../src/core/research/reviewLoop.js';
import { PERSONA_FIELDS } from '../../src/core/scoring/criteria.js';
import { scoringToolHandlers } from '../../src/core/scoring/priority.js';
import type { Store } from '../../src/core/store/db.js';
import { newId } from '../../src/core/store/repos.js';
import { addTask, researchSetup, review, revise } from './helpers/research.js';

const opened: Store[] = [];
afterEach(() => {
  for (const s of opened.splice(0)) s.close();
});

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'bif-outputs-'));
  const t = researchSetup(opened, {
    dir,
    extraHandlers: () => ({ ...marketToolHandlers({ dataDir: dir }), ...scoringToolHandlers() }),
  });
  t.store.workspaces.insert({ id: 'ws_a', name: 'Acme', sector: 'saas', createdAt: 'now' });
  return t;
}

/** Worker script saving one finding with its own artifact (no submit). */
const saveFinding =
  (claim: string): FakeScript =>
  async (tools) => {
    const a = (await tools.call('save_artifact', { kind: 'text', mime: 'text/plain', content: `source: ${claim}` })) as { artifactId: string };
    await tools.call('save_finding', { claim, subject: 'Acme', evidence: [a.artifactId] });
  };

const personaProfile = (evidence: string[]) =>
  Object.fromEntries(PERSONA_FIELDS.map((f) => [f, { value: `${f} value`, confidence: 0.6, evidence }]));

describe('review status of task outputs', () => {
  it('"$10" corrected to "$20": only "$20" is verified, "$10" is superseded and never used', async () => {
    let reviews = 0;
    const t = setup();
    t.state.pick = (r) => {
      if (r.kind === 'work') {
        return async (tools) => {
          await saveFinding('Acme Pro costs $10 per seat')(tools);
          await tools.call('submit_result', { summary: 'Pro is $10' });
        };
      }
      if (r.kind === 'review') {
        reviews++;
        return reviews === 1 ? review(3, [{ class: 'blocking', description: 'pricing page says $20' }]) : review(9);
      }
      return async (tools) => {
        await saveFinding('Acme Pro costs $20 per seat')(tools);
        await revise('fix', { summary: 'Pro is $20' }, false)(r)(tools);
      };
    };
    const task = addTask(t.store, { workspaceId: 'ws_a' });
    const out = await runTaskWithReview(task, t.deps);
    expect(out.status).toBe('verified');
    const byClaim = Object.fromEntries(t.store.findings.list({ taskId: task.id }).map((f) => [f.claim, f]));
    expect(byClaim['Acme Pro costs $20 per seat']!.status).toBe('verified');
    expect(byClaim['Acme Pro costs $10 per seat']!.status).toBe('superseded');
    // The revise prompt told the worker which outputs are current and the superseded rule.
    const revisePrompt = t.requests.find((r) => r.kind === 'revise')!.prompt;
    expect(revisePrompt).toMatch(/## Your current outputs\n- finding fnd_\w+: Acme Pro costs \$10/);
    // The round-2 reviewer only sees the current ("$20") finding.
    const reviewerPrompts = t.requests.filter((r) => r.kind === 'review').map((r) => r.prompt);
    expect(reviewerPrompts[1]).toContain('Acme Pro costs $20 per seat');
    expect(reviewerPrompts[1]).not.toContain('Acme Pro costs $10 per seat');
    // A superseded finding is excluded from synthesis even with a user override.
    const old = byClaim['Acme Pro costs $10 per seat']!;
    expect(isSynthesisEligible({ ...old, includeInSynthesis: true })).toBe(false);
  });

  it('an earlier-round output cited by id in the final deliverable stays current', async () => {
    let reviews = 0;
    const t = setup();
    t.state.pick = (r) => {
      if (r.kind === 'work') {
        return async (tools) => {
          await saveFinding('Acme has 3 tiers')(tools);
          await tools.call('submit_result', { summary: 'tiers' });
        };
      }
      if (r.kind === 'review') {
        reviews++;
        return reviews === 1 ? review(3, [{ class: 'substantive', description: 'add the free tier' }]) : review(9);
      }
      return async (tools) => {
        await saveFinding('Acme has a free tier')(tools);
        const keep = t.store.findings.list({ claim: 'Acme has 3 tiers' })[0]!.id;
        await revise('fix', { summary: 'tiers', findings: [keep] }, false)(r)(tools);
      };
    };
    const task = addTask(t.store, { workspaceId: 'ws_a' });
    await runTaskWithReview(task, t.deps);
    expect(t.store.findings.list({ taskId: task.id }).map((f) => f.status)).toEqual(['verified', 'verified']);
  });

  it('a failed task marks its findings failed', async () => {
    const t = setup();
    t.state.pick = (r) => (r.kind === 'work' ? saveFinding('half done') : undefined); // never submits
    const task = addTask(t.store, { workspaceId: 'ws_a' });
    expect((await runTaskWithReview(task, t.deps)).status).toBe('failed');
    expect(t.store.findings.list({ taskId: task.id })[0]!.status).toBe('failed');
  });

  it('recommendations and personas take their task status; reviewer sees their content and transitive evidence', async () => {
    const t = setup();
    // A verified finding of an earlier task (cited by the recommendation) and an unrelated one.
    const cited = t.artifacts.save({ workspaceId: 'ws_a', kind: 'text', mime: 'text/plain', bytes: 'G2 reviews' });
    const unrelated = t.artifacts.save({ workspaceId: 'ws_a', kind: 'text', mime: 'text/plain', bytes: 'unrelated' });
    const base = { workspaceId: 'ws_a', runId: 'rrun_0', subject: 'Acme', criteria: {}, createdAt: 'now' };
    t.store.findings.insert({ ...base, id: 'fnd_cited', taskId: 'tsk_old', claim: 'CITED_CLAIM churn is high', evidence: [cited.id], status: 'verified' });
    t.store.findings.insert({ ...base, id: 'fnd_other', taskId: 'tsk_old', claim: 'UNRELATED_CLAIM', evidence: [unrelated.id], status: 'verified' });
    let reviews = 0;
    t.state.pick = (r) => {
      if (r.kind === 'work') {
        return async (tools) => {
          await tools.call('save_recommendation', {
            title: 'REC_TITLE annual plans', summary: 'REC_SUMMARY lock in customers', criteria: { upside: 4 }, finding_ids: ['fnd_cited'],
          });
          await tools.call('submit_result', { summary: 'one recommendation' });
        };
      }
      reviews++;
      return review(reviews === 1 ? 9 : 9);
    };
    const task = addTask(t.store, { workspaceId: 'ws_a', type: 'synthesize_recommendations', phase: 'synthesis' });
    expect((await runTaskWithReview(task, t.deps)).status).toBe('verified');
    const rec = t.store.recommendations.list({ workspaceId: 'ws_a' })[0]!;
    expect(rec).toMatchObject({ taskId: task.id, status: 'verified', taskRound: 1 });
    const prompt = t.requests.find((r) => r.kind === 'review')!.prompt;
    expect(prompt).toContain('REC_TITLE annual plans');
    expect(prompt).toContain('REC_SUMMARY lock in customers');
    expect(prompt).toContain('CITED_CLAIM churn is high');
    expect(prompt).toContain(cited.id);
    expect(prompt).not.toContain('UNRELATED_CLAIM');
    expect(prompt).not.toContain(unrelated.id);

    // Persona saved by an unverified persona_profile task.
    const art = t.artifacts.save({ workspaceId: 'ws_a', kind: 'text', mime: 'text/plain', bytes: 'reviews' });
    t.state.pick = (r) => {
      if (r.kind === 'work' || r.kind === 'revise') {
        return async (tools) => {
          if (r.kind === 'revise') for (const m of r.prompt.matchAll(/^- \[(\w+)\]/gm)) await tools.call('respond_to_review', { issue_id: m[1], action: 'fix', reason: 'r' });
          await tools.call('save_persona', { segment: 'SMB owner', audience: 'external', profile: personaProfile([art.id]) });
          await tools.call('submit_result', { summary: 'persona' });
        };
      }
      return review(5, [{ class: 'substantive', description: 'thin evidence' }]);
    };
    const ptask = addTask(t.store, { workspaceId: 'ws_a', type: 'persona_profile', phase: 'market_research' });
    expect((await runTaskWithReview(ptask, t.deps)).status).toBe('unverified');
    const persona = t.store.personas.list({ workspaceId: 'ws_a' })[0]!;
    expect(persona).toMatchObject({ taskId: ptask.id, status: 'unverified', version: 3 });
    const personaReview = t.requests.filter((r) => r.kind === 'review').at(-1)!.prompt;
    expect(personaReview).toContain('### Personas saved by this task');
    expect(personaReview).toContain('pain_points: pain_points value');
    expect(personaReview).toContain(art.id);
  });
});

describe('persona panel uses reviewed outputs only', () => {
  it('runs only verified (or user-included) personas and recommendations; superseded never', async () => {
    const t = setup();
    const art = t.artifacts.save({ workspaceId: 'ws_a', kind: 'text', mime: 'text/plain', bytes: 'reviews' });
    const ctx = { agentRunId: newId('arun'), workspaceId: 'ws_a', role: 'worker' as const, model: { provider: 'claude' as const, model: 'sonnet' }, promptVersion: 'pv' };
    for (const segment of ['Verified Vera', 'Unverified Uma', 'Included Ines']) {
      expect((await t.handle(ctx, 'save_persona', { segment, audience: 'external', profile: personaProfile([art.id]) })).ok).toBe(true);
    }
    const [vera, uma, ines] = t.store.personas.list({ workspaceId: 'ws_a' });
    t.store.personas.update(vera!.id, { status: 'verified' });
    t.store.personas.update(uma!.id, { status: 'unverified' });
    t.store.personas.update(ines!.id, { status: 'unverified' });
    setOutputInclude(t.store, 'persona', ines!.id, true);
    const rec = (id: string, extra: Record<string, unknown>) =>
      t.store.recommendations.insert({
        id, workspaceId: 'ws_a', title: id, summary: id, criteria: {}, findingIds: [], personaFeedback: [], priority: 0, createdAt: 'now', ...extra,
      });
    rec('rec_ok', { status: 'verified' });
    rec('rec_unv', { status: 'unverified' });
    rec('rec_inc', { status: 'failed', includeOverride: true });
    rec('rec_sup', { status: 'superseded', includeOverride: true });
    rec('rec_exc', { status: 'verified', includeOverride: false });
    t.state.pick = (r) => {
      const recId = /Recommendation id: (\S+)/.exec(r.prompt)![1]!;
      return async (tools) => {
        await tools.call('submit_persona_feedback', {
          recommendation_id: recId, scores: { appeal: 3, adoption: 3, willingness_to_pay: 3, friction: 3 }, concerns: [], reasoning: 'r', would_change_mind: 'w',
        });
      };
    };
    const report = await runPersonaPanel('ws_a', t.deps);
    expect(report.feedback).toBe(4); // 2 personas × 2 recommendations
    const pairs = t.requests.map((r) => `${/name: (\S+)/.exec(r.systemPrompt)![1]}:${/Recommendation id: (\S+)/.exec(r.prompt)![1]}`);
    expect(pairs.sort()).toEqual(['included-ines:rec_inc', 'included-ines:rec_ok', 'verified-vera:rec_inc', 'verified-vera:rec_ok']);
    expect(t.store.recommendations.get('rec_unv')!.personaFeedback).toEqual([]);
  });

  it('visibility and usability rules', () => {
    expect(isOutputUsable({ status: 'verified' })).toBe(true);
    expect(isOutputUsable({ status: 'unverified' })).toBe(false);
    expect(isOutputUsable({ status: 'unverified', includeOverride: true })).toBe(true);
    expect(isOutputUsable({ status: 'superseded', includeOverride: true })).toBe(false);
    expect(isOutputUsable({ status: 'verified', includeOverride: false })).toBe(false);
    expect(isRecommendationShown({ status: 'unverified' })).toBe(true);
    expect(isRecommendationShown({ status: 'failed' })).toBe(false);
    expect(isRecommendationShown({ status: 'failed', includeOverride: true })).toBe(true);
    expect(isRecommendationShown({ status: 'superseded', includeOverride: true })).toBe(false);
  });
});

describe('versioned agent.md', () => {
  it('keeps <slug>.v<N>.md per version and <slug>.md as the latest', async () => {
    const t = setup();
    const art = t.artifacts.save({ workspaceId: 'ws_a', kind: 'text', mime: 'text/plain', bytes: 'reviews' });
    const ctx = { agentRunId: newId('arun'), workspaceId: 'ws_a', role: 'worker' as const, model: { provider: 'claude' as const, model: 'sonnet' }, promptVersion: 'pv' };
    const profile = personaProfile([art.id]);
    await t.handle(ctx, 'save_persona', { segment: 'SMB owner', audience: 'external', profile });
    await t.handle(ctx, 'save_persona', { segment: 'SMB owner', audience: 'external', profile: { ...profile, goals: { value: 'GROW_V2', confidence: 0.9, evidence: [art.id] } } });
    const p = t.store.personas.list({ workspaceId: 'ws_a' })[0]!;
    expect(p.version).toBe(2);
    const dir = join(t.dir, 'ws_a', 'personas');
    expect(p.agentMdPath).toBe(join(dir, 'smb-owner.md'));
    const v1 = readFileSync(join(dir, 'smb-owner.v1.md'), 'utf8');
    const v2 = readFileSync(join(dir, 'smb-owner.v2.md'), 'utf8');
    expect(v1).toContain('version: 1');
    expect(v1).not.toContain('GROW_V2');
    expect(v2).toContain('version: 2');
    expect(v2).toContain('GROW_V2');
    expect(readFileSync(p.agentMdPath, 'utf8')).toBe(v2);
    expect(existsSync(join(dir, 'smb-owner.v3.md'))).toBe(false);
  });
});
