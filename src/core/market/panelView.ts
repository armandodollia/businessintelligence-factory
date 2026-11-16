import type { BifConfig } from '../config/schema.js';
import { isOutputUsable } from '../research/outputs.js';
import type { PERSONA_FEEDBACK_KEYS } from '../scoring/criteria.js';
import { segmentPersonas } from '../stakeholders/personas.js';
import type { Store } from '../store/db.js';
import type { Decision, PanelBaseline, PersonaFeedback, Recommendation } from '../types.js';
import { panelSummary } from './panel.js';
import { panelHistory, planRead, textHashOf } from './panelRounds.js';
import { panelSettings, type PanelSeat } from './panelSettings.js';

/**
 * What people see of a recommendation's persona panel beyond its current reactions (persona panel
 * design 2026-11-16 §8): where the personas disagree, the earlier rounds, the baseline, and which
 * personas were unavailable or have used up their rounds. Everything in it is simulated. The current
 * reactions themselves are `Recommendation.personaFeedback`, served as they are stored.
 */

type Scale = (typeof PERSONA_FEEDBACK_KEYS)[number];
type RecordedSeat = PanelSeat & { index: number };

export type RecommendationPanel = {
  simulated: true;
  /**
   * The scales on which the counted reactions differ by two points or more, each as its range. Never
   * an average: an average hides the disagreement, and one of simulated people says nothing of real ones.
   */
  disagreement: Array<{ scale: Scale; min: number; max: number }>;
  /** The reactions not counted in `disagreement`: they add nothing beyond a general reader (`sameAsBaseline`). */
  leftOut: number;
  /** The personas' earlier rounds, in the order stored: each was the persona's current reaction until a later round replaced it. */
  earlierRounds: Array<{ personaId: string; round: number; reaction: PersonaFeedback }>;
  /**
   * What the run with no persona said: its latest answer (`current`: whether that is to the text as it
   * is now) and its earlier ones, oldest first. Never a persona's feedback. Unset: no baseline is stored.
   */
  baseline?: { current: boolean; reaction: PanelBaseline; earlier: PanelBaseline[] };
  /**
   * The personas that the last panel run could not get a reaction from to the text as it is now: the
   * seat could not be started, or the run gave no answer after the retry. No other seat was tried.
   */
  unavailable: Array<{ personaId: string; round: number; seat: RecordedSeat; reason: string }>;
  /** The personas that have not read the text as it is now and will not: their rounds are used up (`round`: their last). */
  limitReached: Array<{ personaId: string; round: number }>;
  /** The baseline of the text as it is now could not be had in the last panel run. */
  baselineUnavailable?: { round: number; seat: RecordedSeat; reason: string };
  /** The baseline has not read the text as it is now and will not: its rounds are used up. */
  baselineLimitReached?: true;
};

/** The payload of a record that a read could not be had (`persona_unavailable`, `baseline_unavailable`; panel.ts). */
type UnavailableRecord = { event?: string; recommendation?: string; persona?: string; round?: number; textHash?: string; seat?: RecordedSeat; reason?: string };

/**
 * The panel of each of `recs` (recommendations of `workspaceId`), by recommendation id. A
 * recommendation has one when `personaPanel` is configured, or when earlier rounds or baselines of it
 * are stored (they stay readable when the block is removed). Without either it has none, and the page
 * shows its persona feedback as it did before the panel had rounds.
 *
 * A record that a persona (or the baseline) was unavailable counts while it is the last word on the
 * text as it is now: it was made for that text, and no reaction to that text has been stored since.
 */
export function panelViews(store: Store, config: BifConfig, workspaceId: string, recs: Recommendation[]): Map<string, RecommendationPanel> {
  const settings = panelSettings(config);
  const out = new Map<string, RecommendationPanel>();
  // The personas the panel reads with (panel.ts): usable audience segments.
  const personas = settings ? new Set(segmentPersonas(store, workspaceId).filter(isOutputUsable).map((p) => p.id)) : new Set<string>();
  const records: UnavailableRecord[] = settings
    ? store.decisions.list({ workspaceId, kind: 'decision' }).map((d: Decision) => (d.payload ?? {}) as UnavailableRecord)
    : [];
  /** The last record of `event` for a recommendation (and a persona), if it was made for the text `textHash`. */
  const lastRecord = (event: string, recId: string, textHash: string, personaId?: string): UnavailableRecord | undefined => {
    const last = records.findLast((r) => r.event === event && r.recommendation === recId && (personaId === undefined || r.persona === personaId));
    return last && last.textHash === textHash && last.seat && typeof last.reason === 'string' ? last : undefined;
  };

  for (const rec of recs) {
    const { baselines, earlierRounds } = panelHistory(store, rec.id);
    if (!settings && !baselines.length && !earlierRounds.length) continue;
    const textHash = textHashOf(rec);
    const summary = panelSummary(rec);
    const latest = baselines.at(-1)?.reaction as PanelBaseline | undefined;
    const panel: RecommendationPanel = {
      simulated: true,
      disagreement: summary.disagreement.map((scale) => ({ scale, min: summary.scores[scale].min, max: summary.scores[scale].max })),
      leftOut: summary.leftOut,
      earlierRounds: earlierRounds.flatMap((r) => (r.personaId ? [{ personaId: r.personaId, round: r.round, reaction: r.reaction as PersonaFeedback }] : [])),
      ...(latest ? { baseline: { current: latest.textHash === textHash, reaction: latest, earlier: baselines.slice(0, -1).map((b) => b.reaction as PanelBaseline) } } : {}),
      unavailable: [],
      limitReached: [],
    };
    if (settings) {
      for (const personaId of personas) {
        const current = rec.personaFeedback.find((f) => f.personaId === personaId);
        if (current?.textHash === textHash) continue; // it has read the text as it is now
        const plan = planRead(settings, textHash, current);
        if (!plan.read && plan.why === 'round_limit') panel.limitReached.push({ personaId, round: plan.round });
        const record = lastRecord('persona_unavailable', rec.id, textHash, personaId);
        if (record) panel.unavailable.push({ personaId, round: record.round ?? plan.round, seat: record.seat!, reason: record.reason! });
      }
      if (settings.baseline && latest?.textHash !== textHash) {
        const plan = planRead(settings, textHash, latest);
        if (!plan.read && plan.why === 'round_limit') panel.baselineLimitReached = true;
        const record = lastRecord('baseline_unavailable', rec.id, textHash);
        if (record) panel.baselineUnavailable = { round: record.round ?? plan.round, seat: record.seat!, reason: record.reason! };
      }
    }
    out.set(rec.id, panel);
  }
  return out;
}
