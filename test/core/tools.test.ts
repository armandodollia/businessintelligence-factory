import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { serve } from '@hono/node-server';
import type { AddressInfo } from 'node:net';
import { Hono } from 'hono';
import { afterEach, describe, expect, it } from 'vitest';
import { mountMcp } from '../../src/api/mcp.js';
import { defaultConfig } from '../../src/core/config/schema.js';
import { EventBus, type BusEvent } from '../../src/core/events.js';
import { ArtifactStore } from '../../src/core/evidence/artifacts.js';
import { openStore, type Store } from '../../src/core/store/db.js';
import { newId } from '../../src/core/store/repos.js';
import { createToolHandlers, getRunOutputs, resolveUserRequest, type ToolHandlerDeps } from '../../src/core/harness/tools/handlers.js';
import { ROLE_TOOLS, TOOL_NAMES } from '../../src/core/harness/tools/registry.js';
import { TokenRegistry, type RunContext } from '../../src/core/harness/tokens.js';
import type { Task } from '../../src/core/types.js';

const opened: Store[] = [];
afterEach(() => {
  for (const s of opened.splice(0)) s.close();
});

function setup(extra: Partial<ToolHandlerDeps> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'bif-tools-'));
  const dbPath = join(dir, 'bif.db');
  const store = openStore(dbPath);
  opened.push(store);
  const artifacts = new ArtifactStore(store, dir);
  const events = new EventBus();
  const seen: BusEvent[] = [];
  events.on((e) => seen.push(e));
  const deps: ToolHandlerDeps = { store, artifacts, config: defaultConfig, events, ...extra };
  const handle = createToolHandlers(deps);
  return { dir, dbPath, store, artifacts, events, seen, deps, handle };
}

function ctx(role: RunContext['role'], extra: Partial<RunContext> = {}): RunContext {
  return {
    agentRunId: newId('arun'),
    workspaceId: 'ws_a',
    role,
    model: { provider: 'claude', model: 'sonnet' },
    promptVersion: 'pv_1234',
    ...extra,
  };
}

function addTask(store: Store, workspaceId = 'ws_a'): Task {
  return store.tasks.insert({
    id: newId('tsk'), workspaceId, runId: 'run_1', phase: 'deep_dives', type: 'flow_walkthrough',
    brief: 'Walk signup', model: { provider: 'claude', model: 'sonnet' }, needsBrowser: true,
    acceptanceCriteria: ['screenshots per step'], status: 'running', round: 1, createdAt: new Date().toISOString(),
  });
}

const tick = () => new Promise((r) => setTimeout(r, 20));

describe('role scope table', () => {
  it('matches the brief', () => {
    const base = ['log_decision', 'save_artifact', 'request_user_action', 'request_approval'];
    expect(new Set(ROLE_TOOLS.reviewer)).toEqual(new Set(['log_decision', 'submit_review', 'read_artifact']));
    expect(new Set(ROLE_TOOLS.persona)).toEqual(new Set(['log_decision', 'submit_persona_feedback']));
    expect(new Set(ROLE_TOOLS.interviewer)).toEqual(new Set(['log_decision', 'update_profile', 'save_symptom']));
    expect(new Set(ROLE_TOOLS.worker)).toEqual(
      new Set([...base, 'save_finding', 'submit_result', 'respond_to_review', 'get_identity', 'save_persona']),
    );
    expect(new Set(ROLE_TOOLS.orchestrator)).toEqual(new Set([...base, 'propose_tasks']));
    expect(new Set(ROLE_TOOLS.synthesizer)).toEqual(
      new Set([...base, 'save_recommendation', 'save_finding', 'submit_result']),
    );
    for (const tools of Object.values(ROLE_TOOLS)) for (const t of tools) expect(TOOL_NAMES).toContain(t);
  });
});

describe('tool handlers', () => {
  it('save_finding rejects empty evidence', async () => {
    const { store, handle } = setup();
    const task = addTask(store);
    const r = await handle(ctx('worker', { taskId: task.id }), 'save_finding', {
      claim: 'c', subject: 's', criteria: { impact: 5 }, evidence: [],
    });
    expect(r.ok).toBe(false);
    expect(store.findings.list()).toHaveLength(0);
  });

  it('save_finding rejects artifact from other workspace', async () => {
    const { store, artifacts, handle } = setup();
    const task = addTask(store);
    const foreign = artifacts.save({ workspaceId: 'ws_b', kind: 'text', mime: 'text/plain', bytes: 'x' });
    const r = await handle(ctx('worker', { taskId: task.id }), 'save_finding', {
      claim: 'c', subject: 's', criteria: {}, evidence: [foreign.id],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain(foreign.id);
    expect(store.findings.list()).toHaveLength(0);
    expect(store.decisions.list()).toHaveLength(0);
  });

  it('save_finding stores finding and a score decision', async () => {
    const { store, artifacts, handle } = setup();
    const task = addTask(store);
    const a = artifacts.save({ workspaceId: 'ws_a', kind: 'text', mime: 'text/plain', bytes: 'pricing page' });
    const c = ctx('worker', { taskId: task.id });
    const r = await handle(c, 'save_finding', {
      claim: 'Acme hides pricing', subject: 'Acme', criteria: { impact: 7, confidence: 'high' }, evidence: [a.id],
    });
    expect(r.ok).toBe(true);
    const [f] = store.findings.list();
    expect(f).toMatchObject({ workspaceId: 'ws_a', runId: 'run_1', taskId: task.id, status: 'pending', evidence: [a.id] });
    const [d] = store.decisions.list();
    expect(d).toMatchObject({ kind: 'score', agentRunId: c.agentRunId, refs: [f!.id, a.id] });
  });

  it('rejects tool not in role scope', async () => {
    const { store, artifacts, handle, seen } = setup();
    const task = addTask(store);
    const a = artifacts.save({ workspaceId: 'ws_a', kind: 'text', mime: 'text/plain', bytes: 'x' });
    const r = await handle(ctx('reviewer', { taskId: task.id }), 'save_finding', {
      claim: 'c', subject: 's', criteria: {}, evidence: [a.id],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/not available to role 'reviewer'/);
    expect(store.findings.list()).toHaveLength(0);
    expect(seen).toContainEqual(expect.objectContaining({ type: 'tool_call', tool: 'save_finding', ok: false }));
    const unknown = await handle(ctx('worker'), 'no_such_tool' as never, {});
    expect(unknown.ok).toBe(false);
  });

  it('log_decision writes Decision with promptVersion', async () => {
    const { store, handle } = setup();
    const c = ctx('orchestrator');
    const r = await handle(c, 'log_decision', {
      what: 'Focus on pricing', why: 'interview says churn at checkout', alternatives: ['onboarding'],
      signals_positive: ['a'], signals_negative: [], confidence: 0.7,
    });
    expect(r.ok).toBe(true);
    const [d] = store.decisions.list({ agentRunId: c.agentRunId });
    expect(d).toMatchObject({
      kind: 'decision', role: 'orchestrator', promptVersion: 'pv_1234', model: c.model, workspaceId: 'ws_a',
      payload: expect.objectContaining({ tool: 'log_decision', what: 'Focus on pricing', confidence: 0.7 }),
    });
    const bad = await handle(c, 'log_decision', { what: 'x', why: 'y', confidence: 3 });
    expect(bad.ok).toBe(false);
    expect(store.decisions.list()).toHaveLength(1);
  });

  it('request_approval blocks until resolveUserRequest(approved)', async () => {
    const { store, events, handle, deps } = setup();
    const task = addTask(store);
    const c = ctx('worker', { taskId: task.id });
    let settled = false;
    const p = handle(c, 'request_approval', { action: 'request a demo', site: 'acme.test', details: 'demo form' }).then((r) => {
      settled = true;
      return r;
    });
    await tick();
    expect(settled).toBe(false);
    const [req] = store.userRequests.list({ status: 'pending' });
    expect(req).toMatchObject({ kind: 'approval', site: 'acme.test', taskId: task.id, agentRunId: c.agentRunId });
    expect(req!.details).toContain('request a demo');
    expect(store.tasks.get(task.id)!.status).toBe('waiting_user');
    resolveUserRequest({ store, events }, req!.id, 'resolved', 'go ahead');
    const r = await p;
    expect(r).toEqual({ ok: true, data: { requestId: req!.id, status: 'resolved', approved: true, response: 'go ahead' } });
    expect(store.userRequests.get(req!.id)!.status).toBe('resolved');
    expect(store.tasks.get(task.id)!.status).toBe('running');
    void deps;
  });

  it('request_user_action returns denied and stops waiting on abort', async () => {
    const { store, events, handle } = setup();
    const c = ctx('worker');
    const p = handle(c, 'request_user_action', { kind: 'register', site: 'acme.test', instructions: 'needs phone' });
    await tick();
    const [req] = store.userRequests.list();
    expect(req).toMatchObject({ kind: 'register', details: 'needs phone', taskId: '' });
    resolveUserRequest({ store, events }, req!.id, 'denied');
    expect(await p).toMatchObject({ ok: true, data: { status: 'denied', approved: false } });

    const ac = new AbortController();
    const p2 = handle(c, 'request_user_action', { kind: 'captcha', site: 's', instructions: 'i' }, { signal: ac.signal });
    await tick();
    ac.abort();
    expect(await p2).toMatchObject({ ok: false });
    expect(store.userRequests.list({ status: 'pending' })).toHaveLength(1); // stays pending for resume
    expect(() => resolveUserRequest({ store, events }, 'nope', 'resolved')).toThrow();
  });

  it('submit_result / submit_review / respond_to_review persist and read back via getRunOutputs', async () => {
    const { store, handle } = setup();
    const task = addTask(store);
    const worker = ctx('worker', { taskId: task.id });
    expect((await handle(worker, 'submit_result', { summary: 'done', steps: [1, 2] })).ok).toBe(true);
    expect(store.tasks.get(task.id)!.result).toEqual({ summary: 'done', steps: [1, 2] });

    const reviewer = ctx('reviewer', { taskId: task.id, model: { provider: 'codex', model: 'gpt-6.1-sol' } });
    expect((await handle(reviewer, 'submit_review', { score: 11, issues: [] })).ok).toBe(false);
    const rev = await handle(reviewer, 'submit_review', {
      score: 6,
      issues: [
        { class: 'blocking', description: 'missing step 3 screenshot' },
        { id: 'custom', class: 'nit', description: 'typo' },
      ],
    });
    expect(rev.ok).toBe(true);
    const out = getRunOutputs(store, reviewer.agentRunId);
    expect(out.review).toEqual({
      score: 6,
      issues: [
        { id: 'I1', class: 'blocking', description: 'missing step 3 screenshot' },
        { id: 'custom', class: 'nit', description: 'typo' },
      ],
    });
    expect(store.decisions.list({ agentRunId: reviewer.agentRunId })[0]!.kind).toBe('review');

    const revise = ctx('worker', { taskId: task.id });
    await handle(revise, 'respond_to_review', { issue_id: 'I1', action: 'fix', reason: 'added' });
    await handle(revise, 'respond_to_review', { issue_id: 'custom', action: 'pushback', reason: 'nit' });
    await handle(revise, 'submit_result', { summary: 'v2' });
    const o2 = getRunOutputs(store, revise.agentRunId);
    expect(o2.result).toEqual({ summary: 'v2' });
    expect(o2.review).toBeUndefined();
    expect(o2.responses).toEqual([
      { issueId: 'I1', action: 'fix', reason: 'added' },
      { issueId: 'custom', action: 'pushback', reason: 'nit' },
    ]);
    expect(store.decisions.list({ agentRunId: revise.agentRunId }).map((d) => d.kind)).toEqual([
      'decision', 'pushback', 'decision',
    ]);
    expect(getRunOutputs(store, worker.agentRunId).result).toEqual({ summary: 'done', steps: [1, 2] });
    expect(getRunOutputs(store, 'arun_none')).toEqual({ responses: [] });
  });

  it('save_artifact + read_artifact roundtrip, scoped to workspace', async () => {
    const { artifacts, handle } = setup();
    const c = ctx('worker');
    const r = await handle(c, 'save_artifact', {
      kind: 'text', content: 'Pricing: $49/mo', mime: 'text/plain', source_url: 'https://acme.test/pricing', flow: 'pricing', step: 1,
    });
    expect(r.ok).toBe(true);
    const id = (r as { data: { artifactId: string } }).data.artifactId;
    expect(artifacts.read(id).artifact).toMatchObject({ workspaceId: 'ws_a', sourceUrl: 'https://acme.test/pricing', step: 1 });
    const png = await handle(c, 'save_artifact', { kind: 'screenshot', content_base64: Buffer.from([1, 2, 3]).toString('base64'), mime: 'image/png' });
    expect(png.ok).toBe(true);
    expect((await handle(c, 'save_artifact', { kind: 'text', mime: 'text/plain' })).ok).toBe(false);

    const reviewer = ctx('reviewer');
    const read = await handle(reviewer, 'read_artifact', { artifact_id: id });
    expect(read).toMatchObject({ ok: true, data: { artifact: { id }, text: 'Pricing: $49/mo' } });
    const img = await handle(reviewer, 'read_artifact', { artifact_id: (png as { data: { artifactId: string } }).data.artifactId });
    expect(img).toMatchObject({ ok: true, images: [{ mimeType: 'image/png' }] });
    const other = await handle(ctx('reviewer', { workspaceId: 'ws_b' }), 'read_artifact', { artifact_id: id });
    expect(other.ok).toBe(false);
  });

  it('extra handlers: absent → not available; present → validated input + decision for judgments', async () => {
    const calls: unknown[] = [];
    const { store, handle } = setup({
      extraHandlers: {
        propose_tasks: async (_ctx, input) => {
          calls.push(input);
          return { ok: true, data: { accepted: 1, rejected: [] } };
        },
      },
    });
    const orch = ctx('orchestrator');
    const bad = await handle(orch, 'propose_tasks', { tasks: [{ type: 'nope' }] });
    expect(bad.ok).toBe(false);
    expect(calls).toHaveLength(0);
    const task = {
      type: 'news_scan', brief: 'scan news', model: { provider: 'claude', model: 'sonnet' },
      needs_browser: false, acceptance_criteria: ['3 sources'],
    };
    const ok = await handle(orch, 'propose_tasks', { tasks: [task] });
    expect(ok).toEqual({ ok: true, data: { accepted: 1, rejected: [] } });
    expect(calls).toEqual([{ tasks: [task] }]);
    expect(store.decisions.list({ agentRunId: orch.agentRunId })[0]).toMatchObject({
      kind: 'task_proposal', payload: { tool: 'propose_tasks', input: { tasks: [task] }, result: { accepted: 1, rejected: [] } },
    });
    const missing = await handle(ctx('worker'), 'get_identity', { site: 'acme.test' });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error).toMatch(/not available/);
  });
});

describe('tokens', () => {
  it('rejects unknown token; resolves after store reopen; revoke', () => {
    const { store, dbPath } = setup();
    const tokens = new TokenRegistry(store);
    expect(tokens.resolve('nope')).toBeNull();
    const c = ctx('worker', { taskId: 'tsk_1' });
    const token = tokens.issue(c);
    expect(tokens.resolve(token)).toEqual(c);
    const row = store.agentRuns.get(c.agentRunId)!;
    expect(row).toMatchObject({ token, status: 'running', role: 'worker', promptVersion: 'pv_1234' });
    store.close();

    const store2 = openStore(dbPath);
    opened.push(store2);
    const tokens2 = new TokenRegistry(store2);
    expect(tokens2.resolve(token)).toEqual(c);
    tokens2.revoke(token);
    expect(tokens2.resolve(token)).toBeNull();
    // finished runs never resolve, even from a fresh registry
    store2.agentRuns.update(c.agentRunId, { status: 'done' });
    expect(new TokenRegistry(store2).resolve(token)).toBeNull();
  });
});

describe('mcp server', () => {
  async function connect(app: Hono, token: string) {
    const client = new Client({ name: 'test', version: '0.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(`http://bif.local/mcp/${token}`), {
      fetch: async (url, init) => app.fetch(new Request(url, init)),
    });
    await client.connect(transport);
    return client;
  }

  it('tools/list for reviewer returns exactly its 3 tools', async () => {
    const s = setup();
    const tokens = new TokenRegistry(s.store);
    const app = new Hono();
    mountMcp(app, { tokens, handle: s.handle });
    const reviewer = ctx('reviewer');
    const client = await connect(app, tokens.issue(reviewer));
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(['log_decision', 'read_artifact', 'submit_review']);
    const review = tools.find((t) => t.name === 'submit_review')!;
    expect(review.inputSchema.type).toBe('object');
    expect(review.inputSchema.properties).toHaveProperty('score');

    const res = await client.callTool({
      name: 'log_decision',
      arguments: { what: 'w', why: 'y', alternatives: [], signals_positive: [], signals_negative: [], confidence: 0.5 },
    });
    expect(res.isError).toBeFalsy();
    expect(s.store.decisions.list({ agentRunId: reviewer.agentRunId })).toHaveLength(1);
    const denied = await client.callTool({ name: 'save_finding', arguments: {} });
    expect(denied.isError).toBe(true);
    await client.close();

    const worker = await connect(app, tokens.issue(ctx('worker')));
    expect((await worker.listTools()).tools).toHaveLength(ROLE_TOOLS.worker.length);
    await worker.close();
  });

  it('unknown token is rejected at the HTTP layer', async () => {
    const s = setup();
    const app = new Hono();
    mountMcp(app, { tokens: new TokenRegistry(s.store), handle: s.handle });
    await expect(connect(app, 'tok_unknown')).rejects.toThrow();
    const res = await app.fetch(
      new Request('http://bif.local/mcp/tok_unknown', {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      }),
    );
    expect(res.status).toBe(401);
  });

  it('blocking request_approval over a real HTTP server stays open until resolved', async () => {
    const s = setup();
    const tokens = new TokenRegistry(s.store);
    const app = new Hono();
    mountMcp(app, { tokens, handle: s.handle });
    const server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' });
    await new Promise((r) => server.once('listening', r));
    const { port } = server.address() as AddressInfo;
    try {
      const client = new Client({ name: 'test', version: '0.0.0' });
      await client.connect(
        new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp/${tokens.issue(ctx('worker'))}`)),
      );
      const call = client.callTool({ name: 'request_approval', arguments: { action: 'request a demo', site: 's', details: 'd' } });
      await new Promise((r) => setTimeout(r, 300));
      const [req] = s.store.userRequests.list({ status: 'pending' });
      expect(req).toBeDefined();
      resolveUserRequest(s, req!.id, 'resolved', 'ok');
      const res = await call;
      expect(res.isError).toBeFalsy();
      expect(JSON.parse((res.content as Array<{ text: string }>)[0]!.text)).toMatchObject({ approved: true, response: 'ok' });
      await client.close();
    } finally {
      server.close();
    }
  });
});
