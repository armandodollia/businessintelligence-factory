/**
 * Stakeholder personas, task 3 (design 2026-11-15-stakeholder-personas-design.md §9, §16): statements —
 * notes, real decision records, the interviewer's `note_stakeholder` tool, open statements, and that
 * storing a statement changes no persona.
 */
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { listFeedback } from '../../../src/core/feedback/events.js';
import type { RunContext } from '../../../src/core/harness/tokens.js';
import { buildInterviewPrompt, interviewToolHandlers } from '../../../src/core/interview/interview.js';
import { personaLearningRepos } from '../../../src/core/personas/store.js';
import { STAKEHOLDER_FIELDS } from '../../../src/core/scoring/criteria.js';
import { stakeholderToolHandlers } from '../../../src/core/stakeholders/personas.js';
import { addNote, openStatements, recordDecision, StakeholderError } from '../../../src/core/stakeholders/statements.js';
import { stakeholderRepos } from '../../../src/core/stakeholders/store.js';
import type { Store } from '../../../src/core/store/db.js';
import { newId } from '../../../src/core/store/repos.js';
import { fixtureStakeholderTask, researchSetup } from '../helpers/research.js';

const opened: Store[] = [];
afterEach(() => {
  for (const s of opened.splice(0)) s.close();
});

const NOW = '2026-11-15T10:00:00.000Z';
const ACTOR = 'tester';

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'bif-stk-st-'));
  const t = researchSetup(opened, {
    dir,
    extraHandlers: () => ({ ...stakeholderToolHandlers({ dataDir: dir }), ...interviewToolHandlers() }),
  });
  t.store.workspaces.insert({ id: 'ws_a', name: 'Acme', sector: 'saas', createdAt: NOW });
  t.store.workspaces.insert({ id: 'ws_b', name: 'Acme Payments', sector: 'saas', createdAt: NOW, parentWorkspaceId: 'ws_a' });
  t.store.workspaces.insert({ id: 'ws_other', name: 'Other', sector: 'saas', createdAt: NOW });
  const arts: Record<string, string> = {};
  for (const ws of ['ws_a', 'ws_b', 'ws_other']) {
    arts[ws] = t.artifacts.save({ workspaceId: ws, kind: 'text', mime: 'text/plain', bytes: `Org chart of ${ws}` }).id;
  }
  const ctx = (workspaceId = 'ws_a', role: RunContext['role'] = 'worker'): RunContext => ({
    agentRunId: newId('arun'), workspaceId, role, model: { provider: 'claude', model: 'sonnet' }, promptVersion: 'pv',
  });
  const save = async (label: string, opts: { workspaceId?: string; subject?: string } = {}) => {
    const ws = opts.workspaceId ?? 'ws_a';
    const profile = Object.fromEntries(STAKEHOLDER_FIELDS.map((f) => [f, { value: `${f} of ${label}`, confidence: 0.5, evidence: [arts[ws]!] }]));
    const r = await t.handle({ ...ctx(ws), taskId: fixtureStakeholderTask(t.store, ws, opts.subject ?? 'own').id }, 'save_stakeholder', {
      label, stakeholder_type: 'leader', subject: opts.subject ?? 'own', relation: `needs ${label}`, profile,
    });
    if (!r.ok) throw new Error(r.error);
    const id = (r.data as { personaId: string }).personaId;
    t.store.personas.update(id, { status: 'verified' });
    return id;
  };
  const rec = (id: string, workspaceId = 'ws_a') =>
    t.store.recommendations.insert({ id, workspaceId, title: 'Raise prices', summary: 's', criteria: {}, findingIds: [], priority: 3, createdAt: NOW, personaFeedback: [] });
  return { ...t, save, rec, ctx };
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

describe('addNote', () => {
  it('stores a note on a hidden stakeholder without revealing it, and one stakeholder_note event without the text', async () => {
    const t = setup();
    const cfo = await t.save('Chief financial officer');
    const s = addNote(t.store, ACTOR, 'ws_a', { personaId: cfo, text: '  Cares about payback  ', field: 'decision_criteria' });
    expect(s).toMatchObject({
      rootWorkspaceId: 'ws_a', workspaceId: 'ws_a', personaId: cfo, source: 'note', field: 'decision_criteria', text: 'Cares about payback', actor: ACTOR,
    });
    expect(s.id).toMatch(/^sst_/);
    expect(t.store.personas.get(cfo)!.disclosure).toBe('hidden');
    const ev = listFeedback(t.store, { kind: 'stakeholder_note' });
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ actor: ACTOR, targetType: 'stakeholder', targetId: cfo });
    expect(JSON.stringify(ev[0])).not.toContain('payback');
  });

  it('a note without a persona is node-wide', () => {
    const t = setup();
    const s = addNote(t.store, ACTOR, 'ws_b', { text: 'The works council must agree' });
    expect(s).toMatchObject({ rootWorkspaceId: 'ws_a', workspaceId: 'ws_b', source: 'note' });
    expect(s.personaId ?? undefined).toBeUndefined();
  });

  it('refuses an empty text, an unknown field (400), another tree\'s or a segment persona (404)', async () => {
    const t = setup();
    const cfo = await t.save('Chief financial officer');
    const foreign = await t.save('Foreign director', { workspaceId: 'ws_other' });
    t.store.personas.insert({ id: 'per_seg', workspaceId: 'ws_a', slug: 'seg', segment: 'SMB', profile: {}, agentMdPath: 'x.md', version: 1 });
    expect(refusal(() => addNote(t.store, ACTOR, 'ws_a', { personaId: cfo, text: '   ' })).status).toBe(400);
    expect(refusal(() => addNote(t.store, ACTOR, 'ws_a', { personaId: cfo, text: 'x', field: 'shoe_size' })).status).toBe(400);
    expect(refusal(() => addNote(t.store, ACTOR, 'ws_a', { personaId: foreign, text: 'x' })).status).toBe(404);
    expect(refusal(() => addNote(t.store, ACTOR, 'ws_a', { personaId: 'per_seg', text: 'x' })).status).toBe(404);
    expect(stakeholderRepos(t.store).statements.list({})).toEqual([]);
  });

  it('text is redacted and capped at 4,000 characters', async () => {
    const t = setup();
    t.store.identities.insert({ id: 'idn_1', workspaceId: 'ws_a', site: 'x.test', name: 'n', email: 'n@x.test', password: 'Zq9xK2mPw7Lr', createdAt: NOW });
    const a = addNote(t.store, ACTOR, 'ws_b', { text: 'password Zq9xK2mPw7Lr' });
    expect(a.text).not.toContain('Zq9xK2mPw7Lr');
    const b = addNote(t.store, ACTOR, 'ws_a', { text: 'z'.repeat(9000) });
    expect(b.text.length).toBeLessThanOrEqual(4000);
    expect(b.text.length).toBeGreaterThan(3990);
  });
});

describe('recordDecision', () => {
  it('stores the real decision as a statement and one stakeholder_decision_record event (ids and decision only)', async () => {
    const t = setup();
    const cfo = await t.save('Chief financial officer');
    t.store.personas.update(cfo, { disclosure: 'open' });
    t.rec('rec_1');
    const s = recordDecision(t.store, ACTOR, 'ws_a', { recommendationId: 'rec_1', personaId: cfo, decision: 'rejected', reasoning: ' Too risky this year ' });
    expect(s).toMatchObject({
      personaId: cfo, source: 'decision_record', recommendationId: 'rec_1', decision: 'rejected', text: 'Too risky this year', actor: ACTOR,
    });
    const ev = listFeedback(t.store, { kind: 'stakeholder_decision_record' });
    expect(ev).toHaveLength(1);
    expect(ev[0]!.afterJson).toEqual({ statementId: s.id, personaId: cfo, recommendationId: 'rec_1', decision: 'rejected' });
    expect(JSON.stringify(ev[0])).not.toContain('risky');
  });

  it('validates: decision enum and reasoning (400), unknown or foreign recommendation and persona (404), hidden (409), not own or not the node (400)', async () => {
    const t = setup();
    const cfo = await t.save('Chief financial officer');
    const hidden = await t.save('Board chair');
    const child = await t.save('Head of payments', { workspaceId: 'ws_b' });
    const foreign = await t.save('Foreign director', { workspaceId: 'ws_other' });
    t.store.competitors.insert({
      id: 'cmp_rival', workspaceId: 'ws_a', name: 'Rival', threat: 4, directness: 5,
      comparison: { pricing: 3, onboarding: 3, ux: 3, features: 3 }, evidence: [], createdAt: NOW, updatedAt: NOW, status: 'verified',
    });
    const rival = await t.save('Rival CEO', { subject: 'cmp_rival' });
    for (const id of [cfo, child, foreign, rival]) t.store.personas.update(id, { disclosure: 'open' });
    t.rec('rec_1');
    t.rec('rec_foreign', 'ws_other');
    const ok = { recommendationId: 'rec_1', personaId: cfo, decision: 'approved' as const, reasoning: 'fine' };
    const r = (over: Record<string, unknown>) => refusal(() => recordDecision(t.store, ACTOR, 'ws_a', { ...ok, ...over } as typeof ok)).status;
    expect(r({ decision: 'maybe' })).toBe(400);
    expect(r({ reasoning: '  ' })).toBe(400);
    expect(r({ reasoning: 'x'.repeat(2001) })).toBe(400);
    expect(r({ recommendationId: 'rec_missing' })).toBe(404);
    expect(r({ recommendationId: 'rec_foreign' })).toBe(404);
    expect(r({ personaId: foreign })).toBe(404);
    expect(r({ personaId: 'per_missing' })).toBe(404);
    expect(r({ personaId: hidden })).toBe(409);
    expect(r({ personaId: rival })).toBe(400);
    expect(r({ personaId: child })).toBe(400);
    expect(stakeholderRepos(t.store).statements.list({})).toEqual([]);
    expect(recordDecision(t.store, ACTOR, 'ws_a', ok).decision).toBe('approved');
  });
});

describe('note_stakeholder (interviewer)', () => {
  it('stores a quote the user typed (whitespace-normalised), with source interview and a Decision without the text', async () => {
    const t = setup();
    const cfo = await t.save('Chief financial officer');
    t.store.interview.insert({ id: 'itv_1', workspaceId: 'ws_a', role: 'user', text: 'Our CFO   only signs off\nwhen payback is under a year.', createdAt: NOW });
    const c = t.ctx('ws_a', 'interviewer');
    const r = await t.handle(c, 'note_stakeholder', { persona_id: cfo, quote: 'CFO only signs off when payback is under a year', field: 'decision_criteria' });
    expect(r.ok).toBe(true);
    const id = (r as { data: { statementId: string } }).data.statementId;
    const s = stakeholderRepos(t.store).statements.get(id)!;
    expect(s).toMatchObject({ source: 'interview', personaId: cfo, field: 'decision_criteria', text: 'CFO only signs off when payback is under a year', workspaceId: 'ws_a' });
    const decisions = t.store.decisions.list({ agentRunId: c.agentRunId });
    expect(decisions).toHaveLength(1);
    expect(decisions[0]!.payload).toMatchObject({ tool: 'note_stakeholder', statementId: id, personaId: cfo });
    expect(JSON.stringify(decisions[0])).not.toContain('payback');
    expect(t.store.personas.get(cfo)!.disclosure).toBe('hidden');
    // a replayed call in the same run stores nothing new
    const again = await t.handle(c, 'note_stakeholder', { persona_id: cfo, quote: 'CFO only signs off when payback is under a year', field: 'decision_criteria' });
    expect((again as { data: { statementId: string } }).data.statementId).toBe(id);
    expect(stakeholderRepos(t.store).statements.list({})).toHaveLength(1);
  });

  it('refuses an invented quote, a quote from the interviewer\'s own turn, a case change and a foreign persona', async () => {
    const t = setup();
    const foreign = await t.save('Foreign director', { workspaceId: 'ws_other' });
    t.store.interview.insert({ id: 'itv_1', workspaceId: 'ws_a', role: 'user', text: 'Our CFO signs off on pricing.', createdAt: NOW });
    t.store.interview.insert({ id: 'itv_2', workspaceId: 'ws_a', role: 'agent', text: 'So the board decides budgets?', createdAt: NOW });
    t.store.interview.insert({ id: 'itv_3', workspaceId: 'ws_b', role: 'user', text: 'The board decides budgets', createdAt: NOW });
    const c = t.ctx('ws_a', 'interviewer');
    const call = (input: Record<string, unknown>) => t.handle(c, 'note_stakeholder', input);
    expect(await call({ quote: 'The CEO hates discounts' })).toMatchObject({ ok: false });
    expect(await call({ quote: 'the board decides budgets' })).toMatchObject({ ok: false });
    expect(await call({ quote: 'The board decides budgets' })).toMatchObject({ ok: false }); // another node's transcript
    expect(await call({ quote: 'our cfo signs off' })).toMatchObject({ ok: false });
    expect(await call({ quote: 'CFO signs off', persona_id: foreign })).toMatchObject({ ok: false });
    expect(stakeholderRepos(t.store).statements.list({})).toEqual([]);
    expect(await call({ quote: 'CFO signs off' })).toMatchObject({ ok: true });
  });

  it('refuses a quote shorter than 12 characters (schema and handler)', async () => {
    const t = setup();
    t.store.interview.insert({ id: 'itv_1', workspaceId: 'ws_a', role: 'user', text: 'Our CFO signs off.', createdAt: NOW });
    const c = t.ctx('ws_a', 'interviewer');
    const short = await t.handle(c, 'note_stakeholder', { quote: 'CFO signs' });
    expect(short).toMatchObject({ ok: false });
    expect((short as { error: string }).error).toMatch(/quote/);
    // 12 characters before whitespace normalisation, fewer after: the handler refuses it
    const spaced = await t.handle(c, 'note_stakeholder', { quote: '  CFO  signs ' });
    expect(spaced).toMatchObject({ ok: false, error: 'quote needs at least 12 characters' });
    expect(await t.handle(c, 'note_stakeholder', { quote: 'CFO signs of' })).toMatchObject({ ok: true });
  });

  it('the interviewer prompt lists the node\'s own stakeholders (id, label, type only, hidden ones too), fenced', async () => {
    const t = setup();
    const ws = t.store.workspaces.get('ws_a')!;
    expect(buildInterviewPrompt(ws, t.store)).not.toMatch(/note_stakeholder|## Stakeholders/);
    const cfo = await t.save('Chief financial officer');
    const team = await t.save('Billing platform team');
    t.store.personas.update(team, { disclosure: 'open', stakeholderType: 'team' });
    await t.save('Head of payments', { workspaceId: 'ws_b' });
    const rival = await t.save('Rival chief executive');
    t.store.personas.update(rival, { subjectKind: 'competitor' });
    const p = buildInterviewPrompt(ws, t.store);
    expect(p).toContain('## Stakeholders of this node');
    expect(p).toContain(`- ${cfo} — Chief financial officer (leader)`);
    expect(p).toContain(`- ${team} — Billing platform team (team)`);
    expect(p).toMatch(/<<<EVIDENCE stakeholders\n- per_/);
    expect(p).toMatch(/call `note_stakeholder` with the user's exact words/);
    expect(p).toMatch(/without `persona_id`/);
    expect(p).not.toContain('Head of payments'); // another node's
    expect(p).not.toContain('Rival chief executive'); // not an own stakeholder
    expect(p).not.toContain('needs Chief financial officer'); // no relation
    expect(p).not.toContain('decision_criteria of'); // no profile
  });

  it('is available to the interviewer only', async () => {
    const t = setup();
    t.store.interview.insert({ id: 'itv_1', workspaceId: 'ws_a', role: 'user', text: 'Our CFO signs off.', createdAt: NOW });
    expect(await t.handle(t.ctx('ws_a', 'worker'), 'note_stakeholder', { quote: 'CFO signs off' })).toMatchObject({ ok: false });
  });
});

describe('openStatements and persona invariance', () => {
  it('returns the persona\'s statements not consumed, oldest first', async () => {
    const t = setup();
    const cfo = await t.save('Chief financial officer');
    const repo = stakeholderRepos(t.store).statements;
    const base = { rootWorkspaceId: 'ws_a', workspaceId: 'ws_a', personaId: cfo, source: 'note' as const, actor: ACTOR };
    repo.insert({ ...base, id: 'sst_c', text: 'third', createdAt: '2026-11-15T12:00:00.000Z' });
    repo.insert({ ...base, id: 'sst_a', text: 'first', createdAt: '2026-11-15T10:00:00.000Z' });
    repo.insert({ ...base, id: 'sst_b', text: 'second', createdAt: '2026-11-15T11:00:00.000Z' });
    repo.insert({ ...base, id: 'sst_d', text: 'consumed', createdAt: '2026-11-15T09:00:00.000Z' });
    repo.update('sst_d', { consumedByRunId: 'arun_x' });
    expect(openStatements(t.store, cfo).map((s) => s.text)).toEqual(['first', 'second', 'third']);
  });

  it('storing any statement leaves the persona, its agent.md and its adjustments unchanged', async () => {
    const t = setup();
    const cfo = await t.save('Chief financial officer');
    t.store.personas.update(cfo, { disclosure: 'open' });
    t.rec('rec_1');
    t.store.interview.insert({ id: 'itv_1', workspaceId: 'ws_a', role: 'user', text: 'Our CFO signs off.', createdAt: NOW });
    const before = t.store.personas.get(cfo)!;
    const md = readFileSync(before.agentMdPath, 'utf8');
    const adjustments = personaLearningRepos(t.store).adjustments.list({ personaId: cfo });
    addNote(t.store, ACTOR, 'ws_a', { personaId: cfo, text: 'note' });
    recordDecision(t.store, ACTOR, 'ws_a', { recommendationId: 'rec_1', personaId: cfo, decision: 'deferred', reasoning: 'later' });
    expect(await t.handle(t.ctx('ws_a', 'interviewer'), 'note_stakeholder', { persona_id: cfo, quote: 'CFO signs off' })).toMatchObject({ ok: true });
    expect(t.store.personas.get(cfo)).toEqual(before);
    expect(readFileSync(before.agentMdPath, 'utf8')).toBe(md);
    expect(personaLearningRepos(t.store).adjustments.list({ personaId: cfo })).toEqual(adjustments);
    expect(openStatements(t.store, cfo)).toHaveLength(3);
  });
});
