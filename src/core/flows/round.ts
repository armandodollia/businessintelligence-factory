/**
 * The ranking round (design 2026-11-14-flow-records-and-ranking-design.md §10.2, §12.1, §14): the
 * `flow_ranking` phase runner. First, the node's rulings whose flows have a new version are marked
 * as needing the user's confirmation (`refreshOverrides`). Per active flow type with at least two
 * rankable flows of the node:
 *
 * 1. Review-answered checks are brought up to date (`applyReviewChecks`).
 * 2. Stage 1, broad: each usable persona of the node judges the pairs it has no live verdict on, in
 *    sittings (`sittings`) over the flows in an order shuffled by a seed derived from the persona id
 *    (stable across rounds). One persona run per sitting; pairs still missing are asked once more,
 *    then reported as not judged.
 * 3. Stage 2, focused (after stage 1 of every type): the pairs `focusedPairs` selects from each
 *    type's ranking (including the user's disagreements on live verdicts, `disagreedPairs`), at most
 *    `maxFocusedComparisons` per round, taken across types in turn
 *    (`pickFocused`); one run per pair. The rest are not narrowed.
 * 4. A snapshot of every ranked flow type (`snapshotRankings`), and one harness Decision
 *    (`flow_ranking_round`) with the round's report and the pairs left not narrowed.
 *
 * Persona runs are ordinary `persona` runs (like the panel): the persona's agent.md (with the tree's
 * calibration) as system prompt, no browser, no task. The persona answers through
 * `submit_flow_verdicts`; the dispatcher logs that call as a `flow_verdicts` Decision, which the round
 * reads back and stores with `recordVerdicts` (simulated, as every verdict). Each flow is shown under
 * its id, its third-party text (steps, notes, review quotes) inside `fenceEvidence`, never with its
 * checklist score. Every run logs one prompt read listing the flows (and mentions and step
 * artifacts) it was shown, so a run shown upload-derived text is upload-exposed. Runs of different
 * personas go concurrently; a failed run never fails the round: a persona job that throws (its
 * agent.md cannot be built, a run rejects) is recorded as a `flow_verdicts_failed` harness Decision
 * and its pairs left are reported as not judged.
 */
import { createHash } from 'node:crypto';
import { AbortError } from '../events.js';
import type { ExtraToolHandler } from '../harness/tools/handlers.js';
import type { ToolInput, ToolName } from '../harness/tools/registry.js';
import { estimateTokens } from '../knowledge/extract/normalize.js';
import type { PromptRead } from '../knowledge/promptReads.js';
import { itemIsUploadDerived } from '../knowledge/provenance.js';
import { fenceEvidence, redactServed, stripFences } from '../knowledge/trust.js';
import { agentMdOf } from '../market/panel.js';
import { panelSettings, seatOf, seatUnavailable } from '../market/panelSettings.js';
import { promptTemplate, renderTemplate, withCalibration } from '../prompts/index.js';
import { recordPromptVersion } from '../prompts/store.js';
import { recordHarnessDecision, runAgent, throwIfAborted, type PhaseRunner, type ResearchDeps } from '../research/deps.js';
import { isOutputUsable } from '../research/outputs.js';
import { calibrationScope } from '../scoring/calibration.js';
import type { Store } from '../store/db.js';
import { segmentPersonas } from '../stakeholders/personas.js';
import type { ModelRef, Persona, RetrievalResultRef } from '../types.js';
import { rootOf } from '../workspace/tree.js';
import { activeChecklists, flowTypeByKey, listFlowTypes } from './catalog.js';
import { applyReviewChecks, flowChecks } from './checks.js';
import { flowsSettings, type FlowsSettings } from './config.js';
import { disagreedPairs, refreshOverrides } from './feedback.js';
import { flowSteps, rankableFlows } from './flows.js';
import { nodeRanking, snapshotRankings } from './rankings.js';
import { flowRepos } from './repos.js';
import { reviewDigest } from './reviews.js';
import type { Flow, FlowCheck, FlowType, StopReason } from './types.js';
import { focusedPairs, liveVerdicts, missingPairs, recordVerdicts, sittings, type FocusReason, type VerdictInput } from './verdicts.js';

export type RoundReport = {
  /** Flow types judged (active, with at least two rankable flows). */
  flowTypes: number;
  /** Stage 1 persona runs (retries included). */
  sittings: number;
  /** Stage 2 persona runs. */
  focused: number;
  /** Verdicts stored (both stages). */
  verdicts: number;
  /** Pairs a persona left unjudged after the retry. */
  notJudged: Array<{ flowTypeId: string; personaId: string; pairs: number }>;
  /** Pairs selected for a focused run that the per-round cap left out. */
  notNarrowed: number;
};

/** Stage 1 runs per sitting group: the first ask, then one retry for the pairs still missing. */
export const BROAD_ATTEMPTS = 2;
/** Review quotes shown per flow, by detail; negative ones first. */
export const BRIEF_QUOTES = { broad: 5, focused: 12 } as const;
/** Longest review quote shown. */
export const BRIEF_QUOTE_MAX_CHARS = 300;
/** Longest step field (action, observation, error) shown, by detail. */
const STEP_TEXT_MAX = { broad: 300, focused: 1200 } as const;
const NOTE_MAX = { broad: 400, focused: 1200 } as const;

const STOP_TEXT: Record<StopReason, string> = {
  payment: 'payment details were required',
  phone: 'a phone number was required',
  kyc: 'an identity check was required',
  captcha: 'a captcha could not be passed',
  approval_needed: 'an approval was needed',
  error: 'an error blocked the way',
  not_found: 'the flow could not be found',
};

/** What a brief carries besides its text: the records shown, for the run's prompt read. */
type Brief = { label: string; text: string; shown: RetrievalResultRef[]; uploadDerived: boolean };

/** `text` on one line, cut to `max` characters (after redaction, so no partial secret is left). */
const cut = (text: string, max: number): string => {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
};

/** An audience-dependent answer as text. */
function answerText(c: FlowCheck): string {
  if (c.value !== undefined && c.value !== null) return typeof c.value === 'string' ? c.value : JSON.stringify(c.value);
  return c.answer === 'na' ? 'not applicable' : c.answer === 'no_signal' ? 'no signal' : c.answer.replace(/_/g, ' ');
}

function briefOf(store: Store, workspaceId: string, flow: Flow, detail: 'broad' | 'focused', settings: FlowsSettings): Brief {
  const r = flowRepos(store);
  const steps = flowSteps(store, flow.id);
  const { general, specific } = activeChecklists(store, workspaceId, flow.flowTypeId);
  const rows = flowChecks(store, flow.id);
  /** Audience-dependent (unscored) items of each list, answered on that list's rows. */
  const answers = (specific ? [general, specific] : [general]).flatMap((c) =>
    c.items.flatMap((item) => {
      if (item.scored) return [];
      const row = rows.find((x) => x.checklistId === c.id && x.itemKey === item.key);
      return row ? [{ question: item.question, answer: answerText(row), note: row.note, mentionRefs: row.mentionRefs }] : [];
    }),
  );
  const digest = reviewDigest(store, flow, settings);
  const quotes = [...digest.quotes.filter((q) => q.polarity === 'negative'), ...digest.quotes.filter((q) => q.polarity !== 'negative')].slice(
    0,
    BRIEF_QUOTES[detail],
  );

  // Third-party text, redacted as a whole before any cut, then fence-stripped.
  const red = redactServed(store, workspaceId, {
    name: flow.name,
    variant: flow.variant,
    goal: flow.goal,
    notable: flow.notable ?? '',
    steps: steps.map((s) => ({ action: s.action, observation: s.observation, asked: s.asked, error: s.error ?? '' })),
    answers,
    quotes: quotes.map((q) => q.quote),
  });
  const clean = (s: string | undefined, max: number) => cut(stripFences(s ?? ''), max);
  const stepMax = STEP_TEXT_MAX[detail];

  const lines: string[] = [];
  lines.push(`Flow: ${clean(red.name, 200)} (variant: ${clean(red.variant, 100)})`);
  lines.push(`Goal: ${clean(red.goal, 400)}`);
  lines.push(flow.reachedGoal ? 'Reached the goal: yes' : `Reached the goal: no (partial: stopped where ${STOP_TEXT[flow.stopReason ?? 'error']})`);
  lines.push(`Steps (${red.steps.length}):`);
  red.steps.forEach((s, i) => {
    lines.push(`${i + 1}. Did: ${clean(s.action, stepMax)}`);
    if (s.observation) lines.push(`   Saw: ${clean(s.observation, stepMax)}`);
    if (s.asked.length) lines.push(`   Asked for: ${s.asked.map((a) => clean(a, 100)).join(', ')}`);
    if (s.error) lines.push(`   Error: ${clean(s.error, stepMax)}`);
  });
  if (red.answers.length) {
    lines.push('What was recorded (it matters differently to different people):');
    for (const a of red.answers) lines.push(`- ${clean(a.question, 200)}: ${clean(a.answer, 300)}${a.note ? ` (${clean(a.note, 300)})` : ''}`);
  }
  if (red.notable) lines.push(`Anything else notable: ${clean(red.notable, NOTE_MAX[detail])}`);
  if (digest.total === 0) {
    lines.push('Reviews: none found');
  } else {
    lines.push(`Reviews: ${digest.total} mentions (${digest.negative} negative)${quotes.length < digest.total ? `, ${quotes.length} shown` : ''}`);
    quotes.forEach((q, i) => lines.push(`- [${q.polarity}] "${clean(red.quotes[i], BRIEF_QUOTE_MAX_CHARS)}"`));
  }
  const text = stripFences(lines.join('\n'));

  // What the run is shown, for its prompt read: the flow, its step artifacts, the quoted mentions and their
  // sources; also every mention the review counts and the audience-dependent answers rest on, so a brief
  // drawn from an upload-derived mention makes the run upload-exposed (flow design §8.4, §14).
  const shown: RetrievalResultRef[] = [{ id: flow.id, kind: 'flow' }];
  for (const s of steps) if (s.artifactId) shown.push({ id: s.artifactId, kind: 'artifact' });
  for (const q of quotes) {
    shown.push({ id: q.id, kind: 'review_mention' });
    const m = r.reviewMentions.get(q.id);
    if (m) shown.push({ id: m.artifactId, kind: 'artifact' }, ...(m.chunkId ? [{ id: m.chunkId, kind: 'chunk' }] : []));
  }
  for (const q of digest.quotes) shown.push({ id: q.id, kind: 'review_mention' });
  for (const a of answers) for (const id of a.mentionRefs) shown.push({ id, kind: 'review_mention' });
  const unique = [...new Map(shown.map((x) => [x.id, x])).values()];
  return { label: flow.id, text, shown: unique, uploadDerived: unique.some((x) => itemIsUploadDerived(store, x.id)) };
}

/** What a persona is shown for one flow (spec §10.2): goal, steps, audience-dependent answers, notable, review digest. Never the checklist score. */
export function flowBrief(store: Store, workspaceId: string, flow: Flow, detail: 'broad' | 'focused', settings: FlowsSettings): { label: string; text: string } {
  const { label, text } = briefOf(store, workspaceId, flow, detail, settings);
  return { label, text };
}

/** Deterministic shuffle (Fisher–Yates over a mulberry32 stream seeded from `seed`). */
function shuffled<T>(items: T[], seed: string): T[] {
  let a = createHash('sha256').update(seed).digest().readUInt32LE(0);
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

/** The tree's flow type named by a tool input: its id, or its key (merges resolved). */
function flowTypeNamed(store: Store, workspaceId: string, name: string): FlowType | undefined {
  const byId = flowRepos(store).flowTypes.get(name);
  if (byId && byId.rootWorkspaceId === rootOf(store, workspaceId)) return byId;
  return flowTypeByKey(store, workspaceId, name);
}

/**
 * `submit_flow_verdicts` handler: checks that the flow type is one of the caller's tree; the
 * dispatcher logs the `flow_verdicts` Decision on success and the round stores the verdicts from it
 * (it knows the persona and the flows shown).
 */
const submitFlowVerdictsHandler: ExtraToolHandler = async (ctx, raw, deps) => {
  const input = raw as ToolInput<'submit_flow_verdicts'>;
  const type = flowTypeNamed(deps.store, ctx.workspaceId, input.flow_type);
  if (!type || type.status === 'rejected') {
    return { ok: false, error: `unknown flow type '${input.flow_type}': use the flow type key given in your prompt` };
  }
  return { ok: true, data: { received: input.verdicts.length } };
};

/** Extra tool handlers of the ranking round, for `createToolHandlers({ extraHandlers })`. */
export function flowRoundToolHandlers(): Partial<Record<ToolName, ExtraToolHandler>> {
  return { submit_flow_verdicts: submitFlowVerdictsHandler };
}

/** Stamps the persona and flow type on every flow_verdicts Decision of a run. */
function stampPersona(store: Store, agentRunId: string, persona: Persona, flowTypeId: string): void {
  for (const d of store.decisions.list({ agentRunId, kind: 'flow_verdicts' })) {
    const payload = { ...((d.payload ?? {}) as Record<string, unknown>), persona: { id: persona.id, version: persona.version }, flowTypeId };
    store.decisions.update(d.id, { payload, refs: [...new Set([...d.refs, flowTypeId])] });
  }
}

/** Every verdict the run submitted for `type`, in call order; undefined when it submitted none. */
function verdictsOfRun(store: Store, workspaceId: string, agentRunId: string, type: FlowType): VerdictInput[] | undefined {
  let found = false;
  const out: VerdictInput[] = [];
  for (const d of store.decisions.list({ agentRunId, kind: 'flow_verdicts' })) {
    const p = d.payload as { tool?: string; input?: ToolInput<'submit_flow_verdicts'> } | null;
    if (p?.tool !== 'submit_flow_verdicts' || !p.input) continue;
    if (flowTypeNamed(store, workspaceId, p.input.flow_type)?.id !== type.id) continue;
    found = true;
    out.push(...p.input.verdicts);
  }
  return found ? out : undefined;
}

type Judge = {
  deps: ResearchDeps;
  workspaceId: string;
  type: FlowType;
  persona: Persona;
  /** Built on first use, inside the persona's own job: a persona whose agent.md cannot be built fails alone. */
  systemPrompt: () => string;
  model: ModelRef;
  /** Persona panel configured: the effort of the persona's seat (`model` is then the seat's too). */
  effort?: string;
  /** Persona panel configured: why the persona's seat cannot be started. It then judges nothing, on no other model. */
  unavailable?: string;
  settings: FlowsSettings;
  report: RoundReport;
};

/** Throws when the persona's seat cannot be started: its job records the failure like any other (`recordJobFailure`). */
function needSeat(j: Judge): void {
  if (j.unavailable !== undefined) throw new Error(j.unavailable);
}

/** Pseudo run id of the round's own decisions (a failure before any run exists, the round summary). */
export const ROUND_ACTOR = 'flow_ranking';
/** Not-narrowed items listed in the round's summary decision; the rest are counted. */
export const ROUND_LIST_MAX = 100;

/** One persona run over `flows`, asking `pairs`; stores what it submitted. Returns the verdicts stored. */
async function judgeRun(j: Judge, stage: 'broad' | 'focused', flows: Flow[], pairs: Array<[string, string]>, attempt: number): Promise<number> {
  const { deps, workspaceId, type, persona, model } = j;
  const { store } = deps;
  const systemPrompt = j.systemPrompt();
  const template = promptTemplate(stage === 'broad' ? 'flow_verdicts' : 'flow_verdict_pair');
  const briefs = flows.map((f) => briefOf(store, workspaceId, f, stage, j.settings));
  const flowsText = briefs.map((b) => `### Flow ${b.label}\n${fenceEvidence(b.label, b.text)}`).join('\n\n');
  // The definition may be agent-written (a proposed type) and echo third-party pages: fenced like the flows.
  const definition = fenceEvidence(type.id, cut(redactServed(store, workspaceId, type.definition), 1000));
  const prompt = renderTemplate(template, {
    flow_type: type.key,
    definition,
    flows: flowsText,
    pairs: pairs.map(([a, b]) => `- ${a} vs ${b}`).join('\n'),
  });
  // promptVersion(system + template), with its exact text kept in the prompt store (as the panel).
  const version = recordPromptVersion(store, 'persona', `${systemPrompt}\n${template}`);
  const read: PromptRead = {
    query: JSON.stringify({ flowType: type.key, stage, pairs: pairs.length }),
    scope: 'node',
    results: [...new Map(briefs.flatMap((b) => b.shown).map((x) => [x.id, x])).values()],
    tokensReturned: estimateTokens(flowsText),
    uploadDerived: briefs.some((b) => b.uploadDerived),
  };
  throwIfAborted(deps.signal);
  const outcome = await runAgent(deps, {
    kind: 'work', role: 'persona', workspaceId, round: 1, attempt, prompt, systemPrompt, model, needsBrowser: false,
    promptVersion: version, promptReads: [read], ...(j.effort !== undefined ? { effort: j.effort } : {}),
  });
  stampPersona(store, outcome.agentRunId, persona, type.id);
  throwIfAborted(deps.signal);
  const verdicts = verdictsOfRun(store, workspaceId, outcome.agentRunId, type);
  if (!verdicts) {
    const reason = outcome.status === 'failed' ? `run failed: ${outcome.reason ?? `exit ${outcome.exitCode}`}` : 'no submit_flow_verdicts call';
    recordHarnessDecision(
      store,
      { agentRunId: outcome.agentRunId, workspaceId, role: 'persona', model, promptVersion: version },
      'decision',
      { event: 'flow_verdicts_missing', flowTypeId: type.id, personaId: persona.id, stage, pairs: pairs.length, attempt, reason },
      [type.id],
    );
    return 0;
  }
  return recordVerdicts(
    store,
    { workspaceId, flowTypeId: type.id, persona, stage, agentRunId: outcome.agentRunId, allowed: flows.map((f) => f.id) },
    verdicts,
  ).saved;
}

const isAbort = (deps: ResearchDeps, err: unknown) => err instanceof AbortError || deps.signal?.aborted === true;

/**
 * A persona's job that threw (its agent.md could not be built, a run rejected, storing failed):
 * recorded as a harness Decision naming the persona and the flow type, never failing the round.
 */
function recordJobFailure(j: Judge, stage: 'broad' | 'focused', err: unknown, pairsLeft: number): void {
  recordHarnessDecision(
    j.deps.store,
    { agentRunId: ROUND_ACTOR, workspaceId: j.workspaceId, role: 'persona', model: j.model, promptVersion: 'n/a' },
    'decision',
    {
      event: 'flow_verdicts_failed', flowTypeId: j.type.id, personaId: j.persona.id, stage, pairsLeft,
      reason: err instanceof Error ? err.message : String(err),
    },
    [j.type.id],
  );
}

/** Stage 1 for one persona: every pair it has no live verdict on, asked in sittings, the rest once more. */
async function broadStage(j: Judge, flows: Flow[]): Promise<void> {
  const { deps, workspaceId, type, persona, settings, report } = j;
  const byId = new Map(flows.map((f) => [f.id, f]));
  const order = shuffled(flows.map((f) => f.id), persona.id);
  const missing = () => missingPairs(deps.store, workspaceId, type.id, persona, order);
  try {
    for (let attempt = 1; attempt <= BROAD_ATTEMPTS; attempt++) {
      const pairs = missing();
      if (pairs.length === 0) break;
      // Only a persona that has a pair to judge needs its seat: one with nothing left ends here, whatever its seat.
      needSeat(j);
      // Only the flows of the pairs still to ask, in the persona's order.
      const involved = order.filter((id) => pairs.some(([a, b]) => a === id || b === id));
      for (const sitting of sittings(involved, pairs, settings.maxFlowsPerSitting)) {
        report.sittings++;
        // Read the result before adding: `report.verdicts += await …` would read the counter before
        // the await and lose the other personas' concurrent additions.
        const saved = await judgeRun(j, 'broad', sitting.flowIds.map((id) => byId.get(id)!), sitting.pairs, attempt);
        report.verdicts += saved;
      }
    }
  } catch (err) {
    if (isAbort(deps, err)) throw err;
    recordJobFailure(j, 'broad', err, missing().length);
  }
  const left = missing().length;
  if (left > 0) report.notJudged.push({ flowTypeId: type.id, personaId: persona.id, pairs: left });
}

export type FocusedItem = { flowTypeId: string; personaId: string; a: string; b: string; reasons: FocusReason[] };

/**
 * Spends the round's focused cap across flow types: the first candidate of each type, then the
 * second of each, … (each list already most rank-relevant first), until `cap` items are chosen.
 * Deterministic for the same lists in the same order.
 */
export function pickFocused<T>(lists: T[][], cap: number): { chosen: T[]; left: T[] } {
  const chosen: T[] = [];
  const left: T[] = [];
  const longest = Math.max(0, ...lists.map((l) => l.length));
  for (let i = 0; i < longest; i++) {
    for (const list of lists) {
      const item = list[i];
      if (item === undefined) continue;
      (chosen.length < cap ? chosen : left).push(item);
    }
  }
  return { chosen, left };
}

/** Payload of the round's summary decision: the report and the not-narrowed items (at most `ROUND_LIST_MAX`). */
export function roundSummary(report: RoundReport, notNarrowed: FocusedItem[], researchRunId?: string): Record<string, unknown> {
  return {
    event: 'flow_ranking_round',
    ...(researchRunId !== undefined ? { researchRunId } : {}),
    report,
    notNarrowed: notNarrowed.slice(0, ROUND_LIST_MAX),
    notNarrowedMore: Math.max(0, notNarrowed.length - ROUND_LIST_MAX),
  };
}

/** Runs `jobs` concurrently; jobs record their own failures, so only an abort ends the round here. */
async function settle(deps: ResearchDeps, jobs: Array<Promise<void>>): Promise<void> {
  const results = await Promise.allSettled(jobs);
  if (deps.signal?.aborted) throw new AbortError('research cancelled');
  const failed = results.find((r): r is PromiseRejectedResult => r.status === 'rejected');
  if (failed) throw failed.reason; // a bug, not a failed run: jobs catch those themselves
}

/** Runs the ranking round for the node (see the module doc). */
export async function runFlowRanking(workspaceId: string, deps: ResearchDeps): Promise<RoundReport> {
  const { store, config } = deps;
  const settings = flowsSettings(config);
  const report: RoundReport = { flowTypes: 0, sittings: 0, focused: 0, verdicts: 0, notJudged: [], notNarrowed: 0 };
  // Rulings whose flows have a new version since: still applied, but the user is asked again.
  refreshOverrides(store, workspaceId);

  // Audience segments only (stakeholder design §5).
  const personas = segmentPersonas(store, workspaceId).filter(isOutputUsable);
  const usable = new Set(personas.map((p) => p.id));
  const model = settings.model ?? config.roles.persona;
  const scope = calibrationScope(store, config, workspaceId);
  /** The persona's agent.md with this business's persona calibration, built once, when first needed. */
  const systemPrompts = new Map<string, string>();
  const systemPromptOf = (p: Persona) => {
    let text = systemPrompts.get(p.id);
    if (text === undefined) systemPrompts.set(p.id, (text = withCalibration(agentMdOf(deps, p), 'persona', scope)));
    return text;
  };
  // Persona panel configured: a persona judges flows on the seat it has in the panel (persona panel design §2),
  // whatever `flows.model` says, and on no other.
  const panel = panelSettings(config);
  const seatFor = (persona: Persona): Pick<Judge, 'model' | 'effort' | 'unavailable'> => {
    if (!panel) return { model };
    const { index, seat } = seatOf(panel, personas, persona);
    const why = seatUnavailable(config, seat);
    return {
      model: { provider: seat.provider, model: seat.model },
      ...(seat.effort !== undefined ? { effort: seat.effort } : {}),
      ...(why !== undefined ? { unavailable: `persona '${persona.slug}' is unavailable on seat ${index} (${seat.provider}/${seat.model}): ${why}` } : {}),
    };
  };
  const judge = (type: FlowType, persona: Persona): Judge => ({
    deps, workspaceId, type, persona, systemPrompt: () => systemPromptOf(persona), ...seatFor(persona), settings, report,
  });

  // Stage 1 per flow type: broad sittings, personas concurrently.
  const judged: Array<{ type: FlowType; flows: Flow[] }> = [];
  for (const type of listFlowTypes(store, workspaceId, { status: 'active' })) {
    const flows = rankableFlows(store, workspaceId, type.id);
    if (flows.length < 2) continue;
    report.flowTypes++;
    for (const f of flows) applyReviewChecks(store, workspaceId, f.id, settings);
    if (personas.length === 0) continue;
    judged.push({ type, flows });
    await settle(deps, personas.map(async (p) => broadStage(judge(type, p), flows)));
  }

  // Stage 2: the focused candidates of every type, the round's cap spent across types in turn.
  const candidates = judged.map(({ type }): FocusedItem[] => {
    const ranking = nodeRanking(store, config, workspaceId, type.id);
    const ranked = new Set(ranking.ranked.map((f) => f.flowId));
    const verdicts = liveVerdicts(store, workspaceId, type.id).filter((v) => usable.has(v.personaId) && ranked.has(v.flowAId) && ranked.has(v.flowBId));
    return focusedPairs({
      verdicts,
      ranked: ranking.ranked,
      checklist: new Map(ranking.ranked.map((f) => [f.flowId, f.checklist])),
      // The user's disagreements on still-live verdicts, of the personas and flows judged here.
      disagreed: disagreedPairs(store, workspaceId, type.id).filter((d) => usable.has(d.personaId) && ranked.has(d.a) && ranked.has(d.b)),
      settings: { ...settings, maxFocusedComparisons: Number.POSITIVE_INFINITY },
    }).map((item) => ({ flowTypeId: type.id, ...item }));
  });
  const { chosen, left } = pickFocused(candidates, Math.max(0, settings.maxFocusedComparisons));
  report.focused = chosen.length;
  report.notNarrowed = left.length;
  const flowsById = new Map(judged.flatMap(({ flows }) => flows.map((f) => [f.id, f] as const)));
  const typeById = new Map(judged.map(({ type }) => [type.id, type]));
  await settle(
    deps,
    personas.map(async (p) => {
      const mine = chosen.filter((i) => i.personaId === p.id);
      for (let k = 0; k < mine.length; k++) {
        const item = mine[k]!;
        const j = judge(typeById.get(item.flowTypeId)!, p);
        const a = flowsById.get(item.a);
        const b = flowsById.get(item.b);
        if (!a || !b) continue;
        try {
          needSeat(j);
          const saved = await judgeRun(j, 'focused', [a, b], [[a.id, b.id]], 1);
          report.verdicts += saved;
        } catch (err) {
          if (isAbort(deps, err)) throw err;
          // The persona's remaining focused items are not run this round.
          recordJobFailure(j, 'focused', err, mine.length - k);
          return;
        }
      }
    }),
  );

  const researchRunId = store.researchRuns.list({ workspaceId, status: 'running' }).filter((r) => r.phase === 'flow_ranking').at(-1)?.id;
  snapshotRankings(store, config, workspaceId, researchRunId);
  recordHarnessDecision(
    store,
    { agentRunId: ROUND_ACTOR, workspaceId, role: 'persona', model, promptVersion: 'n/a' },
    'decision',
    roundSummary(report, left, researchRunId),
    researchRunId !== undefined ? [researchRunId] : [],
  );
  return report;
}

/** `runFlowRanking` as the `flow_ranking` phase runner: `phaseRunners: { flow_ranking: flowRankingRunner }`. */
export const flowRankingRunner: PhaseRunner = async (workspaceId, deps) => {
  await runFlowRanking(workspaceId, deps);
};
