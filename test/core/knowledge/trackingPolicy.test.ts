/**
 * KS-6 (design §13 "WP-D"): blocked knowledge reads become `policy_events` rows; the `retrieval` and
 * `policy_blocked` bus events are persisted in `bus_events`, the retrieval as its id only.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { listPolicyEvents, policyDenialsSection } from '../../../src/core/policy/policyEvents.js';
import type { Store } from '../../../src/core/store/db.js';
import { newId } from '../../../src/core/store/repos.js';
import { listBusEvents } from '../../../src/core/telemetry/busEvents.js';
import { attachEventRecorders, type EventRecorders } from '../../../src/core/telemetry/recorders.js';
import type { Role } from '../../../src/core/types.js';
import { ks4, T0 } from './ks4fixture.js';

const opened: Store[] = [];
const recorders: EventRecorders[] = [];
afterEach(async () => {
  for (const r of recorders.splice(0)) await r.stop();
  for (const s of opened.splice(0)) s.close();
});

function setup() {
  const t = ks4(opened);
  recorders.push(attachEventRecorders({ store: t.store, events: t.events, config: t.config }));
  const run = (workspaceId: string, role: Role, taskId?: string) => {
    const c = t.ctx(workspaceId, role, taskId ? { taskId } : {});
    t.store.agentRuns.insert({
      id: c.agentRunId, workspaceId, role, model: c.model, token: c.agentRunId, status: 'running', startedAt: T0, promptVersion: 'pv_ks4',
      ...(taskId ? { taskId } : {}),
    });
    return c;
  };
  const task = () =>
    t.store.tasks.insert({
      id: newId('tsk'), workspaceId: 'ws_a', runId: 'rrun_1', phase: 'deep_dives', type: 'news_scan', brief: 'b', model: { provider: 'claude', model: 'sonnet' },
      needsBrowser: false, acceptanceCriteria: ['c'], status: 'reviewing', round: 1, createdAt: T0,
    });
  return { ...t, run, task };
}

describe('blocked knowledge reads are policy events (KS-6)', () => {
  it('out-of-slice (reviewer) and out-of-tree (worker) attempts are recorded once each, with role and task', async () => {
    const t = setup();
    const tk = t.task();
    const unrelated = t.fact('ws_a', 'Acme was founded in 1999');
    const foreign = t.fact('ws_b', 'Beta was founded in 2001');
    const reviewer = t.run('ws_a', 'reviewer', tk.id);
    expect((await t.handle(reviewer, 'expand', { id: unrelated.id })).ok).toBe(false);
    const worker = t.run('ws_a', 'worker');
    expect(await t.handle(worker, 'expand', { id: foreign.id })).toEqual({ ok: false, error: `item '${foreign.id}' not found` });
    // An unknown id is not an attempt on anything.
    expect((await t.handle(worker, 'expand', { id: 'fnd_01AAAAAAAAAAAAAAAAAAAAAAAA' })).ok).toBe(false);

    const rows = listPolicyEvents(t.store, { workspaceId: 'ws_a' });
    expect(rows.map((r) => [r.kind, r.action, r.site, r.role, r.agentRunId, r.taskId ?? null])).toEqual([
      ['blocked', 'expand', 'knowledge:out_of_slice', 'reviewer', reviewer.agentRunId, tk.id],
      ['blocked', 'expand', 'knowledge:out_of_tree', 'worker', worker.agentRunId, null],
    ]);
    expect(rows.every((r) => r.rootWorkspaceId === 'ws_a')).toBe(true);
    // Nothing lands in the other tree's history.
    expect(listPolicyEvents(t.store, { workspaceId: 'ws_b' })).toEqual([]);
  });

  it('agents are reminded of out-of-slice blocks, never of out-of-tree ones (that would confirm the id exists)', async () => {
    const t = setup();
    const tk = t.task();
    const unrelated = t.fact('ws_a', 'Acme was founded in 1999');
    const foreign = t.fact('ws_b', 'Beta was founded in 2001');
    await t.handle(t.run('ws_a', 'reviewer', tk.id), 'expand', { id: unrelated.id });
    await t.handle(t.run('ws_a', 'worker'), 'expand', { id: foreign.id });
    expect(policyDenialsSection(t.store, 'ws_a', 'reviewer')).toContain('outside the task\'s review slice');
    expect(policyDenialsSection(t.store, 'ws_a', 'worker')).toBe('');
  });
});

describe('bus_events persistence of knowledge events (KS-6)', () => {
  it('a retrieval is stored as its id only; a blocked read with its reason', async () => {
    const t = setup();
    t.fact('ws_a', 'Acme Pro costs 49 dollars per seat');
    const foreign = t.fact('ws_b', 'Beta secret plan');
    const w = t.run('ws_a', 'worker');
    await t.call(w, 'search', { query: 'Pro seat' });
    await t.handle(w, 'expand', { id: foreign.id });
    const [ret] = t.rows(w.agentRunId);
    const stored = listBusEvents(t.store, { workspaceId: 'ws_a' }).filter((e) => e.type === 'retrieval' || e.type === 'policy_blocked');
    expect(stored.map((e) => e.type)).toEqual(['retrieval', 'policy_blocked']);
    expect(stored[0]!.payload).toEqual({ type: 'retrieval', workspaceId: 'ws_a', retrievalEventId: ret!.id });
    expect(stored[0]!.agentRunId).toBe(w.agentRunId);
    // No second copy of the retrieval payload (query, results, tokens).
    expect(JSON.stringify(stored[0]!.payload)).not.toMatch(/Pro seat|resultIds|tokens/);
    expect(stored[1]!.payload).toMatchObject({ tool: 'expand', itemId: foreign.id, reason: 'out_of_tree' });
  });
});
