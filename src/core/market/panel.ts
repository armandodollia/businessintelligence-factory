import { existsSync, readFileSync } from 'node:fs';
import type { ToolInput } from '../harness/tools/registry.js';
import { loadPrompt, promptTemplate, renderTemplate, withCalibration } from '../prompts/index.js';
import { recordPromptVersion } from '../prompts/store.js';
import { isOutputUsable } from '../research/outputs.js';
import { recordHarnessDecision, runAgent, throwIfAborted, type PhaseRunner, type ResearchDeps } from '../research/deps.js';
import { calibrationScope } from '../scoring/calibration.js';
import { PERSONA_FEEDBACK_KEYS } from '../scoring/criteria.js';
import { countedReaction } from '../scoring/priority.js';
import type { AboutOthersFlag, Decision, ModelRef, PanelBaseline, Persona, PersonaFeedback, PersonaFeedbackTextField, Recommendation } from '../types.js';
import { segmentPersonas } from '../stakeholders/personas.js';
import { runStakeholderReads, type ReadsReport } from '../stakeholders/reads.js';
import { scopeOf } from '../workspace/tree.js';
import {
  BASELINE_SYSTEM_PROMPT, expectRulings, forgetRulings, keepEarlierRound, latestBaseline, markAgainstBaseline, notRuled, planRead, roundPart,
  storeBaseline, textHashOf, type OpenConcern,
} from './panelRounds.js';
import { panelSettings, seatOf, seatUnavailable, type PanelSeat, type PanelSettings } from './panelSettings.js';
import { writeAgentMd } from './personas.js';

/** Persona runs per (recommendation, persona) that may end without `submit_persona_feedback`. */
export const PANEL_ATTEMPTS = 2;

/** Pseudo run id of the panel's own decisions (a persona whose seat cannot be started has no run). */
export const PANEL_ACTOR = 'persona_panel';

/** A persona that is unavailable for a recommendation (persona panel design §4), with its seat and the cause. */
export type PanelUnavailable = { recommendationId: string; personaId: string; slug: string; seat: PanelSeat & { index: number }; reason: string };

export type PanelReport = {
  /** Feedback entries attached (one per persona per recommendation that answered). */
  feedback: number;
  /** Pairs whose persona never called `submit_persona_feedback` (after retry). */
  missing: Array<{ recommendationId: string; personaId: string; reason: string }>;
  /** The stakeholder reads that follow the segment personas (stakeholder design §10). */
  stakeholderReads?: ReadsReport;
  /**
   * With `personaPanel` configured only: the pairs whose persona was unavailable (its seat cannot be
   * started, or its run gave no answer after the retry: those are in `missing` too). Each is also
   * recorded as a harness Decision `persona_unavailable`.
   */
  unavailable?: PanelUnavailable[];
  /** With `onUnavailable: "fail"` and a persona unavailable: why the panel phase ends as failed. */
  failed?: string;
  /**
   * With `personaPanel` configured only (design §7): the pairs that were not read in this run. `unchanged`:
   * the persona already read this text. `limitReached`: the text changed, but the persona has used up its
   * rounds (`round`: its last one); its reaction to the earlier text stays the current one.
   */
  rounds?: { unchanged: number; limitReached: Array<{ recommendationId: string; personaId: string; slug: string; round: number }> };
  /**
   * With `personaPanel.baseline` on only (design §5): the runs with no persona, by recommendation. `stored`:
   * baselines stored in this run. `unchanged` / `limitReached`: not read, as for a persona. `unavailable`:
   * seat 0 cannot be started, or the run gave no answer after the retry; each is also recorded as a harness
   * Decision `baseline_unavailable`, and the reactions to that text stay unmarked. Never a reason for the
   * phase to fail, and never counted in `feedback`, `missing` or `unavailable`.
   */
  baseline?: {
    stored: number;
    unchanged: number;
    limitReached: string[];
    unavailable: Array<{ recommendationId: string; round: number; seat: PanelSeat & { index: number }; reason: string }>;
  };
};

type FeedbackKey = (typeof PERSONA_FEEDBACK_KEYS)[number];

/** Spread (max − min) at or above which personas are said to disagree on a score. */
export const DISAGREEMENT_SPREAD = 2;

export type PanelSummary = {
  simulated: true;
  /** The reactions the numbers below are of. */
  n: number;
  /**
   * The reactions left out of every number below: those marked as saying what the run with no persona
   * said (`sameAsBaseline`), which are not counted as agreement. 0 unless `personaPanel` is configured.
   */
  leftOut: number;
  scores: Record<FeedbackKey, { mean: number; min: number; max: number; spread: number }>;
  /** Score keys where personas disagree (spread ≥ DISAGREEMENT_SPREAD). */
  disagreement: FeedbackKey[];
  /** Mean of each score per audience (external / internal), when personas are given. */
  byAudience: Partial<Record<'external' | 'internal', Record<FeedbackKey, number>>>;
};

const round2 = (n: number) => Math.round(n * 100) / 100;
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

/**
 * Panel summary of a recommendation's (simulated) persona feedback: mean/min/max/spread per score,
 * the scores where segments disagree, and per-audience means. A reaction that adds nothing beyond a
 * general reader (`sameAsBaseline`) is in none of these numbers; `leftOut` says how many were.
 */
export function panelSummary(rec: Pick<Recommendation, 'personaFeedback'>, personas: Persona[] = []): PanelSummary {
  const all = rec.personaFeedback ?? [];
  const fb = all.filter(countedReaction);
  const scores = {} as PanelSummary['scores'];
  const disagreement: FeedbackKey[] = [];
  for (const k of PERSONA_FEEDBACK_KEYS) {
    const xs = fb.map((f) => f.scores[k]);
    const min = xs.length ? Math.min(...xs) : 0;
    const max = xs.length ? Math.max(...xs) : 0;
    scores[k] = { mean: round2(mean(xs)), min, max, spread: max - min };
    if (max - min >= DISAGREEMENT_SPREAD) disagreement.push(k);
  }
  const byAudience: PanelSummary['byAudience'] = {};
  const audienceOf = new Map(personas.map((p) => [p.id, p.audience ?? 'external']));
  for (const a of ['external', 'internal'] as const) {
    const group = fb.filter((f) => audienceOf.get(f.personaId) === a);
    if (!group.length) continue;
    byAudience[a] = Object.fromEntries(
      PERSONA_FEEDBACK_KEYS.map((k) => [k, round2(mean(group.map((f) => f.scores[k])))]),
    ) as Record<FeedbackKey, number>;
  }
  return { simulated: true, n: fb.length, leftOut: all.length - fb.length, scores, disagreement, byAudience };
}

/** The agent.md system prompt of a persona; recompiled (and rewritten) when the file is missing. */
export function agentMdOf(deps: ResearchDeps, persona: Persona): string {
  if (persona.agentMdPath && existsSync(persona.agentMdPath)) return readFileSync(persona.agentMdPath, 'utf8');
  return writeAgentMd(deps.store, persona);
}

function panelPrompt(template: string, rec: Recommendation, scope: string): string {
  return renderTemplate(template, {
    recommendation_id: rec.id,
    title: rec.title,
    summary: rec.summary,
    scope,
  });
}

/** Last valid `submit_persona_feedback` decision of a run for `recId` (written by the dispatcher). */
function feedbackOfRun(
  deps: ResearchDeps,
  agentRunId: string,
  recId: string,
): { decision: Decision; input: ToolInput<'submit_persona_feedback'> } | undefined {
  const ds = deps.store.decisions.list({ agentRunId, kind: 'persona_feedback' });
  for (let i = ds.length - 1; i >= 0; i--) {
    const p = ds[i]!.payload as { tool?: string; input?: ToolInput<'submit_persona_feedback'> } | null;
    if (p?.tool === 'submit_persona_feedback' && p.input?.recommendation_id === recId) return { decision: ds[i]!, input: p.input };
  }
  return undefined;
}

/**
 * Stamps the originating persona on EVERY persona_feedback Decision of a panel run (`payload.personaId`,
 * `payload.targetId = <recId>:<personaId>` from the decision's own recommendation, refs += rec +
 * persona) — including repeated or off-target submissions — so ratings of that feedback join exactly
 * the right decisions in the training export and no decision is left without its persona.
 */
function stampPersona(deps: ResearchDeps, agentRunId: string, personaId: string): void {
  for (const d of deps.store.decisions.list({ agentRunId, kind: 'persona_feedback' })) {
    const p = (d.payload ?? {}) as Record<string, unknown>;
    const recId = (p.input as { recommendation_id?: unknown } | undefined)?.recommendation_id;
    if (typeof recId !== 'string') continue;
    const payload = { ...p, personaId, targetId: `${recId}:${personaId}` };
    deps.store.decisions.update(d.id, { payload, refs: [...new Set([...d.refs, recId, personaId])] });
  }
}

/** The fields every reaction has, as the tool call gave them. */
function answerOf(input: ToolInput<'submit_persona_feedback'>): Omit<PersonaFeedback, 'personaId'> {
  return {
    scores: {
      appeal: input.scores.appeal,
      adoption: input.scores.adoption,
      willingnessToPay: input.scores.willingness_to_pay,
      friction: input.scores.friction,
    },
    concerns: input.concerns,
    reasoning: input.reasoning,
    wouldChangeMind: input.would_change_mind,
    simulated: true,
  };
}

function toFeedback(personaId: string, input: ToolInput<'submit_persona_feedback'>): PersonaFeedback {
  return { personaId, ...answerOf(input) };
}

// --- "no numbers about other people" (persona panel design §6) -----------------------------------
// A simple pattern check, sentence by sentence. A sentence is flagged when it has
//   1. a share next to a group of people: a percentage ("40%", "12.5 percent") or "N out of M" / "N in M",
//      and a group noun in the same sentence ("40% of customers", "9 out of 10 buyers");
//   2. most / many / all / the majority of a group: the quantifier, then at most "of", a determiner and
//      one more word, then the group noun ("most people like me", "many of our users", "all small-business buyers");
//   3. a market size: "market" (or TAM / SAM / SOM) and a sized number in the same sentence: an amount of
//      money, a number with k / m / bn / million / billion / trillion, or a percentage ("a $4 billion market").
// What is not flagged: a percentage or a score with no group noun ("I would pay 20% more", "2 out of 5 for
// appeal"), a quantifier of something else ("most of my time"), "market" without a number.

/** Nouns for a group of other people. */
const GROUP = '(?:people|customers|users|buyers|clients|consumers|shoppers|subscribers|companies|businesses|firms|teams|colleagues|peers)';
const COUNT = '(?:\\d+|one|two|three|four|five|six|seven|eight|nine|ten)';
const PERCENT = '\\d+(?:[.,]\\d+)?\\s?(?:%|percent\\b|per\\s+cent\\b)';
const HAS_GROUP = new RegExp(`\\b${GROUP}\\b`, 'i');
const SHARE = new RegExp(`${PERCENT}|\\b${COUNT}\\s+(?:out\\s+of|in)\\s+${COUNT}\\b`, 'i');
const QUANTIFIED_GROUP = new RegExp(
  `\\b(?:most|many|all|(?:the|a)\\s+majority\\s+of)\\s+(?:of\\s+)?(?:(?:the|our|my|your|their|these|those|other)\\s+)?(?:[a-z][a-z-]*\\s+)?${GROUP}\\b`,
  'i',
);
const MARKET = /\b(?:[Mm]arkets?|TAM|SAM|SOM)\b/;
const SIZED_NUMBER = new RegExp(`[$€£]\\s?\\d|\\d[\\d.,]*\\s?(?:k|m|bn|million|billion|trillion)\\b|${PERCENT}`, 'i');

const ABOUT_OTHERS: Array<{ reason: string; hits: (sentence: string) => boolean }> = [
  { reason: 'a share of other people', hits: (s) => SHARE.test(s) && HAS_GROUP.test(s) },
  { reason: 'a claim about most, many or all of a group', hits: (s) => QUANTIFIED_GROUP.test(s) },
  { reason: 'a market size', hits: (s) => MARKET.test(s) && SIZED_NUMBER.test(s) },
];

/**
 * The sentences of `text` that make a claim about other people in numbers, each once, with the rule it
 * hit first (see the list above). `text` of a hit is the sentence as it stands in the text.
 */
export function aboutOthers(text: string): Array<{ text: string; reason: string }> {
  const out: Array<{ text: string; reason: string }> = [];
  for (const sentence of text.split(/(?<=[.!?])\s+|\n+/).map((s) => s.trim())) {
    const rule = sentence ? ABOUT_OTHERS.find((r) => r.hits(sentence)) : undefined;
    if (rule) out.push({ text: sentence, reason: rule.reason });
  }
  return out;
}

/**
 * Every flagged passage of a reaction, with the field (and the item of a list field) it is in. Every
 * free text of the reaction that the page shows is checked: the concerns and what each rests on, the
 * reasoning, what would change its mind, the other side, another route, what it is unsure about, the
 * reason of each ruling, and its earlier concerns as listed to it with what each rested on (a carried
 * concern is checked as it is listed, so one that was flagged when it was raised is flagged here too).
 */
function aboutOthersFlags(fb: PanelBaseline): AboutOthersFlag[] {
  const out: AboutOthersFlag[] = [];
  const check = (field: PersonaFeedbackTextField, value: string | null | undefined, index?: number) => {
    for (const hit of aboutOthers(value ?? '')) out.push({ field, ...(index !== undefined ? { index } : {}), ...hit });
  };
  fb.concerns.forEach((c, i) => check('concerns', c, i));
  fb.concernBasis?.forEach((b, i) => check('concernBasis', b, i));
  check('reasoning', fb.reasoning);
  check('wouldChangeMind', fb.wouldChangeMind);
  check('otherSide', fb.otherSide);
  check('instead', fb.instead);
  fb.unsure?.forEach((u, i) => check('unsure', u, i));
  fb.rulings?.forEach((r, i) => check('rulings', r.reason, i));
  fb.earlierConcerns?.forEach((c, i) => check('earlierConcerns', c, i));
  fb.earlierConcernBasis?.forEach((b, i) => check('earlierConcernBasis', b, i));
  return out;
}

/** What a read of a configured panel was of: its round, the text read (with its hash) and, from round 2, the reader's earlier concerns as listed to it. */
type ReadOf = { round: number; textHash: string; textRead: { title: string; summary: string }; listed: OpenConcern[] };

/**
 * A reaction of a configured panel (design §6, §7, §9), of a persona or of the baseline: today's fields,
 * the seat, the new answer fields, the basis of each concern (a concern without one is ungrounded), the
 * flags on claims about other people, the round, the text read with its hash and, from round 2, the
 * concerns that were listed, each with the basis it was raised with, and the numbers of those left
 * without a ruling. Nothing the reader wrote is deleted. `rulings` are stored as sent: the tool refused
 * any that was not about a listed concern.
 */
function panelReaction(input: ToolInput<'submit_persona_feedback'>, seat: PanelSeat, of: ReadOf): PanelBaseline {
  const concernBasis = input.concerns.map((_, i) => input.concern_basis?.[i]?.trim() ?? '');
  const unsure = input.unsure?.filter((u) => u.trim()) ?? [];
  const reaction: PanelBaseline = {
    ...answerOf(input),
    seat: { provider: seat.provider, model: seat.model, ...(seat.effort !== undefined ? { effort: seat.effort } : {}) },
    concernBasis,
    ungrounded: concernBasis.flatMap((basis, i) => (basis ? [] : [i])),
    ...(input.other_side?.trim() ? { otherSide: input.other_side } : {}),
    ...(input.instead?.trim() ? { instead: input.instead } : {}),
    ...(unsure.length ? { unsure } : {}),
    ...(input.rulings?.length ? { rulings: input.rulings } : {}),
    round: of.round,
    textHash: of.textHash,
    textRead: of.textRead,
    ...(of.listed.length
      ? { earlierConcerns: of.listed.map((c) => c.text), earlierConcernBasis: of.listed.map((c) => c.basis), notRuled: notRuled(of.listed.length, input.rulings) }
      : {}),
  };
  return { ...reaction, aboutOthers: aboutOthersFlags(reaction) };
}

/** Why the panel phase ends as failed under `onUnavailable: "fail"`: each persona, its seat, the recommendations and the cause. */
function panelFailure(unavailable: PanelUnavailable[]): string {
  const groups = new Map<string, { who: string; recs: string[]; reason: string }>();
  for (const u of unavailable) {
    const who = `persona '${u.slug}' on seat ${u.seat.index} (${u.seat.provider}/${u.seat.model})`;
    const group = groups.get(`${who}\n${u.reason}`) ?? { who, recs: [], reason: u.reason };
    group.recs.push(u.recommendationId);
    groups.set(`${who}\n${u.reason}`, group);
  }
  const named = [...groups.values()].map((g) => `${g.who} is unavailable for ${g.recs.join(', ')}: ${g.reason}`);
  return `persona panel failed (personaPanel.onUnavailable: fail): ${named.join('; ')}`;
}

/**
 * Replaces this persona's entry in the recommendation's feedback (re-read first: runs finish concurrently).
 * `keepEarlier` (a configured panel): the reaction it replaces is kept as an earlier round (`keepEarlierRound`).
 */
function attach(deps: ResearchDeps, recId: string, fb: PersonaFeedback, keepEarlier = false): void {
  const { store } = deps;
  store.transaction(() => {
    const cur = store.recommendations.get(recId);
    if (!cur) return;
    const all = cur.personaFeedback ?? [];
    if (keepEarlier) for (const earlier of all.filter((f) => f.personaId === fb.personaId)) keepEarlierRound(store, cur, earlier);
    store.recommendations.update(recId, { personaFeedback: [...all.filter((f) => f.personaId !== fb.personaId), fb] });
  });
}

/**
 * Marks every `persona_feedback` Decision of a baseline run as the baseline's (`payload.baseline: true`,
 * refs += the recommendation). It names no persona and no rating target (`personaId`, `targetId`): it is
 * simulated persona output that belongs to no persona, so nothing that reads a persona's reactions by
 * those reads it as one.
 */
function stampBaseline(deps: ResearchDeps, agentRunId: string): void {
  for (const d of deps.store.decisions.list({ agentRunId, kind: 'persona_feedback' })) {
    const p = (d.payload ?? {}) as Record<string, unknown>;
    const recId = (p.input as { recommendation_id?: unknown } | undefined)?.recommendation_id;
    if (typeof recId !== 'string') continue;
    deps.store.decisions.update(d.id, { payload: { ...p, baseline: true }, refs: [...new Set([...d.refs, recId])] });
  }
}

/**
 * Persona panel (spec §8b.4): every usable recommendation of the workspace (verified, or included by
 * the user; never superseded) is put to each usable persona (same rule)
 * independently — one `persona` run per pair, system prompt = the persona's agent.md, user prompt =
 * `persona_panel.md`. The run must call `submit_persona_feedback` (the dispatcher logs the
 * `persona_feedback` Decision); its feedback is attached to `Recommendation.personaFeedback` with
 * `simulated: true`, replacing that persona's earlier feedback. A run without feedback is retried
 * once, then logged as a harness Decision and skipped. Then the stakeholder reads run
 * (`runStakeholderReads`, stakeholder design §10), with or without segment personas. Usable as the
 * `persona_panel` phase runner.
 *
 * With `personaPanel` configured (persona panel design 2026-11-16 §3 to §7; without it nothing below applies):
 * - rounds: a persona reads a recommendation only when it has no reaction to its text as it is now
 *   (`planRead`): never the same text twice, and a changed text at most `rounds` times (`PanelReport.rounds`
 *   says what was not read). From round 2 the prompt ends with `persona_panel_round.md`: the text the
 *   persona read before and the text as it stands now, both fenced as data, and the persona's own open
 *   concerns to rule on. The new reaction replaces the current one; the earlier round is kept
 *   (`panelHistory`). A read without an answer is not a round;
 * - each persona runs on its seat (`seatOf`: model and effort) and on no other. A persona that has
 *   something to read and whose seat cannot be started is not run; it, and a persona whose run gave no
 *   answer after the retry, is unavailable for the recommendation: reported (`PanelReport.unavailable`)
 *   and recorded as a Decision `persona_unavailable`;
 * - under `onUnavailable: "report"` that is all. Under `"fail"` every persona that can run still runs and
 *   its reactions are stored and kept, the stakeholder reads run as always, and the report then says why
 *   the phase failed (`PanelReport.failed`; the phase runner throws it);
 * - the panel prompt is followed by the persona rules (`persona_panel_rules.md`), and the reaction is
 *   stored with its round, the text read and its hash, its seat, the new answer fields, its ungrounded
 *   concerns, its `aboutOthers` flags and, from round 2, its earlier concerns as listed, each with the
 *   basis it was raised with;
 * - the baseline (`baseline` on): each recommendation is also read by a run with no persona, on seat 0,
 *   by the same rule of rounds, with the same prompt and tool. Its answer is stored apart
 *   (`persona_panel_reads`), never as a persona's feedback, and the reactions to the same text are marked
 *   `sameAsBaseline` or not. A baseline that cannot be had is reported (`PanelReport.baseline`) and
 *   nothing is marked.
 */
export async function runPersonaPanel(workspaceId: string, deps: ResearchDeps): Promise<PanelReport> {
  const { store } = deps;
  const settings = panelSettings(deps.config);
  const report: PanelReport = {
    feedback: 0,
    missing: [],
    ...(settings ? { unavailable: [], rounds: { unchanged: 0, limitReached: [] } } : {}),
    ...(settings?.baseline ? { baseline: { stored: 0, unchanged: 0, limitReached: [], unavailable: [] } } : {}),
  };
  const ws = store.workspaces.get(workspaceId);
  const scope = ws ? scopeOf(ws).name : workspaceId;
  // Only reviewed outputs go to the panel (spec §7.2): verified, or included by the user.
  // Audience segments only: stakeholder personas give stakeholder reads instead (stakeholder design §10).
  const personas = segmentPersonas(store, workspaceId).filter(isOutputUsable);
  const recs = store.recommendations.list({ workspaceId }).filter(isOutputUsable);
  if (personas.length && recs.length) await segmentPanel(workspaceId, deps, personas, recs, scope, report, settings);
  // Then each open stakeholder persona reads each recommendation (stakeholder design §10).
  report.stakeholderReads = await runStakeholderReads(workspaceId, deps);
  return report;
}

/** A seat of a configured panel with its index: a persona's (`seatOf`), or seat 0 for the baseline. */
type Seated = { index: number; seat: PanelSeat };

/** Who reads: a persona with its agent.md, or nobody (the baseline) with the neutral system prompt. */
type Reader = { persona?: Persona; systemPrompt: string; model: ModelRef; effort?: string };

/**
 * What is read: the prompt, the template it was rendered from (the prompt version is of the system
 * prompt and this), the round and, in a configured panel, how many earlier concerns the prompt lists.
 */
type Read = { prompt: string; template: string; round: number; listed?: number };

type Answer = { input: ToolInput<'submit_persona_feedback'>; agentRunId: string };
type NoAnswer = { reason: string; agentRunId: string; promptVersion: string };

/** The segment personas' feedback on every recommendation (one run per pair, concurrently), and the baselines of a configured panel. */
async function segmentPanel(
  workspaceId: string,
  deps: ResearchDeps,
  personas: Persona[],
  recs: Recommendation[],
  scope: string,
  report: PanelReport,
  /** The configured panel; `undefined`: the panel of before (every persona on `roles.persona`, every pair read on every run, the prompt and the feedback of before). */
  settings: PanelSettings | undefined,
): Promise<void> {
  const { store, config } = deps;
  const template = loadPrompt('persona_panel');
  // Configured: the persona rules follow the panel prompt (so it has another version). Not configured: the text of before.
  const text = settings ? `${template.text.trimEnd()}\n\n${promptTemplate('persona_panel_rules')}` : template.text;
  const unavailable = report.unavailable ?? [];
  const seatOfRun = ({ index, seat: { provider, model, effort } }: Seated) => ({ index, provider, model, ...(effort !== undefined ? { effort } : {}) });

  /**
   * Reports and records the pair as unavailable. `run`: the last run that gave no answer (none: the seat
   * cannot be started). The record names the recommendation and the persona as `recommendation` and
   * `persona` and carries no refs: it is no judgment of either, so the export must not read it as one
   * or join their ratings to it (the keys `recommendationId` / `personaId`, or a ref, would do that).
   * It says which read it was (`round`, and `textHash` of the text that was to be read), so the page can
   * tell whether it is still the last word on the text as it is now (`panelViews`).
   */
  const markUnavailable = (rec: Recommendation, persona: Persona, seated: Seated, round: number, reason: string, run?: { agentRunId: string; promptVersion: string }): void => {
    const seat = seatOfRun(seated);
    unavailable.push({ recommendationId: rec.id, personaId: persona.id, slug: persona.slug, seat, reason });
    recordHarnessDecision(
      store,
      { agentRunId: run?.agentRunId ?? PANEL_ACTOR, workspaceId, role: 'persona', model: { provider: seat.provider, model: seat.model }, promptVersion: run?.promptVersion ?? 'n/a' },
      'decision',
      { event: 'persona_unavailable', recommendation: rec.id, persona: persona.id, slug: persona.slug, round, textHash: textHashOf(rec), seat, reason },
      [],
    );
  };

  /**
   * Reports and records that a recommendation has no baseline of its text. The record names the
   * recommendation as `recommendation` and carries no refs, as a persona's does: nothing may read it as
   * a judgment of the recommendation, or join the recommendation's ratings to it.
   */
  const baselineUnavailable = (rec: Recommendation, seated: Seated, round: number, reason: string, run?: { agentRunId: string; promptVersion: string }): void => {
    const seat = seatOfRun(seated);
    report.baseline?.unavailable.push({ recommendationId: rec.id, round, seat, reason });
    recordHarnessDecision(
      store,
      { agentRunId: run?.agentRunId ?? PANEL_ACTOR, workspaceId, role: 'persona', model: { provider: seat.provider, model: seat.model }, promptVersion: run?.promptVersion ?? 'n/a' },
      'decision',
      { event: 'baseline_unavailable', baseline: true, recommendation: rec.id, round, textHash: textHashOf(rec), seat, reason },
      [],
    );
  };

  /** One read of `rec`: the run and its one retry, on the reader's model and no other. The answer, or why there is none. */
  const ask = async (rec: Recommendation, reader: Reader, read: Read): Promise<Answer | NoAnswer> => {
    const { persona, systemPrompt, model, effort } = reader;
    // promptVersion(system + template), with its exact text kept in the prompt store (learning loop WP-B).
    const version = recordPromptVersion(deps.store, 'persona', `${systemPrompt}\n${read.template}`);
    let reason = 'no submit_persona_feedback call';
    let lastRun = '';
    for (let attempt = 1; attempt <= PANEL_ATTEMPTS; attempt++) {
      throwIfAborted(deps.signal);
      const request = {
        kind: 'work', role: 'persona', workspaceId, round: read.round, attempt, prompt: read.prompt, systemPrompt,
        model, needsBrowser: false, promptVersion: version, ...(effort !== undefined ? { effort } : {}),
      } as const;
      let outcome: Awaited<ReturnType<typeof runAgent>>;
      if (read.listed === undefined) outcome = await runAgent(deps, request);
      else {
        // A configured panel: the tool is told how many concerns the prompt lists, to check the rulings against.
        const listed = read.listed;
        let started: string | undefined;
        try {
          outcome = await runAgent(deps, {
            ...request,
            onStart: (ctx) => {
              started = ctx.agentRunId;
              expectRulings(started, listed);
            },
          });
        } finally {
          if (started !== undefined) forgetRulings(started);
        }
      }
      lastRun = outcome.agentRunId;
      if (persona) stampPersona(deps, outcome.agentRunId, persona.id);
      else stampBaseline(deps, outcome.agentRunId);
      throwIfAborted(deps.signal);
      const found = feedbackOfRun(deps, outcome.agentRunId, rec.id);
      if (found) return { input: found.input, agentRunId: outcome.agentRunId };
      reason = outcome.status === 'failed' ? `run failed: ${outcome.reason ?? `exit ${outcome.exitCode}`}` : 'no submit_persona_feedback call';
      if (!persona) continue;
      recordHarnessDecision(
        store,
        { agentRunId: outcome.agentRunId, workspaceId, role: 'persona', model, promptVersion: version },
        'decision',
        { event: 'persona_feedback_missing', recommendationId: rec.id, personaId: persona.id, attempt, reason, willRetry: attempt < PANEL_ATTEMPTS },
        [rec.id, persona.id],
      );
    }
    return { reason, agentRunId: lastRun, promptVersion: version };
  };

  /** The panel of before: the pair is read, whatever was read before. */
  const readAsBefore = async (rec: Recommendation, persona: Persona, systemPrompt: string): Promise<void> => {
    const got = await ask(rec, { persona, systemPrompt, model: config.roles.persona }, { prompt: panelPrompt(text, rec, scope), template: text, round: 1 });
    if ('input' in got) {
      attach(deps, rec.id, toFeedback(persona.id, got.input));
      report.feedback++;
    } else report.missing.push({ recommendationId: rec.id, personaId: persona.id, reason: got.reason });
  };

  const roundTemplate = settings ? promptTemplate('persona_panel_round') : '';
  /**
   * A read in a configured panel: the panel prompt with the rules and, from round 2, the round part made
   * of `last`, the reader's own current reaction (and of nothing else); and what the read is of.
   */
  const roundRead = (rec: Recommendation, round: number, last: PanelBaseline | undefined): { read: Read; of: ReadOf } => {
    const prompt = panelPrompt(text, rec, scope);
    const part = last ? roundPart(roundTemplate, round, last, rec) : undefined;
    const of: ReadOf = { round, textHash: textHashOf(rec), textRead: { title: rec.title, summary: rec.summary }, listed: part?.listed ?? [] };
    if (!part) return { read: { prompt, template: text, round, listed: 0 }, of };
    return { read: { prompt: `${prompt.trimEnd()}\n\n${part.text}`, template: `${text.trimEnd()}\n\n${roundTemplate}`, round, listed: of.listed.length }, of };
  };
  const seatedReader = (seated: Seated, systemPrompt: string, persona?: Persona): Reader => ({
    ...(persona ? { persona } : {}), systemPrompt, model: { provider: seated.seat.provider, model: seated.seat.model },
    ...(seated.seat.effort !== undefined ? { effort: seated.seat.effort } : {}),
  });

  /** A persona's read in a configured panel: round `round`, after its current reaction `last` (none in round 1). */
  const readRound = async (rec: Recommendation, persona: Persona, systemPrompt: string, seated: Seated, round: number, last: PersonaFeedback | undefined): Promise<void> => {
    const { read, of } = roundRead(rec, round, last);
    const got = await ask(rec, seatedReader(seated, systemPrompt, persona), read);
    if ('input' in got) {
      attach(deps, rec.id, { personaId: persona.id, ...panelReaction(got.input, seated.seat, of) }, true);
      report.feedback++;
      return;
    }
    report.missing.push({ recommendationId: rec.id, personaId: persona.id, reason: got.reason });
    // The retry was on the same seat; the persona is never tried on another (persona panel design §4).
    markUnavailable(rec, persona, seated, round, got.reason, got);
  };

  /** The baseline's read: as a persona's, with no persona. Its answer is stored apart, and counted nowhere as a reaction. */
  const readBaseline = async (rec: Recommendation, seated: Seated, round: number, last: PanelBaseline | undefined): Promise<void> => {
    const { read, of } = roundRead(rec, round, last);
    const got = await ask(rec, seatedReader(seated, BASELINE_SYSTEM_PROMPT), read);
    if (!('input' in got)) return baselineUnavailable(rec, seated, round, got.reason, got);
    storeBaseline(store, rec, panelReaction(got.input, seated.seat, of), got.agentRunId);
    if (report.baseline) report.baseline.stored++;
  };

  const jobs: Array<Promise<void>> = [];
  for (const persona of personas) {
    // This business's approved persona calibration (calibration/persona.md) goes after every persona's agent.md.
    const systemPrompt = () => withCalibration(agentMdOf(deps, persona), 'persona', calibrationScope(store, config, workspaceId));
    if (!settings) {
      const own = systemPrompt();
      for (const rec of recs) jobs.push(readAsBefore(rec, persona, own));
      continue;
    }
    const seated = seatOf(settings, personas, persona);
    const cannotStart = seatUnavailable(config, seated.seat);
    let own: string | undefined;
    for (const rec of recs) {
      const last = rec.personaFeedback?.find((f) => f.personaId === persona.id);
      const plan = planRead(settings, textHashOf(rec), last);
      if (!plan.read) {
        if (plan.why === 'unchanged') report.rounds!.unchanged++;
        else report.rounds!.limitReached.push({ recommendationId: rec.id, personaId: persona.id, slug: persona.slug, round: plan.round });
      } else if (cannotStart !== undefined) markUnavailable(rec, persona, seated, plan.round, cannotStart);
      else jobs.push(readRound(rec, persona, (own ??= systemPrompt()), seated, plan.round, last));
    }
  }
  if (settings?.baseline && report.baseline) {
    // The run with no persona: on seat 0, and on no other when that seat cannot be started.
    const seated: Seated = { index: 0, seat: settings.seats[0]! };
    const cannotStart = seatUnavailable(config, seated.seat);
    for (const rec of recs) {
      const last = latestBaseline(store, rec.id)?.reaction;
      const plan = planRead(settings, textHashOf(rec), last);
      if (!plan.read) {
        if (plan.why === 'unchanged') report.baseline.unchanged++;
        else report.baseline.limitReached.push(rec.id);
      } else if (cannotStart !== undefined) baselineUnavailable(rec, seated, plan.round, cannotStart);
      else jobs.push(readBaseline(rec, seated, plan.round, last));
    }
  }
  const results = await Promise.allSettled(jobs);
  const err = results.find((r): r is PromiseRejectedResult => r.status === 'rejected');
  if (err) throw err.reason;
  // Every read is in: each reaction to the text a baseline read is compared with that baseline.
  if (settings?.baseline) for (const rec of recs) markAgainstBaseline(store, rec.id);
  if (settings?.onUnavailable === 'fail' && unavailable.length) report.failed = panelFailure(unavailable);
}

/**
 * `runPersonaPanel` as the `persona_panel` phase runner: `phaseRunners: { persona_panel: personaPanelRunner }`.
 * A panel that failed (`PanelReport.failed`) fails the phase with that reason; what it stored is kept.
 */
export const personaPanelRunner: PhaseRunner = async (workspaceId, deps) => {
  const report = await runPersonaPanel(workspaceId, deps);
  if (report.failed !== undefined) throw new Error(report.failed);
};
