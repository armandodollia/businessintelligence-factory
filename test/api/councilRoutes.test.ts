import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/api/routes.js';
import type { BifConfig } from '../../src/core/config/schema.js';
import { councilStep } from '../../src/core/council/round.js';
import { councilFor } from '../../src/core/council/settings.js';
import { councilReviewDecisions } from '../../src/core/council/store.js';
import type { FakeScript } from '../../src/core/harness/adapter.js';
import { runTaskWithReview } from '../../src/core/research/reviewLoop.js';
import type { Store } from '../../src/core/store/db.js';
import type { Task } from '../../src/core/types.js';
import { createWorkspace } from '../../src/core/workspace/tree.js';
import { TASK_COPY, addTask, researchSetup, review, revise, submitCopyOnly, submitWork, withTaskIds, workDone, type Picker } from '../core/helpers/research.js';

const opened: Store[] = [];
afterEach(() => {
  for (const s of opened.splice(0)) s.close();
});

type Council = NonNullable<BifConfig['council']>;
type Sent = { score: number; issues?: Array<Record<string, unknown>>; questions?: string[]; follow_ups?: string[] };

const REVENUE = 'The revenue figure in the finding does not match the cited filing';

const COUNCIL: Council = {
  rounds: 2,
  members: [
    { name: 'a', provider: 'claude', model: 'opus', lens: 'evidence' },
    { name: 'b', provider: 'codex', model: 'gpt-6.1-sol', lens: 'reasoning', effort: 'high' },
    { name: 'x', provider: 'opencode', model: 'big-pickle', lens: 'privacy', blocking: false },
    { name: 'spare', provider: 'claude', model: 'opus-9', lens: 'value' },
  ],
  stages: { news_scan: { members: ['a', 'b', 'x'], passScore: 8 }, own_stakeholders: { members: ['a', 'b'] } },
};

const send =
  (r: Sent): FakeScript =>
  async (t) => {
    await t.call('submit_review', { issues: [], summary: `score ${r.score}`, ...r });
  };

/** Round 1: member a upholds one issue (on the task's evidence copy) and asks a question, b names a follow-up; round 2: both pass. */
const members = (name: string, round: number): Sent =>
  round > 1
    ? { score: 9 }
    : name === 'a'
      ? { score: 6, issues: [{ class: 'blocking', description: REVENUE, evidence: [TASK_COPY] }], questions: ['Is the filing the latest one?'] }
      : { score: 9, follow_ups: ['Check the pricing page of the second product'] };

function setup(council: Council | null = COUNCIL) {
  const pick: Picker = (req) => {
    if (req.kind === 'work') return submitWork();
    if (req.kind === 'revise') return revise('fix')(req);
    const name = req.runTags?.councilMember;
    return name ? send(withTaskIds(t.store, req.task, members(name, req.round))) : review(9);
  };
  const t = researchSetup(opened, { config: (c) => void (council ? (c.council = structuredClone(council)) : undefined), pick });
  const app = createApp({ store: t.store, artifacts: t.artifacts, events: t.events, config: t.config, research: t.deps });
  const get = async (path: string) => {
    const res = await app.request(path);
    return { status: res.status, body: (await res.json()) as any };
  };
  const root = createWorkspace(t.store, { name: 'Acme', sector: 'saas' });
  const child = createWorkspace(t.store, { name: 'Acme Payments', sector: 'saas', parentWorkspaceId: root.id });
  const other = createWorkspace(t.store, { name: 'Globex', sector: 'saas' });
  const task = (extra: Partial<Task> = {}) => addTask(t.store, { workspaceId: root.id, ...extra });
  /** The council of a task, asked from its own node. */
  const url = (x: Task) => `/api/workspaces/${x.workspaceId}/tasks/${x.id}/council`;
  return { ...t, app, get, root, child, other, task, url };
}

describe('GET /api/workspaces/:id/tasks/:taskId/council', () => {
  it('serves the stage rules and every round: members with their scores and states, issues with who raised them, questions and follow-ups', async () => {
    const t = setup();
    const task = t.task();
    expect(await runTaskWithReview(task, t.deps)).toMatchObject({ status: 'verified', round: 2 });
    const [d1, d2] = councilReviewDecisions(t.store, task);

    const res = await t.get(t.url(task));
    expect(res.status).toBe(200);
    expect(res.body.stage).toEqual({ rounds: 2, passScore: 8, blockOn: 'any', onUnavailable: 'fail' });
    expect(res.body).not.toHaveProperty('withheld');
    expect(res.body.rounds.map((r: any) => [r.round, r.decisionId, r.result.pass, r.result.score])).toEqual([
      [1, d1!.id, false, 6],
      [2, d2!.id, true, 9],
    ]);
    const [r1] = res.body.rounds;
    expect(r1.at).toBe(d1!.createdAt);
    expect(r1.result.members.map((m: any) => [m.name, m.provider, m.model, m.lens, m.blocking, m.state, m.score])).toEqual([
      ['a', 'claude', 'opus', 'evidence', true, 'reviewed', 6],
      ['b', 'codex', 'gpt-6.1-sol', 'reasoning', true, 'reviewed', 9],
      ['x', 'opencode', 'big-pickle', 'privacy', false, 'unavailable', undefined],
    ]);
    expect(r1.result.members[2].reason).toBe("provider 'opencode' is not enabled");
    const copy = t.store.findings.list({ taskId: task.id })[0]!.evidence[0]!;
    expect(r1.result.issues).toMatchObject([{ id: 'I1', class: 'blocking', description: REVENUE, evidence: [copy], raisedBy: ['a'], standing: 'upheld' }]);
    expect(r1.result.questions).toEqual([{ text: 'Is the filing the latest one?', raisedBy: ['a'] }]);
    expect(r1.result.followUps).toEqual([{ text: 'Check the pricing page of the second product', raisedBy: ['b'] }]);
    expect(res.body.rounds[1].result.issues).toEqual([]);
  });

  it('a task that was not reviewed by a council has no rounds, and no stage when its type is not a council stage', async () => {
    const t = setup();
    const single = t.task({ type: 'public_filings' });
    await runTaskWithReview(single, t.deps);
    expect((await t.get(t.url(single))).body).toEqual({ rounds: [] });
    // A council stage whose task has not been reviewed yet: the rules, and no round.
    const queued = t.task();
    expect((await t.get(t.url(queued))).body).toEqual({ stage: { rounds: 2, passScore: 8, blockOn: 'any', onUnavailable: 'fail' }, rounds: [] });
    // No council block at all.
    const plain = setup(null);
    const task = plain.task();
    await runTaskWithReview(task, plain.deps);
    expect((await plain.get(plain.url(task))).body).toEqual({ rounds: [] });
  });

  it('an unknown task answers 404, and so does an unknown workspace', async () => {
    const t = setup();
    const res = await t.get(`/api/workspaces/${t.root.id}/tasks/tsk_missing/council`);
    expect(res).toEqual({ status: 404, body: { error: "task 'tsk_missing' not found" } });
    const task = t.task();
    expect(await t.get(`/api/workspaces/ws_missing/tasks/${task.id}/council`)).toEqual({ status: 404, body: { error: "workspace 'ws_missing' not found" } });
  });

  it('is tree-checked: a task of the same business tree is served from any of its nodes, one of another tree answers exactly like an unknown one', async () => {
    const t = setup();
    const task = t.task();
    await runTaskWithReview(task, t.deps);
    const own = await t.get(`/api/workspaces/${t.root.id}/tasks/${task.id}/council`);
    expect(own.status).toBe(200);
    expect(own.body.rounds).toHaveLength(2);
    // Another node of the same tree.
    expect((await t.get(`/api/workspaces/${t.child.id}/tasks/${task.id}/council`)).body).toEqual(own.body);

    const foreign = await t.get(`/api/workspaces/${t.other.id}/tasks/${task.id}/council`);
    const unknown = await t.get(`/api/workspaces/${t.other.id}/tasks/tsk_missing/council`);
    expect(foreign).toEqual({ status: 404, body: { error: `task '${task.id}' not found` } });
    expect(unknown).toEqual({ status: 404, body: { error: "task 'tsk_missing' not found" } });
    expect(JSON.stringify(foreign.body)).not.toContain(REVENUE);
  });

  it('there is no route that reads a task\'s council by the task id alone', async () => {
    const t = setup();
    const task = t.task();
    await runTaskWithReview(task, t.deps);
    for (const path of [`/api/tasks/${task.id}/council`, `/api/tasks/${task.id}/council?workspaceId=${t.root.id}`]) {
      const res = await t.get(path);
      expect(res.status, path).toBe(404);
      expect(JSON.stringify(res.body), path).not.toContain(REVENUE);
      expect(res.body, path).not.toHaveProperty('rounds');
    }
  });

  it('private research: the rounds of a withheld own-stakeholder task are served as withheld, without members, scores, issues or reasons', async () => {
    const t = setup();
    const task = t.task({ type: 'own_stakeholders', phase: 'stakeholders', status: 'reviewing' });
    await workDone(t, task, submitCopyOnly('private'));
    await councilStep(t.deps, task.id, 1, councilFor(t.config, 'own_stakeholders')!);
    const [d] = councilReviewDecisions(t.store, task);

    const res = await t.get(t.url(task));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      stage: { rounds: 2, passScore: 9, blockOn: 'any', onUnavailable: 'fail' },
      withheld: true,
      rounds: [{ round: 1, decisionId: d!.id, at: d!.createdAt, withheld: true }],
    });
    expect(JSON.stringify(res.body)).not.toContain(REVENUE);

    // Once the research has finished and no stakeholder of the node is hidden, it is served like any other.
    t.store.tasks.update(task.id, { status: 'unverified' });
    const open = await t.get(t.url(task));
    expect(open.body).not.toHaveProperty('withheld');
    expect(open.body.rounds[0].result.issues).toMatchObject([{ description: REVENUE, raisedBy: ['a'] }]);
  });
});

describe('where a council-reviewed task is listed (design §9)', () => {
  it('the task list marks a task a council reviewed, also when it passed; a task with a single reviewer is served as before', async () => {
    const t = setup();
    const councilTask = t.task();
    const single = t.task({ type: 'public_filings' });
    const queued = t.task();
    expect(await runTaskWithReview(councilTask, t.deps)).toMatchObject({ status: 'verified' });
    await runTaskWithReview(single, t.deps);
    const list = (await t.get(`/api/workspaces/${t.root.id}/tasks`)).body as Array<Record<string, unknown>>;
    expect(list.map((x) => [x.id, x.status, x.councilReviewed])).toEqual([
      [councilTask.id, 'verified', true],
      [single.id, 'verified', undefined],
      [queued.id, 'queued', undefined],
    ]);
    expect(list[1]).toEqual(JSON.parse(JSON.stringify(t.store.tasks.get(single.id))));
    // Private research: the withheld task still says that a council reviewed it (its table is served withheld).
    const priv = t.task({ type: 'own_stakeholders', phase: 'stakeholders', status: 'reviewing' });
    await workDone(t, priv, submitCopyOnly('private'));
    await councilStep(t.deps, priv.id, 1, councilFor(t.config, 'own_stakeholders')!);
    const served = ((await t.get(`/api/workspaces/${t.root.id}/tasks`)).body as Array<Record<string, unknown>>).find((x) => x.id === priv.id)!;
    expect(served).toMatchObject({ withheld: true, councilReviewed: true });
    expect(served).not.toHaveProperty('brief');
  });

  it("the Decision list marks a member's own review with the member's name and lens; the round's review and a single review are not marked", async () => {
    const t = setup();
    const task = t.task();
    const single = t.task({ type: 'public_filings' });
    await runTaskWithReview(task, t.deps);
    await runTaskWithReview(single, t.deps);
    const reviews = (await t.get(`/api/workspaces/${t.root.id}/decisions?kind=review`)).body as Array<{ payload: { tool: string; event?: string }; councilMember?: unknown }>;
    expect(reviews.map((d) => [d.payload.event ?? d.payload.tool, d.councilMember])).toEqual([
      ['submit_review', { name: 'a', lens: 'evidence' }],
      ['submit_review', { name: 'b', lens: 'reasoning' }],
      ['council_review', undefined],
      ['submit_review', { name: 'a', lens: 'evidence' }],
      ['submit_review', { name: 'b', lens: 'reasoning' }],
      ['council_review', undefined],
      ['submit_review', undefined],
    ]);
    // The lens is the one the member had in its round, whatever the configuration says now.
    t.config.council!.members[0]!.lens = 'privacy';
    const later = (await t.get(`/api/workspaces/${t.root.id}/decisions?kind=review`)).body as Array<{ councilMember?: unknown }>;
    expect(later[0]!.councilMember).toEqual({ name: 'a', lens: 'evidence' });
  });

  it('a live Decision event of a member run is marked too, before its round is recorded', async () => {
    const t = setup();
    const task = t.task();
    const ac = new AbortController();
    const res = await t.app.request(`/api/events?workspaceId=${t.root.id}`, { signal: ac.signal });
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let text = dec.decode((await reader.read()).value); // connection comment
    await runTaskWithReview(task, t.deps);
    while (!text.includes('"task_status"')) text += dec.decode((await reader.read()).value);
    const decisions = text
      .split('\n')
      .filter((l) => l.startsWith('data: '))
      .map((l) => JSON.parse(l.slice(6)) as { type: string; decision?: { kind: string; payload: { tool: string }; councilMember?: unknown } })
      .filter((e) => e.type === 'decision' && e.decision!.kind === 'review')
      .map((e) => e.decision!);
    expect(decisions.map((d) => [d.payload.tool, d.councilMember])).toEqual([
      ['submit_review', { name: 'a', lens: 'evidence' }],
      ['submit_review', { name: 'b', lens: 'reasoning' }],
      ['submit_review', { name: 'a', lens: 'evidence' }],
      ['submit_review', { name: 'b', lens: 'reasoning' }],
    ]);
    await reader.cancel();
    ac.abort();
  });
});

describe('GET /api/council', () => {
  it('serves the configured council with the defaults applied, each member available or not and why, and the stages', async () => {
    const t = setup();
    const res = await t.get('/api/council');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      council: {
        rounds: 2, passScore: 9, blockOn: 'any', onUnavailable: 'fail',
        members: [
          { name: 'a', provider: 'claude', model: 'opus', lens: 'evidence', blocking: true, available: true, stages: ['news_scan', 'own_stakeholders'] },
          { name: 'b', provider: 'codex', model: 'gpt-6.1-sol', effort: 'high', lens: 'reasoning', blocking: true, available: true, stages: ['news_scan', 'own_stakeholders'] },
          { name: 'x', provider: 'opencode', model: 'big-pickle', lens: 'privacy', blocking: false, available: false, reason: "provider 'opencode' is not enabled", stages: ['news_scan'] },
          { name: 'spare', provider: 'claude', model: 'opus-9', lens: 'value', blocking: true, available: false, reason: "model 'opus-9' is not in providers.claude.models", stages: [] },
        ],
        stages: [
          { taskType: 'news_scan', rounds: 2, passScore: 8, members: ['a', 'b', 'x'] },
          { taskType: 'own_stakeholders', rounds: 2, passScore: 9, members: ['a', 'b'] },
        ],
      },
    });
  });

  it('answers `council: null` when no council is configured', async () => {
    const t = setup(null);
    expect(await t.get('/api/council')).toEqual({ status: 200, body: { council: null } });
  });
});
