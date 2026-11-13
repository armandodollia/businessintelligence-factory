import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/api/routes.js';
import { recordOutcome } from '../../src/core/learning/outcomes.js';
import type { Store } from '../../src/core/store/db.js';
import { newId } from '../../src/core/store/repos.js';
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
  return { ...t, get, root, child, other };
}

function outcome(store: Store, workspaceId: string, label: 'confirmed' | 'stale', promptVersion: string) {
  const d = store.decisions.insert({
    id: newId('dec'), workspaceId, agentRunId: 'run_none', role: 'worker', model: { provider: 'claude', model: 'sonnet' }, kind: 'decision',
    payload: { tool: 'submit_result' }, refs: [], promptVersion, createdAt: new Date().toISOString(),
  });
  recordOutcome(store, { decisionId: d.id, outcome: label === 'stale' ? 'contradicted' : 'verified', label, source: label === 'stale' ? 'what_changed' : 'review_loop' });
}

describe('GET /api/workspaces/:id/outcomes', () => {
  it('reports label counts per role / task type / prompt version; ?scope=tree covers the business tree only', async () => {
    const t = setup();
    outcome(t.store, t.root.id, 'confirmed', 'v1');
    outcome(t.store, t.child.id, 'stale', 'v1');
    outcome(t.store, t.other.id, 'stale', 'v9');

    const own = await t.get(`/api/workspaces/${t.root.id}/outcomes`);
    expect(own.status).toBe(200);
    expect(own.body.labels).toContain('confirmed');
    expect(own.body.rows).toEqual([{ role: 'worker', promptVersion: 'v1', counts: { confirmed: 1 }, total: 1 }]);

    const tree = await t.get(`/api/workspaces/${t.root.id}/outcomes?scope=tree`);
    expect(tree.body.rows).toEqual([{ role: 'worker', promptVersion: 'v1', counts: { confirmed: 1, stale: 1 }, total: 2 }]);

    expect((await t.get('/api/workspaces/ws_missing/outcomes')).status).toBe(404);
  });
});
