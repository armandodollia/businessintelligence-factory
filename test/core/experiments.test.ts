/**
 * Learning loop WP-F: experiments. A finished task is re-run as arms A and B (worker model and / or
 * worker prompt version); the arm tasks run the normal review loop with lessons off, are tagged
 * (tasks, runs, decisions) so normal metrics leave them out, leave no results in the workspace and
 * never escalate. `compareExperiment` reports pass rate, rounds, review scores, user ratings and cost
 * per arm.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { runEscalation } from '../../src/core/escalation/escalation.js';
import {
  compareExperiment,
  ExperimentError,
  getExperiment,
  listExperiments,
  recoverExperiments,
  runExperiment,
  startExperiment,
} from '../../src/core/learning/experiments.js';
import { listOutcomes, outcomeReport } from '../../src/core/learning/outcomes.js';
import { lessonsOff, NORMAL_DECISION_SQL, NORMAL_RUN_SQL, runTags, taskExperiment } from '../../src/core/learning/runTags.js';
import { promptVersionMetrics } from '../../src/core/metrics/promptMetrics.js';
import { recordUsage } from '../../src/core/metrics/usage.js';
import { recordPromptVersion } from '../../src/core/prompts/store.js';
import { runTaskWithReview } from '../../src/core/research/reviewLoop.js';
import type { Store } from '../../src/core/store/db.js';
import { newId } from '../../src/core/store/repos.js';
import { createWorkspace } from '../../src/core/workspace/tree.js';
import { addTask, researchSetup, review, revise, submitWork } from './helpers/research.js';

const opened: Store[] = [];
afterEach(() => {
  for (const s of opened.splice(0)) s.close();
});

/** Arm B's worker (model haiku) needs two rounds; everything else passes in round 1. */
async function world() {
  const reviews = new Map<string, number>();
  const s = researchSetup(opened, {
    pick: (r) => {
      if (r.kind === 'work') return submitWork({ summary: `work by ${r.task?.model.model}` });
      if (r.kind === 'revise') return revise('fix')(r);
      if (r.kind === 'review') {
        const n = (reviews.get(r.task!.id) ?? 0) + 1;
        reviews.set(r.task!.id, n);
        return r.task!.model.model === 'haiku' && n === 1 ? review(5, [{ class: 'substantive', description: 'thin' }]) : review(9);
      }
      return undefined;
    },
  });
  const ws = createWorkspace(s.store, { name: 'Acme', sector: 'saas' });
  const source = await runTaskWithReview(addTask(s.store, { workspaceId: ws.id }), s.deps);
  return { ...s, ws, source };
}

describe('startExperiment / compareExperiment', () => {
  it('runs the task as arms A and B and compares pass rate, rounds, scores, ratings and cost', async () => {
    const w = await world();
    const exp = await runExperiment(w.deps, {
      taskId: w.source.id, name: 'haiku vs sonnet', actor: 'alice', repeats: 2,
      arms: [{}, { model: { provider: 'claude', model: 'haiku' } }],
    });
    expect(exp).toMatchObject({ status: 'done', actor: 'alice', repeats: 2, sourceTaskId: w.source.id, workspaceId: w.ws.id, rootWorkspaceId: w.ws.id });
    expect(exp.arms.map((a) => [a.arm, a.model.model, a.taskIds.length])).toEqual([['A', 'sonnet', 2], ['B', 'haiku', 2]]);

    // Arm tasks: clones of the source in a research run that no drain loop or resume picks up.
    const armTask = w.store.tasks.get(exp.arms[1]!.taskIds[0]!)!;
    expect(armTask).toMatchObject({ brief: w.source.brief, type: w.source.type, acceptanceCriteria: w.source.acceptanceCriteria, runId: exp.researchRunId });
    expect(w.store.researchRuns.get(exp.researchRunId)!.status).toBe('done');
    expect(taskExperiment(w.store, armTask.id)).toEqual({ experimentId: exp.id, arm: 'B' });

    // Every run of an arm task is tagged with lessons off; its decisions carry the tags too.
    const armRuns = w.store.agentRuns.list({ taskId: armTask.id });
    expect(armRuns.length).toBeGreaterThanOrEqual(4);
    for (const r of armRuns) expect(runTags(w.store, r.id)).toEqual({ experimentId: exp.id, arm: 'B', lessonsOff: true });
    const untagged = w.store.db
      .prepare(`SELECT COUNT(*) AS n FROM decisions d JOIN agent_runs r ON r.id = d.agent_run_id WHERE r.task_id = ? AND ${NORMAL_DECISION_SQL('d')}`)
      .get(armTask.id) as { n: number };
    expect(untagged.n).toBe(0);
    expect(lessonsOff(w.store, { taskId: armTask.id })).toBe(true);
    expect(lessonsOff(w.store, { agentRunId: armRuns[0]!.id })).toBe(true);
    expect(lessonsOff(w.store, { taskId: w.source.id })).toBe(false);

    // Costs from agent_usage, ratings by the user on an arm decision.
    recordUsage(w.store, { agentRunId: armRuns[0]!.id, workspaceId: w.ws.id, taskId: armTask.id, role: 'worker', model: { provider: 'claude', model: 'haiku' } }, 1, {
      t: 'usage', inputTokens: 1_000_000, outputTokens: 0,
    });
    const armDecision = w.store.decisions.list({ agentRunId: armRuns[0]!.id })[0]!;
    w.store.ratings.insert({
      id: newId('rat'), workspaceId: w.ws.id, targetType: 'decision', targetId: armDecision.id, criterion: 'confidence', agentValue: 0.5,
      verdict: 'disagree', userValue: 0.2, createdAt: new Date().toISOString(), agentRunId: armRuns[0]!.id,
    });

    const cmp = compareExperiment(w.store, exp.id)!;
    const [a, b] = cmp.arms;
    expect(a).toMatchObject({ arm: 'A', finished: 2, verified: 2, passRate: 1, firstRoundPassRate: 1, meanRounds: 1, meanReviewScore: 9 });
    expect(b).toMatchObject({ arm: 'B', finished: 2, verified: 2, passRate: 1, firstRoundPassRate: 0, meanRounds: 2, meanReviewScore: 7 });
    expect(b!.reviewScores).toEqual([5, 9, 5, 9]);
    expect(b!.userRatings).toEqual({ count: 1, agree: 0, agreeRate: 0 });
    expect(a!.userRatings.count).toBe(0);
    expect(b!.cost.costUsd).toBeGreaterThan(0);
    expect(b!.costPerTask).toBeCloseTo(b!.cost.costUsd / 2, 6);
    expect(a!.cost.costUsd).toBe(0);
    expect(a!.reviewerModels).toEqual([{ provider: 'codex', model: 'gpt-6.1-sol' }]);
    expect(listExperiments(w.store, w.ws.id).map((e) => e.id)).toEqual([exp.id]);
  });

  it('a prompt arm runs the worker with the stored prompt version', async () => {
    const w = await world();
    const variant = 'You are a careful research worker. VARIANT_B_PROMPT. Call submit_result.';
    const exp = await runExperiment(w.deps, { taskId: w.source.id, arms: [{}, { promptText: variant }] });
    const armB = exp.arms[1]!;
    expect(armB.promptVersion).toBe(recordPromptVersion(w.store, 'worker', variant));
    const work = w.requests.filter((r) => r.kind === 'work' && armB.taskIds.includes(r.task!.id));
    expect(work).toHaveLength(1);
    expect(work[0]!.systemPrompt).toBe(variant);
    expect(compareExperiment(w.store, exp.id)!.arms[1]!.workerPromptVersions).toEqual([armB.promptVersion]);
    const armA = w.requests.find((r) => r.kind === 'work' && exp.arms[0]!.taskIds.includes(r.task!.id))!;
    expect(armA.systemPrompt).not.toContain('VARIANT_B_PROMPT');
    // A prompt version of another role is refused.
    const reviewerHash = recordPromptVersion(w.store, 'reviewer', 'reviewer text');
    expect(() => startExperiment(w.deps, { taskId: w.source.id, arms: [{}, { promptVersion: reviewerHash }] })).toThrow(ExperimentError);
  });

  it('leaves no results, outcomes, escalations or normal-metric counts behind', async () => {
    const w = await world();
    const before = {
      findings: w.store.findings.list({ workspaceId: w.ws.id }).filter((f) => f.status !== 'superseded').length,
      outcomes: listOutcomes(w.store, { workspaceIds: [w.ws.id] }).length,
      metrics: JSON.stringify(promptVersionMetrics(w.store, w.ws.id).map(({ firstSeen: _f, lastSeen: _l, ...m }) => m)),
      report: JSON.stringify(outcomeReport(w.store, [w.ws.id])),
    };
    // Arm B ends unverified (max rounds 1 for its reviews at 5).
    w.config.loop.maxRounds = 1;
    const exp = await runExperiment(w.deps, { taskId: w.source.id, arms: [{}, { model: { provider: 'claude', model: 'haiku' } }] });
    const armB = w.store.tasks.get(exp.arms[1]!.taskIds[0]!)!;
    expect(armB.status).toBe('unverified');
    for (const id of exp.arms.flatMap((a) => a.taskIds)) {
      expect(w.store.findings.list({ taskId: id }).every((f) => f.status === 'superseded')).toBe(true);
    }
    expect(w.store.findings.list({ workspaceId: w.ws.id }).filter((f) => f.status !== 'superseded')).toHaveLength(before.findings);
    expect(listOutcomes(w.store, { workspaceIds: [w.ws.id] })).toHaveLength(before.outcomes);
    expect(listOutcomes(w.store, { workspaceIds: [w.ws.id], includeExperiments: true })).toHaveLength(before.outcomes);
    expect(JSON.stringify(outcomeReport(w.store, [w.ws.id]))).toBe(before.report);
    expect(JSON.stringify(promptVersionMetrics(w.store, w.ws.id).map(({ firstSeen: _f, lastSeen: _l, ...m }) => m))).toBe(before.metrics);
    expect(await runEscalation(w.deps, armB.id)).toEqual([]);
    expect(w.requests.filter((r) => r.kind === 'escalate')).toHaveLength(0);
    // WP-G filter: normal runs are exactly the source task's.
    const normal = w.store.db.prepare(`SELECT DISTINCT task_id AS t FROM agent_runs WHERE ${NORMAL_RUN_SQL()}`).all() as Array<{ t: string }>;
    expect(normal.map((r) => r.t)).toEqual([w.source.id]);
  });

  it('validates its input', async () => {
    const w = await world();
    const running = addTask(w.store, { workspaceId: w.ws.id, status: 'running' });
    expect(() => startExperiment(w.deps, { taskId: 'tsk_missing', arms: [{}, {}] })).toThrow(/not found/);
    expect(() => startExperiment(w.deps, { taskId: running.id, arms: [{}, {}] })).toThrow(/finished/);
    expect(() => startExperiment(w.deps, { taskId: w.source.id, arms: [{}, { model: { provider: 'opencode', model: 'x' } }] })).toThrow(/not enabled/);
    expect(() => startExperiment(w.deps, { taskId: w.source.id, arms: [{}, { model: { provider: 'claude', model: 'nope' } }] })).toThrow(/not in providers/);
    expect(() => startExperiment(w.deps, { taskId: w.source.id, arms: [{}, { promptVersion: 'deadbeef' }] })).toThrow(/unknown prompt version/);
    expect(() => startExperiment(w.deps, { taskId: w.source.id, repeats: 9, arms: [{}, {}] })).toThrow(/repeats/);
    const exp = await runExperiment(w.deps, { taskId: w.source.id, arms: [{}, {}] });
    expect(() => startExperiment(w.deps, { taskId: exp.arms[0]!.taskIds[0]!, arms: [{}, {}] })).toThrow(/experiment/);
  });

  it('an experiment left running by a stopped server is marked interrupted at boot', async () => {
    const w = await world();
    const { experiment, done } = startExperiment(w.deps, { taskId: w.source.id, arms: [{}, {}] });
    expect(recoverExperiments(w.store)).toEqual([experiment.id]);
    expect(getExperiment(w.store, experiment.id)!.status).toBe('interrupted');
    // Work that still finishes in this process does not overwrite the boot verdict.
    expect((await done).status).toBe('interrupted');
    expect(recoverExperiments(w.store)).toEqual([]);
  });
});
