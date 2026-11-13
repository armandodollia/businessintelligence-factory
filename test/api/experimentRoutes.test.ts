import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/api/routes.js';
import { runReviewerAudit } from '../../src/core/learning/reviewerAudit.js';
import { runTaskWithReview } from '../../src/core/research/reviewLoop.js';
import type { Store } from '../../src/core/store/db.js';
import { createWorkspace } from '../../src/core/workspace/tree.js';
import { addTask, researchSetup, review, submitWork } from '../core/helpers/research.js';

const opened: Store[] = [];
afterEach(() => {
  for (const s of opened.splice(0)) s.close();
});

async function setup() {
  const t = researchSetup(opened, {
    pick: (r) => (r.kind === 'work' ? submitWork() : r.kind === 'review' ? review(9) : r.kind === 'audit' ? review(2, [{ class: 'blocking', description: 'unsupported' }]) : undefined),
  });
  t.config.user = { id: 'alice' };
  const app = createApp({ store: t.store, artifacts: t.artifacts, events: t.events, config: t.config, research: t.deps });
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await app.request(path, body === undefined ? { method } : { method, body: JSON.stringify(body), headers: { 'content-type': 'application/json' } });
    return { status: res.status, body: (await res.json()) as any };
  };
  const root = createWorkspace(t.store, { name: 'Acme', sector: 'saas' });
  const child = createWorkspace(t.store, { name: 'Acme Pay', sector: 'saas', parentWorkspaceId: root.id });
  const other = createWorkspace(t.store, { name: 'Globex', sector: 'saas' });
  const task = await runTaskWithReview(addTask(t.store, { workspaceId: child.id }), t.deps);
  return { ...t, call, root, child, other, task };
}

const until = async (cond: () => Promise<boolean>) => {
  for (let i = 0; i < 200 && !(await cond()); i++) await new Promise((r) => setTimeout(r, 5));
};

describe('reviewer audit routes', () => {
  it('starts an audit with the configured actor and lists the tree\'s audits, misses and summary', async () => {
    const t = await setup();
    const started = await t.call('POST', `/api/workspaces/${t.root.id}/audits`, { n: 3, actor: 'mallory' });
    expect(started.status).toBe(400); // unknown body field (the actor never comes from the body)
    const ok = await t.call('POST', `/api/workspaces/${t.root.id}/audits`, { n: 3 });
    expect(ok.status).toBe(202);
    expect(ok.body.audits).toEqual([expect.objectContaining({ taskId: t.task.id, actor: 'alice', startedBy: 'api', status: 'running' })]);
    await until(async () => (await t.call('GET', `/api/workspaces/${t.child.id}/audits`)).body.summary.running === 0);
    const list = await t.call('GET', `/api/workspaces/${t.child.id}/audits`);
    expect(list.body.rootWorkspaceId).toBe(t.root.id);
    expect(list.body.summary).toMatchObject({ total: 1, miss: 1, missRate: 1 });
    const misses = await t.call('GET', `/api/workspaces/${t.root.id}/audit-misses`);
    expect(misses.body).toEqual([expect.objectContaining({ taskId: t.task.id, classes: ['blocking'] })]);
    // Another tree sees none of it.
    expect((await t.call('GET', `/api/workspaces/${t.other.id}/audits`)).body.audits).toEqual([]);
    expect((await t.call('GET', `/api/workspaces/${t.other.id}/audit-misses`)).body).toEqual([]);
    expect((await t.call('POST', `/api/workspaces/${t.other.id}/audits`, { taskIds: [t.task.id] })).status).toBe(400);
    expect((await t.call('GET', '/api/workspaces/ws_missing/audits')).status).toBe(404);
  });

  it('creates and toggles audit schedules', async () => {
    const t = await setup();
    expect((await t.call('POST', `/api/workspaces/${t.root.id}/audit-schedules`, { cron: 'bad cron', n: 2 })).status).toBe(400);
    const s = await t.call('POST', `/api/workspaces/${t.child.id}/audit-schedules`, { cron: '0 3 * * 1', n: 2 });
    expect(s.status).toBe(201);
    expect(s.body).toMatchObject({ rootWorkspaceId: t.root.id, enabled: true, actor: 'alice' });
    const off = await t.call('POST', `/api/audit-schedules/${s.body.id}`, { enabled: false });
    expect(off.body.enabled).toBe(false);
    expect((await t.call('GET', `/api/workspaces/${t.root.id}/audits`)).body.schedules).toHaveLength(1);
    expect((await t.call('POST', '/api/audit-schedules/asch_missing', { enabled: true })).status).toBe(404);
  });
});

describe('experiment routes', () => {
  it('starts an experiment on a task of the workspace and serves the comparison', async () => {
    const t = await setup();
    expect((await t.call('POST', `/api/workspaces/${t.root.id}/experiments`, { taskId: t.task.id, arms: [{}, {}] })).status).toBe(404);
    expect((await t.call('POST', `/api/workspaces/${t.child.id}/experiments`, { taskId: t.task.id, arms: [{}] })).status).toBe(400);
    const bad = await t.call('POST', `/api/workspaces/${t.child.id}/experiments`, { taskId: t.task.id, arms: [{}, { model: { provider: 'claude', model: 'nope' } }] });
    expect(bad.status).toBe(400);
    const res = await t.call('POST', `/api/workspaces/${t.child.id}/experiments`, {
      taskId: t.task.id, name: 'haiku', arms: [{}, { model: { provider: 'claude', model: 'haiku' } }],
    });
    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({ status: 'running', actor: 'alice', name: 'haiku' });
    await until(async () => (await t.call('GET', `/api/experiments/${res.body.id}`)).body.experiment.status !== 'running');
    const cmp = await t.call('GET', `/api/experiments/${res.body.id}`);
    expect(cmp.body.experiment.status).toBe('done');
    expect(cmp.body.arms.map((a: any) => [a.arm, a.model.model, a.passRate])).toEqual([['A', 'sonnet', 1], ['B', 'haiku', 1]]);
    expect((await t.call('GET', `/api/workspaces/${t.child.id}/experiments`)).body.map((e: any) => e.id)).toEqual([res.body.id]);
    expect((await t.call('GET', '/api/experiments/exp_missing')).status).toBe(404);
  });

  it('audits of the tree ignore experiment arm tasks', async () => {
    const t = await setup();
    const res = await t.call('POST', `/api/workspaces/${t.child.id}/experiments`, { taskId: t.task.id, arms: [{}, {}] });
    await until(async () => (await t.call('GET', `/api/experiments/${res.body.id}`)).body.experiment.status !== 'running');
    const audits = await runReviewerAudit(t.deps, { workspaceId: t.root.id, n: 10 });
    expect(audits.map((a) => a.taskId)).toEqual([t.task.id]);
  });
});
