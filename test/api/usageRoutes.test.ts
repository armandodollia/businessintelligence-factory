import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/api/routes.js';
import { recordUsage } from '../../src/core/metrics/usage.js';
import { recordPromptVersion } from '../../src/core/prompts/store.js';
import type { Store } from '../../src/core/store/db.js';
import { usageRepos } from '../../src/core/store/usageRepos.js';
import { createWorkspace } from '../../src/core/workspace/tree.js';
import { researchSetup } from '../core/helpers/research.js';

const opened: Store[] = [];
afterEach(() => {
  for (const s of opened.splice(0)) s.close();
});

function setup() {
  const t = researchSetup(opened);
  const app = createApp({ store: t.store, artifacts: t.artifacts, events: t.events, config: t.config, research: t.deps });
  const json = async (method: string, path: string, body?: unknown) => {
    const init: RequestInit = { method };
    if (body !== undefined) {
      init.body = JSON.stringify(body);
      init.headers = { 'content-type': 'application/json' };
    }
    const res = await app.request(path, init);
    const text = await res.text();
    return { status: res.status, body: text ? (JSON.parse(text) as any) : undefined };
  };
  const ws = createWorkspace(t.store, { name: 'Acme', sector: 'saas' });
  const run = t.store.agentRuns.insert({
    id: 'arun_1', workspaceId: ws.id, role: 'worker', model: { provider: 'claude', model: 'sonnet' }, token: 'tok_x', status: 'done',
    startedAt: '2026-11-01T00:00:00Z', promptVersion: recordPromptVersion(t.store, 'worker', 'You are a worker.'), attempts: 1,
  });
  recordUsage(t.store, { agentRunId: run.id, workspaceId: ws.id, role: 'worker', model: run.model, promptVersion: run.promptVersion! }, 1, {
    t: 'usage', inputTokens: 1000, outputTokens: 100,
  });
  return { ...t, app, json, ws, run };
}

describe('WP-B API', () => {
  it('GET /api/costs reports totals and groups, filtered by workspace, with budget status', async () => {
    const t = setup();
    t.config.budgets = { workspace: { maxTokens: 10_000 } };
    const other = createWorkspace(t.store, { name: 'Other', sector: 'saas' });
    recordUsage(t.store, { agentRunId: 'arun_2', workspaceId: other.id, role: 'reviewer', model: { provider: 'claude', model: 'opus' } }, 1, {
      t: 'usage', outputTokens: 10,
    });
    const all = await t.json('GET', '/api/costs');
    expect(all.status).toBe(200);
    expect(all.body.byWorkspace).toHaveLength(2);
    const one = await t.json('GET', `/api/costs?workspaceId=${t.ws.id}`);
    expect(one.body.total).toMatchObject({ runs: 1, inputTokens: 1000, outputTokens: 100, totalTokens: 1100 });
    expect(one.body.byRole.map((g: { key: string }) => g.key)).toEqual(['worker']);
    expect(one.body.byModel[0].key).toBe('claude/sonnet');
    expect(one.body.pricing.version).toEqual(expect.any(String));
    expect(one.body.budgets).toEqual([expect.objectContaining({ kind: 'workspace', spent: { tokens: 1100, costUsd: expect.any(Number) }, exceeded: false })]);
    expect((await t.json('GET', '/api/costs?workspaceId=ws_nope')).status).toBe(404);
  });

  it('GET /api/prompts/:hash resolves a prompt version to its text', async () => {
    const t = setup();
    const ok = await t.json('GET', `/api/prompts/${t.run.promptVersion}`);
    expect(ok.body).toMatchObject({ hash: t.run.promptVersion, role: 'worker', text: 'You are a worker.' });
    expect((await t.json('GET', '/api/prompts/00000000')).status).toBe(404);
  });

  it('GET /api/runs/:id and /events page through the run', async () => {
    const t = setup();
    const dir = join(t.config.dataDir, t.ws.id, 'runs', t.run.id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'events.jsonl'), [1, 2, 3].map((i) => JSON.stringify({ t: 'message', text: `m${i}` })).join('\n') + '\n');
    usageRepos(t.store).agentRunAttempts.insert({
      id: 'att_1', workspaceId: t.ws.id, runId: t.run.id, attempt: 1, startedAt: 'a', endedAt: 'b', exitCode: 0, rateLimited: false,
    });
    const detail = await t.json('GET', `/api/runs/${t.run.id}`);
    expect(detail.body).toMatchObject({ run: { id: t.run.id }, attempts: [{ attempt: 1 }], usage: { totalTokens: 1100 } });
    expect(detail.body.run.token).toBeUndefined(); // run tokens never leave the server
    const page = await t.json('GET', `/api/runs/${t.run.id}/events?offset=1&limit=1`);
    expect(page.body).toMatchObject({ total: 3, offset: 1, limit: 1, events: [{ t: 'message', text: 'm2' }] });
    expect((await t.json('GET', '/api/runs/arun_nope/events')).status).toBe(404);
  });

  it('GET /api/workspaces/:id/agent-runs lists runs newest first with usage', async () => {
    const t = setup();
    t.store.agentRuns.insert({
      id: 'arun_new', workspaceId: t.ws.id, role: 'reviewer', model: { provider: 'codex', model: 'gpt-6.1-sol' }, token: 'tok_y', status: 'failed',
      startedAt: '2026-11-02T00:00:00Z', failureReason: 'boom',
    });
    const r = await t.json('GET', `/api/workspaces/${t.ws.id}/agent-runs`);
    expect(r.body.map((x: { id: string }) => x.id)).toEqual(['arun_new', 'arun_1']);
    expect(r.body[0]).toMatchObject({ failureReason: 'boom', usage: { totalTokens: 0 } });
    expect(r.body[1].usage.totalTokens).toBe(1100);
    expect(r.body[0].token).toBeUndefined();
  });

  it('GET prompt-version metrics', async () => {
    const t = setup();
    const r = await t.json('GET', `/api/workspaces/${t.ws.id}/metrics/prompt-versions?role=worker`);
    expect(r.body).toEqual([expect.objectContaining({ role: 'worker', promptVersion: t.run.promptVersion, runs: 1 })]);
  });

  it('calibration: approving a patch keeps history; reverting restores a version and logs a decision', async () => {
    const t = setup();
    const p = (n: number) => ({ role: 'worker', examples: [], patchText: `## Calibration\n\n${n}. finding "F${n}" — \`relevance\`: you said 1; the user says 5.\n` });
    const a1 = await t.json('POST', `/api/workspaces/${t.ws.id}/calibration/prompt-patch/apply`, p(1));
    expect(a1.status).toBe(200);
    await t.json('POST', `/api/workspaces/${t.ws.id}/calibration/prompt-patch/apply`, p(2));
    const versions = await t.json('GET', `/api/workspaces/${t.ws.id}/calibration/versions?role=worker`);
    expect(versions.body.map((v: { source: string }) => v.source)).toEqual(['import', 'apply', 'apply']);
    expect(versions.body[1]).toMatchObject({ decisionId: a1.body.decisionId, actor: 'local-user' });
    expect(a1.body.versionId).toBe(versions.body[1].id);

    const rev = await t.json('POST', `/api/workspaces/${t.ws.id}/calibration/versions/${versions.body[1].id}/revert`, {});
    expect(rev.status).toBe(200);
    expect(readFileSync(rev.body.path, 'utf8')).not.toContain('F2');
    const d = t.store.decisions.get(rev.body.decisionId)!;
    expect(d.payload).toMatchObject({ tool: 'revert_calibration', role: 'worker', versionId: versions.body[1].id });
    const after = await t.json('GET', `/api/workspaces/${t.ws.id}/calibration/versions`);
    expect(after.body.at(-1)).toMatchObject({ source: 'revert', decisionId: rev.body.decisionId });
    expect((await t.json('POST', `/api/workspaces/${t.ws.id}/calibration/versions/cal_nope/revert`, {})).status).toBe(404);
    expect((await t.json('GET', `/api/workspaces/${t.ws.id}/calibration/versions?role=nope`)).status).toBe(400);
  });
});
