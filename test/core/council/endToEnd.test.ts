import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../../../src/api/routes.js';
import type { BifConfig } from '../../../src/core/config/schema.js';
import { LOOK_FOR } from '../../../src/core/council/lenses.js';
import { councilMemberOf, councilReviewDecisions, councilRounds } from '../../../src/core/council/store.js';
import type { FakeScript } from '../../../src/core/harness/adapter.js';
import { reviewIssueHistory } from '../../../src/core/learning/reviewIssues.js';
import type { AgentRequest } from '../../../src/core/research/deps.js';
import { startPhase } from '../../../src/core/research/orchestrator.js';
import { researchToolHandlers } from '../../../src/core/research/tools.js';
import type { Store } from '../../../src/core/store/db.js';
import type { Task } from '../../../src/core/types.js';
import { researchSetup, review, revise, submitWork } from '../helpers/research.js';

/**
 * End to end with fake agents (design §10): one research run whose orchestrator proposes a task of a
 * council stage (`news_scan`) and a task of a type that keeps its single reviewer (`public_filings`).
 * The council task goes through two rounds; the other is reviewed exactly as with no council configured.
 */

const opened: Store[] = [];
afterEach(() => {
  for (const s of opened.splice(0)) s.close();
});

type Council = NonNullable<BifConfig['council']>;

const COUNCIL: Council = {
  rounds: 3,
  members: [
    { name: 'evidence', provider: 'claude', model: 'opus', lens: 'evidence' },
    { name: 'brief', provider: 'claude', model: 'sonnet', lens: 'brief' },
    { name: 'second', provider: 'codex', model: 'gpt-6.1-sol', lens: 'reasoning', effort: 'high' },
    { name: 'redo', provider: 'claude', model: 'haiku', lens: 'rewrite', blocking: false },
  ],
  stages: { news_scan: {} },
};

const DATE = 'The article date in the finding is not the date on the cited page';

const spec = (type: string) => ({
  type, brief: `do ${type}`, subject: 'Acme', model: { provider: 'claude', model: 'sonnet' }, needs_browser: false, acceptance_criteria: ['at least one dated source'],
});

const send =
  (r: Record<string, unknown>): FakeScript =>
  async (t) => {
    await t.call('submit_review', { issues: [], summary: `score ${String(r.score)}`, ...r });
  };

/**
 * Round 1: `evidence` upholds one issue, `brief` sends a nit with a low score, `second` a scope issue.
 * Round 2: all pass. The non-blocking `redo` never ends by itself: no round waits for it.
 */
const memberScript = (name: string, round: number, copy: string): FakeScript => {
  if (name === 'redo') return () => new Promise<void>(() => {});
  if (round > 1) return send({ score: name === 'evidence' ? 9 : 9.5 });
  if (name === 'evidence') return send({ score: 6, issues: [{ class: 'blocking', description: DATE, evidence: [copy] }] });
  if (name === 'brief') return send({ score: 7, issues: [{ class: 'nit', description: 'The summary is long' }] });
  return send({ score: 9, issues: [{ class: 'scope_expansion', description: 'The competitor pricing is not covered' }] });
};

async function run(council?: Council) {
  const s = researchSetup(opened, {
    extraHandlers: () => researchToolHandlers(),
    config: (c) => void (council ? (c.council = structuredClone(council)) : undefined),
    pick: (r) => {
      if (r.kind === 'orchestrate') {
        return r.round === 1
          ? async (t) => {
              await t.call('propose_tasks', { tasks: [spec('news_scan'), spec('public_filings')] });
            }
          : async () => {};
      }
      if (r.kind === 'work') return submitWork({ summary: `result of ${r.task!.type}` }, `claim of ${r.task!.type}`);
      if (r.kind === 'revise') return revise('fix')(r);
      const name = r.runTags?.councilMember;
      // The single reviewer of either type: one issue in round 1, a pass in round 2.
      if (!name) return r.round === 1 ? review(6, [{ class: 'substantive', description: 'thin evidence' }]) : review(9);
      // The evidence copy of the task under review: an issue counts only for evidence of the task's review slice.
      return memberScript(name, r.round, s.store.findings.list({ taskId: r.task!.id })[0]!.evidence[0]!);
    },
  });
  s.store.workspaces.insert({ id: 'ws_a', name: 'Acme', sector: 'saas', createdAt: new Date().toISOString() } as never);
  const researchRun = await startPhase('ws_a', 'deep_dives', s.deps);
  const tasks = s.store.tasks.list({ runId: researchRun.id });
  const byType = (type: Task['type']) => tasks.find((t) => t.type === type)!;
  const app = createApp({ store: s.store, artifacts: s.artifacts, events: s.events, config: s.config, research: s.deps });
  const get = async (path: string) => (await (await app.request(path)).json()) as any;
  return { ...s, researchRun, tasks, byType, get };
}

/** What a task left behind, without ids and times: its requests, runs, Decisions and issue history. */
function trace(s: Awaited<ReturnType<typeof run>>, task: Task) {
  const ids = new Map<string, string>();
  const normalize = <T>(v: T): T =>
    JSON.parse(
      JSON.stringify(v)
        .replace(/\b[a-z]+_[0-9A-Z]{26}\b/g, (id) => ids.get(id) ?? (ids.set(id, `${id.split('_')[0]}#${ids.size}`), ids.get(id)!))
        .replace(/"(?:createdAt|startedAt|endedAt|capturedAt|resolvedAt)":"[^"]+"/g, '"at":"T"'),
    ) as T;
  const runs = s.store.agentRuns.list({ taskId: task.id });
  return normalize({
    task: (({ status, round, failureReason }) => ({ status, round, failureReason: failureReason ?? null }))(s.store.tasks.get(task.id)!),
    requests: s.requests.filter((r) => r.task?.id === task.id).map((r) => ({ ...r, task: undefined })),
    runs: runs.map((r) => ({ role: r.role, model: r.model, status: r.status, round: r.round, promptVersion: r.promptVersion, member: councilMemberOf(s.store, r.id) ?? null })),
    decisions: s.store.decisions
      .list({ workspaceId: 'ws_a' })
      .filter((d) => runs.some((r) => r.id === d.agentRunId) || d.refs.includes(task.id))
      .map((d) => ({ role: d.role, model: d.model, kind: d.kind, payload: d.payload, refs: d.refs, promptVersion: d.promptVersion })),
    history: reviewIssueHistory(s.store, task.id).map((t) => t.rounds.map((r) => ({ ...r, id: undefined }))),
    findings: s.store.findings.list({ taskId: task.id }).map((f) => ({ claim: f.claim, status: f.status })),
  });
}

describe('a research run with a council stage and a single-reviewer task type', () => {
  it('the council stage is reviewed by its members round by round; the other task type exactly as with no council', async () => {
    const s = await run(COUNCIL);
    expect(s.researchRun.status).toBe('done');
    expect(s.tasks.map((t) => [t.type, t.status, t.round]).sort()).toEqual([
      ['news_scan', 'verified', 2],
      ['public_filings', 'verified', 2],
    ]);
    const councilTask = s.byType('news_scan');
    const singleTask = s.byType('public_filings');

    // --- the council stage ---------------------------------------------------------------------
    const memberRequests = s.requests.filter((r) => r.task?.id === councilTask.id && r.kind === 'review');
    expect(memberRequests.map((r) => [r.round, r.runTags?.councilMember, r.effort])).toEqual([
      [1, 'evidence', undefined],
      [1, 'brief', undefined],
      [1, 'second', 'high'],
      [1, 'redo', undefined],
      [2, 'evidence', undefined],
      [2, 'brief', undefined],
      [2, 'second', 'high'],
      [2, 'redo', undefined],
    ]);
    // Eight member runs, each a reviewer run of its own on the member's own model; none is left running.
    const memberRuns = s.store.agentRuns.list({ taskId: councilTask.id, role: 'reviewer' });
    expect(new Set(memberRuns.map((r) => r.id)).size).toBe(8);
    expect(memberRuns.map((r) => [r.round, councilMemberOf(s.store, r.id)?.member, `${r.model.provider}/${r.model.model}`, r.status])).toEqual([
      [1, 'evidence', 'claude/opus', 'done'],
      [1, 'brief', 'claude/sonnet', 'done'],
      [1, 'second', 'codex/gpt-6.1-sol', 'done'],
      [1, 'redo', 'claude/haiku', 'failed'],
      [2, 'evidence', 'claude/opus', 'done'],
      [2, 'brief', 'claude/sonnet', 'done'],
      [2, 'second', 'codex/gpt-6.1-sol', 'done'],
      [2, 'redo', 'claude/haiku', 'failed'],
    ]);
    // Each member's prompt holds its own lens and no other member's.
    const lensOf = (r: AgentRequest) => COUNCIL.members.find((m) => m.name === r.runTags!.councilMember)!.lens;
    for (const r of memberRequests) {
      expect(r.systemPrompt).toContain(LOOK_FOR[lensOf(r)]);
      for (const other of ['evidence', 'brief', 'reasoning'] as const) if (other !== lensOf(r)) expect(r.systemPrompt).not.toContain(LOOK_FOR[other]);
    }
    // One review per round, read as the task's review. Round 1 failed on the one upheld issue: the nit
    // with its low score and the scope issue did not count, and the non-blocking member was not waited for.
    const rounds = councilRounds(s.store, councilTask.id);
    expect(councilReviewDecisions(s.store, councilTask)).toHaveLength(2);
    expect(rounds.map((r) => [r.round, r.result.pass, r.result.score])).toEqual([[1, false, 6], [2, true, 9]]);
    const [r1] = rounds;
    expect(r1!.result.issues.map((i) => [i.id, i.class, i.description, i.raisedBy, i.standing])).toEqual([
      ['I1', 'blocking', DATE, ['evidence'], 'upheld'],
    ]);
    expect(r1!.result.dropped.map((d) => [d.rule, d.raisedBy])).toEqual([['nit', ['brief']], ['scope', ['second']]]);
    expect(r1!.result.followUps).toEqual([{ text: 'The competitor pricing is not covered', raisedBy: ['second'] }]);
    expect(r1!.result.members.map((m) => [m.name, m.state, m.score, m.countedScore, m.unsupportedScore ?? false])).toEqual([
      ['evidence', 'reviewed', 6, 6, false],
      ['brief', 'reviewed', 7, 9, true],
      ['second', 'reviewed', 9, 9, false],
      ['redo', 'not_waited', undefined, undefined, false],
    ]);
    // The worker answered the upheld issue only.
    const revision = s.requests.find((r) => r.task?.id === councilTask.id && r.kind === 'revise')!.prompt;
    expect(revision).toContain(`- [I1] (blocking) ${DATE}`);
    expect(revision).not.toContain('The summary is long');
    expect(reviewIssueHistory(s.store, councilTask.id).map((t) => [t.issueId, t.status])).toEqual([['I1', 'fixed']]);

    // --- the task type that keeps its single reviewer ------------------------------------------
    const plain = await run();
    expect(plain.tasks.map((t) => [t.type, t.status, t.round]).sort()).toEqual([
      ['news_scan', 'verified', 2],
      ['public_filings', 'verified', 2],
    ]);
    const single = trace(s, singleTask);
    expect(single.runs.map((r) => [r.role, r.model.provider, r.member])).toEqual([
      ['worker', 'claude', null],
      ['reviewer', 'codex', null],
      ['worker', 'claude', null],
      ['reviewer', 'codex', null],
    ]);
    expect(single).toEqual(trace(plain, plain.byType('public_filings')));
    expect(councilRounds(s.store, singleTask.id)).toEqual([]);
    // With no council block, the council stage's task type is reviewed by the single reviewer too.
    expect(councilRounds(plain.store, plain.byType('news_scan').id)).toEqual([]);
    expect(plain.store.agentRuns.list({ taskId: plain.byType('news_scan').id, role: 'reviewer' })).toHaveLength(2);

    // --- what the API serves ---------------------------------------------------------------------
    const table = await s.get(`/api/workspaces/ws_a/tasks/${councilTask.id}/council`);
    expect(table.stage).toEqual({ rounds: 3, passScore: 9, blockOn: 'any', onUnavailable: 'fail' });
    expect(table.rounds.map((r: any) => r.result.members.map((m: any) => (m.state === 'reviewed' ? `${m.score}/10` : m.state)))).toEqual([
      ['6/10', '7/10', '9/10', 'not_waited'],
      ['9/10', '9.5/10', '9.5/10', 'not_waited'],
    ]);
    expect(await s.get(`/api/workspaces/ws_a/tasks/${singleTask.id}/council`)).toEqual({ rounds: [] });
    const findings = (await s.get('/api/workspaces/ws_a/findings')) as Array<{ taskId: string; status: string; lastReview?: { score: number; council?: { taskId: string } } }>;
    const current = findings.filter((f) => f.status === 'verified');
    expect(current.map((f) => [f.taskId === councilTask.id ? 'council' : 'single', f.lastReview?.score, f.lastReview?.council ?? null]).sort()).toEqual([
      ['council', 9, { taskId: councilTask.id }],
      ['single', 9, null],
    ]);
  });
});
