/**
 * Stakeholder personas: the wording and pure helpers of the Stakeholders page and of the reads on a
 * recommendation (design 2026-11-15-stakeholder-personas-design.md §7, §8, §15). `useStakeholders` and
 * `useStakeholderReads` (hooks.ts) hold the state and the user's actions; `views/Stakeholders.tsx` and
 * `views/stakeholders/*` render.
 */
import { plural } from './flows.js';
import type {
  HiddenStakeholderView,
  OpenStakeholderView,
  RealDecision,
  StakeholderQuestionGroup,
  StakeholderView,
  StakeholdersView,
} from './types.js';

/** The intro of the question round (§15, exact copy). */
export const QUESTIONS_INTRO = 'The tool has drafted a picture of each of these. It will show you after you answer, so your answers are your own.';
/** Said once while the node still has hidden stakeholders. */
export const KEPT_OUT_NOTE = 'Research on these stakeholders is kept out of the activity log until you answer, skip or choose to see it.';
/** What a task, run, decision or request of withheld own-stakeholder research shows instead of its content (§7). */
export const WITHHELD_TEXT = 'Withheld until you answer the stakeholder questions';

/** Mirrors `REAL_DECISIONS` (src/core/stakeholders/types.ts). */
export const REAL_DECISIONS: readonly RealDecision[] = ['approved', 'approved_with_conditions', 'rejected', 'deferred'];

/** "approved_with_conditions" → "approved with conditions" (stances, decisions, field names). */
export const words = (key: string): string => key.replace(/_/g, ' ');

/** "Questions for you (3 stakeholders)". */
export const questionsHeading = (groups: StakeholderQuestionGroup[]): string =>
  `Questions for you (${plural(groups.filter((g) => g.persona).length, 'stakeholder')})`;

export const isHiddenView = (v: StakeholderView): v is HiddenStakeholderView => v.disclosure === 'hidden';
export const isOpenView = (v: StakeholderView): v is OpenStakeholderView => v.disclosure === 'open';

/** The answers worth sending: only questions the user typed something into (blank answers are never sent). */
export function answersToSend(groups: StakeholderQuestionGroup[], drafts: Record<string, string>): Array<{ questionId: string; text: string }> {
  const out: Array<{ questionId: string; text: string }> = [];
  for (const g of groups) {
    for (const q of g.questions) {
      const text = drafts[q.id]?.trim();
      if (text) out.push({ questionId: q.id, text });
    }
  }
  return out;
}

/**
 * Whether something served by the API is withheld research: a task, run, run-events page or request
 * with `withheld: true`, or a Decision payload `{ tool?, withheld: true }`.
 */
export const isWithheld = (x: unknown): boolean => !!x && typeof x === 'object' && (x as { withheld?: unknown }).withheld === true;

/** The payload of `GET .../stakeholders`, or null for anything not shaped like one (e.g. an older server). */
export function asStakeholdersView(data: unknown): StakeholdersView | null {
  const v = data as Partial<StakeholdersView> | null | undefined;
  return v && typeof v === 'object' && Array.isArray(v.own) && Array.isArray(v.competitors) ? (v as StakeholdersView) : null;
}
