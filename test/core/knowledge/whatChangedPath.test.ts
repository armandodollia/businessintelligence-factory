/**
 * KS-5 × KS-6 integration: ONE "what changed" path. The scheduler's `recordWhatChanged` diffs the runs
 * (KS-5, fact lineage) and records outcomes through `recordWhatChangedOutcomes` (KS-6) with the
 * scheduled run's config, so `stale` is recorded there too; the text fallback is one function
 * (`contradictedFindings`) for the diff and the outcomes; every outcome is written exactly once, also
 * when the step is replayed (pipeline resume) or the process stopped between the Decision and its
 * outcomes.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { recordStaleOutcome } from '../../../src/core/knowledge/facts.js';
import { listOutcomes } from '../../../src/core/learning/outcomes.js';
import type { DecisionOutcome } from '../../../src/core/learning/types.js';
import { contradictedFindings } from '../../../src/core/scheduler/diff.js';
import { recordWhatChanged } from '../../../src/core/scheduler/whatChanged.js';
import type { Store } from '../../../src/core/store/db.js';
import { knowledgeRepos, newId } from '../../../src/core/store/repos.js';
import { recordSystemDecision } from '../../../src/core/systemDecision.js';
import { researchSetup } from '../helpers/research.js';

const opened: Store[] = [];
afterEach(() => {
  for (const s of opened.splice(0)) s.close();
});

const NOW = new Date('2026-06-02T00:00:00Z');

function world() {
  const env = researchSetup(opened);
  const { store } = env;
  store.workspaces.insert({ id: 'ws_a', name: 'Acme', sector: 'saas', createdAt: 'now' });
  store.schedules.insert({ id: 'sch_1', workspaceId: 'ws_a', name: 'weekly', cron: '0 0 * * 1', phases: ['deep_dives'], enabled: true });
  const rr = (id: string, at: string) =>
    store.researchRuns.insert({ id, workspaceId: 'ws_a', phase: 'deep_dives', status: 'done', startedAt: at, scheduleId: 'sch_1' });
  const prev = rr('rrun_p', '2026-01-01T00:00:00Z');
  const next = rr('rrun_n', '2026-06-01T00:00:00Z');
  const fact = (runId: string, subject: string, claim: string, extra: Record<string, unknown> = {}) => {
    const f = store.findings.insert({
      id: newId('fnd'), workspaceId: 'ws_a', runId, taskId: 'tsk_x', subject, claim, criteria: {}, evidence: [], status: 'verified',
      createdAt: '2026-01-01T00:00:00Z', lastConfirmedAt: '2026-01-01T00:00:00Z', ...extra,
    });
    store.decisions.insert({
      id: newId('dec'), workspaceId: 'ws_a', agentRunId: 'run_x', role: 'worker', model: { provider: 'claude', model: 'sonnet' }, kind: 'score',
      payload: { tool: 'save_finding', findingId: f.id }, refs: [f.id], promptVersion: 'pv', createdAt: '2026-01-01T00:00:00Z',
    });
    return f;
  };
  // prev: a price (contradicted by a NEW fact of next), a plans fact next replaced, and an SSO fact on the
  // plans' subject that next neither saw nor contradicted with a new fact (past TTL → stale only).
  const price = fact('rrun_p', 'Acme', 'Acme Pro costs $10/mo');
  const plans = fact('rrun_p', 'Globex', 'Globex sells three plans');
  const sso = fact('rrun_p', 'Globex', 'Globex has SSO');
  fact('rrun_n', 'Acme', 'Acme Pro costs $12/mo');
  const v2 = fact('rrun_n', 'Globex', 'Globex sells four plans', { replacesId: plans.id, lineageId: plans.id, version: 2 });
  store.findings.update(plans.id, { lifecycle: 'replaced' });
  knowledgeRepos(store).factObservations.insert({
    id: newId('obs'), workspaceId: 'ws_a', lineageId: plans.id, findingId: v2.id, priorFindingId: plans.id, kind: 'replace', runId: 'rrun_n',
    evidence: [], status: 'applied', createdAt: '2026-06-01T00:00:00Z', appliedAt: '2026-06-01T00:00:00Z',
  });
  return { env, store, prev, next, price, plans, sso };
}

const key = (o: DecisionOutcome) => `${o.subjectId ?? o.decisionId}|${o.targetId ?? ''}|${o.outcome}|${o.label}|${o.source}`;
const snapshot = (store: Store) => listOutcomes(store).map(key).sort();

describe('one "what changed" path (KS-5 diff × KS-6 outcomes)', () => {
  it('the scheduled step passes its config: unobserved facts past TTL get `stale` there', () => {
    const w = world();
    recordWhatChanged({ store: w.store, config: w.env.config, now: NOW }, 'sch_1', [w.next]);
    const stale = listOutcomes(w.store).filter((o) => o.source === 'fact_lineage' && o.label === 'stale');
    expect(stale.map((o) => o.subjectId).sort()).toEqual([w.price.id, w.sso.id].sort());
  });

  it('the text fallback is one function: the outcomes are exactly `contradictedFindings`', () => {
    const w = world();
    // The replaced plans fact puts its subject in the next run, but no NEW fact on it: SSO is not contradicted.
    expect(contradictedFindings(w.prev.id, w.next.id, { store: w.store })).toEqual([w.price.id]);
    recordWhatChanged({ store: w.store, config: w.env.config, now: NOW }, 'sch_1', [w.next]);
    const text = listOutcomes(w.store).filter((o) => o.source === 'what_changed' && o.outcome === 'contradicted');
    expect(text.map((o) => o.targetId)).toEqual([w.price.id]);
  });

  it('replay: each outcome once — a second step, the briefing / list_changes lapse, and a stop between Decision and outcomes', () => {
    const w = world();
    const [wc] = recordWhatChanged({ store: w.store, config: w.env.config, now: NOW }, 'sch_1', [w.next]);
    expect(wc).toBeDefined();
    const first = snapshot(w.store);
    expect(new Set(first).size).toBe(first.length);
    expect(first.length).toBeGreaterThan(0);
    // Pipeline resume replays the step: no new Decision, no new outcome.
    expect(recordWhatChanged({ store: w.store, config: w.env.config, now: NOW }, 'sch_1', [w.next])).toEqual([]);
    // The briefing / list_changes observing the same lapse share the key.
    recordStaleOutcome(w.store, w.env.config, w.store.findings.get(w.sso.id)!, NOW);
    expect(snapshot(w.store)).toEqual(first);

    // A stop after the Decision and before its outcomes: the replay records them, once.
    const v = world();
    recordSystemDecision({ store: v.store }, {
      workspaceId: 'ws_a', actor: 'scheduler',
      payload: { tool: 'scheduler', event: 'what_changed', scheduleId: 'sch_1', phase: 'deep_dives', prevRunId: v.prev.id, nextRunId: v.next.id },
      refs: [v.next.id, v.prev.id],
    });
    expect(listOutcomes(v.store)).toEqual([]);
    recordWhatChanged({ store: v.store, config: v.env.config, now: NOW }, 'sch_1', [v.next]);
    const replayed = snapshot(v.store);
    expect(replayed.length).toBe(first.length);
    recordWhatChanged({ store: v.store, config: v.env.config, now: NOW }, 'sch_1', [v.next]);
    expect(snapshot(v.store)).toEqual(replayed);
  });
});
