import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/api/routes.js';
import type { Store } from '../../src/core/store/db.js';
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
  const child = createWorkspace(t.store, { name: 'Acme Pay', sector: 'saas', parentWorkspaceId: root.id });
  const other = createWorkspace(t.store, { name: 'Globex', sector: 'saas' });
  const run = (id: string, workspaceId: string, startedAt: string, status: 'done' | 'failed' = 'done') =>
    t.store.agentRuns.insert({ id, workspaceId, role: 'worker', model: { provider: 'claude', model: 'sonnet' }, token: `tok_${id}`, status, startedAt, promptVersion: 'aaaa' });
  run('r1', root.id, '2026-11-02T10:00:00.000Z');
  run('r2', child.id, '2026-11-10T10:00:00.000Z', 'failed');
  run('r3', other.id, '2026-11-10T10:00:00.000Z');
  return { ...t, get, root, child, other };
}

describe('GET /api/workspaces/:id/metrics (WP-G)', () => {
  it('serves the business tree by default, one node on request, and never another tree', async () => {
    const t = setup();
    const tree = await t.get(`/api/workspaces/${t.root.id}/metrics`);
    expect(tree.status).toBe(200);
    expect(tree.body).toMatchObject({ rootWorkspaceId: t.root.id, scope: 'tree', groupBy: 'role', bucket: 'day', totals: { runs: 2, failedRuns: 1 } });
    expect(tree.body.experiments).toEqual({ included: false, excludedRuns: 0 });
    expect(tree.body.lessons).toEqual([]); // WP-E slot: no rules yet
    const node = await t.get(`/api/workspaces/${t.root.id}/metrics?scope=node`);
    expect(node.body.totals.runs).toBe(1);
  });

  it('takes the window, the grouping, the bucket and the experiment toggle from the query', async () => {
    const t = setup();
    const r = await t.get(`/api/workspaces/${t.root.id}/metrics?since=2026-11-09&groupBy=prompt_version&bucket=week&includeExperiments=1`);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ groupBy: 'prompt_version', bucket: 'week', window: { since: '2026-11-09', until: null }, experiments: { included: true } });
    expect(r.body.groups.map((g: { key: string }) => g.key)).toEqual(['worker:aaaa']);
    expect(r.body.series.map((p: { bucket: string; runs: number }) => [p.bucket, p.runs])).toEqual([['2026-11-09', 1]]);
  });

  it('does not run the training export (the exclusion summary stays on demand)', async () => {
    const t = setup();
    const r = await t.get(`/api/workspaces/${t.root.id}/metrics`);
    expect(r.body).not.toHaveProperty('exportSummary');
  });

  it('400 on a malformed query, 404 on an unknown workspace', async () => {
    const t = setup();
    for (const q of ['scope=world', 'groupBy=colour', 'bucket=month', 'since=yesterday', 'until=2026-13-45', 'includeExperiments=maybe']) {
      expect((await t.get(`/api/workspaces/${t.root.id}/metrics?${q}`)).status, q).toBe(400);
    }
    expect((await t.get('/api/workspaces/ws_nope/metrics')).status).toBe(404);
  });
});
