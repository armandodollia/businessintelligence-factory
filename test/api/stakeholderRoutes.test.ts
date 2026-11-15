/**
 * Stakeholder routes (design 2026-11-15-stakeholder-personas-design.md §7, §14, §16): the node's
 * stakeholders (hidden ones as id, label, type and question count only), the question round, notes,
 * the user's statements, recorded real decisions, simulated reads and reactions to them; and the
 * persona learning routes of project 2 serving open stakeholders, never hidden ones.
 *
 * The actor of every write is the configured one (`config.user.id`), never the body. Ids of another
 * business tree answer exactly like unknown ones (404). The leak test sweeps every GET route of the
 * real app with a hidden stakeholder whose research, adjustment, proposal, run and read carry marker
 * strings.
 *
 * Fixture: tree A — ws_a "Acme" with a hidden own stakeholder (cfo, saved through `save_stakeholder`,
 * verified, with its question round), an open own stakeholder (ops team), a competitor stakeholder
 * (Rival Pay's CEO), a segment persona and a recommendation rec_1 read by the open ones; tree B — ws_b.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../src/api/routes.js';
import { listFeedback } from '../../src/core/feedback/events.js';
import { writeAgentMd } from '../../src/core/market/personas.js';
import { collectPersonaSignals } from '../../src/core/personas/signals.js';
import { personaLearningRepos } from '../../src/core/personas/store.js';
import { PERSONA_FIELDS, STAKEHOLDER_FIELDS } from '../../src/core/scoring/criteria.js';
import { stakeholderPersonas as stakeholderPersonasOf, stakeholderToolHandlers } from '../../src/core/stakeholders/personas.js';
import { ensureQuestions } from '../../src/core/stakeholders/questions.js';
import { stakeholderRepos } from '../../src/core/stakeholders/store.js';
import type { StakeholderRead } from '../../src/core/stakeholders/types.js';
import type { Store } from '../../src/core/store/db.js';
import { newId, Repo } from '../../src/core/store/repos.js';
import type { Persona } from '../../src/core/types.js';
import { fixtureStakeholderTask, researchSetup } from '../core/helpers/research.js';
import { mkdirSync, writeFileSync } from 'node:fs';
import { runDirOf } from '../../src/core/harness/paths.js';
import type { Experiment, ReviewerAudit } from '../../src/core/learning/wpfTypes.js';
import { recordRunPrompt } from '../../src/core/prompts/store.js';

import { persistBusEvent } from '../../src/core/telemetry/busEvents.js';

/** The `experiments` table (core/learning/experiments.ts keeps its spec private). */
const EXPERIMENT_SPEC = {
  table: 'experiments',
  key: 'id',
  fields: {
    id: 'text', workspaceId: 'text', rootWorkspaceId: 'text', sourceTaskId: 'text', researchRunId: 'text', name: 'text', arms: 'json',
    repeats: 'int', status: 'text', failureReason: 'text', actor: 'text', createdAt: 'text', endedAt: 'text',
  },
} as const;

/** The `reviewer_audits` table (core/learning/reviewerAudit.ts keeps its spec private). */
const AUDIT_SPEC = {
  table: 'reviewer_audits',
  key: 'id',
  fields: {
    id: 'text', batchId: 'text', workspaceId: 'text', rootWorkspaceId: 'text', taskId: 'text', taskType: 'text', startedBy: 'text',
    actor: 'text', scheduleId: 'text', status: 'text', verdict: 'text', reason: 'text', passThreshold: 'real',
    originalDecisionId: 'text', originalRunId: 'text', originalModel: 'json', originalPromptVersion: 'text', originalScore: 'real',
    auditModel: 'json', auditRunId: 'text', auditDecisionId: 'text', auditPromptVersion: 'text', auditScore: 'real',
    auditIssues: 'json', outcomeId: 'text', createdAt: 'text', endedAt: 'text',
  },
} as const;

const opened: Store[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const s of opened.splice(0)) s.close();
});

const T0 = '2026-11-15T10:00:00.000Z';
const ACTOR = 'ana@acme';
/** Every marker starts with this; none may appear in any response while the stakeholder is hidden. */
const MARK = 'LEAKMARK';

let clock = 0;
const at = () => new Date(Date.parse(T0) + ++clock * 1000).toISOString();

async function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'bif-stk-api-'));
  const t = researchSetup(opened, { dir, extraHandlers: () => stakeholderToolHandlers({ dataDir: dir }), config: (c) => (c.user = { id: ACTOR }) });
  t.store.workspaces.insert({ id: 'ws_a', name: 'Acme', sector: 'saas', createdAt: T0, scope: { level: 'company', name: 'Acme', description: 'payments' } });
  t.store.workspaces.insert({ id: 'ws_b', name: 'Beta', sector: 'saas', createdAt: T0 });
  for (const [id, ws, name] of [['cmp_rival', 'ws_a', 'Rival Pay'], ['cmp_beta', 'ws_b', 'Beta Rival']] as const) {
    t.store.competitors.insert({
      id, workspaceId: ws, name, threat: 4, directness: 5, comparison: { pricing: 3, onboarding: 3, ux: 3, features: 3 }, evidence: [], createdAt: T0,
      updatedAt: T0, status: 'verified',
    });
  }
  const app = createApp({ store: t.store, artifacts: t.artifacts, events: t.events, config: t.config, research: t.deps });
  const call = async (method: string, path: string, body?: unknown) => {
    const init: RequestInit = { method, headers: { 'content-type': 'application/json' } };
    if (body !== undefined) init.body = JSON.stringify(body);
    const res = await app.request(path, init);
    const text = await res.text();
    let json: any;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      json = undefined;
    }
    return { status: res.status, body: json, text };
  };

  /** Saves a stakeholder through the real worker tool, then marks it verified. */
  const save = async (ws: string, label: string, subject: string, mark: string, evidence: string, run?: { agentRunId: string; taskId: string }): Promise<Persona> => {
    const profile = Object.fromEntries(STAKEHOLDER_FIELDS.map((f) => [f, { value: `${mark}-${f}`, confidence: 0.6, evidence: [evidence] }]));
    const r = await t.handle(
      {
        agentRunId: run?.agentRunId ?? newId('arun'), workspaceId: ws, role: 'worker', model: { provider: 'claude', model: 'sonnet' }, promptVersion: 'pv',
        taskId: run?.taskId ?? fixtureStakeholderTask(t.store, ws, subject).id,
      },
      'save_stakeholder',
      { label, stakeholder_type: label.includes('team') ? 'team' : 'leader', subject, relation: `${mark}-relation`, profile },
    );
    if (!r.ok) throw new Error(JSON.stringify(r));
    const id = (r as { data: { personaId: string } }).data.personaId;
    return t.store.personas.update(id, { status: 'verified' });
  };
  const evA = t.artifacts.save({ workspaceId: 'ws_a', kind: 'text', mime: 'text/plain', bytes: 'Org chart of Acme' }).id;
  const evB = t.artifacts.save({ workspaceId: 'ws_b', kind: 'text', mime: 'text/plain', bytes: 'Org chart of Beta' }).id;

  // The own-stakeholder research of ws_a: a research run, its task (result, review issues, acceptance
  // notes and failure reason carry markers), a worker run whose events.jsonl holds the save_stakeholder
  // input and model text, a reviewer run with a `review` Decision quoting the profile, bus events and an
  // audit of the task.
  const model = { provider: 'claude' as const, model: 'sonnet' };
  t.store.researchRuns.insert({ id: 'rrun_1', workspaceId: 'ws_a', phase: 'stakeholders', status: 'done', startedAt: T0, endedAt: T0 });
  const ownTask = t.store.tasks.insert({
    id: 'tsk_own', workspaceId: 'ws_a', runId: 'rrun_1', phase: 'stakeholders', type: 'own_stakeholders', brief: 'Who matters to Acme', model,
    needsBrowser: false, acceptanceCriteria: [`${MARK}-acceptance`], status: 'verified', round: 1, createdAt: T0,
    result: { summary: `${MARK}-summary` }, reviewIssues: [{ id: 'i1', class: 'nit', description: `${MARK}-review-issue` }], failureReason: `${MARK}-failure`,
  });
  const runRow = (id: string, role: 'worker' | 'reviewer') =>
    t.store.agentRuns.insert({
      id, workspaceId: 'ws_a', taskId: ownTask.id, role, model, token: `tok_${id}`, status: 'done', startedAt: T0, endedAt: T0, promptVersion: 'pv0001',
      taskType: 'own_stakeholders', failureReason: `${MARK}-run-failure`,
    });
  const workerRun = runRow('arun_w', 'worker');
  const reviewerRun = runRow('arun_r', 'reviewer');
  recordRunPrompt(t.store, 'worker', 'pv0001', 'You are a research worker.');
  const cfo = await save('ws_a', 'Chief financial officer', 'own', MARK, evA, { agentRunId: workerRun.id, taskId: ownTask.id }); // hidden
  const runDir = runDirOf(dir, 'ws_a', workerRun.id);
  mkdirSync(runDir, { recursive: true });
  writeFileSync(
    join(runDir, 'events.jsonl'),
    [
      { t: 'message', text: `${MARK}-model-text: the CFO approves only quick payback` },
      { t: 'tool_call', name: 'save_stakeholder', input: { label: 'Chief financial officer', relation: `${MARK}-relation`, profile: { objections: { value: `${MARK}-objections` } } } },
      { t: 'done', exitCode: 0 },
    ].map((e) => JSON.stringify(e)).join('\n') + '\n',
  );
  const review = t.store.decisions.insert({
    id: newId('dec'), workspaceId: 'ws_a', agentRunId: reviewerRun.id, role: 'reviewer', model, kind: 'review',
    payload: { tool: 'submit_review', score: 8, what: `${MARK}-review-what`, issues: [{ description: `${MARK}-review-quote` }] }, refs: [evA, cfo.id],
    promptVersion: 'pv0001', createdAt: at(),
  });
  persistBusEvent(t.store, { type: 'tool_call', workspaceId: 'ws_a', agentRunId: workerRun.id, tool: 'save_stakeholder', ok: false, error: `${MARK}-tool-error` });
  persistBusEvent(t.store, { type: 'run_status', workspaceId: 'ws_a', agentRunId: workerRun.id, taskId: ownTask.id, status: 'failed', reason: `${MARK}-status-reason` });
  new Repo<ReviewerAudit, 'id'>(t.store.db, AUDIT_SPEC).insert({
    id: 'aud_1', batchId: 'bat_1', workspaceId: 'ws_a', rootWorkspaceId: 'ws_a', taskId: ownTask.id, taskType: 'own_stakeholders', startedBy: 'api', actor: ACTOR,
    status: 'done', verdict: 'miss', reason: `${MARK}-audit-reason`, passThreshold: 7, originalDecisionId: review.id, originalRunId: reviewerRun.id, originalModel: model,
    originalScore: 8, auditModel: model, auditScore: 3, auditIssues: [{ id: 'a1', class: 'blocking', description: `${MARK}-audit-issue` }], createdAt: at(),
  } as ReviewerAudit);
  // A user request of the withheld task (older data: such runs can no longer ask), and an experiment on it.
  t.store.userRequests.insert({
    id: 'ureq_own', workspaceId: 'ws_a', agentRunId: workerRun.id, taskId: ownTask.id, kind: 'escalation', site: `${MARK}-site`,
    details: `${MARK}-request-details`, status: 'pending', createdAt: at(), optionsJson: { options: [`${MARK}-option`, 'No'], recommended: 0, rationale: `${MARK}-rationale-q` },
  });
  t.store.tasks.insert({ ...ownTask, id: 'tsk_arm', failureReason: `${MARK}-arm-failure` });
  new Repo<Experiment, 'id'>(t.store.db, EXPERIMENT_SPEC).insert({
    id: 'exp_1', workspaceId: 'ws_a', rootWorkspaceId: 'ws_a', sourceTaskId: ownTask.id, researchRunId: 'rrun_1', arms: [{ arm: 'A', model, taskIds: ['tsk_arm'] }],
    repeats: 1, status: 'failed', failureReason: `${MARK}-experiment-failure`, actor: ACTOR, createdAt: at(),
  } as Experiment);
  const opsTeam = t.store.personas.update((await save('ws_a', 'Billing platform team', 'own', 'OPS', evA)).id, { disclosure: 'open' });
  const rivalCeo = await save('ws_a', 'Chief executive', 'cmp_rival', 'RIVAL', evA); // competitor: open from the start
  const betaCfo = await save('ws_b', 'Chief financial officer', 'own', 'BETA', evB);
  ensureQuestions(t.store, 'ws_a');
  ensureQuestions(t.store, 'ws_b');

  const segProfile = Object.fromEntries(PERSONA_FIELDS.map((f) => [f, { value: `${f} of smb`, confidence: 0.7, evidence: [] }]));
  const smb = t.store.personas.insert({
    id: 'per_smb', workspaceId: 'ws_a', slug: 'smb', segment: 'Small businesses', profile: segProfile, version: 1, status: 'verified',
    agentMdPath: join(dir, 'ws_a', 'personas', 'smb.md'),
  });
  writeAgentMd(t.store, smb);

  const rec = (id: string, ws: string) =>
    t.store.recommendations.insert({ id, workspaceId: ws, title: `Do ${id}`, summary: 's', criteria: {}, findingIds: [], priority: 3, personaFeedback: [], createdAt: T0, status: 'verified' });
  rec('rec_1', 'ws_a');
  rec('rec_2', 'ws_a');
  rec('rec_b', 'ws_b');
  const read = (p: Persona, recId: string, mark: string, stance: string): StakeholderRead =>
    stakeholderRepos(t.store).reads.insert({
      id: newId('srd'), rootWorkspaceId: p.workspaceId, workspaceId: p.workspaceId, recommendationId: recId, personaId: p.id, personaVersion: p.version,
      stance, conditions: [`${mark}-condition`], concerns: [`${mark}-concern`], reasoning: `${mark}-reasoning`, wouldChangeMind: `${mark}-would-change`,
      agentRunId: 'arun_read', simulated: true, createdAt: at(),
    });
  const reads = {
    cfo: read(cfo, 'rec_1', MARK, 'reject'),
    ops: read(opsTeam, 'rec_1', 'OPS', 'approve'),
    rival: read(rivalCeo, 'rec_1', 'RIVAL', 'watch'),
    beta: read(betaCfo, 'rec_b', 'BETA', 'approve'),
  };

  // Persona learning data of the hidden stakeholder (what a retro would hold, were it not skipped).
  const lr = personaLearningRepos(t.store);
  const adjustment = (p: Persona, mark: string) =>
    lr.adjustments.insert({
      id: newId('pad'), rootWorkspaceId: p.workspaceId, workspaceId: p.workspaceId, personaId: p.id, marker: `A-${Math.random().toString(16).slice(2, 8).toUpperCase()}`,
      text: `${mark}-adjustment`, version: p.version, status: 'active', source: 'retro', actor: ACTOR, stats: {}, internal: true, createdAt: T0, changedAt: T0,
    });
  const proposal = (p: Persona, mark: string) =>
    lr.proposals.insert({
      id: newId('ppr'), rootWorkspaceId: p.workspaceId, workspaceId: p.workspaceId, personaId: p.id, action: 'add', field: 'decision_criteria',
      text: `${mark}-proposal`, rationale: `${mark}-rationale`, evidence: [], stats: {}, source: 'retro', status: 'pending', internal: true, createdAt: at(),
    });
  const run = (p: Persona, mark: string) =>
    lr.runs.insert({
      id: newId('plr'), rootWorkspaceId: p.workspaceId, personaId: p.id, status: 'proposed', signalsThrough: T0, shownSignalIds: [], shownStatementIds: [],
      stats: { n: 0, agree: 0, disagree: 0, items: 0, lower: 0 }, assumption: `${mark}-assumption`, createdAt: at(),
    });
  const hidden = { adjustment: adjustment(cfo, MARK), proposal: proposal(cfo, MARK), run: run(cfo, MARK) };

  const w = (rest: string, ws = 'ws_a') => `/api/workspaces/${ws}${rest}`;
  return { ...t, dir, app, call, w, ownTask, workerRun, reviewerRun, review, cfo, opsTeam, rivalCeo, betaCfo, smb, reads, hidden, adjustment, proposal, run, evA };
}

const keysOf = (o: object) => Object.keys(o).sort();
const HIDDEN_KEYS = ['disclosure', 'id', 'label', 'questions', 'stakeholderType'];

describe('GET /stakeholders', () => {
  it('serves own stakeholders (hidden ones as id, label, type, disclosure and question count only) and competitor stakeholders under their company', async () => {
    const s = await setup();
    const r = await s.call('GET', s.w('/stakeholders'));
    expect(r.status).toBe(200);
    expect(r.body.enabled).toBe(true);
    const [ops, cfo] = r.body.own; // by slug: stk-billing-…, stk-chief-…
    expect(cfo).toEqual({ id: s.cfo.id, label: 'Chief financial officer', stakeholderType: 'leader', disclosure: 'hidden', questions: 4 });
    expect(keysOf(cfo)).toEqual(HIDDEN_KEYS);
    expect(ops).toMatchObject({
      id: s.opsTeam.id, label: 'Billing platform team', stakeholderType: 'team', disclosure: 'open', subjectKind: 'own', relation: 'OPS-relation',
      version: 1, status: 'verified', statements: 0, questions: 0,
    });
    expect(ops.profile.decision_criteria).toMatchObject({ value: 'OPS-decision_criteria', confidence: 0.6, evidence: [s.evA] });
    expect(keysOf(ops)).toEqual([...HIDDEN_KEYS, 'profile', 'relation', 'statements', 'status', 'subjectKind', 'version'].sort());
    expect(r.body.competitors).toEqual([
      { competitorId: 'cmp_rival', name: 'Rival Pay', stakeholders: [expect.objectContaining({ id: s.rivalCeo.id, disclosure: 'open', subjectKind: 'competitor', relation: 'RIVAL-relation' })] },
    ]);
  });

  it('statements is the number of statements about the stakeholder; enabled follows config.stakeholders.enabled', async () => {
    const s = await setup();
    await s.call('POST', `/api/workspaces/ws_a/stakeholders/${s.opsTeam.id}/notes`, { text: 'They ship on Tuesdays only.' });
    await s.call('POST', `/api/workspaces/ws_a/stakeholders/${s.opsTeam.id}/notes`, { text: 'They want two weeks of notice.' });
    const r = await s.call('GET', s.w('/stakeholders'));
    expect(r.body.own.find((v: any) => v.id === s.opsTeam.id).statements).toBe(2);
    expect(JSON.stringify(r.body)).not.toContain('Tuesdays');
    s.config.stakeholders = { enabled: false };
    expect((await s.call('GET', s.w('/stakeholders'))).body.enabled).toBe(false);
    // Final review item 4: switched off, a hidden stakeholder is still listed and can still be opened.
    expect((await s.call('GET', s.w('/stakeholders'))).body.own.find((v: any) => v.id === s.cfo.id)).toMatchObject({ disclosure: 'hidden' });
    expect((await s.call('POST', `/api/workspaces/ws_a/stakeholders/${s.cfo.id}/reveal`)).body).toMatchObject({ id: s.cfo.id, disclosure: 'open' });
  });

  it('an open stakeholder carries the user\'s include override once set (the "Use for reads and learning" box)', async () => {
    const s = await setup();
    expect((await s.call('POST', `/api/personas/${s.rivalCeo.id}/include`, { include: true })).status).toBe(200);
    const r = await s.call('GET', s.w('/stakeholders'));
    expect(r.body.competitors[0].stakeholders[0].includeOverride).toBe(true);
    expect(r.body.own.find((v: any) => v.id === s.opsTeam.id)).not.toHaveProperty('includeOverride');
  });

  it('an unknown node answers 404; another tree serves only its own stakeholders', async () => {
    const s = await setup();
    expect((await s.call('GET', s.w('/stakeholders', 'ws_nope'))).status).toBe(404);
    const b = await s.call('GET', s.w('/stakeholders', 'ws_b'));
    expect(b.body.own.map((v: any) => v.id)).toEqual([s.betaCfo.id]);
    expect(b.body.competitors).toEqual([]);
  });
});

describe('the question round', () => {
  it('GET /stakeholder-questions groups the open questions by stakeholder (id, label, type), node-wide questions last', async () => {
    const s = await setup();
    const r = await s.call('GET', s.w('/stakeholder-questions'));
    expect(r.status).toBe(200);
    expect(r.body.groups).toHaveLength(2);
    expect(r.body.groups[0].persona).toEqual({ id: s.cfo.id, label: 'Chief financial officer', stakeholderType: 'leader' });
    expect(r.body.groups[0].questions.map((q: any) => q.field)).toEqual(['decision_criteria', 'dependencies', 'known_positions', 'objections']);
    expect(r.body.groups[1].persona).toBeUndefined();
    expect(r.body.groups[1].questions).toHaveLength(2);
  });

  it('POST answers: statements stored, the stakeholder opens, the configured actor (not the body) on the stakeholder_answers event', async () => {
    const s = await setup();
    const groups = (await s.call('GET', s.w('/stakeholder-questions'))).body.groups;
    const q = groups[0].questions[0];
    const r = await s.call('POST', '/api/workspaces/ws_a/stakeholder-questions/answers', { answers: [{ questionId: q.id, text: 'Payback inside a year.' }], actor: 'mallory' });
    expect(r.status).toBe(200);
    expect(r.body.opened).toEqual([s.cfo.id]);
    expect(r.body.statements).toEqual([expect.objectContaining({ personaId: s.cfo.id, source: 'question_answer', text: 'Payback inside a year.', actor: ACTOR })]);
    expect(listFeedback(s.store, { kind: 'stakeholder_answers' })).toEqual([expect.objectContaining({ actor: ACTOR, targetId: 'ws_a' })]);
    expect(s.store.personas.get(s.cfo.id)!.disclosure).toBe('open');
  });

  it('POST answers: skipAll opens every stakeholder of the round; a question of another tree answers 404; a bad body 400; a second answer 409', async () => {
    const s = await setup();
    const betaQ = stakeholderRepos(s.store).questions.list({ workspaceId: 'ws_b' })[0]!;
    expect((await s.call('POST', '/api/workspaces/ws_a/stakeholder-questions/answers', { answers: [{ questionId: betaQ.id, text: 'x' }] })).status).toBe(404);
    expect((await s.call('POST', '/api/workspaces/ws_a/stakeholder-questions/answers', { answers: 'no' })).status).toBe(400);
    expect((await s.call('POST', '/api/workspaces/ws_a/stakeholder-questions/answers', { skip: [s.betaCfo.id] })).status).toBe(404);
    const q = stakeholderRepos(s.store).questions.list({ personaId: s.cfo.id })[0]!;
    const r = await s.call('POST', '/api/workspaces/ws_a/stakeholder-questions/answers', { skipAll: true });
    expect(r.body).toEqual({ opened: [s.cfo.id], statements: [] });
    expect((await s.call('POST', '/api/workspaces/ws_a/stakeholder-questions/answers', { answers: [{ questionId: q.id, text: 'late' }] })).status).toBe(409);
    expect(s.store.personas.get(s.betaCfo.id)!.disclosure).toBe('hidden');
  });

  it('POST reveal opens the stakeholder, records stakeholder_reveal with the configured actor and serves the open view; another tree 404', async () => {
    const s = await setup();
    expect((await s.call('POST', `/api/workspaces/ws_a/stakeholders/${s.betaCfo.id}/reveal`, {})).status).toBe(404);
    const r = await s.call('POST', `/api/workspaces/ws_a/stakeholders/${s.cfo.id}/reveal`, { actor: 'mallory' });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ id: s.cfo.id, disclosure: 'open', relation: `${MARK}-relation`, questions: 0 });
    expect(listFeedback(s.store, { kind: 'stakeholder_reveal' })).toEqual([expect.objectContaining({ actor: ACTOR, targetId: s.cfo.id })]);
  });
});

describe('notes and statements', () => {
  it('POST notes on a hidden stakeholder stores a statement (configured actor) and reveals nothing; GET statements serves the user\'s own words, newest first', async () => {
    const s = await setup();
    vi.useFakeTimers({ toFake: ['Date'] });
    const first = await s.call('POST', `/api/workspaces/ws_a/stakeholders/${s.cfo.id}/notes`, { text: 'She hates surprises.', actor: 'mallory' });
    expect(first.status).toBe(201);
    expect(first.body).toMatchObject({ personaId: s.cfo.id, source: 'note', text: 'She hates surprises.', actor: ACTOR });
    expect(first.text).not.toContain(MARK);
    vi.setSystemTime(new Date(Date.now() + 60_000));
    const second = await s.call('POST', `/api/workspaces/ws_a/stakeholders/${s.cfo.id}/notes`, { text: 'Budget talks happen in March.', field: 'constraints' });
    expect(second.body.field).toBe('constraints');
    expect(listFeedback(s.store, { kind: 'stakeholder_note' }).map((e) => e.actor)).toEqual([ACTOR, ACTOR]);
    expect(s.store.personas.get(s.cfo.id)!.disclosure).toBe('hidden');

    const r = await s.call('GET', s.w(`/stakeholders/${s.cfo.id}/statements`));
    expect(r.status).toBe(200);
    expect(r.body.statements.map((x: any) => x.text)).toEqual(['Budget talks happen in March.', 'She hates surprises.']);
  });

  it('a bad field or an empty text answers 400; a stakeholder of another tree, or unknown, 404 on notes and statements', async () => {
    const s = await setup();
    expect((await s.call('POST', `/api/workspaces/ws_a/stakeholders/${s.cfo.id}/notes`, { text: 'x', field: 'goals' })).status).toBe(400);
    expect((await s.call('POST', `/api/workspaces/ws_a/stakeholders/${s.cfo.id}/notes`, { text: '   ' })).status).toBe(400);
    expect((await s.call('POST', `/api/workspaces/ws_a/stakeholders/${s.cfo.id}/notes`, {})).status).toBe(400);
    for (const id of [s.betaCfo.id, 'per_nope', s.smb.id]) {
      expect((await s.call('POST', `/api/workspaces/ws_a/stakeholders/${id}/notes`, { text: 'hello there' })).status).toBe(404);
      expect((await s.call('GET', s.w(`/stakeholders/${id}/statements`))).status).toBe(404);
    }
    expect(stakeholderRepos(s.store).statements.list()).toEqual([]);
  });
});

describe('recorded decisions, reads and reactions', () => {
  it('POST stakeholder-decisions stores a decision_record statement with the configured actor; a hidden stakeholder answers 409', async () => {
    const s = await setup();
    const r = await s.call('POST', '/api/workspaces/ws_a/recommendations/rec_1/stakeholder-decisions', {
      personaId: s.opsTeam.id, decision: 'approved', reasoning: 'They found the capacity.', actor: 'mallory',
    });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ source: 'decision_record', recommendationId: 'rec_1', decision: 'approved', actor: ACTOR, text: 'They found the capacity.' });
    expect(listFeedback(s.store, { kind: 'stakeholder_decision_record' })).toEqual([expect.objectContaining({ actor: ACTOR })]);
    expect(
      (await s.call('POST', '/api/workspaces/ws_a/recommendations/rec_1/stakeholder-decisions', { personaId: s.cfo.id, decision: 'rejected', reasoning: 'No.' })).status,
    ).toBe(409);
    expect((await s.call('POST', '/api/workspaces/ws_a/recommendations/rec_1/stakeholder-decisions', { personaId: s.opsTeam.id, decision: 'maybe', reasoning: 'x' })).status).toBe(400);
  });

  it('Review Focus 4: a decision for a recommendation the stakeholder never read is stored as a statement and gives no reaction signal', async () => {
    const s = await setup();
    const r = await s.call('POST', '/api/workspaces/ws_a/recommendations/rec_2/stakeholder-decisions', { personaId: s.opsTeam.id, decision: 'rejected', reasoning: 'No capacity this quarter.' });
    expect(r.status).toBe(201);
    expect(stakeholderRepos(s.store).statements.get(r.body.id)).toMatchObject({ source: 'decision_record', recommendationId: 'rec_2' });
    expect(collectPersonaSignals(s.store, s.opsTeam.id).filter((x) => x.itemKey === 'rec:rec_2')).toEqual([]);
    // Against a read it did make (rec_1, read `approve`), the same decision gives a disagreeing decision signal.
    await s.call('POST', '/api/workspaces/ws_a/recommendations/rec_1/stakeholder-decisions', { personaId: s.opsTeam.id, decision: 'rejected', reasoning: 'Not now.' });
    expect(collectPersonaSignals(s.store, s.opsTeam.id).filter((x) => x.itemKey === 'rec:rec_1')).toEqual([
      expect.objectContaining({ topic: 'decision', polarity: 'disagree' }),
    ]);
  });

  it('GET stakeholder-reads serves the reads of open stakeholders (own first) with label and type, never a hidden one\'s', async () => {
    const s = await setup();
    const r = await s.call('GET', s.w('/recommendations/rec_1/stakeholder-reads'));
    expect(r.status).toBe(200);
    expect(r.body.reads.map((x: any) => [x.id, x.label, x.stakeholderType, x.subjectKind, x.simulated])).toEqual([
      [s.reads.ops.id, 'Billing platform team', 'team', 'own', true],
      [s.reads.rival.id, 'Chief executive', 'leader', 'competitor', true],
    ]);
    expect(r.text).not.toContain(MARK);
  });

  it('POST reaction records stakeholder_read_reaction with the configured actor; a hidden stakeholder\'s read, or another tree\'s, answers 404', async () => {
    const s = await setup();
    const r = await s.call('POST', `/api/workspaces/ws_a/stakeholder-reads/${s.reads.ops.id}/reaction`, { reaction: 'disagree', reason: 'They never approve in Q4.', actor: 'mallory' });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ kind: 'stakeholder_read_reaction', actor: ACTOR, targetId: s.reads.ops.id, reason: 'They never approve in Q4.' });
    expect((await s.call('POST', `/api/workspaces/ws_a/stakeholder-reads/${s.reads.cfo.id}/reaction`, { reaction: 'agree' })).status).toBe(404);
    expect((await s.call('POST', `/api/workspaces/ws_a/stakeholder-reads/${s.reads.beta.id}/reaction`, { reaction: 'agree' })).status).toBe(404);
    expect((await s.call('POST', `/api/workspaces/ws_a/stakeholder-reads/${s.reads.ops.id}/reaction`, { reaction: 'meh' })).status).toBe(400);
    expect(listFeedback(s.store, { kind: 'stakeholder_read_reaction' })).toHaveLength(1);
    const reads = (await s.call('GET', s.w('/recommendations/rec_1/stakeholder-reads'))).body.reads;
    expect(reads.map((x: any) => [x.id, x.reaction, x.reactionReason])).toEqual([
      [s.reads.ops.id, 'disagree', 'They never approve in Q4.'],
      [s.reads.rival.id, undefined, undefined],
    ]);
  });

  it('a recommendation of another tree, or unknown, answers 404 on reads and decisions', async () => {
    const s = await setup();
    for (const rec of ['rec_b', 'rec_nope']) {
      expect((await s.call('GET', s.w(`/recommendations/${rec}/stakeholder-reads`))).status).toBe(404);
      expect((await s.call('POST', `/api/workspaces/ws_a/recommendations/${rec}/stakeholder-decisions`, { personaId: s.opsTeam.id, decision: 'approved', reasoning: 'ok' })).status).toBe(404);
    }
    expect((await s.call('GET', s.w('/recommendations/rec_b/stakeholder-reads', 'ws_b'))).body.reads.map((x: any) => x.id)).toEqual([]); // beta cfo is hidden
  });
});

describe('persona learning routes serve open stakeholders, never hidden ones (Review Focus 5)', () => {
  it('GET persona-learning lists segment personas and open stakeholders of the node; the tree-wide pending count leaves hidden personas out', async () => {
    const s = await setup();
    s.proposal(s.opsTeam, 'OPS');
    const r = await s.call('GET', s.w('/persona-learning'));
    expect(r.status).toBe(200);
    expect(r.body.personas.map((p: any) => p.personaId).sort()).toEqual([s.opsTeam.id, s.rivalCeo.id, s.smb.id].sort());
    expect(r.body.personas.find((p: any) => p.personaId === s.opsTeam.id)).toMatchObject({ kind: 'stakeholder', segment: 'Billing platform team' });
    expect(r.body.pendingInTree).toBe(1);
    expect(r.text).not.toContain(MARK);
  });

  it('signals, accept, reject and retire answer 404 for a hidden stakeholder and change nothing', async () => {
    const s = await setup();
    const reject = s.proposal(s.cfo, MARK);
    expect((await s.call('GET', s.w(`/personas/${s.cfo.id}/signals`))).status).toBe(404);
    expect((await s.call('POST', `/api/workspaces/ws_a/persona-proposals/${s.hidden.proposal.id}/accept`, {})).status).toBe(404);
    expect((await s.call('POST', `/api/workspaces/ws_a/persona-proposals/${reject.id}/reject`, {})).status).toBe(404);
    expect((await s.call('POST', `/api/workspaces/ws_a/persona-adjustments/${s.hidden.adjustment.id}/retire`, {})).status).toBe(404);
    const lr = personaLearningRepos(s.store);
    expect(lr.proposals.get(s.hidden.proposal.id)!.status).toBe('pending');
    expect(lr.proposals.get(reject.id)!.status).toBe('pending');
    expect(lr.adjustments.get(s.hidden.adjustment.id)!.status).toBe('active');
    expect(listFeedback(s.store, {}).filter((e) => e.kind.startsWith('persona_'))).toEqual([]);
  });

  it('the three feedback kinds of persona learning are not affected: accept, reject and retire work on an open stakeholder (and still on a segment persona)', async () => {
    const s = await setup();
    const a = s.proposal(s.opsTeam, 'OPS');
    const b = s.proposal(s.opsTeam, 'OPS2');
    const adj = s.adjustment(s.opsTeam, 'OPS3');
    expect((await s.call('GET', s.w(`/personas/${s.opsTeam.id}/signals`))).status).toBe(200);
    expect((await s.call('POST', `/api/workspaces/ws_a/persona-proposals/${a.id}/accept`, { actor: 'mallory' })).status).toBe(200);
    expect((await s.call('POST', `/api/workspaces/ws_a/persona-proposals/${b.id}/reject`, { reason: 'not like them' })).status).toBe(200);
    expect((await s.call('POST', `/api/workspaces/ws_a/persona-adjustments/${adj.id}/retire`, {})).status).toBe(200);
    const segment = s.proposal(s.smb, 'SMB');
    expect((await s.call('POST', `/api/workspaces/ws_a/persona-proposals/${segment.id}/reject`, {})).status).toBe(200);
    const kinds = listFeedback(s.store, {}).filter((e) => e.kind.startsWith('persona_'));
    expect(kinds.map((e) => [e.kind, e.actor])).toEqual([
      ['persona_learning_accept', ACTOR], ['persona_learning_reject', ACTOR], ['persona_adjustment_retire', ACTOR], ['persona_learning_reject', ACTOR],
    ]);
  });

  it('GET personas (the segment list) never lists a stakeholder', async () => {
    const s = await setup();
    const r = await s.call('GET', s.w('/personas'));
    expect(r.body.map((p: any) => p.id)).toEqual([s.smb.id]);
  });
});

describe('the leak test: nothing about a hidden stakeholder but its id, label, type and question count is served', () => {
  type S = Awaited<ReturnType<typeof setup>>;
  /** Every marker string the fixture seeded (the search routes are queried with each). */
  const MARKERS = [
    ...STAKEHOLDER_FIELDS.map((f) => `${MARK}-${f}`), `${MARK}-relation`, `${MARK}-adjustment`, `${MARK}-proposal`, `${MARK}-assumption`, `${MARK}-reasoning`,
    `${MARK}-summary`, `${MARK}-review-issue`, `${MARK}-review-quote`, `${MARK}-model-text`, `${MARK}-tool-error`, `${MARK}-audit-issue`,
  ];

  /** The app's routes of `method` (no wildcard, no SSE stream). */
  const routesOf = (s: S, method: string) =>
    [...new Set((s.app as unknown as { routes: Array<{ method: string; path: string }> }).routes.filter((r) => r.method === method).map((r) => r.path))]
      .filter((p) => p.startsWith('/api/') && p !== '/api/events' && !p.includes('*'))
      .sort();

  /** Fills each route parameter by the resource it names, with the hidden stakeholder's and the withheld research's ids. */
  function filler(s: S): (path: string) => string {
    const cfo = s.store.personas.get(s.cfo.id)!;
    const byName: Record<string, string> = {
      personaId: cfo.id, recId: 'rec_1', readId: s.reads.cfo.id, proposalId: s.hidden.proposal.id, adjustmentId: s.hidden.adjustment.id,
      entityId: cfo.entityId!, itemId: cfo.id, artifactId: s.evA, hash: 'pv0001',
    };
    const byPrefix: Array<[string, string]> = [
      ['/api/workspaces/:id', 'ws_a'], ['/api/runs/:id', s.workerRun.id], ['/api/artifacts/:id', s.evA], ['/api/personas/:id', cfo.id],
      ['/api/recommendations/:id', 'rec_1'], ['/api/experiments/:id', 'exp_1'], ['/api/requests/:id', 'ureq_own'],
    ];
    return (path) => {
      const prefix = byPrefix.find(([p]) => path === p || path.startsWith(`${p}/`));
      const head = prefix ? prefix[1] : cfo.id;
      // Any other parameter gets the hidden persona's id: a route that resolves it must not serve it.
      return path.replace(/:id\b/, head).replace(/:(\w+)/g, (_, name: string) => byName[name] ?? cfo.id);
    };
  }

  function getUrls(s: S): string[] {
    const fill = filler(s);
    const cfo = s.store.personas.get(s.cfo.id)!;
    const k = '/api/workspaces/ws_a/knowledge';
    const variants = [
      '/api/workspaces/ws_a/export?includeUploads=1', '/api/workspaces/ws_a/export/summary?includeUploads=1', '/api/workspaces/ws_a/findings?scope=tree',
      `/api/runs/${s.reviewerRun.id}`, `/api/runs/${s.reviewerRun.id}/events`, '/api/workspaces/ws_a/tasks?runId=rrun_1',
      `/api/workspaces/ws_a/bus-events?agentRunId=${s.workerRun.id}`, `/api/workspaces/ws_a/bus-events?taskId=${s.ownTask.id}`,
      '/api/workspaces/ws_a/decisions?kind=review', '/api/workspaces/ws_a/decisions?kind=score', '/api/costs?workspaceId=ws_a',
      `${k}/search?q=Chief`, `${k}/search?q=Chief&include_unverified=true&scope=tree`, `${k}/entities?scope=tree`,
      `${k}/entities/${cfo.entityId}?scope=tree`, `${k}/items/${cfo.id}?scope=tree`, `${k}/node?scope=tree`, `${k}/changes?scope=tree`,
      `${k}/items/${cfo.entityId}`, `${k}/items/${s.review.id}`, `${k}/items/${s.ownTask.id}`,
    ];
    return [...routesOf(s, 'GET').map(fill), ...variants];
  }

  /** The GET responses, with the URLs whose body holds a marker or the agent.md path. */
  async function sweep(s: S): Promise<{ leaks: string[]; errors: string[]; status: Map<string, number> }> {
    const leaks: string[] = [];
    const errors: string[] = [];
    const status = new Map<string, number>();
    for (const url of getUrls(s)) {
      const r = await s.call('GET', url);
      status.set(url, r.status);
      if (r.status >= 500) errors.push(`${url} ${r.status} ${r.text.slice(0, 200)}`);
      if (r.text.includes(MARK)) leaks.push(url);
      if (r.text.includes(s.cfo.agentMdPath)) leaks.push(`${url} (agent.md path)`);
    }
    return { leaks, errors, status };
  }

  it('the sweep covers every GET under /api/workspaces/:id/ and reaches the top-level resources (200, not 404)', async () => {
    const s = await setup();
    const routes = routesOf(s, 'GET');
    const underWorkspace = routes.filter((p) => p.startsWith('/api/workspaces/:id/'));
    expect(underWorkspace).toEqual(
      expect.arrayContaining([
        '/api/workspaces/:id/stakeholders', '/api/workspaces/:id/stakeholder-questions', '/api/workspaces/:id/stakeholders/:personaId/statements',
        '/api/workspaces/:id/recommendations/:recId/stakeholder-reads', '/api/workspaces/:id/personas', '/api/workspaces/:id/persona-learning',
        '/api/workspaces/:id/personas/:personaId/signals', '/api/workspaces/:id/recommendations', '/api/workspaces/:id/decisions',
        '/api/workspaces/:id/tasks', '/api/workspaces/:id/agent-runs', '/api/workspaces/:id/bus-events', '/api/workspaces/:id/audits',
      ]),
    );
    expect(underWorkspace.length).toBeGreaterThan(30);
    const urls = getUrls(s);
    for (const r of routes) expect(urls).toContain(filler(s)(r));
    const { status } = await sweep(s);
    const fill = filler(s);
    for (const route of [
      '/api/runs/:id', '/api/runs/:id/events', '/api/prompts/:hash', '/api/artifacts/:id/meta', '/api/workspaces/:id/stakeholders/:personaId/statements',
      '/api/workspaces/:id/recommendations/:recId/stakeholder-reads', '/api/workspaces/:id/knowledge/items/:itemId', '/api/workspaces/:id/knowledge/entities/:entityId',
      '/api/workspaces/:id/tasks', '/api/workspaces/:id/decisions', '/api/workspaces/:id/agent-runs', '/api/workspaces/:id/bus-events', '/api/workspaces/:id/audits',
      '/api/workspaces/:id/audit-misses', '/api/workspaces/:id/review-queue', '/api/workspaces/:id/export', '/api/experiments/:id',
      '/api/workspaces/:id/experiments', '/api/workspaces/:id/requests',
    ]) {
      expect(status.get(fill(route)), route).toBe(200);
    }
  });

  it('while hidden, no GET response holds what research found, its raw activity or its evidence refs; afterwards it is served again', async () => {
    const s = await setup();
    const { leaks, errors } = await sweep(s);
    expect(errors).toEqual([]);
    expect(leaks).toEqual([]);
    // Search with every marker as the query finds nothing (the search echoes its query, so hits are checked).
    for (const q of MARKERS) {
      const r = await s.call('GET', `/api/workspaces/ws_a/knowledge/search?q=${encodeURIComponent(q)}&scope=tree&include_unverified=true&include_history=true`);
      expect(r.body.hits, q).toEqual([]);
    }

    // The decision log: the save Decision keeps label, type and confidences, refs only the persona; the review is withheld.
    const decisions = (await s.call('GET', s.w('/decisions'))).body as any[];
    const saved = decisions.find((d) => d.payload?.tool === 'save_stakeholder' && d.payload.personaId === s.cfo.id);
    expect(Object.values(saved.payload.confidence).every((x) => typeof x === 'number')).toBe(true);
    expect(saved.refs).toEqual([s.cfo.id]);
    expect(decisions.find((d) => d.id === s.review.id)).toMatchObject({ kind: 'review', payload: { tool: 'submit_review', withheld: true }, refs: [] });
    // Run events, task detail, run detail: withheld, status 200.
    expect((await s.call('GET', `/api/runs/${s.workerRun.id}/events`)).body).toMatchObject({ events: [], withheld: true });
    const task = (await s.call('GET', s.w('/tasks'))).body.find((x: any) => x.id === s.ownTask.id);
    expect(task).toMatchObject({ id: s.ownTask.id, type: 'own_stakeholders', status: 'verified', withheld: true });
    expect(task.result).toBeUndefined();
    expect(task.reviewIssues).toBeUndefined();
    expect((await s.call('GET', `/api/runs/${s.workerRun.id}`)).body.run).toMatchObject({ id: s.workerRun.id, withheld: true });
    expect((await s.call('GET', s.w('/requests'))).body.find((r: any) => r.id === 'ureq_own')).toMatchObject({ details: '', status: 'pending', withheld: true });

    // Answer its questions: it opens, and everything is served again.
    const groups = (await s.call('GET', s.w('/stakeholder-questions'))).body.groups;
    const answers = groups[0].questions.map((q: any) => ({ questionId: q.id, text: `Answer to ${q.field}` }));
    expect((await s.call('POST', '/api/workspaces/ws_a/stakeholder-questions/answers', { answers })).status).toBe(200);
    const list = (await s.call('GET', s.w('/stakeholders'))).text;
    for (const f of STAKEHOLDER_FIELDS) expect(list).toContain(`${MARK}-${f}`);
    expect(list).toContain(`${MARK}-relation`);
    const learning = (await s.call('GET', s.w('/persona-learning'))).text;
    for (const m of ['adjustment', 'proposal', 'assumption']) expect(learning).toContain(`${MARK}-${m}`);
    expect((await s.call('GET', s.w('/recommendations/rec_1/stakeholder-reads'))).text).toContain(`${MARK}-reasoning`);
    expect((await s.call('GET', `/api/runs/${s.workerRun.id}/events`)).text).toContain(`${MARK}-model-text`);
    expect((await s.call('GET', s.w('/tasks'))).text).toContain(`${MARK}-summary`);
    expect((await s.call('GET', s.w('/decisions'))).text).toContain(`${MARK}-review-quote`);
    expect((await s.call('GET', s.w('/audits'))).text).toContain(`${MARK}-audit-issue`);
    expect((await s.call('GET', '/api/experiments/exp_1')).text).toContain(`${MARK}-arm-failure`);
    expect((await s.call('GET', s.w('/requests'))).text).toContain(`${MARK}-request-details`);
  });

  it('routes that change data and return a record never return a hidden stakeholder\'s research', async () => {
    const s = await setup();
    const cfo = s.store.personas.get(s.cfo.id)!;
    const ops = s.store.personas.get(s.opsTeam.id)!;
    const k = '/api/workspaces/ws_a/knowledge';
    const calls: Array<[string, string, unknown, number?]> = [
      ['POST', `/api/personas/${cfo.id}/include`, { include: true }, 404],
      ['POST', '/api/ratings', { workspaceId: 'ws_a', targetType: 'persona', targetId: cfo.id, criterion: 'goals', verdict: 'agree' }, 400],
      ['POST', '/api/ratings', { workspaceId: 'ws_a', targetType: 'decision', targetId: s.review.id, criterion: 'score', verdict: 'agree' }, 400],
      ['POST', `${k}/entities/${cfo.entityId}/rename`, { name: 'Chief financial officer (finance)' }],
      ['POST', `${k}/entities/merge`, { survivorId: cfo.entityId, loserId: ops.entityId }],
      ['POST', `/api/workspaces/ws_a/stakeholders/${cfo.id}/notes`, { text: 'She hates surprises.' }, 201],
      ['POST', `/api/workspaces/ws_a/persona-proposals/${s.hidden.proposal.id}/accept`, {}, 404],
      ['POST', `/api/workspaces/ws_a/persona-proposals/${s.hidden.proposal.id}/reject`, {}, 404],
      ['POST', `/api/workspaces/ws_a/persona-adjustments/${s.hidden.adjustment.id}/retire`, {}, 404],
      ['POST', `/api/workspaces/ws_a/stakeholder-reads/${s.reads.cfo.id}/reaction`, { reaction: 'agree' }, 404],
      ['POST', `/api/workspaces/ws_a/recommendations/rec_1/stakeholder-decisions`, { personaId: cfo.id, decision: 'approved', reasoning: 'ok' }, 409],
    ];
    for (const [method, url, body, expected] of calls) {
      const r = await s.call(method, url, body);
      expect(r.status, url).toBeLessThan(500);
      if (expected !== undefined) expect(r.status, url).toBe(expected);
      expect(r.text, url).not.toContain(MARK);
    }
    // Every other route that changes data and takes a persona, entity, proposal, adjustment or read id, filled with the hidden ones.
    const fill = filler(s);
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      // `reveal` is left out: it opens the stakeholder, after which its research is served by design.
      const routes = routesOf(s, method).filter((p) => (/:(personaId|entityId|proposalId|adjustmentId|readId|itemId)\b/.test(p) || p === '/api/personas/:id/include') && !p.endsWith('/reveal'));
      for (const route of routes) {
        const r = await s.call(method, fill(route), {});
        expect(r.status, route).toBeLessThan(500);
        expect(r.text, route).not.toContain(MARK);
      }
    }
  });

  it('the event stream drops a withheld run\'s events and serves its Decisions withheld', async () => {
    const s = await setup();
    const ctrl = new AbortController();
    const res = await s.app.request('/api/events?workspaceId=ws_a', { signal: ctrl.signal });
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let text = '';
    const readUntil = async (needle: string) => {
      while (!text.includes(needle)) {
        const { value, done } = await reader.read();
        if (done) break;
        text += dec.decode(value);
      }
    };
    await readUntil('connected');
    s.events.emit({ type: 'run_event', workspaceId: 'ws_a', agentRunId: s.workerRun.id, event: { t: 'message', text: `${MARK}-live-text` } });
    s.events.emit({ type: 'decision', workspaceId: 'ws_a', decision: s.review });
    s.events.emit({ type: 'tool_call', workspaceId: 'ws_a', agentRunId: s.workerRun.id, tool: 'save_stakeholder', ok: false, error: `${MARK}-live-error` });
    s.events.emit({ type: 'run_event', workspaceId: 'ws_a', agentRunId: 'arun_other', event: { t: 'message', text: 'SENTINEL' } });
    await readUntil('SENTINEL');
    ctrl.abort();
    await reader.cancel().catch(() => undefined);
    expect(text).not.toContain(MARK);
    expect(text).toContain(`"id":"${s.review.id}"`);
    expect(text).toContain('"withheld":true');
  });
});

describe('own-stakeholder research is withheld from its first run (final review item 1)', () => {
  /** ws_c: a running own_stakeholders task whose worker run has not saved anything yet (no stakeholder, hidden or not). */
  async function live() {
    const dir = mkdtempSync(join(tmpdir(), 'bif-stk-live-'));
    const t = researchSetup(opened, { dir, extraHandlers: () => stakeholderToolHandlers({ dataDir: dir }) });
    t.store.workspaces.insert({ id: 'ws_c', name: 'Cargo', sector: 'logistics', createdAt: T0 });
    t.store.researchRuns.insert({ id: 'rrun_live', workspaceId: 'ws_c', phase: 'stakeholders', status: 'running', startedAt: T0 });
    const model = { provider: 'claude' as const, model: 'sonnet' };
    const task = t.store.tasks.insert({
      id: 'tsk_live', workspaceId: 'ws_c', runId: 'rrun_live', phase: 'stakeholders', type: 'own_stakeholders', brief: 'Who matters to Cargo', model,
      needsBrowser: false, acceptanceCriteria: ['evidence'], status: 'running', round: 1, createdAt: T0,
    });
    const run = t.store.agentRuns.insert({
      id: 'arun_live', workspaceId: 'ws_c', taskId: task.id, role: 'worker', model, token: 'tok_live', status: 'running', startedAt: T0, promptVersion: 'pv0001',
      taskType: 'own_stakeholders',
    });
    const runDir = runDirOf(dir, 'ws_c', run.id);
    mkdirSync(runDir, { recursive: true });
    writeFileSync(
      join(runDir, 'events.jsonl'),
      [
        { t: 'message', text: `${MARK}-live-model-text: the CFO signs off on budgets` },
        { t: 'tool_call', name: 'save_stakeholder', input: { label: 'Chief financial officer', relation: `${MARK}-live-relation` } },
      ].map((e) => JSON.stringify(e)).join('\n') + '\n',
    );
    const logged = t.store.decisions.insert({
      id: newId('dec'), workspaceId: 'ws_c', agentRunId: run.id, role: 'worker', model, kind: 'decision',
      payload: { tool: 'log_decision', what: `${MARK}-live-decision` }, refs: [], promptVersion: 'pv0001', createdAt: at(),
    });
    const app = createApp({ store: t.store, artifacts: t.artifacts, events: t.events, config: t.config, research: t.deps });
    const get = async (path: string) => {
      const res = await app.request(path);
      return { status: res.status, text: await res.text() };
    };
    return { ...t, app, get, task, run, logged };
  }

  it('REST: before any save, the run\'s events, the task and its Decisions are served only in the withheld form', async () => {
    const s = await live();
    expect(stakeholderPersonasOf(s.store, 'ws_c')).toEqual([]);
    const events = await s.get(`/api/runs/${s.run.id}/events`);
    expect(JSON.parse(events.text)).toMatchObject({ events: [], withheld: true });
    const tasks = JSON.parse((await s.get('/api/workspaces/ws_c/tasks')).text) as any[];
    expect(tasks.find((x) => x.id === s.task.id)).toMatchObject({ withheld: true });
    const decisions = JSON.parse((await s.get('/api/workspaces/ws_c/decisions')).text) as any[];
    expect(decisions.find((d) => d.id === s.logged.id)).toMatchObject({ payload: { tool: 'log_decision', withheld: true }, refs: [] });
    for (const path of [`/api/runs/${s.run.id}/events`, `/api/runs/${s.run.id}`, '/api/workspaces/ws_c/tasks', '/api/workspaces/ws_c/decisions', '/api/workspaces/ws_c/agent-runs']) {
      expect((await s.get(path)).text, path).not.toContain(MARK);
    }
    // Finished with nothing saved: nothing hidden is left, so it is served again.
    s.store.tasks.update(s.task.id, { status: 'verified' });
    s.store.agentRuns.update(s.run.id, { status: 'done', endedAt: T0 });
    expect((await s.get(`/api/runs/${s.run.id}/events`)).text).toContain(`${MARK}-live-model-text`);
  });

  it('SSE: before any save, the run\'s live events are dropped and its Decisions served withheld', async () => {
    const s = await live();
    const ctrl = new AbortController();
    const res = await s.app.request('/api/events?workspaceId=ws_c', { signal: ctrl.signal });
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let text = '';
    const readUntil = async (needle: string) => {
      while (!text.includes(needle)) {
        const { value, done } = await reader.read();
        if (done) break;
        text += dec.decode(value);
      }
    };
    await readUntil('connected');
    s.events.emit({ type: 'run_event', workspaceId: 'ws_c', agentRunId: s.run.id, event: { t: 'message', text: `${MARK}-live-text` } });
    s.events.emit({ type: 'run_event', workspaceId: 'ws_c', agentRunId: s.run.id, event: { t: 'tool_call', name: 'save_stakeholder', input: { relation: `${MARK}-live-input` } } as never });
    s.events.emit({ type: 'tool_call', workspaceId: 'ws_c', agentRunId: s.run.id, tool: 'save_stakeholder', ok: false, error: `${MARK}-live-error` });
    s.events.emit({ type: 'decision', workspaceId: 'ws_c', decision: s.logged });
    s.events.emit({ type: 'run_event', workspaceId: 'ws_c', agentRunId: 'arun_other', event: { t: 'message', text: 'SENTINEL' } });
    await readUntil('SENTINEL');
    ctrl.abort();
    await reader.cancel().catch(() => undefined);
    expect(text).not.toContain(MARK);
    expect(text).toContain(`"id":"${s.logged.id}"`);
    expect(text).toContain('"withheld":true');
  });
});
