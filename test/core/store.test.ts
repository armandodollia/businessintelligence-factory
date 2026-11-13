import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { openStore, type Store } from '../../src/core/store/db.js';
import { MIGRATIONS } from '../../src/core/store/migrations.js';
import { newId } from '../../src/core/store/repos.js';
import type {
  AgentRun,
  Artifact,
  Decision,
  Finding,
  InterviewTurn,
  Persona,
  Profile,
  Rating,
  Recommendation,
  ResearchRun,
  Schedule,
  Symptom,
  Task,
  UserRequest,
  Workspace,
} from '../../src/core/types.js';

const now = () => new Date().toISOString();
const opened: Store[] = [];

function tmpDb(): string {
  return join(mkdtempSync(join(tmpdir(), 'bif-store-')), 'nested', 'bif.db');
}

function open(path: string): Store {
  const s = openStore(path);
  opened.push(s);
  return s;
}

afterEach(() => {
  for (const s of opened.splice(0)) s.close();
});

function finding(workspaceId: string, extra: Partial<Finding> = {}): Finding {
  return {
    id: newId('fnd'),
    workspaceId,
    runId: 'run_1',
    taskId: 'tsk_1',
    subject: 'Acme',
    claim: 'Acme hides pricing behind a demo request',
    criteria: { impact: 7, confidence: 'high' },
    evidence: ['art_1', 'art_2'],
    status: 'pending',
    createdAt: now(),
    ...extra,
  };
}

describe('newId', () => {
  it('is prefixed, unique and time-sortable', () => {
    const a = newId('fnd');
    const b = newId('fnd');
    expect(a).toMatch(/^fnd_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(a).not.toBe(b);
    expect(a.slice(4, 14) <= b.slice(4, 14)).toBe(true);
  });
});

describe('store', () => {
  it('roundtrips a finding with JSON criteria', () => {
    const store = open(tmpDb());
    const f = finding('ws_1');
    store.findings.insert(f);
    expect(store.findings.get(f.id)).toEqual(f);
    const updated = store.findings.update(f.id, { status: 'verified', criteria: { impact: 9 } });
    expect(updated.status).toBe('verified');
    expect(store.findings.get(f.id)?.criteria).toEqual({ impact: 9 });
    expect(store.findings.get('missing')).toBeUndefined();
    expect(() => store.findings.update('missing', { status: 'verified' })).toThrow(/not found/);
  });

  it('list filters by workspaceId', () => {
    const store = open(tmpDb());
    store.findings.insert(finding('ws_a'));
    store.findings.insert(finding('ws_a', { status: 'verified' }));
    store.findings.insert(finding('ws_b'));
    expect(store.findings.list({ workspaceId: 'ws_a' })).toHaveLength(2);
    expect(store.findings.list({ workspaceId: 'ws_b' })).toHaveLength(1);
    expect(store.findings.list({ workspaceId: 'ws_a', status: 'verified' })).toHaveLength(1);
    expect(store.findings.list()).toHaveLength(3);
    // Non-scalar / unknown fields are rejected rather than interpolated into SQL.
    expect(() => store.findings.list({ nope: 1 } as never)).toThrow(/filter/);
  });

  it('migrations idempotent on reopen', () => {
    const path = tmpDb();
    const s1 = openStore(path);
    s1.workspaces.insert({ id: 'ws_1', name: 'Acme', sector: 'saas', createdAt: now() });
    expect(s1.schemaVersion()).toBe(MIGRATIONS.length);
    s1.close();
    const s2 = open(path);
    expect(s2.schemaVersion()).toBe(MIGRATIONS.length);
    expect(s2.workspaces.list()).toHaveLength(1);
    const s3 = open(path);
    expect(s3.schemaVersion()).toBe(MIGRATIONS.length);
  });

  it('pending user request survives reopen', () => {
    const path = tmpDb();
    const s1 = openStore(path);
    const req: UserRequest = {
      id: newId('ureq'),
      workspaceId: 'ws_1',
      agentRunId: 'arun_1',
      taskId: 'tsk_1',
      kind: 'register',
      site: 'competitor.example',
      details: 'Site requires phone verification',
      status: 'pending',
      createdAt: now(),
    };
    s1.userRequests.insert(req);
    s1.userRequests.insert({ ...req, id: newId('ureq'), status: 'resolved', response: 'done' });
    s1.close();
    const s2 = open(path);
    const pending = s2.userRequests.list({ status: 'pending' });
    expect(pending).toHaveLength(1);
    expect(pending[0]).toEqual(req);
  });

  it('transaction rolls back on throw', () => {
    const store = open(tmpDb());
    expect(() =>
      store.transaction(() => {
        store.findings.insert(finding('ws_tx'));
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(store.findings.list({ workspaceId: 'ws_tx' })).toHaveLength(0);
    store.transaction(() => store.findings.insert(finding('ws_tx')));
    expect(store.findings.list({ workspaceId: 'ws_tx' })).toHaveLength(1);
  });

  it('roundtrips every repository', () => {
    const store = open(tmpDb());
    const ws = 'ws_all';
    const model = { provider: 'claude' as const, model: 'opus' };
    const workspace: Workspace = { id: ws, name: 'Acme', sector: 'saas', createdAt: now() };
    const artifact: Artifact = {
      id: newId('art'), workspaceId: ws, kind: 'screenshot', path: 'data/x.png', sha256: 'ab'.repeat(32),
      mime: 'image/png', sourceUrl: 'https://x.test', title: 'Home', flow: 'signup', step: 2, note: 'n',
      capturedAt: now(),
    };
    const task: Task = {
      id: newId('tsk'), workspaceId: ws, runId: 'run_1', phase: 'deep_dives', type: 'flow_walkthrough',
      brief: 'Walk signup', subject: 'Acme', model, needsBrowser: true, acceptanceCriteria: ['a', 'b'],
      status: 'queued', round: 0, result: { ok: true }, createdAt: now(),
    };
    const researchRun: ResearchRun = { id: newId('run'), workspaceId: ws, phase: 'scoring', status: 'running', startedAt: now() };
    const agentRun: AgentRun = {
      id: newId('arun'), workspaceId: ws, taskId: task.id, role: 'worker', model, token: newId('tok'),
      status: 'done', exitCode: 0, startedAt: now(), endedAt: now(),
    };
    const decision: Decision = {
      id: newId('dec'), workspaceId: ws, agentRunId: agentRun.id, role: 'orchestrator', model, kind: 'task_proposal',
      payload: { tasks: [1, 2] }, refs: ['fnd_1'], promptVersion: 'v1', createdAt: now(),
    };
    const rating: Rating = {
      id: newId('rat'), workspaceId: ws, targetType: 'finding', targetId: 'fnd_1', criterion: 'impact',
      agentValue: 7, verdict: 'disagree', userValue: 'low', reason: 'meh', createdAt: now(),
    };
    const ratingNull: Rating = { ...rating, id: newId('rat'), agentValue: null, verdict: 'agree' };
    delete ratingNull.userValue;
    delete ratingNull.reason;
    const recommendation: Recommendation = {
      id: newId('rec'), workspaceId: ws, title: 'Publish pricing', summary: 's', criteria: { impact: 8 },
      findingIds: ['fnd_1'], priority: 1.5, createdAt: now(), taskId: 'tsk_1', status: 'verified', taskRound: 2,
      includeOverride: false,
      personaFeedback: [{
        personaId: 'per_1', scores: { appeal: 7, adoption: 6, willingnessToPay: 5, friction: 3 },
        concerns: ['c'], reasoning: 'r', wouldChangeMind: 'w', simulated: true,
      }],
    };
    const persona: Persona = {
      id: newId('per'), workspaceId: ws, slug: 'ops-olivia', segment: 'ops',
      profile: { role: { value: 'Ops lead', confidence: 0.8, evidence: ['art_1'] } },
      agentMdPath: 'data/ws/personas/ops-olivia.md', version: 1, status: 'unverified', taskId: 'tsk_2', taskRound: 1,
      includeOverride: true,
    };
    const symptom: Symptom = {
      id: newId('sym'), workspaceId: ws, kind: 'strength', title: 't', detail: 'd', criteria: { a: 1 }, evidence: ['art_1'],
    };
    const schedule: Schedule = {
      id: newId('sch'), workspaceId: ws, name: 'weekly', cron: '0 9 * * 1', phases: ['deep_dives'], enabled: false,
    };
    const turn: InterviewTurn = { id: newId('itv'), workspaceId: ws, role: 'agent', text: 'hi', createdAt: now() };
    const profile: Profile = { workspaceId: ws, data: { sector: 'saas', nested: { a: [1] } } };

    store.workspaces.insert(workspace);
    store.artifacts.insert(artifact);
    store.findings.insert(finding(ws));
    store.tasks.insert(task);
    store.researchRuns.insert(researchRun);
    store.agentRuns.insert(agentRun);
    store.decisions.insert(decision);
    store.ratings.insert(rating);
    store.ratings.insert(ratingNull);
    store.recommendations.insert(recommendation);
    store.personas.insert(persona);
    store.symptoms.insert(symptom);
    store.schedules.insert(schedule);
    store.interview.insert(turn);
    store.profiles.insert(profile);

    // Columns added in migration 6 come back with their DB defaults.
    expect(store.workspaces.get(ws)).toEqual({
      ...workspace,
      scope: { level: 'company', name: '', description: '' },
      audiences: ['external'],
    });
    expect(store.artifacts.get(artifact.id)).toEqual(artifact);
    expect(store.tasks.get(task.id)).toEqual(task);
    expect(store.researchRuns.get(researchRun.id)).toEqual(researchRun);
    expect(store.agentRuns.get(agentRun.id)).toEqual(agentRun);
    expect(store.decisions.get(decision.id)).toEqual(decision);
    expect(store.ratings.get(rating.id)).toEqual(rating);
    expect(store.ratings.get(ratingNull.id)).toEqual(ratingNull);
    expect(store.recommendations.get(recommendation.id)).toEqual(recommendation);
    expect(store.personas.get(persona.id)).toEqual({ ...persona, audience: 'external' });
    expect(store.symptoms.get(symptom.id)).toEqual(symptom);
    expect(store.schedules.get(schedule.id)).toEqual(schedule);
    expect(store.interview.get(turn.id)).toEqual(turn);
    expect(store.profiles.get(ws)).toEqual(profile);

    expect(store.tasks.list({ needsBrowser: true })).toHaveLength(1);
    expect(store.schedules.list({ enabled: false })).toHaveLength(1);
    expect(store.agentRuns.list({ token: agentRun.token })).toHaveLength(1);

    // update can clear optional fields
    const cleared = store.researchRuns.update(researchRun.id, { status: 'done', endedAt: now() });
    expect(cleared.status).toBe('done');
    expect(store.tasks.update(task.id, { subject: undefined }).subject).toBeUndefined();
    expect(store.profiles.update(ws, { data: { x: 1 } })).toEqual({ workspaceId: ws, data: { x: 1 } });
  });

  it('roundtrips JSON null (Decision.payload, Task.result) distinct from undefined', () => {
    const store = open(tmpDb());
    const ws = 'ws_null';
    const model = { provider: 'claude' as const, model: 'opus' };
    const decision: Decision = {
      id: newId('dec'), workspaceId: ws, agentRunId: 'arun_1', role: 'worker', model, kind: 'decision',
      payload: null, refs: [], promptVersion: 'v1', createdAt: now(),
    };
    store.decisions.insert(decision);
    const gotDecision = store.decisions.get(decision.id)!;
    expect(gotDecision.payload).toBeNull();
    expect('payload' in gotDecision).toBe(true);

    const task: Task = {
      id: newId('tsk'), workspaceId: ws, runId: 'run_1', phase: 'deep_dives', type: 'news_scan',
      brief: 'b', model, needsBrowser: false, acceptanceCriteria: [], status: 'queued', round: 0,
      result: null, createdAt: now(),
    };
    store.tasks.insert(task);
    const gotTask = store.tasks.get(task.id)!;
    expect(gotTask.result).toBeNull();
    expect('result' in gotTask).toBe(true);

    // undefined still clears (SQL NULL → omitted).
    const cleared = store.tasks.update(task.id, { result: undefined });
    expect('result' in cleared).toBe(false);
    expect(store.tasks.update(task.id, { result: null }).result).toBeNull();
  });

  it('migration 3 upgrades a v2 database: user_requests.task_id nullable, empty ids become NULL', () => {
    const path = tmpDb();
    openStore(path).close(); // create directories
    rmSync(path);
    const raw = new DatabaseSync(path);
    raw.exec('BEGIN');
    raw.exec(MIGRATIONS[0]!);
    raw.exec(MIGRATIONS[1]!);
    raw.exec('PRAGMA user_version = 2');
    raw.exec(`INSERT INTO user_requests (id, workspace_id, agent_run_id, task_id, kind, details, status, created_at)
      VALUES ('ureq_1', 'ws', 'arun_1', '', 'login', 'd', 'pending', 'now'),
             ('ureq_2', 'ws', 'arun_1', 'tsk_1', 'login', 'd', 'pending', 'now')`);
    raw.exec('COMMIT');
    raw.close();
    const store = open(path);
    expect(store.schemaVersion()).toBe(MIGRATIONS.length);
    expect('taskId' in store.userRequests.get('ureq_1')!).toBe(false);
    expect(store.userRequests.get('ureq_2')!.taskId).toBe('tsk_1');
    expect(store.userRequests.list({ status: 'pending' }).map((r) => r.id)).toEqual(['ureq_1', 'ureq_2']);
  });

  it('migration 11 backfills recommendation / persona task + status from their save decisions', () => {
    const path = tmpDb();
    openStore(path).close();
    rmSync(path);
    const raw = new DatabaseSync(path);
    raw.exec('BEGIN');
    for (const m of MIGRATIONS.slice(0, 10)) raw.exec(m);
    raw.exec('PRAGMA user_version = 10');
    raw.exec(`INSERT INTO tasks (id, workspace_id, run_id, phase, type, brief, model, needs_browser, acceptance_criteria, status, round, created_at)
      VALUES ('tsk_syn', 'ws', 'r', 'synthesis', 'synthesize_recommendations', 'b', '{}', 0, '[]', 'verified', 1, 'now'),
             ('tsk_per', 'ws', 'r', 'market_research', 'persona_profile', 'b', '{}', 0, '[]', 'unverified', 3, 'now')`);
    raw.exec(`INSERT INTO agent_runs (id, workspace_id, task_id, role, model, token, status, started_at)
      VALUES ('arun_s', 'ws', 'tsk_syn', 'synthesizer', '{}', 't1', 'done', 'now'),
             ('arun_p', 'ws', 'tsk_per', 'worker', '{}', 't2', 'done', 'now')`);
    raw.exec(`INSERT INTO decisions (id, workspace_id, agent_run_id, role, model, kind, payload, refs, prompt_version, created_at)
      VALUES ('dec_1', 'ws', 'arun_s', 'synthesizer', '{}', 'score', '{"tool":"save_recommendation","recommendationId":"rec_1"}', '[]', 'v', 'now'),
             ('dec_2', 'ws', 'arun_p', 'worker', '{}', 'score', '{"tool":"save_persona","personaId":"per_1"}', '[]', 'v', 'now')`);
    raw.exec(`INSERT INTO recommendations (id, workspace_id, title, summary, criteria, finding_ids, persona_feedback, priority, created_at)
      VALUES ('rec_1', 'ws', 't', 's', '{}', '[]', '[]', 1, 'now'), ('rec_orphan', 'ws', 't', 's', '{}', '[]', '[]', 1, 'now')`);
    raw.exec(`INSERT INTO personas (id, workspace_id, slug, segment, profile, agent_md_path, version)
      VALUES ('per_1', 'ws', 'sam', 'SMB', '{}', 'x.md', 1)`);
    raw.exec('COMMIT');
    raw.close();
    const store = open(path);
    expect(store.schemaVersion()).toBe(MIGRATIONS.length);
    expect(store.recommendations.get('rec_1')).toMatchObject({ taskId: 'tsk_syn', status: 'verified' });
    expect(store.recommendations.get('rec_orphan')!.status).toBe('unverified');
    expect(store.personas.get('per_1')).toMatchObject({ taskId: 'tsk_per', status: 'unverified' });
    expect(store.pipelines.list()).toEqual([]);
  });
});

