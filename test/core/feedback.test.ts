import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import {
  answerUserRequest,
  applyPromptPatchAsUser,
  correctHypothesis,
  decideUnitProposal,
  editProfile,
  rolePromptVersion,
  setIncludeOverride,
} from '../../src/core/feedback/actions.js';
import { actorOf as calibrationActorOf } from '../../src/core/scoring/calibrationHistory.js';
import { recordSystemDecision } from '../../src/core/systemDecision.js';
import { usageRepos } from '../../src/core/store/usageRepos.js';
import { actorOf, latestFeedback, listFeedback, onFeedback, recordFeedback } from '../../src/core/feedback/events.js';
import { targetProvenance } from '../../src/core/feedback/provenance.js';
import { feedbackRatings, signalDelta } from '../../src/core/feedback/signals.js';
import { sendInterviewMessage } from '../../src/core/interview/interview.js';
import { uploadInternal } from '../../src/core/internal/uploads.js';
import { calibrationReport, calibrationScope, proposePromptPatch } from '../../src/core/scoring/calibration.js';
import { exportTrainingData } from '../../src/core/scoring/export.js';
import { rateCriterion } from '../../src/core/scoring/ratings.js';
import { reviewQueue } from '../../src/core/scoring/reviewQueue.js';
import { MIGRATIONS } from '../../src/core/store/migrations.js';
import { openStore, type Store } from '../../src/core/store/db.js';
import { newId } from '../../src/core/store/repos.js';
import type { Decision, Finding, SymptomHypothesis, UnitProposal, UserRequest } from '../../src/core/types.js';
import { researchSetup } from './helpers/research.js';

const opened: Store[] = [];
afterEach(() => {
  for (const s of opened.splice(0)) s.close();
});

const T0 = '2026-11-13T10:00:00.000Z';
const T1 = '2026-11-13T11:00:00.000Z';
const T2 = '2026-11-13T12:00:00.000Z';

function setup() {
  const t = researchSetup(opened);
  t.store.workspaces.insert({ id: 'ws_a', name: 'Acme', sector: 'saas', createdAt: T0 });
  t.store.agentRuns.insert({
    id: 'arun_w', workspaceId: 'ws_a', taskId: 'tsk_1', role: 'worker', model: { provider: 'claude', model: 'sonnet' },
    token: 'tok_w', status: 'done', startedAt: T0, promptVersion: 'pv_w1',
  });
  t.store.tasks.insert({
    id: 'tsk_1', workspaceId: 'ws_a', runId: 'rrun_1', phase: 'deep_dives', type: 'news_scan', brief: 'b', model: { provider: 'claude', model: 'sonnet' },
    needsBrowser: false, acceptanceCriteria: [], status: 'verified', round: 1, createdAt: T0,
  });
  return t;
}

const decision = (over: Partial<Decision>): Decision => ({
  id: 'dec_x', workspaceId: 'ws_a', agentRunId: 'arun_w', role: 'worker', model: { provider: 'claude', model: 'sonnet' },
  kind: 'decision', payload: {}, refs: [], promptVersion: 'pv_w1', createdAt: T0, ...over,
});

function addFinding(t: ReturnType<typeof setup>, over: Partial<Finding> = {}, runId = 'arun_w'): Finding {
  const f: Finding = {
    id: 'fnd_1', workspaceId: 'ws_a', runId: 'rrun_1', taskId: 'tsk_1', subject: 'Acme', claim: 'Acme raised prices',
    criteria: { relevance: 4, reliability: 3 }, evidence: [], status: 'verified', createdAt: T0, ...over,
  };
  t.store.findings.insert(f);
  t.store.decisions.insert(decision({ id: `dec_${f.id}`, agentRunId: runId, payload: { tool: 'save_finding', findingId: f.id, criteria: f.criteria }, refs: [f.id] }));
  return f;
}

function addHypothesis(t: ReturnType<typeof setup>, over: Partial<SymptomHypothesis> = {}): SymptomHypothesis {
  t.store.symptoms.insert({ id: 'sym_1', workspaceId: 'ws_a', kind: 'symptom', title: 'Churn up', detail: 'd', criteria: { severity: 4 }, evidence: [] });
  const h: SymptomHypothesis = {
    id: 'hyp_1', workspaceId: 'ws_a', symptomId: 'sym_1', hypothesis: 'Price rise drives churn', confidence: 60, evidence: [],
    taskId: 'tsk_1', createdAt: T0, status: 'unverified', ...over,
  };
  t.store.symptomHypotheses.insert(h);
  t.store.decisions.insert(decision({
    id: 'dec_hyp', kind: 'score', payload: { tool: 'save_hypothesis', hypothesisId: h.id, symptomId: 'sym_1', hypothesis: h.hypothesis, confidence: h.confidence },
    refs: [h.id, 'sym_1'],
  }));
  return h;
}

function addProposal(t: ReturnType<typeof setup>): UnitProposal {
  t.store.decisions.insert(decision({ id: 'dec_unit', payload: { tool: 'propose_business_unit', proposalId: 'unit_1', name: 'Platform' } }));
  return t.store.unitProposals.insert({
    id: 'unit_1', workspaceId: 'ws_a', name: 'Platform', description: 'Dev platform', level: 'slice', audiences: ['internal'],
    evidence: [], reasoning: 'org chart', status: 'proposed', decisionId: 'dec_unit', createdAt: T0,
  });
}

const exportRows = (t: ReturnType<typeof setup>, includeUploads = false) =>
  exportTrainingData('ws_a', t, includeUploads).trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, any>);

describe('migration 14', () => {
  it('upgrades a v13 database: existing human rows get the default actor, nothing is lost', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bif-m14-'));
    const path = join(dir, 'bif.db');
    const raw = new DatabaseSync(path);
    for (const [i, m] of MIGRATIONS.slice(0, 13).entries()) {
      raw.exec(m);
      raw.exec(`PRAGMA user_version = ${i + 1}`);
    }
    raw.exec(`INSERT INTO ratings (id, workspace_id, target_type, target_id, criterion, agent_value, verdict, created_at)
      VALUES ('rat_old', 'ws_a', 'finding', 'fnd_1', 'relevance', 4, 'agree', '${T0}')`);
    raw.close();
    const store = openStore(path);
    opened.push(store);
    expect(store.schemaVersion()).toBe(MIGRATIONS.length);
    expect(store.ratings.get('rat_old')).toMatchObject({ actor: 'local-user', verdict: 'agree' });
    expect(store.ratings.get('rat_old')!.agentRunId).toBeUndefined();
  });

  it('feedback_events is append-only', () => {
    const t = setup();
    const e = recordFeedback(t.store, { workspaceId: 'ws_a', kind: 'profile_edit', targetType: 'profile', targetId: 'ws_a', afterJson: { a: 1 } });
    expect(() => t.store.db.prepare('UPDATE feedback_events SET reason = ? WHERE id = ?').run('x', e.id)).toThrow(/append-only/);
    expect(() => t.store.db.prepare('DELETE FROM feedback_events WHERE id = ?').run(e.id)).toThrow(/append-only/);
    expect(listFeedback(t.store, { workspaceId: 'ws_a' })).toHaveLength(1);
  });
});

describe('feedback events API', () => {
  it('records, lists, filters, resolves provenance and notifies listeners', () => {
    const t = setup();
    addFinding(t);
    const seen: string[] = [];
    const off = onFeedback((_s, e) => seen.push(e.kind));
    const e = recordFeedback(t.store, {
      workspaceId: 'ws_a', actor: 'ana', kind: 'include_override', targetType: 'finding', targetId: 'fnd_1',
      beforeJson: { include: null, status: 'verified' }, afterJson: { include: false }, reason: '  stale  ',
    });
    off();
    recordFeedback(t.store, { workspaceId: 'ws_a', kind: 'profile_edit', targetType: 'profile', targetId: 'ws_a' });
    expect(seen).toEqual(['include_override']);
    expect(e).toMatchObject({ actor: 'ana', reason: 'stale', agentRunId: 'arun_w', promptVersion: 'pv_w1' });
    expect(listFeedback(t.store, { workspaceId: 'ws_a', kind: 'include_override' })).toEqual([e]);
    expect(latestFeedback(t.store, { workspaceId: 'ws_a' })).toMatchObject({ kind: 'profile_edit', actor: 'local-user' });
    expect(latestFeedback(t.store, { workspaceId: 'ws_a' })!.agentRunId).toBeUndefined();
    expect(() => recordFeedback(t.store, { workspaceId: 'ws_a', kind: 'nope' as never, targetType: 'profile', targetId: 'x' })).toThrow(/unknown/);
  });

  it('actorOf takes config.user.id, default local-user', () => {
    expect(actorOf({})).toBe('local-user');
    expect(actorOf({ user: { id: 'ana@acme' } })).toBe('ana@acme');
  });
});

describe('rating provenance', () => {
  it('stores actor, agent run and prompt version of the rated judgment (latest at rating time)', () => {
    const t = setup();
    addFinding(t);
    const r1 = rateCriterion({ workspaceId: 'ws_a', targetType: 'finding', targetId: 'fnd_1', criterion: 'relevance', verdict: 'agree', actor: 'ana' }, t);
    expect(r1).toMatchObject({ actor: 'ana', agentRunId: 'arun_w', promptVersion: 'pv_w1' });
    expect(t.store.ratings.get(r1.id)).toMatchObject({ actor: 'ana', agentRunId: 'arun_w', promptVersion: 'pv_w1' });

    // A revision by another run with a new prompt version: later ratings point at it.
    t.store.agentRuns.insert({
      id: 'arun_w2', workspaceId: 'ws_a', taskId: 'tsk_1', role: 'worker', model: { provider: 'claude', model: 'sonnet' },
      token: 'tok_w2', status: 'done', startedAt: T1, promptVersion: 'pv_w2',
    });
    t.store.decisions.insert(decision({ id: 'dec_rev', agentRunId: 'arun_w2', promptVersion: 'pv_w2', createdAt: new Date().toISOString(), payload: { tool: 'save_finding', findingId: 'fnd_1', revision: true } }));
    const r2 = rateCriterion({ workspaceId: 'ws_a', targetType: 'finding', targetId: 'fnd_1', criterion: 'relevance', verdict: 'agree' }, t);
    expect(r2).toMatchObject({ actor: 'local-user', agentRunId: 'arun_w2', promptVersion: 'pv_w2' });
  });

  it('resolves decision targets, persona feedback and outputs without a judging decision', () => {
    const t = setup();
    t.store.decisions.insert(decision({ id: 'dec_log', payload: { tool: 'log_decision', what: 'w', confidence: 0.5 } }));
    expect(targetProvenance(t.store, 'ws_a', 'decision', 'dec_log')).toEqual({ decisionId: 'dec_log', agentRunId: 'arun_w', promptVersion: 'pv_w1' });
    t.store.decisions.insert(decision({ id: 'dec_pf', kind: 'persona_feedback', payload: { personaId: 'per_1', input: { recommendation_id: 'rec_1' } } }));
    expect(targetProvenance(t.store, 'ws_a', 'persona_feedback', 'rec_1:per_1').decisionId).toBe('dec_pf');
    t.store.competitors.insert({
      id: 'cmp_1', workspaceId: 'ws_a', name: 'Globex', threat: 3, directness: 3, comparison: { pricing: 3, onboarding: 3, ux: 3, features: 3 },
      evidence: [], taskId: 'tsk_1', createdAt: T0, updatedAt: T0,
    });
    expect(targetProvenance(t.store, 'ws_a', 'competitor', 'cmp_1')).toEqual({ agentRunId: 'arun_w', promptVersion: 'pv_w1' });
    // System decisions have no agent run.
    t.store.decisions.insert(decision({ id: 'dec_sys', agentRunId: 'user', promptVersion: 'n/a' }));
    expect(targetProvenance(t.store, 'ws_a', 'decision', 'dec_sys')).toEqual({ decisionId: 'dec_sys' });
    // A user decision at a real prompt version (prompt patch approval) still has no agent run.
    t.store.decisions.insert(decision({ id: 'dec_patch', agentRunId: 'ana', promptVersion: 'abcd1234', payload: { actor: 'user', actorId: 'ana' } }));
    expect(targetProvenance(t.store, 'ws_a', 'decision', 'dec_patch')).toEqual({ decisionId: 'dec_patch', promptVersion: 'abcd1234' });
    // Other workspaces' decisions are not resolved.
    expect(targetProvenance(t.store, 'ws_b', 'decision', 'dec_log')).toEqual({});
  });
});

describe('review queue re-queue after an agent revision', () => {
  it('a rated finding returns to the queue when the agent revises it after the rating', () => {
    const t = setup();
    addFinding(t);
    for (const criterion of ['relevance', 'reliability']) {
      rateCriterion({ workspaceId: 'ws_a', targetType: 'finding', targetId: 'fnd_1', criterion, verdict: 'agree' }, t);
    }
    expect(reviewQueue('ws_a', t).find((i) => i.targetId === 'fnd_1')).toBeUndefined();
    // A reuse record is not a revision.
    t.store.decisions.insert(decision({ id: 'dec_reuse', createdAt: '2999-01-01T00:00:00.000Z', payload: { tool: 'save_finding', findingId: 'fnd_1', reused: true } }));
    expect(reviewQueue('ws_a', t).find((i) => i.targetId === 'fnd_1')).toBeUndefined();
    t.store.decisions.insert(decision({ id: 'dec_rev', createdAt: '2999-01-01T00:00:00.000Z', payload: { tool: 'save_finding', findingId: 'fnd_1', revision: true } }));
    expect(reviewQueue('ws_a', t).find((i) => i.targetId === 'fnd_1')?.unrated).toEqual(['relevance', 'reliability']);
  });
});

describe('include overrides', () => {
  it('records before/after, skips no-ops, and feeds calibration (exclude = disagree, include unverified = agree)', () => {
    const t = setup();
    addFinding(t);
    addFinding(t, { id: 'fnd_2', status: 'unverified', claim: 'Unverified claim' });
    setIncludeOverride(t.store, 'finding', 'fnd_1', false, { actor: 'ana', reason: 'outdated' });
    setIncludeOverride(t.store, 'finding', 'fnd_1', false, { actor: 'ana' }); // unchanged: no event
    setIncludeOverride(t.store, 'finding', 'fnd_2', true);
    expect(t.store.findings.get('fnd_1')!.includeInSynthesis).toBe(false);
    const events = listFeedback(t.store, { workspaceId: 'ws_a', kind: 'include_override' });
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      actor: 'ana', targetType: 'finding', targetId: 'fnd_1', reason: 'outdated', agentRunId: 'arun_w', promptVersion: 'pv_w1',
      beforeJson: { include: null, status: 'verified' }, afterJson: { include: false },
    });

    const signals = feedbackRatings(t.store, 'ws_a');
    expect(signals.map((r) => [r.targetId, r.criterion, r.verdict, r.agentValue, r.userValue])).toEqual([
      ['fnd_1', 'include', 'disagree', 'verified', 'excluded'],
      ['fnd_2', 'include', 'agree', 'unverified', undefined],
    ]);
    const row = calibrationReport('ws_a', t).byCriterion.find((r) => r.criterion === 'include');
    expect(row).toEqual({ targetType: 'finding', criterion: 'include', n: 2, agreeRate: 0.5, meanDelta: -0.5 });
    const worker = calibrationReport('ws_a', t).byRoleTask.find((r) => r.criterion === 'include');
    expect(worker).toMatchObject({ role: 'worker', taskType: 'news_scan' });
    expect(proposePromptPatch('ws_a', 'worker', t).patchText).toContain('`include`: you said "verified"; the user says "excluded". Reason: outdated');

    // Reset withdraws the signal.
    setIncludeOverride(t.store, 'finding', 'fnd_1', null);
    expect(feedbackRatings(t.store, 'ws_a').map((r) => r.targetId)).toEqual(['fnd_2']);
  });

  it('hypothesis overrides target the save_hypothesis decision', () => {
    const t = setup();
    addHypothesis(t);
    const h = setIncludeOverride(t.store, 'hypothesis', 'hyp_1', false) as SymptomHypothesis;
    expect(h.includeOverride).toBe(false);
    expect(feedbackRatings(t.store, 'ws_a')).toMatchObject([{ targetType: 'decision', targetId: 'dec_hyp', criterion: 'include', verdict: 'disagree' }]);
    expect(() => setIncludeOverride(t.store, 'hypothesis', 'hyp_nope', true)).toThrow(/not found/);
  });
});

describe('signal scales', () => {
  it('rejections and exclusions are the largest disagreement; edits half; agrees zero', () => {
    expect(signalDelta({ criterion: 'unit_proposal', verdict: 'disagree', agentValue: 'proposed', userValue: 'rejected' })).toBe(-1);
    expect(signalDelta({ criterion: 'unit_proposal', verdict: 'disagree', agentValue: 'proposed', userValue: 'edited' })).toBe(-0.5);
    expect(signalDelta({ criterion: 'unit_proposal', verdict: 'agree', agentValue: 'proposed' })).toBe(0);
    expect(signalDelta({ criterion: 'include', verdict: 'disagree', agentValue: 'verified', userValue: 'excluded' })).toBe(-1);
    expect(signalDelta({ criterion: 'relevance', verdict: 'disagree', agentValue: 4, userValue: 2 })).toBeUndefined();
  });

  it('a unit proposal rejection ranks first in the prompt patch top-N', () => {
    const t = setup();
    addFinding(t);
    addProposal(t);
    rateCriterion({ workspaceId: 'ws_a', targetType: 'finding', targetId: 'fnd_1', criterion: 'relevance', verdict: 'disagree', userValue: 3 }, t);
    decideUnitProposal(t.store, 'unit_1', { action: 'reject', reason: 'no such team' });
    const patch = proposePromptPatch('ws_a', 'worker', t);
    expect(patch.examples.map((e) => e.criterion)).toEqual(['unit_proposal', 'relevance']);
    expect(patch.sources).toEqual([{ targetType: 'decision', targetId: 'dec_unit' }, { targetType: 'finding', targetId: 'fnd_1' }]);
    expect(calibrationReport('ws_a', t).byCriterion.find((r) => r.criterion === 'unit_proposal')).toMatchObject({ n: 1, meanDelta: -1 });
  });
});

describe('unit proposal decisions', () => {
  it('accept-with-edit keeps the original, records a correction rating with the diff and a proposal_edit event', () => {
    const t = setup();
    addProposal(t);
    const out = decideUnitProposal(t.store, 'unit_1', { action: 'accept', edits: { name: 'Dev Platform' }, reason: 'real name' }, { actor: 'ana' });
    expect(out.workspace).toMatchObject({ name: 'Dev Platform', parentWorkspaceId: 'ws_a' });
    expect(out.proposal).toMatchObject({
      status: 'accepted', name: 'Dev Platform', actor: 'ana', decisionReason: 'real name',
      originalPayload: { name: 'Platform', description: 'Dev platform', level: 'slice', audiences: ['internal'], evidence: [], reasoning: 'org chart' },
    });
    expect(out.proposal.decidedAt).toBeTruthy();
    expect(out.rating).toMatchObject({
      targetType: 'decision', targetId: 'dec_unit', criterion: 'unit_proposal', agentValue: 'proposed', verdict: 'disagree', userValue: 'edited',
      actor: 'ana', agentRunId: 'arun_w', promptVersion: 'pv_w1', reason: 'real name (edited: name: "Platform" → "Dev Platform")',
    });
    expect(out.feedback).toMatchObject({
      kind: 'proposal_edit', actor: 'ana', targetType: 'unit_proposal', targetId: 'unit_1', reason: 'real name', agentRunId: 'arun_w',
      beforeJson: { name: 'Platform' }, afterJson: { status: 'accepted', name: 'Dev Platform', childWorkspaceId: out.workspace!.id },
    });
    expect(() => decideUnitProposal(t.store, 'unit_1', { action: 'reject' })).toThrow(/already accepted/);
  });

  it('plain accept is an agree; reject keeps decidedAt / actor / reason', () => {
    const t = setup();
    addProposal(t);
    const a = decideUnitProposal(t.store, 'unit_1', { action: 'accept', edits: { name: 'Platform' } });
    expect(a.feedback.kind).toBe('proposal_accept');
    expect(a.rating).toMatchObject({ verdict: 'agree', criterion: 'unit_proposal' });
    expect(a.proposal.originalPayload).toBeUndefined();

    t.store.unitProposals.insert({ ...t.store.unitProposals.get('unit_1')!, id: 'unit_2', status: 'proposed', childWorkspaceId: undefined });
    const r = decideUnitProposal(t.store, 'unit_2', { action: 'reject', reason: 'duplicate' }, { actor: 'ana' });
    expect(r.proposal).toMatchObject({ status: 'rejected', actor: 'ana', decisionReason: 'duplicate' });
    expect(r.rating).toMatchObject({ verdict: 'disagree', userValue: 'rejected', actor: 'ana', agentRunId: 'arun_w' });
    expect(r.feedback).toMatchObject({ kind: 'proposal_reject', reason: 'duplicate' });
  });
});

describe('user request answers', () => {
  it('stores resolvedAt / actor and a request_answer event linked to the requesting run', () => {
    const t = setup();
    const req: UserRequest = {
      id: 'ureq_1', workspaceId: 'ws_a', agentRunId: 'arun_w', taskId: 'tsk_1', kind: 'approval', site: 'vendor.com',
      details: 'Request a demo?', status: 'pending', createdAt: T0,
    };
    t.store.userRequests.insert(req);
    const out = answerUserRequest(t, 'ureq_1', 'denied', 'no demos', { actor: 'ana' });
    expect(out).toMatchObject({ status: 'denied', response: 'no demos', actor: 'ana' });
    expect(out.resolvedAt).toBeTruthy();
    expect(latestFeedback(t.store, { kind: 'request_answer' })).toMatchObject({
      actor: 'ana', targetId: 'ureq_1', agentRunId: 'arun_w', promptVersion: 'pv_w1',
      beforeJson: { status: 'pending', details: 'Request a demo?' }, afterJson: { status: 'denied', response: 'no demos' },
    });
    expect(() => answerUserRequest(t, 'ureq_1', 'resolved', undefined)).toThrow(/already denied/);
  });
});

describe('hypothesis corrections and profile edits', () => {
  it('a user correction updates the hypothesis and records the before/after', () => {
    const t = setup();
    addHypothesis(t);
    const h = correctHypothesis(t.store, 'hyp_1', { confidence: 20, hypothesis: 'Onboarding drives churn' }, { actor: 'ana', reason: 'support tickets' });
    expect(h).toMatchObject({ confidence: 20, hypothesis: 'Onboarding drives churn' });
    expect(latestFeedback(t.store, { kind: 'hypothesis_correction' })).toMatchObject({
      actor: 'ana', targetId: 'hyp_1', reason: 'support tickets', agentRunId: 'arun_w',
      beforeJson: { symptomId: 'sym_1', confidence: 60, hypothesis: 'Price rise drives churn' },
      afterJson: { confidence: 20, hypothesis: 'Onboarding drives churn' },
    });
    expect(() => correctHypothesis(t.store, 'hyp_1', { confidence: 20 })).toThrow(/nothing to correct/);
    expect(() => correctHypothesis(t.store, 'hyp_1', { confidence: 120 })).toThrow(/0–100/);
    expect(() => correctHypothesis(t.store, 'hyp_1', { hypothesis: '  ' })).toThrow(/empty/);
  });

  it('profile edits record changed keys only and never touch uploads', () => {
    const t = setup();
    t.store.profiles.insert({ workspaceId: 'ws_a', data: { basics: 'b2b saas', uploads: ['art_x'], pricing: 'per seat' } });
    editProfile(t.store, 'ws_a', { pricing: 'usage based', basics: 'b2b saas' }, { reason: 'changed in 2026' });
    expect(t.store.profiles.get('ws_a')!.data).toEqual({ basics: 'b2b saas', uploads: ['art_x'], pricing: 'usage based' });
    expect(latestFeedback(t.store, { kind: 'profile_edit' })).toMatchObject({
      targetType: 'profile', targetId: 'ws_a', beforeJson: { pricing: 'per seat' }, afterJson: { pricing: 'usage based' }, reason: 'changed in 2026',
    });
    expect(() => editProfile(t.store, 'ws_a', { uploads: [] })).toThrow(/managed by the app/);
    expect(() => editProfile(t.store, 'ws_a', { basics: 'b2b saas' })).toThrow(/does not change/);
  });
});

describe('prompt patch apply', () => {
  it('logs the real actor and the patched role new prompt version', () => {
    const t = setup();
    const scope = calibrationScope(t.store, t.config.dataDir, 'ws_a');
    const before = rolePromptVersion(t.config, 'worker', scope);
    const out = applyPromptPatchAsUser(t, 'ws_a', { role: 'worker', patchText: '## Calibration\n\n1. be precise\n', examples: [] }, { actor: 'ana' });
    expect(out.previousPromptVersion).toBe(before);
    expect(out.promptVersion).toBe(rolePromptVersion(t.config, 'worker', scope));
    expect(out.promptVersion).not.toBe(before);
    const d = t.store.decisions.get(out.decisionId)!;
    expect(d).toMatchObject({ agentRunId: 'ana', promptVersion: out.promptVersion, payload: { actor: 'user', actorId: 'ana', tool: 'apply_prompt_patch', previousPromptVersion: before } });
    expect(out.feedback).toMatchObject({
      kind: 'prompt_patch_apply', actor: 'ana', targetType: 'prompt', targetId: 'worker', promptVersion: out.promptVersion,
      beforeJson: { promptVersion: before, appendix: '' }, afterJson: { promptVersion: out.promptVersion, decisionId: d.id },
    });
    for (const role of ['orchestrator', 'reviewer', 'interviewer', 'persona', 'synthesizer'] as const) {
      expect(rolePromptVersion(t.config, role, scope)).toMatch(/^[0-9a-f]{8}$/);
    }
  });

  it('is the versioned apply too: one calibration_versions row linked to the decision and the feedback event', () => {
    const t = setup();
    const out = applyPromptPatchAsUser(t, 'ws_a', { role: 'reviewer', patchText: '## Calibration\n\n1. be strict\n', examples: [] }, { actor: 'ana' });
    const versions = usageRepos(t.store).calibrationVersions.list({ rootWorkspaceId: 'ws_a', role: 'reviewer' });
    expect(versions.map((v) => v.source)).toEqual(['import', 'apply']);
    expect(versions[1]).toMatchObject({ id: out.versionId, actor: 'ana', decisionId: out.decisionId });
    expect(out.feedback.afterJson).toMatchObject({ versionId: out.versionId, decisionId: out.decisionId });
    expect(listFeedback(t.store, { kind: 'prompt_patch_apply' })).toHaveLength(1);
  });

  it('one actorOf: the calibration history module re-exports the feedback one', () => {
    expect(calibrationActorOf).toBe(actorOf);
  });

  it('a user system decision without an actor id falls back to the default actor, never the `user` pseudo run id', () => {
    const t = setup();
    const d = recordSystemDecision(t, { workspaceId: 'ws_a', actor: 'user', payload: { tool: 'x' } });
    expect(d.agentRunId).toBe('local-user');
    expect(d.payload).toMatchObject({ actor: 'user', actorId: 'local-user' });
    expect(recordSystemDecision(t, { workspaceId: 'ws_a', actor: 'scheduler', payload: {} }).agentRunId).toBe('scheduler');
  });
});

describe('interview turns', () => {
  it('both turns are linked to the interviewer run', async () => {
    const t = setup();
    const agent = await sendInterviewMessage('ws_a', 'We sell CRM software', { ...t, supervisor: t.supervisor, fake: async () => 'What do you charge?' });
    const turns = t.store.interview.list({ workspaceId: 'ws_a' });
    expect(turns.map((x) => x.role)).toEqual(['user', 'agent']);
    expect(agent.agentRunId).toBeTruthy();
    expect(turns.map((x) => x.agentRunId)).toEqual([agent.agentRunId, agent.agentRunId]);
    expect(t.store.agentRuns.get(agent.agentRunId!)!.role).toBe('interviewer');
  });
});

describe('export', () => {
  it('adds request answers, interview turns, feedback events and final review status', () => {
    const t = setup();
    addFinding(t);
    t.store.userRequests.insert({ id: 'ureq_1', workspaceId: 'ws_a', agentRunId: 'arun_w', taskId: 'tsk_1', kind: 'approval', details: 'demo?', status: 'pending', createdAt: T0 });
    t.store.userRequests.insert({ id: 'ureq_2', workspaceId: 'ws_a', agentRunId: 'arun_w', kind: 'other', details: 'still waiting', status: 'pending', createdAt: T0 });
    answerUserRequest(t, 'ureq_1', 'resolved', 'ok');
    t.store.interview.insert({ id: 'itv_1', workspaceId: 'ws_a', role: 'user', text: 'hello', createdAt: T1, agentRunId: 'arun_i' });
    t.store.interview.insert({ id: 'itv_2', workspaceId: 'ws_a', role: 'agent', text: 'hi', createdAt: T2, agentRunId: 'arun_i' });
    setIncludeOverride(t.store, 'finding', 'fnd_1', false);
    const rows = exportRows(t);
    expect(rows.map((r) => r.type)).toEqual(['decision', 'request_answer', 'interview_turn', 'interview_turn', 'feedback_event', 'feedback_event']);
    expect(rows[0]).toMatchObject({ decision: { id: 'dec_fnd_1' }, finalReviewStatus: 'verified' });
    expect(rows[1]!.request).toMatchObject({ id: 'ureq_1', status: 'resolved', response: 'ok' });
    expect(rows[2]!.turn).toMatchObject({ id: 'itv_1', agentRunId: 'arun_i' });
    expect(rows.slice(4).map((r) => r.feedbackEvent.kind)).toEqual(['request_answer', 'include_override']);
    expect(rows[5]).toMatchObject({ finalReviewStatus: 'verified' });
  });

  it('upload provenance excludes upload-derived requests, turns and feedback events unless opted in', () => {
    const t = setup();
    const up = uploadInternal('ws_a', { name: 'kpis.csv', bytes: new TextEncoder().encode('churn,12'), mime: 'text/csv' }, t);
    // A finding resting on the upload, and a clean one.
    addFinding(t, { id: 'fnd_up', evidence: [up.id] });
    t.store.agentRuns.insert({ ...t.store.agentRuns.get('arun_w')!, id: 'arun_w2', token: 'tok_w2', taskId: 'tsk_2' });
    addFinding(t, { id: 'fnd_ok', taskId: 'tsk_2' }, 'arun_w2');
    setIncludeOverride(t.store, 'finding', 'fnd_up', false);
    setIncludeOverride(t.store, 'finding', 'fnd_ok', false);
    // A request of a task whose finding rests on the upload.
    t.store.userRequests.insert({ id: 'ureq_up', workspaceId: 'ws_a', agentRunId: 'arun_w', taskId: 'tsk_1', kind: 'other', details: 'q', status: 'pending', createdAt: T0 });
    answerUserRequest(t, 'ureq_up', 'resolved', 'a');
    // Interview: a user turn before the upload; an agent turn after it; a user turn citing it.
    t.store.interview.insert({ id: 'itv_before', workspaceId: 'ws_a', role: 'agent', text: 'hello', createdAt: '2000-01-01T00:00:00.000Z' });
    t.store.interview.insert({ id: 'itv_after', workspaceId: 'ws_a', role: 'agent', text: 'churn is 12', createdAt: '2999-01-01T00:00:00.000Z' });
    t.store.interview.insert({ id: 'itv_user', workspaceId: 'ws_a', role: 'user', text: 'see my upload', createdAt: '2999-01-01T00:00:00.000Z' });
    t.store.interview.insert({ id: 'itv_cite', workspaceId: 'ws_a', role: 'user', text: `see ${up.id}`, createdAt: '2999-01-01T00:00:00.000Z' });

    const kept = exportRows(t);
    const keys = (rows: Array<Record<string, any>>) =>
      rows.map((r) => r.decision?.id ?? r.request?.id ?? r.turn?.id ?? `${r.feedbackEvent.kind}:${r.feedbackEvent.targetId}`);
    expect(keys(kept)).toEqual(['dec_fnd_ok', 'itv_before', 'itv_user', 'include_override:fnd_ok']);
    expect(keys(exportRows(t, true))).toEqual([
      'dec_fnd_up', 'dec_fnd_ok', 'ureq_up', 'itv_before', 'itv_after', 'itv_user', 'itv_cite',
      'include_override:fnd_up', 'include_override:fnd_ok', 'request_answer:ureq_up',
    ]);
  });

  it('an applied prompt patch built from upload-derived ratings is excluded', () => {
    const t = setup();
    const up = uploadInternal('ws_a', { name: 'kpis.csv', bytes: new TextEncoder().encode('x'), mime: 'text/csv' }, t);
    const f = addFinding(t, { id: newId('fnd'), evidence: [up.id] });
    rateCriterion({ workspaceId: 'ws_a', targetType: 'finding', targetId: f.id, criterion: 'relevance', verdict: 'disagree', userValue: 1 }, t);
    const p = proposePromptPatch('ws_a', 'worker', t);
    applyPromptPatchAsUser(t, 'ws_a', p);
    const kinds = exportRows(t).map((r) => r.decision?.payload?.tool ?? r.feedbackEvent?.kind);
    expect(kinds).not.toContain('apply_prompt_patch');
    expect(kinds).not.toContain('prompt_patch_apply');
    const all = exportRows(t, true).map((r) => r.decision?.payload?.tool ?? r.feedbackEvent?.kind);
    expect(all).toContain('apply_prompt_patch');
    expect(all).toContain('prompt_patch_apply');
  });
});
