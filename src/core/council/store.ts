import type { ReviewIssue } from '../harness/tools/handlers.js';
import type { Store } from '../store/db.js';
import { newId } from '../store/repos.js';
import type { Decision } from '../types.js';
import type { BifConfig } from '../config/schema.js';
import type { CouncilResult, MergedIssue } from './merge.js';
import type { CouncilStage, Lens } from './settings.js';

/**
 * How a council round is stored (design 2026-11-16-review-council-design.md §8), and how the rest of BIF
 * reads it as ONE review per round.
 *
 * - The round has an id (`councilRoundId`). It is no agent run: the merged review is the product of the
 *   round, not of one member, and the record must exist when no member could be started.
 * - Each member is a normal reviewer run of the task, tagged with the round id and its name
 *   (`agent_runs.council_round_id / council_member`, migration 29; written before the agent starts). Its
 *   `submit_review` Decision is kept. Runs, usage and cost stay per member run: the tag takes a run out
 *   of no metric. It only means "this run's review is one member's": whoever looks for THE review of a
 *   task skips these runs (`isCouncilMemberRun`) and reads the round's Decision instead.
 * - The round is one harness Decision of kind `review`, event `council_review`, whose `agentRunId` is the
 *   round id and whose refs name the task. Its payload is the merged review (`CouncilReviewPayload`):
 *   `score`, `pass` and `issues` (the upheld issues: what the worker must answer) read like any review, so
 *   consumers that only need those need not know about councils; the rest is the council's own record.
 * - A round that is recorded twice (a restart between the record and the task's next step) counts once:
 *   the later record replaces the earlier one (`councilRounds`). Member runs of a round that was
 *   interrupted before its record have a round id no Decision carries, so nothing ever counts them.
 * - A failed round (design §7: a blocking member is unavailable under `onUnavailable: "fail"`, or no
 *   blocking member reviewed) has `failed` (the reason), score 0 and no upheld issue: what the members that did
 *   review raised is kept as advisory. No revision is made on a partial council, so nothing of it is put
 *   to the worker; everything downstream treats it like the single reviewer's synthetic review.
 */

export const COUNCIL_REVIEW_EVENT = 'council_review';

const ROUND_PREFIX = 'cnl:';

/** A new council round id of `taskId`. The task is part of the id, so a task's rounds are found by index. */
export function newCouncilRoundId(taskId: string): string {
  return `${ROUND_PREFIX}${taskId}:${newId('r')}`;
}

/**
 * The task of a council round id; `undefined` for any other id (an agent run id among them). A round's
 * Decision has the round id where other Decisions have their run, so whoever asks "which task is this
 * Decision's run of" (what may be served of private research, the task of an outcome) asks this too.
 */
export function councilRoundTaskId(id: string | undefined): string | undefined {
  if (!id?.startsWith(ROUND_PREFIX)) return undefined;
  const end = id.indexOf(':', ROUND_PREFIX.length);
  return end > ROUND_PREFIX.length ? id.slice(ROUND_PREFIX.length, end) : undefined;
}

/** Payload of a `council_review` Decision (`tool: 'harness'` is added by `recordHarnessDecision`). */
export type CouncilReviewPayload = {
  event: typeof COUNCIL_REVIEW_EVENT;
  taskId: string;
  round: number;
  /** The lowest counted score; 0 for a failed round. */
  score: number;
  pass: boolean;
  /** Upheld issues with who raised them: what the worker must answer. */
  issues: MergedIssue[];
  /** Issues shown to the worker that do not block. */
  advisory: MergedIssue[];
  dropped: CouncilResult['dropped'];
  questions: CouncilResult['questions'];
  followUps: CouncilResult['followUps'];
  members: CouncilResult['members'];
  /** The rules the round was merged by. */
  passScore: number;
  blockOn: CouncilStage['blockOn'];
  onUnavailable: CouncilStage['onUnavailable'];
  /** Why the task must end `unverified` now (design §7). Absent for a round that was merged and judged. */
  failed?: string;
};

export type CouncilRound = {
  round: number;
  decisionId: string;
  /** When the round was recorded. */
  at: string;
  result: CouncilResult;
  /** See `CouncilReviewPayload.failed`. */
  failed?: string;
};

/** The payload of a council round's Decision; `undefined` for any other Decision. */
export function councilReviewOf(d: Pick<Decision, 'kind' | 'payload'> | undefined): CouncilReviewPayload | undefined {
  const p = d?.payload as { tool?: unknown; event?: unknown } | null | undefined;
  return d?.kind === 'review' && p?.tool === 'harness' && p.event === COUNCIL_REVIEW_EVENT ? (p as unknown as CouncilReviewPayload) : undefined;
}

/** The council round a reviewer run is a member of, and the member's name; `undefined` for any other run. */
export function councilMemberOf(store: Pick<Store, 'db'>, agentRunId: string): { roundId: string; member: string } | undefined {
  const r = store.db.prepare('SELECT council_round_id AS c, council_member AS m FROM agent_runs WHERE id = ?').get(agentRunId) as
    | { c: string | null; m: string | null }
    | undefined;
  return r && r.c !== null ? { roundId: r.c, member: r.m ?? '' } : undefined;
}

/** Whether the run is a council member's: its review is one member's, never by itself the task's review. */
export function isCouncilMemberRun(store: Pick<Store, 'db'>, agentRunId: string): boolean {
  return councilMemberOf(store, agentRunId) !== undefined;
}

/** Ids of council member runs (of one workspace, or all), for consumers that go through many runs. */
export function councilMemberRunIds(store: Pick<Store, 'db'>, workspaceId?: string): Set<string> {
  const rows = store.db
    .prepare(`SELECT id FROM agent_runs WHERE council_round_id IS NOT NULL${workspaceId !== undefined ? ' AND workspace_id = ?' : ''}`)
    .all(...(workspaceId !== undefined ? [workspaceId] : [])) as Array<{ id: string }>;
  return new Set(rows.map((r) => r.id));
}

/**
 * Ids of the tasks of a node that have a council round on record, whatever its outcome (design §9: the
 * council table is offered wherever such a task is listed, also for a task that passed).
 */
export function councilReviewedTaskIds(store: Pick<Store, 'db'>, workspaceId: string): Set<string> {
  const rows = store.db
    .prepare(`SELECT DISTINCT agent_run_id AS r FROM decisions WHERE workspace_id = ? AND kind = 'review' AND agent_run_id >= ? AND agent_run_id < ?`)
    .all(workspaceId, ROUND_PREFIX, `${ROUND_PREFIX}\uffff`) as Array<{ r: string }>;
  return new Set(rows.flatMap((x) => councilRoundTaskId(x.r) ?? []));
}

/** What a member's own review Decision is marked with where Decisions are listed (design §9). */
export type CouncilMemberMark = { name: string; lens?: Lens };

/**
 * A review Decision as lists and live events serve it: one made by a council member run carries
 * `councilMember` (the member's name and lens), so it is read as one member's review and not as a
 * further review of the task. Every other Decision is returned as it is. The lens is the one the member
 * had in its round (the round's record); while the round is not recorded yet, or never was, the one the
 * configuration gives that name now.
 */
export function withCouncilMember<D extends Pick<Decision, 'agentRunId' | 'kind'>>(
  store: Store,
  config: Pick<BifConfig, 'council'>,
  d: D,
): D & { councilMember?: CouncilMemberMark } {
  if (d.kind !== 'review') return d;
  const member = councilMemberOf(store, d.agentRunId);
  if (!member) return d;
  const recorded = store.decisions.list({ agentRunId: member.roundId }).flatMap((x) => councilReviewOf(x) ?? []).at(-1);
  const lens = recorded?.members.find((m) => m.name === member.member)?.lens ?? config.council?.members.find((m) => m.name === member.member)?.lens;
  return { ...d, councilMember: { name: member.member, ...(lens ? { lens } : {}) } };
}

/** Every `council_review` Decision of the task, oldest first (a round recorded twice is there twice). */
export function councilReviewDecisions(store: Store, task: { id: string; workspaceId: string }): Decision[] {
  const prefix = `${ROUND_PREFIX}${task.id}:`;
  const ids = store.db
    .prepare(`SELECT id FROM decisions WHERE agent_run_id >= ? AND agent_run_id < ? AND kind = 'review' ORDER BY rowid`)
    .all(prefix, `${prefix}￿`) as Array<{ id: string }>;
  return ids
    .map((r) => store.decisions.get(r.id))
    .filter((d): d is Decision => d !== undefined && d.workspaceId === task.workspaceId && councilReviewOf(d)?.taskId === task.id);
}

function roundOf(d: Decision, p: CouncilReviewPayload): CouncilRound {
  const result: CouncilResult = {
    pass: p.pass, score: p.score, issues: [...p.issues, ...p.advisory], dropped: p.dropped, questions: p.questions,
    followUps: p.followUps, members: p.members,
  };
  return { round: p.round, decisionId: d.id, at: d.createdAt, result, ...(p.failed !== undefined ? { failed: p.failed } : {}) };
}

/** The council rounds of a task, by round; of a round recorded more than once, the latest record. */
export function councilRounds(store: Store, taskId: string): CouncilRound[] {
  const task = store.tasks.get(taskId);
  if (!task) return [];
  const byRound = new Map<number, CouncilRound>();
  for (const d of councilReviewDecisions(store, task)) {
    const r = roundOf(d, councilReviewOf(d)!);
    byRound.set(r.round, r);
  }
  return [...byRound.values()].sort((a, b) => a.round - b.round);
}

/** A round of private research while it is withheld: that it took place, and nothing of what it said. */
export type WithheldCouncilRound = Pick<CouncilRound, 'round' | 'decisionId' | 'at'> & { withheld: true };

/** What `GET /api/workspaces/:id/tasks/:taskId/council` serves: the council table of a task (design §9). */
export type CouncilView = {
  /** The rules of the task type's council stage in the current configuration; absent when it is not a council stage. */
  stage?: Pick<CouncilStage, 'rounds' | 'passScore' | 'blockOn' | 'onUnavailable'>;
  /** The recorded rounds, by round; empty for a task no council reviewed. */
  rounds: Array<CouncilRound | WithheldCouncilRound>;
  /** The task is private research that is withheld (stakeholder design §7): every round is a `WithheldCouncilRound`. */
  withheld?: true;
};

/**
 * The council view of a task. `withheld`: the caller's ruling on whether the task's research is served
 * (`withholding(store).task(task)`; not decided here, because that module reads this one).
 */
export function councilView(store: Store, task: { id: string }, stage: CouncilStage | undefined, withheld: boolean): CouncilView {
  const rounds = councilRounds(store, task.id);
  return {
    ...(stage ? { stage: { rounds: stage.rounds, passScore: stage.passScore, blockOn: stage.blockOn, onUnavailable: stage.onUnavailable } } : {}),
    ...(withheld ? { withheld: true as const } : {}),
    rounds: withheld ? rounds.map((r) => ({ round: r.round, decisionId: r.decisionId, at: r.at, withheld: true as const })) : rounds,
  };
}

/** The upheld issues of a recorded round as plain review issues (what the revise step and the history hold). */
export function upheldIssues(p: Pick<CouncilReviewPayload, 'issues'>): ReviewIssue[] {
  return p.issues.map((i) => ({ id: i.id, class: i.class, description: i.description, ...(i.evidence?.length ? { evidence: i.evidence } : {}) }));
}

/**
 * Every issue id the task's reviews have used so far: the review-issue history and what its council rounds
 * recorded (upheld, advisory, dropped). The harness gives a member's new issue none of these, because a
 * member that reuses the id of an earlier issue is taken to mean that issue (design §6 step 3.5).
 */
export function usedIssueIds(store: Store, task: { id: string; workspaceId: string }): Set<string> {
  const ids = new Set(
    (store.db.prepare('SELECT DISTINCT issue_id AS i FROM review_issues WHERE task_id = ? AND workspace_id = ?').all(task.id, task.workspaceId) as Array<{ i: string }>).map(
      (r) => r.i,
    ),
  );
  for (const d of councilReviewDecisions(store, task)) {
    const p = councilReviewOf(d)!;
    for (const i of [...p.issues, ...p.advisory, ...p.dropped.map((x) => x.issue)]) ids.add(i.id);
  }
  return ids;
}
