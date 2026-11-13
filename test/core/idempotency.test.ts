import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { defaultConfig } from '../../src/core/config/schema.js';
import { EventBus } from '../../src/core/events.js';
import { ArtifactStore } from '../../src/core/evidence/artifacts.js';
import { createToolHandlers } from '../../src/core/harness/tools/handlers.js';
import type { RunContext } from '../../src/core/harness/tokens.js';
import { interviewToolHandlers } from '../../src/core/interview/interview.js';
import { researchToolHandlers } from '../../src/core/research/tools.js';
import { scoringToolHandlers } from '../../src/core/scoring/priority.js';
import { openStore, type Store } from '../../src/core/store/db.js';
import { newId } from '../../src/core/store/repos.js';

const opened: Store[] = [];
afterEach(() => {
  for (const s of opened.splice(0)) s.close();
});

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'bif-idem-'));
  const store = openStore(join(dir, 'bif.db'));
  opened.push(store);
  const handle = createToolHandlers({
    store, artifacts: new ArtifactStore(store, dir), config: defaultConfig, events: new EventBus(),
    extraHandlers: { ...researchToolHandlers(), ...interviewToolHandlers(), ...scoringToolHandlers() },
  });
  store.workspaces.insert({ id: 'ws_a', name: 'Acme', sector: 'saas', createdAt: '' });
  return { store, handle };
}

const ctx = (role: RunContext['role'], extra: Partial<RunContext> = {}): RunContext => ({
  agentRunId: newId('arun'), workspaceId: 'ws_a', role, model: { provider: 'claude', model: 'sonnet' }, promptVersion: 'p', ...extra,
});

function taskWithRun(store: Store, run: RunContext) {
  const taskId = newId('tsk');
  store.tasks.insert({
    id: taskId, workspaceId: 'ws_a', runId: 'rrun_1', phase: 'synthesis', type: 'synthesize_recommendations', brief: 'b',
    model: run.model, needsBrowser: false, acceptanceCriteria: ['c'], status: 'running', round: 1, createdAt: '',
  });
  store.agentRuns.insert({
    id: run.agentRunId, workspaceId: 'ws_a', taskId, role: run.role, model: run.model, token: `tok_${run.agentRunId}`,
    status: 'running', startedAt: '',
  });
  return { ...run, taskId };
}

const data = <T>(r: { ok: boolean; data?: unknown; error?: string }): T => {
  if (!r.ok) throw new Error(r.error);
  return r.data as T;
};

describe('replayed tool calls are idempotent', () => {
  it('respond_to_review: one decision per (run, issue)', async () => {
    const { store, handle } = setup();
    const c = ctx('worker');
    const input = { issue_id: 'I1', action: 'pushback', reason: 'nit' };
    data(await handle(c, 'respond_to_review', input));
    expect(data<{ duplicate?: boolean }>(await handle(c, 'respond_to_review', input)).duplicate).toBe(true);
    expect(store.decisions.list({ kind: 'pushback' })).toHaveLength(1);
    // A different run (next revision round) answers again.
    data(await handle(ctx('worker'), 'respond_to_review', input));
    expect(store.decisions.list({ kind: 'pushback' })).toHaveLength(2);
  });

  it('save_recommendation: one recommendation per (task, title); replay updates it', async () => {
    const { store, handle } = setup();
    store.findings.insert({
      id: 'fnd_1', workspaceId: 'ws_a', runId: 'r', taskId: 't', subject: 's', claim: 'c', criteria: {}, evidence: [],
      status: 'verified', createdAt: '',
    });
    const c = taskWithRun(store, ctx('synthesizer'));
    const a = data<{ recommendationId: string }>(
      await handle(c, 'save_recommendation', { title: 'Cut prices', summary: 'v1', finding_ids: ['fnd_1'], criteria: { upside: 4 } }),
    );
    // Retry of the task with a new run (same task) replays the call.
    const c2 = { ...c, agentRunId: newId('arun') };
    store.agentRuns.insert({ id: c2.agentRunId, workspaceId: 'ws_a', taskId: c.taskId, role: 'synthesizer', model: c.model, token: 'tok_2', status: 'running', startedAt: '' });
    const b = data<{ recommendationId: string; duplicate: boolean }>(
      await handle(c2, 'save_recommendation', { title: ' cut  PRICES', summary: 'v2', finding_ids: ['fnd_1'], criteria: { upside: 5 } }),
    );
    expect(b).toMatchObject({ recommendationId: a.recommendationId, duplicate: true });
    expect(store.recommendations.list()).toHaveLength(1);
    expect(store.recommendations.get(a.recommendationId)).toMatchObject({ summary: 'v2', criteria: { upside: 5 } });
    expect(store.decisions.list({ kind: 'score' })).toHaveLength(1);
  });

  it('propose_business_unit: one proposal per (task, name)', async () => {
    const { store, handle } = setup();
    const c = taskWithRun(store, ctx('worker'));
    const input = { name: 'Payments', description: 'd', level: 'division', audiences: ['external'], reasoning: 'r' };
    const a = data<{ proposalId: string }>(await handle(c, 'propose_business_unit', input));
    const b = data<{ proposalId: string; duplicate: boolean }>(await handle(c, 'propose_business_unit', { ...input, name: 'payments' }));
    expect(b).toEqual({ proposalId: a.proposalId, duplicate: true });
    expect(store.unitProposals.list()).toHaveLength(1);
    data(await handle(c, 'propose_business_unit', { ...input, name: 'Lending' }));
    expect(store.unitProposals.list()).toHaveLength(2);
  });

  it('save_symptom: one symptom per (run, kind, title)', async () => {
    const { store, handle } = setup();
    const c = ctx('interviewer');
    const input = { kind: 'symptom', title: 'Renewals down', detail: 'd', criteria: { severity: 4, trend: '↓', causeConfidence: 50 } };
    const a = data<{ symptomId: string }>(await handle(c, 'save_symptom', input));
    const b = data<{ symptomId: string; duplicate: boolean }>(await handle(c, 'save_symptom', input));
    expect(b).toEqual({ symptomId: a.symptomId, duplicate: true });
    expect(store.symptoms.list()).toHaveLength(1);
    data(await handle(c, 'save_symptom', { ...input, kind: 'strength', criteria: { severity: 4, trend: '↑', causeConfidence: 50 } }));
    expect(store.symptoms.list()).toHaveLength(2);
  });
});
