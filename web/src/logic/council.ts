/**
 * Review council (design 2026-11-16-review-council-design.md §9): what the council table and the
 * settings page say. Behaviour only; `views/CouncilTable.tsx` and `views/Settings.tsx` render it.
 */
import { councilApi } from './api.js';
import { useResource } from './hooks.js';
import type { CouncilOverview, CouncilResult, CouncilRound, CouncilView, WithheldCouncilRound } from './types.js';

type Member = CouncilResult['members'][number];
type Rules = NonNullable<CouncilView['stage']>;

/** What a member gave in a round; `undefined`: it was not seated in that round. */
export function memberCell(m: Pick<Member, 'state' | 'score'> | undefined): string {
  if (!m) return '—';
  switch (m.state) {
    case 'reviewed':
      return `${m.score ?? '?'}/10`;
    case 'no_score':
      return 'no score';
    case 'unavailable':
      return 'unavailable';
    case 'not_waited':
      return 'not waited for';
  }
}

/** How a round ended. */
export function roundResult(r: CouncilRound): string {
  if (r.failed !== undefined) return 'did not count';
  return `${r.result.pass ? 'passed' : 'not passed'} (${r.result.score})`;
}

/** `blockOn` in words. */
export function blockOnText(blockOn: Rules['blockOn']): string {
  const who = blockOn === 'any' ? 'any blocking member raises it' : blockOn === 'majority' ? 'more than half of the blocking members raise it' : 'every blocking member raises it';
  return `an issue blocks when ${who}`;
}

/** `onUnavailable` in words (it is about blocking members; a non-blocking member never ends a task). */
export function onUnavailableText(onUnavailable: Rules['onUnavailable']): string {
  return onUnavailable === 'fail' ? 'a blocking member that is unavailable ends the task unverified' : 'a round goes on without a member that is unavailable';
}

const isRecorded = (r: CouncilRound | WithheldCouncilRound): r is CouncilRound => !('withheld' in r);

export type CouncilTableData = {
  rounds: CouncilRound[];
  /** Every member seated in some round, in the order they first appear, with what each gave per round. */
  rows: Array<{ member: Member; cells: Array<Member | undefined> }>;
  /** Members without a score, per round, with the reason on record. */
  reasons: Array<{ round: number; name: string; state: string; reason: string }>;
  /** Of the latest round: what the worker must answer, what it was shown as advice, the questions. */
  open: CouncilResult['issues'];
  advisory: CouncilResult['issues'];
  questions: CouncilResult['questions'];
  /** Of every round (they are for later work, and a later round's members need not repeat them). */
  followUps: Array<{ text: string; raisedBy: string[]; round: number }>;
};

/** The table and the lists below it, from the rounds the API served. */
export function councilTable(view: CouncilView): CouncilTableData {
  const rounds = view.rounds.filter(isRecorded);
  const order: Member[] = [];
  for (const r of rounds) for (const m of r.result.members) if (!order.some((o) => o.name === m.name)) order.push(m);
  const latest = rounds.at(-1);
  const followUps: CouncilTableData['followUps'] = [];
  for (const r of rounds) {
    for (const f of r.result.followUps) if (!followUps.some((x) => x.text === f.text)) followUps.push({ ...f, round: r.round });
  }
  return {
    rounds,
    rows: order.map((member) => ({ member, cells: rounds.map((r) => r.result.members.find((m) => m.name === member.name)) })),
    reasons: rounds.flatMap((r) =>
      r.result.members.flatMap((m) => (m.state !== 'reviewed' && m.reason ? [{ round: r.round, name: m.name, state: memberCell(m), reason: m.reason }] : [])),
    ),
    open: latest?.result.issues.filter((i) => i.standing === 'upheld') ?? [],
    advisory: latest?.result.issues.filter((i) => i.standing === 'advisory') ?? [],
    questions: latest?.result.questions ?? [],
    followUps,
  };
}

/** Whether a task served by the API was reviewed by a council (`councilReviewed`): its council table can be opened. */
export const isCouncilReviewed = (task: unknown): boolean => !!task && typeof task === 'object' && (task as { councilReviewed?: unknown }).councilReviewed === true;

/**
 * What a review Decision is where review Decisions are listed, when it is a council's: a member's own
 * review ("council member: <name> (<lens>)", so it is not read as a further review of the task) or the
 * round's one review. `undefined` for a single reviewer's review and for anything else.
 */
export function reviewDecisionLabel(d: { payload: unknown; councilMember?: { name: string; lens?: string } }): string | undefined {
  if (d.councilMember) return `council member: ${d.councilMember.name}${d.councilMember.lens ? ` (${d.councilMember.lens})` : ''}`;
  const p = d.payload as { tool?: unknown; event?: unknown } | null;
  return p?.tool === 'harness' && p.event === 'council_review' ? 'council review' : undefined;
}

/** The council rounds of a task, read from the node the page is on. Loaded once: a round is not live. */
export function useTaskCouncil(taskId: string, wsId: string) {
  const res = useResource(`council:${wsId}:${taskId}`, () => councilApi.getTaskCouncil(taskId, wsId));
  return { view: res.data ?? null, loading: res.loading, error: res.error };
}

/** The configured council for the settings page; `reloadKey` changes when the configuration was saved. */
export function useCouncilOverview(reloadKey: string | null): { council: CouncilOverview | null; loaded: boolean; error: string | null } {
  const res = useResource(`council-overview:${reloadKey ?? ''}`, councilApi.getCouncil);
  return { council: res.data?.council ?? null, loaded: res.data !== undefined, error: res.error };
}
