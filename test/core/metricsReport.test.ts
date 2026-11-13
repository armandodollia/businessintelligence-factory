import { afterEach, describe, expect, it } from 'vitest';
import { learningRepos } from '../../src/core/learning/store.js';
import { tagRun } from '../../src/core/learning/runTags.js';
import { outcomeReport } from '../../src/core/learning/outcomes.js';
import { isExperimentRun } from '../../src/core/metrics/experimentFilter.js';
import { promptVersionMetrics } from '../../src/core/metrics/promptMetrics.js';
import { metricsReport, bucketOf } from '../../src/core/metrics/report.js';
import { usageTotals } from '../../src/core/metrics/usage.js';
import { calibrationReport } from '../../src/core/scoring/calibration.js';
import { openStore, type Store } from '../../src/core/store/db.js';
import { knowledgeRepos, newId } from '../../src/core/store/repos.js';
import { usageRepos } from '../../src/core/store/usageRepos.js';
import type { AgentRun, Task } from '../../src/core/types.js';
import { createWorkspace } from '../../src/core/workspace/tree.js';

const opened: Store[] = [];
afterEach(() => {
  for (const s of opened.splice(0)) s.close();
});

const SONNET = { provider: 'claude', model: 'sonnet' } as const;

function setup() {
  const store = openStore(':memory:');
  opened.push(store);
  const root = createWorkspace(store, { name: 'Acme', sector: 'saas' });
  const child = createWorkspace(store, { name: 'Acme Pay', sector: 'saas', parentWorkspaceId: root.id });
  const other = createWorkspace(store, { name: 'Globex', sector: 'saas' });

  const run = (id: string, workspaceId: string, extra: Partial<AgentRun>) =>
    store.agentRuns.insert({ id, workspaceId, role: 'worker', model: SONNET, token: `t_${id}`, status: 'done', startedAt: '2026-11-02T10:00:00.000Z', ...extra });
  const task = (id: string, workspaceId: string, extra: Partial<Task>) =>
    store.tasks.insert({
      id, workspaceId, runId: 'rrun_1', phase: 'deep_dives', type: 'news_scan', brief: 'b', model: SONNET, needsBrowser: false,
      acceptanceCriteria: [], status: 'verified', round: 1, createdAt: '2026-11-01T00:00:00.000Z', ...extra,
    });
  const usage = (runId: string, workspaceId: string, role: AgentRun['role'], costUsd: number, promptVersion: string, model = 'sonnet') =>
    usageRepos(store).agentUsage.insert({
      id: newId('use'), workspaceId, runId, role, provider: 'claude', model, promptVersion, attempt: 1, inputTokens: 100, outputTokens: 10,
      cacheReadTokens: 0, cacheWriteTokens: 0, costUsd, createdAt: '2026-11-02T10:00:01.000Z',
    });

  // Root, week of Mon 2026-11-02.
  task('t1', root.id, { status: 'verified', round: 1 });
  task('t2', root.id, { status: 'failed', round: 1, type: 'competitor_scan' as Task['type'] });
  run('w1', root.id, { taskId: 't1', promptVersion: 'aaaa', taskType: 'news_scan' as Task['type'] });
  run('rev1', root.id, { taskId: 't1', role: 'reviewer', promptVersion: 'rrrr', model: { provider: 'claude', model: 'opus' }, startedAt: '2026-11-02T11:00:00.000Z' });
  run('w2', root.id, {
    taskId: 't2', promptVersion: 'aaaa', status: 'failed', failureReason: 'idle timeout', attempts: 2, startedAt: '2026-11-03T10:00:00.000Z',
    taskType: 'competitor_scan' as Task['type'],
  });
  usage('w1', root.id, 'worker', 0.5, 'aaaa');
  usage('rev1', root.id, 'reviewer', 0.25, 'rrrr', 'opus');
  usage('w2', root.id, 'worker', 0.1, 'aaaa');
  for (const [attempt, rateLimited] of [[1, true], [2, false]] as const) {
    usageRepos(store).agentRunAttempts.insert({
      id: newId('att'), workspaceId: root.id, runId: 'w2', attempt, startedAt: '2026-11-03T10:00:00.000Z', endedAt: '2026-11-03T10:01:00.000Z',
      exitCode: 1, rateLimited, ...(rateLimited ? {} : { failureReason: 'idle timeout' }),
    });
  }
  // Root, week of Mon 2026-11-09: a newer prompt version, unverified after 3 rounds.
  task('t3', root.id, { status: 'unverified', round: 3 });
  run('w3', root.id, { taskId: 't3', promptVersion: 'bbbb', startedAt: '2026-11-10T10:00:00.000Z', taskType: 'news_scan' as Task['type'] });
  usage('w3', root.id, 'worker', 1, 'bbbb');
  // An experiment run (WP-F tags it; the test predicate stands in for the column).
  task('tx', root.id, { status: 'verified', round: 1 });
  run('x1', root.id, { taskId: 'tx', promptVersion: 'bbbb', startedAt: '2026-11-10T12:00:00.000Z' });
  usage('x1', root.id, 'worker', 5, 'bbbb');

  // Child node of the same tree.
  task('tc', child.id, { status: 'verified', round: 2 });
  run('c1', child.id, { taskId: 'tc', promptVersion: 'aaaa', startedAt: '2026-11-04T10:00:00.000Z', model: { provider: 'claude', model: 'haiku' } });
  usage('c1', child.id, 'worker', 0.05, 'aaaa', 'haiku');
  // Another tree: never counted.
  task('to', other.id, { status: 'verified', round: 1 });
  run('o1', other.id, { taskId: 'to', promptVersion: 'aaaa' });
  usage('o1', other.id, 'worker', 9, 'aaaa');

  // Ratings of values produced by w1 (agree) and w3 (relevance 2 → 4: +0.5).
  store.ratings.insert({ id: 'rat1', workspaceId: root.id, targetType: 'finding', targetId: 'fnd_1', criterion: 'relevance', agentValue: 3, verdict: 'agree', agentRunId: 'w1', createdAt: '2026-11-12T00:00:00.000Z' } as never);
  store.ratings.insert({ id: 'rat2', workspaceId: root.id, targetType: 'finding', targetId: 'fnd_3', criterion: 'relevance', agentValue: 2, userValue: 4, verdict: 'disagree', agentRunId: 'w3', createdAt: '2026-11-12T00:00:00.000Z' } as never);
  store.ratings.insert({ id: 'ratx', workspaceId: root.id, targetType: 'finding', targetId: 'fnd_x', criterion: 'relevance', agentValue: 2, userValue: 4, verdict: 'disagree', agentRunId: 'x1', createdAt: '2026-11-12T00:00:00.000Z' } as never);

  // Outcomes and review issues.
  const outcome = (id: string, runId: string, label: string, extra: Record<string, unknown> = {}) =>
    learningRepos(store).decisionOutcomes.insert({
      id, workspaceId: root.id, subjectType: 'task', subjectId: id, runId, outcome: label, label: label as never, evidenceJson: {}, source: 'review_loop',
      actor: 'system', role: 'worker', promptVersion: 'aaaa', createdAt: '2026-11-12T00:00:00.000Z', ...extra,
    });
  outcome('out1', 'w1', 'confirmed', { taskType: 'news_scan' });
  outcome('out2', 'w2', 'run-failed', { taskType: 'competitor_scan' });
  const issue = (id: string, synthetic: boolean, cls: 'substantive' | 'blocking') =>
    learningRepos(store).reviewIssues.insert({
      id, workspaceId: root.id, taskId: 't1', round: 1, issueId: id, class: cls, text: 'x', evidence: [], status: 'fixed', synthetic,
      reviewerRunId: 'rev1', workerRunId: 'w1', workerPromptVersion: 'aaaa', createdAt: '2026-11-02T11:00:00.000Z',
    });
  issue('I1', false, 'substantive');
  issue('I2', true, 'blocking'); // harness-made: not a reviewer judgment

  // Retrieval: one agent read with no result, one human read (reported apart).
  const ret = (role: string, agentRunId: string | undefined) =>
    knowledgeRepos(store).retrievalEvents.insert({
      id: newId('ret'), workspaceId: root.id, rootWorkspaceId: root.id, ...(agentRunId ? { agentRunId, taskId: 't1' } : {}), role, tool: 'search', query: 'q', scope: 'node',
      resultIds: [], resultCount: 0, tokensReturned: 40, truncated: false, relaxed: false, latencyMs: 1, uploadDerived: false, createdAt: '2026-11-02T10:30:00.000Z',
    } as never);
  ret('worker', 'w1');
  ret('user', undefined);

  const isExp = (r: AgentRun) => r.id === 'x1';
  return { store, root, child, other, isExp };
}

describe('metricsReport (WP-G)', () => {
  it('groups pass rate, rounds, failures, cost, rating agreement and outcomes by role (one node)', () => {
    const { store, root, isExp } = setup();
    const r = metricsReport(store, { workspaceId: root.id, scope: 'node', groupBy: 'role', isExperimentRun: isExp });
    const worker = r.groups.find((g) => g.key === 'worker')!;
    expect(worker).toMatchObject({
      runs: 3, failedRuns: 1, failureRate: 0.333, attempts: 2, rateLimitedAttempts: 1,
      tasks: 3, verified: 1, unverified: 1, failed: 1, passRate: 0.333, firstRoundPassRate: 0.333, meanRounds: 2,
      reviewIssues: 1, ratings: 2, agrees: 1, agreeRate: 0.5, meanDelta: 0.25, costUsd: 1.6, outcomes: 2,
      outcomeCounts: { confirmed: 1, 'run-failed': 1 },
    });
    expect(r.groups.find((g) => g.key === 'reviewer')).toMatchObject({ runs: 1, tasks: 0, passRate: null, costUsd: 0.25 });
    expect(r.failuresByReason).toEqual([{ reason: 'idle timeout', runs: 1 }]);
    expect(r.reviewIssuesByClass).toEqual([{ class: 'substantive', issues: 1, tasks: 1 }]);
    expect(r.experiments).toEqual({ included: false, excludedRuns: 1 });
    expect(r.lessons).toBeNull(); // WP-E slot
  });

  it('agrees with the source APIs when nothing is filtered (prompt version, cost, calibration, outcomes)', () => {
    const { store, root } = setup();
    const r = metricsReport(store, { workspaceId: root.id, scope: 'node', groupBy: 'prompt_version', includeExperiments: true });
    for (const pv of promptVersionMetrics(store, root.id)) {
      const g = r.groups.find((x) => x.key === `${pv.role}:${pv.promptVersion}`)!;
      expect(g, pv.promptVersion).toMatchObject({
        runs: pv.runs, failedRuns: pv.failedRuns, tasks: pv.tasks, verified: pv.verified, unverified: pv.unverified, failed: pv.failed,
        passRate: pv.passRate, firstRoundPassRate: pv.firstRoundPassRate, meanRounds: pv.meanRounds, costUsd: pv.costUsd, totalTokens: pv.totalTokens,
        ratings: pv.ratings, agreeRate: pv.agreeRate,
      });
    }
    expect(r.totals.costUsd).toBe(usageTotals(store, { workspaceId: root.id }).costUsd);
    expect(r.totals.ratings).toBe(calibrationReport(root.id, { store }).byCriterion.reduce((a, c) => a + c.n, 0));
    expect(r.totals.outcomes).toBe(outcomeReport(store, [root.id]).rows.reduce((a, c) => a + c.total, 0));
  });

  it('tree scope adds the other nodes of the business tree and never another tree', () => {
    const { store, child, isExp } = setup();
    const tree = metricsReport(store, { workspaceId: child.id, scope: 'tree', groupBy: 'model', isExperimentRun: isExp });
    expect(tree.workspaceIds).toHaveLength(2);
    expect(tree.groups.map((g) => g.key)).toEqual(['claude/haiku', 'claude/opus', 'claude/sonnet']);
    expect(tree.totals.runs).toBe(5);
    expect(tree.totals.costUsd).toBe(1.9);
    const node = metricsReport(store, { workspaceId: child.id, scope: 'node', isExperimentRun: isExp });
    expect(node.totals).toMatchObject({ runs: 1, tasks: 1, verified: 1, meanRounds: 2, costUsd: 0.05 });
  });

  it('includes experiment runs (and what they produced) only on request', () => {
    const { store, root, isExp } = setup();
    const off = metricsReport(store, { workspaceId: root.id, scope: 'node', isExperimentRun: isExp });
    const on = metricsReport(store, { workspaceId: root.id, scope: 'node', isExperimentRun: isExp, includeExperiments: true });
    expect(off.totals).toMatchObject({ runs: 4, tasks: 3, ratings: 2, costUsd: 1.85 });
    expect(on.totals).toMatchObject({ runs: 5, tasks: 4, ratings: 3, costUsd: 6.85 });
    expect(on.experiments).toEqual({ included: true, excludedRuns: 0 });
  });

  it('by default leaves out the runs WP-F tags (experiment and audit runs), with a toggle to include them', () => {
    const { store, root } = setup();
    // The real WP-F columns: x1 is an experiment arm run, rev1 a reviewer-audit run.
    store.db.prepare("UPDATE agent_runs SET experiment_id = 'exp_1', arm = 'B' WHERE id = 'x1'").run();
    tagRun(store, 'rev1', { auditId: 'aud_1', lessonsOff: true });
    expect(isExperimentRun(store, store.agentRuns.get('x1')!)).toBe(true);
    expect(isExperimentRun(store, store.agentRuns.get('rev1')!)).toBe(true);
    expect(isExperimentRun(store, store.agentRuns.get('w1')!)).toBe(false);
    const off = metricsReport(store, { workspaceId: root.id, scope: 'node' });
    expect(off.experiments).toEqual({ included: false, excludedRuns: 2 });
    expect(off.totals).toMatchObject({ runs: 3, costUsd: 1.6 });
    const on = metricsReport(store, { workspaceId: root.id, scope: 'node', includeExperiments: true });
    expect(on.experiments).toEqual({ included: true, excludedRuns: 0 });
    expect(on.totals).toMatchObject({ runs: 5, costUsd: 6.85 });
  });

  it('time series by week and by day, gaps filled, inside the window', () => {
    const { store, root, isExp } = setup();
    const week = metricsReport(store, { workspaceId: root.id, scope: 'node', bucket: 'week', isExperimentRun: isExp });
    expect(week.series.map((p) => [p.bucket, p.runs, p.tasks, p.costUsd])).toEqual([
      ['2026-11-02', 3, 2, 0.85],
      ['2026-11-09', 1, 1, 1],
    ]);
    const day = metricsReport(store, { workspaceId: root.id, scope: 'node', bucket: 'day', isExperimentRun: isExp });
    expect(day.series.map((p) => p.bucket)).toEqual([
      '2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06', '2026-11-07', '2026-11-08', '2026-11-09', '2026-11-10',
    ]);
    expect(day.series[3]).toMatchObject({ runs: 0, passRate: null, costUsd: 0 });
    // Per-group series share the bucket axis.
    const worker = day.groupSeries.find((g) => g.key === 'worker')!;
    expect(worker.points.map((p) => p.runs)).toEqual([1, 1, 0, 0, 0, 0, 0, 0, 1]);

    const windowed = metricsReport(store, { workspaceId: root.id, scope: 'node', since: '2026-11-09T00:00:00.000Z', isExperimentRun: isExp });
    expect(windowed.totals).toMatchObject({ runs: 1, tasks: 1, unverified: 1, ratings: 1, outcomes: 0, costUsd: 1 });
    expect(windowed.window).toEqual({ since: '2026-11-09T00:00:00.000Z', until: null });
    const until = metricsReport(store, { workspaceId: root.id, scope: 'node', until: '2026-11-02T23:59:59.999Z', isExperimentRun: isExp });
    expect(until.totals).toMatchObject({ runs: 2, tasks: 1, outcomes: 1 });
  });

  it('weeks start on Monday (UTC)', () => {
    expect(bucketOf('2026-11-08T23:00:00.000Z', 'week')).toBe('2026-11-02'); // Sunday
    expect(bucketOf('2026-11-09T00:00:00.000Z', 'week')).toBe('2026-11-09');
    expect(bucketOf('2026-11-09T13:00:00.000Z', 'day')).toBe('2026-11-09');
    expect(bucketOf('not a date', 'day')).toBeNull();
  });

  it('groups by task type and carries the knowledge metrics with human reads kept apart', () => {
    const { store, root, isExp } = setup();
    const r = metricsReport(store, { workspaceId: root.id, scope: 'node', groupBy: 'task_type', isExperimentRun: isExp });
    expect(r.groups.find((g) => g.key === 'competitor_scan')).toMatchObject({ runs: 1, tasks: 1, failed: 1 });
    expect(r.knowledge.retrieval).toMatchObject({ retrievals: 1, zeroResultRate: 1, user: { reads: 1 } });
    expect(r.knowledge.byGroup).toEqual([
      expect.objectContaining({ key: 'news_scan', retrievals: 1, searches: 1, zeroResultSearches: 1, zeroResultRate: 1, hitRate: 0 }),
    ]);
    expect(r.knowledge.store.facts.total).toBe(0);
  });
});
