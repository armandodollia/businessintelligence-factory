/**
 * KS-6 metrics on a seeded store (design §13 "WP-B / WP-E / WP-G"): store size, freshness, retrieval
 * hit rate and zero-result rate, retrieved / used tokens per run by role / task type / prompt version /
 * model, the share of input tokens that was retrieved (joined with `agent_usage`), and the WP-E
 * signals — all for one business tree.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { recordOutcome } from '../../../src/core/learning/outcomes.js';
import { knowledgeMetrics, knowledgeSignals } from '../../../src/core/knowledge/metrics.js';
import { knowledgeRead } from '../../../src/core/knowledge/tools.js';
import { uploadInternal } from '../../../src/core/internal/uploads.js';
import { ingestorFor } from '../../../src/core/knowledge/ingest.js';
import { uploadExposure } from '../../../src/core/scoring/export.js';
import { recordUsage } from '../../../src/core/metrics/usage.js';
import type { Store } from '../../../src/core/store/db.js';
import { newId } from '../../../src/core/store/repos.js';
import { attachEventRecorders, type EventRecorders } from '../../../src/core/telemetry/recorders.js';
import type { Role } from '../../../src/core/types.js';
import { ks4, T0 } from './ks4fixture.js';

const opened: Store[] = [];
const recorders: EventRecorders[] = [];
afterEach(async () => {
  for (const r of recorders.splice(0)) await r.stop();
  for (const s of opened.splice(0)) s.close();
});

async function seeded() {
  const t = ks4(opened);
  recorders.push(attachEventRecorders({ store: t.store, events: t.events, config: t.config }));
  const task = (workspaceId: string, type: 'news_scan' | 'public_filings') =>
    t.store.tasks.insert({
      id: newId('tsk'), workspaceId, runId: newId('rrun'), phase: 'deep_dives', type, brief: 'b', model: { provider: 'claude', model: 'sonnet' },
      needsBrowser: false, acceptanceCriteria: ['a'], status: 'running', round: 1, createdAt: T0,
    });
  const run = (workspaceId: string, role: Role, taskId: string, promptVersion = 'pv_ks4') => {
    const c = t.ctx(workspaceId, role, { taskId, promptVersion });
    t.store.agentRuns.insert({ id: c.agentRunId, workspaceId, taskId, role, model: c.model, token: c.agentRunId, status: 'done', startedAt: T0, promptVersion });
    return c;
  };
  const page = await t.page('ws_a', 'Acme pricing page: the Pro plan costs 49 dollars per seat.');
  const fresh = t.fact('ws_a', 'Acme Pro costs 49 dollars per seat', { lastConfirmedAt: '2027-02-01T00:00:00.000Z' });
  t.fact('ws_c', 'Acme Payments launched in 2019'); // confirmed at T0 (2026-11-01) — stale by 2027-03
  t.fact('ws_a', 'Acme had a free tier', { lifecycle: 'retracted' });
  t.fact('ws_a', 'Acme Pro costs 39 dollars', { lifecycle: 'replaced' });
  t.fact('ws_a', 'Acme Pro costs 59 dollars', { lifecycle: 'candidate', status: 'unverified' });
  t.fact('ws_b', 'Beta Pro costs 49 dollars per seat'); // other tree

  // Run 1 (news_scan): a search that is used, a zero-result search.
  const t1 = task('ws_a', 'news_scan');
  const r1 = run('ws_a', 'worker', t1.id);
  await t.call(r1, 'search', { query: 'Pro seat' });
  await t.call(r1, 'search', { query: 'unicorn zebra' });
  await t.call(r1, 'save_finding', { claim: 'Acme bills per seat', subject: 'Acme', evidence: [page.id], relation: 'new' });
  // A screenshot without a caption and a quote that is not in the page: rejected saves.
  expect((await t.handle(r1, 'save_artifact', { kind: 'screenshot', mime: 'image/png', content_base64: 'iVBORw0KGgo=' })).ok).toBe(false);
  expect((await t.handle(r1, 'save_finding', {
    claim: 'Acme Pro has a 14-day trial', subject: 'Acme', evidence: [page.id], relation: 'new', evidence_refs: [{ artifact_id: page.id, quote: 'fourteen day trial' }],
  })).ok).toBe(false);
  // Run 2 (public_filings, other prompt version): a search hit nobody used.
  const t2 = task('ws_c', 'public_filings');
  const r2 = run('ws_c', 'worker', t2.id, 'pv_2');
  await t.call(r2, 'search', { query: 'Payments launched' });
  // Another tree's activity never counts.
  const tb = task('ws_b', 'news_scan');
  const rb = run('ws_b', 'worker', tb.id);
  await t.call(rb, 'search', { query: 'nothing matches here' });

  recordUsage(t.store, { agentRunId: r1.agentRunId, workspaceId: 'ws_a', taskId: t1.id, role: 'worker', model: r1.model, promptVersion: 'pv_ks4' }, 1, {
    t: 'usage', inputTokens: 10_000, outputTokens: 500, cacheReadTokens: 6_000,
  });
  recordUsage(t.store, { agentRunId: r2.agentRunId, workspaceId: 'ws_c', taskId: t2.id, role: 'worker', model: r2.model, promptVersion: 'pv_2' }, 1, {
    t: 'usage', inputTokens: 4_000, outputTokens: 100,
  });
  recordOutcome(t.store, {
    subjectType: 'fact_version', subjectId: fresh.id, workspaceId: 'ws_a', outcome: 'duplicate_saved', label: 'duplicate-saved', source: 'user_reject',
    sourceKey: 'feedback:fb_1', role: 'worker', promptVersion: 'pv_ks4', taskId: t1.id,
  });
  return { ...t, r1, r2, t1, t2 };
}

describe('knowledgeMetrics (KS-6)', () => {
  it('store size, freshness, retrieval rates and per-group tokens for one tree', async () => {
    const t = await seeded();
    const m = knowledgeMetrics(t.store, { workspaceId: 'ws_c', config: t.config, now: new Date('2027-03-01T00:00:00Z'), dataDir: t.artifacts.dataDir });
    expect(m.rootWorkspaceId).toBe('ws_a');
    expect(m.workspaceIds.sort()).toEqual(['ws_a', 'ws_c', 'ws_d', 'ws_g']);
    expect(m.store.facts).toEqual({ candidate: 1, current: 3, replaced: 1, retracted: 1, total: 6 });
    expect(m.store.artifacts).toBe(1);
    expect(m.store.chunks).toBeGreaterThan(0);
    expect(m.store.fileBytes).toBeGreaterThan(0);
    expect(m.freshness).toMatchObject({ currentFacts: 3, stale: 2, staleShare: 0.667 });

    const r = m.retrieval;
    expect(r.retrievals).toBe(3); // 3 searches; tree B's search not counted
    expect(r.runs).toBe(2);
    expect(r.withUse).toBe(1);
    expect(r.hitRate).toBe(0.333);
    expect(r.searches).toBe(3);
    expect(r.zeroResultSearches).toBe(1);
    expect(r.zeroResultRate).toBe(0.333);
    expect(r.usedTokens).toBeGreaterThan(0);
    expect(r.usedTokens).toBeLessThanOrEqual(r.retrievedTokens);
    const g1 = r.byGroup.find((g) => g.taskType === 'news_scan')!;
    expect(g1).toMatchObject({ role: 'worker', promptVersion: 'pv_ks4', model: 'claude/sonnet', runs: 1, retrievals: 2, withUse: 1, hitRate: 0.5, zeroResultRate: 0.5 });
    const g2 = r.byGroup.find((g) => g.taskType === 'public_filings')!;
    expect(g2).toMatchObject({ promptVersion: 'pv_2', retrievals: 1, withUse: 0, usedTokens: 0 });
    expect(g2.unusedTokens).toBe(g2.retrievedTokens);
    expect(g1.retrievedTokensPerRun).toBe(g1.retrievedTokens);
  });

  it('joins agent_usage: the share of input tokens that was retrieved, per role / model / prompt version / task', async () => {
    const t = await seeded();
    const m = knowledgeMetrics(t.store, { workspaceId: 'ws_a' });
    const retrieved1 = t.rows(t.r1.agentRunId).reduce((n, e) => n + e.tokensReturned, 0);
    const retrieved2 = t.rows(t.r2.agentRunId).reduce((n, e) => n + e.tokensReturned, 0);
    expect(m.usage.total).toMatchObject({ runs: 2, inputTokens: 14_000, retrievedTokens: retrieved1 + retrieved2 });
    expect(m.usage.total.retrievedShare).toBe(Math.round(((retrieved1 + retrieved2) / 14_000) * 1000) / 1000);
    expect(m.usage.byPromptVersion.map((g) => [g.key, g.inputTokens, g.retrievedTokens])).toEqual([
      ['worker:pv_ks4', 10_000, retrieved1],
      ['worker:pv_2', 4_000, retrieved2],
    ]);
    expect(m.usage.byTask.find((g) => g.key === t.t1.id)!.retrievedShare).toBe(Math.round((retrieved1 / 10_000) * 1000) / 1000);
    expect(m.usage.byModel.map((g) => g.key)).toEqual(['claude/sonnet']);
    // Node scope: only that workspace's rows.
    expect(knowledgeMetrics(t.store, { workspaceId: 'ws_c', scope: 'node' }).usage.total.inputTokens).toBe(4_000);
  });

  it('WP-E signals: zero-result, unused tokens, duplicate-saved, missing caption, rejected quote — with their tasks', async () => {
    const t = await seeded();
    const sig = knowledgeSignals(t.store, { workspaceId: 'ws_g' });
    const by = (kind: string, pv = 'pv_ks4') => sig.find((s) => s.kind === kind && s.promptVersion === pv);
    expect(by('zero_result')).toMatchObject({ rootWorkspaceId: 'ws_a', role: 'worker', count: 1, total: 2, rate: 0.5, taskIds: [t.t1.id] });
    expect(by('unused_tokens', 'pv_2')).toMatchObject({ count: 1, total: 1, rate: 1, taskIds: [t.t2.id] });
    expect(by('unused_tokens', 'pv_2')!.tokens).toBeGreaterThan(0);
    expect(by('duplicate_saved')).toMatchObject({ count: 1, taskIds: [t.t1.id] });
    expect(by('missing_caption')).toMatchObject({ count: 1, taskIds: [t.t1.id], examples: [t.r1.agentRunId] });
    expect(by('rejected_quote')).toMatchObject({ count: 1, taskIds: [t.t1.id] });
    // Ids only: no query or error text.
    expect(JSON.stringify(sig)).not.toMatch(/unicorn|fourteen|description|Payments/);
    // Tree B sees only its own zero-result search.
    expect(knowledgeSignals(t.store, { workspaceId: 'ws_b' }).map((s) => [s.kind, s.count])).toEqual([['zero_result', 1]]);
  });

  it('human reads (role user, KS-7 web routes) never mix into the agent figures and expose no run (design-thread ruling)', async () => {
    const t = await seeded();
    const before = knowledgeMetrics(t.store, { workspaceId: 'ws_a', config: t.config });
    const signalsBefore = knowledgeSignals(t.store, { workspaceId: 'ws_a' });
    const exposedBefore = uploadExposure(t.store).runs;
    uploadInternal('ws_a', { name: 'board.txt', bytes: new TextEncoder().encode('Confidential: churn rose to 14 percent.'), mime: 'text/plain' }, t);
    await ingestorFor(t).idle();
    const user = { workspaceId: 'ws_a', role: 'user' as const };
    for (const query of ['churn', 'nothing at all matches', 'Pro seat']) {
      expect(knowledgeRead({ store: t.store, config: t.config, events: t.events }, user, 'search', { query }).ok).toBe(true);
    }
    const after = knowledgeMetrics(t.store, { workspaceId: 'ws_a', config: t.config });
    expect(after.retrieval.user).toMatchObject({ reads: 3, searches: 3, zeroResultSearches: 1 });
    expect(after.retrieval.user.tokensReturned).toBeGreaterThan(0);
    const { user: _u1, ...agentAfter } = after.retrieval;
    const { user: _u0, ...agentBefore } = before.retrieval;
    expect(agentAfter).toEqual(agentBefore);
    expect(after.usage).toEqual(before.usage);
    expect(knowledgeSignals(t.store, { workspaceId: 'ws_a' })).toEqual(signalsBefore);
    // No agent run: nothing becomes upload-exposed although the user read upload text.
    expect([...uploadExposure(t.store).runs]).toEqual([...exposedBefore]);
  });
});
