/**
 * Stakeholder personas, task 4 (design 2026-11-15-stakeholder-personas-design.md §7, §10): simulated
 * stakeholder reads of recommendations in the persona panel, and the user's reaction to a read.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { listFeedback } from '../../../src/core/feedback/events.js';
import type { FakeScript } from '../../../src/core/harness/adapter.js';
import type { RunContext } from '../../../src/core/harness/tokens.js';
import { runPersonaPanel } from '../../../src/core/market/panel.js';
import { marketToolHandlers } from '../../../src/core/market/personas.js';
import type { AgentRequest } from '../../../src/core/research/deps.js';
import { reactToRead, readsOf, runStakeholderReads, submitStakeholderReadHandler } from '../../../src/core/stakeholders/reads.js';
import { StakeholderError } from '../../../src/core/stakeholders/statements.js';
import { stakeholderRepos } from '../../../src/core/stakeholders/store.js';
import type { Store } from '../../../src/core/store/db.js';
import { newId } from '../../../src/core/store/repos.js';
import type { Persona, Recommendation } from '../../../src/core/types.js';
import { researchSetup } from '../helpers/research.js';

const opened: Store[] = [];
afterEach(() => {
  for (const s of opened.splice(0)) s.close();
});

const NOW = '2026-11-15T10:00:00.000Z';
const ACTOR = 'tester';

type Answer = { stance: string; conditions?: string[]; concerns?: string[] } | 'silent';
/** What each persona (slug) answers; default: approve (own) / watch (competitor). */
type Answers = Record<string, Answer | ((attempt: number) => Answer)>;

const slugOf = (req: AgentRequest) => /^name: (\S+)$/m.exec(req.systemPrompt)?.[1] ?? '';
const recOf = (req: AgentRequest) => /^Recommendation id: (\S+)$/m.exec(req.prompt)?.[1] ?? '';

function setup(opts: { maxReadsPerPanel?: number; enabled?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'bif-stk-rd-'));
  const results: Array<{ slug: string; ok: boolean; error?: string }> = [];
  const t = researchSetup(opened, {
    dir,
    extraHandlers: () => ({ ...marketToolHandlers({ dataDir: dir }), submit_stakeholder_read: submitStakeholderReadHandler }),
    config: (c) => {
      c.stakeholders = {
        ...(opts.maxReadsPerPanel !== undefined ? { maxReadsPerPanel: opts.maxReadsPerPanel } : {}),
        ...(opts.enabled !== undefined ? { enabled: opts.enabled } : {}),
      };
    },
  });
  t.store.workspaces.insert({
    id: 'ws_a', name: 'Acme', sector: 'saas', createdAt: NOW, scope: { level: 'division', name: 'Acme Payments', description: 'payments' },
  });
  t.store.workspaces.insert({ id: 'ws_other', name: 'Other', sector: 'saas', createdAt: NOW });
  const answers: Answers = {};
  t.state.pick = (req) => {
    if (req.role !== 'persona') return undefined;
    const slug = slugOf(req);
    const rec = recOf(req);
    const own = !slug.startsWith('stk-rival-');
    const a = answers[slug];
    const answer = typeof a === 'function' ? a(req.attempt) : (a ?? { stance: own ? 'approve' : 'watch' });
    const script: FakeScript = async (tools) => {
      if (answer === 'silent') return;
      try {
        await tools.call('submit_stakeholder_read', {
          recommendation_id: rec,
          stance: answer.stance,
          conditions: answer.conditions ?? ['a pilot first'],
          concerns: answer.concerns ?? ['cost'],
          reasoning: `${slug} on ${rec}`,
          would_change_mind: 'evidence of payback',
        });
        results.push({ slug, ok: true });
      } catch (e) {
        results.push({ slug, ok: false, error: (e as Error).message });
      }
    };
    return script;
  };
  const stakeholder = (slug: string, extra: Partial<Persona> = {}, workspaceId = 'ws_a'): Persona =>
    t.store.personas.insert({
      id: newId('per'), workspaceId, slug, segment: slug.replace(/^stk-/, '').replace(/-/g, ' '), profile: {},
      agentMdPath: join(dir, 'personas', workspaceId, `${slug}.md`), version: 3, status: 'verified',
      kind: 'stakeholder', stakeholderType: 'leader', subjectKind: slug.startsWith('stk-rival-') ? 'competitor' : 'own',
      ...(slug.startsWith('stk-rival-') ? { subjectId: 'cmp_rival' } : {}), relation: `relation of ${slug}`, disclosure: 'open', ...extra,
    });
  const rec = (id: string, extra: Partial<Recommendation> = {}, workspaceId = 'ws_a'): Recommendation =>
    t.store.recommendations.insert({
      id, workspaceId, title: `Title of ${id}`, summary: `Summary of ${id}`, criteria: {}, findingIds: [], priority: 3,
      createdAt: NOW, personaFeedback: [], status: 'verified', ...extra,
    });
  const reads = () => stakeholderRepos(t.store).reads.list({ workspaceId: 'ws_a' });
  const personaRuns = () => t.requests.filter((r) => r.role === 'persona');
  return { ...t, answers, results, stakeholder, rec, reads, personaRuns };
}

/** Two own stakeholders (one open, one hidden), one unusable own, one competitor's; two usable recommendations and one unusable. */
function seeded(opts: Parameters<typeof setup>[0] = {}) {
  const t = setup(opts);
  const cfo = t.stakeholder('stk-cfo');
  const board = t.stakeholder('stk-board', { disclosure: 'hidden' });
  const cto = t.stakeholder('stk-cto', { status: 'pending' });
  const rival = t.stakeholder('stk-rival-ceo');
  const ops = t.stakeholder('stk-ops');
  t.rec('rec_1');
  t.rec('rec_2');
  t.rec('rec_pending', { status: 'pending' });
  return { ...t, cfo, board, cto, rival, ops };
}

describe('runStakeholderReads', () => {
  it('one read per (open usable stakeholder, usable recommendation), own first by slug, then competitors', async () => {
    const t = seeded();
    const report = await runStakeholderReads('ws_a', t.deps);
    expect(report).toEqual({ reads: 6, missing: [], skippedByCap: 0 });
    expect(t.personaRuns().map((r) => `${slugOf(r)}:${recOf(r)}`)).toEqual([
      'stk-cfo:rec_1', 'stk-cfo:rec_2', 'stk-ops:rec_1', 'stk-ops:rec_2', 'stk-rival-ceo:rec_1', 'stk-rival-ceo:rec_2',
    ]);
    for (const r of t.personaRuns()) {
      expect(r).toMatchObject({ kind: 'work', role: 'persona' });
      // Final review item 5: an own stakeholder reads offline; a competitor's stakeholder as before.
      expect(r.offline).toBe(slugOf(r).startsWith('stk-rival-') ? undefined : true);
    }
    for (const run of t.store.agentRuns.list({ role: 'persona' })) expect(run.status).toBe('done');
    const reads = t.reads();
    expect(reads).toHaveLength(6);
    for (const read of reads) {
      expect(read.id).toMatch(/^srd_/);
      expect(read).toMatchObject({
        rootWorkspaceId: 'ws_a', workspaceId: 'ws_a', personaVersion: 3, simulated: true,
        conditions: ['a pilot first'], concerns: ['cost'], wouldChangeMind: 'evidence of payback',
      });
      expect(read.personaId).not.toBe(t.board.id);
      expect(read.personaId).not.toBe(t.cto.id);
      expect(read.recommendationId).not.toBe('rec_pending');
      expect(t.store.agentRuns.get(read.agentRunId)).toMatchObject({ role: 'persona', workspaceId: 'ws_a' });
    }
    expect(reads.filter((r) => r.personaId === t.rival.id).map((r) => r.stance)).toEqual(['watch', 'watch']);
    expect(reads.filter((r) => r.personaId === t.cfo.id).map((r) => r.stance)).toEqual(['approve', 'approve']);
  });

  it('the prompt fences the recommendation and asks own stakeholders to approve, competitors how they would respond', async () => {
    const t = seeded();
    await runStakeholderReads('ws_a', t.deps);
    const own = t.personaRuns().find((r) => slugOf(r) === 'stk-cfo')!;
    const rival = t.personaRuns().find((r) => slugOf(r) === 'stk-rival-ceo')!;
    expect(own.prompt).toMatch(/<<<EVIDENCE \S+\nTitle: Title of rec_1\n\nSummary of rec_1\n>>>/);
    expect(own.prompt).toMatch(/would you approve/i);
    expect(own.prompt).toContain('approve, approve_with_conditions, reject, not_my_call');
    expect(own.prompt).not.toContain('ignore, watch, copy, counter');
    expect(rival.prompt).toMatch(/how would .* respond/i);
    expect(rival.prompt).toContain('ignore, watch, copy, counter');
    expect(own.prompt).toContain('Acme Payments');
    expect(own.systemPrompt).toMatch(/submit_stakeholder_read/);
  });

  it('records each read as a persona_feedback Decision stamped with the persona and the recommendation', async () => {
    const t = seeded();
    await runStakeholderReads('ws_a', t.deps);
    const read = t.reads().find((r) => r.personaId === t.cfo.id && r.recommendationId === 'rec_1')!;
    const ds = t.store.decisions.list({ agentRunId: read.agentRunId, kind: 'persona_feedback' });
    expect(ds).toHaveLength(1);
    expect(ds[0]!.payload).toMatchObject({
      tool: 'submit_stakeholder_read', personaId: t.cfo.id, recommendationId: 'rec_1', targetId: `rec_1:${t.cfo.id}`,
      input: { recommendation_id: 'rec_1', stance: 'approve' },
    });
    expect(ds[0]!.refs).toEqual(expect.arrayContaining(['rec_1', t.cfo.id]));
  });

  it('never changes the recommendation: priority and persona feedback stay', async () => {
    const t = seeded();
    t.store.recommendations.update('rec_1', {
      personaFeedback: [{ personaId: 'per_seg', scores: { appeal: 4, adoption: 3, willingnessToPay: 2, friction: 1 }, concerns: [], reasoning: 'r', wouldChangeMind: 'w', simulated: true }],
    });
    const before = [t.store.recommendations.get('rec_1'), t.store.recommendations.get('rec_2')];
    await runStakeholderReads('ws_a', t.deps);
    expect([t.store.recommendations.get('rec_1'), t.store.recommendations.get('rec_2')]).toEqual(before);
  });

  it('a stance outside the persona\'s set is refused; the persona may correct it in the same run', async () => {
    const t = setup();
    const cfo = t.stakeholder('stk-cfo');
    const rival = t.stakeholder('stk-rival-ceo');
    t.rec('rec_1');
    t.answers['stk-cfo'] = { stance: 'copy' };
    t.answers['stk-rival-ceo'] = { stance: 'approve' };
    const report = await runStakeholderReads('ws_a', t.deps);
    expect(t.results.every((r) => !r.ok)).toBe(true);
    expect(t.results.find((r) => r.slug === 'stk-cfo')!.error).toMatch(/stance must be one of approve, approve_with_conditions, reject, not_my_call/);
    expect(t.results.find((r) => r.slug === 'stk-rival-ceo')!.error).toMatch(/stance must be one of ignore, watch, copy, counter/);
    expect(t.reads()).toEqual([]);
    expect(report.missing.map((m) => m.personaId).sort()).toEqual([cfo.id, rival.id].sort());
    expect(t.store.decisions.list({ workspaceId: 'ws_a', kind: 'persona_feedback' })).toEqual([]);

    // corrected within one run: the refused call stores nothing, the second one is the read
    const u = setup();
    u.stakeholder('stk-cfo');
    u.rec('rec_1');
    u.state.pick = (req) =>
      req.role !== 'persona'
        ? undefined
        : async (tools) => {
            const base = { recommendation_id: 'rec_1', conditions: [], concerns: [], reasoning: 'r', would_change_mind: 'w' };
            await expect(tools.call('submit_stakeholder_read', { ...base, stance: 'counter' })).rejects.toThrow(/stance/);
            await tools.call('submit_stakeholder_read', { ...base, stance: 'reject' });
          };
    expect(await runStakeholderReads('ws_a', u.deps)).toMatchObject({ reads: 1, missing: [] });
    expect(u.reads().map((r) => r.stance)).toEqual(['reject']);
  });

  it('refuses a read of another recommendation than the one asked, a persona run that was asked nothing, and oversized texts', async () => {
    const t = setup();
    t.stakeholder('stk-cfo');
    t.rec('rec_1');
    t.rec('rec_2');
    const errors: string[] = [];
    t.state.pick = (req) =>
      req.role !== 'persona'
        ? undefined
        : async (tools) => {
            const base = { stance: 'approve', conditions: [], concerns: [], reasoning: 'r', would_change_mind: 'w' };
            const other = recOf(req) === 'rec_1' ? 'rec_2' : 'rec_1';
            for (const input of [
              { ...base, recommendation_id: other },
              { ...base, recommendation_id: recOf(req), conditions: ['1', '2', '3', '4', '5', '6'] },
              { ...base, recommendation_id: recOf(req), concerns: ['x'.repeat(301)] },
              { ...base, recommendation_id: recOf(req), reasoning: 'x'.repeat(1001) },
              { ...base, recommendation_id: recOf(req), would_change_mind: 'x'.repeat(1001) },
            ]) {
              await tools.call('submit_stakeholder_read', input).catch((e: Error) => errors.push(e.message));
            }
          };
    const report = await runStakeholderReads('ws_a', t.deps);
    expect(report.reads).toBe(0);
    expect(errors).toHaveLength(20);
    expect(errors[0]).toMatch(/rec_/);
    const ctx: RunContext = { agentRunId: newId('arun'), workspaceId: 'ws_a', role: 'persona', model: { provider: 'claude', model: 'sonnet' }, promptVersion: 'pv' };
    const r = await t.handle(ctx, 'submit_stakeholder_read', {
      recommendation_id: 'rec_1', stance: 'approve', conditions: [], concerns: [], reasoning: 'r', would_change_mind: 'w',
    });
    expect(r).toMatchObject({ ok: false });
    expect(await t.handle({ ...ctx, role: 'worker' }, 'submit_stakeholder_read', {})).toMatchObject({ ok: false, error: expect.stringMatching(/not available to role/) });
  });

  it('a second panel replaces each persona\'s read of a recommendation', async () => {
    const t = seeded();
    await runStakeholderReads('ws_a', t.deps);
    const first = t.reads().find((r) => r.personaId === t.cfo.id && r.recommendationId === 'rec_1')!;
    t.answers['stk-cfo'] = { stance: 'reject', concerns: ['too risky'] };
    t.store.personas.update(t.cfo.id, { version: 4 });
    await runStakeholderReads('ws_a', t.deps);
    expect(t.reads()).toHaveLength(6);
    const second = stakeholderRepos(t.store).reads.list({ personaId: t.cfo.id, recommendationId: 'rec_1' });
    expect(second).toHaveLength(1);
    expect(second[0]).toMatchObject({ stance: 'reject', concerns: ['too risky'], personaVersion: 4 });
    expect(second[0]!.agentRunId).not.toBe(first.agentRunId);
  });

  it('the cap counts runs: pairs beyond it are skipped, counted and recorded in one harness Decision', async () => {
    const t = seeded({ maxReadsPerPanel: 4 });
    const report = await runStakeholderReads('ws_a', t.deps);
    expect(report).toEqual({ reads: 4, missing: [], skippedByCap: 2 });
    expect(t.personaRuns()).toHaveLength(4);
    expect(t.personaRuns().map(slugOf)).not.toContain('stk-rival-ceo'); // own stakeholders first
    const capped = t.store.decisions.list({ workspaceId: 'ws_a' }).filter((d) => (d.payload as { event?: string }).event === 'stakeholder_reads_capped');
    expect(capped).toHaveLength(1);
    expect(capped[0]!.payload).toMatchObject({ tool: 'harness', maxReadsPerPanel: 4, skipped: 2 });
  });

  it('a run without the tool is retried once, then reported missing with a harness Decision per attempt; retries count against the cap', async () => {
    const t = setup();
    const cfo = t.stakeholder('stk-cfo');
    t.rec('rec_1');
    t.answers['stk-cfo'] = (attempt) => (attempt === 1 ? 'silent' : { stance: 'not_my_call' });
    expect(await runStakeholderReads('ws_a', t.deps)).toEqual({ reads: 1, missing: [], skippedByCap: 0 });
    expect(t.personaRuns()).toHaveLength(2);
    expect(t.reads().map((r) => [r.personaId, r.stance])).toEqual([[cfo.id, 'not_my_call']]);

    const u = setup();
    const ops = u.stakeholder('stk-ops');
    u.rec('rec_1');
    u.answers['stk-ops'] = 'silent';
    const report = await runStakeholderReads('ws_a', u.deps);
    expect(report).toEqual({ reads: 0, missing: [{ recommendationId: 'rec_1', personaId: ops.id, reason: 'no submit_stakeholder_read call' }], skippedByCap: 0 });
    expect(u.personaRuns()).toHaveLength(2);
    const missing = u.store.decisions.list({ workspaceId: 'ws_a' }).filter((d) => (d.payload as { event?: string }).event === 'stakeholder_read_missing');
    expect(missing.map((d) => (d.payload as { attempt: number; willRetry: boolean }).willRetry)).toEqual([true, false]);

    // with the cap used up by first attempts, a silent pair is not retried
    const v = setup({ maxReadsPerPanel: 1 });
    v.stakeholder('stk-ops');
    v.rec('rec_1');
    v.answers['stk-ops'] = 'silent';
    const capped = await runStakeholderReads('ws_a', v.deps);
    expect(v.personaRuns()).toHaveLength(1);
    expect(capped.missing).toHaveLength(1);
    expect(capped.skippedByCap).toBe(0);
    const vMissing = v.store.decisions.list({ workspaceId: 'ws_a' }).filter((d) => (d.payload as { event?: string }).event === 'stakeholder_read_missing');
    expect(vMissing.map((d) => (d.payload as { willRetry: boolean }).willRetry)).toEqual([false]);
  });

  it('disabled stakeholders run nothing', async () => {
    const t = seeded({ enabled: false });
    expect(await runStakeholderReads('ws_a', t.deps)).toEqual({ reads: 0, missing: [], skippedByCap: 0 });
    expect(t.personaRuns()).toEqual([]);
  });

  it('runs in the persona panel after the segment personas, even with no segment persona', async () => {
    const t = seeded();
    const report = await runPersonaPanel('ws_a', t.deps);
    expect(report.feedback).toBe(0);
    expect(report.stakeholderReads).toEqual({ reads: 6, missing: [], skippedByCap: 0 });
    expect(t.reads()).toHaveLength(6);
  });
});

describe('readsOf', () => {
  it('returns the reads of open personas only, never one of a hidden persona, and only within the caller\'s tree', async () => {
    const t = seeded();
    await runStakeholderReads('ws_a', t.deps);
    stakeholderRepos(t.store).reads.insert({
      id: 'srd_hidden', rootWorkspaceId: 'ws_a', workspaceId: 'ws_a', recommendationId: 'rec_1', personaId: t.board.id, personaVersion: 3,
      stance: 'reject', conditions: [], concerns: [], reasoning: 'r', wouldChangeMind: 'w', agentRunId: 'arun_x', simulated: true, createdAt: NOW,
    });
    const reads = readsOf(t.store, 'ws_a', 'rec_1');
    expect(reads.map((r) => r.personaId)).toEqual([t.cfo.id, t.ops.id, t.rival.id]);
    expect(reads.map((r) => r.id)).not.toContain('srd_hidden');
    expect(readsOf(t.store, 'ws_other', 'rec_1')).toEqual([]);
  });

  it('serves each read with the user\'s latest reaction to it, and none once the read was replaced by a newer run', async () => {
    const t = seeded();
    await runStakeholderReads('ws_a', t.deps);
    const [first, second] = readsOf(t.store, 'ws_a', 'rec_1');
    expect(first!.reaction).toBeUndefined();
    expect(first!.reactionReason).toBeUndefined();
    reactToRead(t.store, ACTOR, 'ws_a', first!.id, 'disagree', 'Our CFO would never approve this');
    reactToRead(t.store, ACTOR, 'ws_a', first!.id, 'agree');
    reactToRead(t.store, ACTOR, 'ws_a', second!.id, 'disagree', 'Ops is short of people');
    const served = readsOf(t.store, 'ws_a', 'rec_1');
    expect(served[0]).toMatchObject({ id: first!.id, reaction: 'agree' });
    expect(served[0]!.reactionReason).toBeUndefined();
    expect(served[1]).toMatchObject({ id: second!.id, reaction: 'disagree', reactionReason: 'Ops is short of people' });
    stakeholderRepos(t.store).reads.update(second!.id, { agentRunId: 'arun_newer', stance: 'reject' });
    expect(readsOf(t.store, 'ws_a', 'rec_1')[1]!.reaction).toBeUndefined();
  });
});

describe('reactToRead', () => {
  it('records stakeholder_read_reaction with the read\'s persona, version, recommendation and stance', async () => {
    const t = seeded();
    await runStakeholderReads('ws_a', t.deps);
    const read = readsOf(t.store, 'ws_a', 'rec_1')[0]!;
    const e = reactToRead(t.store, ACTOR, 'ws_a', read.id, 'disagree', '  Our CFO would never approve this  ');
    expect(e).toMatchObject({
      kind: 'stakeholder_read_reaction', targetType: 'stakeholder_read', targetId: read.id, actor: ACTOR, workspaceId: 'ws_a',
      reason: 'Our CFO would never approve this', agentRunId: read.agentRunId,
      afterJson: { reaction: 'disagree', personaId: read.personaId, personaVersion: 3, recommendationId: 'rec_1', stance: 'approve' },
    });
    expect(reactToRead(t.store, ACTOR, 'ws_a', read.id, 'agree').reason).toBeUndefined();
    expect(listFeedback(t.store, { kind: 'stakeholder_read_reaction' })).toHaveLength(2);
  });

  it('answers 404 across trees, for an unknown read and for a hidden persona\'s read; 400 for an unknown reaction', async () => {
    const t = seeded();
    await runStakeholderReads('ws_a', t.deps);
    const read = readsOf(t.store, 'ws_a', 'rec_1')[0]!;
    stakeholderRepos(t.store).reads.insert({ ...read, id: 'srd_hidden', personaId: t.board.id, recommendationId: 'rec_2' });
    const refusal = (fn: () => unknown): StakeholderError => {
      try {
        fn();
      } catch (e) {
        if (e instanceof StakeholderError) return e;
        throw e;
      }
      throw new Error('expected a refusal');
    };
    expect(refusal(() => reactToRead(t.store, ACTOR, 'ws_other', read.id, 'agree')).status).toBe(404);
    expect(refusal(() => reactToRead(t.store, ACTOR, 'ws_a', 'srd_missing', 'agree')).status).toBe(404);
    expect(refusal(() => reactToRead(t.store, ACTOR, 'ws_a', 'srd_hidden', 'agree')).status).toBe(404);
    expect(refusal(() => reactToRead(t.store, ACTOR, 'ws_a', read.id, 'maybe' as 'agree')).status).toBe(400);
    expect(refusal(() => reactToRead(t.store, ACTOR, 'ws_a', read.id, 'agree', 'x'.repeat(3000))).status).toBe(400);
    expect(listFeedback(t.store, { kind: 'stakeholder_read_reaction' })).toEqual([]);
  });
});
