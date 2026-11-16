import { afterEach, describe, expect, it } from 'vitest';
import type { BifConfig } from '../../../src/core/config/schema.js';
import { councilRoundNote, councilSection } from '../../../src/core/council/lenses.js';
import { NOT_WAITED_REASON, councilStep, reviewOfCurrentWork } from '../../../src/core/council/round.js';
import { councilFor, type CouncilStage } from '../../../src/core/council/settings.js';
import { COUNCIL_REVIEW_EVENT, councilMemberOf, councilReviewDecisions, councilReviewOf, councilRounds, isCouncilMemberRun } from '../../../src/core/council/store.js';
import { AbortError } from '../../../src/core/events.js';
import type { FakeScript } from '../../../src/core/harness/adapter.js';
import { listOutcomes } from '../../../src/core/learning/outcomes.js';
import { reviewIssueHistory } from '../../../src/core/learning/reviewIssues.js';
import { recordUsage, usageByRun, usageTotals } from '../../../src/core/metrics/usage.js';
import { decisionTags } from '../../../src/core/learning/runTags.js';
import type { AgentRequest } from '../../../src/core/research/deps.js';
import { reviewerRunInput, runTaskWithReview } from '../../../src/core/research/reviewLoop.js';
import type { Store } from '../../../src/core/store/db.js';
import type { Task } from '../../../src/core/types.js';
import { TASK_COPY, TASK_FINDING, addTask, researchSetup, review, revise, submitWork, tick, withTaskIds, type Picker } from '../helpers/research.js';

const opened: Store[] = [];
afterEach(() => {
  for (const s of opened.splice(0)) s.close();
});

type Council = NonNullable<BifConfig['council']>;
type Sent = { score: number | null; issues?: Array<Record<string, unknown>>; summary?: string; questions?: string[]; follow_ups?: string[] };

/** Three members on two CLIs; `news_scan` (the type `addTask` makes) is the council stage. */
const COUNCIL: Council = {
  members: [
    { name: 'a', provider: 'claude', model: 'opus', lens: 'evidence' },
    { name: 'b', provider: 'codex', model: 'gpt-6.1-sol', lens: 'reasoning', effort: 'high' },
    { name: 'c', provider: 'claude', model: 'sonnet', lens: 'brief' },
  ],
  stages: { news_scan: {} },
};

const council = (over: Partial<Council> = {}) => (c: BifConfig) => void (c.council = { ...structuredClone(COUNCIL), ...over });

const member = (req: AgentRequest): string | undefined => req.runTags?.councilMember;

const send =
  (r: Sent): FakeScript =>
  async (t) => {
    await t.call('submit_review', { issues: [], summary: `score ${r.score}`, ...r });
  };

/** A member script per name; a function gets the request (round, prompt). */
type Scripts = Record<string, Sent | FakeScript | ((req: AgentRequest) => Sent | FakeScript)>;

const scripted = (x: Sent | FakeScript): FakeScript => (typeof x === 'function' ? x : send(x));

/** The reviewed task's own finding and its evidence copy, as a member script writes them (`withTaskIds`). */
const OUTPUT = TASK_FINDING;
const COPY = TASK_COPY;

/** A member's review with the real ids of the task under review (store: the test's latest). */
const withRealIds = (sent: Sent | FakeScript, task: Task | undefined): Sent | FakeScript => (typeof sent === 'function' ? sent : withTaskIds(opened.at(-1)!, task, sent));

/** Picker: the worker submits, a revision answers every listed issue (`answer`), members follow `scripts`. */
const pick =
  (scripts: Scripts, answer: 'fix' | 'pushback' = 'fix'): Picker =>
  (req) => {
    if (req.kind === 'work') return submitWork();
    if (req.kind === 'revise') return revise(answer)(req);
    const name = member(req);
    if (!name) return undefined;
    const s = scripts[name];
    if (s === undefined) throw new Error(`no script for member ${name}`);
    return scripted(withRealIds(typeof s === 'function' && !isFake(s) ? (s as (r: AgentRequest) => Sent | FakeScript)(req) : (s as Sent | FakeScript), req.task));
  };

/** Marks a function in `Scripts` as the member's script itself (it takes the tool client), not a per-request function. */
const FAKES = new WeakSet<object>();
const isFake = (f: object) => FAKES.has(f);
const fake = (f: FakeScript): FakeScript => {
  FAKES.add(f);
  return f;
};
/** A member that never ends by itself. */
const never = (): FakeScript => fake(() => new Promise<void>(() => {}));

const REVENUE = 'The revenue figure in the finding does not match the cited filing';
const STALE = 'The pricing claim rests on a page captured two years ago';

const kinds = (requests: AgentRequest[]) => requests.map((r) => (r.kind === 'review' ? `review:${member(r) ?? 'single'}` : r.kind));
const rounds = (store: Store, task: Task) => councilReviewDecisions(store, task).map((d) => councilReviewOf(d)!);
const findingOf = (store: Store, task: Task) => store.findings.list({ taskId: task.id })[0]!.id;
const copyOf = (store: Store, task: Task) => store.findings.list({ taskId: task.id })[0]!.evidence[0]!;

describe('a council stage in the review loop', () => {
  it('three members through two rounds to verified: one review per round, members on their own models', async () => {
    const s = researchSetup(opened, {
      config: council(),
      pick: pick({
        a: (req: AgentRequest) => (req.round === 1 ? { score: 6, issues: [{ class: 'substantive', description: REVENUE, evidence: [COPY] }] } : { score: 9 }),
        b: { score: 9 },
        c: (req: AgentRequest) => (req.round === 1 ? { score: 9, issues: [{ class: 'nit', description: 'The title is long' }], questions: ['Is the 2024 figure audited?'] } : { score: 10 }),
      }),
    });
    const task = addTask(s.store);
    // What the supervisor is asked to run (the member's effort must reach it).
    const efforts: Array<string | undefined> = [];
    const run = s.supervisor.run.bind(s.supervisor);
    s.supervisor.run = (opts) => {
      if (opts.ctx.role === 'reviewer') efforts.push(opts.effort);
      return run(opts);
    };
    const out = await runTaskWithReview(task, s.deps);
    expect(out).toMatchObject({ status: 'verified', round: 2 });
    expect(efforts).toEqual([undefined, 'high', undefined, undefined, 'high', undefined]);
    expect(kinds(s.requests)).toEqual(['work', 'review:a', 'review:b', 'review:c', 'revise', 'review:a', 'review:b', 'review:c']);
    expect(s.store.findings.list({ taskId: task.id }).filter((f) => f.status === 'verified')).toHaveLength(1);

    // Members are reviewer runs on the configured models (no `reviewerFor`), tagged with their round and name.
    const runs = s.store.agentRuns.list({ taskId: task.id, role: 'reviewer' });
    expect(runs.map((r) => `${r.model.provider}/${r.model.model}`)).toEqual(['claude/opus', 'codex/gpt-6.1-sol', 'claude/sonnet', 'claude/opus', 'codex/gpt-6.1-sol', 'claude/sonnet']);
    expect(runs.every((r) => r.status === 'done' && isCouncilMemberRun(s.store, r.id))).toBe(true);
    const tags = runs.map((r) => councilMemberOf(s.store, r.id)!);
    expect(tags.map((t) => t.member)).toEqual(['a', 'b', 'c', 'a', 'b', 'c']);
    expect(new Set(tags.map((t) => t.roundId)).size).toBe(2);
    expect(s.requests.filter((r) => r.kind === 'review').map((r) => r.effort)).toEqual([undefined, 'high', undefined, undefined, 'high', undefined]);

    // One `council_review` Decision per round, whose run is the round.
    const decisions = councilReviewDecisions(s.store, task);
    expect(decisions.map((d) => [d.kind, d.role, d.agentRunId, d.refs, d.model.model])).toEqual([
      ['review', 'reviewer', tags[0]!.roundId, [task.id], 'council'],
      ['review', 'reviewer', tags[3]!.roundId, [task.id], 'council'],
    ]);
    const [r1, r2] = rounds(s.store, task);
    expect(r1).toMatchObject({
      tool: 'harness', event: COUNCIL_REVIEW_EVENT, taskId: task.id, round: 1, score: 6, pass: false, passScore: 9, blockOn: 'any', onUnavailable: 'fail',
      issues: [{ id: 'I1', class: 'substantive', description: REVENUE, evidence: [copyOf(s.store, task)], raisedBy: ['a'], standing: 'upheld' }],
      advisory: [],
      dropped: [{ issue: { id: 'I2', class: 'nit', description: 'The title is long' }, raisedBy: ['c'], rule: 'nit' }],
      questions: [{ text: 'Is the 2024 figure audited?', raisedBy: ['c'] }],
      followUps: [],
    });
    expect(r1!.members.map((m) => [m.name, m.provider, m.model, m.lens, m.blocking, m.state, m.score, m.countedScore, m.runId])).toEqual([
      ['a', 'claude', 'opus', 'evidence', true, 'reviewed', 6, 6, runs[0]!.id],
      ['b', 'codex', 'gpt-6.1-sol', 'reasoning', true, 'reviewed', 9, 9, runs[1]!.id],
      ['c', 'claude', 'sonnet', 'brief', true, 'reviewed', 9, 9, runs[2]!.id],
    ]);
    expect(r1).not.toHaveProperty('failed');
    expect(r2).toMatchObject({ round: 2, score: 9, pass: true, issues: [], advisory: [] });
    expect(councilRounds(s.store, task.id).map((r) => [r.round, r.decisionId, r.result.pass, r.result.score])).toEqual([
      [1, decisions[0]!.id, false, 6],
      [2, decisions[1]!.id, true, 9],
    ]);

    // The history holds what the council upheld, attached to the round and its Decision.
    const history = reviewIssueHistory(s.store, task.id);
    expect(history.map((t) => [t.issueId, t.status, t.rounds.map((r) => [r.round, r.reviewerRunId, r.reviewDecisionId])])).toEqual([
      ['I1', 'fixed', [[1, tags[0]!.roundId, decisions[0]!.id]]],
    ]);
    // The worker answered the upheld issue, and was shown the question as one that needs no answer.
    const revision = s.requests.find((r) => r.kind === 'revise')!.prompt;
    expect(revision).toContain(`- [I1] (substantive) ${REVENUE} (evidence: ${copyOf(s.store, task)})`);
    expect(revision).toContain('## Questions from reviewers');
    expect(revision).toContain('- Is the 2024 figure audited?');
    expect(revision).not.toContain('The title is long'); // a nit is not for the worker
    expect(revision).not.toMatch(/\b(raised by|member) [abc]\b/);
  });

  it('a member is started with what the single reviewer is started with, plus the council section; never with another review', async () => {
    const s = researchSetup(opened, {
      config: council(),
      pick: pick({
        a: { score: 5, issues: [{ class: 'blocking', description: 'SECRET_ISSUE_OF_A', evidence: [COPY] }] },
        b: { score: 9 },
        c: { score: 9 },
      }),
    });
    const task = addTask(s.store);
    s.config.council!.rounds = 1;
    await runTaskWithReview(task, s.deps);
    const now = s.store.tasks.get(task.id)!;
    const single = reviewerRunInput(s.deps, now, 1);
    const stage = councilFor(s.config, 'news_scan')!;
    const members = s.requests.filter((r) => r.kind === 'review');
    expect(members).toHaveLength(3);
    for (const [i, req] of members.entries()) {
      const m = stage.members[i]!;
      expect(req.role).toBe('reviewer');
      expect(req.prompt).toBe(single.prompt);
      expect(req.systemPrompt).toBe(`${single.systemPrompt}\n\n${councilSection(m, stage)}`);
      expect(req.systemPrompt).toContain(`Your lens: \`${m.lens}\``);
      expect(req.promptReads ?? []).toEqual(single.promptReads);
      expect(req.prompt + req.systemPrompt).not.toContain('SECRET_ISSUE_OF_A');
    }
    // The round's Decision carries the version of the reviewer prompt the members share, and its text is stored.
    const d = councilReviewDecisions(s.store, task)[0]!;
    expect(d.promptVersion).toBe(single.promptVersion);
    expect(s.store.db.prepare('SELECT COUNT(*) AS n FROM prompt_versions WHERE hash = ?').get(single.promptVersion)).toEqual({ n: 1 });
  });

  it("a member's system prompt (and so its prompt version) is the same in every round; the round is in its review prompt from round 2", async () => {
    const s = researchSetup(opened, {
      config: council(),
      pick: pick({ a: (req: AgentRequest) => (req.round === 1 ? { score: 6, issues: [{ class: 'substantive', description: REVENUE, where: [OUTPUT] }] } : { score: 9 }), b: { score: 9 }, c: { score: 9 } }),
    });
    const task = addTask(s.store);
    expect(await runTaskWithReview(task, s.deps)).toMatchObject({ status: 'verified', round: 2 });
    const of = (name: string, round: number) => s.requests.find((r) => r.kind === 'review' && member(r) === name && r.round === round)!;
    const stage = councilFor(s.config, 'news_scan')!;
    for (const m of stage.members) {
      expect(of(m.name, 2).systemPrompt, m.name).toBe(of(m.name, 1).systemPrompt);
      expect(of(m.name, 2).systemPrompt).not.toMatch(/Round 2|round 2/);
      // The round note comes before the list of earlier issues, in the review prompt only.
      expect(of(m.name, 1).prompt).not.toContain('## Review round');
      const p2 = of(m.name, 2).prompt;
      expect(p2).toContain(councilRoundNote(2, 2));
      expect(p2.indexOf('## Review round 2')).toBeLessThan(p2.indexOf('## Issues of earlier rounds'));
      expect(p2.indexOf('## Issues of earlier rounds')).toBeLessThan(p2.indexOf('## Evidence artifact ids'));
    }
    // One prompt version per member over both rounds, and three in all (one per lens).
    const versions = s.store.agentRuns.list({ taskId: task.id, role: 'reviewer' }).map((r) => [councilMemberOf(s.store, r.id)!.member, r.promptVersion]);
    expect(new Set(versions.map(([name, v]) => `${name}:${v}`)).size).toBe(3);
    expect(new Set(versions.map(([, v]) => v)).size).toBe(3);
  });

  it('at the round limit the task ends unverified, with the open issues on record', async () => {
    const s = researchSetup(opened, {
      config: council({ rounds: 2 }),
      pick: pick({ a: { score: 6, issues: [{ class: 'blocking', description: REVENUE, where: [OUTPUT] }] }, b: { score: 9 }, c: { score: 9 } }),
    });
    const task = addTask(s.store);
    // `loop.maxRounds` and its per-type override do not apply to a council stage.
    s.config.loop.perTaskType.news_scan = { maxRounds: 5, passThreshold: 1 };
    const out = await runTaskWithReview(task, s.deps);
    expect(out).toMatchObject({ status: 'unverified', round: 2 });
    expect(out.failureReason).toBeUndefined();
    expect(kinds(s.requests).filter((k) => !k.startsWith('review'))).toEqual(['work', 'revise']);
    expect(rounds(s.store, task).map((r) => [r.round, r.pass, r.issues.map((i) => i.id)])).toEqual([[1, false, ['I1']], [2, false, ['I1']]]);
    expect(reviewIssueHistory(s.store, task.id).map((t) => [t.issueId, t.rounds.map((r) => [r.round, r.status])])).toEqual([['I1', [[1, 'fixed'], [2, 'open']]]]);
  });

  it('a stage may seat some members and set its own rounds and pass score', async () => {
    const s = researchSetup(opened, {
      config: (c) => void (c.council = { ...structuredClone(COUNCIL), stages: { news_scan: { members: ['c', 'a'], passScore: 7, rounds: 1 } } }),
      pick: pick({ a: { score: 7 }, c: { score: 8 } }),
    });
    const task = addTask(s.store);
    expect(await runTaskWithReview(task, s.deps)).toMatchObject({ status: 'verified', round: 1 });
    expect(kinds(s.requests)).toEqual(['work', 'review:c', 'review:a']);
    expect(rounds(s.store, task)[0]).toMatchObject({ score: 7, pass: true, passScore: 7 });
  });
});

describe('a task type that is not a council stage', () => {
  /** Ids differ between two stores; everything else must not. */
  const normalize = (v: unknown): unknown => {
    const seen = new Map<string, string>();
    const text = JSON.stringify(v).replace(/\b[a-z]+_[0-9A-Z]{26}\b/g, (id) => {
      if (!seen.has(id)) seen.set(id, `${id.split('_')[0]}#${seen.size}`);
      return seen.get(id)!;
    });
    return JSON.parse(text.replace(/"(?:createdAt|startedAt|endedAt|capturedAt)":"[^"]+"/g, '"at":"T"'));
  };

  async function run(config?: (c: BifConfig) => void) {
    let reviews = 0;
    const s = researchSetup(opened, {
      ...(config ? { config } : {}),
      pick: (r) =>
        r.kind === 'work'
          ? submitWork()
          : r.kind === 'revise'
            ? revise('pushback')(r)
            : ++reviews === 1
              ? review(5, [{ class: 'substantive', description: 'thin evidence' }, { class: 'nit', description: 'typo' }])
              : reviews === 2
                ? async () => {}
                : review(9),
    });
    const task = addTask(s.store);
    const out = await runTaskWithReview(task, s.deps);
    return {
      status: [out.status, out.round, out.failureReason ?? null],
      requests: s.requests.map((r) => ({ ...r, task: undefined })),
      runs: s.store.agentRuns.list({ taskId: task.id }).map((r) => ({ role: r.role, model: r.model, status: r.status, round: r.round, promptVersion: r.promptVersion, member: councilMemberOf(s.store, r.id) ?? null })),
      decisions: s.store.decisions.list({ workspaceId: task.workspaceId }).map((d) => ({ role: d.role, model: d.model, kind: d.kind, payload: d.payload, refs: d.refs, promptVersion: d.promptVersion })),
      history: reviewIssueHistory(s.store, task.id).map((t) => t.rounds.map((r) => ({ ...r, id: undefined, resolvedAt: undefined }))),
      councilRounds: councilRounds(s.store, task.id),
    };
  }

  it('runs, prompts, Decisions, statuses and the issue history are what they are with no council block', async () => {
    const plain = await run();
    // A council exists, for another task type: `news_scan` keeps its single reviewer.
    const other = await run((c) => void (c.council = { ...structuredClone(COUNCIL), stages: { synthesize_recommendations: {} } }));
    expect(plain.status).toEqual(['verified', 3, null]);
    expect(plain.requests.map((r) => r.kind)).toEqual(['work', 'review', 'revise', 'review', 'revise', 'review']);
    expect(plain.councilRounds).toEqual([]);
    expect(plain.runs.every((r) => r.member === null)).toBe(true);
    expect(normalize(other)).toEqual(normalize(plain));
  });

  it('in one store, a council stage next to a single-reviewer task type: each is reviewed its own way', async () => {
    const s = researchSetup(opened, {
      config: council(),
      pick: (r) => (member(r) ? send({ score: 9 }) : r.kind === 'work' ? submitWork() : r.kind === 'review' ? review(8) : undefined),
    });
    const councilTask = addTask(s.store);
    const singleTask = addTask(s.store, { type: 'public_filings' });
    expect(await runTaskWithReview(singleTask, s.deps)).toMatchObject({ status: 'verified', round: 1 });
    expect(await runTaskWithReview(councilTask, s.deps)).toMatchObject({ status: 'verified', round: 1 });
    const reviewers = (t: Task) => s.store.agentRuns.list({ taskId: t.id, role: 'reviewer' });
    expect(reviewers(singleTask).map((r) => [r.model.provider, isCouncilMemberRun(s.store, r.id)])).toEqual([['codex', false]]);
    expect(reviewers(councilTask)).toHaveLength(3);
    expect(councilRounds(s.store, singleTask.id)).toEqual([]);
    expect(councilRounds(s.store, councilTask.id)).toHaveLength(1);
    const reviews = (t: Task) => s.store.decisions.list({ workspaceId: t.workspaceId, kind: 'review' }).filter((d) => d.refs.includes(t.id));
    expect(reviews(singleTask).map((d) => (d.payload as { tool: string }).tool)).toEqual(['submit_review']);
  });
});

describe('what cannot make a round fail (design §6, rules 3, 4 and 7)', () => {
  const passes = async (scripts: Scripts, over: Partial<Council> = {}) => {
    const s = researchSetup(opened, { config: council(over), pick: pick(scripts) });
    const task = addTask(s.store);
    const out = await runTaskWithReview(task, s.deps);
    return { out, round: rounds(s.store, task)[0]!, kinds: kinds(s.requests) };
  };

  it('a nit, however low the score that comes with it', async () => {
    const r = await passes({ a: { score: 2, issues: [{ class: 'nit', description: 'The title is long', where: [OUTPUT] }] }, b: { score: 9 }, c: { score: 9 } });
    expect(r.out).toMatchObject({ status: 'verified', round: 1 });
    expect(r.round).toMatchObject({ pass: true, score: 9, issues: [] });
    expect(r.round.members[0]).toMatchObject({ score: 2, countedScore: 9, unsupportedScore: true });
    expect(r.kinds).not.toContain('revise');
  });

  it('a scope issue: it becomes a follow-up', async () => {
    const r = await passes({ a: { score: 4, issues: [{ class: 'scope_expansion', description: 'Cover the Asian market too', evidence: [COPY] }] }, b: { score: 9 }, c: { score: 9 } });
    expect(r.out.status).toBe('verified');
    expect(r.round).toMatchObject({ pass: true, issues: [], dropped: [{ rule: 'scope' }], followUps: [{ text: 'Cover the Asian market too', raisedBy: ['a'] }] });
  });

  it('a score below the pass score with no blocking or substantive issue', async () => {
    const r = await passes({ a: { score: 0 }, b: { score: 9 }, c: { score: 9 } });
    expect(r.out.status).toBe('verified');
    expect(r.round.members[0]).toMatchObject({ score: 0, countedScore: 9, unsupportedScore: true });
  });

  it('an issue with neither an output nor evidence: it is a question', async () => {
    const r = await passes({ a: { score: 3, issues: [{ class: 'blocking', description: 'Something feels off about the numbers' }] }, b: { score: 9 }, c: { score: 9 } });
    expect(r.out.status).toBe('verified');
    expect(r.round).toMatchObject({ pass: true, issues: [], questions: [{ text: 'Something feels off about the numbers', raisedBy: ['a'] }] });
  });

  it('an issue that names only ids that are not outputs of the task and evidence outside its review slice: it is a question, and the ids are on the member\'s entry', async () => {
    const s = researchSetup(opened, { config: council(), pick: pick({}) });
    // An output and an evidence copy that exist, but belong to another task.
    const other = addTask(s.store);
    await s.deps.supervisor.run({ ctx: { workspaceId: other.workspaceId, role: 'worker', model: other.model, promptVersion: 'p', taskId: other.id }, prompt: 'p', systemPrompt: 's', needsBrowser: false, fake: submitWork({ summary: 'Globex cut prices' }, 'Globex cut prices') });
    const foreign = s.store.findings.list({ taskId: other.id })[0]!;
    s.state.pick = pick({
      a: { score: 3, issues: [{ class: 'blocking', description: REVENUE, where: ['fnd_made_up', foreign.id], evidence: ['art_made_up', foreign.evidence[0]!] }] },
      b: { score: 9 },
      c: { score: 9 },
    });
    const task = addTask(s.store);
    const out = await runTaskWithReview(task, s.deps);
    expect(out).toMatchObject({ status: 'verified', round: 1 });
    expect(kinds(s.requests)).not.toContain('revise');
    const [r] = rounds(s.store, task);
    expect(r).toMatchObject({ pass: true, score: 9, issues: [], advisory: [], questions: [{ text: REVENUE, raisedBy: ['a'] }] });
    expect(r!.members[0]).toMatchObject({
      score: 3, countedScore: 9, unsupportedScore: true,
      droppedIds: { where: ['fnd_made_up', foreign.id], evidence: ['art_made_up', foreign.evidence[0]!] },
    });
    expect(r!.members[1]).not.toHaveProperty('droppedIds');
    // What the member sent is kept as it was sent.
    const sent = s.store.decisions.list({ agentRunId: r!.members[0]!.runId! }).map((d) => d.payload as { issues: Array<{ where: string[] }> })[0]!;
    expect(sent.issues[0]!.where).toEqual(['fnd_made_up', foreign.id]);
  });

  it('an issue that names a real output or real evidence next to an unknown id keeps what is real, and still blocks', async () => {
    const s = researchSetup(opened, {
      config: council({ rounds: 1 }),
      pick: pick({
        a: { score: 3, issues: [{ class: 'blocking', description: REVENUE, where: ['fnd_made_up', OUTPUT] }, { class: 'substantive', description: STALE, evidence: [COPY, 'art_made_up'] }] },
        b: { score: 9 },
        c: { score: 9 },
      }),
    });
    const task = addTask(s.store);
    expect(await runTaskWithReview(task, s.deps)).toMatchObject({ status: 'unverified', round: 1 });
    const [r] = rounds(s.store, task);
    expect(r!.issues.map((i) => [i.description, i.where, i.evidence, i.standing])).toEqual([
      [REVENUE, [findingOf(s.store, task)], undefined, 'upheld'],
      [STALE, undefined, [copyOf(s.store, task)], 'upheld'],
    ]);
    expect(r!.members[0]).toMatchObject({ score: 3, countedScore: 3, droppedIds: { where: ['fnd_made_up'], evidence: ['art_made_up'] } });
  });

  it('an issue too few blocking members raised (`blockOn: all`), with its low score', async () => {
    const r = await passes({ a: { score: 5, issues: [{ class: 'substantive', description: REVENUE, where: [OUTPUT] }] }, b: { score: 9 }, c: { score: 9 } }, { blockOn: 'all' });
    expect(r.out.status).toBe('verified');
    expect(r.round).toMatchObject({ pass: true, issues: [], advisory: [{ description: REVENUE, standing: 'advisory', raisedBy: ['a'] }] });
  });
});

describe('unavailable members (design §7)', () => {
  const OFF = { name: 'x', provider: 'opencode', model: 'big-pickle', lens: 'privacy' } as const;

  it('fail: a blocking member this configuration cannot start ends the task unverified at once, with no member run and no revision', async () => {
    const s = researchSetup(opened, {
      config: council({ members: [...COUNCIL.members, OFF] }),
      pick: pick({ a: { score: 9 }, b: { score: 9 }, c: { score: 9 } }),
    });
    const task = addTask(s.store);
    const out = await runTaskWithReview(task, s.deps);
    expect(out).toMatchObject({ status: 'unverified', round: 1 });
    expect(out.failureReason).toBe("council member 'x' (opencode/big-pickle) is unavailable: provider 'opencode' is not enabled");
    expect(kinds(s.requests)).toEqual(['work']);
    expect(s.store.agentRuns.list({ taskId: task.id, role: 'reviewer' })).toEqual([]);
    const [r] = rounds(s.store, task);
    expect(r).toMatchObject({ round: 1, score: 0, pass: false, issues: [], failed: out.failureReason });
    expect(r!.members.map((m) => [m.name, m.state])).toEqual([['a', 'not_waited'], ['b', 'not_waited'], ['c', 'not_waited'], ['x', 'unavailable']]);
    expect(r!.members[3]!.reason).toBe("provider 'opencode' is not enabled");
    expect(r!.members[0]!.reason).toMatch(/^not started: 'x' cannot review/);
    expect(reviewIssueHistory(s.store, task.id)).toEqual([]);
    expect(s.store.findings.list({ taskId: task.id }).map((f) => f.status)).toEqual(['unverified']);
  });

  it('fail: a model that is not configured for its provider is named with its cause', async () => {
    const s = researchSetup(opened, {
      config: council({ members: [{ name: 'a', provider: 'claude', model: 'opus-9', lens: 'evidence' }] }),
      pick: pick({}),
    });
    const out = await runTaskWithReview(addTask(s.store), s.deps);
    expect(out.status).toBe('unverified');
    expect(out.failureReason).toBe("council member 'a' (claude/opus-9) is unavailable: model 'opus-9' is not in providers.claude.models");
  });

  it('fail: a member whose run gives no valid review ends the task after the round, the other reviews on record and nothing put to the worker', async () => {
    const s = researchSetup(opened, {
      config: council(),
      pick: pick({
        a: { score: 4, issues: [{ class: 'blocking', description: REVENUE, where: [OUTPUT] }] },
        b: fake(async () => {}), // ends without a review
        c: { score: 9 },
      }),
    });
    const task = addTask(s.store);
    const out = await runTaskWithReview(task, s.deps);
    expect(out).toMatchObject({ status: 'unverified', round: 1 });
    expect(out.failureReason).toBe("council member 'b' (codex/gpt-6.1-sol) gave no review: the run ended without a review");
    expect(kinds(s.requests)).toEqual(['work', 'review:a', 'review:b', 'review:c']);
    const [r] = rounds(s.store, task);
    expect(r).toMatchObject({ score: 0, pass: false, issues: [], failed: out.failureReason });
    // What the members that did review raised stays on record, as advice.
    expect(r!.advisory).toMatchObject([{ description: REVENUE, raisedBy: ['a'], standing: 'advisory' }]);
    expect(r!.members.map((m) => [m.name, m.state, m.score])).toEqual([['a', 'reviewed', 4], ['b', 'no_score', undefined], ['c', 'reviewed', 9]]);
    expect(reviewIssueHistory(s.store, task.id)).toEqual([]);
    // No other model took the member's place.
    expect(s.store.agentRuns.list({ taskId: task.id, role: 'reviewer' }).map((x) => x.model.model)).toEqual(['opus', 'gpt-6.1-sol', 'sonnet']);
  });

  it('fail: in the record of a failed round nothing is upheld, also not what a rewrite replaced', async () => {
    const s = researchSetup(opened, {
      config: council(),
      pick: pick({
        a: { score: 4, issues: [{ class: 'blocking', action: 'rewrite', description: 'Rebuild it from the annual report', where: [OUTPUT] }] },
        b: fake(async () => {}), // ends without a review
        c: { score: 6, issues: [{ class: 'substantive', description: REVENUE, where: [OUTPUT] }] },
      }),
    });
    const task = addTask(s.store);
    expect(await runTaskWithReview(task, s.deps)).toMatchObject({ status: 'unverified', round: 1 });
    const [r] = rounds(s.store, task);
    expect(r!.failed).toBeDefined();
    expect(r!.issues).toEqual([]);
    expect(r!.advisory.map((i) => [i.action, i.standing])).toEqual([['rewrite', 'advisory']]);
    expect(r!.dropped.map((d) => [d.issue.description, d.rule, d.standing])).toEqual([[REVENUE, 'rewrite', 'advisory']]);
  });

  it('a failed run and a `score: null` are no review either; the null score is recorded with the reason the member gave', async () => {
    const s = researchSetup(opened, {
      config: council(),
      pick: pick({
        a: fake(async () => { throw new Error('codex: command not found'); }),
        b: { score: null, summary: 'The evidence copies could not be opened' },
        c: { score: 9 },
      }),
    });
    const task = addTask(s.store);
    const out = await runTaskWithReview(task, s.deps);
    expect(out.status).toBe('unverified');
    expect(out.failureReason).toBe(
      "council member 'a' (claude/opus) gave no review: run failed (exit 1; codex: command not found); " +
        "council member 'b' (codex/gpt-6.1-sol) gave no review: the member could not score: The evidence copies could not be opened",
    );
    expect(rounds(s.store, task)[0]!.members.map((m) => [m.name, m.state])).toEqual([['a', 'no_score'], ['b', 'no_score'], ['c', 'reviewed']]);
  });

  it('report: the round goes on without the member, shown as unavailable', async () => {
    const s = researchSetup(opened, {
      config: council({ onUnavailable: 'report', members: [...COUNCIL.members, OFF] }),
      pick: pick({ a: { score: 9 }, b: fake(async () => {}), c: { score: 9.5 } }),
    });
    const task = addTask(s.store);
    const out = await runTaskWithReview(task, s.deps);
    expect(out).toMatchObject({ status: 'verified', round: 1 });
    expect(out.failureReason).toBeUndefined();
    const [r] = rounds(s.store, task);
    expect(r).toMatchObject({ pass: true, score: 9, onUnavailable: 'report' });
    expect(r).not.toHaveProperty('failed');
    expect(r!.members.map((m) => [m.name, m.state, m.reason])).toEqual([
      ['a', 'reviewed', undefined],
      ['b', 'no_score', 'the run ended without a review'],
      ['c', 'reviewed', undefined],
      ['x', 'unavailable', "provider 'opencode' is not enabled"],
    ]);
  });

  it('never another model: for a member whose provider is disabled no run is started, on that provider or on any other', async () => {
    for (const onUnavailable of ['report', 'fail'] as const) {
      const s = researchSetup(opened, {
        // Non-blocking under `fail`, so that the round runs under both settings.
        config: council({ onUnavailable, members: [...COUNCIL.members, { ...OFF, blocking: onUnavailable === 'report' }] }),
        pick: pick({ a: { score: 9 }, b: { score: 9 }, c: { score: 9 } }),
      });
      // Everything the supervisor is asked to run, whoever asks.
      const started: string[] = [];
      const run = s.supervisor.run.bind(s.supervisor);
      s.supervisor.run = (opts) => {
        started.push(`${opts.ctx.role}:${opts.ctx.model.provider}/${opts.ctx.model.model}`);
        return run(opts);
      };
      const task = addTask(s.store);
      expect(await runTaskWithReview(task, s.deps)).toMatchObject({ status: 'verified', round: 1 });
      // One run per member that can be started, each on its own model, and none in the place of `x`.
      expect(started).toEqual(['worker:claude/sonnet', 'reviewer:claude/opus', 'reviewer:codex/gpt-6.1-sol', 'reviewer:claude/sonnet']);
      const runs = s.store.agentRuns.list({ taskId: task.id, role: 'reviewer' });
      expect(runs.map((r) => [councilMemberOf(s.store, r.id)!.member, `${r.model.provider}/${r.model.model}`])).toEqual([['a', 'claude/opus'], ['b', 'codex/gpt-6.1-sol'], ['c', 'claude/sonnet']]);
      const row = rounds(s.store, task)[0]!.members[3]!;
      expect(row).toMatchObject({ name: 'x', provider: 'opencode', model: 'big-pickle', state: 'unavailable', reason: "provider 'opencode' is not enabled" });
      expect(row).not.toHaveProperty('runId');
      expect(row).not.toHaveProperty('score');
    }
  });

  it('report: with no blocking member left the round is treated as fail (none can be started: nobody runs)', async () => {
    const s = researchSetup(opened, {
      config: council({ onUnavailable: 'report', members: [OFF, { name: 'n', provider: 'claude', model: 'opus', lens: 'rewrite', blocking: false }] }),
      pick: pick({ n: { score: 10 } }),
    });
    const task = addTask(s.store);
    const out = await runTaskWithReview(task, s.deps);
    expect(out.status).toBe('unverified');
    expect(out.failureReason).toBe("no blocking council member reviewed: council member 'x' (opencode/big-pickle) is unavailable: provider 'opencode' is not enabled");
    expect(kinds(s.requests)).toEqual(['work']);
    expect(rounds(s.store, task)[0]!.members.map((m) => [m.name, m.state])).toEqual([['x', 'unavailable'], ['n', 'not_waited']]);
  });

  it('report: when every blocking member ends without a review, a non-blocking review does not make a round', async () => {
    const s = researchSetup(opened, {
      config: council({ onUnavailable: 'report', members: [COUNCIL.members[0]!, { name: 'n', provider: 'claude', model: 'sonnet', lens: 'rewrite', blocking: false }] }),
      pick: pick({ a: fake(async () => {}), n: { score: 10 } }),
    });
    const task = addTask(s.store);
    // The non-blocking member has ended before the blocking one does.
    const out = await runTaskWithReview(task, s.deps);
    expect(out.status).toBe('unverified');
    expect(out.failureReason).toBe("no blocking council member reviewed: council member 'a' (claude/opus) gave no review: the run ended without a review");
    expect(rounds(s.store, task)[0]).toMatchObject({ pass: false, score: 0, failed: out.failureReason });
  });

  it('a non-blocking member this configuration cannot start never ends a task: under fail and under report it is recorded as unavailable and the round runs with the others', async () => {
    const members = [...COUNCIL.members, { ...OFF, blocking: false }];
    for (const onUnavailable of ['fail', 'report'] as const) {
      const s = researchSetup(opened, { config: council({ members, onUnavailable }), pick: pick({ a: { score: 9 }, b: { score: 9 }, c: { score: 9 } }) });
      const task = addTask(s.store);
      const out = await runTaskWithReview(task, s.deps);
      expect(out).toMatchObject({ status: 'verified', round: 1 });
      expect(out.failureReason).toBeUndefined();
      expect(kinds(s.requests)).toEqual(['work', 'review:a', 'review:b', 'review:c']);
      const [r] = rounds(s.store, task);
      expect(r).toMatchObject({ pass: true, score: 9, onUnavailable });
      expect(r).not.toHaveProperty('failed');
      expect(r!.members.map((m) => [m.name, m.state])).toEqual([['a', 'reviewed'], ['b', 'reviewed'], ['c', 'reviewed'], ['x', 'unavailable']]);
      expect(r!.members[3]).toMatchObject({ blocking: false, reason: "provider 'opencode' is not enabled" });
    }
  });

  it('fail: only the blocking member that cannot be started is named as the cause; a non-blocking one beside it is recorded as unavailable', async () => {
    const s = researchSetup(opened, {
      config: council({ members: [...COUNCIL.members, OFF, { name: 'y', provider: 'opencode', model: 'big-pickle', lens: 'rewrite', blocking: false }] }),
      pick: pick({ a: { score: 9 }, b: { score: 9 }, c: { score: 9 } }),
    });
    const task = addTask(s.store);
    const out = await runTaskWithReview(task, s.deps);
    expect(out.status).toBe('unverified');
    expect(out.failureReason).toBe("council member 'x' (opencode/big-pickle) is unavailable: provider 'opencode' is not enabled");
    expect(kinds(s.requests)).toEqual(['work']);
    const [r] = rounds(s.store, task);
    expect(r!.members.map((m) => [m.name, m.state])).toEqual([['a', 'not_waited'], ['b', 'not_waited'], ['c', 'not_waited'], ['x', 'unavailable'], ['y', 'unavailable']]);
    expect(r!.members[0]!.reason).toBe("not started: 'x' cannot review, so the round could not count");
    expect(r!.members[4]!.reason).toBe("provider 'opencode' is not enabled");
  });

  it("fail: a non-blocking member's run that gives no review never ends the task: the round does not depend on it", async () => {
    const s = researchSetup(opened, {
      config: council({ members: [{ name: 'n', provider: 'claude', model: 'haiku', lens: 'rewrite', blocking: false }, ...COUNCIL.members] }),
      pick: pick({
        n: fake(async () => {}), // ends without a review, before the blocking members do
        a: fake(async (t) => {
          await tick(30);
          await send({ score: 9 })(t);
        }),
        b: { score: 9 },
        c: { score: 9 },
      }),
    });
    const task = addTask(s.store);
    expect(await runTaskWithReview(task, s.deps)).toMatchObject({ status: 'verified', round: 1 });
    const [r] = rounds(s.store, task);
    expect(r).not.toHaveProperty('failed');
    expect(r!.members[0]).toMatchObject({ name: 'n', state: 'no_score', reason: 'the run ended without a review' });
  });
});

describe('a run the supervisor refuses before it starts', () => {
  const N = { name: 'n', provider: 'claude', model: 'haiku', lens: 'rewrite', blocking: false } as const;
  const refuse = (s: ReturnType<typeof researchSetup>, model: string) => {
    const run = s.supervisor.run.bind(s.supervisor);
    s.supervisor.run = (opts) =>
      opts.ctx.role === 'reviewer' && opts.ctx.model.model === model ? Promise.reject(new Error('usd budget exceeded ($5.00); extension denied')) : run(opts);
  };

  it('for a blocking member: the task fails with that reason, as when the single reviewer is refused; no round is recorded', async () => {
    const s = researchSetup(opened, { config: council({ onUnavailable: 'report' }), pick: pick({ a: never(), b: { score: 9 }, c: { score: 9 } }) });
    refuse(s, 'gpt-6.1-sol');
    const task = addTask(s.store);
    const out = await runTaskWithReview(task, s.deps);
    expect(out).toMatchObject({ status: 'failed', round: 1, failureReason: 'usd budget exceeded ($5.00); extension denied' });
    expect(councilReviewDecisions(s.store, task)).toEqual([]);
    expect(s.store.agentRuns.list({ status: 'running' })).toEqual([]);
  });

  it('for a non-blocking member: it is recorded as unavailable and the round goes on', async () => {
    const s = researchSetup(opened, { config: council({ members: [...COUNCIL.members, N] }), pick: pick({ a: { score: 9 }, b: { score: 9 }, c: { score: 9 }, n: { score: 9 } }) });
    refuse(s, 'haiku');
    const task = addTask(s.store);
    expect(await runTaskWithReview(task, s.deps)).toMatchObject({ status: 'verified', round: 1 });
    expect(rounds(s.store, task)[0]!.members.at(-1)).toMatchObject({ name: 'n', state: 'unavailable', reason: 'could not be started: usd budget exceeded ($5.00); extension denied' });
  });
});

describe('a non-blocking member', () => {
  const N = { name: 'n', provider: 'claude', model: 'haiku', lens: 'rewrite', blocking: false } as const;

  it('never delays a round: still running when the blocking members have ended, it is cancelled and recorded as not waited for', async () => {
    const s = researchSetup(opened, {
      config: council({ members: [...COUNCIL.members, N] }),
      pick: pick({ a: { score: 9 }, b: { score: 9 }, c: { score: 9 }, n: never() }),
    });
    const task = addTask(s.store);
    const out = await runTaskWithReview(task, s.deps);
    expect(out).toMatchObject({ status: 'verified', round: 1 });
    const [r] = rounds(s.store, task);
    const row = r!.members.at(-1)!;
    expect(row).toMatchObject({ name: 'n', blocking: false, state: 'not_waited', reason: NOT_WAITED_REASON });
    expect(row).not.toHaveProperty('score');
    // Its run is closed, with the reason, and nothing of it is left running.
    const run = s.store.agentRuns.get(row.runId!)!;
    expect(run).toMatchObject({ status: 'failed', failureReason: NOT_WAITED_REASON });
    expect(run.endedAt).toBeDefined();
    expect(s.store.agentRuns.list({ status: 'running' })).toEqual([]);
  });

  it('never delays a round when worker slots are scarce: seated first with one slot, it starts after the blocking member and the round ends when that one ends', async () => {
    const started: string[] = [];
    const s = researchSetup(opened, {
      config: (c) => {
        council({ members: [N, COUNCIL.members[0]!] })(c);
        c.limits.maxParallelWorkers = 1;
      },
      pick: pick({
        // Slow, and it would review: if it held the only slot, the blocking member would wait for it.
        n: fake(async (t) => {
          started.push('n');
          await tick(300);
          await send({ score: 2 })(t);
        }),
        a: fake(async (t) => {
          started.push('a');
          await send({ score: 9 })(t);
        }),
      }),
    });
    const task = addTask(s.store);
    const out = await runTaskWithReview(task, s.deps);
    expect(out).toMatchObject({ status: 'verified', round: 1 });
    expect(started[0]).toBe('a');
    const [r] = rounds(s.store, task);
    expect(r!.members.map((m) => [m.name, m.state, m.score])).toEqual([['n', 'not_waited', undefined], ['a', 'reviewed', 9]]);
    expect(r!.members[0]!.reason).toBe(NOT_WAITED_REASON);
    expect(s.store.agentRuns.list({ status: 'running' })).toEqual([]);
    // The blocking member's run was not held up by the other one: it began before any run of `n` did.
    const runs = s.store.agentRuns.list({ taskId: task.id, role: 'reviewer' });
    expect(runs[0]!.model.model).toBe('opus');
  });

  it('is not started before every blocking member has its slot, however late one asks for it', async () => {
    const started: string[] = [];
    const s = researchSetup(opened, {
      config: (c) => {
        council({ members: [N, COUNCIL.members[0]!, COUNCIL.members[2]!] })(c);
        c.limits.maxParallelWorkers = 2;
      },
      pick: pick({
        n: fake(async (t) => {
          started.push('n');
          await tick(300);
          await send({ score: 2 })(t);
        }),
        a: fake(async (t) => {
          started.push('a');
          await send({ score: 9 })(t);
        }),
        c: fake(async (t) => {
          started.push('c');
          await send({ score: 9 })(t);
        }),
      }),
    });
    // Member c is slow to reach the worker slots (as a run that waits on its budget check is).
    const run = s.supervisor.run.bind(s.supervisor);
    s.supervisor.run = async (opts) => {
      if (opts.ctx.role === 'reviewer' && opts.ctx.model.model === 'sonnet') await tick(60);
      return run(opts);
    };
    const task = addTask(s.store);
    expect(await runTaskWithReview(task, s.deps)).toMatchObject({ status: 'verified', round: 1 });
    // Had `n` been started with the others, it would have taken the second slot while `c` was on its way.
    expect(started.slice(0, 2)).toEqual(['a', 'c']);
    expect(rounds(s.store, task)[0]!.members.map((m) => [m.name, m.state])).toEqual([['n', 'not_waited'], ['a', 'reviewed'], ['c', 'reviewed']]);
  });

  it('one whose run finished by itself while the round was cancelling it is recorded as what happened: a finished run and its review, not a cancelled one', async () => {
    const s = researchSetup(opened, {
      config: council({ members: [...COUNCIL.members, N] }),
      pick: pick({
        a: { score: 9 },
        b: { score: 9 },
        c: { score: 9 },
        n: fake(async (t) => {
          await tick(60); // still at work when the blocking members have ended
          await send(withTaskIds(s.store, task, { score: 3, issues: [{ class: 'substantive', description: STALE, where: [OUTPUT] }] }))(t);
        }),
      }),
    });
    const task = addTask(s.store);
    // The cancel comes too late for this run: it ends by itself (as a CLI that exits before the signal lands).
    const run = s.supervisor.run.bind(s.supervisor);
    s.supervisor.run = (opts) => (opts.ctx.model.model === 'haiku' ? run({ ...opts, signal: new AbortController().signal }) : run(opts));
    expect(await runTaskWithReview(task, s.deps)).toMatchObject({ status: 'verified', round: 1 });
    const [r] = rounds(s.store, task);
    const row = r!.members.at(-1)!;
    expect(row).toMatchObject({ name: 'n', blocking: false, state: 'reviewed', score: 3 });
    expect(row).not.toHaveProperty('reason');
    expect(row).not.toHaveProperty('countedScore');
    const memberRun = s.store.agentRuns.get(row.runId!)!;
    expect(memberRun.status).toBe('done');
    expect(memberRun.failureReason).toBeUndefined();
    // Its review is used as that of any non-blocking member: advice, and never the round's outcome.
    expect(r).toMatchObject({ pass: true, score: 9, issues: [], advisory: [{ description: STALE, raisedBy: ['n'], standing: 'advisory' }] });
  });

  it('never decides a round: its score is not counted and its issue is shown as advice', async () => {
    const s = researchSetup(opened, {
      config: council({ members: [N, ...COUNCIL.members] }),
      pick: pick({
        n: { score: 1, issues: [{ class: 'blocking', action: 'rewrite', description: 'Discard the finding and rebuild it from the filing', where: [OUTPUT] }] },
        a: fake(async (t) => {
          await tick(30); // the non-blocking member has ended by then
          await send({ score: 9 })(t);
        }),
        b: { score: 9 },
        c: { score: 9 },
      }),
    });
    const task = addTask(s.store);
    expect(await runTaskWithReview(task, s.deps)).toMatchObject({ status: 'verified', round: 1 });
    const [r] = rounds(s.store, task);
    expect(r).toMatchObject({ pass: true, score: 9, issues: [], advisory: [{ action: 'rewrite', raisedBy: ['n'], standing: 'advisory' }] });
    expect(r!.members[0]).toMatchObject({ name: 'n', state: 'reviewed', score: 1 });
    expect(r!.members[0]).not.toHaveProperty('countedScore');
  });
});

describe('what the worker is shown of a round (design §6 step 6)', () => {
  /** The sections of a prompt by their `## ` heading. */
  const sections = (prompt: string) => new Map(prompt.split(/^(?=## )/m).map((part) => [part.split('\n')[0]!, part] as const));

  it('an issue the council did not uphold is under the advice heading of the round-2 revise prompt, and not among the issues to answer', async () => {
    const s = researchSetup(opened, {
      config: council({ blockOn: 'majority' }),
      pick: pick({
        // Round 1: b and c uphold one issue; a alone raises another, which is advice under `majority`.
        a: (req: AgentRequest) => (req.round === 1 ? { score: 6, issues: [{ class: 'substantive', description: REVENUE, where: [OUTPUT] }] } : { score: 9 }),
        b: (req: AgentRequest) => (req.round === 1 ? { score: 6, issues: [{ class: 'substantive', description: STALE, evidence: [COPY] }] } : { score: 9 }),
        c: (req: AgentRequest) => (req.round === 1 ? { score: 6, issues: [{ class: 'substantive', description: STALE, evidence: [COPY] }] } : { score: 9 }),
      }),
    });
    const task = addTask(s.store);
    expect(await runTaskWithReview(task, s.deps)).toMatchObject({ status: 'verified', round: 2 });
    const [r1] = rounds(s.store, task);
    expect(r1!.issues.map((i) => [i.id, i.description])).toEqual([['I1', STALE]]);
    expect(r1!.advisory.map((i) => i.description)).toEqual([REVENUE]);
    const revision = s.requests.find((r) => r.kind === 'revise' && r.round === 2)!.prompt;
    const parts = sections(revision);
    const toAnswer = parts.get('## Review issues')!;
    const advice = parts.get('## Not blocking (answer if useful)')!;
    expect(toAnswer).toContain(`- [I1] (substantive) ${STALE}`);
    expect(toAnswer).not.toContain(REVENUE);
    expect(advice).toContain(`- (substantive) ${REVENUE} (about: ${findingOf(s.store, task)})`);
    expect(advice).toContain('Do not call `respond_to_review` for them.');
    expect(advice).not.toContain(STALE);
    // It is nowhere else in the prompt, and under no id the worker could answer.
    expect(revision.split(REVENUE)).toHaveLength(2);
    expect([...revision.matchAll(/^- \[(\w+)\]/gm)].map((m) => m[1])).toEqual(['I1']);
    expect(advice.indexOf('## Not blocking')).toBe(0);
    expect(revision.indexOf('## Review issues')).toBeLessThan(revision.indexOf('## Not blocking (answer if useful)'));
  });

  it("a merged issue reaches the worker and the history with every member's wording, and a later repeat of one wording is still a repeat (council review C6)", async () => {
    // Two different points about one output, alike enough to be taken as one defect.
    const FIGURE = 'The revenue figure in the finding is 12 million but the filing says 10';
    const YEAR = 'The revenue figure in the finding is for 2023 but the brief asks for 2024';
    const s = researchSetup(opened, {
      config: council(),
      pick: pick(
        {
          a: (req: AgentRequest) => (req.round === 1 ? { score: 6, issues: [{ class: 'substantive', description: FIGURE, where: [OUTPUT] }] } : { score: 9 }),
          // Round 2, after the worker's pushback: b lists the issue again in the very words it used before.
          b: (req: AgentRequest) => ({ score: 6, issues: [{ ...(req.round === 1 ? {} : { id: 'I1' }), class: 'substantive', description: YEAR, where: [OUTPUT] }] }),
          c: { score: 9 },
        },
        'pushback',
      ),
    });
    const task = addTask(s.store);
    const out = await runTaskWithReview(task, s.deps);
    const merged = `${FIGURE}\nAlso raised by b: ${YEAR}`;
    const [r1, r2] = rounds(s.store, task);
    expect(r1!.issues).toMatchObject([{ id: 'I1', description: merged, wordings: [FIGURE, YEAR], raisedBy: ['a', 'b'], standing: 'upheld' }]);
    // The worker reads both points, and the history keeps them.
    const revision = s.requests.find((r) => r.kind === 'revise')!.prompt;
    expect(revision).toContain(`- [I1] (substantive) ${merged} (about: ${findingOf(s.store, task)})`);
    expect(reviewIssueHistory(s.store, task.id)[0]!.rounds[0]).toMatchObject({ issueId: 'I1', text: merged });
    // The members of round 2 are shown the whole text; b's repeat of its own wording says nothing new.
    expect(s.requests.find((r) => r.kind === 'review' && r.round === 2)!.prompt).toContain(`- [I1] (substantive) ${merged}\n  Worker's reason: pushback because reasons`);
    expect(r2).toMatchObject({ pass: true, issues: [], advisory: [{ id: 'I1', description: YEAR, raisedBy: ['b'], standing: 'advisory' }] });
    expect(out).toMatchObject({ status: 'verified', round: 2 });
  });
});

describe('which review of the current deliverable a round is (council review C3)', () => {
  it('counts the valid reviews before the round: a council round that did not fail, never a failed one', async () => {
    const s = researchSetup(opened, {
      config: council(),
      pick: pick({ a: { score: 6, issues: [{ class: 'blocking', description: REVENUE, where: [OUTPUT] }] }, b: (req: AgentRequest) => (req.round === 1 ? { score: 9 } : fake(async () => {})), c: { score: 9 } }),
    });
    const task = addTask(s.store);
    // Round 1 is a valid review that does not pass; round 2 fails (b ends without a review).
    expect(await runTaskWithReview(task, s.deps)).toMatchObject({ status: 'unverified', round: 2 });
    expect(rounds(s.store, task).map((r) => [r.round, r.failed !== undefined])).toEqual([[1, false], [2, true]]);
    expect(reviewOfCurrentWork(s.store, task, 1)).toBe(1);
    expect(reviewOfCurrentWork(s.store, task, 2)).toBe(2);
    // The failed round 2 is no review: a round 3 would be the second review of the deliverable, not the third.
    expect(reviewOfCurrentWork(s.store, task, 3)).toBe(2);
  });

  it("counts a single reviewer's review with a score (the type had one reviewer then), and not a run that gave none", async () => {
    let reviews = 0;
    const s = researchSetup(opened, {
      // Round 1: a review with a score. Round 2: the reviewer run gives none (the loop's synthetic review).
      pick: (r) => (r.kind === 'work' ? submitWork() : r.kind === 'revise' ? revise('fix')(r) : ++reviews === 1 ? review(5, [{ class: 'substantive', description: 'thin evidence' }]) : async () => {}),
    });
    s.config.loop.maxRounds = 2;
    const task = addTask(s.store);
    expect(await runTaskWithReview(task, s.deps)).toMatchObject({ status: 'unverified', round: 2 });
    expect(reviewOfCurrentWork(s.store, task, 2)).toBe(2);
    expect(reviewOfCurrentWork(s.store, task, 3)).toBe(2);
  });
});

describe('the wordings of an issue the members were not shown (council review C6)', () => {
  it('advice with two wordings in one round is the earlier issue when a later round repeats one of them', async () => {
    const FIGURE = 'The revenue figure in the finding is 12 million but the filing says 10';
    const YEAR = 'The revenue figure in the finding is for 2023 but the brief asks for 2024';
    const s = researchSetup(opened, {
      config: council({ blockOn: 'all' }),
      pick: pick({
        // Round 1: everyone raises one issue (upheld under `all`); a and b word another one differently
        // about the same output, which c does not raise (advice). Round 2: everyone raises b's wording,
        // on evidence only, so only the words can make it the earlier issue.
        a: (req: AgentRequest) => ({ score: 6, issues: req.round === 1 ? [{ class: 'substantive', description: STALE, evidence: [COPY] }, { class: 'substantive', description: FIGURE, where: [OUTPUT] }] : [{ class: 'substantive', description: YEAR, evidence: [COPY] }] }),
        b: (req: AgentRequest) => ({ score: 6, issues: req.round === 1 ? [{ class: 'substantive', description: STALE, evidence: [COPY] }, { class: 'substantive', description: YEAR, where: [OUTPUT] }] : [{ class: 'substantive', description: YEAR, evidence: [COPY] }] }),
        c: (req: AgentRequest) => ({ score: 6, issues: [{ class: 'substantive', description: req.round === 1 ? STALE : YEAR, evidence: [COPY] }] }),
      }),
    });
    s.config.council!.rounds = 2;
    const task = addTask(s.store);
    await runTaskWithReview(task, s.deps);
    const [r1, r2] = rounds(s.store, task);
    expect(r1!.issues.map((i) => [i.id, i.description])).toEqual([['I1', STALE]]);
    expect(r1!.advisory).toMatchObject([{ id: 'I2', description: `${FIGURE}\nAlso raised by b: ${YEAR}`, wordings: [FIGURE, YEAR], raisedBy: ['a', 'b'] }]);
    // Not a new issue of a second review (that would be advice): the one raised in round 1, under its id.
    expect(r2!.issues.map((i) => [i.id, i.description, i.raisedBy, i.standing])).toEqual([['I2', YEAR, ['a', 'b', 'c'], 'upheld']]);
  });
});

describe('usage and cost (design §8: they stay per member run)', () => {
  it("each member run carries its own usage rows, under its own model; the round and its Decision carry none", async () => {
    const s = researchSetup(opened, { config: council(), pick: pick({ a: { score: 9 }, b: { score: 9 }, c: { score: 9 } }) });
    // A fake run reports no usage by itself: every run reports here what its CLI would (one `usage` event),
    // recorded the way the supervisor records it.
    const tokens: Record<string, number> = { 'claude/opus': 1000, 'codex/gpt-6.1-sol': 2000, 'claude/sonnet': 300 };
    const run = s.supervisor.run.bind(s.supervisor);
    s.supervisor.run = (opts) =>
      run({
        ...opts,
        beforeStart: (ctx) => {
          opts.beforeStart?.(ctx);
          recordUsage(s.store, ctx, 1, { t: 'usage', inputTokens: tokens[`${ctx.model.provider}/${ctx.model.model}`]!, outputTokens: 10 });
        },
      });
    const task = addTask(s.store);
    expect(await runTaskWithReview(task, s.deps)).toMatchObject({ status: 'verified', round: 1 });
    const [decision] = councilReviewDecisions(s.store, task);
    const round = councilReviewOf(decision)!;
    const memberRuns = round.members.map((m) => m.runId!);
    expect(memberRuns).toHaveLength(3);
    const worker = s.store.agentRuns.list({ taskId: task.id, role: 'worker' })[0]!;
    const usage = usageByRun(s.store, [task.workspaceId]);
    // One usage entry per run that ran: the worker and the three members, each member under its own model.
    expect(new Set(usage.map((u) => u.runId))).toEqual(new Set([worker.id, ...memberRuns]));
    expect(memberRuns.map((id) => usage.find((u) => u.runId === id)!).map((u) => [u.role, `${u.provider}/${u.model}`, u.inputTokens])).toEqual([
      ['reviewer', 'claude/opus', 1000],
      ['reviewer', 'codex/gpt-6.1-sol', 2000],
      ['reviewer', 'claude/sonnet', 300],
    ]);
    // The round is no run: nothing is counted on its id, and the task's total is the sum of its four runs.
    expect(s.store.agentRuns.get(decision!.agentRunId)).toBeUndefined();
    expect(s.store.db.prepare('SELECT COUNT(*) AS n FROM agent_usage WHERE run_id = ?').get(decision!.agentRunId)).toEqual({ n: 0 });
    expect(memberRuns).not.toContain(decision!.agentRunId);
    expect(usageTotals(s.store, { taskId: task.id })).toMatchObject({ runs: 4, inputTokens: 3600, outputTokens: 40 });
    expect(JSON.stringify(decision!.payload)).not.toMatch(/inputTokens|outputTokens|costUsd/);
  });
});

describe('abort and restart', () => {
  it('aborting in the middle of a round stops every member and leaves the task as it is, with no round recorded', async () => {
    const ac = new AbortController();
    const s = researchSetup(opened, {
      config: council(),
      pick: pick({ a: { score: 3, issues: [{ class: 'blocking', description: REVENUE, where: [OUTPUT] }] }, b: never(), c: never() }),
    });
    const task = addTask(s.store);
    const running = runTaskWithReview(task, { ...s.deps, signal: ac.signal });
    const settled = running.then(() => 'done', (e: unknown) => e);
    // Wait until member a has submitted and the others are running.
    for (let i = 0; i < 200 && s.store.decisions.list({ kind: 'review' }).length < 1; i++) await tick(5);
    await tick(20);
    ac.abort();
    const err = await settled;
    expect(err).toBeInstanceOf(AbortError);
    expect(s.store.tasks.get(task.id)).toMatchObject({ status: 'reviewing', step: 'review', round: 1 });
    expect(councilReviewDecisions(s.store, task)).toEqual([]);
    expect(reviewIssueHistory(s.store, task.id)).toEqual([]);
    expect(s.store.agentRuns.list({ status: 'running' })).toEqual([]);

    // Restart: the round is run again, as a new round. What the first attempt's members sent counts for nothing.
    s.state.pick = pick({ a: { score: 9 }, b: { score: 9 }, c: { score: 9 } });
    const out = await runTaskWithReview(s.store.tasks.get(task.id)!, s.deps);
    expect(out).toMatchObject({ status: 'verified', round: 1 });
    const all = rounds(s.store, task);
    expect(all.map((r) => [r.round, r.score, r.pass, r.issues.length])).toEqual([[1, 9, true, 0]]);
    const memberRuns = s.store.agentRuns.list({ taskId: task.id, role: 'reviewer' });
    expect(memberRuns).toHaveLength(6);
    const counted = new Set(all[0]!.members.map((m) => m.runId));
    expect(memberRuns.slice(0, 3).some((r) => counted.has(r.id))).toBe(false);
    expect(memberRuns.slice(3).every((r) => counted.has(r.id))).toBe(true);
    expect(new Set(memberRuns.map((r) => councilMemberOf(s.store, r.id)!.roundId)).size).toBe(2);
    expect(reviewIssueHistory(s.store, task.id)).toEqual([]);
  });

  it('a round recorded twice (a restart after the record, before the next step) counts once: the later record', async () => {
    const s = researchSetup(opened, { config: council(), pick: pick({ a: { score: 9 }, b: { score: 9 }, c: { score: 9 } }) });
    const task = addTask(s.store);
    await s.deps.supervisor.run({ ctx: { workspaceId: task.workspaceId, role: 'worker', model: task.model, promptVersion: 'p', taskId: task.id }, prompt: 'p', systemPrompt: 's', needsBrowser: false, fake: submitWork() });
    const stage = councilFor(s.config, 'news_scan') as CouncilStage;
    s.state.pick = pick({ a: { score: 5, issues: [{ class: 'blocking', description: REVENUE, where: [OUTPUT] }] }, b: { score: 9 }, c: { score: 9 } });
    const first = await councilStep(s.deps, task.id, 1, stage);
    expect(first).toMatchObject({ valid: true, pass: false, score: 5, issues: [{ id: 'I1', class: 'blocking', description: REVENUE }] });
    s.state.pick = pick({ a: { score: 6, issues: [{ class: 'blocking', description: STALE, where: [OUTPUT] }] }, b: { score: 9 }, c: { score: 9 } });
    const second = await councilStep(s.deps, task.id, 1, stage);
    expect(second).toMatchObject({ pass: false, score: 6, issues: [{ id: 'I1', description: STALE }] });
    expect(councilReviewDecisions(s.store, task)).toHaveLength(2);
    expect(councilRounds(s.store, task.id).map((r) => [r.round, r.result.score, r.result.issues.map((i) => i.description)])).toEqual([[1, 6, [STALE]]]);
  });
});

describe('issues across rounds', () => {
  it('ids stay stable: an issue repeated under its id keeps it, and the harness gives a new issue no id of an earlier round', async () => {
    const s = researchSetup(opened, {
      config: council(),
      pick: pick({
        a: (req: AgentRequest) =>
          req.round === 1
            ? { score: 6, issues: [{ class: 'substantive', description: REVENUE, where: [OUTPUT] }] }
            : req.round === 2
              ? {
                  score: 6,
                  issues: [
                    // A new issue, sent without an id: numbered by the harness.
                    { class: 'substantive', description: STALE, evidence: [COPY] },
                    // The earlier one, in other words, under the id the member was shown.
                    { id: 'I1', class: 'substantive', description: 'Still there: the corrected finding repeats the 12 million', evidence: [COPY] },
                  ],
                }
              : { score: 9 },
        b: { score: 9 },
        c: { score: 9 },
      }),
    });
    const task = addTask(s.store);
    const out = await runTaskWithReview(task, s.deps);
    expect(out).toMatchObject({ status: 'verified', round: 3 });
    const [r1, r2] = rounds(s.store, task);
    expect(r1!.issues.map((i) => [i.id, i.description])).toEqual([['I1', REVENUE]]);
    // The member's raw ids: the new issue was numbered I2, not I1.
    const sent = s.store.decisions.list({ kind: 'review' }).map((d) => d.payload as { tool: string; issues: Array<{ id: string }> });
    expect(sent.filter((p) => p.tool === 'submit_review' && p.issues.length === 2)[0]!.issues.map((i) => i.id)).toEqual(['I2', 'I1']);
    // Round 2: the repeated issue is upheld under its id; the new substantive one is advice (step 3.5).
    expect(r2!.issues.map((i) => [i.id, i.standing])).toEqual([['I1', 'upheld']]);
    expect(r2!.advisory.map((i) => [i.id, i.description, i.standing])).toEqual([['I2', STALE, 'advisory']]);
    expect(reviewIssueHistory(s.store, task.id).map((t) => [t.issueId, t.rounds.map((r) => [r.round, r.status])])).toEqual([['I1', [[1, 'fixed'], [2, 'fixed']]]]);

    // From round 2 members are shown the issues of earlier rounds with the worker's answer.
    const prompts = (round: number) => s.requests.filter((r) => r.kind === 'review' && r.round === round).map((r) => r.prompt);
    for (const p of prompts(1)) expect(p).not.toContain('## Issues of earlier rounds');
    for (const p of prompts(2)) {
      expect(p).toContain('## Issues of earlier rounds');
      expect(p).toContain(`- [I1] (substantive) ${REVENUE}\n  Worker's answer: fixed`);
      expect(p).toMatch(/list it again with the same `id` and say what in\nthe current deliverable shows it/);
      expect(p).not.toContain("Worker's answer: fixed:"); // the worker's own account of its fix is not shown
    }
    // The advisory issue of round 2 was not put to the worker, so round 3 does not list it.
    for (const p of prompts(3)) expect(p).not.toContain(STALE);
    // The worker was shown it as advice in the revision after round 2.
    const revisions = s.requests.filter((r) => r.kind === 'revise').map((r) => r.prompt);
    expect(revisions[1]).toContain('## Not blocking (answer if useful)');
    expect(revisions[1]).toContain(`- (substantive) ${STALE} (evidence: ${copyOf(s.store, task)})`);
    expect(revisions[1]).toMatch(/^- \[I1\] \(substantive\) Still there/m);
    expect([...revisions[1]!.matchAll(/^- \[(\w+)\]/gm)].map((m) => m[1])).toEqual(['I1']);
  });

  it('an issue that was only advice in one round was raised in an earlier round: raised again, it is upheld under the same id', async () => {
    const s = researchSetup(opened, {
      config: council({ rounds: 4 }),
      pick: pick({
        a: (req: AgentRequest) =>
          req.round === 1
            ? { score: 6, issues: [{ class: 'substantive', description: REVENUE, where: [OUTPUT] }] }
            : req.round <= 3
              ? { score: 6, issues: [{ class: 'substantive', description: STALE, evidence: [COPY] }] }
              : { score: 9 },
        b: { score: 9 },
        c: { score: 9 },
      }),
    });
    const task = addTask(s.store);
    const out = await runTaskWithReview(task, s.deps);
    // Round 2: new, so advice (and the low score with it is unsupported): the round passes.
    expect(out).toMatchObject({ status: 'verified', round: 2 });
    expect(rounds(s.store, task)[1]).toMatchObject({ pass: true, issues: [], advisory: [{ id: 'I2', description: STALE }] });
    // Had the task gone on, round 3 would have found the issue among those of earlier rounds.
    s.store.tasks.update(task.id, { status: 'queued', step: 'review', round: 3 });
    const again = await runTaskWithReview(s.store.tasks.get(task.id)!, s.deps);
    expect(again).toMatchObject({ status: 'verified', round: 4 });
    expect(rounds(s.store, task)[2]).toMatchObject({ round: 3, pass: false, issues: [{ id: 'I2', description: STALE, standing: 'upheld' }], advisory: [] });
  });

  it('a dispute: the worker pushes back, a member raises the issue again in the same words, and the issue no longer blocks', async () => {
    const s = researchSetup(opened, {
      config: council(),
      pick: pick(
        {
          a: (req: AgentRequest) =>
            req.round === 1
              ? { score: 6, issues: [{ class: 'substantive', description: REVENUE, where: [OUTPUT] }] }
              : { score: 6, issues: [{ id: 'I1', class: 'substantive', description: REVENUE, where: [OUTPUT], evidence: [COPY] }] },
          b: { score: 9 },
          c: { score: 9 },
        },
        'pushback',
      ),
    });
    const task = addTask(s.store);
    const out = await runTaskWithReview(task, s.deps);
    expect(out).toMatchObject({ status: 'verified', round: 2 });
    const [, r2] = rounds(s.store, task);
    expect(r2).toMatchObject({ pass: true, score: 9, issues: [], advisory: [{ id: 'I1', standing: 'advisory', raisedBy: ['a'] }] });
    expect(r2!.members[0]).toMatchObject({ score: 6, countedScore: 9, unsupportedScore: true });
    // Members of round 2 were put the dispute as a single reviewer is, and the earlier issue with the worker's answer.
    const p2 = s.requests.find((r) => r.kind === 'review' && r.round === 2)!.prompt;
    expect(p2).toContain('## Disputed issues from the previous review');
    expect(p2).toContain(`- [I1] (substantive) ${REVENUE}\n  Worker's reason: pushback because reasons`);
    expect(p2).toContain(`- [I1] (substantive) ${REVENUE}\n  Worker's answer: pushed back: pushback because reasons`);
    // The council did not uphold it: the dispute is settled for the worker.
    expect(reviewIssueHistory(s.store, task.id).map((t) => [t.issueId, t.status])).toEqual([['I1', 'withdrawn']]);
    const [d1] = councilReviewDecisions(s.store, task);
    expect(listOutcomes(s.store, { taskId: task.id, source: 'dispute' }).map((o) => [o.outcome, o.label, o.decisionId, o.role])).toEqual([
      ['withdrawn_after_pushback', 'reviewer-false-positive', d1!.id, 'reviewer'],
    ]);
  });

  it('a dispute reasserted with something new to say (here about the output, with no evidence cited) is upheld under its id; the reassert cap then closes it as for a single reviewer', async () => {
    const s = researchSetup(opened, {
      config: council(),
      pick: pick(
        {
          a: (req: AgentRequest) =>
            req.round === 1
              ? { score: 6, issues: [{ class: 'substantive', description: REVENUE, where: [OUTPUT] }] }
              : { score: 6, issues: [{ id: 'I1', class: 'substantive', description: 'The reason does not hold: page 3 of the filing says 10', where: [OUTPUT] }] },
          b: { score: 9 },
          c: { score: 9 },
        },
        'pushback',
      ),
    });
    const task = addTask(s.store);
    const out = await runTaskWithReview(task, s.deps);
    expect(out).toMatchObject({ status: 'unverified', round: 3 });
    expect(rounds(s.store, task).map((r) => r.issues.map((i) => [i.id, i.standing]))).toEqual([[['I1', 'upheld']], [['I1', 'upheld']], [['I1', 'upheld']]]);
    expect(reviewIssueHistory(s.store, task.id).map((t) => [t.issueId, t.rounds.map((r) => [r.round, r.status])])).toEqual([
      // Round 3 raised it again after the second pushback: that row is upheld too, as a single reviewer's repeat is.
      ['I1', [[1, 'upheld'], [2, 'upheld'], [3, 'open']]],
    ]);
    // After one reassert (`loop.maxReasserts` 1) the worker is told to fix it, and round 3 is not put the dispute again.
    const revisions = s.requests.filter((r) => r.kind === 'revise').map((r) => r.prompt);
    expect(revisions[0]).not.toContain('## Reasserted issues');
    expect(revisions[1]).toContain('## Reasserted issues\n- I1: the reviewer reasserted this issue after your pushback (1×; limit reached)');
    const p3 = s.requests.find((r) => r.kind === 'review' && r.round === 3)!.prompt;
    expect(p3).not.toContain('## Disputed issues from the previous review');
    expect(p3).toContain("Worker's answer: pushed back: pushback because reasons");
  });

  it('a pushed-back issue that is reasserted and then replaced by an upheld rewrite was upheld, not withdrawn', async () => {
    const s = researchSetup(opened, {
      config: council({ rounds: 2 }),
      pick: pick(
        {
          a: (req: AgentRequest) =>
            req.round === 1
              ? { score: 6, issues: [{ class: 'substantive', description: REVENUE, where: [OUTPUT] }] }
              : { score: 6, issues: [{ id: 'I1', class: 'substantive', description: 'The reason does not hold: page 3 says 10', where: [OUTPUT], evidence: [COPY] }] },
          b: (req: AgentRequest) => (req.round === 1 ? { score: 9 } : { score: 5, issues: [{ class: 'blocking', action: 'rewrite', description: 'Rebuild it from the annual report', where: [OUTPUT] }] }),
          c: { score: 9 },
        },
        'pushback',
      ),
    });
    const task = addTask(s.store);
    await runTaskWithReview(task, s.deps);
    const [, r2] = rounds(s.store, task);
    expect(r2!.issues.map((i) => [i.id, i.action])).toEqual([['I2', 'rewrite']]);
    expect(r2!.dropped).toMatchObject([{ issue: { id: 'I1' }, rule: 'rewrite', replacedBy: 'I2', standing: 'upheld' }]);
    expect(reviewIssueHistory(s.store, task.id).map((t) => [t.issueId, t.rounds.map((r) => [r.round, r.status])])).toEqual([['I1', [[1, 'upheld']]], ['I2', [[2, 'open']]]]);
    expect(listOutcomes(s.store, { taskId: task.id, label: 'reviewer-false-positive' })).toEqual([]);
  });

  it('a pushed-back issue the council did not uphold again is withdrawn, also when an upheld rewrite covers its output (council review C4)', async () => {
    const s = researchSetup(opened, {
      config: council({ rounds: 2 }),
      pick: pick(
        {
          a: (req: AgentRequest) =>
            req.round === 1
              ? { score: 6, issues: [{ class: 'substantive', description: REVENUE, where: [OUTPUT] }] }
              : // Raised again in the earlier words: it says nothing new, so the council does not uphold it.
                { score: 6, issues: [{ id: 'I1', class: 'substantive', description: REVENUE, where: [OUTPUT], evidence: [COPY] }] },
          b: (req: AgentRequest) => (req.round === 1 ? { score: 9 } : { score: 5, issues: [{ class: 'blocking', action: 'rewrite', description: 'Rebuild it from the annual report', where: [OUTPUT] }] }),
          c: { score: 9 },
        },
        'pushback',
      ),
    });
    const task = addTask(s.store);
    await runTaskWithReview(task, s.deps);
    const [, r2] = rounds(s.store, task);
    expect(r2!.issues.map((i) => [i.id, i.action])).toEqual([['I2', 'rewrite']]);
    expect(r2!.dropped).toMatchObject([{ issue: { id: 'I1' }, raisedBy: ['a'], rule: 'rewrite', replacedBy: 'I2', standing: 'advisory' }]);
    // The rewrite is what the worker answers. The dispute is settled as for any reassert that does not block.
    expect(reviewIssueHistory(s.store, task.id).map((t) => [t.issueId, t.rounds.map((r) => [r.round, r.status])])).toEqual([['I1', [[1, 'withdrawn']]], ['I2', [[2, 'open']]]]);
    const [d1] = councilReviewDecisions(s.store, task);
    expect(listOutcomes(s.store, { taskId: task.id, label: 'reviewer-false-positive' }).map((o) => [o.outcome, o.decisionId])).toEqual([['withdrawn_after_pushback', d1!.id]]);
  });

  it('an upheld rewrite is shown to the worker first, with the outputs to discard; what it replaced is on record', async () => {
    const s = researchSetup(opened, {
      config: council({ rounds: 1 }),
      pick: pick({}),
    });
    const task = addTask(s.store);
    s.config.council!.rounds = 2;
    let finding = '';
    let second = '';
    s.state.pick = (req) => {
      // The work saves two findings: the rewrite discards the first, the deletion is about the second.
      if (req.kind === 'work') {
        return async (t) => {
          const a = (await t.call('save_artifact', { kind: 'text', mime: 'text/plain', content: 'the annual report' })) as { artifactId: string };
          await t.call('save_finding', { claim: 'Acme raised prices', subject: 'Acme', evidence: [a.artifactId] });
          await t.call('save_finding', { claim: 'Acme has a pricing page', subject: 'Acme', evidence: [a.artifactId] });
          await t.call('submit_result', { summary: 'Acme raised prices', evidence: [a.artifactId] });
        };
      }
      if (req.kind === 'revise') return revise('fix')(req);
      [finding, second] = s.store.findings.list({ taskId: task.id }).map((f) => f.id) as [string, string];
      const name = member(req)!;
      if (req.round === 2) return send({ score: 9 });
      if (name === 'a') return send({ score: 5, issues: [{ class: 'substantive', description: REVENUE, where: [finding] }, { class: 'substantive', action: 'delete', description: 'It restates its source', where: [second] }] });
      if (name === 'b') return send({ score: 4, issues: [{ class: 'blocking', action: 'rewrite', description: 'Rebuild it from the annual report', where: [finding] }] });
      return send({ score: 9 });
    };
    const out = await runTaskWithReview(task, s.deps);
    expect(out).toMatchObject({ status: 'verified', round: 2 });
    const [r1] = rounds(s.store, task);
    expect(r1!.issues.map((i) => [i.id, i.action ?? 'fix'])).toEqual([['I1', 'delete'], ['I2', 'rewrite']]);
    expect(r1!.dropped).toMatchObject([{ issue: { id: 'I3', description: REVENUE }, raisedBy: ['a'], rule: 'rewrite', replacedBy: 'I2' }]);
    const revision = s.requests.find((r) => r.kind === 'revise')!.prompt;
    const lines = revision.split('\n').filter((l) => /^- \[I\d\]/.test(l));
    expect(lines).toEqual([
      `- [I2] (blocking) Rewrite: discard ${finding} (neither re-save nor cite them) and redo them as proposed here, for the same brief and nothing more. Rebuild it from the annual report`,
      `- [I1] (substantive) Delete ${second} (neither re-save nor cite them): It restates its source`,
    ]);
    expect(revision).not.toContain(REVENUE); // replaced by the rewrite
  });
});

describe('an experiment arm task in a council stage', () => {
  it("the round's Decision carries the arm's tags, like every Decision of the arm's runs", async () => {
    const s = researchSetup(opened, { config: council(), pick: pick({ a: { score: 9 }, b: { score: 9 }, c: { score: 9 } }) });
    const task = addTask(s.store);
    s.store.db.prepare("UPDATE tasks SET experiment_id = 'exp_1', arm = 'B' WHERE id = ?").run(task.id);
    await runTaskWithReview(task, s.deps);
    const d = councilReviewDecisions(s.store, task)[0]!;
    expect(decisionTags(s.store, d.id)).toEqual({ experimentId: 'exp_1', arm: 'B' });
  });
});
