/**
 * The scheduled "what changed" outcome hook (learning loop WP-C), isolated in ONE function.
 * Knowledge store KS-6 (design §13: "this replaces WP-C's text-diff hook for scheduled changes")
 * replaced its text diff with fact lineage: `recordWhatChanged` (src/core/scheduler/whatChanged.ts)
 * calls it once per diffed phase run; nothing else does.
 */
import type { BifConfig } from '../config/schema.js';
import { recordStaleOutcome } from '../knowledge/facts.js';
import { lineageOutcomesOfRun, observedLineages } from '../knowledge/outcomes.js';
import { contradictedFindings, factsOfRun } from '../scheduler/diff.js';
import type { Store } from '../store/db.js';
import type { Finding, ResearchRun } from '../types.js';
import { outputSaveDecision, recordOutcome } from './outcomes.js';
import type { DecisionOutcome } from './types.js';

export type WhatChangedOutcomesInput = {
  whatChangedDecisionId: string;
  prev: ResearchRun;
  next: ResearchRun;
  changedArtifacts: Array<{ prev: string; next: string }>;
  /** With a config, facts of `prev` the next run did not observe and that are past their TTL get `stale`. */
  config?: Pick<BifConfig, 'knowledge'>;
  now?: Date;
};

/**
 * Outcomes of a scheduled "what changed" diff, from fact lineage (design §11, §13):
 * 1. Lineage events of the NEXT run: `confirmed` / `changed` / `retracted` were written when its
 *    observations were applied at task end (`applyObservations`, keyed by observation id). They are
 *    returned here, never written twice.
 * 2. Facts of the previous run (saved or observed in it) whose lineage the next run did NOT observe:
 *    - text fallback, only against facts the next run saved as `new` (design §11): the scheduler
 *      diff's `contradictedFindings` (one function for the diff and these outcomes) → `contradicted` /
 *      `stale` (source `what_changed`) — e.g. "$10/mo" then a new "$12/mo" instead of a replacement;
 *    - a screenshot the fact cites changed in the next run: `changed` / `stale` (source `what_changed`);
 *    - with `config`: past its TTL now → the lazy `stale` lineage outcome (`recordStaleOutcome`,
 *      once per lapse, shared with `list_changes` and the briefing).
 * A fact the next run confirmed, replaced or retracted never gets a text-diff outcome (the old hook
 * flagged a confirmed fact as contradicted whenever its subject also had a new claim). Idempotent.
 */
export function recordWhatChangedOutcomes(store: Store, input: WhatChangedOutcomesInput): DecisionOutcome[] {
  const out: DecisionOutcome[] = [...lineageOutcomesOfRun(store, input.next.id)];
  const observed = observedLineages(store, input.next.id);
  const base = { whatChangedDecisionId: input.whatChangedDecisionId, prevRunId: input.prev.id, nextRunId: input.next.id };
  const write = (f: Finding, outcome: string, evidence: Record<string, unknown>) => {
    const save = outputSaveDecision(store, 'finding', f.id);
    if (!save) return;
    const o = recordOutcome(store, {
      decisionId: save.id, outcome, label: 'stale', source: 'what_changed', evidence: { ...base, ...evidence },
      targetType: 'finding', targetId: f.id, ...(f.taskId && store.tasks.get(f.taskId) ? { taskId: f.taskId } : {}),
    });
    if (o) out.push(o);
  };

  // The text fallback is the scheduler diff's (one function, KS-5 × KS-6).
  const contradicted = new Set(contradictedFindings(input.prev.id, input.next.id, { store }));
  const unobserved = factsOfRun(store, input.prev).filter((f) => !observed.has(f.lineageId ?? f.id));
  const changed = new Map(input.changedArtifacts.map((c) => [c.prev, c.next]));
  for (const f of unobserved) {
    if ((f.lifecycle ?? 'current') !== 'current') continue;
    if (contradicted.has(f.id)) write(f, 'contradicted', {});
    const hits = f.evidence.filter((a) => changed.has(a));
    if (hits.length) write(f, 'changed', { changedArtifacts: hits.map((a) => ({ prev: a, next: changed.get(a) })) });
    if (input.config) {
      const o = recordStaleOutcome(store, input.config, store.findings.get(f.id) ?? f, input.now);
      if (o && !out.some((x) => x.id === o.id)) out.push(o);
    }
  }
  return out;
}
