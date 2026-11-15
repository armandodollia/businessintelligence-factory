import { existsSync, readFileSync } from 'node:fs';
import type { ToolInput } from '../harness/tools/registry.js';
import { loadPrompt, renderTemplate, withCalibration } from '../prompts/index.js';
import { recordPromptVersion } from '../prompts/store.js';
import { isOutputUsable } from '../research/outputs.js';
import { recordHarnessDecision, runAgent, throwIfAborted, type PhaseRunner, type ResearchDeps } from '../research/deps.js';
import { calibrationScope } from '../scoring/calibration.js';
import { PERSONA_FEEDBACK_KEYS } from '../scoring/criteria.js';
import type { Decision, Persona, PersonaFeedback, Recommendation } from '../types.js';
import { segmentPersonas } from '../stakeholders/personas.js';
import { runStakeholderReads, type ReadsReport } from '../stakeholders/reads.js';
import { scopeOf } from '../workspace/tree.js';
import { writeAgentMd } from './personas.js';

/** Persona runs per (recommendation, persona) that may end without `submit_persona_feedback`. */
export const PANEL_ATTEMPTS = 2;

export type PanelReport = {
  /** Feedback entries attached (one per persona per recommendation that answered). */
  feedback: number;
  /** Pairs whose persona never called `submit_persona_feedback` (after retry). */
  missing: Array<{ recommendationId: string; personaId: string; reason: string }>;
  /** The stakeholder reads that follow the segment personas (stakeholder design §10). */
  stakeholderReads?: ReadsReport;
};

type FeedbackKey = (typeof PERSONA_FEEDBACK_KEYS)[number];

/** Spread (max − min) at or above which personas are said to disagree on a score. */
export const DISAGREEMENT_SPREAD = 2;

export type PanelSummary = {
  simulated: true;
  n: number;
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
 * the scores where segments disagree, and per-audience means.
 */
export function panelSummary(rec: Pick<Recommendation, 'personaFeedback'>, personas: Persona[] = []): PanelSummary {
  const fb = rec.personaFeedback ?? [];
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
  return { simulated: true, n: fb.length, scores, disagreement, byAudience };
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

function toFeedback(personaId: string, input: ToolInput<'submit_persona_feedback'>): PersonaFeedback {
  return {
    personaId,
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

/** Replaces this persona's entry in the recommendation's feedback (re-read first: runs finish concurrently). */
function attach(deps: ResearchDeps, recId: string, fb: PersonaFeedback): void {
  const { store } = deps;
  store.transaction(() => {
    const cur = store.recommendations.get(recId);
    if (!cur) return;
    const rest = (cur.personaFeedback ?? []).filter((f) => f.personaId !== fb.personaId);
    store.recommendations.update(recId, { personaFeedback: [...rest, fb] });
  });
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
 */
export async function runPersonaPanel(workspaceId: string, deps: ResearchDeps): Promise<PanelReport> {
  const { store } = deps;
  const report: PanelReport = { feedback: 0, missing: [] };
  const ws = store.workspaces.get(workspaceId);
  const scope = ws ? scopeOf(ws).name : workspaceId;
  // Only reviewed outputs go to the panel (spec §7.2): verified, or included by the user.
  // Audience segments only: stakeholder personas give stakeholder reads instead (stakeholder design §10).
  const personas = segmentPersonas(store, workspaceId).filter(isOutputUsable);
  const recs = store.recommendations.list({ workspaceId }).filter(isOutputUsable);
  if (personas.length && recs.length) await segmentPanel(workspaceId, deps, personas, recs, scope, report);
  // Then each open stakeholder persona reads each recommendation (stakeholder design §10).
  report.stakeholderReads = await runStakeholderReads(workspaceId, deps);
  return report;
}

/** The segment personas' feedback on every recommendation (one run per pair, concurrently). */
async function segmentPanel(
  workspaceId: string,
  deps: ResearchDeps,
  personas: Persona[],
  recs: Recommendation[],
  scope: string,
  report: PanelReport,
): Promise<void> {
  const { store, config } = deps;
  const template = loadPrompt('persona_panel');
  const model = config.roles.persona;

  const one = async (rec: Recommendation, persona: Persona, systemPrompt: string): Promise<void> => {
    const prompt = panelPrompt(template.text, rec, scope);
    // promptVersion(system + template), with its exact text kept in the prompt store (learning loop WP-B).
    const version = recordPromptVersion(deps.store, 'persona', `${systemPrompt}\n${template.text}`);
    let reason = 'no submit_persona_feedback call';
    for (let attempt = 1; attempt <= PANEL_ATTEMPTS; attempt++) {
      throwIfAborted(deps.signal);
      const outcome = await runAgent(deps, {
        kind: 'work', role: 'persona', workspaceId, round: 1, attempt, prompt, systemPrompt,
        model, needsBrowser: false, promptVersion: version,
      });
      stampPersona(deps, outcome.agentRunId, persona.id);
      throwIfAborted(deps.signal);
      const found = feedbackOfRun(deps, outcome.agentRunId, rec.id);
      if (found) {
        attach(deps, rec.id, toFeedback(persona.id, found.input));
        report.feedback++;
        return;
      }
      reason = outcome.status === 'failed' ? `run failed: ${outcome.reason ?? `exit ${outcome.exitCode}`}` : 'no submit_persona_feedback call';
      recordHarnessDecision(
        store,
        { agentRunId: outcome.agentRunId, workspaceId, role: 'persona', model, promptVersion: version },
        'decision',
        { event: 'persona_feedback_missing', recommendationId: rec.id, personaId: persona.id, attempt, reason, willRetry: attempt < PANEL_ATTEMPTS },
        [rec.id, persona.id],
      );
    }
    report.missing.push({ recommendationId: rec.id, personaId: persona.id, reason });
  };

  const jobs: Array<Promise<void>> = [];
  for (const persona of personas) {
    // This business's approved persona calibration (calibration/persona.md) goes after every persona's agent.md.
    const systemPrompt = withCalibration(agentMdOf(deps, persona), 'persona', calibrationScope(store, config, workspaceId));
    for (const rec of recs) jobs.push(one(rec, persona, systemPrompt));
  }
  const results = await Promise.allSettled(jobs);
  const err = results.find((r): r is PromiseRejectedResult => r.status === 'rejected');
  if (err) throw err.reason;
}

/** `runPersonaPanel` as the `persona_panel` phase runner: `phaseRunners: { persona_panel: personaPanelRunner }`. */
export const personaPanelRunner: PhaseRunner = async (workspaceId, deps) => {
  await runPersonaPanel(workspaceId, deps);
};
