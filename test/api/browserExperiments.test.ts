/**
 * Orchestrator ruling R4 (wave 2): no browser experiments by default. An experiment on a task that
 * uses the browser is refused unless `config.experiments.allowBrowser` is true (default false); when it
 * is allowed, starting one needs an explicit `confirmBrowser: true` in the request, because real-world
 * actions repeat per arm and per repeat.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/api/routes.js';
import { parseConfig } from '../../src/core/config/load.js';
import { ExperimentError, startExperiment } from '../../src/core/learning/experiments.js';
import type { Store } from '../../src/core/store/db.js';
import { createWorkspace } from '../../src/core/workspace/tree.js';
import { addTask, researchSetup, review, submitWork } from '../core/helpers/research.js';

const opened: Store[] = [];
afterEach(() => {
  for (const s of opened.splice(0)) s.close();
});

function setup() {
  const t = researchSetup(opened, { pick: (r) => (r.kind === 'work' ? submitWork() : r.kind === 'review' ? review(9) : undefined) });
  const app = createApp({ store: t.store, artifacts: t.artifacts, events: t.events, config: t.config, research: t.deps });
  const call = async (path: string, body: unknown) => {
    const res = await app.request(path, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } });
    return { status: res.status, body: (await res.json()) as any };
  };
  const ws = createWorkspace(t.store, { name: 'Acme', sector: 'saas' });
  const browserTask = addTask(t.store, { workspaceId: ws.id, needsBrowser: true, status: 'verified' });
  const plainTask = addTask(t.store, { workspaceId: ws.id, status: 'verified' });
  const arms = [{}, { model: { provider: 'claude', model: 'haiku' } }] as const;
  return { ...t, call, ws, browserTask, plainTask, arms };
}

describe('R4: browser experiments', () => {
  it('config.experiments.allowBrowser defaults to false', () => {
    const s = setup();
    expect(s.config.experiments?.allowBrowser ?? false).toBe(false);
    expect(parseConfig({ ...s.config, experiments: { allowBrowser: true } }, 'test').experiments).toEqual({ allowBrowser: true });
  });

  it('are refused by default, in core and by the API', async () => {
    const s = setup();
    expect(() => startExperiment(s.deps, { taskId: s.browserTask.id, arms: [...s.arms] })).toThrow(ExperimentError);
    expect(() => startExperiment(s.deps, { taskId: s.browserTask.id, arms: [...s.arms], confirmBrowser: true })).toThrow(/allowBrowser/);
    const res = await s.call(`/api/workspaces/${s.ws.id}/experiments`, { taskId: s.browserTask.id, arms: s.arms, confirmBrowser: true });
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/experiments\.allowBrowser/);
    // A task without the browser is unaffected.
    const ok = await s.call(`/api/workspaces/${s.ws.id}/experiments`, { taskId: s.plainTask.id, arms: s.arms });
    expect(ok.status).toBe(202);
  });

  it('when allowed, need an explicit confirm flag in the request', async () => {
    const s = setup();
    s.config.experiments = { allowBrowser: true };
    const missing = await s.call(`/api/workspaces/${s.ws.id}/experiments`, { taskId: s.browserTask.id, arms: s.arms });
    expect(missing.status).toBe(400);
    expect(missing.body.error).toMatch(/confirmBrowser/);
    const wrong = await s.call(`/api/workspaces/${s.ws.id}/experiments`, { taskId: s.browserTask.id, arms: s.arms, confirmBrowser: 'yes' });
    expect(wrong.status).toBe(400);
    const ok = await s.call(`/api/workspaces/${s.ws.id}/experiments`, { taskId: s.browserTask.id, arms: s.arms, repeats: 2, confirmBrowser: true });
    expect(ok.status).toBe(202);
    expect(ok.body.arms.map((a: { taskIds: string[] }) => a.taskIds.length)).toEqual([2, 2]);
  });
});
