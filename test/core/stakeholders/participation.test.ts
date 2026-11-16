/**
 * Stakeholder positions, task 1 (design 2026-11-15-stakeholder-positions-design.md §6): what an own
 * stakeholder, a former colleague at a competitor and a parked former colleague take part in — each
 * cell of the table — and what the agent.md of a former colleague says.
 *
 * The four personas of every test: `own` (Head of finance), `gone` (Head of sales, left for Rival Pay),
 * `parked` (Head of legal, left for somewhere that is no competitor) and `rival` (the CEO of Rival Pay,
 * who never worked here).
 */
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BifConfig } from '../../../src/core/config/schema.js';
import { recordFeedback } from '../../../src/core/feedback/events.js';
import type { FakeScript } from '../../../src/core/harness/adapter.js';
import { buildInterviewPrompt, interviewToolHandlers } from '../../../src/core/interview/interview.js';
import { compileStakeholderMd, STAKEHOLDER_AGENT_MD_HEADINGS } from '../../../src/core/market/agentMd.js';
import { agentMdPath, writeAgentMd } from '../../../src/core/market/personas.js';
import { personaLearningToolHandlers, runPersonaLearning } from '../../../src/core/personas/learn.js';
import { collectPersonaSignals } from '../../../src/core/personas/signals.js';
import { personaLearningRepos } from '../../../src/core/personas/store.js';
import type { AgentRequest } from '../../../src/core/research/deps.js';
import { STAKEHOLDER_FIELDS } from '../../../src/core/scoring/criteria.js';
import { stakeholderSlug, stakeholderTaskSection, stakeholderToolHandlers } from '../../../src/core/stakeholders/personas.js';
import { changePosition, formerColleagues, holdsInternal, markLeft, markReturned, type PositionDeps } from '../../../src/core/stakeholders/positions.js';
import { answerQuestions, ensureQuestions } from '../../../src/core/stakeholders/questions.js';
import { reactToRead, readsOf, runStakeholderReads, submitStakeholderReadHandler } from '../../../src/core/stakeholders/reads.js';
import { addNote, recordDecision, StakeholderError } from '../../../src/core/stakeholders/statements.js';
import { stakeholderRepos } from '../../../src/core/stakeholders/store.js';
import type { Store } from '../../../src/core/store/db.js';
import { newId } from '../../../src/core/store/repos.js';
import type { Persona, PersonaProfileField } from '../../../src/core/types.js';
import { fixtureStakeholderTask, researchSetup } from '../helpers/research.js';

const T0 = '2026-11-15T10:00:00.000Z';
const ACTOR = 'tester';
const LEFT = '2026-10-31';
const CODEX = { provider: 'codex' as const, model: 'gpt-6.1-sol' };

const opened: Store[] = [];
let minute = 0;
beforeEach(() => {
  minute = 0;
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(T0));
});
afterEach(() => {
  vi.useRealTimers();
  for (const s of opened.splice(0)) s.close();
});
const tick = () => vi.setSystemTime(new Date(Date.parse(T0) + ++minute * 60_000));
const later = () => new Date(Date.parse(T0) + (minute + 1) * 60_000);

/** The default config with Claude and OpenCode disabled: no enabled provider can run offline. */
const codexOnly = (c: BifConfig) => {
  c.providers.claude = { ...c.providers.claude, enabled: false };
  c.providers.opencode = { ...c.providers.opencode, enabled: false };
};

const slugOf = (req: AgentRequest) => /^name: (\S+)$/m.exec(req.systemPrompt)?.[1] ?? '';
const personaOf = (prompt: string) => /persona_id `(\w+)`/.exec(prompt)![1]!;
const profileOf = (label: string): Record<string, PersonaProfileField> =>
  Object.fromEntries(STAKEHOLDER_FIELDS.map((f) => [f, { value: `${f} of ${label}`, confidence: 0.6, evidence: [] }]));

function setup(configure?: (c: BifConfig) => void) {
  const dir = mkdtempSync(join(tmpdir(), 'bif-stk-part-'));
  const t = researchSetup(opened, {
    dir,
    extraHandlers: () => ({
      ...stakeholderToolHandlers({ dataDir: dir }), ...interviewToolHandlers(), ...personaLearningToolHandlers(),
      submit_stakeholder_read: submitStakeholderReadHandler,
    }),
    ...(configure ? { config: configure } : {}),
  });
  t.store.workspaces.insert({ id: 'ws_a', name: 'Acme', sector: 'saas', createdAt: T0, scope: { level: 'division', name: 'Acme Payments', description: 'payments' } });
  t.store.competitors.insert({
    id: 'cmp_rival', workspaceId: 'ws_a', name: 'Rival Pay', threat: 4, directness: 5, comparison: { pricing: 3, onboarding: 3, ux: 3, features: 3 }, evidence: [],
    createdAt: T0, updatedAt: T0, status: 'verified',
  });
  const pos: PositionDeps = { store: t.store, dataDir: dir };
  const stakeholder = (label: string, extra: Partial<Persona> = {}): Persona => {
    const slug = extra.slug ?? stakeholderSlug(label);
    const p = t.store.personas.insert({
      id: newId('per'), workspaceId: 'ws_a', slug, segment: label, profile: profileOf(label), version: 1, status: 'verified',
      agentMdPath: agentMdPath(dir, 'ws_a', slug), kind: 'stakeholder', stakeholderType: 'leader', subjectKind: 'own', relation: `relation of ${label}`,
      disclosure: 'open', ...extra,
    });
    writeAgentMd(t.store, p);
    return t.store.personas.get(p.id)!;
  };
  const own = stakeholder('Head of finance');
  const gone = markLeft(pos, ACTOR, 'ws_a', stakeholder('Head of sales').id, { date: LEFT, to: { competitorId: 'cmp_rival' }, title: 'VP Sales' });
  const parked = markLeft(pos, ACTOR, 'ws_a', stakeholder('Head of legal').id, { date: LEFT, to: { elsewhere: { companyName: 'A law firm' } } });
  const rival = stakeholder('CEO', { slug: 'stk-rival-pay-ceo', subjectKind: 'competitor', subjectId: 'cmp_rival' });
  const rec = (id: string) =>
    t.store.recommendations.insert({
      id, workspaceId: 'ws_a', title: `Title of ${id}`, summary: `Summary of ${id}`, criteria: {}, findingIds: [], priority: 3, createdAt: T0, personaFeedback: [],
      status: 'verified',
    });
  const harnessEvents = (event: string) =>
    t.store.decisions.list({}).filter((d) => (d.payload as { tool?: string; event?: string }).tool === 'harness' && (d.payload as { event?: string }).event === event);
  return { ...t, pos, stakeholder, own, gone, parked, rival, rec, harnessEvents };
}

const refusal = (fn: () => unknown): StakeholderError => {
  try {
    fn();
  } catch (e) {
    if (e instanceof StakeholderError) return e;
    throw e;
  }
  throw new Error('expected a refusal');
};

// ---------------------------------------------------------------------------------------------------
describe('the four personas', () => {
  it('are what the tests below take them for', () => {
    const t = setup();
    expect(t.own).toMatchObject({ subjectKind: 'own', slug: 'stk-head-of-finance' });
    expect(t.gone).toMatchObject({ subjectKind: 'competitor', subjectId: 'cmp_rival', leftAt: LEFT, slug: 'stk-rival-pay-head-of-sales' });
    expect(t.parked).toMatchObject({ subjectKind: 'former', leftAt: LEFT, slug: 'stk-head-of-legal' });
    expect(t.rival).toMatchObject({ subjectKind: 'competitor', subjectId: 'cmp_rival' });
    expect(t.rival).not.toHaveProperty('leftAt');
    expect([t.own, t.gone, t.parked, t.rival].map(holdsInternal)).toEqual([true, true, true, false]);
  });
});

// ---------------------------------------------------------------------------------------------------
describe('question round: own stakeholders only', () => {
  it('a hidden own stakeholder gets questions; a hidden former colleague (at a competitor or parked) and a competitor\'s stakeholder get none', () => {
    const t = setup();
    const board = t.stakeholder('Board', { disclosure: 'hidden' });
    for (const p of [t.gone, t.parked, t.rival]) t.store.personas.update(p.id, { disclosure: 'hidden' });
    const made = ensureQuestions(t.store, 'ws_a');
    expect([...new Set(made.map((q) => q.personaId ?? 'node'))]).toEqual([board.id, 'node']);
    for (const p of [t.gone, t.parked, t.rival]) expect(stakeholderRepos(t.store).questions.list({ personaId: p.id })).toEqual([]);
  });

  it('with only former colleagues hidden at the node, no round is created', () => {
    const t = setup();
    for (const p of [t.gone, t.parked]) t.store.personas.update(p.id, { disclosure: 'hidden' });
    expect(ensureQuestions(t.store, 'ws_a')).toEqual([]);
  });

  it('leaving closes the open questions of the round, so nothing waits for an answer about someone who left', () => {
    const t = setup();
    const p = t.stakeholder('Head of ops', { disclosure: 'hidden' });
    ensureQuestions(t.store, 'ws_a');
    // Skipping opens it; a question added later (older data) is closed by leaving.
    answerQuestions(t.store, ACTOR, 'ws_a', { answers: [], skip: [p.id] });
    stakeholderRepos(t.store).questions.insert({ id: 'stq_late', rootWorkspaceId: 'ws_a', workspaceId: 'ws_a', personaId: p.id, field: 'objections', text: 'q', status: 'open', createdAt: T0 });
    markLeft(t.pos, ACTOR, 'ws_a', p.id, { date: LEFT, to: { elsewhere: {} } });
    expect(stakeholderRepos(t.store).questions.list({ personaId: p.id, status: 'open' })).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------------
describe('reads of recommendations', () => {
  type Stance = string | ((req: AgentRequest) => string);
  const answering = (t: ReturnType<typeof setup>, stances: Record<string, Stance> = {}) => {
    const results: Array<{ slug: string; ok: boolean; error?: string }> = [];
    t.state.pick = (req) => {
      if (req.role !== 'persona') return undefined;
      const slug = slugOf(req);
      const rec = /^Recommendation id: (\S+)$/m.exec(req.prompt)![1]!;
      const chosen = stances[slug] ?? (/^subject: competitor$/m.test(req.systemPrompt) ? 'watch' : 'approve');
      const script: FakeScript = async (tools) => {
        try {
          await tools.call('submit_stakeholder_read', {
            recommendation_id: rec, stance: typeof chosen === 'function' ? chosen(req) : chosen, conditions: [], concerns: [], reasoning: `${slug} on ${rec}`,
            would_change_mind: 'w',
          });
          results.push({ slug, ok: true });
        } catch (e) {
          results.push({ slug, ok: false, error: (e as Error).message });
        }
      };
      return script;
    };
    return results;
  };
  const personaRuns = (t: ReturnType<typeof setup>) => t.requests.filter((r) => r.role === 'persona');

  it('own: an approval read, offline; former colleague at a competitor: a rival read, offline; parked: none; a competitor\'s stakeholder: a rival read, not offline', async () => {
    const t = setup();
    t.rec('rec_1');
    answering(t);
    expect(await runStakeholderReads('ws_a', t.deps)).toEqual({ reads: 3, missing: [], skippedByCap: 0 });
    const runs = personaRuns(t);
    // Own first, then the competitor's stakeholders by slug; the parked one is not asked.
    expect(runs.map(slugOf)).toEqual(['stk-head-of-finance', 'stk-rival-pay-ceo', 'stk-rival-pay-head-of-sales']);
    expect(runs.map((r) => r.offline)).toEqual([true, undefined, true]);
    const [ownRun, rivalRun, goneRun] = runs;
    expect(ownRun!.prompt).toContain('Would you approve this if it came to you?');
    expect(ownRun!.prompt).toContain('approve, approve_with_conditions, reject, not_my_call');
    for (const r of [rivalRun!, goneRun!]) {
      expect(r.prompt).toContain('Imagine Acme Payments, your rival, did this.');
      expect(r.prompt).toContain('ignore, watch, copy, counter');
      expect(r.prompt).not.toContain('Would you approve');
    }
    // The former colleague reads as who they are now, with what they knew when they left.
    expect(goneRun!.systemPrompt).toContain('former_colleague: true');
    expect(goneRun!.systemPrompt).toContain(`Until ${LEFT} you worked at Acme Payments`);
    const reads = stakeholderRepos(t.store).reads.list({ workspaceId: 'ws_a' });
    expect(Object.fromEntries(reads.map((r) => [r.personaId, r.stance]))).toEqual({ [t.own.id]: 'approve', [t.rival.id]: 'watch', [t.gone.id]: 'watch' });
    expect(reads.some((r) => r.personaId === t.parked.id)).toBe(false);
    // Shown own first, then the competitor's.
    expect(readsOf(t.store, 'ws_a', 'rec_1').map((r) => r.personaId)).toEqual([t.own.id, t.rival.id, t.gone.id]);
  });

  it('a former colleague at a competitor cannot answer with an approval stance, nor a parked one be asked', async () => {
    const t = setup();
    t.rec('rec_1');
    const results = answering(t, { 'stk-rival-pay-head-of-sales': 'approve' });
    const report = await runStakeholderReads('ws_a', t.deps);
    expect(report.reads).toBe(2);
    expect(report.missing.map((m) => m.personaId)).toEqual([t.gone.id]);
    const refused = results.filter((r) => r.slug === 'stk-rival-pay-head-of-sales');
    expect(refused.length).toBeGreaterThan(0);
    for (const r of refused) expect(r).toMatchObject({ ok: false, error: expect.stringContaining('ignore, watch, copy, counter') });
    expect(results.some((r) => r.slug === 'stk-head-of-legal')).toBe(false);
  });

  it('an approval read made before leaving is replaced by the rival read', async () => {
    const t = setup();
    t.rec('rec_1');
    const p = t.stakeholder('Head of ops');
    answering(t);
    await runStakeholderReads('ws_a', t.deps);
    const before = stakeholderRepos(t.store).reads.list({ personaId: p.id });
    expect(before.map((r) => r.stance)).toEqual(['approve']);
    markLeft(t.pos, ACTOR, 'ws_a', p.id, { date: LEFT, to: { competitorId: 'cmp_rival' } });
    await runStakeholderReads('ws_a', t.deps);
    const after = stakeholderRepos(t.store).reads.list({ personaId: p.id });
    expect(after.map((r) => `${r.id}:${r.stance}:${r.personaVersion}`)).toEqual([`${before[0]!.id}:watch:2`]);
  });

  it('with no provider that can run offline, the reads of the own stakeholder and of the former colleague are skipped; the competitor\'s stakeholder reads', async () => {
    const t = setup((c) => {
      codexOnly(c);
      c.roles.persona = CODEX;
    });
    t.rec('rec_1');
    answering(t);
    expect((await runStakeholderReads('ws_a', t.deps)).reads).toBe(1);
    expect(personaRuns(t).map((r) => `${slugOf(r)}:${r.offline}`)).toEqual(['stk-rival-pay-ceo:undefined']);
    const why = t.harnessEvents('stakeholder_reads_offline_unavailable');
    expect(why).toHaveLength(1);
    expect((why[0]!.payload as { personaIds: string[] }).personaIds).toEqual([t.own.id, t.gone.id]);
  });

  it('the user can still react to a read a parked former colleague made before leaving', async () => {
    const t = setup();
    t.rec('rec_1');
    const p = t.stakeholder('Head of ops');
    answering(t);
    await runStakeholderReads('ws_a', t.deps);
    const read = stakeholderRepos(t.store).reads.list({ personaId: p.id })[0]!;
    markLeft(t.pos, ACTOR, 'ws_a', p.id, { date: LEFT, to: { elsewhere: {} } });
    expect(reactToRead(t.store, ACTOR, 'ws_a', read.id, 'disagree').targetId).toBe(read.id);
    // Its old read is listed after the own stakeholders' and the competitors'.
    expect(readsOf(t.store, 'ws_a', 'rec_1').map((r) => r.personaId)).toEqual([t.own.id, t.rival.id, t.gone.id, p.id]);
  });
});

// ---------------------------------------------------------------------------------------------------
describe('recording a real decision: own stakeholders only', () => {
  it('own: stored; former colleague at a competitor, parked, a competitor\'s stakeholder: 400', () => {
    const t = setup();
    t.rec('rec_1');
    const record = (personaId: string) => recordDecision(t.store, ACTOR, 'ws_a', { recommendationId: 'rec_1', personaId, decision: 'approved', reasoning: 'Fits the plan' });
    expect(record(t.own.id)).toMatchObject({ source: 'decision_record', personaId: t.own.id });
    for (const p of [t.gone, t.parked, t.rival]) {
      const e = refusal(() => record(p.id));
      expect(e.status, p.slug).toBe(400);
      expect(e.message).toContain('not an own stakeholder');
    }
    expect(stakeholderRepos(t.store).statements.list({ source: 'decision_record' })).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------------------------------
describe('notes by the user: everyone', () => {
  it('a note is stored on an own stakeholder, a former colleague at a competitor and a parked one', () => {
    const t = setup();
    for (const p of [t.own, t.gone, t.parked]) {
      expect(addNote(t.store, ACTOR, 'ws_a', { personaId: p.id, text: `About ${p.segment}` })).toMatchObject({ personaId: p.id, source: 'note', workspaceId: 'ws_a' });
    }
    expect(stakeholderRepos(t.store).statements.list({ source: 'note' })).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------------------------------
describe('learning from notes and reactions', () => {
  const learning = (configure?: (c: BifConfig) => void) => {
    const t = setup(configure);
    t.state.pick = (r) => (r.role === 'retro' ? async (tc) => void (await tc.call('submit_persona_learning', { persona_id: personaOf(r.prompt), assumption: 'a', proposals: [] })) : undefined);
    const note = (p: Persona) => {
      tick();
      return addNote(t.store, ACTOR, 'ws_a', { personaId: p.id, text: 'Only signs off on things that pay back within a year.' });
    };
    /** `n` disagreeing reactions, each to a read of a different recommendation. */
    const disagree = (p: Persona, n: number) => {
      for (let i = 0; i < n; i++) {
        tick();
        const recId = newId('rec');
        t.rec(recId);
        const read = stakeholderRepos(t.store).reads.insert({
          id: newId('srd'), rootWorkspaceId: 'ws_a', workspaceId: 'ws_a', recommendationId: recId, personaId: p.id, personaVersion: p.version,
          stance: p.subjectKind === 'own' ? 'approve' : 'watch', conditions: [], concerns: [], reasoning: 'r', wouldChangeMind: 'w', agentRunId: 'arun_read',
          simulated: true, createdAt: new Date().toISOString(),
        });
        tick();
        reactToRead(t.store, ACTOR, 'ws_a', read.id, 'disagree', 'would never do that');
      }
    };
    const run = () => runPersonaLearning(t.deps, 'ws_a', { now: later() });
    const learners = () => t.requests.filter((r) => r.role === 'retro').map((r) => personaOf(r.prompt));
    const offlineOf = (p: Persona) => t.requests.find((r) => r.role === 'retro' && personaOf(r.prompt) === p.id)?.offline;
    return { ...t, note, disagree, run, learners, offlineOf };
  };

  it('notes: an own stakeholder, a former colleague at a competitor and a parked one each learn from one, offline; a competitor\'s stakeholder not offline', async () => {
    const t = learning();
    for (const p of [t.own, t.gone, t.parked, t.rival]) t.note(p);
    expect(await t.run()).toMatchObject({ personasEvaluated: 4, personasQualified: 4, personaLearningRuns: 4 });
    expect(t.learners().sort()).toEqual([t.own.id, t.gone.id, t.parked.id, t.rival.id].sort());
    expect([t.own, t.gone, t.parked, t.rival].map(t.offlineOf)).toEqual([true, true, true, undefined]);
  });

  it('reactions: they qualify an own stakeholder and a former colleague at a competitor (offline), not a parked one', async () => {
    const t = learning();
    // Reactions to the reads each made; the parked one's are to reads from before it left.
    for (const p of [t.own, t.gone, t.parked]) t.disagree(p, 8);
    expect(await t.run()).toMatchObject({ personasEvaluated: 4, personasQualified: 2, personaLearningRuns: 2 });
    expect(t.learners().sort()).toEqual([t.own.id, t.gone.id].sort());
    expect([t.own, t.gone].map(t.offlineOf)).toEqual([true, true]);
    expect(personaLearningRepos(t.store).runs.list({ personaId: t.parked.id })).toEqual([]);
  });

  it('a parked former colleague learns from its notes only: the run is shown the note and no reaction', async () => {
    const t = learning();
    t.disagree(t.parked, 8);
    const st = t.note(t.parked);
    expect(await t.run()).toMatchObject({ personasQualified: 1, personaLearningRuns: 1 });
    const [run] = personaLearningRepos(t.store).runs.list({ personaId: t.parked.id });
    expect(run).toMatchObject({ shownStatementIds: [st.id], shownSignalIds: [] });
    const prompt = t.requests.find((r) => r.role === 'retro')!.prompt;
    expect(prompt).toContain(st.id);
    expect(prompt).not.toContain('would never do that');
    // The header says who this is now, never "own".
    expect(prompt).toContain(`- subject: a former colleague (left on ${LEFT})`);
  });

  it('the learning prompt of a former colleague at a competitor names it as one', async () => {
    const t = learning();
    t.note(t.gone);
    t.note(t.own);
    t.note(t.rival);
    await t.run();
    const promptOf = (p: Persona) => t.requests.find((r) => r.role === 'retro' && personaOf(r.prompt) === p.id)!.prompt;
    expect(promptOf(t.gone)).toContain(`- subject: a competitor's stakeholder, a former colleague (left on ${LEFT})`);
    expect(promptOf(t.own)).toContain('- subject: own');
    expect(promptOf(t.rival)).toMatch(/^- subject: a competitor's stakeholder$/m);
  });

  it('no engine retire proposal for a parked former colleague, whatever the reactions to its old reads say', async () => {
    const t = learning();
    const repos = personaLearningRepos(t.store);
    /** An active adjustment recorded on 4 of 6 disagreements, then 6 more reads, all disagreed with. */
    const adjusted = (p: Persona) => {
      tick();
      const now = new Date().toISOString();
      const a = repos.adjustments.insert({
        id: newId('pad'), rootWorkspaceId: 'ws_a', workspaceId: 'ws_a', personaId: p.id, marker: `m-${p.slug}`, text: 'You approve only what pays back within a year.',
        version: 1, status: 'active', source: 'retro', actor: ACTOR, stats: { n: 6, agree: 2, disagree: 4, items: 6, lower: 0.3 }, internal: true, createdAt: now,
        changedAt: now,
      });
      t.disagree(p, 6);
      return a;
    };
    const ofGone = adjusted(t.gone);
    const ofParked = adjusted(t.parked);
    const report = await t.run();
    // The one at a competitor still reads: its adjustment is judged. The parked one's is left alone.
    expect(repos.proposals.list({ adjustmentId: ofGone.id, action: 'retire' })).toEqual([expect.objectContaining({ source: 'engine', status: 'pending' })]);
    expect(repos.proposals.list({ personaId: t.parked.id })).toEqual([]);
    expect(report.personaProposals).toBe(1);
  });

  it('a move keeps the open reactions: made at the old node, they reach the next learning run at the new one', async () => {
    const t = learning();
    t.store.workspaces.insert({ id: 'ws_b', name: 'Acme Cards', sector: 'saas', createdAt: T0, parentWorkspaceId: 'ws_a' });
    t.store.workspaces.insert({ id: 'ws_other', name: 'Other', sector: 'saas', createdAt: T0 });
    t.disagree(t.own, 8);
    const before = collectPersonaSignals(t.store, t.own.id).map((s) => s.id);
    expect(before).toHaveLength(8);
    tick();
    const moved = changePosition(t.pos, ACTOR, 'ws_a', t.own.id, { change: 'moved', date: LEFT, toWorkspaceId: 'ws_b' });
    expect(moved.workspaceId).toBe('ws_b');
    // An event of another business tree that names the persona is no signal of it.
    recordFeedback(t.store, {
      workspaceId: 'ws_other', actor: ACTOR, kind: 'stakeholder_read_reaction', targetType: 'stakeholder_read', targetId: 'srd_foreign',
      afterJson: { reaction: 'disagree', personaId: t.own.id, personaVersion: 1, recommendationId: 'rec_foreign', stance: 'approve' },
    });
    expect(collectPersonaSignals(t.store, t.own.id).map((s) => s.id)).toEqual(before);

    expect(await t.run()).toMatchObject({ personasQualified: 1, personaLearningRuns: 1 });
    const [run] = personaLearningRepos(t.store).runs.list({ personaId: t.own.id });
    expect(run!.shownSignalIds).toEqual(before);
    expect(t.requests.find((r) => r.role === 'retro')!.workspaceId).toBe('ws_b');
  });

  it('a reaction made after the move, at the old node where the read is, counts too; and a reaction per read is counted once', async () => {
    const t = learning();
    t.store.workspaces.insert({ id: 'ws_b', name: 'Acme Cards', sector: 'saas', createdAt: T0, parentWorkspaceId: 'ws_a' });
    t.disagree(t.own, 2);
    tick();
    changePosition(t.pos, ACTOR, 'ws_a', t.own.id, { change: 'moved', date: LEFT, toWorkspaceId: 'ws_b' });
    const [first] = stakeholderRepos(t.store).reads.list({ personaId: t.own.id });
    tick();
    reactToRead(t.store, ACTOR, 'ws_b', first!.id, 'agree');
    const signals = collectPersonaSignals(t.store, t.own.id);
    expect(signals).toHaveLength(2);
    expect(signals.map((s) => s.polarity).sort()).toEqual(['agree', 'disagree']);
  });

  it('with no provider that can run offline, own and former colleagues are skipped with one harness Decision; the competitor\'s stakeholder learns', async () => {
    const t = learning((c) => {
      codexOnly(c);
      c.personaLearning = { model: CODEX };
    });
    for (const p of [t.own, t.gone, t.parked, t.rival]) t.note(p);
    await t.run();
    expect(t.learners()).toEqual([t.rival.id]);
    const why = t.harnessEvents('persona_learning_offline_unavailable');
    expect(why).toHaveLength(1);
    expect([...(why[0]!.payload as { personaIds: string[] }).personaIds].sort()).toEqual([t.own.id, t.gone.id, t.parked.id].sort());
  });
});

// ---------------------------------------------------------------------------------------------------
describe('caps of save_stakeholder: former colleagues take no place', () => {
  const saving = (configure: (c: BifConfig) => void) => {
    const t = setup(configure);
    const art = t.artifacts.save({ workspaceId: 'ws_a', kind: 'text', mime: 'text/plain', bytes: 'Org chart' }).id;
    const save = (label: string, subject: string) =>
      t.handle(
        { agentRunId: newId('arun'), workspaceId: 'ws_a', role: 'worker', model: { provider: 'claude', model: 'sonnet' }, promptVersion: 'pv', taskId: fixtureStakeholderTask(t.store, 'ws_a', subject).id },
        'save_stakeholder',
        {
          label, stakeholder_type: 'leader', subject, relation: `needs ${label}`,
          profile: Object.fromEntries(STAKEHOLDER_FIELDS.map((f) => [f, { value: `${f} of ${label}`, confidence: 0.5, evidence: [art] }])),
        },
      );
    return { ...t, save };
  };

  it('maxOwn counts the own stakeholder, not the parked one nor the one at a competitor', async () => {
    // One own stakeholder (Head of finance) is saved: with maxOwn 2 exactly one more fits.
    const t = saving((c) => (c.stakeholders = { maxOwn: 2 }));
    expect((await t.save('Head of product', 'own')).ok).toBe(true);
    const full = await t.save('Head of people', 'own');
    expect(full).toMatchObject({ ok: false, error: expect.stringContaining('at most 2 own stakeholders (stakeholders.maxOwn) and 2 are saved') });
  });

  it('maxPerCompetitor counts the competitor\'s stakeholder, not the former colleague who went there', async () => {
    // Rival Pay has its CEO and the former colleague: with maxPerCompetitor 2 exactly one more fits.
    const t = saving((c) => (c.stakeholders = { maxPerCompetitor: 2 }));
    expect((await t.save('CFO', 'cmp_rival')).ok).toBe(true);
    const full = await t.save('CTO', 'cmp_rival');
    expect(full).toMatchObject({ ok: false, error: expect.stringContaining('at most 2 stakeholders per competitor (stakeholders.maxPerCompetitor) and 2 are saved') });
  });

  it('the competitor research prompt does not offer a former colleague as a stakeholder to update', () => {
    const t = setup();
    const section = stakeholderTaskSection(t.store, t.config, { type: 'competitor_stakeholders', workspaceId: 'ws_a' });
    expect(section).toContain('stk-rival-pay-ceo');
    expect(section).not.toContain('stk-rival-pay-head-of-sales');
    const own = stakeholderTaskSection(t.store, t.config, { type: 'own_stakeholders', workspaceId: 'ws_a' });
    expect(own).toContain('stk-head-of-finance');
    expect(own).not.toContain('stk-head-of-legal');
    expect(own).not.toContain('stk-rival-pay-head-of-sales');
  });
});

// ---------------------------------------------------------------------------------------------------
describe('interview: only own stakeholders are listed', () => {
  it('lists the own stakeholder; not the former colleague at a competitor, the parked one or the competitor\'s stakeholder', () => {
    const t = setup();
    const prompt = buildInterviewPrompt(t.store.workspaces.get('ws_a')!, t.store);
    expect(prompt).toContain(`- ${t.own.id} — Head of finance (leader)`);
    for (const p of [t.gone, t.parked, t.rival]) expect(prompt, p.slug).not.toContain(p.id);
    expect(prompt).not.toMatch(/Head of sales|Head of legal/);
    expect(prompt.match(/^- per_/gm)).toHaveLength(1);
  });

  it('a node whose stakeholders have all left lists none', () => {
    const t = setup();
    markLeft(t.pos, ACTOR, 'ws_a', t.own.id, { date: LEFT, to: { elsewhere: {} } });
    expect(buildInterviewPrompt(t.store.workspaces.get('ws_a')!, t.store)).not.toContain('## Stakeholders of this node');
  });

  it('someone who returned is listed again', () => {
    const t = setup();
    markReturned(t.pos, ACTOR, 'ws_a', t.gone.id, { date: '2026-11-10', toWorkspaceId: 'ws_a' });
    expect(buildInterviewPrompt(t.store.workspaces.get('ws_a')!, t.store)).toContain(`- ${t.gone.id} — Head of sales (leader)`);
  });
});

// ---------------------------------------------------------------------------------------------------
describe('followed on the web: former colleagues only', () => {
  it('the former colleague at a competitor and the parked one are the node\'s former colleagues; the own and the competitor\'s stakeholder are not', () => {
    const t = setup();
    expect(formerColleagues(t.store, 'ws_a').map((p) => p.id)).toEqual([t.parked.id, t.gone.id]);
  });
});

// ---------------------------------------------------------------------------------------------------
describe('agent.md of a former colleague', () => {
  const base: Persona = {
    id: 'per_x', workspaceId: 'ws_a', slug: 'stk-rival-pay-head-of-sales', segment: 'Head of sales', version: 4, agentMdPath: '/x', kind: 'stakeholder',
    stakeholderType: 'leader', subjectKind: 'competitor', subjectId: 'cmp_rival', relation: 'VP Sales', disclosure: 'open', leftAt: LEFT,
    leftFrom: { workspaceId: 'ws_a', scopeName: 'Acme Payments', stakeholderType: 'manager', title: 'Head of Sales EMEA', relation: 'approves discounts.' },
    profile: {
      ...Object.fromEntries(STAKEHOLDER_FIELDS.map((f) => [f, { value: `${f} value`, confidence: 0.7, evidence: ['art_1'], basis: 'internal' as const }])),
      goals_incentives: { value: 'Grow the rival', confidence: 0.5, evidence: ['art_2'], basis: 'public' },
      decision_criteria: { value: 'Payback and reach', confidence: 0.6, evidence: ['art_1', 'art_2'], basis: 'both', conflict: 'Inside she asked for payback;\nher talks stress reach.' },
      constraints: { value: 'Probably a small budget', confidence: 0.3, evidence: ['art_1', 'art_2'], basis: 'inferred' },
      influence: { value: 'High', confidence: 0.4, evidence: ['art_1'] },
    },
  };
  const section = (md: string, field: keyof typeof STAKEHOLDER_AGENT_MD_HEADINGS) => {
    const at = md.indexOf(`\n## ${STAKEHOLDER_AGENT_MD_HEADINGS[field]}\n`);
    return md.slice(at, md.indexOf('\n## ', at + 4));
  };

  it('at a competitor: frontmatter, the paragraph after the opening one, and what each section rests on', () => {
    const md = compileStakeholderMd(base, { scopeName: 'Acme Payments', competitorName: 'Rival Pay' });
    const fm = /^---\n([\s\S]*?)\n---\n/.exec(md)![1]!.split('\n');
    expect(fm).toContain('former_colleague: true');
    expect(fm).toContain('subject: competitor');
    const opening = md.indexOf('You are Head of sales at Rival Pay, a rival of Acme Payments: VP Sales.');
    const left = md.indexOf(
      `Until ${LEFT} you worked at Acme Payments as Head of Sales EMEA, one of its stakeholders (manager): approves discounts. You know its plans, its people and ` +
        `its way of deciding as they were up to ${LEFT}, and nothing that changed there later.`,
    );
    const simulated = md.indexOf('You are a simulated stakeholder built from researched evidence.');
    expect(opening).toBeGreaterThan(-1);
    expect(left).toBeGreaterThan(opening);
    expect(simulated).toBeGreaterThan(left);
    expect(md).toContain(
      'Each section below says what it rests on: internal knowledge from your time there, public sources since you left, both, or a conclusion from both.',
    );
    expect(section(md, 'role_mandate')).toContain(`_Rests on: internal knowledge (as of ${LEFT})_`);
    expect(section(md, 'goals_incentives')).toContain('_Rests on: public sources_');
    expect(section(md, 'decision_criteria')).toContain('_Rests on: both_');
    expect(section(md, 'decision_criteria')).toContain('_Conflict: Inside she asked for payback; her talks stress reach._');
    expect(section(md, 'constraints')).toContain('_Rests on: a conclusion from both_');
    // A field without a basis says nothing about it; no other section carries a conflict.
    expect(section(md, 'influence')).not.toContain('Rests on');
    expect(md.match(/_Conflict: /g)).toHaveLength(1);
    expect(md.match(/_Rests on: /g)).toHaveLength(STAKEHOLDER_FIELDS.length - 1);
    // The confidence line stays, and the rival instructions.
    expect(section(md, 'role_mandate')).toContain('_Confidence: 0.7 · Evidence: art_1_');
    expect(md.slice(md.indexOf('## Instructions'))).toContain('how Rival Pay would respond');
  });

  it('at a competitor, without a title or a relation in the position held', () => {
    const md = compileStakeholderMd({ ...base, leftFrom: { workspaceId: 'ws_a', scopeName: 'Acme Payments', stakeholderType: 'leader' } }, { competitorName: 'Rival Pay' });
    expect(md).toContain(`Until ${LEFT} you worked at Acme Payments, one of its stakeholders (leader). You know its plans`);
  });

  it('parked: compiled as an own stakeholder, with a first line saying they left on that date', () => {
    const parked: Persona = { ...base, slug: 'stk-head-of-legal', segment: 'Head of legal', subjectKind: 'former', subjectId: undefined, relation: '' };
    const md = compileStakeholderMd(parked, { scopeName: 'Acme Payments' });
    const body = md.slice(md.indexOf('# Head of legal'));
    expect(body.split('\n').filter(Boolean)[1]).toBe(`You left Acme Payments on ${LEFT}: what follows is who you were there until then.`);
    expect(body).toContain('You are Head of legal, a stakeholder of Acme Payments. You judge proposals as someone who must approve, fund or supply them.');
    expect(md).toContain('subject: own');
    expect(md).not.toContain('former_colleague');
    expect(md).not.toContain('Rests on');
    expect(md).not.toContain('_Conflict');
    expect(md.slice(md.indexOf('## Instructions'))).toContain('approve_with_conditions');
  });

  it('parked: the opening line leaves the relation out (it holds the title at the new company, not what the node needs from them)', () => {
    const parked: Persona = { ...base, slug: 'stk-head-of-legal', segment: 'Head of legal', subjectKind: 'former', subjectId: undefined, relation: 'Partner at a law firm' };
    const md = compileStakeholderMd(parked, { scopeName: 'Acme Payments' });
    expect(md).toContain('You are Head of legal, a stakeholder of Acme Payments. You judge proposals as someone who must approve, fund or supply them.');
    expect(md).not.toContain('Partner at a law firm');
  });

  it('own, and a competitor\'s stakeholder that never worked here: unchanged, whatever basis marks the profile keeps', () => {
    const plain = (p: Persona): Persona => ({ ...p, profile: Object.fromEntries(Object.entries(p.profile).map(([k, v]) => [k, { value: v.value, confidence: v.confidence, evidence: v.evidence }])) });
    const own: Persona = { ...base, slug: 'stk-head-of-sales', subjectKind: 'own', subjectId: undefined, leftAt: undefined, leftFrom: undefined };
    const rival: Persona = { ...base, leftAt: undefined, leftFrom: undefined };
    for (const p of [own, rival]) {
      const md = compileStakeholderMd(p, { scopeName: 'Acme Payments', competitorName: 'Rival Pay' });
      expect(md).toBe(compileStakeholderMd(plain(p), { scopeName: 'Acme Payments', competitorName: 'Rival Pay' }));
      expect(md).not.toMatch(/former_colleague|Rests on|_Conflict|You left|Until /);
    }
  });

  it('written to disk by the actions: the file of the one who left for a competitor and of the parked one', () => {
    const t = setup();
    const gone = readFileSync(t.gone.agentMdPath, 'utf8');
    expect(gone).toContain('You are Head of sales at Rival Pay, a rival of Acme Payments: VP Sales.');
    expect(gone).toContain(`Until ${LEFT} you worked at Acme Payments, one of its stakeholders (leader): relation of Head of sales.`);
    expect(gone.match(/_Rests on: internal knowledge \(as of 2026-10-31\)_/g)).toHaveLength(STAKEHOLDER_FIELDS.length);
    const parked = readFileSync(t.parked.agentMdPath, 'utf8');
    expect(parked).toContain(`You left Acme Payments on ${LEFT}`);
    expect(parked).not.toContain('A law firm');
  });
});
