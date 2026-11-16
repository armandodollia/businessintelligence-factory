import { promptTemplate, renderTemplate } from '../prompts/index.js';
import type { CouncilMember, CouncilStage, Lens } from './settings.js';

/**
 * What a council member is told on top of the reviewer prompt (design 2026-11-16-review-council-design.md
 * §5): the member rules (`council_member.md`, §5.1), its one lens (§5.2), how to report a useless finding
 * (§5.3) and a rewrite (§5.4) and the pass score. That is its system prompt: the same in every round, so
 * a member has one prompt version per lens and pass score. What depends on the round is in its review
 * prompt: from the second review of a deliverable, the rule that keeps the scope of the review from growing
 * (`councilRoundNote`, §6 step 3.5), and from round 2 the issues of earlier rounds (`council/round.ts`).
 */

/** §5.3. Every member reports one when it sees it; the `value` lens hunts for them. */
const USELESS_FINDING = `A finding is useless when removing it would change no recommendation, no hypothesis and no answer to the brief:

- it restates its source without a claim that bears on the brief;
- it repeats another finding of this task, or a fact already stored, in other words;
- it cannot be checked against any evidence, and nothing rests on it;
- it is about a subject the brief does not ask about.

Raise each one as an issue with \`action: "delete"\`, class \`substantive\`, the finding's id in \`where\`, and one sentence on what would still hold without it. Never propose deleting a finding that is the only support of an acceptance criterion, or that a recommendation or hypothesis of this task cites.`;

/** §5.4. Every member reports one when it sees it; the `rewrite` lens looks for one. */
const REWRITE = `Raise it as one issue with \`action: "rewrite"\`: in \`where\`, the outputs to discard (several ids are fine); in the description, the other approach in five lines or fewer, why it answers this brief better, and which acceptance criteria it covers. It must deliver the same task and nothing more.`;

/** §5.2: what the member of each lens looks for (a member's prompt holds the text of its own lens only). */
export const LOOK_FOR: Record<Lens, string> = {
  evidence:
    'Check each claim against the copy it cites: figures, dates, names and quotes match; nothing is invented, stale or misattributed; one source is not presented as several.',
  brief:
    'Go through each acceptance criterion and each thing the brief asks for, and decide whether it is met, partly met, unmet or not checkable. Anything not fully met is at least `substantive`.',
  reasoning:
    'Check the step from evidence to conclusion: findings that do not support the recommendation or hypothesis built on them, scores and priorities the evidence does not justify, counter-evidence that was ignored, alternative explanations that were not ruled out.',
  privacy:
    'Look for upload-derived or interview text where it must not be, internal details in public-facing output, data of another business tree, and stored secrets.',
  value: `Hunt for useless findings: go through every finding of this task and ask what would change without it.\n\n${USELESS_FINDING}`,
  rewrite: `Look for a better way to do the same task: would discarding this deliverable, or part of it, and working another way answer the brief better? When there is one:\n\n${REWRITE}`,
};

/** What a member reports when it sees it, whatever its lens: the two things its own lens does not already cover. */
function alsoReport(lens: Lens): string {
  const parts: string[] = [];
  if (lens !== 'value') parts.push(`**A useless finding.** ${USELESS_FINDING}`);
  if (lens !== 'rewrite') parts.push(`**A rewrite**, when discarding outputs of this task and working another way would answer the brief better. ${REWRITE}`);
  return parts.join('\n\n');
}

/**
 * §6 step 3.5, told to members from the second review of a deliverable so a late issue is classed for what
 * it is: a section of the member's review prompt (never of its system prompt, which must not change with
 * the round). `round`: the loop's round, for the heading. `reviewOfWork`: which review of the current
 * deliverable this is (`reviewOfCurrentWork` in council/round.ts). Empty for its first review, in whatever
 * round that is: after an escalation the work can be done again in a later round, and then no revision
 * has been made and no issue is late.
 */
export function councilRoundNote(round: number, reviewOfWork: number): string {
  if (reviewOfWork < 2) return '';
  return (
    `## Review round ${round}\n` +
    'The worker has revised the deliverable since the first review. To keep the task from growing with every round, a `substantive` issue that no member raised in an earlier round is now shown to the worker as advice and does not block. ' +
    'A new `blocking` issue still blocks, so use `blocking` only for what it means: the deliverable is wrong or unusable without the fix.'
  );
}

/** The council section of a member's system prompt, appended to the reviewer system prompt. The same in every round. */
export function councilSection(member: CouncilMember, stage: Pick<CouncilStage, 'passScore'>): string {
  const rules = renderTemplate(promptTemplate('council_member'), {
    lens: member.lens,
    passScore: String(stage.passScore),
    lookFor: LOOK_FOR[member.lens],
    alsoReport: alsoReport(member.lens),
  });
  return `${rules.trimEnd()}\n`;
}
