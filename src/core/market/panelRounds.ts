import { createHash } from 'node:crypto';
import { fenceEvidence } from '../knowledge/trust.js';
import { REPEAT_SIMILARITY, issueSimilarity } from '../learning/reviewIssues.js';
import { renderTemplate } from '../prompts/index.js';
import type { Store } from '../store/db.js';
import { newId } from '../store/repos.js';
import type { PanelBaseline, PanelRead, PersonaFeedback, PersonaRuling, Recommendation } from '../types.js';
import type { PanelSettings } from './panelSettings.js';

/**
 * Rounds and the baseline of a configured persona panel (design 2026-11-16-persona-panel-design.md §5,
 * §7, §9, §11): which read is next, what a later round is told, the check of its rulings, the comparison
 * with the baseline, and the reads kept apart from `Recommendation.personaFeedback` (migration 30).
 * `panel.ts` runs the panel with these. Nothing here applies without a `personaPanel` block.
 */

// --- the same text --------------------------------------------------------------------------------

/**
 * Hash of a recommendation's text as the panel prompt shows it: its title and its summary, and nothing
 * else of it. Two reads are of the same text when their hashes are equal.
 */
export function textHashOf(rec: Pick<Recommendation, 'title' | 'summary'>): string {
  return createHash('sha256').update(JSON.stringify([rec.title, rec.summary])).digest('hex').slice(0, 16);
}

// --- which read is next (design §7) ---------------------------------------------------------------

/** What a reader (a persona, or the baseline) does with a recommendation in a panel run. `round`: of the read, or of the last read when none is made. */
export type ReadPlan = { read: true; round: number } | { read: false; why: 'unchanged' | 'round_limit'; round: number };

/**
 * The next read of a text by a reader whose current reaction is `last`:
 * - no reaction yet: round 1;
 * - a reaction to the same text: none (rereading unchanged work is not a round);
 * - a reaction to another text: the next round, while rounds are left; none once they are used up.
 * A reaction stored before rounds were recorded is round 1 with no hash, so its next read is round 2.
 */
export function planRead(settings: Pick<PanelSettings, 'rounds'>, textHash: string, last: Pick<PersonaFeedback, 'round' | 'textHash'> | undefined): ReadPlan {
  if (!last) return { read: true, round: 1 };
  const round = last.round ?? 1;
  if (last.textHash === textHash) return { read: false, why: 'unchanged', round };
  return round >= settings.rounds ? { read: false, why: 'round_limit', round } : { read: true, round: round + 1 };
}

// --- what a later round is told ---------------------------------------------------------------------

/**
 * A concern a reader still has open, as its next round lists it, with what was recorded of it when it
 * was raised. `basis`: the part of the profile it rests on; '' when the reader gave none (ungrounded);
 * `null` when nothing is recorded (it was raised before the panel asked for a basis).
 */
export type OpenConcern = { text: string; basis: string | null };

/**
 * The concerns a reader still has open after the reaction `last`, each on one line: the concerns listed
 * to it then that it did not rule `resolved` (they stand, or it gave no ruling), then the concerns it
 * raised then. They are what its next round lists, numbered from 1. Each keeps its basis: a carried
 * concern the one carried with it (`earlierConcernBasis`), a concern raised in `last` the one given
 * with it (`concernBasis`). A concern listed twice is listed once, as its first listing has it.
 */
export function openConcerns(
  last: Pick<PersonaFeedback, 'concerns' | 'concernBasis' | 'earlierConcerns' | 'earlierConcernBasis' | 'rulings'>,
): OpenConcern[] {
  const ruled = new Map((last.rulings ?? []).map((r) => [r.concern, r.ruling]));
  const standing = (last.earlierConcerns ?? [])
    .map((text, i): OpenConcern => ({ text, basis: last.earlierConcernBasis?.[i] ?? null }))
    .filter((_, i) => ruled.get(i + 1) !== 'resolved');
  const raised = last.concerns.map((text, i): OpenConcern => ({ text, basis: last.concernBasis ? (last.concernBasis[i] ?? '') : null }));
  const open = new Map<string, OpenConcern>();
  for (const concern of [...standing, ...raised]) {
    const text = concern.text.replace(/\s+/g, ' ').trim();
    if (text && !open.has(text)) open.set(text, { text, basis: concern.basis });
  }
  return [...open.values()];
}

/** A recommendation's text as a round prompt shows it inside a fence: untrusted data, which can neither close its fence nor open another. */
const fencedText = (label: string, text: Pick<Recommendation, 'title' | 'summary'>) => fenceEvidence(label, `Title: ${text.title}\n\n${text.summary}`);

/**
 * The part of the prompt of a round after the first (`persona_panel_round.md`), for the reader whose
 * current reaction is `last`: that the text changed, the text it read then (`last.textRead`) and the
 * text as it stands now (`current`), both fenced as data, and its own open concerns to rule on
 * (`listed`, in the order they are numbered, each with what was recorded of it: the prompt lists their
 * texts only). A reaction stored without its text has no earlier text to show: the prompt says so and
 * shows the text as it stands now only. Of earlier reads only `last` is read: the earlier text is the
 * reader's own earlier read, and nothing of any other reader can be in it.
 */
export function roundPart(
  template: string,
  round: number,
  last: Pick<PersonaFeedback, 'concerns' | 'concernBasis' | 'earlierConcerns' | 'earlierConcernBasis' | 'rulings' | 'textHash' | 'textRead'>,
  current: Pick<Recommendation, 'title' | 'summary'>,
): { text: string; listed: OpenConcern[] } {
  const listed = openConcerns(last);
  const text = renderTemplate(template, {
    round: String(round),
    changed: last.textHash
      ? 'The text of the recommendation changed since you last read it.'
      : 'You last read it before the panel recorded which text a reader read: the text may have changed since.',
    earlier_text: last.textRead
      ? `The text you read before:\n\n${fencedText('text_you_read_before', last.textRead)}`
      : 'The text you read before was not kept, so it cannot be shown.',
    current_text: fencedText('text_as_it_stands_now', current),
    earlier_concerns: listed.length ? listed.map((c, i) => `${i + 1}. ${c.text}`).join('\n') : 'None: you left no concern open.',
  });
  return { text, listed };
}

// --- rulings --------------------------------------------------------------------------------------

/** How many earlier concerns each running read of a configured panel was listed, by agent run id (set when the run starts, removed when it ends). */
const listedTo = new Map<string, number>();

/** Says how many earlier concerns the run was listed (0 in round 1), for `rulingsProblem`. */
export function expectRulings(agentRunId: string, listed: number): void {
  listedTo.set(agentRunId, listed);
}

export function forgetRulings(agentRunId: string): void {
  listedTo.delete(agentRunId);
}

/**
 * Why the rulings of a `submit_persona_feedback` call are refused, if they are: a ruling on a concern
 * that was not listed to the run, or two rulings on one concern. A concern without a ruling is no
 * problem (it is recorded as not ruled, `notRuled`). A run that is not a read of a configured panel is
 * not checked.
 */
export function rulingsProblem(agentRunId: string, rulings: PersonaRuling[] | undefined): string | undefined {
  const listed = listedTo.get(agentRunId);
  if (listed === undefined || !rulings?.length) return undefined;
  if (listed === 0) return 'rulings: your prompt lists no earlier concerns to rule on; send no `rulings`';
  const unknown = [...new Set(rulings.map((r) => r.concern).filter((n) => n > listed))];
  if (unknown.length) {
    return `rulings: concern ${unknown.join(', ')} is not one of your earlier concerns (your prompt lists 1 to ${listed}); rule only on the concerns listed`;
  }
  const twice = [...new Set(rulings.map((r) => r.concern).filter((n, i, all) => all.indexOf(n) !== i))];
  return twice.length ? `rulings: concern ${twice.join(', ')} has more than one ruling; send one ruling per concern` : undefined;
}

/** The numbers (from 1) of the `listed` concerns that `rulings` holds no ruling on. */
export function notRuled(listed: number, rulings: PersonaRuling[] | undefined): number[] {
  const ruled = new Set((rulings ?? []).map((r) => r.concern));
  return Array.from({ length: listed }, (_, i) => i + 1).filter((n) => !ruled.has(n));
}

// --- the baseline (design §5) ---------------------------------------------------------------------

/**
 * The system prompt of the run with no persona: a general reader. It gets the panel prompt a persona
 * gets, which speaks of "your profile"; this says there is none.
 */
export const BASELINE_SYSTEM_PROMPT = `You are a general reader with no particular stake in what you are asked to read. You are not a customer, a user, a buyer, an employee or a consultant of the business in question, and you stand for no group of people.

You have no profile. Where your task speaks of your profile, or of the person described in it, there is none: react as any careful reader would, from what the text itself says. Do not invent a role, a history or a persona for yourself. Where a rule asks for the part of your profile a concern rests on, name the part of the text it rests on.

Answer by calling \`submit_persona_feedback\` exactly once. Do not call any other tool.
`;

const comparedText = (r: Pick<PersonaFeedback, 'concerns' | 'reasoning'>) => [...r.concerns, r.reasoning].join('\n');

/**
 * Whether a reaction says what the baseline says: its concerns and reasoning are as similar to the
 * baseline's as a review issue is to one it repeats (`issueSimilarity` at `REPEAT_SIMILARITY`).
 */
export function sameAsBaseline(reaction: Pick<PersonaFeedback, 'concerns' | 'reasoning'>, baseline: Pick<PersonaFeedback, 'concerns' | 'reasoning'>): boolean {
  return issueSimilarity(comparedText(reaction), comparedText(baseline)) >= REPEAT_SIMILARITY;
}

// --- the reads kept apart (migration 30) ------------------------------------------------------------

type Reads = Pick<Store, 'personaPanelReads'>;

/**
 * The reads of a recommendation that are not a persona's current reaction, each list in the order
 * stored: every baseline (the last is the baseline of the text it read), and the earlier rounds of the
 * personas. Simulated, like the feedback they belong to.
 */
export function panelHistory(store: Reads, recommendationId: string): { baselines: PanelRead[]; earlierRounds: PanelRead[] } {
  const reads = store.personaPanelReads.list({ recommendationId });
  return { baselines: reads.filter((r) => r.kind === 'baseline'), earlierRounds: reads.filter((r) => r.kind === 'persona') };
}

/** The last baseline stored for a recommendation, with its row. */
export function latestBaseline(store: Reads, recommendationId: string): (PanelRead & { reaction: PanelBaseline }) | undefined {
  return store.personaPanelReads.list({ recommendationId, kind: 'baseline' }).at(-1);
}

/** Stores a baseline: apart from the recommendation's persona feedback, next to the baselines of before. */
export function storeBaseline(store: Reads, rec: Pick<Recommendation, 'id' | 'workspaceId'>, reaction: PanelBaseline, agentRunId: string): PanelRead {
  return store.personaPanelReads.insert({
    id: newId('ppr'), workspaceId: rec.workspaceId, recommendationId: rec.id, kind: 'baseline', round: reaction.round ?? 1,
    ...(reaction.textHash !== undefined ? { textHash: reaction.textHash } : {}), agentRunId, reaction, createdAt: new Date().toISOString(),
  });
}

/** Keeps a persona's reaction that a later round is about to replace, so that the earlier round stays readable. */
export function keepEarlierRound(store: Reads, rec: Pick<Recommendation, 'id' | 'workspaceId'>, reaction: PersonaFeedback): PanelRead {
  return store.personaPanelReads.insert({
    id: newId('ppr'), workspaceId: rec.workspaceId, recommendationId: rec.id, kind: 'persona', personaId: reaction.personaId, round: reaction.round ?? 1,
    ...(reaction.textHash !== undefined ? { textHash: reaction.textHash } : {}), reaction, createdAt: new Date().toISOString(),
  });
}

/**
 * Sets `sameAsBaseline` on the current reactions of a recommendation that read the text its latest
 * baseline read. A reaction to another text keeps the mark it has (it was compared with the baseline of
 * its own text, or with none). With no baseline nothing is marked. Returns how many marks changed.
 */
export function markAgainstBaseline(store: Pick<Store, 'personaPanelReads' | 'recommendations' | 'transaction'>, recommendationId: string): number {
  return store.transaction(() => {
    const baseline = latestBaseline(store, recommendationId)?.reaction;
    const rec = store.recommendations.get(recommendationId);
    if (!baseline?.textHash || !rec) return 0;
    let changed = 0;
    const personaFeedback = rec.personaFeedback.map((f) => {
      if (f.textHash !== baseline.textHash) return f;
      const same = sameAsBaseline(f, baseline);
      if (f.sameAsBaseline === same) return f;
      changed++;
      return { ...f, sameAsBaseline: same };
    });
    if (changed) store.recommendations.update(recommendationId, { personaFeedback });
    return changed;
  });
}
