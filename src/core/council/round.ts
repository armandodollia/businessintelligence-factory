import { AbortError } from '../events.js';
import type { RunOutcome } from '../harness/supervisor.js';
import { rerunRedidWork, taskReruns } from '../escalation/context.js';
import { getRunOutputs, validScore, type ReviewIssue } from '../harness/tools/handlers.js';
import { earlierRoundIssues, maxReasserts, openDisputes, recordReviewRound } from '../learning/reviewIssues.js';
import { isAuditRun, taskExperiment } from '../learning/runTags.js';
import { promptVersion } from '../prompts/index.js';
import { recordRunPrompt } from '../prompts/store.js';
import { recordHarnessDecision, runAgent, throwIfAborted, type ResearchDeps } from '../research/deps.js';
import { failureReason, reviewSlice, reviewerRunInput, taskOutputIds } from '../research/reviewLoop.js';
import type { Store } from '../store/db.js';
import type { ReviewIssueRecord } from '../learning/types.js';
import type { Task } from '../types.js';
import { councilRoundNote, councilSection } from './lenses.js';
import { mergeCouncil, type CouncilIssueIn, type CouncilResult, type MemberReview, type MergeInput } from './merge.js';
import { memberUnavailable, type CouncilMember, type CouncilStage } from './settings.js';
import { COUNCIL_REVIEW_EVENT, councilReviewOf, councilRounds, isCouncilMemberRun, newCouncilRoundId, upheldIssues, type CouncilReviewPayload } from './store.js';

/**
 * One council round (design 2026-11-16-review-council-design.md §5–§8): the harness is the orchestrator.
 * It seats the members that can be started, runs them in parallel, merges what they send by the fixed
 * rules of `merge.ts` and records the round as one review (`store.ts`).
 *
 * What this file settles:
 * - A member is a reviewer run with exactly what today's reviewer is started with (`reviewerRunInput`:
 *   same system prompt, review prompt, prompt reads; same tools and review slice by its role), plus the
 *   council section at the end of its system prompt (the same in every round: one prompt version per
 *   lens and pass score) and, from round 2, the round note and the list of the issues of earlier rounds
 *   in its review prompt. Its model is the member's own: `reviewerFor` is not used, and no other model
 *   ever takes a member's place.
 * - Blocking members are started first; a non-blocking member is started only once every blocking member
 *   has started (it has its worker slot) or ended, so it never takes a slot a blocking member waits for.
 *   The round ends when every blocking member has ended. A non-blocking member still running then, or
 *   not started yet, is cancelled through its own abort signal (chained to `deps.signal`) and recorded
 *   as "not waited for". One whose run finished by itself before the cancel took effect is recorded as
 *   what happened: a finished run, with its review.
 * - Unavailable members (§7). `onUnavailable` is about blocking members only. Under `fail`, a blocking
 *   member this configuration cannot start (provider disabled, model not configured: what the start-up
 *   warning names) ends the task before any member runs, and a blocking member whose run gives no valid
 *   review ends it once the round's blocking members have ended (the other reviews stay on record).
 *   Under `report` the round goes on without them. A round in which no blocking member reviewed has
 *   failed whatever the setting.
 * - A non-blocking member never ends a task and never decides a round (ruling of 2026-11-16). One this
 *   configuration cannot start is recorded as `unavailable` with its reason and the round runs with the
 *   others, under both settings. The round does not wait for its run, so whether that run gives a
 *   review, fails first or is cancelled cannot be what the task's end depends on: it is recorded
 *   (`no_score`, `not_waited`) and the round goes on.
 * - Which review of the deliverable a round is (council review of 2026-11-16, C3) is counted, not read
 *   off the loop's round number: `reviewOfCurrentWork`. The rule on late issues (§6 step 3.5) and the note
 *   that tells members of it apply from the second valid review since the worker last did the `work`
 *   step. A re-run after an escalation can do the work again in a later round (after a failed council
 *   round, or a task that failed before any review): its first review is then a first review.
 * - "Evidence or nothing" (ruling of 2026-11-16) is checked here, before the merge (`withKnownIds`): an
 *   issue counts for the outputs of this task it names and the evidence of the task's review slice it
 *   cites, and for no other id.
 * - A failed round is recorded and returns `failed`: the task ends `unverified` with that reason and no
 *   revision. Nothing of a partial council is put to the worker.
 * - A run the supervisor refuses before it starts (a denied budget extension, a configuration error) is
 *   not an unavailable member: it would be refused for any reviewer. For a blocking member the error is
 *   thrown once the round's runs have stopped, and the task fails as it does when the single reviewer's
 *   run is refused. A non-blocking member that is refused is recorded as unavailable.
 */

/** The run's failure reason of a non-blocking member cancelled at the end of its round. */
export const NOT_WAITED_REASON = 'cancelled: every blocking member of the council round had ended (a non-blocking member is not waited for)';

export type CouncilStepResult = {
  /** A review the worker can answer was made (false for a failed round). */
  valid: boolean;
  /** The round's score: the lowest counted score; 0 for a failed round. */
  score: number;
  /** The upheld issues, under stable ids: what the worker must answer. */
  issues: ReviewIssue[];
  pass: boolean;
  /** Why the task must end `unverified` now. */
  failed?: string;
};

const modelOf = (m: CouncilMember) => `${m.provider}/${m.model}`;

/** An issue the review dropped after the worker's pushback is settled: members are not asked about it again. */
const listedForMembers = (r: Pick<ReviewIssueRecord, 'status'>): boolean => r.status !== 'withdrawn';

/**
 * Which review of the task's current deliverable the review of loop round `round` is (the merge's `round`):
 * 1 + the valid reviews it has had since the worker last did the `work` step. That step is done in round 1,
 * and again in the round a re-run after an escalation starts the work anew (`rerunRedidWork`); reviews of
 * what the worker then replaced are not reviews of the current deliverable. A valid review is a council
 * round that did not fail (a failed round is "no review took place", design §7) or a single reviewer's
 * review with a score (the task type may have had one reviewer in an earlier round); of a round reviewed
 * more than once, the latest record counts, and the round counts once.
 */
export function reviewOfCurrentWork(store: Store, task: Pick<Task, 'id' | 'workspaceId'>, round: number): number {
  let from = 1;
  for (const rerun of taskReruns(store, task)) if (rerunRedidWork(rerun)) from = rerun.previousRound + 1;
  const reviewed = new Set<number>();
  for (const c of councilRounds(store, task.id)) if (c.failed === undefined) reviewed.add(c.round);
  for (const run of store.agentRuns.list({ taskId: task.id, role: 'reviewer' })) {
    if (run.workspaceId !== task.workspaceId || run.status !== 'done' || run.round === undefined) continue;
    if (isAuditRun(store, run.id) || isCouncilMemberRun(store, run.id)) continue;
    if (validScore(getRunOutputs(store, run.id).review?.score)) reviewed.add(run.round);
  }
  return 1 + [...reviewed].filter((r) => r >= from && r < round).length;
}

/**
 * What a review of `round` can repeat (the merge's `earlier`): the issues the earlier rounds put to the
 * worker (the review-issue history, which members are shown from round 2: `earlierIssuesSection`) and
 * what earlier council rounds recorded besides: advisory issues and issues a rewrite replaced. Those were
 * not shown to the members (`unlisted`), so only their words and outputs can make a new issue one of them.
 */
export function earlierIssues(store: Store, task: Pick<Task, 'id' | 'workspaceId'>, round: number): MergeInput['earlier'] {
  const out = new Map<string, MergeInput['earlier'][number]>();
  for (const r of earlierRoundIssues(store, task, round)) out.set(r.issueId, { id: r.issueId, description: r.text, ...(listedForMembers(r) ? {} : { unlisted: true }) });
  for (const c of councilRounds(store, task.id)) {
    if (c.round >= round) continue;
    for (const i of [...c.result.issues, ...c.result.dropped.filter((d) => d.rule === 'rewrite').map((d) => d.issue)]) {
      const listed = out.get(i.id);
      // The history has the text the worker answered; the council's record adds the outputs it was about
      // and the wording of each member that raised it (a later member may repeat any one of them).
      if (listed) {
        if (i.where?.length) listed.where = [...new Set([...(listed.where ?? []), ...i.where])];
        if (i.wordings?.length) listed.wordings = [...new Set([...(listed.wordings ?? []), ...i.wordings])];
      } else {
        out.set(i.id, {
          id: i.id, description: i.description, ...(i.where?.length ? { where: i.where } : {}), ...(i.wordings?.length ? { wordings: i.wordings } : {}), unlisted: true,
        });
      }
    }
  }
  return [...out.values()];
}

/**
 * Review prompt section of a council member from round 2 (ruling on design §6 step 3.5): the issues the
 * earlier rounds put to the worker, with their ids and the worker's answer, so that a member (a new run
 * each round) can say that one still stands by listing it under its id. Empty when there are none.
 * Like the dispute section, it carries only the issue and the worker's answer.
 */
export function earlierIssuesSection(store: Store, task: Pick<Task, 'id' | 'workspaceId'>, round: number): string {
  const rows = earlierRoundIssues(store, task, round).filter(listedForMembers);
  if (!rows.length) return '';
  const answer = (status: string, reason: string | undefined): string =>
    status === 'fixed' ? 'fixed' : status === 'pushed_back' || status === 'upheld' ? `pushed back: ${reason ?? '(no reason given)'}` : 'none recorded';
  return [
    '## Issues of earlier rounds',
    'Earlier review rounds put these issues to the worker, who has revised the deliverable since. Check each',
    'against the current deliverable. If one still stands, list it again with the same `id` and say what in',
    'the current deliverable shows it. If it is settled, leave it out. Use one of these ids only for that',
    'same issue, and give a new issue no `id`: the harness numbers it.',
    ...rows.map((r) => `- [${r.issueId}] (${r.class}) ${r.text}\n  Worker's answer: ${answer(r.status, r.responseReason)}`),
  ].join('\n');
}

type Seat = { member: CouncilMember; controller: AbortController; ended: boolean; notWaited: boolean; outcome?: RunOutcome; refused?: Error };

const absent = (member: CouncilMember, state: MemberReview['state'], reason: string, runId?: string): MemberReview => ({
  member, state, reason, issues: [], questions: [], followUps: [], ...(runId !== undefined ? { runId } : {}),
});

/** What a member's ended run gave: its review, or why there is none. */
function memberReview(store: Store, seat: Seat): MemberReview {
  const { member, outcome } = seat;
  if (seat.notWaited) return absent(member, 'not_waited', NOT_WAITED_REASON, outcome?.agentRunId);
  if (!outcome) return absent(member, 'unavailable', `could not be started: ${seat.refused?.message ?? 'unknown error'}`);
  const runId = outcome.agentRunId;
  if (outcome.status !== 'done') return absent(member, 'no_score', failureReason(outcome), runId);
  const sent = store.decisions
    .list({ agentRunId: runId })
    .map((d) => d.payload as { tool?: unknown; score?: unknown; issues?: unknown; summary?: unknown; questions?: unknown; followUps?: unknown } | null)
    .filter((p) => p?.tool === 'submit_review')
    .at(-1);
  if (!sent) return absent(member, 'no_score', 'the run ended without a review', runId);
  if (!validScore(sent.score)) {
    const why = typeof sent.summary === 'string' && sent.summary.trim() ? sent.summary.trim() : 'no reason given';
    return absent(member, 'no_score', `the member could not score: ${why}`, runId);
  }
  const texts = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
  return {
    member, state: 'reviewed', runId, score: sent.score, issues: Array.isArray(sent.issues) ? (sent.issues as CouncilIssueIn[]) : [],
    questions: texts(sent.questions), followUps: texts(sent.followUps),
  };
}

/**
 * Runs the members that can be started and returns the review of each by name. Throws `AbortError` when
 * `deps.signal` aborts, and the supervisor's error when it refuses a blocking member's run (nothing is
 * recorded then, as for a single reviewer).
 */
async function runMembers(
  deps: ResearchDeps,
  round: { task: Task; round: number; stage: CouncilStage; roundId: string; input: ReturnType<typeof reviewerRunInput> },
  start: CouncilMember[],
): Promise<Map<string, MemberReview>> {
  const { store } = deps;
  const { task, stage, roundId, input } = round;
  const seats: Seat[] = start.map((member) => ({ member, controller: new AbortController(), ended: false, notWaited: false }));
  const abortAll = () => seats.forEach((s) => s.controller.abort());
  deps.signal?.addEventListener('abort', abortAll, { once: true });
  if (deps.signal?.aborted) abortAll();
  /** Asks the supervisor to run the member. `started`: its run has a worker slot and an id, or will never have one. */
  const launch = (seat: Seat): { started: Promise<void>; ended: Promise<void> } => {
    const { member } = seat;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => (markStarted = resolve));
    const systemPrompt = `${input.systemPrompt}\n\n${councilSection(member, stage)}`;
    const ended = (async () => {
      try {
        seat.outcome = await runAgent(
          { ...deps, signal: seat.controller.signal },
          {
            kind: 'review', role: 'reviewer', workspaceId: task.workspaceId, task, round: round.round, attempt: 1,
            prompt: input.prompt, systemPrompt, model: { provider: member.provider, model: member.model }, needsBrowser: false,
            promptVersion: promptVersion(systemPrompt), runTags: { councilRoundId: roundId, councilMember: member.name },
            onStart: () => markStarted(),
            ...(member.effort !== undefined ? { effort: member.effort } : {}),
            ...(input.promptReads.length ? { promptReads: input.promptReads } : {}),
          },
        );
      } catch (err) {
        // Before start: cancelled while it waited for a slot, or the supervisor refused the run.
        if (!(err instanceof AbortError || (err as Error).name === 'AbortError')) {
          seat.refused = err as Error;
          if (member.blocking) abortAll(); // the round cannot be made: stop what it started
        }
      } finally {
        seat.ended = true;
        markStarted();
      }
    })();
    return { started, ended };
  };
  try {
    // Blocking members first. A non-blocking member asks for a worker slot only once every blocking member
    // has one (or has ended), so with few slots (`limits.maxParallelWorkers`) it can never hold one a
    // blocking member is waiting for, wherever it is seated.
    const blocking = seats.filter((s) => s.member.blocking).map(launch);
    let over = false;
    const others = Promise.all(blocking.map((r) => r.started)).then(() =>
      over ? undefined : Promise.all(seats.filter((s) => !s.member.blocking).map((seat) => launch(seat).ended)),
    );
    await Promise.all(blocking.map((r) => r.ended));
    // The round is over: a non-blocking member still at work, or not started yet, has no round to report to.
    over = true;
    for (const seat of seats) {
      if (seat.ended) continue;
      seat.notWaited = true;
      seat.controller.abort();
    }
    await others;
    // A run that finished by itself while it was being cancelled was not cancelled: it is recorded as
    // what it is, a finished run, and its review is taken like that of a member that ended in time.
    for (const seat of seats) if (seat.notWaited && seat.outcome?.status === 'done') seat.notWaited = false;
  } finally {
    deps.signal?.removeEventListener('abort', abortAll);
  }
  throwIfAborted(deps.signal);
  const refused = seats.find((s) => s.member.blocking && s.refused);
  if (refused) throw refused.refused!;
  for (const seat of seats) {
    if (seat.notWaited && seat.outcome) store.agentRuns.update(seat.outcome.agentRunId, { failureReason: NOT_WAITED_REASON });
  }
  return new Map(seats.map((s) => [s.member.name, memberReview(store, s)]));
}

/**
 * "Evidence or nothing" (design §5.1 rule 4), checked before the merge: an id in `where` that is not an
 * output of the task and an id in `evidence` that is not in the task's review slice count for nothing
 * and are taken off the issue. They are recorded on the member's entry (`droppedIds`); the member's own
 * Decision keeps what it sent. An issue left with neither is a question by the merge's rule (step 3.3).
 */
function withKnownIds(review: MemberReview, known: { outputs: Set<string>; slice: Set<string> }): MemberReview {
  const dropped = { where: new Set<string>(), evidence: new Set<string>() };
  const check = (ids: string[] | undefined, ok: Set<string>, unknown: Set<string>): string[] => {
    for (const id of ids ?? []) if (!ok.has(id)) unknown.add(id);
    return (ids ?? []).filter((id) => ok.has(id));
  };
  const issues = review.issues.map((i): CouncilIssueIn => {
    const { where: _where, evidence: _evidence, ...rest } = i;
    const where = check(i.where, known.outputs, dropped.where);
    const evidence = check(i.evidence, known.slice, dropped.evidence);
    return { ...rest, ...(evidence.length ? { evidence } : {}), ...(where.length ? { where } : {}) };
  });
  if (!dropped.where.size && !dropped.evidence.size) return review;
  return {
    ...review, issues,
    droppedIds: { ...(dropped.where.size ? { where: [...dropped.where] } : {}), ...(dropped.evidence.size ? { evidence: [...dropped.evidence] } : {}) },
  };
}

/**
 * Why the round has failed (design §7), or `undefined`. Only a blocking member can be missing: one that
 * could not be started, or whose run gave no valid review (see the header).
 */
function failureOf(stage: CouncilStage, reviews: MemberReview[]): string | undefined {
  const blocking = reviews.filter((r) => r.member.blocking);
  const missing = blocking.filter((r) => r.state === 'unavailable' || r.state === 'no_score');
  const named = missing.map((r) => `council member '${r.member.name}' (${modelOf(r.member)}) ${r.state === 'unavailable' ? 'is unavailable' : 'gave no review'}: ${r.reason ?? 'unknown'}`);
  if (missing.length && stage.onUnavailable === 'fail') return named.join('; ');
  if (!blocking.some((r) => r.state === 'reviewed')) return `no blocking council member reviewed: ${named.join('; ')}`;
  return undefined;
}

/** Runs one council round of `stage` for the task and records it. See the header for the rules. */
export async function councilStep(deps: ResearchDeps, taskId: string, round: number, stage: CouncilStage): Promise<CouncilStepResult> {
  const { store, config } = deps;
  const task = store.tasks.get(taskId)!;
  const roundId = newCouncilRoundId(task.id);
  // Which review of the current deliverable this is: the late-issue rule and its note go by that, not by
  // the loop's round (the work may have been done again since the earlier rounds).
  const reviewOfWork = reviewOfCurrentWork(store, task, round);
  // What today's reviewer is started with, plus what depends on the round (nothing in round 1): the round
  // note and the issues of earlier rounds. They are in the review prompt, so that a member's system
  // prompt, and with it its prompt version, is the same in every round.
  const input = reviewerRunInput(deps, task, round, {}, [councilRoundNote(round, reviewOfWork), earlierIssuesSection(store, task, round)].filter(Boolean).join('\n\n'));
  const unavailable = new Map(stage.members.flatMap((m) => {
    const why = memberUnavailable(config, m);
    return why === undefined ? [] : [[m.name, why] as const];
  }));
  const canStart = stage.members.filter((m) => !unavailable.has(m.name));
  // Nobody is started when the round cannot count: a blocking member is missing under `fail`, or no
  // blocking member is left. A non-blocking member that cannot be started stops nothing.
  const missingBlocking = stage.members.filter((m) => m.blocking && unavailable.has(m.name)).map((m) => `'${m.name}'`);
  const stopped = (missingBlocking.length > 0 && stage.onUnavailable === 'fail') || !canStart.some((m) => m.blocking);
  const ran = stopped ? new Map<string, MemberReview>() : await runMembers(deps, { task, round, stage, roundId, input }, canStart);
  const known = { outputs: taskOutputIds(deps, task), slice: reviewSlice(deps, task).ids };
  const reviews = stage.members.map((m): MemberReview => {
    const review = ran.get(m.name);
    if (review) return withKnownIds(review, known);
    return unavailable.has(m.name)
      ? absent(m, 'unavailable', unavailable.get(m.name)!)
      : absent(m, 'not_waited', `not started: ${missingBlocking.join(', ')} cannot review, so the round could not count`);
  });

  const failed = failureOf(stage, reviews);
  const merged = mergeCouncil({
    stage, round: reviewOfWork, reviews,
    earlier: earlierIssues(store, task, round),
    disputed: new Set(openDisputes(store, task, round, maxReasserts(config)).map((d) => d.issueId)),
  });
  // A failed round puts nothing to the worker: what was raised stays on record, as advice (also what a
  // rewrite replaced: nothing of a round that did not count was upheld).
  const advice = <T extends { standing?: 'upheld' | 'advisory' }>(x: T): T => (x.standing === undefined ? x : { ...x, standing: 'advisory' as const });
  const result: CouncilResult =
    failed === undefined ? merged : { ...merged, pass: false, score: 0, issues: merged.issues.map(advice), dropped: merged.dropped.map(advice) };
  const payload: CouncilReviewPayload = {
    event: COUNCIL_REVIEW_EVENT, taskId: task.id, round, score: result.score, pass: result.pass,
    issues: result.issues.filter((i) => i.standing === 'upheld'), advisory: result.issues.filter((i) => i.standing === 'advisory'),
    dropped: result.dropped, questions: result.questions, followUps: result.followUps, members: result.members,
    passScore: stage.passScore, blockOn: stage.blockOn, onUnavailable: stage.onUnavailable,
    ...(failed !== undefined ? { failed } : {}),
  };

  const issues = store.transaction(() => {
    // The Decision is the round's, not a member's: its "run" is the round id, its model names no member's
    // model, and its prompt version is that of the reviewer prompt every member's prompt starts with.
    recordRunPrompt(store, 'reviewer', input.promptVersion, input.systemPrompt);
    const decision = recordHarnessDecision(
      store,
      { agentRunId: roundId, workspaceId: task.workspaceId, role: 'reviewer', model: { provider: stage.members[0]!.provider, model: 'council' }, promptVersion: input.promptVersion },
      'review',
      payload,
      [task.id],
    );
    // An experiment arm's Decisions carry its tags; this one has no run to inherit them from.
    const experiment = taskExperiment(store, task.id);
    if (experiment) store.db.prepare('UPDATE decisions SET experiment_id = ?, arm = ? WHERE id = ?').run(experiment.experimentId, experiment.arm, decision.id);
    // What the history and the revise step hold is what was stored (identity secrets redacted).
    const stored = councilReviewOf(decision) ?? payload;
    // Reasserted: only what the council upheld before the rewrite took its place. A rewrite replaces
    // advice too, and a pushed-back issue that came back as advice is withdrawn like any other.
    const replaced = stored.dropped.filter((d) => d.rule === 'rewrite' && d.standing === 'upheld').map((d) => d.issue.id);
    return recordReviewRound(store, config, task.id, round, { valid: failed === undefined, issues: upheldIssues(stored) }, { roundId, decisionId: decision.id, replaced });
  });
  return { valid: failed === undefined, score: result.score, issues, pass: result.pass, ...(failed !== undefined ? { failed } : {}) };
}
