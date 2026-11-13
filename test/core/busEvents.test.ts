import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BusEvent } from '../../src/core/events.js';
import type { Store } from '../../src/core/store/db.js';
import { newId } from '../../src/core/store/repos.js';
import { listBusEvents, persistBusEvent, pruneBusEvents } from '../../src/core/telemetry/busEvents.js';
import { createOtlpExporter, toOtlpLogRecord } from '../../src/core/telemetry/otlp.js';
import { attachEventRecorders, type EventRecorders } from '../../src/core/telemetry/recorders.js';
import { researchSetup, review, submitWork, addTask, tick } from './helpers/research.js';
import { learningRepos } from '../../src/core/learning/store.js';
import { runTaskWithReview } from '../../src/core/research/reviewLoop.js';
import { MIGRATIONS } from '../../src/core/store/migrations.js';

const opened: Store[] = [];
const recorders: EventRecorders[] = [];
afterEach(async () => {
  for (const r of recorders.splice(0)) await r.stop();
  for (const s of opened.splice(0)) s.close();
});

const ctx = { workspaceId: 'ws_a', role: 'worker' as const, model: { provider: 'claude' as const, model: 'sonnet' }, promptVersion: 'v1' };

describe('migration 17', () => {
  it('adds options_json, policy_events and bus_events (latest migration)', () => {
    const s = researchSetup(opened);
    expect(s.store.schemaVersion()).toBe(MIGRATIONS.length);
    const cols = (t: string) => (s.store.db.prepare(`PRAGMA table_info(${t})`).all() as Array<{ name: string }>).map((c) => c.name);
    expect(cols('user_requests')).toContain('options_json');
    expect(cols('policy_events')).toEqual(expect.arrayContaining(['root_workspace_id', 'role', 'kind', 'action', 'request_id']));
    expect(cols('bus_events')).toEqual(expect.arrayContaining(['seq', 'workspace_id', 'type', 'payload', 'created_at']));
  });
});

describe('bus event persistence', () => {
  it('persists tool-call errors and status events but not run events or decisions (stored elsewhere)', async () => {
    const s = researchSetup(opened, {
      pick: (r) => (r.kind === 'work' ? submitWork() : review(9)),
    });
    recorders.push(attachEventRecorders({ store: s.store, events: s.events, config: s.config }));
    const run = { ...ctx, agentRunId: newId('arun') };
    s.tokens.issue(run);
    // Tool-call validation error: only ever visible on SSE before migration 17.
    const bad = await s.handle(run, 'save_finding', { claim: 'x' });
    expect(bad.ok).toBe(false);
    const task = addTask(s.store);
    await runTaskWithReview(task, s.deps);

    const all = listBusEvents(s.store, { workspaceId: 'ws_a', limit: 1000 });
    const types = new Set(all.map((e) => e.type));
    expect(types).toEqual(new Set(['tool_call', 'run_status', 'task_status']));
    const err = listBusEvents(s.store, { workspaceId: 'ws_a', type: 'tool_call', agentRunId: run.agentRunId });
    expect(err).toHaveLength(1);
    expect(err[0]!.payload).toMatchObject({ type: 'tool_call', tool: 'save_finding', ok: false });
    expect(String((err[0]!.payload as { error: string }).error)).toMatch(/invalid input for save_finding/);
    expect(listBusEvents(s.store, { workspaceId: 'ws_a', taskId: task.id, type: 'task_status' })[0]!.payload).toMatchObject({ status: 'verified' });
    // Paging by sequence number.
    const first = listBusEvents(s.store, { workspaceId: 'ws_a', limit: 2 });
    const next = listBusEvents(s.store, { workspaceId: 'ws_a', afterSeq: first[1]!.seq, limit: 2 });
    expect(next[0]!.seq).toBeGreaterThan(first[1]!.seq);
    expect(listBusEvents(s.store, { workspaceId: 'ws_other' })).toEqual([]);
  });

  it('integration: stores references only — usage, review issues, outcomes and decisions stay in their own tables', async () => {
    const s = researchSetup(opened, {
      config: (c) => (c.loop.maxRounds = 1),
      pick: (r) => (r.kind === 'work' ? submitWork() : review(4, [{ class: 'substantive', description: 'REVIEW ISSUE TEXT no source' }])),
    });
    recorders.push(attachEventRecorders({ store: s.store, events: s.events, config: s.config }));
    const task = addTask(s.store);
    await runTaskWithReview(task, s.deps);
    // WP-B usage arrives as a run_event (stored in agent_usage), never as a bus_events row.
    s.events.emit({ type: 'run_event', workspaceId: 'ws_a', agentRunId: 'arun_u', event: { t: 'usage', inputTokens: 123456, outputTokens: 1 } as never });
    expect(learningRepos(s.store).reviewIssues.list({ taskId: task.id }).map((r) => r.text)).toContain('REVIEW ISSUE TEXT no source');
    expect(learningRepos(s.store).decisionOutcomes.list({ taskId: task.id }).length).toBeGreaterThan(0);
    const all = listBusEvents(s.store, { workspaceId: 'ws_a', limit: 1000 });
    expect([...new Set(all.map((e) => e.type))].sort()).toEqual(['run_status', 'task_status', 'tool_call']);
    const dump = JSON.stringify(all);
    expect(dump).not.toContain('REVIEW ISSUE TEXT');
    expect(dump).not.toContain('123456');
    const allowed: Record<string, string[]> = {
      run_status: ['type', 'workspaceId', 'agentRunId', 'taskId', 'status', 'exitCode', 'reason'],
      task_status: ['type', 'workspaceId', 'taskId', 'status'],
      tool_call: ['type', 'workspaceId', 'agentRunId', 'tool', 'ok', 'error'],
    };
    for (const e of all) for (const k of Object.keys(e.payload)) expect(allowed[e.type]).toContain(k);
  });

  it('keeps user requests as ids only and redacts identity secrets', () => {
    const s = researchSetup(opened);
    s.store.identities.insert({
      id: 'idn_1', workspaceId: 'ws_a', site: 'x.com', name: 'n', email: 'e@x', password: 'hunter2-secret', createdAt: new Date().toISOString(),
    });
    persistBusEvent(s.store, { type: 'tool_call', workspaceId: 'ws_a', agentRunId: 'arun_1', tool: 'x', ok: false, error: 'bad hunter2-secret' });
    persistBusEvent(s.store, {
      type: 'user_request', workspaceId: 'ws_a',
      request: { id: 'ureq_1', workspaceId: 'ws_a', agentRunId: 'arun_1', kind: 'login', details: 'TOP SECRET DETAILS', status: 'pending', createdAt: '' },
    });
    const rows = listBusEvents(s.store, { workspaceId: 'ws_a' });
    expect(JSON.stringify(rows)).not.toContain('hunter2-secret');
    expect(JSON.stringify(rows)).not.toContain('TOP SECRET DETAILS');
    expect(rows[1]!.payload).toMatchObject({ requestId: 'ureq_1', kind: 'login', status: 'pending' });
    expect(persistBusEvent(s.store, { type: 'decision', workspaceId: 'ws_a', decision: {} as never })).toBeUndefined();
  });

  it('prunes rows older than the retention window', () => {
    const s = researchSetup(opened);
    const now = Date.parse('2026-11-13T00:00:00Z');
    persistBusEvent(s.store, { type: 'task_status', workspaceId: 'ws_a', taskId: 't1', status: 'failed' }, new Date(now - 40 * 86_400_000));
    persistBusEvent(s.store, { type: 'task_status', workspaceId: 'ws_a', taskId: 't2', status: 'failed' }, new Date(now - 1 * 86_400_000));
    expect(pruneBusEvents(s.store, 0, new Date(now))).toBe(0);
    expect(pruneBusEvents(s.store, 30, new Date(now))).toBe(1);
    expect(listBusEvents(s.store, { workspaceId: 'ws_a' }).map((e) => e.taskId)).toEqual(['t2']);
  });
});

describe('OTLP export', () => {
  it('maps bus events to OTLP log records without free text', () => {
    const rec = toOtlpLogRecord(
      { type: 'run_event', workspaceId: 'ws_a', agentRunId: 'arun_1', taskId: 't1', event: { t: 'message', text: 'UPLOAD DERIVED TEXT' } },
      new Date('2026-11-13T00:00:00Z'),
    );
    expect(rec.timeUnixNano).toBe(String(Date.parse('2026-11-13T00:00:00Z') * 1_000_000));
    expect(JSON.stringify(rec)).not.toContain('UPLOAD DERIVED TEXT');
    const attrs = Object.fromEntries(rec.attributes.map((a) => [a.key, a.value]));
    expect(attrs['bif.event.type']).toEqual({ stringValue: 'run_event' });
    expect(attrs['bif.run_event.t']).toEqual({ stringValue: 'message' });
    expect(attrs['bif.task_id']).toEqual({ stringValue: 't1' });
    const err = toOtlpLogRecord({ type: 'tool_call', workspaceId: 'ws_a', agentRunId: 'a', tool: 'save_finding', ok: false, error: 'invalid' });
    expect(err.severityText).toBe('ERROR');
  });

  it('batches events to <endpoint>/v1/logs with the configured headers', async () => {
    const fetch = vi.fn(async (_url: string, _init: RequestInit) => new Response('{}'));
    const exp = createOtlpExporter({ endpoint: 'http://collector:4318/', headers: { authorization: 'Bearer t' }, fetch, batchMs: 5 });
    const e: BusEvent = { type: 'task_status', workspaceId: 'ws_a', taskId: 't1', status: 'verified' };
    exp.push(e);
    exp.push(e);
    await exp.flush();
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe('http://collector:4318/v1/logs');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer t');
    const body = JSON.parse(String(init.body));
    expect(body.resourceLogs[0].resource.attributes[0]).toEqual({ key: 'service.name', value: { stringValue: 'bif' } });
    expect(body.resourceLogs[0].scopeLogs[0].logRecords).toHaveLength(2);
    await exp.close();
  });

  it('is off unless telemetry.otlp.enabled; export failures never break the bus', async () => {
    const s = researchSetup(opened);
    const fetch = vi.fn(async () => {
      throw new Error('collector down');
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const off = attachEventRecorders({ store: s.store, events: s.events, config: s.config, fetch });
    s.events.emit({ type: 'task_status', workspaceId: 'ws_a', taskId: 't1', status: 'failed' });
    await off.stop();
    expect(fetch).not.toHaveBeenCalled();

    s.config.telemetry = { otlp: { enabled: true, endpoint: 'http://127.0.0.1:4318' } };
    const on = attachEventRecorders({ store: s.store, events: s.events, config: s.config, fetch, otlpBatchMs: 5 });
    s.events.emit({ type: 'task_status', workspaceId: 'ws_a', taskId: 't1', status: 'failed' });
    await tick(30);
    await on.stop();
    expect(fetch).toHaveBeenCalled();
    warn.mockRestore();
  });
});
