/**
 * Learning loop WP-F privacy: audit and experiment runs follow the same upload-exposure and export
 * rules as every run (design §12): their judgments are left out of the default export by the per-task
 * rule, included (and tagged) with `includeUploads`; an auditor reads only its task's review slice and
 * never another business tree.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { uploadInternal } from '../../src/core/internal/uploads.js';
import { runIsUploadExposed } from '../../src/core/knowledge/retrievalLog.js';
import { runExperiment } from '../../src/core/learning/experiments.js';
import { runReviewerAudit } from '../../src/core/learning/reviewerAudit.js';
import { runTaskWithReview } from '../../src/core/research/reviewLoop.js';
import { exportTrainingData, exportTrainingDataWithSummary } from '../../src/core/scoring/export.js';
import type { Store } from '../../src/core/store/db.js';
import { createWorkspace } from '../../src/core/workspace/tree.js';
import { addTask, researchSetup, review, submitWork, type Picker } from './helpers/research.js';

const opened: Store[] = [];
afterEach(() => {
  for (const s of opened.splice(0)) s.close();
});

type Line = { type: string; decision?: { id: string; agentRunId: string }; experimentId?: string; arm?: string; auditId?: string };
const lines = (jsonl: string): Line[] => jsonl.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as Line);

/** Worker that cites an artifact id it is given (an upload, or public evidence when undefined). */
const citing = (artifactId: () => string | undefined): Picker => () => async (t) => {
  const id = artifactId();
  if (!id) return submitWork()(t);
  await t.call('save_finding', { claim: 'Churn rose to 14 percent', subject: 'Acme', evidence: [id] });
  await t.call('submit_result', { summary: 'churn', evidence: [id] });
};

function world(pick: Picker) {
  const s = researchSetup(opened, { pick });
  const root = createWorkspace(s.store, { name: 'Acme', sector: 'saas' });
  const other = createWorkspace(s.store, { name: 'Globex', sector: 'saas' });
  const upload = uploadInternal(root.id, { name: 'board.txt', bytes: new TextEncoder().encode('Board memo: churn rose to 14 percent.'), mime: 'text/plain' }, s);
  return { ...s, root, other, upload };
}

describe('reviewer audits and the export rules', () => {
  it('an audit of an upload-derived task is upload-exposed; its judgment is excluded by default and tagged when included', async () => {
    let uploadId: string | undefined;
    const w = world((r) => (r.kind === 'work' ? citing(() => uploadId)(r) : r.kind === 'review' || r.kind === 'audit' ? review(r.kind === 'audit' ? 3 : 9) : undefined));
    uploadId = w.upload.id;
    const task = await runTaskWithReview(addTask(w.store, { workspaceId: w.root.id }), w.deps);
    expect(task.status).toBe('verified');
    const [a] = await runReviewerAudit(w.deps, { workspaceId: w.root.id });
    expect(a).toMatchObject({ verdict: 'miss' });
    expect(runIsUploadExposed(w.store, a!.auditRunId!)).toBe(true);

    const { jsonl, summary } = exportTrainingDataWithSummary(w.root.id, { store: w.store });
    expect(lines(jsonl).some((l) => l.decision?.agentRunId === a!.auditRunId || l.auditId)).toBe(false);
    expect(summary.excludedJudgments.total).toBeGreaterThan(0);
    const all = lines(exportTrainingData(w.root.id, { store: w.store }, true));
    expect(all.find((l) => l.decision?.id === a!.auditDecisionId)).toMatchObject({ auditId: a!.id });
  });

  it('an auditor reads only its task review slice, never another tree', async () => {
    let foreign = '';
    let own = '';
    const errors: string[] = [];
    const w = world((r) => {
      if (r.kind === 'work') return submitWork();
      if (r.kind === 'review') return review(9);
      if (r.kind === 'audit') {
        return async (t) => {
          for (const id of [foreign, own]) {
            try {
              await t.call('expand', { id });
            } catch (e) {
              errors.push(`${id}: ${(e as Error).message}`);
            }
          }
          await review(9)(t);
        };
      }
      return undefined;
    });
    const task = await runTaskWithReview(addTask(w.store, { workspaceId: w.root.id }), w.deps);
    own = w.store.findings.list({ taskId: task.id })[0]!.evidence[0]!;
    foreign = w.artifacts.save({ workspaceId: w.other.id, kind: 'text', mime: 'text/plain', title: 'Globex', bytes: new TextEncoder().encode('Globex secret plan') }).id;
    const [a] = await runReviewerAudit(w.deps, { workspaceId: w.root.id });
    expect(a).toMatchObject({ verdict: 'agree' });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(new RegExp(`^${foreign}: .*not found`));
  });
});

describe('experiments and the export rules', () => {
  it("an arm's judgments that rest on an upload are excluded by default; included lines carry experiment and arm", async () => {
    let uploadId: string | undefined;
    const w = world((r) => {
      if (r.kind === 'work') return citing(() => (r.task?.model.model === 'haiku' ? uploadId : undefined))(r);
      return r.kind === 'review' ? review(9) : undefined;
    });
    uploadId = w.upload.id;
    const source = await runTaskWithReview(addTask(w.store, { workspaceId: w.root.id }), w.deps);
    const exp = await runExperiment(w.deps, { taskId: source.id, arms: [{}, { model: { provider: 'claude', model: 'haiku' } }] });
    const armRuns = (arm: number) => new Set(exp.arms[arm]!.taskIds.flatMap((id) => w.store.agentRuns.list({ taskId: id }).map((r) => r.id)));

    const def = lines(exportTrainingData(w.root.id, { store: w.store }));
    const b = armRuns(1);
    expect(def.some((l) => l.decision && b.has(l.decision.agentRunId))).toBe(false);
    const aLines = def.filter((l) => l.decision && armRuns(0).has(l.decision.agentRunId));
    expect(aLines.length).toBeGreaterThan(0);
    for (const l of aLines) expect(l).toMatchObject({ experimentId: exp.id, arm: 'A' });
    // Normal judgments carry no tags.
    expect(def.filter((l) => l.decision && !armRuns(0).has(l.decision.agentRunId)).every((l) => l.experimentId === undefined)).toBe(true);

    const all = lines(exportTrainingData(w.root.id, { store: w.store }, true));
    const bLines = all.filter((l) => l.decision && b.has(l.decision.agentRunId));
    expect(bLines.length).toBeGreaterThan(0);
    for (const l of bLines) expect(l).toMatchObject({ experimentId: exp.id, arm: 'B' });
  });
});
