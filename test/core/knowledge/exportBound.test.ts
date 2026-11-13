/**
 * Export-exclusion ruling (design §12, binding): KS-6's per-task exclusion with three conditions.
 * - Bound: the exposed run, its task (reviews, deliverable decisions, outputs) and later judgments that
 *   reference those outputs — no further. A later run merely SHOWN one of those outputs is not exposed.
 * - Computed at export time, never stored: no flag is written, so nothing spreads through cards or
 *   briefings.
 * - Visible cost: the export summary counts the excluded judgments by cause and says `includeUploads`
 *   includes them.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { uploadInternal } from '../../../src/core/internal/uploads.js';
import { synthesisBriefing } from '../../../src/core/knowledge/briefing.js';
import { ingestorFor } from '../../../src/core/knowledge/ingest.js';
import { itemIsUploadDerived } from '../../../src/core/knowledge/provenance.js';
import { runIsUploadExposed } from '../../../src/core/knowledge/retrievalLog.js';
import { exportTrainingData, exportTrainingDataWithSummary } from '../../../src/core/scoring/export.js';
import type { Store } from '../../../src/core/store/db.js';
import { newId } from '../../../src/core/store/repos.js';
import type { Decision, Role, Task } from '../../../src/core/types.js';
import { ks4, T0 } from './ks4fixture.js';

const opened: Store[] = [];
afterEach(() => {
  for (const s of opened.splice(0)) s.close();
});

type Line = { type: string; decision?: Decision; retrievalEvent?: { id: string } };
const parse = (jsonl: string): Line[] => jsonl.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as Line);
const decisionIds = (jsonl: string) => parse(jsonl).filter((l) => l.type === 'decision').map((l) => l.decision!.id);

async function world() {
  const t = ks4(opened);
  const up = uploadInternal('ws_a', { name: 'board.txt', bytes: new TextEncoder().encode('Confidential board memo: churn rose to 14 percent.'), mime: 'text/plain' }, t);
  await ingestorFor(t).idle();
  const pub = await t.page('ws_a', 'Public pricing page: the Pro plan costs 49 dollars per seat.');
  const task = (): Task =>
    t.store.tasks.insert({
      id: newId('tsk'), workspaceId: 'ws_a', runId: newId('rrun'), phase: 'deep_dives', type: 'news_scan', brief: 'b',
      model: { provider: 'claude', model: 'sonnet' }, needsBrowser: false, acceptanceCriteria: ['a'], status: 'running', round: 1, createdAt: T0,
    });
  const run = (role: Role, taskId: string) => {
    const c = t.ctx('ws_a', role, { taskId });
    t.store.agentRuns.insert({
      id: c.agentRunId, workspaceId: 'ws_a', role, model: c.model, token: c.agentRunId, status: 'done', startedAt: T0, promptVersion: 'pv_ks4', taskId,
    });
    return c;
  };
  const decisionsOf = (agentRunId: string) => t.store.decisions.list({ agentRunId }).map((d) => d.id);

  // T1: the exposed run reads the upload, cites nothing from it, and saves a public finding F1.
  const t1 = task();
  const exposed = run('worker', t1.id);
  await t.call(exposed, 'search', { query: 'churn', kinds: ['passage'] });
  await t.call(exposed, 'log_decision', { what: 'Plan the pricing comparison', why: 'board priorities', confidence: 0.6, refs: [] });
  const f1 = await t.call<{ findingId: string }>(exposed, 'save_finding', {
    claim: 'Acme Pro costs 49 dollars per seat', subject: 'Acme', evidence: [pub.id], relation: 'new',
  });
  t.store.findings.update(f1.findingId, { status: 'verified' });
  const reviewer = run('reviewer', t1.id);
  await t.call(reviewer, 'submit_review', { score: 9, issues: [] });

  // A run that cites the upload itself.
  const citer = run('worker', task().id);
  await t.call(citer, 'log_decision', { what: 'Use the board memo', why: 'churn figure', confidence: 0.5, refs: [up.id] });

  // T2: a later run is SHOWN F1 (search and a briefing) but is not exposed by that alone.
  const t2 = task();
  const later = run('worker', t2.id);
  await t.call(later, 'search', { query: 'Acme Pro seat', kinds: ['fact'] });
  await t.call(later, 'log_decision', { what: 'Compare seat prices', why: 'public page', confidence: 0.7, refs: [pub.id] });
  const f2 = await t.call<{ findingId: string }>(later, 'save_finding', {
    claim: 'The Pro plan page is public', subject: 'Acme', evidence: [pub.id], relation: 'new',
  });
  // ...and it saves a recommendation citing F1: that judgment references an output of the exposed task.
  const rec = t.store.recommendations.insert({
    id: newId('rec'), workspaceId: 'ws_a', title: 'Price per seat', summary: 's', criteria: {}, findingIds: [f1.findingId],
    personaFeedback: [], priority: 1, createdAt: T0, status: 'verified', taskId: t2.id,
  });
  const recDecision = t.store.decisions.insert({
    id: newId('dec'), workspaceId: 'ws_a', agentRunId: later.agentRunId, role: 'worker', model: later.model, kind: 'score',
    payload: { tool: 'save_recommendation', recommendationId: rec.id }, refs: [rec.id], promptVersion: 'pv', createdAt: T0,
  });
  // T3: judges only T2's other output F2 — the exclusion does not reach it.
  const third = run('worker', task().id);
  await t.call(third, 'log_decision', { what: 'Build on the public page finding', why: 'F2', confidence: 0.6, refs: [f2.findingId] });

  return { t, up, pub, f1: f1.findingId, f2: f2.findingId, exposed, reviewer, citer, later, third, rec, recDecision, decisionsOf };
}

describe('export exclusion: the bound (design §12 ruling)', () => {
  it('excludes the exposed run, its task and judgments referencing its outputs — and nothing further', async () => {
    const w = await world();
    const out = decisionIds(exportTrainingData('ws_a', { store: w.t.store }));
    for (const d of [...w.decisionsOf(w.exposed.agentRunId), ...w.decisionsOf(w.reviewer.agentRunId), ...w.decisionsOf(w.citer.agentRunId)]) {
      expect(out).not.toContain(d);
    }
    expect(out).not.toContain(w.recDecision.id);
    // The later run was only SHOWN F1: not exposed; its other judgments and its read are exported.
    expect(runIsUploadExposed(w.t.store, w.later.agentRunId)).toBe(false);
    const laterOwn = w.decisionsOf(w.later.agentRunId).filter((d) => d !== w.recDecision.id);
    expect(laterOwn.length).toBeGreaterThanOrEqual(2);
    expect(out).toEqual(expect.arrayContaining(laterOwn));
    const reads = parse(exportTrainingData('ws_a', { store: w.t.store })).filter((l) => l.type === 'retrieval_event').map((l) => l.retrievalEvent!.id);
    const shown = w.t.rows(w.later.agentRunId);
    expect(shown.some((r) => r.resultIds.some((x) => x.id === w.f1))).toBe(true);
    expect(reads).toEqual(expect.arrayContaining(shown.map((r) => r.id)));
    // One step further (a judgment of the later task's other output): exported.
    expect(out).toEqual(expect.arrayContaining(w.decisionsOf(w.third.agentRunId)));
    // includeUploads keeps everything.
    const all = decisionIds(exportTrainingData('ws_a', { store: w.t.store }, true));
    expect(all).toEqual(expect.arrayContaining([...w.decisionsOf(w.exposed.agentRunId), ...w.decisionsOf(w.reviewer.agentRunId), w.recDecision.id]));
  });

  it('is computed at export time: nothing is stored, and cards / briefings showing F1 do not expose a run', async () => {
    const w = await world();
    const { db } = w.t.store;
    const tables = (db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '%_fts%'`).all() as Array<{ name: string }>).map((r) => r.name);
    const dump = () => tables.map((n) => JSON.stringify(db.prepare(`SELECT * FROM "${n}" ORDER BY rowid`).all())).join('\n');
    const before = dump();
    exportTrainingDataWithSummary('ws_a', { store: w.t.store });
    exportTrainingData('ws_a', { store: w.t.store });
    expect(dump()).toBe(before);
    // F1 carries no flag; a briefing listing it is not upload-derived.
    expect(itemIsUploadDerived(w.t.store, w.f1)).toBe(false);
    const b = synthesisBriefing({ store: w.t.store, config: w.t.config, now: new Date() }, { workspaceId: 'ws_a', role: 'synthesizer' });
    expect(b.results.map((r) => r.id)).toContain(w.f1);
    expect(b.uploadDerived).toBe(false);
    // A fresh run that expands F1 (its full text) is not upload-exposed either.
    const reader = w.t.ctx('ws_a');
    await w.t.call(reader, 'expand', { id: w.f1 });
    expect(w.t.rows(reader.agentRunId).at(-1)!.uploadDerived).toBe(false);
    expect(runIsUploadExposed(w.t.store, reader.agentRunId)).toBe(false);
  });
});

describe('export exclusion: the visible cost (summary by cause)', () => {
  it('counts the excluded judgments by cause and says includeUploads includes them', async () => {
    const w = await world();
    const { jsonl, summary } = exportTrainingDataWithSummary('ws_a', { store: w.t.store });
    expect(jsonl).toBe(exportTrainingData('ws_a', { store: w.t.store }));
    const by = Object.fromEntries(summary.excludedJudgments.byCause.map((c) => [c.cause, c.count]));
    expect(summary.excludedJudgments.byCause.map((c) => [c.cause, c.label])).toEqual([
      ['cites_upload', 'cites an upload'],
      ['exposed_run', 'exposed run'],
      ['exposed_task', 'task of an exposed run'],
      ['exposed_output', 'references an output of such a task'],
    ]);
    expect(by).toEqual({
      cites_upload: w.decisionsOf(w.citer.agentRunId).length,
      exposed_run: w.decisionsOf(w.exposed.agentRunId).length,
      exposed_task: w.decisionsOf(w.reviewer.agentRunId).length,
      exposed_output: 1,
    });
    expect(summary.excludedJudgments.total).toBe(Object.values(by).reduce((a, b) => a + b, 0));
    expect(summary.includeUploads).toBe(false);
    expect(summary.note).toMatch(/includeUploads/);
    // Every decision is either exported or counted, once.
    expect(decisionIds(jsonl).length + summary.excludedJudgments.total).toBe(w.t.store.decisions.list({ workspaceId: 'ws_a' }).length);

    const inc = exportTrainingDataWithSummary('ws_a', { store: w.t.store }, true);
    expect(inc.summary.includeUploads).toBe(true);
    expect(inc.summary.excludedJudgments.total).toBe(0);
    expect(inc.summary.excludedOtherLines.total).toBe(0);
  });
});
