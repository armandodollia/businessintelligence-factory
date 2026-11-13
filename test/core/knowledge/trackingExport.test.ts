/**
 * KS-6 export (design §12 "Upload exposure", §13): judgments of a run that was SHOWN upload-derived
 * text are excluded by default even when it cited nothing; the new retrieval-event and
 * fact-observation lines follow the same upload rules; `includeUploads` overrides.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { setIncludeOverride } from '../../../src/core/feedback/actions.js';
import { uploadInternal } from '../../../src/core/internal/uploads.js';
import { ingestorFor } from '../../../src/core/knowledge/ingest.js';
import { runIsUploadExposed } from '../../../src/core/knowledge/retrievalLog.js';
import { exportTrainingData } from '../../../src/core/scoring/export.js';
import type { Store } from '../../../src/core/store/db.js';
import { knowledgeRepos, newId } from '../../../src/core/store/repos.js';
import type { Decision, Role, Task } from '../../../src/core/types.js';
import { ks4, T0 } from './ks4fixture.js';

const opened: Store[] = [];
afterEach(() => {
  for (const s of opened.splice(0)) s.close();
});

type Line = { type: string; decision?: Decision; retrievalEvent?: { id: string }; uses?: unknown[]; observation?: { id: string }; feedbackEvent?: { id: string } };
const parse = (jsonl: string): Line[] => jsonl.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as Line);

async function setup() {
  const t = ks4(opened);
  const up = uploadInternal('ws_a', { name: 'board.txt', bytes: new TextEncoder().encode('Confidential board memo: churn rose to 14 percent.'), mime: 'text/plain' }, t);
  await ingestorFor(t).idle();
  const pub = await t.page('ws_a', 'Public pricing page: the Pro plan costs 49 dollars per seat.');
  const task = (): Task =>
    t.store.tasks.insert({
      id: newId('tsk'), workspaceId: 'ws_a', runId: newId('rrun'), phase: 'deep_dives', type: 'news_scan', brief: 'b',
      model: { provider: 'claude', model: 'sonnet' }, needsBrowser: false, acceptanceCriteria: ['a'], status: 'running', round: 1, createdAt: T0,
    });
  const run = (role: Role, taskId?: string) => {
    const c = t.ctx('ws_a', role, taskId ? { taskId } : {});
    t.store.agentRuns.insert({
      id: c.agentRunId, workspaceId: 'ws_a', role, model: c.model, token: c.agentRunId, status: 'done', startedAt: T0, promptVersion: 'pv_ks4',
      ...(taskId ? { taskId } : {}),
    });
    return c;
  };
  const decisionsOf = (agentRunId: string) => t.store.decisions.list({ agentRunId });
  return { ...t, up, pub, task, run, decisionsOf };
}

describe('upload-exposed runs in the export (KS-6)', () => {
  it('a run that only READ an upload and cited nothing is excluded by default; includeUploads keeps it', async () => {
    const t = await setup();
    const exposedTask = t.task();
    const reader = t.run('worker', exposedTask.id);
    // Reads the upload's text through search and cites nothing from it.
    await t.call(reader, 'search', { query: 'churn', kinds: ['passage'] });
    expect(runIsUploadExposed(t.store, reader.agentRunId)).toBe(true);
    await t.call(reader, 'log_decision', { what: 'Plan the pricing comparison', why: 'board priorities', confidence: 0.6, refs: [] });
    const saved = await t.call<{ findingId: string }>(reader, 'save_finding', {
      claim: 'Acme Pro costs 49 dollars per seat', subject: 'Acme', evidence: [t.pub.id], relation: 'new',
    });
    // The same task's reviewer was not shown the upload itself, but judges the exposed run's output.
    const reviewer = t.run('reviewer', exposedTask.id);
    await t.call(reviewer, 'submit_review', { score: 9, issues: [] });

    // A clean run in another task.
    const clean = t.run('worker', t.task().id);
    await t.call(clean, 'search', { query: 'pricing', kinds: ['passage'] });
    expect(runIsUploadExposed(t.store, clean.agentRunId)).toBe(false);
    await t.call(clean, 'log_decision', { what: 'Compare seat prices', why: 'public page', confidence: 0.7, refs: [t.pub.id] });

    const ids = (jsonl: string) => parse(jsonl).filter((l) => l.type === 'decision').map((l) => l.decision!.id);
    const out = ids(exportTrainingData('ws_a', { store: t.store }));
    for (const d of [...t.decisionsOf(reader.agentRunId), ...t.decisionsOf(reviewer.agentRunId)]) expect(out).not.toContain(d.id);
    expect(out).toEqual(expect.arrayContaining(t.decisionsOf(clean.agentRunId).map((d) => d.id)));

    const all = ids(exportTrainingData('ws_a', { store: t.store }, true));
    for (const d of [...t.decisionsOf(reader.agentRunId), ...t.decisionsOf(reviewer.agentRunId)]) expect(all).toContain(d.id);

    // A later judgment resting on the exposed run's output (a recommendation citing its finding, a
    // user include override on it) is excluded like one resting on an upload.
    t.store.findings.update(saved.findingId, { status: 'verified' });
    const synth = t.run('synthesizer', t.task().id);
    const rec = t.store.recommendations.insert({
      id: newId('rec'), workspaceId: 'ws_a', title: 'Price per seat', summary: 's', criteria: {}, findingIds: [saved.findingId],
      personaFeedback: [], priority: 1, createdAt: T0, status: 'verified',
    });
    const recDecision = t.store.decisions.insert({
      id: newId('dec'), workspaceId: 'ws_a', agentRunId: synth.agentRunId, role: 'synthesizer', model: synth.model, kind: 'score',
      payload: { tool: 'save_recommendation', recommendationId: rec.id }, refs: [rec.id], promptVersion: 'pv', createdAt: T0,
    });
    const fb = setIncludeOverride(t.store, 'finding', saved.findingId, false, { actor: 'alice' });
    expect(fb).toBeTruthy();
    const lines = parse(exportTrainingData('ws_a', { store: t.store }));
    expect(lines.some((l) => l.decision?.id === recDecision.id)).toBe(false);
    expect(lines.filter((l) => l.type === 'feedback_event')).toEqual([]);
    expect(parse(exportTrainingData('ws_a', { store: t.store }, true)).filter((l) => l.type === 'feedback_event')).toHaveLength(1);
  });
});

describe('knowledge lines in the export (KS-6)', () => {
  it('retrieval events (with their uses) and fact observations, under the upload rules', async () => {
    const t = await setup();
    const cleanTask = t.task();
    const clean = t.run('worker', cleanTask.id);
    const known = t.fact('ws_a', 'Acme Pro costs 49 dollars per seat');
    await t.call(clean, 'search', { query: 'Pro seat' });
    const fresh = await t.call<{ artifactId: string }>(clean, 'save_artifact', { kind: 'text', mime: 'text/plain', content: 'still 49 per seat' });
    const obs = await t.call<{ observationId: string }>(clean, 'confirm_finding', { finding_id: known.id, evidence: [fresh.artifactId] });

    const exposedTask = t.task();
    const exposed = t.run('worker', exposedTask.id);
    await t.call(exposed, 'search', { query: 'churn', kinds: ['passage'] });
    const other = t.fact('ws_a', 'Acme has 3 plans');
    const fresh2 = await t.call<{ artifactId: string }>(exposed, 'save_artifact', { kind: 'text', mime: 'text/plain', content: 'three plans listed' });
    const exposedObs = await t.call<{ observationId: string }>(exposed, 'confirm_finding', { finding_id: other.id, evidence: [fresh2.artifactId] });
    // A confirmation citing the upload itself (upload-derived observation).
    const uploadTask = t.task();
    const third = t.run('worker', uploadTask.id);
    const third2 = t.fact('ws_a', 'Acme churn is high');
    t.store.artifacts.get(t.up.id);
    knowledgeRepos(t.store).artifactCaptures.insert({ id: newId('cap'), artifactId: t.up.id, workspaceId: 'ws_a', taskId: uploadTask.id, capturedAt: T0 });
    const uploadObs = await t.call<{ observationId: string }>(third, 'confirm_finding', { finding_id: third2.id, evidence: [t.up.id] });

    const lines = parse(exportTrainingData('ws_a', { store: t.store }));
    const rets = lines.filter((l) => l.type === 'retrieval_event');
    const cleanRows = t.rows(clean.agentRunId);
    expect(rets.map((l) => l.retrievalEvent!.id)).toEqual(cleanRows.map((r) => r.id));
    expect(rets[0]!.uses).toEqual([{ itemId: known.id, usedByKind: 'observation', usedById: obs.observationId }]);
    const obsIds = lines.filter((l) => l.type === 'fact_observation').map((l) => l.observation!.id);
    expect(obsIds).toContain(obs.observationId);
    expect(obsIds).not.toContain(exposedObs.observationId);
    expect(obsIds).not.toContain(uploadObs.observationId);

    const all = parse(exportTrainingData('ws_a', { store: t.store }, true));
    expect(all.filter((l) => l.type === 'retrieval_event').map((l) => l.retrievalEvent!.id)).toEqual(
      expect.arrayContaining(t.rows(exposed.agentRunId).map((r) => r.id)),
    );
    expect(all.filter((l) => l.type === 'fact_observation').map((l) => l.observation!.id)).toEqual(
      expect.arrayContaining([obs.observationId, exposedObs.observationId, uploadObs.observationId]),
    );
  });
});
