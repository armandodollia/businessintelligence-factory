import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/api/routes.js';
import type { Store } from '../../src/core/store/db.js';
import { knowledgeRepos, newId } from '../../src/core/store/repos.js';
import { createWorkspace } from '../../src/core/workspace/tree.js';
import { researchSetup } from '../core/helpers/research.js';

const opened: Store[] = [];
afterEach(() => {
  for (const s of opened.splice(0)) s.close();
});

function setup() {
  const t = researchSetup(opened);
  const app = createApp({ store: t.store, artifacts: t.artifacts, events: t.events, config: t.config, research: t.deps });
  const get = async (path: string) => {
    const res = await app.request(path);
    return { status: res.status, body: (await res.json()) as any };
  };
  const root = createWorkspace(t.store, { name: 'Acme', sector: 'saas' });
  const child = createWorkspace(t.store, { name: 'Acme Payments', sector: 'saas', parentWorkspaceId: root.id });
  const other = createWorkspace(t.store, { name: 'Globex', sector: 'saas' });
  const retrieval = (workspaceId: string, rootWorkspaceId: string, resultCount: number, createdAt = '2026-11-10T00:00:00.000Z') =>
    knowledgeRepos(t.store).retrievalEvents.insert({
      id: newId('ret'), workspaceId, rootWorkspaceId, agentRunId: newId('arun'), role: 'worker', tool: 'search', query: 'q', scope: 'node',
      resultIds: Array.from({ length: resultCount }, () => ({ id: newId('fnd'), kind: 'fact' })), resultCount, tokensReturned: 50,
      truncated: false, relaxed: false, latencyMs: 1, uploadDerived: false, createdAt,
    });
  return { ...t, get, root, child, other, retrieval };
}

describe('GET /api/workspaces/:id/knowledge/metrics and /signals (KS-6)', () => {
  it('serves one business tree (or one node), with a time window, and never another tree', async () => {
    const t = setup();
    t.retrieval(t.root.id, t.root.id, 2);
    t.retrieval(t.child.id, t.root.id, 0);
    t.retrieval(t.other.id, t.other.id, 0);
    const tree = await t.get(`/api/workspaces/${t.child.id}/knowledge/metrics`);
    expect(tree.status).toBe(200);
    expect(tree.body).toMatchObject({ rootWorkspaceId: t.root.id, retrieval: { retrievals: 2, searches: 2, zeroResultSearches: 1, zeroResultRate: 0.5 } });
    expect(tree.body.store).toHaveProperty('fileBytes');
    const node = await t.get(`/api/workspaces/${t.child.id}/knowledge/metrics?scope=node`);
    expect(node.body.retrieval.retrievals).toBe(1);
    const windowed = await t.get(`/api/workspaces/${t.root.id}/knowledge/metrics?since=2026-11-11`);
    expect(windowed.body.retrieval.retrievals).toBe(0);
    const signals = await t.get(`/api/workspaces/${t.root.id}/knowledge/signals`);
    expect(signals.body.map((s: { kind: string; count: number }) => [s.kind, s.count])).toEqual([['zero_result', 1], ['unused_tokens', 1]]);
    expect((await t.get(`/api/workspaces/${t.other.id}/knowledge/signals`)).body.map((s: { kind: string }) => s.kind)).toEqual(['zero_result']);
  });

  it('400 on a malformed filter, 404 on an unknown workspace', async () => {
    const t = setup();
    expect((await t.get(`/api/workspaces/${t.root.id}/knowledge/metrics?scope=world`)).status).toBe(400);
    expect((await t.get(`/api/workspaces/${t.root.id}/knowledge/signals?since=yesterday`)).status).toBe(400);
    expect((await t.get('/api/workspaces/ws_nope/knowledge/metrics')).status).toBe(404);
  });
});
