import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { BusEvent } from '../../src/core/events.js';
import type { FakeScript } from '../../src/core/harness/adapter.js';
import type { RunContext } from '../../src/core/harness/tokens.js';
import { uploadInternal } from '../../src/core/internal/uploads.js';
import { resumeInterrupted } from '../../src/core/research/orchestrator.js';
import { runTaskWithReview } from '../../src/core/research/reviewLoop.js';
import { researchToolHandlers } from '../../src/core/research/tools.js';
import { exportTrainingData } from '../../src/core/scoring/export.js';
import type { Store } from '../../src/core/store/db.js';
import { newId } from '../../src/core/store/repos.js';
import type { Task } from '../../src/core/types.js';
import { addTask, researchSetup, review, revise } from './helpers/research.js';

const opened: Store[] = [];
afterEach(() => {
  for (const s of opened.splice(0)) s.close();
});

function setup() {
  const t = researchSetup(opened, { dir: mkdtempSync(join(tmpdir(), 'bif-xtask-')), extraHandlers: () => researchToolHandlers() });
  t.store.workspaces.insert({ id: 'ws_a', name: 'Acme', sector: 'saas', createdAt: 'now' });
  t.store.symptoms.insert({ id: 'sym_1', workspaceId: 'ws_a', kind: 'symptom', title: 'renewals down', detail: 'd', criteria: {}, evidence: [] });
  const upload = uploadInternal('ws_a', { name: 'kpis.csv', bytes: new TextEncoder().encode('secret kpis'), mime: 'text/csv' }, t);
  return { ...t, upload };
}

const ctx = (extra: Partial<RunContext> = {}): RunContext => ({
  agentRunId: newId('arun'), workspaceId: 'ws_a', role: 'worker', model: { provider: 'claude', model: 'sonnet' }, promptVersion: 'pv', ...extra,
});

const competitor = (evidence: string[]) => ({
  name: 'Globex', threat: 4, directness: 5, comparison: { pricing: 2, onboarding: 4, ux: 3, features: 5 }, evidence,
});

async function runWith(t: ReturnType<typeof setup>, extra: Partial<Task>, work: FakeScript, result: Record<string, unknown>) {
  t.state.pick = (r) =>
    r.kind === 'work'
      ? async (tools) => {
          await work(tools);
          await tools.call('submit_result', result);
        }
      : review(9);
  return runTaskWithReview(addTask(t.store, { workspaceId: 'ws_a', ...extra }), t.deps);
}

describe('cross-task provenance', () => {
  it('unchanged re-save of another task\'s upload-backed competitor keeps ownership but excludes the deliverable from export', async () => {
    const t = setup();
    const first = await runWith(t, { type: 'discover_competitors', phase: 'competitor_discovery' }, async (tools) => {
      await tools.call('save_competitor', competitor([t.upload.id]));
    }, { summary: 'first' });
    const cmp = t.store.competitors.list()[0]!;
    expect(cmp).toMatchObject({ taskId: first.id, status: 'verified' });
    // A second task re-saves it unchanged, citing only the upload it saw via the competitor (not in its own text).
    await runWith(t, { type: 'flow_walkthrough', phase: 'deep_dives' }, async (tools) => {
      await tools.call('save_competitor', competitor([t.upload.id]));
    }, { summary: 'SECRET_REUSE_TEXT' });
    expect(t.store.competitors.get(cmp.id)).toMatchObject({ taskId: first.id, status: 'verified' });
    expect(exportTrainingData('ws_a', t)).not.toContain('SECRET_REUSE_TEXT');
    expect(exportTrainingData('ws_a', t, true)).toContain('SECRET_REUSE_TEXT');
  });

  it('a deliverable citing another task\'s upload-backed hypothesis or finding by id is excluded', async () => {
    const t = setup();
    const fid = newId('fnd');
    t.store.findings.insert({
      id: fid, workspaceId: 'ws_a', runId: 'r', taskId: 'tsk_other', subject: 'Acme', claim: 'renewals -12%', criteria: {},
      evidence: [t.upload.id], status: 'verified', createdAt: 'now',
    });
    const owner = addTask(t.store, { workspaceId: 'ws_a', type: 'symptom_hypotheses', phase: 'synthesis' });
    const h = await t.handle(ctx({ taskId: owner.id }), 'save_hypothesis', { symptom_id: 'sym_1', hypothesis: 'price rise', confidence: 60, evidence: [t.upload.id] });
    const hid = (h as { data: { hypothesisId: string } }).data.hypothesisId;
    await runWith(t, {}, async () => {}, { summary: 'SECRET_CITES_HYP', basedOn: [hid] });
    await runWith(t, {}, async () => {}, { summary: 'SECRET_CITES_FINDING', basedOn: [fid] });
    const out = exportTrainingData('ws_a', t);
    expect(out).not.toContain('SECRET_CITES_HYP');
    expect(out).not.toContain('SECRET_CITES_FINDING');
  });

  it('provenance is sticky: a hypothesis corrected from upload to public evidence still excludes the round-2 deliverable', async () => {
    const t = setup();
    const pub = t.artifacts.save({ workspaceId: 'ws_a', kind: 'text', mime: 'text/plain', bytes: 'public article' });
    let reviews = 0;
    t.state.pick = (r) => {
      if (r.kind === 'work') {
        return async (tools) => {
          await tools.call('save_hypothesis', { symptom_id: 'sym_1', hypothesis: 'price rise', confidence: 70, evidence: [t.upload.id] });
          await tools.call('submit_result', { summary: 'SECRET_ROUND1' });
        };
      }
      if (r.kind === 'review') return review(++reviews === 1 ? 4 : 9, [{ class: 'substantive', description: 'cite public sources' }]);
      return async (tools) => {
        await tools.call('save_hypothesis', { symptom_id: 'sym_1', hypothesis: 'price rise', confidence: 40, evidence: [pub.id] });
        await revise('fix', { summary: 'SECRET_ROUND2' }, false)(r)(tools);
      };
    };
    const task = addTask(t.store, { workspaceId: 'ws_a', type: 'symptom_hypotheses', phase: 'synthesis' });
    expect((await runTaskWithReview(task, t.deps)).status).toBe('verified');
    expect(t.store.symptomHypotheses.list()[0]!.evidence).toEqual([pub.id]);
    const out = exportTrainingData('ws_a', t);
    expect(out).not.toContain('SECRET_ROUND1');
    expect(out).not.toContain('SECRET_ROUND2');
  });
});

describe('reuse records in the export', () => {
  it('a rating after an unchanged reuse attaches to the original score decision; reuse records are deduped and not exported', async () => {
    const t = setup();
    const pub = t.artifacts.save({ workspaceId: 'ws_a', kind: 'text', mime: 'text/plain', bytes: 'public pricing page' });
    const first = addTask(t.store, { workspaceId: 'ws_a', type: 'discover_competitors', phase: 'competitor_discovery' });
    await t.handle(ctx({ taskId: first.id }), 'save_competitor', competitor([pub.id]));
    const cmp = t.store.competitors.list()[0]!;
    t.store.competitors.update(cmp.id, { status: 'verified' });
    const original = t.store.decisions.list({ workspaceId: 'ws_a', kind: 'score' })[0]!;

    const second = addTask(t.store, { workspaceId: 'ws_a', type: 'flow_walkthrough', phase: 'deep_dives' });
    const reuser = ctx({ taskId: second.id });
    await t.handle(reuser, 'save_competitor', competitor([pub.id]));
    await t.handle(reuser, 'save_competitor', competitor([pub.id])); // replay in the same run
    const reuse = t.store.decisions.list({ agentRunId: reuser.agentRunId });
    expect(reuse).toHaveLength(1);
    expect(reuse[0]!.payload).toMatchObject({ reused: true, competitorId: cmp.id });

    // Rated after the reuse record was written.
    await new Promise((r) => setTimeout(r, 5));
    t.store.ratings.insert({
      id: newId('rat'), workspaceId: 'ws_a', targetType: 'competitor', targetId: cmp.id, criterion: 'threat', agentValue: 4,
      verdict: 'disagree', userValue: 2, createdAt: new Date().toISOString(),
    });
    const rows = exportTrainingData('ws_a', t).trim().split('\n').map((l) => JSON.parse(l) as { decision: { id: string }; ratings: unknown[] });
    expect(rows.find((r) => r.decision.id === original.id)!.ratings).toHaveLength(1);
    expect(rows.some((r) => r.decision.id === reuse[0]!.id)).toBe(false);
  });
});

describe('hypotheses without an owning task', () => {
  it('are unverified with no round, on create and on correction', async () => {
    const t = setup();
    const a = t.artifacts.save({ workspaceId: 'ws_a', kind: 'text', mime: 'text/plain', bytes: 'x' });
    const c = ctx();
    const r = await t.handle(c, 'save_hypothesis', { symptom_id: 'sym_1', hypothesis: 'h', confidence: 50, evidence: [a.id] });
    const id = (r as { data: { hypothesisId: string } }).data.hypothesisId;
    const h = t.store.symptomHypotheses.get(id)!;
    expect(h.status).toBe('unverified');
    expect(h.taskRound).toBeUndefined();
    expect(h.taskId).toBeUndefined();
  });

  it('a task-owned hypothesis corrected by a run without a task becomes unverified with no round', async () => {
    const t = setup();
    const a = t.artifacts.save({ workspaceId: 'ws_a', kind: 'text', mime: 'text/plain', bytes: 'x' });
    const task = addTask(t.store, { workspaceId: 'ws_a', type: 'symptom_hypotheses', phase: 'synthesis' });
    const c = ctx({ taskId: task.id });
    const r = await t.handle(c, 'save_hypothesis', { symptom_id: 'sym_1', hypothesis: 'h', confidence: 50, evidence: [a.id] });
    const id = (r as { data: { hypothesisId: string } }).data.hypothesisId;
    expect(t.store.symptomHypotheses.get(id)).toMatchObject({ status: 'pending', taskRound: 1 });
    // Same run id (replay scope) but the task is gone from the context: correction without an owner.
    t.store.tasks.update(task.id, { workspaceId: 'ws_other' });
    const fix = await t.handle(c, 'save_hypothesis', { symptom_id: 'sym_1', hypothesis: 'h', confidence: 10, evidence: [a.id] });
    expect(fix).toMatchObject({ ok: true, data: { revised: true } });
    const h = t.store.symptomHypotheses.get(id)!;
    expect(h).toMatchObject({ status: 'unverified', confidence: 10 });
    expect(h.taskRound).toBeUndefined();
  });
});

describe('abandoned tasks on resume', () => {
  it('mark their outputs failed and emit task_status', () => {
    const t = setup();
    t.store.researchRuns.insert({ id: 'rrun_done', workspaceId: 'ws_a', phase: 'deep_dives', status: 'done', startedAt: 'now' });
    const task = addTask(t.store, { workspaceId: 'ws_a', runId: 'rrun_done', status: 'running' });
    t.store.findings.insert({
      id: newId('fnd'), workspaceId: 'ws_a', runId: 'rrun_done', taskId: task.id, subject: 's', claim: 'c', criteria: {}, evidence: [],
      status: 'pending', createdAt: 'now', taskRound: 1,
    });
    t.store.competitors.insert({
      id: newId('cmp'), workspaceId: 'ws_a', name: 'Globex', threat: 3, directness: 3, comparison: { pricing: 3, onboarding: 3, ux: 3, features: 3 },
      evidence: [], taskId: task.id, createdAt: 'now', updatedAt: 'now', status: 'pending', taskRound: 1,
    });
    const report = resumeInterrupted(t.deps);
    expect(report.abandonedTasks).toEqual([task.id]);
    expect(t.store.findings.list({ taskId: task.id })[0]!.status).toBe('failed');
    expect(t.store.competitors.list({ taskId: task.id })[0]!.status).toBe('failed');
    const ev = t.seen.filter((e): e is Extract<BusEvent, { type: 'task_status' }> => e.type === 'task_status');
    expect(ev).toEqual([{ type: 'task_status', workspaceId: 'ws_a', taskId: task.id, status: 'failed' }]);
  });
});
