/**
 * KS-4: prompt-context reads are logged BEFORE the run starts (design-thread ruling for KS-4), so a
 * crash mid-run cannot lose the row that makes a run upload-exposed (design §12); and every prompt
 * hash a retrieval row carries resolves in the prompt store.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { FakeScript } from '../../../src/core/harness/adapter.js';
import { uploadInternal } from '../../../src/core/internal/uploads.js';
import { ingestorFor } from '../../../src/core/knowledge/ingest.js';
import { runIsUploadExposed } from '../../../src/core/knowledge/retrievalLog.js';
import { promptStoreGaps } from '../../../src/core/prompts/store.js';
import { runAgent } from '../../../src/core/research/deps.js';
import { runTaskWithReview } from '../../../src/core/research/reviewLoop.js';
import type { Store } from '../../../src/core/store/db.js';
import { knowledgeRepos } from '../../../src/core/store/repos.js';
import { addTask, researchSetup } from '../helpers/research.js';

const opened: Store[] = [];
afterEach(() => {
  for (const s of opened.splice(0)) s.close();
});

function setup() {
  const t = researchSetup(opened);
  t.store.workspaces.insert({ id: 'ws_a', name: 'Acme', sector: 'saas', createdAt: 'now' });
  return t;
}

describe('prompt reads are logged before the run starts', () => {
  it('runAgent writes promptReads rows once the run id exists and before the agent sees anything', async () => {
    const env = setup();
    const task = addTask(env.store);
    const res = await runAgent(env.deps, {
      kind: 'work', role: 'worker', workspaceId: 'ws_a', task, round: 1, attempt: 1, prompt: 'p', systemPrompt: 'sys',
      model: task.model, needsBrowser: false, promptVersion: 'pv_test',
      promptReads: [{ query: 'briefing', scope: 'node', results: [{ id: 'fnd_x', kind: 'fact' }], tokensReturned: 12, uploadDerived: false }],
    });
    const rows = knowledgeRepos(env.store).retrievalEvents.list({ agentRunId: res.agentRunId });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ tool: 'prompt_context', role: 'worker', taskId: task.id, query: 'briefing', promptVersion: 'pv_test', tokensReturned: 12 });
  });

  it('the row exists while the agent runs (checked from inside the fake run)', async () => {
    const env = setup();
    const task = addTask(env.store);
    let during = -1;
    env.state.pick = (): FakeScript => async () => {
      const run = env.store.agentRuns.list({ taskId: task.id }).find((r) => r.status === 'running')!;
      during = knowledgeRepos(env.store).retrievalEvents.list({ agentRunId: run.id }).length;
    };
    await runAgent(env.deps, {
      kind: 'work', role: 'worker', workspaceId: 'ws_a', task, round: 1, attempt: 1, prompt: 'p', systemPrompt: 'sys',
      model: task.model, needsBrowser: false, promptVersion: 'pv',
      promptReads: [{ query: 'q', scope: 'node', results: [], tokensReturned: 0, uploadDerived: false }],
    });
    expect(during).toBe(1);
  });

  it('a reviewer that submits its review and then dies is still upload-exposed (crash after submit)', async () => {
    const env = setup();
    const up = uploadInternal('ws_a', { name: 'kpis.csv', bytes: new TextEncoder().encode('Renewals fell 12% in Q3'), mime: 'text/csv' }, env);
    await ingestorFor(env).idle();
    const task = addTask(env.store);
    let exposedAtCrash: boolean | undefined;
    env.state.pick = (r): FakeScript =>
      r.kind === 'work'
        ? async (tools) => {
            await tools.call('save_finding', {
              claim: 'Renewals fell 12% in Q3', subject: 'Acme', evidence: [up.id], relation: 'new',
              evidence_refs: [{ artifact_id: up.id, quote: 'Renewals fell 12%' }],
            });
            await tools.call('submit_result', { summary: 'done' });
          }
        : async (tools) => {
            await tools.call('submit_review', { score: 9, issues: [] });
            // The process dies here: nothing after this point runs. What the store holds now is what survives.
            const run = env.store.agentRuns.list({ taskId: task.id }).find((x) => x.role === 'reviewer' && x.status === 'running')!;
            exposedAtCrash = runIsUploadExposed(env.store, run.id);
            throw new Error('process killed');
          };
    await runTaskWithReview(task, env.deps);
    expect(exposedAtCrash).toBe(true);
    const reviewer = env.store.agentRuns.list({ taskId: task.id }).find((x) => x.role === 'reviewer')!;
    const [row] = knowledgeRepos(env.store).retrievalEvents.list({ agentRunId: reviewer.id });
    expect(row).toMatchObject({ tool: 'prompt_context', role: 'reviewer', uploadDerived: true });
    expect(row!.resultIds.map((x) => x.id)).toContain(up.id);
  });

  it('a throwing beforeStart fails the run without starting the agent', async () => {
    const env = setup();
    const task = addTask(env.store);
    let started = false;
    env.state.pick = (): FakeScript => async () => {
      started = true;
    };
    const res = await env.supervisor.run({
      ctx: { workspaceId: 'ws_a', role: 'worker', model: task.model, promptVersion: 'pv', taskId: task.id },
      prompt: 'p', systemPrompt: 's', needsBrowser: false, fake: env.deps.fake!({ kind: 'work', role: 'worker', workspaceId: 'ws_a', round: 1, attempt: 1, prompt: 'p', systemPrompt: 's' }),
      beforeStart: () => {
        throw new Error('log unavailable');
      },
    });
    expect(started).toBe(false);
    expect(res.status).toBe('failed');
  });
});

describe('prompt store covers retrieval_events.prompt_version', () => {
  it('a tool read by a real run carries the run\'s prompt hash, and it resolves', async () => {
    const env = setup();
    const task = addTask(env.store);
    env.store.findings.insert({ id: 'fnd_e2e', workspaceId: 'ws_a', runId: 'r', taskId: 'x', subject: 'Acme', claim: 'Acme sells widgets', criteria: {}, evidence: [], status: 'verified', createdAt: 'now' });
    let hits: unknown;
    env.state.pick = (): FakeScript => async (tools) => {
      hits = await tools.call('search', { query: 'widgets', kinds: ['fact'] });
    };
    const res = await runAgent(env.deps, {
      kind: 'work', role: 'worker', workspaceId: 'ws_a', task, round: 1, attempt: 1, prompt: 'p', systemPrompt: 'worker system prompt',
      model: task.model, needsBrowser: false, promptVersion: 'pv_worker_e2e',
    });
    expect(hits).toMatchObject({ hits: [{ id: 'fnd_e2e' }] });
    const [row] = knowledgeRepos(env.store).retrievalEvents.list({ agentRunId: res.agentRunId });
    expect(row).toMatchObject({ tool: 'search', promptVersion: 'pv_worker_e2e', taskId: task.id });
    expect(promptStoreGaps(env.store)).toEqual([]);
  });

  it('lists a retrieval row whose prompt hash has no text, and run-logged rows resolve', async () => {
    const env = setup();
    const task = addTask(env.store);
    await runAgent(env.deps, {
      kind: 'work', role: 'worker', workspaceId: 'ws_a', task, round: 1, attempt: 1, prompt: 'p', systemPrompt: 'system text',
      model: task.model, needsBrowser: false, promptVersion: 'pv_resolves',
      promptReads: [{ query: 'q', scope: 'node', results: [], tokensReturned: 0, uploadDerived: false }],
    });
    expect(promptStoreGaps(env.store)).toEqual([]);
    knowledgeRepos(env.store).retrievalEvents.insert({
      id: 'ret_gap', workspaceId: 'ws_a', rootWorkspaceId: 'ws_a', role: 'worker', tool: 'search', query: 'q', scope: 'node',
      resultIds: [], resultCount: 0, tokensReturned: 0, truncated: false, relaxed: false, latencyMs: 0, uploadDerived: false,
      promptVersion: 'pv_missing', createdAt: 'now',
    });
    expect(promptStoreGaps(env.store)).toEqual(['pv_missing']);
  });
});
