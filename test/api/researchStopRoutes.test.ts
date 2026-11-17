/**
 * `POST /api/workspaces/:id/research/stop`: the person stops the research of one business from the
 * app. The core behaviour is in `test/core/stopResearch.test.ts`; here the route, its record of who
 * did it, and that it reaches one business only. Agents are in-process scripts: no model is called.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/api/routes.js';
import type { FakeScript } from '../../src/core/harness/adapter.js';
import { listFeedback } from '../../src/core/feedback/events.js';
import { isPipelineLocked } from '../../src/core/research/lock.js';
import { researchToolHandlers } from '../../src/core/research/tools.js';
import type { Store } from '../../src/core/store/db.js';
import { createWorkspace } from '../../src/core/workspace/tree.js';
import { researchSetup, type Picker } from '../core/helpers/research.js';

const opened: Store[] = [];
afterEach(() => {
  for (const s of opened.splice(0)) s.close();
});

const never: FakeScript = () => new Promise<void>(() => {});
/** The orchestrator proposes one task; its worker never finishes. */
const stuckInWork: Picker = (req) =>
  req.kind === 'orchestrate'
    ? async (t) => {
        if (req.round === 1) await t.call('propose_tasks', { tasks: [{ type: 'news_scan', subject: 'Acme', brief: 'Scan the news', needs_browser: false, acceptance_criteria: ['one dated article'] }] });
      }
    : req.kind === 'work'
      ? never
      : undefined;

function setup() {
  const t = researchSetup(opened, { extraHandlers: () => researchToolHandlers(), pick: stuckInWork, config: (c) => (c.user = { id: 'erin' }) });
  const app = createApp({ store: t.store, artifacts: t.artifacts, events: t.events, config: t.config, research: t.deps });
  const json = async (method: string, path: string, body?: unknown) => {
    const res = await app.request(path, { method, ...(body !== undefined ? { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } } : {}) });
    const text = await res.text();
    return { status: res.status, body: text ? (JSON.parse(text) as any) : undefined };
  };
  const ws = createWorkspace(t.store, { name: 'Acme', sector: 'saas' });
  const inWork = async (workspaceId: string) => {
    for (let i = 0; i < 2000 && !t.requests.some((r) => r.kind === 'work' && r.workspaceId === workspaceId); i++) await new Promise((r) => setTimeout(r, 5));
    expect(t.requests.some((r) => r.kind === 'work' && r.workspaceId === workspaceId)).toBe(true);
  };
  const stops = () => listFeedback(t.store, { kind: 'user_action' }).filter((e) => (e.afterJson as { action: string }).action === 'research_stop');
  return { ...t, app, json, ws, inWork, stops };
}

describe('POST /api/workspaces/:id/research/stop', () => {
  it('stops the running research, says what it stopped, records who did it, and research can be started again', async () => {
    const t = setup();
    const started = await t.json('POST', `/api/workspaces/${t.ws.id}/research`, { phases: ['deep_dives'] });
    expect(started.status).toBe(202);
    await t.inWork(t.ws.id);

    const stopped = await t.json('POST', `/api/workspaces/${t.ws.id}/research/stop`, {});

    expect(stopped.status).toBe(200);
    expect(stopped.body).toMatchObject({ stopped: true, researchRuns: [started.body.id] });
    expect(stopped.body.requeuedTasks).toHaveLength(1);
    const runs = await t.json('GET', `/api/workspaces/${t.ws.id}/runs`);
    expect(runs.body).toEqual([expect.objectContaining({ id: started.body.id, status: 'failed', failureReason: 'stopped by the user' })]);
    expect(t.store.agentRuns.list({ workspaceId: t.ws.id, status: 'running' })).toEqual([]);
    expect(isPipelineLocked(t.store, t.ws.id)).toBe(false);
    // The configured actor, with ids only.
    expect(t.stops()).toEqual([expect.objectContaining({ actor: 'erin', workspaceId: t.ws.id, targetType: 'workspace', targetId: t.ws.id, afterJson: { action: 'research_stop', researchRunIds: [started.body.id] } })]);

    const again = await t.json('POST', `/api/workspaces/${t.ws.id}/research`, { phases: ['deep_dives'] });
    expect(again.status).toBe(202);
    await t.inWork(t.ws.id);
    expect((await t.json('POST', `/api/workspaces/${t.ws.id}/research/stop`, {})).body).toMatchObject({ stopped: true, researchRuns: [again.body.id] });
  });

  it('with nothing running it answers that nothing was stopped and records nothing', async () => {
    const t = setup();
    const r = await t.json('POST', `/api/workspaces/${t.ws.id}/research/stop`, {});
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ stopped: false, researchRuns: [], pipelines: [], requeuedTasks: [], closedRequests: [] });
    expect(t.stops()).toEqual([]);
  });

  it('an unknown business answers 404', async () => {
    const t = setup();
    const r = await t.json('POST', '/api/workspaces/ws_nope/research/stop', {});
    expect(r.status).toBe(404);
    expect(r.body.error).toContain("workspace 'ws_nope' not found");
  });

  it('reaches the named business only: a unit of the same tree and a business of another tree keep running', async () => {
    const t = setup();
    const unit = createWorkspace(t.store, { name: 'Acme EU', sector: 'saas', parentWorkspaceId: t.ws.id });
    const other = createWorkspace(t.store, { name: 'Other', sector: 'retail' });
    for (const id of [t.ws.id, unit.id, other.id]) {
      expect((await t.json('POST', `/api/workspaces/${id}/research`, { phases: ['deep_dives'] })).status).toBe(202);
      await t.inWork(id);
    }

    expect((await t.json('POST', `/api/workspaces/${t.ws.id}/research/stop`, {})).body).toMatchObject({ stopped: true });

    for (const id of [unit.id, other.id]) {
      expect(t.store.researchRuns.list({ workspaceId: id }).map((r) => r.status), id).toEqual(['running']);
      expect(t.store.agentRuns.list({ workspaceId: id, status: 'running' }), id).toHaveLength(1);
      expect(isPipelineLocked(t.store, id), id).toBe(true);
    }
    // Stop them too, so the test leaves nothing in flight.
    for (const id of [unit.id, other.id]) expect((await t.json('POST', `/api/workspaces/${id}/research/stop`, {})).status).toBe(200);
  });
});
