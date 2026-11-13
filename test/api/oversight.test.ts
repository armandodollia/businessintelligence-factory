import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/api/routes.js';
import { recordPolicyEvent } from '../../src/core/policy/policyEvents.js';
import type { Store } from '../../src/core/store/db.js';
import { persistBusEvent } from '../../src/core/telemetry/busEvents.js';
import type { UserRequest } from '../../src/core/types.js';
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
  const child = createWorkspace(t.store, { name: 'Acme EU', sector: 'saas', parentWorkspaceId: ws.id });
  return { ...t, app, json, ws, child };
}

function escalation(store: Store, workspaceId: string, extra: Partial<UserRequest> = {}): UserRequest {
  return store.userRequests.insert({
    id: `ureq_${Math.random().toString(36).slice(2)}`, workspaceId, agentRunId: 'arun_esc', taskId: 'tsk_1', kind: 'escalation',
    details: 'Which source should the re-run trust?', status: 'pending', createdAt: new Date().toISOString(),
    optionsJson: { options: ['Pricing page', 'Uploaded quotes'], recommended: 0, rationale: 'price unverified' },
    ...extra,
  });
}

describe('escalation answers API', () => {
  it('answers with an option, validates, and conflicts once answered', async () => {
    const t = setup();
    const q = escalation(t.store, t.ws.id);
    const pending = await t.json('GET', `/api/workspaces/${t.ws.id}/requests?status=pending`);
    expect(pending.body[0]).toMatchObject({ kind: 'escalation', optionsJson: { options: ['Pricing page', 'Uploaded quotes'], recommended: 0 } });

    expect((await t.json('POST', `/api/requests/${q.id}/escalation-answer`, { choice: 7 })).status).toBe(400);
    expect((await t.json('POST', `/api/requests/${q.id}/escalation-answer`, { choice: 'a' })).status).toBe(400);
    expect((await t.json('POST', '/api/requests/ureq_nope/escalation-answer', { choice: 0 })).status).toBe(404);
    const ok = await t.json('POST', `/api/requests/${q.id}/escalation-answer`, { choice: 1, note: 'Q3 quote' });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ status: 'resolved', optionsJson: { choice: 1 } });
    expect(ok.body.response).toContain('Uploaded quotes');
    expect(t.seen.some((e) => e.type === 'user_request_resolved' && e.request.id === q.id)).toBe(true);
    expect((await t.json('POST', `/api/requests/${q.id}/escalation-answer`, { choice: 0 })).status).toBe(409);

    const approval = t.store.userRequests.insert({
      id: 'ureq_appr', workspaceId: t.ws.id, agentRunId: 'arun_1', kind: 'approval', details: 'x', status: 'pending', createdAt: '',
    });
    expect((await t.json('POST', `/api/requests/${approval.id}/escalation-answer`, { choice: 0 })).status).toBe(400);
    // Dismissing goes through the generic route.
    const q2 = escalation(t.store, t.ws.id);
    expect((await t.json('POST', `/api/requests/${q2.id}`, { status: 'denied' })).body.status).toBe('denied');
  });
});

describe('policy and bus event history API', () => {
  it('lists policy events tree-wide (or per workspace) and filters by role / kind', async () => {
    const t = setup();
    recordPolicyEvent(t.store, { workspaceId: t.child.id, role: 'worker', kind: 'approval_denied', action: 'request a demo' });
    recordPolicyEvent(t.store, { workspaceId: t.ws.id, role: 'orchestrator', kind: 'blocked', action: 'save_finding' });
    const other = createWorkspace(t.store, { name: 'Globex', sector: 'saas' });
    recordPolicyEvent(t.store, { workspaceId: other.id, role: 'worker', kind: 'approval_denied', action: 'OTHER' });

    const all = await t.json('GET', `/api/workspaces/${t.ws.id}/policy-events`);
    expect(all.body.map((e: { action: string }) => e.action)).toEqual(['request a demo', 'save_finding']);
    const own = await t.json('GET', `/api/workspaces/${t.ws.id}/policy-events?scope=workspace`);
    expect(own.body).toHaveLength(1);
    const workers = await t.json('GET', `/api/workspaces/${t.child.id}/policy-events?role=worker&kind=approval_denied`);
    expect(workers.body.map((e: { action: string }) => e.action)).toEqual(['request a demo']);
    expect((await t.json('GET', `/api/workspaces/${t.ws.id}/policy-events?kind=nope`)).status).toBe(400);
    expect((await t.json('GET', `/api/workspaces/${t.ws.id}/policy-events?role=nope`)).status).toBe(400);
    expect((await t.json('GET', '/api/workspaces/ws_nope/policy-events')).status).toBe(404);
  });

  it('pages persisted bus events', async () => {
    const t = setup();
    for (let i = 0; i < 3; i++) {
      persistBusEvent(t.store, { type: 'tool_call', workspaceId: t.ws.id, agentRunId: 'arun_1', tool: `t${i}`, ok: false, error: 'bad' });
    }
    persistBusEvent(t.store, { type: 'task_status', workspaceId: t.ws.id, taskId: 'tsk_1', status: 'failed' });
    const page = await t.json('GET', `/api/workspaces/${t.ws.id}/bus-events?type=tool_call&limit=2`);
    expect(page.body.map((e: { payload: { tool: string } }) => e.payload.tool)).toEqual(['t0', 't1']);
    const next = await t.json('GET', `/api/workspaces/${t.ws.id}/bus-events?type=tool_call&after=${page.body[1].seq}`);
    expect(next.body.map((e: { payload: { tool: string } }) => e.payload.tool)).toEqual(['t2']);
    const byTask = await t.json('GET', `/api/workspaces/${t.ws.id}/bus-events?taskId=tsk_1`);
    expect(byTask.body).toHaveLength(1);
    expect((await t.json('GET', `/api/workspaces/${t.ws.id}/bus-events?type=run_event`)).status).toBe(400);
    expect((await t.json('GET', `/api/workspaces/${t.ws.id}/bus-events?limit=x`)).status).toBe(400);
  });
});
