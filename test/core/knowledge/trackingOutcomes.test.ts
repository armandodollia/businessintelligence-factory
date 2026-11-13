/**
 * KS-6 outcomes (design §13 "WP-C"): every lineage label is written exactly once — `confirmed`,
 * `changed`, `retracted` (task end), `stale` (first observation past TTL), `user-rejected` (the user
 * retracts), `duplicate-saved` (a handshake answered `new` that the user later merges) — and the
 * scheduled "what changed" hook works from fact lineage instead of the text diff.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { FakeScript, ToolClient } from '../../../src/core/harness/adapter.js';
import { mergeEntitiesAsUser } from '../../../src/core/feedback/actions.js';
import { listFeedback } from '../../../src/core/feedback/events.js';
import { resolveEntity } from '../../../src/core/knowledge/entities.js';
import { recordStaleOutcome, retractFactByUser } from '../../../src/core/knowledge/facts.js';
import { lineageOutcomesOfRun } from '../../../src/core/knowledge/outcomes.js';
import { scopeFor } from '../../../src/core/knowledge/scope.js';
import { outcomesFromFeedback, registerFeedbackOutcomes } from '../../../src/core/learning/feedbackOutcomes.js';
import { listOutcomes } from '../../../src/core/learning/outcomes.js';
import { recordWhatChangedOutcomes } from '../../../src/core/learning/whatChangedOutcomes.js';
import type { AgentRequest } from '../../../src/core/research/deps.js';
import { runTaskWithReview } from '../../../src/core/research/reviewLoop.js';
import { recordWhatChanged } from '../../../src/core/scheduler/whatChanged.js';
import type { Store } from '../../../src/core/store/db.js';
import { knowledgeRepos, newId } from '../../../src/core/store/repos.js';
import type { DecisionOutcome } from '../../../src/core/learning/types.js';
import type { Task } from '../../../src/core/types.js';
import { addTask, researchSetup, review } from '../helpers/research.js';
import { ks4, T0 } from './ks4fixture.js';

const opened: Store[] = [];
const releases: Array<() => void> = [];
afterEach(() => {
  for (const r of releases.splice(0)) r();
  for (const s of opened.splice(0)) s.close();
});

/** Rows per (subject, label): every value must be 1. */
const counts = (rows: DecisionOutcome[]) => {
  const m = new Map<string, number>();
  for (const o of rows) m.set(`${o.subjectId ?? o.decisionId}|${o.label}`, (m.get(`${o.subjectId ?? o.decisionId}|${o.label}`) ?? 0) + 1);
  return m;
};

function recurring() {
  const env = researchSetup(opened);
  env.store.workspaces.insert({ id: 'ws_a', name: 'Acme', sector: 'saas', createdAt: 'now' });
  env.store.schedules.insert({ id: 'sch_1', workspaceId: 'ws_a', name: 'weekly', cron: '0 0 * * 1', phases: ['deep_dives'], enabled: true });
  const capture = async (tools: ToolClient, task: Task, content: string) => {
    const { artifactId } = (await tools.call('save_artifact', { kind: 'text', mime: 'text/plain', content })) as { artifactId: string };
    knowledgeRepos(env.store).artifactCaptures.insert({ id: newId('cap'), artifactId, workspaceId: task.workspaceId, taskId: task.id, capturedAt: new Date().toISOString() });
    return artifactId;
  };
  const run = async (runId: string, startedAt: string, work: (tools: ToolClient, task: Task) => Promise<void>) => {
    const rr = env.store.researchRuns.insert({ id: runId, workspaceId: 'ws_a', phase: 'deep_dives', status: 'running', startedAt, scheduleId: 'sch_1' });
    const task = addTask(env.store, { runId });
    env.state.pick = (r: AgentRequest): FakeScript =>
      r.kind === 'work'
        ? async (tools) => {
            await work(tools, task);
            await tools.call('submit_result', { summary: 'done' });
          }
        : review(9);
    await runTaskWithReview(task, env.deps);
    return env.store.researchRuns.update(rr.id, { status: 'done' });
  };
  return { env, capture, run };
}

describe('scheduled "what changed" from fact lineage (KS-6 replaces the text-diff hook)', () => {
  it('a run that confirms, replaces and retracts gets lineage outcomes once — no text-diff `contradicted`', async () => {
    const { env, capture, run } = recurring();
    await run('rrun_1', '2026-11-01T00:00:00Z', async (tools, task) => {
      const a = await capture(tools, task, 'Pricing: Pro $10 per month. Free tier available. Three plans.');
      for (const claim of ['Acme Pro plan costs $10 per month', 'Acme offers a free tier', 'Acme sells three plans']) {
        await tools.call('save_finding', { claim, subject: 'Acme', evidence: [a] });
      }
    });
    const [price, free, plans] = ['Acme Pro plan costs $10 per month', 'Acme offers a free tier', 'Acme sells three plans'].map(
      (claim) => env.store.findings.list({ claim })[0]!,
    );
    const next = await run('rrun_2', '2026-11-08T00:00:00Z', async (tools, task) => {
      const a = await capture(tools, task, 'Pricing: Pro $10 per month. No free tier. Four plans.');
      await tools.call('confirm_finding', { finding_id: price!.id, evidence: [a] });
      await tools.call('save_finding', { claim: 'Acme sells four plans', subject: 'Acme', evidence: [a], relation: { replaces: plans!.id } });
      await tools.call('retract_finding', { finding_id: free!.id, reason: 'free tier removed', evidence: [a] });
    });

    const [wc] = recordWhatChanged({ store: env.store }, 'sch_1', [next]);
    expect(wc).toBeDefined();
    // The old hook flagged all three prior facts `contradicted` (their subject had a new claim).
    expect(listOutcomes(env.store).filter((o) => o.source === 'what_changed')).toEqual([]);
    const lineage = listOutcomes(env.store).filter((o) => o.subjectType === 'fact_version');
    expect(lineage.map((o) => [o.subjectId, o.label]).sort()).toEqual(
      [[price!.id, 'confirmed'], [plans!.id, 'changed'], [free!.id, 'retracted']].sort(),
    );
    expect([...counts(lineage).values()].every((n) => n === 1)).toBe(true);

    // The hook returns the run's lineage outcomes and writes nothing on a replay.
    const before = listOutcomes(env.store).length;
    const again = recordWhatChangedOutcomes(env.store, {
      whatChangedDecisionId: wc!.id, prev: env.store.researchRuns.get('rrun_1')!, next, changedArtifacts: [],
    });
    expect(again.map((o) => o.id).sort()).toEqual(lineageOutcomesOfRun(env.store, 'rrun_2').map((o) => o.id).sort());
    expect(again).toHaveLength(3);
    expect(listOutcomes(env.store)).toHaveLength(before);
  });

  it('unobserved facts: text fallback only against `new` facts, and `stale` once per lapse (shared with list_changes)', () => {
    const env = researchSetup(opened);
    const { store } = env;
    store.workspaces.insert({ id: 'ws_a', name: 'Acme', sector: 'saas', createdAt: 'now' });
    const rr = (id: string, at: string) => store.researchRuns.insert({ id, workspaceId: 'ws_a', phase: 'deep_dives', status: 'done', startedAt: at, scheduleId: 'sch_1' });
    const prev = rr('rrun_p', '2026-01-01T00:00:00Z');
    const next = rr('rrun_n', '2026-06-01T00:00:00Z');
    const fact = (runId: string, claim: string, extra: Record<string, unknown> = {}) => {
      const f = store.findings.insert({
        id: newId('fnd'), workspaceId: 'ws_a', runId, taskId: 'tsk_x', subject: 'Acme', claim, criteria: {}, evidence: [], status: 'verified',
        createdAt: '2026-01-01T00:00:00Z', lastConfirmedAt: '2026-01-01T00:00:00Z', ...extra,
      });
      store.decisions.insert({
        id: newId('dec'), workspaceId: 'ws_a', agentRunId: 'run_x', role: 'worker', model: { provider: 'claude', model: 'sonnet' }, kind: 'score',
        payload: { tool: 'save_finding', findingId: f.id }, refs: [f.id], promptVersion: 'pv', createdAt: '2026-01-01T00:00:00Z',
      });
      return f;
    };
    const old = fact('rrun_p', 'Acme Pro costs $10/mo');
    const v1 = fact('rrun_p', 'Acme sells three plans');
    // The next run replaced v1 (a replacement, not `new`; applied) and saved nothing else on the subject.
    const v2 = fact('rrun_n', 'Acme sells four plans', { replacesId: v1.id, lineageId: v1.id, version: 2 });
    store.findings.update(v1.id, { lifecycle: 'replaced' });
    knowledgeRepos(store).factObservations.insert({
      id: newId('obs'), workspaceId: 'ws_a', lineageId: v1.id, findingId: v2.id, priorFindingId: v1.id, kind: 'replace', runId: 'rrun_n',
      evidence: [], status: 'applied', createdAt: '2026-06-01T00:00:00Z', appliedAt: '2026-06-01T00:00:00Z',
    });
    const now = new Date('2026-06-02T00:00:00Z');
    const outs = recordWhatChangedOutcomes(store, { whatChangedDecisionId: 'dec_wc', prev, next, changedArtifacts: [], config: env.config, now });
    // No `new` fact on the subject → no text fallback; the unobserved fact is past the 90-day TTL → stale once.
    expect(outs.filter((o) => o.source === 'what_changed')).toEqual([]);
    expect(outs.map((o) => [o.subjectId, o.label])).toEqual([[old.id, 'stale']]);
    // list_changes / the briefing observing the same lapse write nothing more.
    expect(recordStaleOutcome(store, env.config, store.findings.get(old.id)!, now)!.id).toBe(outs.find((o) => o.subjectId === old.id)!.id);
    recordWhatChangedOutcomes(store, { whatChangedDecisionId: 'dec_wc', prev, next, changedArtifacts: [], config: env.config, now });
    expect(listOutcomes(store)).toHaveLength(1);

    // A `new` fact on the subject with another claim → the text fallback applies (once).
    fact('rrun_n', 'Acme Pro costs $12/mo');
    recordWhatChangedOutcomes(store, { whatChangedDecisionId: 'dec_wc', prev, next, changedArtifacts: [] });
    recordWhatChangedOutcomes(store, { whatChangedDecisionId: 'dec_wc', prev, next, changedArtifacts: [] });
    expect(listOutcomes(store).filter((o) => o.source === 'what_changed').map((o) => [o.targetId, o.outcome])).toEqual([[old.id, 'contradicted']]);
  });
});

describe('human outcomes: `user-rejected` and `duplicate-saved` once each (KS-6)', () => {
  async function handshakeNew(t: ReturnType<typeof ks4>) {
    const scope = scopeFor(t.store, 'ws_a');
    const pro = resolveEntity(t.store, scope, { kind: 'product', name: 'Acme Pro' });
    const shown = t.fact('ws_a', 'Acme Pro plan costs 49 dollars per seat per month', { entityId: pro.id });
    const page = await t.page('ws_a', 'Acme Pro: 49 dollars per seat each month.');
    const task = t.store.tasks.insert({
      id: newId('tsk'), workspaceId: 'ws_a', runId: newId('rrun'), phase: 'deep_dives', type: 'news_scan', brief: 'b',
      model: { provider: 'claude', model: 'sonnet' }, needsBrowser: false, acceptanceCriteria: ['a'], status: 'running', round: 1, createdAt: T0,
    });
    const c = t.ctx('ws_a', 'worker', { taskId: task.id });
    const claim = 'Acme Pro plan costs 49 dollars per seat each month';
    const hs = await t.call<{ saved: boolean; candidates: Array<{ id: string }> }>(c, 'save_finding', {
      claim, subject: 'Acme Pro', evidence: [page.id], entity: { kind: 'product', name: 'Acme Pro' },
    });
    expect(hs.saved).toBe(false);
    expect(hs.candidates.map((x) => x.id)).toContain(shown.id);
    // The agent insists it is new, under another product name (a new entity).
    const saved = await t.call<{ findingId: string; entityId: string }>(c, 'save_finding', {
      claim, subject: 'Acme Pro', evidence: [page.id], relation: 'new', entity: { kind: 'product', name: 'Acme Pro seat plan' },
    });
    expect(saved.entityId).not.toBe(pro.id);
    return { pro, shown, saved };
  }

  it('an entity merge joining a handshake answered `new` with a shown candidate → duplicate-saved once', async () => {
    const t = ks4(opened);
    releases.push(registerFeedbackOutcomes());
    const { pro, saved, shown } = await handshakeNew(t);
    mergeEntitiesAsUser(t.store, pro.id, saved.entityId, { actor: 'alice' });
    const [event] = listFeedback(t.store, { kind: 'entity_merge' });
    expect(event!.afterJson).toMatchObject({ duplicateSaved: [{ findingId: saved.findingId, duplicateOf: shown.id }] });
    const dup = () => listOutcomes(t.store).filter((o) => o.label === 'duplicate-saved');
    expect(dup()).toEqual([
      expect.objectContaining({ subjectId: saved.findingId, outcome: 'duplicate_saved', actor: 'alice', source: 'user_reject', role: 'worker', promptVersion: 'pv_ks4' }),
    ]);
    outcomesFromFeedback(t.store, event!); // a replayed event writes nothing more
    expect(dup()).toHaveLength(1);
  });

  it('retracting it as a duplicate → `retracted`/user-rejected and duplicate-saved, once each; a plain retraction → no duplicate-saved', async () => {
    const t = ks4(opened);
    releases.push(registerFeedbackOutcomes());
    const { saved, shown } = await handshakeNew(t);
    retractFactByUser(t.store, saved.findingId, { actor: 'alice', reason: 'same fact', duplicateOf: shown.id });
    const [event] = listFeedback(t.store, { kind: 'fact_retract' });
    outcomesFromFeedback(t.store, event!);
    const mine = listOutcomes(t.store).filter((o) => o.subjectId === saved.findingId);
    expect(mine.map((o) => [o.outcome, o.label]).sort()).toEqual([['duplicate_saved', 'duplicate-saved'], ['retracted', 'user-rejected']]);
    expect(mine.every((o) => o.actor === 'alice')).toBe(true);

    // A fact saved without a handshake, retracted as a duplicate: the agent was never shown it — no label.
    const plain = t.fact('ws_a', 'Acme is based in Berlin');
    t.store.decisions.insert({
      id: newId('dec'), workspaceId: 'ws_a', agentRunId: 'arun_x', role: 'worker', model: { provider: 'claude', model: 'sonnet' }, kind: 'score',
      payload: { tool: 'save_finding', findingId: plain.id, relation: 'new' }, refs: [plain.id], promptVersion: 'pv', createdAt: T0,
    });
    retractFactByUser(t.store, plain.id, { duplicateOf: shown.id });
    expect(listOutcomes(t.store).filter((o) => o.subjectId === plain.id).map((o) => o.label)).toEqual(['user-rejected']);
    // Other-tree or same-lineage targets are refused.
    const other = t.fact('ws_a', 'Acme ships weekly');
    expect(() => retractFactByUser(t.store, other.id, { duplicateOf: t.fact('ws_b', 'Beta x').id })).toThrow(/not found/);
    expect(() => retractFactByUser(t.store, other.id, { duplicateOf: other.id })).toThrow(/own lineage/);
  });
});
