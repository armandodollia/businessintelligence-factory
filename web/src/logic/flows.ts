/**
 * Flows page wording (design 2026-11-14-flow-records-and-ranking-design.md §10.5, §12.2): plain
 * labels for scores, badges, stop reasons, check answers and persona verdicts. Pure functions; the
 * data comes from the hooks (`useFlowTypes`, `useFlowRanking`, `useFlow`, `useFlowCompare`).
 */
import type { CheckAnswer, FlowPersonaRef, IgnoredOverride, RankedFlowRow, StopReason } from './types.js';

/** Longest reason the server takes. */
export const REASON_MAX = 2000;

/** Why a walk stopped before the goal, in words. */
export const STOP_REASON_WORDS: Record<StopReason, string> = {
  payment: 'payment',
  phone: 'phone',
  kyc: 'identity check',
  captcha: 'captcha',
  approval_needed: 'approval needed',
  error: 'error',
  not_found: 'not found',
};

/** "stopped at: payment" for a partial flow; '' for one that reached its goal. */
export function stopText(flow: { reachedGoal: boolean; stopReason?: StopReason }): string {
  if (flow.reachedGoal) return '';
  return flow.stopReason ? `stopped at: ${STOP_REASON_WORDS[flow.stopReason]}` : 'stopped before the goal';
}

export const CHECK_ANSWER_WORDS: Record<CheckAnswer, string> = {
  pass: 'yes, passes',
  fail: 'no, fails',
  na: 'does not apply',
  recorded: 'recorded',
  reported_problem: 'problem reported in reviews',
  no_signal: 'nothing found yet',
  disputed: 'reviews disagree with the walkthrough',
};

/** Answers the user can set when correcting a check (scored checks pass or fail; any check may not apply). */
export function correctableAnswers(scored: boolean): CheckAnswer[] {
  return scored ? ['pass', 'fail', 'na'] : ['recorded', 'na'];
}

export const STRENGTH_WORDS: Record<1 | 2 | 3, string> = { 1: 'slightly', 2: 'clearly', 3: 'strongly' };

export const STAGE_WORDS: Record<'broad' | 'focused', string> = {
  broad: 'broad: judged among all flows at once',
  focused: 'focused: judged on this pair alone',
};

/** A score 0–100 as a whole number; '—' when there is none. */
export function scoreText(n: number | undefined): string {
  return n == null ? '—' : String(Math.round(n));
}

export const pct = (share: number): string => `${Math.round(share * 100)}%`;

/** "wins 9/10" (ties count as comparisons); '—' when the flow was compared with nothing. */
export function winsText(row: Pick<RankedFlowRow, 'wins' | 'comparisons'>): string {
  return row.comparisons > 0 ? `wins ${row.wins}/${row.comparisons}` : '—';
}

/** "14 (3 neg)". */
export function reviewsText(r: { total: number; negative: number }): string {
  return `${r.total} (${r.negative} neg)`;
}

export function personaLabel(p: FlowPersonaRef): string {
  const name = p.segment || p.slug || p.id;
  return p.version !== undefined ? `${name} (v${p.version})` : name;
}

/** Subject name plus the variant ("Acme — by email") when the variant is worth saying. */
export function flowLabel(subject: { name: string } | undefined, flow: { variant?: string; name?: string } | undefined, withVariant = false): string {
  const name = subject?.name ?? flow?.name ?? 'a flow';
  return withVariant && flow?.variant ? `${name} — ${flow.variant}` : name;
}

/**
 * The position was decided by the personas: the flow was ranked on their verdicts alone, or it sits
 * above a flow with a higher checklist score (the personas' preference outweighed the checklist).
 * A pair the user ruled on is the user's decision, not the personas'.
 */
export function decidedByPersonas(row: RankedFlowRow, ranked: RankedFlowRow[]): boolean {
  if (row.decidedBy === 'persona_only') return true;
  const mine = row.checklist;
  if (mine === undefined) return false;
  const ruled = new Set(row.overriddenBy ?? []);
  return ranked.some(
    (o) => o.position > row.position && o.checklist !== undefined && o.checklist > mine && !(o.overriddenBy ?? []).some((id) => ruled.has(id)),
  );
}

/** The flow had nothing to be compared with (the only one of its type, or no verdict on it yet). */
export function noComparison(row: RankedFlowRow, ranked: RankedFlowRow[], noPersonas: boolean): boolean {
  return ranked.length < 2 || (!noPersonas && row.comparisons === 0);
}

export type FlowBadge = 'partial' | 'no comparison' | 'overridden' | 'shared position' | 'decided by personas';

/** The badges of one ranking row, in a fixed order. */
export function rowBadges(row: RankedFlowRow, ranked: RankedFlowRow[], noPersonas: boolean): FlowBadge[] {
  const out: FlowBadge[] = [];
  if (row.partial) out.push('partial');
  if (noComparison(row, ranked, noPersonas)) out.push('no comparison');
  if ((row.overriddenBy ?? []).length > 0) out.push('overridden');
  if (row.sharedPosition) out.push('shared position');
  if (decidedByPersonas(row, ranked)) out.push('decided by personas');
  return out;
}

/** How the rank score is made, in words. */
export function blendText(coverage: number, noPersonas: boolean, typeName: string): string {
  if (noPersonas) return `Rank score = the checklist score alone (no persona judgment for this part of the business).`;
  return (
    `Rank score = ${pct(coverage)} checklist + ${pct(1 - coverage)} personas. ` +
    `The checklist settles about ${pct(coverage)} of judging ${typeName}; the rest is the personas' simulated judgment.`
  );
}

export const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/** Why some of the user's rulings are not followed, one sentence per reason; none when all are. */
export function ignoredRulingsText(ignored: IgnoredOverride[]): string[] {
  const conflict = ignored.filter((o) => o.reason === 'conflict').length;
  const notRanked = ignored.filter((o) => o.reason === 'not_ranked').length;
  const out: string[] = [];
  if (conflict === 1) out.push('1 of your rulings was not kept: it contradicts a newer one.');
  else if (conflict > 1) out.push(`${conflict} of your rulings were not kept: they contradict newer ones.`);
  if (notRanked === 1) out.push('1 of your rulings is not used in this list: one of its flows is not in it (another way through, or a flow no longer used).');
  else if (notRanked > 1) {
    out.push(`${notRanked} of your rulings are not used in this list: one of their flows is not in it (another way through, or a flow no longer used).`);
  }
  return out;
}

/** "1 new flow type, 1 checklist to accept"; '' when nothing waits. */
export function waitingText(p: { flowTypes: number; checklists: number }): string {
  const parts: string[] = [];
  if (p.flowTypes > 0) parts.push(`${plural(p.flowTypes, 'new flow type')}`);
  if (p.checklists > 0) parts.push(`${plural(p.checklists, 'checklist')} to accept`);
  return parts.join(', ');
}

export const SOURCE_WORDS: Record<string, string> = {
  app_store: 'app store',
  review_site: 'review site',
  forum: 'forum',
  community: 'community',
  support_board: 'support board',
  social: 'social media',
  user_provided: 'you provided it',
};
