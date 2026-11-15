/**
 * Stakeholder personas, task 3 (design 2026-11-15-stakeholder-personas-design.md §7, §8, §16): the
 * template question round — question text, creation once per stakeholder, answers, skips, reveal,
 * one-way opening and tree isolation.
 */
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { listFeedback } from '../../../src/core/feedback/events.js';
import type { FakeScript } from '../../../src/core/harness/adapter.js';
import type { RunContext } from '../../../src/core/harness/tokens.js';
import { startPhase } from '../../../src/core/research/orchestrator.js';
import { researchToolHandlers } from '../../../src/core/research/tools.js';
import { STAKEHOLDER_FIELDS } from '../../../src/core/scoring/criteria.js';
import { stakeholderToolHandlers } from '../../../src/core/stakeholders/personas.js';
import {
  answerQuestions,
  ensureQuestions,
  NODE_QUESTIONS,
  openQuestions,
  PEOPLE_TEMPLATES,
  questionText,
  revealStakeholder,
  SYSTEM_TEMPLATES,
} from '../../../src/core/stakeholders/questions.js';
import { StakeholderError } from '../../../src/core/stakeholders/statements.js';
import { stakeholderRepos } from '../../../src/core/stakeholders/store.js';
import type { Store } from '../../../src/core/store/db.js';
import { newId } from '../../../src/core/store/repos.js';
import { fixtureStakeholderTask, researchSetup, review, type Picker } from '../helpers/research.js';

const opened: Store[] = [];
afterEach(() => {
  for (const s of opened.splice(0)) s.close();
});

const NOW = '2026-11-15T10:00:00.000Z';
const ACTOR = 'tester';

function setup(pick?: Picker) {
  const dir = mkdtempSync(join(tmpdir(), 'bif-stk-q-'));
  const t = researchSetup(opened, {
    dir,
    extraHandlers: () => ({ ...researchToolHandlers(), ...stakeholderToolHandlers({ dataDir: dir }) }),
    ...(pick ? { pick } : {}),
  });
  t.store.workspaces.insert({ id: 'ws_a', name: 'Acme', sector: 'saas', createdAt: NOW });
  t.store.workspaces.insert({ id: 'ws_other', name: 'Other', sector: 'saas', createdAt: NOW });
  const art = t.artifacts.save({ workspaceId: 'ws_a', kind: 'text', mime: 'text/plain', bytes: 'Org chart of Acme' }).id;
  const otherArt = t.artifacts.save({ workspaceId: 'ws_other', kind: 'text', mime: 'text/plain', bytes: 'Org chart of Other' }).id;
  const ctx = (workspaceId = 'ws_a'): RunContext => ({
    agentRunId: newId('arun'), workspaceId, role: 'worker', model: { provider: 'claude', model: 'sonnet' }, promptVersion: 'pv',
  });
  /** Saves an own stakeholder through `save_stakeholder`; `verified` (usable) unless `usable: false`. */
  const save = async (label: string, type = 'leader', opts: { usable?: boolean; workspaceId?: string } = {}) => {
    const ws = opts.workspaceId ?? 'ws_a';
    const profile = Object.fromEntries(
      STAKEHOLDER_FIELDS.map((f) => [f, { value: `${f} of ${label}`, confidence: 0.5, evidence: [ws === 'ws_other' ? otherArt : art] }]),
    );
    const r = await t.handle({ ...ctx(ws), taskId: fixtureStakeholderTask(t.store, ws, 'own').id }, 'save_stakeholder', { label, stakeholder_type: type, subject: 'own', relation: `needs ${label}`, profile });
    if (!r.ok) throw new Error(r.error);
    const id = (r.data as { personaId: string }).personaId;
    if (opts.usable !== false) t.store.personas.update(id, { status: 'verified' });
    return id;
  };
  const questions = (personaId?: string) =>
    stakeholderRepos(t.store).questions.list({ workspaceId: 'ws_a' }).filter((q) => (q.personaId ?? undefined) === personaId);
  return { ...t, save, questions, ctx, art };
}

/** The exact copy of spec §8. */
const PEOPLE_SPEC = [
  ['decision_criteria', 'When {label} decides on something you bring to them, what matters most to them?'],
  ['dependencies', 'What do you need from {label} (approval, budget, people, information), and what do they need from you?'],
  ['known_positions', 'Think of the last time {label} said yes or no to something you proposed. What was it, and what reason did they give?'],
  ['objections', 'What usually makes {label} hesitate or push back?'],
];
const SYSTEM_SPEC = [
  ['dependencies', 'What does {label} provide to you, and what do you have to ask them for?'],
  ['decision_criteria', 'When you ask {label} for a change or for access, what decides whether you get it?'],
  ['known_positions', 'Think of the last request {label} accepted or turned down. What was it, and why?'],
  ['constraints', 'What limits what {label} can do for you (their roadmap, capacity, rules)?'],
];
const NODE_SPEC = [
  ['missing', 'Is anyone missing from this list whose approval, budget or data you depend on?'],
  ['not_relevant', 'Is anyone on this list not relevant to your work?'],
];

describe('templates', () => {
  it('are the exact copy of spec §8', () => {
    expect(PEOPLE_TEMPLATES.map((t) => [t.field, t.text])).toEqual(PEOPLE_SPEC);
    expect(SYSTEM_TEMPLATES.map((t) => [t.field, t.text])).toEqual(SYSTEM_SPEC);
    expect(NODE_QUESTIONS.map((t) => [t.field, t.text])).toEqual(NODE_SPEC);
  });

  it('every template filled with a label is the template with the label substituted, nothing else', () => {
    const label = 'Chief financial officer';
    for (const tpl of [...PEOPLE_TEMPLATES, ...SYSTEM_TEMPLATES]) {
      const [before, after, ...rest] = tpl.text.split('{label}');
      expect(rest).toEqual([]);
      expect(questionText(tpl.text, label)).toBe(`${before}${label}${after}`);
    }
  });

  it('a label holding template text or markup appears literally, once, with no second substitution', () => {
    for (const label of ['{label} <b>x</b>', '$& $1 $$ {label}']) {
      for (const tpl of [...PEOPLE_TEMPLATES, ...SYSTEM_TEMPLATES]) {
        const [before, after] = tpl.text.split('{label}');
        const text = questionText(tpl.text, label);
        expect(text).toBe(`${before}${label}${after}`);
        expect(text.split(label).length - 1).toBe(1);
      }
    }
  });
});

describe('ensureQuestions', () => {
  it('a leader gets the people templates, a team the system templates, and the node gets the two node questions', async () => {
    const t = setup();
    const cfo = await t.save('Chief financial officer', 'leader');
    const billing = await t.save('Billing platform team', 'team');
    const created = ensureQuestions(t.store, 'ws_a');
    expect(created).toHaveLength(10);
    expect(t.questions(cfo).map((q) => [q.field, q.text])).toEqual(
      PEOPLE_SPEC.map(([f, s]) => [f, s!.replace('{label}', 'Chief financial officer')]),
    );
    expect(t.questions(billing).map((q) => [q.field, q.text])).toEqual(
      SYSTEM_SPEC.map(([f, s]) => [f, s!.replace('{label}', 'Billing platform team')]),
    );
    expect(t.questions(undefined).map((q) => [q.field, q.text])).toEqual(NODE_SPEC);
    for (const q of created) {
      expect(q.id).toMatch(/^stq_/);
      expect(q).toMatchObject({ rootWorkspaceId: 'ws_a', workspaceId: 'ws_a', status: 'open' });
    }
  });

  it('twice creates nothing new; review status does not matter except superseded and failed', async () => {
    const t = setup();
    await t.save('Chief financial officer');
    const pending = await t.save('Head of sales', 'manager', { usable: false }); // status pending
    const unverified = await t.save('Board of directors', 'board', { usable: false });
    t.store.personas.update(unverified, { status: 'unverified' });
    const failed = await t.save('Treasury team', 'team', { usable: false });
    t.store.personas.update(failed, { status: 'failed' });
    const superseded = await t.save('Legal counsel', 'other', { usable: false });
    t.store.personas.update(superseded, { status: 'superseded' });
    expect(ensureQuestions(t.store, 'ws_a')).toHaveLength(3 * 4 + 2);
    expect(ensureQuestions(t.store, 'ws_a')).toEqual([]);
    expect(t.questions(pending)).toHaveLength(4);
    expect(t.questions(unverified)).toHaveLength(4);
    expect(t.questions(failed)).toEqual([]);
    expect(t.questions(superseded)).toEqual([]);
    expect(stakeholderRepos(t.store).questions.list({ workspaceId: 'ws_a' })).toHaveLength(14);
  });

  it('nothing to ask creates no node questions; a later stakeholder gets a new round with its own node questions', async () => {
    const t = setup();
    expect(ensureQuestions(t.store, 'ws_a')).toEqual([]);
    await t.save('Chief financial officer');
    ensureQuestions(t.store, 'ws_a');
    answerQuestions(t.store, ACTOR, 'ws_a', { answers: [], skipAll: true });
    const later = await t.save('Board of directors', 'board');
    const second = ensureQuestions(t.store, 'ws_a');
    expect(second.filter((q) => q.personaId === later)).toHaveLength(4);
    expect(second.filter((q) => !q.personaId).map((q) => q.field)).toEqual(['missing', 'not_relevant']);
    expect(second).toHaveLength(6);
  });

  it('open stakeholders and competitor stakeholders get no questions', async () => {
    const t = setup();
    const cfo = await t.save('Chief financial officer');
    t.store.personas.update(cfo, { disclosure: 'open' });
    expect(ensureQuestions(t.store, 'ws_a')).toEqual([]);
  });
});

describe('openQuestions', () => {
  it('groups open questions by stakeholder (label and type only), node questions last without a persona', async () => {
    const t = setup();
    const cfo = await t.save('Chief financial officer');
    ensureQuestions(t.store, 'ws_a');
    const groups = openQuestions(t.store, 'ws_a');
    expect(groups).toHaveLength(2);
    expect(groups[0]!.persona).toEqual({ id: cfo, label: 'Chief financial officer', stakeholderType: 'leader' });
    expect(groups[0]!.questions).toHaveLength(4);
    expect(groups[1]!.persona).toBeUndefined();
    expect(groups[1]!.questions.map((q) => q.field)).toEqual(['missing', 'not_relevant']);
  });
});

describe('answerQuestions', () => {
  it('Review Focus 2: some answers of one stakeholder open it, skip the rest, and empty answers make no statement', async () => {
    const t = setup();
    const cfo = await t.save('Chief financial officer');
    const cto = await t.save('Chief technology officer');
    ensureQuestions(t.store, 'ws_a');
    const [q1, q2, q3] = t.questions(cfo);
    const missing = t.questions(undefined)[0]!;
    const res = answerQuestions(t.store, ACTOR, 'ws_a', {
      answers: [
        { questionId: q1!.id, text: '  Payback within a year  ' },
        { questionId: q2!.id, text: '   ' },
        { questionId: missing.id, text: 'The works council' },
      ],
    });
    expect(res.opened).toEqual([cfo]);
    expect(res.statements).toHaveLength(2);
    expect(res.statements[0]).toMatchObject({
      personaId: cfo, source: 'question_answer', field: 'decision_criteria', text: 'Payback within a year', questionId: q1!.id, actor: ACTOR,
    });
    expect(res.statements[0]!.id).toMatch(/^sst_/);
    expect(res.statements[1]!.personaId ?? undefined).toBeUndefined();
    expect(res.statements[1]).toMatchObject({ field: 'missing', text: 'The works council', questionId: missing.id });

    const after = t.questions(cfo);
    expect(after[0]).toMatchObject({ status: 'answered', statementId: res.statements[0]!.id });
    expect(after[0]!.answeredAt).toBeTruthy();
    expect(after.slice(1).map((q) => q.status)).toEqual(['skipped', 'skipped', 'skipped']);
    expect(q3).toBeDefined();
    expect(t.store.personas.get(cfo)!.disclosure).toBe('open');
    // untouched stakeholder stays hidden with open questions; the other node question stays open
    expect(t.store.personas.get(cto)!.disclosure).toBe('hidden');
    expect(t.questions(cto).every((q) => q.status === 'open')).toBe(true);
    expect(t.questions(undefined).map((q) => q.status)).toEqual(['answered', 'open']);

    const events = listFeedback(t.store, { kind: 'stakeholder_answers' });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ actor: ACTOR, targetType: 'workspace', targetId: 'ws_a', workspaceId: 'ws_a' });
    expect(events[0]!.afterJson).toEqual({ answered: [q1!.id, missing.id], opened: [cfo] });
    expect(JSON.stringify(events[0])).not.toMatch(/Payback|works council/);
  });

  it('skip opens a stakeholder without statements', async () => {
    const t = setup();
    const cfo = await t.save('Chief financial officer');
    ensureQuestions(t.store, 'ws_a');
    const res = answerQuestions(t.store, ACTOR, 'ws_a', { answers: [], skip: [cfo] });
    expect(res).toEqual({ opened: [cfo], statements: [] });
    expect(t.questions(cfo).every((q) => q.status === 'skipped')).toBe(true);
    expect(t.store.personas.get(cfo)!.disclosure).toBe('open');
  });

  it('the node questions close with the round: skipped once no hidden stakeholder of the node has open questions', async () => {
    const t = setup();
    const cfo = await t.save('Chief financial officer');
    const cto = await t.save('Chief technology officer');
    ensureQuestions(t.store, 'ws_a');
    const [missing] = t.questions(undefined);
    answerQuestions(t.store, ACTOR, 'ws_a', { answers: [{ questionId: missing!.id, text: 'The works council' }], skip: [cfo] });
    expect(t.questions(undefined).map((q) => q.status)).toEqual(['answered', 'open']);
    answerQuestions(t.store, ACTOR, 'ws_a', { answers: [{ questionId: t.questions(cto)[0]!.id, text: 'Uptime first' }] });
    expect(t.questions(undefined).map((q) => q.status)).toEqual(['answered', 'skipped']);
    expect(openQuestions(t.store, 'ws_a')).toEqual([]);
  });

  it('a question of another node of the same tree answers 404; blank answers count as not sent', async () => {
    const t = setup();
    t.store.workspaces.insert({ id: 'ws_child', name: 'Acme Payments', sector: 'saas', createdAt: NOW, parentWorkspaceId: 'ws_a' });
    const cfo = await t.save('Chief financial officer');
    const child = await t.save('Head of payments', 'manager', { workspaceId: 'ws_child' });
    ensureQuestions(t.store, 'ws_a');
    ensureQuestions(t.store, 'ws_child');
    const childQ = stakeholderRepos(t.store).questions.list({ workspaceId: 'ws_child', personaId: child })[0]!;
    try {
      answerQuestions(t.store, ACTOR, 'ws_a', { answers: [{ questionId: childQ.id, text: 'x' }] });
      throw new Error('expected a refusal');
    } catch (e) {
      expect((e as StakeholderError).status).toBe(404);
    }
    const [q1] = t.questions(cfo);
    answerQuestions(t.store, ACTOR, 'ws_a', { answers: [{ questionId: q1!.id, text: 'Payback' }] });
    // blank answers to a closed question, twice, or to an unknown id are ignored
    const res = answerQuestions(t.store, ACTOR, 'ws_a', {
      answers: [
        { questionId: q1!.id, text: '  ' },
        { questionId: q1!.id, text: '' },
        { questionId: 'stq_missing', text: ' ' },
      ],
    });
    expect(res).toEqual({ opened: [], statements: [] });
    expect(listFeedback(t.store, { kind: 'stakeholder_answers' })).toHaveLength(1);
  });

  it('skipAll opens every stakeholder of the round and skips every open question, node questions too', async () => {
    const t = setup();
    const cfo = await t.save('Chief financial officer');
    const team = await t.save('Billing platform team', 'team');
    ensureQuestions(t.store, 'ws_a');
    const res = answerQuestions(t.store, ACTOR, 'ws_a', { answers: [], skipAll: true });
    expect(res.opened.sort()).toEqual([cfo, team].sort());
    expect(stakeholderRepos(t.store).questions.list({ workspaceId: 'ws_a' }).every((q) => q.status === 'skipped')).toBe(true);
    expect(openQuestions(t.store, 'ws_a')).toEqual([]);
    expect(listFeedback(t.store, { kind: 'stakeholder_answers' })).toHaveLength(1);
  });

  it('answers are redacted and capped at 4,000 characters', async () => {
    const t = setup();
    t.store.identities.insert({
      id: 'idn_1', workspaceId: 'ws_a', site: 'example.com', name: 'Test', email: 'test@example.com', password: 'hunter2-secret', createdAt: NOW,
    });
    const cfo = await t.save('Chief financial officer');
    ensureQuestions(t.store, 'ws_a');
    const [q1, q2] = t.questions(cfo);
    const res = answerQuestions(t.store, ACTOR, 'ws_a', {
      answers: [
        { questionId: q1!.id, text: 'the password is hunter2-secret' },
        { questionId: q2!.id, text: 'y'.repeat(5000) },
      ],
    });
    expect(res.statements[0]!.text).not.toContain('hunter2-secret');
    expect(res.statements[1]!.text.length).toBeLessThanOrEqual(4000);
  });

  it('refuses another tree\'s question (404), a closed question (409), an unknown skip (404) and changes nothing', async () => {
    const t = setup();
    await t.save('Chief financial officer');
    const foreign = await t.save('Foreign director', 'leader', { workspaceId: 'ws_other' });
    ensureQuestions(t.store, 'ws_a');
    ensureQuestions(t.store, 'ws_other');
    const foreignQ = stakeholderRepos(t.store).questions.list({ workspaceId: 'ws_other', personaId: foreign })[0]!;
    const err = (fn: () => unknown) => {
      try {
        fn();
      } catch (e) {
        return e as StakeholderError;
      }
      throw new Error('expected a refusal');
    };
    const e1 = err(() => answerQuestions(t.store, ACTOR, 'ws_a', { answers: [{ questionId: foreignQ.id, text: 'x' }] }));
    expect(e1).toBeInstanceOf(StakeholderError);
    expect(e1.status).toBe(404);
    expect(err(() => answerQuestions(t.store, ACTOR, 'ws_a', { answers: [], skip: [foreign] })).status).toBe(404);
    expect(err(() => answerQuestions(t.store, ACTOR, 'ws_a', { answers: [{ questionId: 'stq_missing', text: 'x' }] })).status).toBe(404);

    const mine = t.questions(t.store.personas.list({ workspaceId: 'ws_a' })[0]!.id)[0]!;
    answerQuestions(t.store, ACTOR, 'ws_a', { answers: [{ questionId: mine.id, text: 'first' }] });
    expect(err(() => answerQuestions(t.store, ACTOR, 'ws_a', { answers: [{ questionId: mine.id, text: 'again' }] })).status).toBe(409);
    expect(t.store.personas.get(foreign)!.disclosure).toBe('hidden');
    expect(stakeholderRepos(t.store).statements.list({})).toHaveLength(1);
  });

  it('changes no persona column but disclosure: version, profile, relation and agent.md stay', async () => {
    const t = setup();
    const cfo = await t.save('Chief financial officer');
    ensureQuestions(t.store, 'ws_a');
    const before = t.store.personas.get(cfo)!;
    const md = readFileSync(before.agentMdPath, 'utf8');
    answerQuestions(t.store, ACTOR, 'ws_a', { answers: [{ questionId: t.questions(cfo)[0]!.id, text: 'Payback' }] });
    const after = t.store.personas.get(cfo)!;
    expect(after).toEqual({ ...before, disclosure: 'open' });
    expect(readFileSync(after.agentMdPath, 'utf8')).toBe(md);
  });

  it('opening is one-way: a later save_stakeholder keeps it open', async () => {
    const t = setup();
    const cfo = await t.save('Chief financial officer');
    ensureQuestions(t.store, 'ws_a');
    answerQuestions(t.store, ACTOR, 'ws_a', { answers: [], skip: [cfo] });
    await t.save('Chief financial officer');
    expect(t.store.personas.get(cfo)).toMatchObject({ disclosure: 'open', version: 2 });
    expect(ensureQuestions(t.store, 'ws_a')).toEqual([]);
  });
});

describe('revealStakeholder', () => {
  it('opens it, skips its open questions, and records stakeholder_reveal', async () => {
    const t = setup();
    const cfo = await t.save('Chief financial officer');
    ensureQuestions(t.store, 'ws_a');
    const p = revealStakeholder(t.store, ACTOR, 'ws_a', cfo);
    expect(p.disclosure).toBe('open');
    expect(t.questions(cfo).every((q) => q.status === 'skipped')).toBe(true);
    expect(t.questions(undefined).every((q) => q.status === 'skipped')).toBe(true); // no hidden stakeholder with open questions left
    const events = listFeedback(t.store, { kind: 'stakeholder_reveal' });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ actor: ACTOR, targetType: 'stakeholder', targetId: cfo });
    // a second reveal changes nothing
    revealStakeholder(t.store, ACTOR, 'ws_a', cfo);
    expect(listFeedback(t.store, { kind: 'stakeholder_reveal' })).toHaveLength(1);
  });

  it('a reveal that leaves no hidden stakeholder with open questions skips the node questions', async () => {
    const t = setup();
    const cfo = await t.save('Chief financial officer');
    const ops = await t.save('Head of operations');
    ensureQuestions(t.store, 'ws_a');
    revealStakeholder(t.store, ACTOR, 'ws_a', cfo);
    expect(t.questions(undefined).every((q) => q.status === 'open')).toBe(true); // ops is still hidden with open questions
    revealStakeholder(t.store, ACTOR, 'ws_a', ops);
    expect(t.questions(undefined).map((q) => q.status)).toEqual(['skipped', 'skipped']);
  });

  it('another tree\'s persona and a segment persona answer 404', async () => {
    const t = setup();
    const foreign = await t.save('Foreign director', 'leader', { workspaceId: 'ws_other' });
    t.store.personas.insert({
      id: 'per_seg', workspaceId: 'ws_a', slug: 'seg', segment: 'SMB owners', profile: {}, agentMdPath: 'seg.md', version: 1, status: 'verified',
    });
    for (const id of [foreign, 'per_seg', 'per_missing']) {
      try {
        revealStakeholder(t.store, ACTOR, 'ws_a', id);
        throw new Error('expected a refusal');
      } catch (e) {
        expect((e as StakeholderError).status).toBe(404);
      }
    }
    expect(t.store.personas.get(foreign)!.disclosure).toBe('hidden');
  });
});

describe('when the stakeholders phase ends', () => {
  const plan: FakeScript = async (t) => {
    await t.call('propose_tasks', {
      tasks: [{ type: 'own_stakeholders', brief: 'map stakeholders', model: { provider: 'claude', model: 'sonnet' }, needs_browser: false, acceptance_criteria: ['c'] }],
    });
  };
  /** Evidence another task captured earlier: own stakeholder research may only read it (it cannot save artifacts). */
  let orgChart = '';
  const work: FakeScript = async (t) => {
    const profile = Object.fromEntries(STAKEHOLDER_FIELDS.map((f) => [f, { value: `${f} v`, confidence: 0.5, evidence: [orgChart] }]));
    await t.call('save_stakeholder', { label: 'Chief financial officer', stakeholder_type: 'leader', subject: 'own', relation: 'approves pricing', profile });
    await t.call('submit_result', { summary: 'saved one', evidence: [orgChart] });
  };
  const pick: Picker = (r) => (r.kind === 'orchestrate' ? (r.round === 1 ? plan : async () => {}) : r.kind === 'work' ? work : review(9));

  it('the verified stakeholders of the phase get their question round', async () => {
    const t = setup(pick);
    orgChart = t.artifacts.save({ workspaceId: 'ws_a', kind: 'text', mime: 'text/plain', bytes: 'Org chart: the CFO approves pricing' }).id;
    const rr = await startPhase('ws_a', 'stakeholders', t.deps);
    expect(rr.status).toBe('done');
    const [p] = t.store.personas.list({ workspaceId: 'ws_a', kind: 'stakeholder' });
    expect(p).toMatchObject({ status: 'verified', disclosure: 'hidden' });
    expect(t.questions(p!.id)).toHaveLength(4);
    expect(t.questions(undefined)).toHaveLength(2);
  });

  it('a failing question round never fails the phase: it is logged and recorded', async () => {
    const t = setup(pick);
    orgChart = t.artifacts.save({ workspaceId: 'ws_a', kind: 'text', mime: 'text/plain', bytes: 'Org chart: the CFO approves pricing' }).id;
    t.store.db.exec('DROP TABLE stakeholder_questions');
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const rr = await startPhase('ws_a', 'stakeholders', t.deps);
      expect(rr.status).toBe('done');
      expect(log).toHaveBeenCalledWith(expect.stringMatching(/stakeholder questions after research run/));
      const d = t.store.decisions.list({ agentRunId: `stakeholders:${rr.id}` });
      expect(d[0]!.payload).toMatchObject({ event: 'stakeholder_questions_failed', researchRunId: rr.id });
    } finally {
      log.mockRestore();
    }
  });
});
