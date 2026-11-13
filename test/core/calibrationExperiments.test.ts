/**
 * Orchestrator ruling R3 (wave 2): ratings of experiment and reviewer-audit judgments are left out of
 * calibration (`calibrationReport`) and prompt-patch examples (`proposePromptPatch`) by default; they
 * still count in the experiment's arm comparison (`compareExperiment`).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { compareExperiment, runExperiment } from '../../src/core/learning/experiments.js';
import { tagRun } from '../../src/core/learning/runTags.js';
import { runTaskWithReview } from '../../src/core/research/reviewLoop.js';
import { calibrationReport, proposePromptPatch } from '../../src/core/scoring/calibration.js';
import type { Store } from '../../src/core/store/db.js';
import { newId } from '../../src/core/store/repos.js';
import type { Rating } from '../../src/core/types.js';
import { createWorkspace } from '../../src/core/workspace/tree.js';
import { addTask, researchSetup, review, revise, submitWork } from './helpers/research.js';

const opened: Store[] = [];
afterEach(() => {
  for (const s of opened.splice(0)) s.close();
});

describe('R3: calibration ignores experiment and audit judgments by default', () => {
  it('leaves their ratings out of calibration and prompt patches, but the arm comparison counts them', async () => {
    const s = researchSetup(opened, {
      pick: (r) => (r.kind === 'work' ? submitWork({ summary: 's' }, `claim of ${r.task?.id}`) : r.kind === 'revise' ? revise('fix')(r) : r.kind === 'review' ? review(9) : undefined),
    });
    const ws = createWorkspace(s.store, { name: 'Acme', sector: 'saas' });
    const source = await runTaskWithReview(addTask(s.store, { workspaceId: ws.id }), s.deps);
    const exp = await runExperiment(s.deps, { taskId: source.id, name: 'x', repeats: 1, arms: [{}, { model: { provider: 'claude', model: 'haiku' } }] });
    const armTask = exp.arms[1]!.taskIds[0]!;
    const runOf = (taskId: string) => s.store.agentRuns.list({ taskId }).find((r) => r.role === 'worker')!;
    const decisionOf = (taskId: string) => s.store.decisions.list({ agentRunId: runOf(taskId).id })[0]!;

    // An audit run of the source task (tagged) with a judgment the user rates.
    const auditRun = s.store.agentRuns.insert({
      id: newId('run'), workspaceId: ws.id, taskId: source.id, role: 'reviewer', model: { provider: 'claude', model: 'opus' }, token: newId('tok'),
      status: 'done', startedAt: new Date().toISOString(),
    });
    tagRun(s.store, auditRun.id, { auditId: 'aud_1', lessonsOff: true });
    const auditDecision = s.store.decisions.insert({
      id: newId('dec'), workspaceId: ws.id, agentRunId: auditRun.id, role: 'reviewer', model: auditRun.model, kind: 'decision',
      payload: { tool: 'log_decision', what: 'x', confidence: 0.9 }, refs: [], promptVersion: 'pv', createdAt: new Date().toISOString(),
    });

    const rate = (targetType: Rating['targetType'], targetId: string, criterion: string, agentRunId: string, agentValue: number, userValue: number) =>
      s.store.ratings.insert({
        id: newId('rat'), workspaceId: ws.id, targetType, targetId, criterion, agentValue, verdict: 'disagree', userValue, ...(agentRunId ? { agentRunId } : {}),
        createdAt: new Date().toISOString(),
      });
    rate('decision', decisionOf(source.id).id, 'confidence', runOf(source.id).id, 0.9, 0.5); // normal
    rate('decision', decisionOf(armTask).id, 'confidence', runOf(armTask).id, 0.9, 0.1); // experiment arm
    rate('decision', decisionOf(armTask).id, 'novelty', '', 5, 1); // experiment arm, known only by the decision's tags
    rate('decision', auditDecision.id, 'confidence', auditRun.id, 0.9, 0.1); // audit

    const n = (r: ReturnType<typeof calibrationReport>) => r.byCriterion.reduce((acc, x) => acc + x.n, 0);
    expect(n(calibrationReport(ws.id, { store: s.store }))).toBe(1);
    expect(n(calibrationReport(ws.id, { store: s.store }, { includeExperiments: true }))).toBe(4);
    const patch = proposePromptPatch(ws.id, 'worker', { store: s.store });
    expect(patch.sources).toEqual([{ targetType: 'decision', targetId: decisionOf(source.id).id }]);
    expect(proposePromptPatch(ws.id, 'worker', { store: s.store }, { includeExperiments: true }).sources).toHaveLength(3);

    // The arm comparison still counts the arm's ratings.
    expect(compareExperiment(s.store, exp.id)!.arms[1]!.userRatings.count).toBe(2);
  });
});
