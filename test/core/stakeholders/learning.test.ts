/**
 * Stakeholder personas, task 5 (design 2026-11-15-stakeholder-personas-design.md §7, §9, §11): the
 * retro, and only the retro, improves stakeholder personas from the user's statements, their reactions
 * to simulated reads and the real decisions they recorded. Statements make a stakeholder eligible on
 * their own, are shown fenced with ids, may be cited alone, are consumed by a finished run, and make
 * its proposals and adjustments internal (left out of the export by default).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BifConfig } from '../../../src/core/config/schema.js';
import { listFeedback } from '../../../src/core/feedback/events.js';
import type { FakeScript } from '../../../src/core/harness/adapter.js';
import { FENCE_CLOSE, FENCE_OPEN } from '../../../src/core/knowledge/trust.js';
import { writeAgentMd } from '../../../src/core/market/personas.js';
import { acceptPersonaProposal } from '../../../src/core/personas/adjustments.js';
import { personaLearningToolHandlers, runPersonaLearning } from '../../../src/core/personas/learn.js';
import { personaLearningRepos } from '../../../src/core/personas/store.js';
import type { AgentRequest } from '../../../src/core/research/deps.js';
import { PERSONA_FIELDS, STAKEHOLDER_FIELDS } from '../../../src/core/scoring/criteria.js';
import { EXCLUSION_CAUSES, exportTrainingDataWithSummary } from '../../../src/core/scoring/export.js';
import { uploadInternal } from '../../../src/core/internal/uploads.js';
import { reactToRead } from '../../../src/core/stakeholders/reads.js';
import { addNote, openStatements } from '../../../src/core/stakeholders/statements.js';
import { stakeholderRepos } from '../../../src/core/stakeholders/store.js';
import type { StakeholderRead } from '../../../src/core/stakeholders/types.js';
import type { Store } from '../../../src/core/store/db.js';
import { newId } from '../../../src/core/store/repos.js';
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

const tick = (): string => {
  minute++;
  const at = new Date(Date.parse(T0) + minute * 60_000);
  vi.setSystemTime(at);
  return at.toISOString();
};
const later = () => new Date(Date.parse(T0) + (minute + 1) * 60_000);

const isLearning = (req: AgentRequest) => req.role === 'retro' && req.prompt.startsWith('# Persona learning');
const personaOf = (prompt: string) => /persona_id `(\w+)`/.exec(prompt)![1]!;
const statementIdsIn = (prompt: string) => [...prompt.matchAll(/^- (sst_\w+) \(/gm)].map((m) => m[1]!);
const reactionIdsIn = (prompt: string) => [...prompt.matchAll(/^- (\S+) (agree|disagree)\b/gm)].map((m) => m[1]!);
const submit = (personaId: string, proposals: unknown[]) => ({ persona_id: personaId, assumption: 'Underrates how much the CFO cares about payback.', proposals });
const add = (evidence: string[], field = 'decision_criteria', text = 'You approve only what pays back within a year.') => ({
  action: 'add', field, text, why: 'The user said so.', evidence,
});

function setup(configure?: (c: BifConfig) => void) {
  const t = researchSetup(opened, { extraHandlers: () => personaLearningToolHandlers(), ...(configure ? { config: configure } : {}) });
  t.store.workspaces.insert({ id: 'ws_a', name: 'Acme', sector: 'saas', createdAt: T0 });
  const stakeholder = (slug: string, extra: Partial<Persona> = {}): Persona => {
    const profile = Object.fromEntries(STAKEHOLDER_FIELDS.map((f) => [f, { value: `${f} of ${slug}`, confidence: 0.6, evidence: [] }]));
    const p = t.store.personas.insert({
      id: `per_${slug.replace(/-/g, '_')}`, workspaceId: 'ws_a', slug, segment: `Label of ${slug}`, profile, version: 1, status: 'verified',
      agentMdPath: join(t.dir, 'personas', `${slug}.md`), kind: 'stakeholder', stakeholderType: 'leader', subjectKind: 'own',
      relation: 'Approves the budget of the payments team', disclosure: 'open', ...extra,
    });
    writeAgentMd(t.store, p);
    return p;
  };
  const segment = (slug: string): Persona => {
    const profile = Object.fromEntries(PERSONA_FIELDS.map((f) => [f, { value: `${f} of ${slug}`, confidence: 0.7, evidence: [] }]));
    const p = t.store.personas.insert({
      id: `per_${slug}`, workspaceId: 'ws_a', slug, segment: `${slug} segment`, profile, version: 1, status: 'verified',
      agentMdPath: join(t.dir, 'personas', `${slug}.md`),
    });
    writeAgentMd(t.store, p);
    return p;
  };
  const note = (p: Persona, text = 'She only signs off on things that pay back within a year.') => {
    tick();
    return addNote(t.store, ACTOR, 'ws_a', { personaId: p.id, text });
  };
  /** A read of a new recommendation by `p` with `stance`. */
  const read = (p: Persona, stance: string, recId = newId('rec')): StakeholderRead => {
    tick();
    t.store.recommendations.insert({ id: recId, workspaceId: 'ws_a', title: `Do ${recId}`, summary: 's', criteria: {}, findingIds: [], priority: 3, personaFeedback: [], createdAt: T0 });
    return stakeholderRepos(t.store).reads.insert({
      id: newId('srd'), rootWorkspaceId: 'ws_a', workspaceId: 'ws_a', recommendationId: recId, personaId: p.id, personaVersion: p.version, stance,
      conditions: [], concerns: [], reasoning: 'r', wouldChangeMind: 'w', agentRunId: 'arun_read', simulated: true, createdAt: new Date().toISOString(),
    });
  };
  /** `n` disagreeing reactions, each to a read of a different recommendation. */
  const disagreeWithReads = (p: Persona, n: number) => {
    for (let i = 0; i < n; i++) {
      const r = read(p, 'approve');
      tick();
      reactToRead(t.store, ACTOR, 'ws_a', r.id, 'disagree', 'she would never approve this');
    }
  };
  const answer = (fn: (req: AgentRequest) => FakeScript) => {
    t.state.pick = (req) => (isLearning(req) ? fn(req) : undefined);
  };
  const repos = personaLearningRepos(t.store);
  const run = () => runPersonaLearning(t.deps, 'ws_a', { now: later() });
  return { ...t, stakeholder, segment, note, read, disagreeWithReads, answer, repos, run };
}

describe('persona learning of stakeholder personas', () => {
  it('one open statement and no reactions get a run; a proposal citing it is pending and internal; accepting it puts an internal adjustment in agent.md', async () => {
    const t = setup();
    const cfo = t.stakeholder('stk-cfo');
    const st = t.note(cfo);
    t.answer((req) => async (tc) => {
      await tc.call('submit_persona_learning', submit(personaOf(req.prompt), [add(statementIdsIn(req.prompt))]));
    });

    expect(await t.run()).toEqual({ personasEvaluated: 1, personasQualified: 1, personaLearningRuns: 1, personaProposals: 1 });
    const prompt = t.requests[0]!.prompt;
    // The stakeholder's own profile: label, type, relation and stakeholder fields, not the segment fields.
    expect(prompt).toContain('## Stakeholder');
    expect(prompt).toContain('- label: Label of stk-cfo');
    expect(prompt).toContain('- type: leader');
    expect(prompt).toContain('- relation: Approves the budget of the payments team');
    expect(prompt).toContain('- decision_criteria: decision_criteria of stk-cfo');
    expect(prompt).not.toMatch(/- (segment|audience|demographics):/);
    // The statement under its own heading, inside the fence, as `<id> (<source>) — <text>`.
    const fenced = prompt.slice(prompt.indexOf(FENCE_OPEN), prompt.lastIndexOf(FENCE_CLOSE));
    expect(fenced).toContain('## Statements');
    expect(fenced).toContain(`- ${st.id} (note) — She only signs off on things that pay back within a year.`);

    const [run] = t.repos.runs.list({ personaId: cfo.id });
    expect(run).toMatchObject({ status: 'proposed', shownStatementIds: [st.id], shownSignalIds: [] });
    const [proposal] = t.repos.proposals.list({ personaId: cfo.id });
    expect(proposal).toMatchObject({ status: 'pending', internal: true, evidence: [st.id], field: 'decision_criteria' });
    // The run consumed the statement.
    expect(stakeholderRepos(t.store).statements.get(st.id)!.consumedByRunId).toBe(run!.id);
    expect(openStatements(t.store, cfo.id)).toEqual([]);

    const { adjustment, persona } = acceptPersonaProposal(t.store, ACTOR, 'ws_a', proposal!.id);
    expect(adjustment).toMatchObject({ status: 'active', internal: true, field: 'decision_criteria' });
    expect(readFileSync(persona.agentMdPath, 'utf8')).toContain('You approve only what pays back within a year.');
  });

  it('statements are consumed after no_change, not after a failed run', async () => {
    const t = setup();
    const cfo = t.stakeholder('stk-cfo');
    const st = t.note(cfo);
    t.answer(() => async () => undefined); // ends without the tool
    await t.run();
    expect(t.repos.runs.list({ personaId: cfo.id })[0]).toMatchObject({ status: 'failed' });
    expect(openStatements(t.store, cfo.id).map((s) => s.id)).toEqual([st.id]);

    t.answer((req) => async (tc) => void (await tc.call('submit_persona_learning', submit(personaOf(req.prompt), []))));
    await t.run();
    const done = t.repos.runs.list({ personaId: cfo.id }).find((r) => r.status === 'no_change')!;
    expect(done.shownStatementIds).toEqual([st.id]);
    expect(openStatements(t.store, cfo.id)).toEqual([]);
    expect(stakeholderRepos(t.store).statements.get(st.id)!.consumedByRunId).toBe(done.id);
    // Nothing left: no third run.
    t.requests.length = 0;
    expect(await t.run()).toMatchObject({ personasQualified: 0, personaLearningRuns: 0 });
  });

  it('a hidden stakeholder with statements is skipped and its statements stay open', async () => {
    const t = setup();
    const cfo = t.stakeholder('stk-cfo', { disclosure: 'hidden' });
    t.note(cfo);
    expect(await t.run()).toEqual({ personasEvaluated: 0, personasQualified: 0, personaLearningRuns: 0, personaProposals: 0 });
    expect(t.requests).toEqual([]);
    expect(openStatements(t.store, cfo.id)).toHaveLength(1);
  });

  it('a segment persona is unaffected by statements and still needs the gate', async () => {
    const t = setup();
    const smb = t.segment('smb');
    tick();
    stakeholderRepos(t.store).statements.insert({
      id: newId('sst'), rootWorkspaceId: 'ws_a', workspaceId: 'ws_a', personaId: smb.id, source: 'note', text: 'A statement about a segment', actor: ACTOR,
      createdAt: new Date().toISOString(),
    });
    expect(await t.run()).toEqual({ personasEvaluated: 1, personasQualified: 0, personaLearningRuns: 0, personaProposals: 0 });
    expect(t.requests).toEqual([]);
  });

  it('stakeholders with statements go first, then by disagreements', async () => {
    const t = setup((c) => (c.personaLearning = { maxPersonasPerRetro: 1 }));
    const loud = t.stakeholder('stk-loud');
    t.disagreeWithReads(loud, 8);
    const quiet = t.stakeholder('stk-quiet');
    t.note(quiet);
    t.answer((req) => async (tc) => void (await tc.call('submit_persona_learning', submit(personaOf(req.prompt), []))));
    expect(await t.run()).toMatchObject({ personasEvaluated: 2, personasQualified: 2, personaLearningRuns: 1 });
    expect(personaOf(t.requests[0]!.prompt)).toBe(quiet.id);
  });

  it('read reactions qualify a stakeholder through the gate; a proposal citing only reactions keeps the evidence rules', async () => {
    const t = setup();
    const cfo = t.stakeholder('stk-cfo');
    t.disagreeWithReads(cfo, 6);
    const errors: string[] = [];
    t.answer((req) => async (tc) => {
      const ids = reactionIdsIn(req.prompt);
      expect(statementIdsIn(req.prompt)).toEqual([]);
      try {
        await tc.call('submit_persona_learning', submit(cfo.id, [add(ids.slice(0, 1))]));
      } catch (e) {
        errors.push((e as Error).message);
      }
      await tc.call('submit_persona_learning', submit(cfo.id, [add(ids.slice(0, 3))]));
    });
    expect(await t.run()).toMatchObject({ personasQualified: 1, personaLearningRuns: 1, personaProposals: 1 });
    expect(errors[0]).toMatch(/cites 1 signal\(s\); an add or replace needs at least 3/);
    // Shown no statement: not internal.
    expect(t.repos.proposals.list({ personaId: cfo.id })[0]).toMatchObject({ internal: false });
  });

  it('a segment field on a stakeholder proposal is refused, and a stakeholder field on a segment proposal', async () => {
    const t = setup();
    const cfo = t.stakeholder('stk-cfo');
    t.note(cfo);
    const smb = t.segment('smb');
    for (let i = 0; i < 6; i++) {
      tick();
      t.store.ratings.insert({
        id: newId('rat'), workspaceId: 'ws_a', targetType: 'persona', targetId: smb.id, criterion: PERSONA_FIELDS[i]!, agentValue: 0.7, verdict: 'disagree',
        userValue: 0.2, createdAt: new Date().toISOString(),
      });
    }
    const errors: Record<string, string> = {};
    t.answer((req) => async (tc) => {
      const id = personaOf(req.prompt);
      const evidence = id === cfo.id ? statementIdsIn(req.prompt) : reactionIdsIn(req.prompt).slice(0, 3);
      try {
        await tc.call('submit_persona_learning', submit(id, [add(evidence, id === cfo.id ? 'buying_behavior' : 'decision_criteria')]));
      } catch (e) {
        errors[id] = (e as Error).message;
      }
      await tc.call('submit_persona_learning', submit(id, []));
    });
    await t.run();
    expect(errors[cfo.id]).toMatch(/field: 'buying_behavior' is not a field of this stakeholder/);
    expect(errors[smb.id]).toMatch(/field: 'decision_criteria' is not a field of this persona/);
    expect(t.repos.proposals.list()).toEqual([]);
  });

  it('engine step: an adjustment of a stakeholder whose read disagreement did not drop gets an internal retire proposal', async () => {
    const t = setup();
    const cfo = t.stakeholder('stk-cfo');
    t.note(cfo);
    t.answer((req) => async (tc) => void (await tc.call('submit_persona_learning', submit(personaOf(req.prompt), [add(statementIdsIn(req.prompt))]))));
    await t.run();
    const [proposal] = t.repos.proposals.list({ personaId: cfo.id });
    // Recorded numbers as if proposed on 4 of 6 disagreements.
    t.repos.proposals.update(proposal!.id, { stats: { n: 6, agree: 2, disagree: 4, items: 6, lower: 0.3 } });
    tick();
    const { adjustment, persona } = acceptPersonaProposal(t.store, ACTOR, 'ws_a', proposal!.id);
    t.disagreeWithReads(persona, 6); // reads by the adjusted version, all disagreed with
    t.answer((req) => async (tc) => void (await tc.call('submit_persona_learning', submit(personaOf(req.prompt), []))));
    await t.run();
    const retire = t.repos.proposals.list({ adjustmentId: adjustment.id, action: 'retire' });
    expect(retire).toEqual([expect.objectContaining({ source: 'engine', status: 'pending', internal: true })]);
  });
});

describe('training export of stakeholder learning', () => {
  it('leaves out internal adjustments, their proposals and Decisions, statements, questions and reads by default; includes them with the switch', async () => {
    const t = setup();
    const cfo = t.stakeholder('stk-cfo');
    const st = t.note(cfo);
    const r = t.read(cfo, 'approve');
    tick();
    reactToRead(t.store, ACTOR, 'ws_a', r.id, 'agree');
    stakeholderRepos(t.store).questions.insert({
      id: newId('stq'), rootWorkspaceId: 'ws_a', workspaceId: 'ws_a', personaId: cfo.id, field: 'objections', text: 'What makes them hesitate?', status: 'open', createdAt: T0,
    });
    t.answer((req) => async (tc) => void (await tc.call('submit_persona_learning', submit(personaOf(req.prompt), [add(statementIdsIn(req.prompt))]))));
    await t.run();
    const [proposal] = t.repos.proposals.list({ personaId: cfo.id });
    tick();
    const { adjustment } = acceptPersonaProposal(t.store, ACTOR, 'ws_a', proposal!.id);
    expect(listFeedback(t.store, { kind: 'persona_learning_accept' })).toHaveLength(1);

    type Line = { type: string; decision?: { payload: { tool?: string } }; feedbackEvent?: { kind: string }; statement?: { id: string }; question?: unknown; read?: { id: string } };
    const parse = (jsonl: string) => jsonl.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as Line);
    const tools = (ls: Line[]) => ls.filter((l) => l.type === 'decision').map((l) => l.decision!.payload.tool);
    const kinds = (ls: Line[]) => ls.filter((l) => l.type === 'feedback_event').map((l) => l.feedbackEvent!.kind);

    const byDefault = exportTrainingDataWithSummary('ws_a', t);
    const out = parse(byDefault.jsonl);
    expect(tools(out)).not.toContain('persona_learning');
    expect(tools(out)).not.toContain('submit_persona_learning');
    expect(kinds(out)).not.toContain('persona_learning_accept');
    expect(kinds(out)).not.toContain('stakeholder_note');
    expect(kinds(out)).not.toContain('stakeholder_read_reaction');
    expect(out.map((l) => l.type)).not.toEqual(expect.arrayContaining(['stakeholder_statement']));
    expect(byDefault.jsonl).not.toContain(st.text);
    expect(byDefault.jsonl).not.toContain(adjustment.text);
    const internal = (c: { byCause: Array<{ cause: string; count: number }> }) => c.byCause.find((x) => x.cause === 'internal')!.count;
    expect(internal(byDefault.summary.excludedJudgments)).toBe(2); // the run's Decision and the accept
    expect(internal(byDefault.summary.excludedOtherLines)).toBeGreaterThanOrEqual(6); // events, the statement, the question, the read

    const all = parse(exportTrainingDataWithSummary('ws_a', t, true).jsonl);
    expect(tools(all)).toEqual(expect.arrayContaining(['persona_learning', 'submit_persona_learning']));
    expect(kinds(all)).toEqual(expect.arrayContaining(['persona_learning_accept', 'stakeholder_note', 'stakeholder_read_reaction']));
    expect(all.filter((l) => l.type === 'stakeholder_statement').map((l) => l.statement!.id)).toEqual([st.id]);
    expect(all.filter((l) => l.type === 'stakeholder_question')).toHaveLength(1);
    expect(all.filter((l) => l.type === 'stakeholder_read').map((l) => l.read!.id)).toEqual([r.id]);
  });

  it('an internal record that also rests on an upload is counted under the upload cause, as EXCLUSION_CAUSES orders them', () => {
    const t = setup();
    const cfo = t.stakeholder('stk-cfo');
    const upload = uploadInternal('ws_a', { name: 'board.txt', bytes: new TextEncoder().encode('Board memo.'), mime: 'text/plain' }, t);
    // A note_stakeholder Decision (internal) that cites the upload, and one that does not.
    t.store.decisions.insert({
      id: newId('dec'), workspaceId: 'ws_a', agentRunId: 'arun_x', role: 'interviewer', model: { provider: 'claude', model: 'fake' }, kind: 'decision',
      payload: { tool: 'note_stakeholder', personaId: cfo.id }, refs: [upload.id], promptVersion: 'v', createdAt: T0,
    });
    t.store.decisions.insert({
      id: newId('dec'), workspaceId: 'ws_a', agentRunId: 'arun_x', role: 'interviewer', model: { provider: 'claude', model: 'fake' }, kind: 'decision',
      payload: { tool: 'note_stakeholder', personaId: cfo.id }, refs: [], promptVersion: 'v', createdAt: T0,
    });
    // A stakeholder feedback event (internal) whose reason cites the upload, and one that does not.
    tick();
    reactToRead(t.store, ACTOR, 'ws_a', t.read(cfo, 'approve').id, 'disagree', `See ${upload.id} for what she approved last year.`);
    tick();
    reactToRead(t.store, ACTOR, 'ws_a', t.read(cfo, 'approve').id, 'agree');

    const { summary } = exportTrainingDataWithSummary('ws_a', t);
    const count = (c: { byCause: Array<{ cause: string; count: number }> }, cause: string) => c.byCause.find((x) => x.cause === cause)!.count;
    expect(count(summary.excludedJudgments, 'cites_upload')).toBe(1);
    expect(count(summary.excludedJudgments, 'internal')).toBe(1);
    expect(EXCLUSION_CAUSES.map((c) => c.cause).at(-1)).toBe('internal');
    // Feedback events: the reaction citing the upload counts under the upload cause, the other as internal.
    expect(listFeedback(t.store, { kind: 'stakeholder_read_reaction' })).toHaveLength(2);
    expect(count(summary.excludedOtherLines, 'cites_upload')).toBe(1);
  });

  it('a non-internal learning proposal of a segment persona is still exported by default', async () => {
    const t = setup();
    const smb = t.segment('smb');
    personaLearningRepos(t.store).proposals.insert({
      id: newId('ppr'), rootWorkspaceId: 'ws_a', workspaceId: 'ws_a', personaId: smb.id, action: 'add', field: 'goals', text: 'You want less paperwork.',
      rationale: 'r', evidence: [], stats: {}, source: 'retro', status: 'pending', createdAt: T0,
    });
    const [p] = personaLearningRepos(t.store).proposals.list({ personaId: smb.id });
    acceptPersonaProposal(t.store, ACTOR, 'ws_a', p!.id);
    const jsonl = exportTrainingDataWithSummary('ws_a', t).jsonl;
    expect(jsonl).toContain('persona_learning_accept');
  });
});
