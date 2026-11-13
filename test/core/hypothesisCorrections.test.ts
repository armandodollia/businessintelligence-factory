import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { BusEvent } from '../../src/core/events.js';
import type { RunContext } from '../../src/core/harness/tokens.js';
import { runTaskWithReview } from '../../src/core/research/reviewLoop.js';
import { researchToolHandlers } from '../../src/core/research/tools.js';
import type { Store } from '../../src/core/store/db.js';
import { newId } from '../../src/core/store/repos.js';
import { addTask, researchSetup, review, revise } from './helpers/research.js';

const opened: Store[] = [];
afterEach(() => {
  for (const s of opened.splice(0)) s.close();
});

function setup() {
  const t = researchSetup(opened, { dir: mkdtempSync(join(tmpdir(), 'bif-hyp-')), extraHandlers: () => researchToolHandlers() });
  t.store.workspaces.insert({ id: 'ws_a', name: 'Acme', sector: 'saas', createdAt: 'now' });
  t.store.symptoms.insert({ id: 'sym_1', workspaceId: 'ws_a', kind: 'symptom', title: 'renewals down', detail: 'd', criteria: {}, evidence: [] });
  return t;
}

const ctx = (extra: Partial<RunContext> = {}): RunContext => ({
  agentRunId: newId('arun'), workspaceId: 'ws_a', role: 'worker', model: { provider: 'claude', model: 'sonnet' }, promptVersion: 'pv', ...extra,
});

const competitor = (evidence: string[], threat = 4) => ({
  name: 'Globex', threat, directness: 5, comparison: { pricing: 2, onboarding: 4, ux: 3, features: 5 }, evidence,
});

describe('save_hypothesis corrections', () => {
  it('round-2 correction (confidence 20, new evidence) is persisted and verified with those values', async () => {
    const t = setup();
    const a1 = t.artifacts.save({ workspaceId: 'ws_a', kind: 'text', mime: 'text/plain', bytes: 'old source' });
    const a2 = t.artifacts.save({ workspaceId: 'ws_a', kind: 'text', mime: 'text/plain', bytes: 'new source' });
    let reviews = 0;
    t.state.pick = (r) => {
      if (r.kind === 'work') {
        return async (tools) => {
          await tools.call('save_hypothesis', { symptom_id: 'sym_1', hypothesis: 'Price rise drove churn', confidence: 80, evidence: [a1.id] });
          await tools.call('submit_result', { summary: 'v1' });
        };
      }
      if (r.kind === 'review') return review(++reviews === 1 ? 4 : 9, [{ class: 'substantive', description: 'confidence too high' }]);
      return async (tools) => {
        const res = (await tools.call('save_hypothesis', {
          symptom_id: 'sym_1', hypothesis: 'price rise drove churn', confidence: 20, evidence: [a2.id],
        })) as { duplicate?: boolean; revised?: boolean };
        expect(res).toMatchObject({ duplicate: true, revised: true });
        await revise('fix', { summary: 'v2' }, false)(r)(tools);
      };
    };
    const task = addTask(t.store, { workspaceId: 'ws_a', type: 'symptom_hypotheses', phase: 'synthesis' });
    expect((await runTaskWithReview(task, t.deps)).status).toBe('verified');
    const [h] = t.store.symptomHypotheses.list();
    expect(t.store.symptomHypotheses.list()).toHaveLength(1);
    expect(h).toMatchObject({ confidence: 20, evidence: [a2.id], status: 'verified', taskRound: 2 });
    const decisions = t.store.decisions.list({ workspaceId: 'ws_a', kind: 'score' }).filter((d) => (d.payload as { tool?: string }).tool === 'save_hypothesis');
    expect(decisions).toHaveLength(2);
    expect(decisions[1]!.payload).toMatchObject({ confidence: 20, revision: true, previous: { confidence: 80, evidence: [a1.id] } });
    // The round-2 reviewer sees the corrected values.
    expect(t.requests.filter((r) => r.kind === 'review')[1]!.prompt).toMatch(/price rise drove churn \(confidence 20%; evidence: art_/i);
  });

  it('an unchanged replay stays a plain duplicate (no new decision)', async () => {
    const t = setup();
    const a1 = t.artifacts.save({ workspaceId: 'ws_a', kind: 'text', mime: 'text/plain', bytes: 'src' });
    const task = addTask(t.store, { workspaceId: 'ws_a', type: 'symptom_hypotheses', phase: 'synthesis' });
    const c = ctx({ taskId: task.id });
    const input = { symptom_id: 'sym_1', hypothesis: 'h', confidence: 50, evidence: [a1.id] };
    expect((await t.handle(c, 'save_hypothesis', input)).ok).toBe(true);
    const again = await t.handle(c, 'save_hypothesis', input);
    expect(again).toMatchObject({ ok: true, data: { duplicate: true } });
    expect((again as { data: { revised?: boolean } }).data.revised).toBeUndefined();
    expect(t.store.decisions.list({ agentRunId: c.agentRunId })).toHaveLength(1);
  });
});

describe('competitor ownership', () => {
  it('without an owning task a competitor is unverified', async () => {
    const t = setup();
    const art = t.artifacts.save({ workspaceId: 'ws_a', kind: 'text', mime: 'text/plain', bytes: 'pricing' });
    expect((await t.handle(ctx(), 'save_competitor', competitor([art.id]))).ok).toBe(true);
    expect(t.store.competitors.list()[0]).toMatchObject({ status: 'unverified' });
    expect(t.store.competitors.list()[0]!.taskId).toBeUndefined();
  });

  it('unchanged re-save by another task keeps the verified owner and status; a changed one takes over', async () => {
    const t = setup();
    const art = t.artifacts.save({ workspaceId: 'ws_a', kind: 'text', mime: 'text/plain', bytes: 'pricing' });
    const first = addTask(t.store, { workspaceId: 'ws_a', type: 'discover_competitors', phase: 'competitor_discovery' });
    await t.handle(ctx({ taskId: first.id }), 'save_competitor', competitor([art.id]));
    const id = t.store.competitors.list()[0]!.id;
    t.store.competitors.update(id, { status: 'verified' });
    const second = addTask(t.store, { workspaceId: 'ws_a', type: 'flow_walkthrough', phase: 'deep_dives' });
    await t.handle(ctx({ taskId: second.id }), 'save_competitor', competitor([art.id]));
    expect(t.store.competitors.get(id)).toMatchObject({ taskId: first.id, status: 'verified' });
    await t.handle(ctx({ taskId: second.id }), 'save_competitor', competitor([art.id], 2));
    expect(t.store.competitors.get(id)).toMatchObject({ taskId: second.id, status: 'pending', threat: 2 });
  });
});

describe('task_status event', () => {
  it('is emitted when a task finishes its review loop', async () => {
    const t = setup();
    t.state.pick = (r) => (r.kind === 'work' ? async (tools) => void (await tools.call('submit_result', { summary: 'x' })) : review(9));
    const task = addTask(t.store, { workspaceId: 'ws_a' });
    await runTaskWithReview(task, t.deps);
    const ev = t.seen.filter((e): e is Extract<BusEvent, { type: 'task_status' }> => e.type === 'task_status');
    expect(ev).toEqual([{ type: 'task_status', workspaceId: 'ws_a', taskId: task.id, status: 'verified' }]);
  });
});
