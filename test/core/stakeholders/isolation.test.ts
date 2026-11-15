/**
 * Stakeholder personas across business trees (design 2026-11-15-stakeholder-personas-design.md §16):
 * two trees, each with an own stakeholder of the same label (so the same slug), its question round,
 * an answer, a note, a simulated read of a recommendation, a reaction, a recorded decision and a
 * learning run with a proposal. Every text of a tree carries that tree's marker. The stakeholders,
 * questions, statements, reads and learning of one tree never appear in the other's functions or
 * routes, and every id of the other tree answers 404 there (exactly like an unknown id).
 */
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../../src/api/routes.js';
import { writeAgentMd } from '../../../src/core/market/personas.js';
import { personaLearningToolHandlers, runPersonaLearning } from '../../../src/core/personas/learn.js';
import { collectPersonaSignals } from '../../../src/core/personas/signals.js';
import { personaLearningRepos } from '../../../src/core/personas/store.js';
import type { AgentRequest } from '../../../src/core/research/deps.js';
import { STAKEHOLDER_FIELDS } from '../../../src/core/scoring/criteria.js';
import { stakeholderPersonas, unassignedStatementLines } from '../../../src/core/stakeholders/personas.js';
import { answerQuestions, ensureQuestions, openQuestions, revealStakeholder } from '../../../src/core/stakeholders/questions.js';
import { reactToRead, readsOf, runStakeholderReads, submitStakeholderReadHandler } from '../../../src/core/stakeholders/reads.js';
import { addNote, openStatements, recordDecision, StakeholderError } from '../../../src/core/stakeholders/statements.js';
import { stakeholderRepos } from '../../../src/core/stakeholders/store.js';
import type { Store } from '../../../src/core/store/db.js';
import type { Persona } from '../../../src/core/types.js';
import { researchSetup } from '../helpers/research.js';

const T0 = '2026-11-15T10:00:00.000Z';
const ACTOR = 'tester';
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

const tick = () => {
  minute++;
  vi.setSystemTime(new Date(Date.parse(T0) + minute * 60_000));
};
const later = () => new Date(Date.parse(T0) + (minute + 1) * 60_000);
const isLearning = (req: AgentRequest) => req.role === 'retro' && req.prompt.startsWith('# Persona learning');
const personaOf = (prompt: string) => /persona_id `(\w+)`/.exec(prompt)![1]!;
const recOf = (req: AgentRequest) => /^Recommendation id: (\S+)$/m.exec(req.prompt)?.[1] ?? '';

const TREES = { a: { ws: 'ws_a', mark: 'MARK_TREE_A' }, b: { ws: 'ws_b', mark: 'MARK_TREE_B' } } as const;
type Tree = keyof typeof TREES;
const other = (x: Tree): Tree => (x === 'a' ? 'b' : 'a');

/** Everything one tree holds, for the assertions. */
type Seeded = { persona: Persona; hiddenId: string; questionIds: string[]; statementIds: string[]; readId: string; recId: string; proposalIds: string[]; runIds: string[] };

async function setup() {
  const t = researchSetup(opened, {
    extraHandlers: () => ({ ...personaLearningToolHandlers(), submit_stakeholder_read: submitStakeholderReadHandler }),
  });
  for (const { ws, mark } of Object.values(TREES)) {
    t.store.workspaces.insert({ id: ws, name: `Company ${mark}`, sector: 'saas', createdAt: T0 });
  }
  // A child node under tree A: tree-wide lookups from it reach tree A only.
  t.store.workspaces.insert({ id: 'ws_a_child', name: 'Payments MARK_TREE_A', sector: 'saas', createdAt: T0, parentWorkspaceId: 'ws_a' });

  // Persona runs read; learning runs propose one add citing the statements they were shown.
  t.state.pick = (req) => {
    if (req.role === 'persona') {
      return async (tc) => {
        await tc.call('submit_stakeholder_read', {
          recommendation_id: recOf(req), stance: 'approve', conditions: [], concerns: [], reasoning: 'reads it', would_change_mind: 'numbers',
        });
      };
    }
    if (isLearning(req)) {
      const id = personaOf(req.prompt);
      const cited = [...req.prompt.matchAll(/^- (sst_\w+) \(/gm)].map((m) => m[1]!);
      return async (tc) => {
        await tc.call('submit_persona_learning', {
          persona_id: id, assumption: 'Underrates payback.',
          proposals: [{ action: 'add', field: 'decision_criteria', text: 'You approve only what pays back within a year.', why: 'The user said so.', evidence: cited }],
        });
      };
    }
    return undefined;
  };

  const seed = async (x: Tree): Promise<Seeded> => {
    const { ws, mark } = TREES[x];
    const profile = Object.fromEntries(STAKEHOLDER_FIELDS.map((f) => [f, { value: `${f} ${mark}`, confidence: 0.6, evidence: [] }]));
    const p = t.store.personas.insert({
      id: `per_cfo_${x}`, workspaceId: ws, slug: 'stk-chief-financial-officer', segment: 'Chief financial officer', profile, version: 1, status: 'verified',
      agentMdPath: join(t.dir, 'personas', ws, 'stk-chief-financial-officer.md'), kind: 'stakeholder', stakeholderType: 'leader', subjectKind: 'own',
      relation: `approves budgets ${mark}`, disclosure: 'hidden',
    });
    writeAgentMd(t.store, p);
    const questions = ensureQuestions(t.store, ws);
    tick();
    const { statements } = answerQuestions(t.store, ACTOR, ws, { answers: [{ questionId: questions[0]!.id, text: `Payback first ${mark}` }] });
    tick();
    const note = addNote(t.store, ACTOR, ws, { personaId: p.id, text: `Signs on Fridays ${mark}` });
    const unassigned = addNote(t.store, ACTOR, ws, { text: `The auditor matters too ${mark}` });
    const rec = t.store.recommendations.insert({
      id: `rec_${x}`, workspaceId: ws, title: `Raise prices ${mark}`, summary: `summary ${mark}`, criteria: {}, findingIds: [], priority: 3,
      personaFeedback: [], createdAt: T0, status: 'verified',
    });
    tick();
    await runStakeholderReads(ws, t.deps);
    const read = readsOf(t.store, ws, rec.id)[0]!;
    tick();
    reactToRead(t.store, ACTOR, ws, read.id, 'disagree', `never ${mark}`);
    tick();
    const decision = recordDecision(t.store, ACTOR, ws, { recommendationId: rec.id, personaId: p.id, decision: 'rejected', reasoning: `Too slow ${mark}` });
    await runPersonaLearning(t.deps, ws, { now: later() });
    // A later stakeholder, still hidden, with its round open.
    const board = t.store.personas.insert({
      ...p, id: `per_board_${x}`, slug: 'stk-board', segment: 'Board', stakeholderType: 'board', disclosure: 'hidden', relation: `oversees ${mark}`,
      agentMdPath: join(t.dir, 'personas', ws, 'stk-board.md'),
    });
    const later2 = ensureQuestions(t.store, ws);
    const learning = personaLearningRepos(t.store);
    return {
      persona: t.store.personas.get(p.id)!,
      hiddenId: board.id,
      questionIds: [...questions, ...later2].map((q) => q.id),
      statementIds: [...statements.map((s) => s.id), note.id, unassigned.id, decision.id],
      readId: read.id,
      recId: rec.id,
      proposalIds: learning.proposals.list({ personaId: p.id }).map((q) => q.id),
      runIds: learning.runs.list({ personaId: p.id }).map((r) => r.id),
    };
  };
  const seeded = { a: await seed('a'), b: await seed('b') } as Record<Tree, Seeded>;

  const app = createApp({ store: t.store, artifacts: t.artifacts, events: t.events, config: t.config, research: t.deps });
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await app.request(path, { method, headers: { 'content-type': 'application/json' }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    return { status: res.status, text: await res.text() };
  };
  /** Every id and the marker of tree `x`. */
  const traces = (x: Tree): string[] => {
    const s = seeded[x];
    return [TREES[x].mark, s.persona.id, s.hiddenId, ...s.questionIds, ...s.statementIds, s.readId, s.recId, ...s.proposalIds, ...s.runIds];
  };
  return { ...t, seeded, call, traces };
}

const refused = (fn: () => unknown): number => {
  try {
    fn();
  } catch (e) {
    if (e instanceof StakeholderError) return e.status;
    throw e;
  }
  return 200;
};

describe('stakeholder personas stay inside their business tree', () => {
  it('both trees got the same shape of data: one stakeholder each, same slug, with questions, statements, a read and a learning proposal', async () => {
    const t = await setup();
    for (const x of ['a', 'b'] as const) {
      const s = t.seeded[x];
      expect(s.persona).toMatchObject({ slug: 'stk-chief-financial-officer', disclosure: 'open', workspaceId: TREES[x].ws });
      expect(s.questionIds).toHaveLength(12); // two rounds: the stakeholder answered, a later one still hidden
      expect(s.statementIds).toHaveLength(4);
      expect(s.proposalIds).toHaveLength(1);
      expect(s.runIds).toHaveLength(1);
    }
  });

  it('core functions of one tree return nothing of the other', async () => {
    const t = await setup();
    const repos = stakeholderRepos(t.store);
    const learning = personaLearningRepos(t.store);
    for (const x of ['a', 'b'] as const) {
      const { ws } = TREES[x];
      const mine = t.seeded[x];
      const theirs = t.seeded[other(x)];
      const foreign = t.traces(other(x));
      const leaks = (v: unknown) => foreign.filter((id) => JSON.stringify(v).includes(id));

      expect(stakeholderPersonas(t.store, ws).map((p) => p.id).sort()).toEqual([mine.persona.id, mine.hiddenId].sort());
      expect(leaks(openQuestions(t.store, ws))).toEqual([]);
      expect(leaks(repos.questions.list({ rootWorkspaceId: ws }))).toEqual([]);
      expect(leaks(repos.statements.list({ rootWorkspaceId: ws }))).toEqual([]);
      expect(leaks(repos.reads.list({ rootWorkspaceId: ws }))).toEqual([]);
      expect(leaks(openStatements(t.store, mine.persona.id))).toEqual([]);
      expect(leaks(unassignedStatementLines(t.store, ws))).toEqual([]);
      expect(readsOf(t.store, ws, mine.recId).map((r) => r.id)).toEqual([mine.readId]);
      expect(readsOf(t.store, ws, theirs.recId)).toEqual([]);
      expect(leaks(collectPersonaSignals(t.store, mine.persona.id))).toEqual([]);
      expect(leaks(learning.proposals.list({ rootWorkspaceId: ws }))).toEqual([]);
      expect(leaks(learning.runs.list({ rootWorkspaceId: ws }))).toEqual([]);
      // A new round on one tree asks about that tree only.
      expect(ensureQuestions(t.store, ws)).toEqual([]);

      // Every write naming the other tree's ids answers 404 and changes nothing.
      const before = JSON.stringify([repos.statements.list(), repos.questions.list(), t.store.personas.list({})]);
      expect(refused(() => answerQuestions(t.store, ACTOR, ws, { answers: [{ questionId: theirs.questionIds[1]!, text: 'x' }] }))).toBe(404);
      expect(refused(() => answerQuestions(t.store, ACTOR, ws, { answers: [], skip: [theirs.persona.id] }))).toBe(404);
      expect(refused(() => revealStakeholder(t.store, ACTOR, ws, theirs.persona.id))).toBe(404);
      expect(refused(() => revealStakeholder(t.store, ACTOR, ws, theirs.hiddenId))).toBe(404);
      expect(refused(() => addNote(t.store, ACTOR, ws, { personaId: theirs.persona.id, text: 'x' }))).toBe(404);
      expect(refused(() => recordDecision(t.store, ACTOR, ws, { recommendationId: theirs.recId, personaId: mine.persona.id, decision: 'approved', reasoning: 'x' }))).toBe(404);
      expect(refused(() => recordDecision(t.store, ACTOR, ws, { recommendationId: mine.recId, personaId: theirs.persona.id, decision: 'approved', reasoning: 'x' }))).toBe(404);
      expect(refused(() => reactToRead(t.store, ACTOR, ws, theirs.readId, 'agree'))).toBe(404);
      expect(JSON.stringify([repos.statements.list(), repos.questions.list(), t.store.personas.list({})])).toBe(before);
    }
    // The child node of tree A sees tree A's reads and refuses tree B's.
    expect(readsOf(t.store, 'ws_a_child', t.seeded.a.recId).map((r) => r.id)).toEqual([t.seeded.a.readId]);
    expect(refused(() => reactToRead(t.store, ACTOR, 'ws_a_child', t.seeded.b.readId, 'agree'))).toBe(404);
  });

  it('the prompts of one tree (reads, learning) carry nothing of the other', async () => {
    const t = await setup();
    const prompts = (mark: string) => t.requests.filter((r) => `${r.systemPrompt}\n${r.prompt}`.includes(mark));
    for (const x of ['a', 'b'] as const) {
      const foreign = t.traces(other(x));
      for (const r of prompts(TREES[x].mark)) {
        expect(foreign.filter((id) => `${r.systemPrompt}\n${r.prompt}`.includes(id))).toEqual([]);
      }
    }
    // Each tree had one read run and one learning run.
    expect(t.requests.filter((r) => r.role === 'persona')).toHaveLength(2);
    expect(t.requests.filter(isLearning)).toHaveLength(2);
  });

  it('routes of one tree serve nothing of the other; its ids answer 404 there', async () => {
    const t = await setup();
    for (const x of ['a', 'b'] as const) {
      const { ws } = TREES[x];
      const mine = t.seeded[x];
      const theirs = t.seeded[other(x)];
      const foreign = t.traces(other(x));
      const w = (path: string) => `/api/workspaces/${ws}${path}`;
      for (const path of [
        '/stakeholders', '/stakeholder-questions', `/stakeholders/${mine.persona.id}/statements`, `/recommendations/${mine.recId}/stakeholder-reads`,
        '/persona-learning', `/personas/${mine.persona.id}/signals`, '/export?includeUploads=1', '/feedback',
      ]) {
        const r = await t.call('GET', w(path));
        expect([path, r.status]).toEqual([path, 200]);
        expect([path, foreign.filter((id) => r.text.includes(id))]).toEqual([path, []]);
        // The tree's own data is there (the check above is not vacuous).
        expect([path, [mine.persona.id, mine.hiddenId, mine.readId].some((id) => r.text.includes(id))]).toEqual([path, true]);
      }
      for (const [method, path, body] of [
        ['GET', `/stakeholders/${theirs.persona.id}/statements`],
        ['GET', `/recommendations/${theirs.recId}/stakeholder-reads`],
        ['GET', `/personas/${theirs.persona.id}/signals`],
        ['POST', '/stakeholder-questions/answers', { answers: [{ questionId: theirs.questionIds[1], text: 'x' }] }],
        ['POST', `/stakeholders/${theirs.persona.id}/reveal`],
        ['POST', `/stakeholders/${theirs.hiddenId}/reveal`],
        ['POST', '/stakeholder-questions/answers', { answers: [], skip: [theirs.hiddenId] }],
        ['POST', `/stakeholders/${theirs.persona.id}/notes`, { text: 'x' }],
        ['POST', `/recommendations/${theirs.recId}/stakeholder-decisions`, { personaId: mine.persona.id, decision: 'approved', reasoning: 'x' }],
        ['POST', `/recommendations/${mine.recId}/stakeholder-decisions`, { personaId: theirs.persona.id, decision: 'approved', reasoning: 'x' }],
        ['POST', `/stakeholder-reads/${theirs.readId}/reaction`, { reaction: 'agree' }],
        ['POST', `/persona-proposals/${theirs.proposalIds[0]}/accept`, {}],
        ['POST', `/persona-proposals/${theirs.proposalIds[0]}/reject`, {}],
      ] as Array<[string, string, unknown?]>) {
        const r = await t.call(method, w(path), body);
        expect([method, path, r.status]).toEqual([method, path, 404]);
      }
    }
    // Nothing was accepted or rejected across trees.
    const learning = personaLearningRepos(t.store);
    expect(learning.proposals.list().map((p) => p.status)).toEqual(['pending', 'pending']);
    expect(learning.adjustments.list()).toEqual([]);
  });
});
