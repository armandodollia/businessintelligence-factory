import { afterEach, describe, expect, it } from 'vitest';
import { computeCost, defaultPricing, priceFor, type PriceTable } from '../../src/core/harness/pricing.js';
import { costReport, recordUsage, resolveRunScope, usageTotals } from '../../src/core/metrics/usage.js';
import { getPromptText, promptStoreGaps, recordPromptVersion, recordRunPrompt } from '../../src/core/prompts/store.js';
import { promptVersion } from '../../src/core/prompts/index.js';
import { openStore, type Store } from '../../src/core/store/db.js';
import { usageRepos } from '../../src/core/store/usageRepos.js';

const opened: Store[] = [];
afterEach(() => {
  for (const s of opened.splice(0)) s.close();
});
function store(): Store {
  const s = openStore(':memory:');
  opened.push(s);
  return s;
}

const TABLE: PriceTable = {
  version: 'test-1',
  effectiveDate: '2026-01-01',
  currency: 'USD',
  models: {
    sonnet: { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 },
    'codex/gpt-x': { input: 1, output: 4 },
  },
  aliases: { 'claude-sonnet-5-5': 'sonnet' },
};

describe('pricing', () => {
  it('ships a dated, editable default table covering the example config models', () => {
    const t = defaultPricing();
    expect(t.version).toMatch(/\d{4}-\d{2}-\d{2}/);
    expect(t.effectiveDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    for (const [provider, model] of [['claude', 'opus'], ['claude', 'sonnet'], ['claude', 'haiku'], ['codex', 'gpt-6.1-sol']] as const) {
      expect(priceFor(t, provider, model), `${provider}/${model}`).toBeDefined();
    }
  });

  it('looks up provider/model, bare model, aliases and provider-prefixed (OpenCode) names', () => {
    expect(priceFor(TABLE, 'claude', 'sonnet')).toMatchObject({ input: 2 });
    expect(priceFor(TABLE, 'claude', 'claude-sonnet-5-5')).toMatchObject({ input: 2 });
    expect(priceFor(TABLE, 'opencode', 'anthropic/claude-sonnet-5-5')).toMatchObject({ input: 2 });
    expect(priceFor(TABLE, 'codex', 'gpt-x')).toMatchObject({ input: 1 });
    expect(priceFor(TABLE, 'claude', 'gpt-x')).toBeUndefined();
    expect(priceFor(TABLE, 'claude', 'unknown')).toBeUndefined();
  });

  it('computes cost per million tokens; cache prices default to the input price', () => {
    expect(computeCost(TABLE.models.sonnet!, { input: 1_000_000, output: 100_000, cacheRead: 1_000_000, cacheWrite: 400_000 })).toBeCloseTo(
      2 + 1 + 0.1 + 1,
    );
    expect(computeCost(TABLE.models['codex/gpt-x']!, { input: 0, output: 0, cacheRead: 1_000_000, cacheWrite: 0 })).toBeCloseTo(1);
  });
});

describe('usage', () => {
  const run = (over: Partial<Parameters<typeof recordUsage>[1]> = {}) => ({
    agentRunId: 'arun_1', workspaceId: 'ws_a', role: 'worker' as const, model: { provider: 'claude' as const, model: 'sonnet' },
    promptVersion: 'pv1', ...over,
  });

  it('records a usage event with disjoint token columns, computed and CLI-reported cost', () => {
    const s = store();
    const u = recordUsage(s, run({ taskId: 'tsk_1' }), 1, {
      t: 'usage', inputTokens: 1000, outputTokens: 200, cacheReadTokens: 600, cacheWriteTokens: 100, costUsd: 0.5,
    }, TABLE);
    expect(u).toMatchObject({
      runId: 'arun_1', taskId: 'tsk_1', inputTokens: 300, cacheReadTokens: 600, cacheWriteTokens: 100, outputTokens: 200,
      cliReportedCostUsd: 0.5, priceVersion: 'test-1', provider: 'claude', model: 'sonnet', promptVersion: 'pv1', attempt: 1,
    });
    expect(u.costUsd).toBeCloseTo((300 * 2 + 200 * 10 + 600 * 0.1 + 100 * 2.5) / 1e6);
    expect(usageRepos(s).agentUsage.list({ runId: 'arun_1' })).toHaveLength(1);
  });

  it('unknown model: no computed cost, the CLI cost is the effective cost', () => {
    const s = store();
    const u = recordUsage(s, run({ model: { provider: 'claude', model: 'mystery' } }), 1, { t: 'usage', inputTokens: 10, costUsd: 0.25 }, TABLE);
    expect(u.costUsd).toBeUndefined();
    expect(u.priceVersion).toBeUndefined();
    expect(usageTotals(s, { workspaceId: 'ws_a' })).toMatchObject({ costUsd: 0.25, inputTokens: 10, unpriced: 0 });
    recordUsage(s, run({ agentRunId: 'arun_2', model: { provider: 'claude', model: 'mystery' } }), 1, { t: 'usage', inputTokens: 5 }, TABLE);
    expect(usageTotals(s, { workspaceId: 'ws_a' })).toMatchObject({ unpriced: 1, runs: 2, totalTokens: 15 });
  });

  it('cost report groups by workspace, task, role, model and prompt version', () => {
    const s = store();
    s.tasks.insert({
      id: 'tsk_1', workspaceId: 'ws_a', runId: 'rrun_1', phase: 'deep_dives', type: 'news_scan', brief: 'b', subject: 'Acme',
      model: { provider: 'claude', model: 'sonnet' }, needsBrowser: false, acceptanceCriteria: [], status: 'verified', round: 1,
      createdAt: new Date().toISOString(),
    });
    recordUsage(s, run({ taskId: 'tsk_1' }), 1, { t: 'usage', inputTokens: 1_000_000 }, TABLE);
    recordUsage(s, run({ agentRunId: 'arun_2', taskId: 'tsk_1', role: 'reviewer', model: { provider: 'codex', model: 'gpt-x' }, promptVersion: 'pv2' }), 1, {
      t: 'usage', outputTokens: 1_000_000,
    }, TABLE);
    recordUsage(s, run({ agentRunId: 'arun_3', workspaceId: 'ws_b' }), 1, { t: 'usage', inputTokens: 1_000_000 }, TABLE);

    const all = costReport(s);
    expect(all.total.costUsd).toBeCloseTo(2 + 4 + 2);
    expect(all.byWorkspace.map((g) => [g.key, g.costUsd])).toEqual([['ws_a', 6], ['ws_b', 2]]);

    const a = costReport(s, { workspaceId: 'ws_a' });
    expect(a.total).toMatchObject({ runs: 2, costUsd: 6 });
    expect(a.byRole.map((g) => g.key).sort()).toEqual(['reviewer', 'worker']);
    expect(a.byModel.find((g) => g.key === 'codex/gpt-x')!.costUsd).toBeCloseTo(4);
    expect(a.byPromptVersion.map((g) => g.key).sort()).toEqual(['reviewer:pv2', 'worker:pv1']);
    expect(a.byTask).toEqual([expect.objectContaining({ key: 'tsk_1', label: 'news_scan: Acme', costUsd: 6 })]);
    expect(a.pricing).toMatchObject({ version: expect.any(String), effectiveDate: expect.any(String) });
  });

  it('resolves a run to its research run and pipeline (task, explicit, or the running research run)', () => {
    const s = store();
    s.researchRuns.insert({ id: 'rrun_1', workspaceId: 'ws_a', phase: 'deep_dives', status: 'running', startedAt: 'x', pipelineId: 'pipe_1' });
    s.tasks.insert({
      id: 'tsk_1', workspaceId: 'ws_a', runId: 'rrun_1', phase: 'deep_dives', type: 'news_scan', brief: 'b',
      model: { provider: 'claude', model: 'sonnet' }, needsBrowser: false, acceptanceCriteria: [], status: 'queued', round: 1, createdAt: 'x',
    });
    expect(resolveRunScope(s, { workspaceId: 'ws_a', taskId: 'tsk_1', role: 'worker' })).toEqual({ researchRunId: 'rrun_1', pipelineId: 'pipe_1' });
    expect(resolveRunScope(s, { workspaceId: 'ws_a', researchRunId: 'rrun_1', role: 'orchestrator' })).toEqual({ researchRunId: 'rrun_1', pipelineId: 'pipe_1' });
    expect(resolveRunScope(s, { workspaceId: 'ws_a', role: 'persona' })).toEqual({ researchRunId: 'rrun_1', pipelineId: 'pipe_1' });
    // The interviewer runs outside pipelines.
    expect(resolveRunScope(s, { workspaceId: 'ws_a', role: 'interviewer' })).toEqual({});
  });
});

describe('prompt store', () => {
  it('records each prompt version once and resolves the hash to its text', () => {
    const s = store();
    const hash = recordPromptVersion(s, 'worker', 'You are a worker.');
    expect(hash).toBe(promptVersion('You are a worker.'));
    expect(recordPromptVersion(s, 'worker', 'You are a worker.')).toBe(hash);
    expect(getPromptText(s, hash)).toMatchObject({ hash, role: 'worker', text: 'You are a worker.' });
    expect(getPromptText(s, 'deadbeef')).toBeUndefined();
  });

  it('recordRunPrompt keeps the exact text when the hash matches, and never overwrites it', () => {
    const s = store();
    const exact = 'system\ntemplate';
    const hash = promptVersion(exact);
    recordPromptVersion(s, 'persona', exact);
    recordRunPrompt(s, 'persona', hash, 'system'); // run system prompt alone does not hash to `hash`
    expect(getPromptText(s, hash)!.text).toBe(exact);
    // No exact text known: the run's system prompt is stored so the hash still resolves.
    recordRunPrompt(s, 'persona', 'abcd1234', 'system only');
    expect(getPromptText(s, 'abcd1234')!.text).toBe('system only');
  });

  it('promptStoreGaps lists recorded versions without text (system decisions excluded)', () => {
    const s = store();
    const hash = recordPromptVersion(s, 'worker', 'w');
    s.agentRuns.insert({
      id: 'arun_1', workspaceId: 'ws_a', role: 'worker', model: { provider: 'claude', model: 'sonnet' }, token: 't1', status: 'done',
      startedAt: 'x', promptVersion: hash,
    });
    s.agentRuns.insert({
      id: 'arun_2', workspaceId: 'ws_a', role: 'worker', model: { provider: 'claude', model: 'sonnet' }, token: 't2', status: 'done',
      startedAt: 'x', promptVersion: 'missing1',
    });
    s.decisions.insert({
      id: 'dec_1', workspaceId: 'ws_a', agentRunId: 'user', role: 'orchestrator', model: { provider: 'claude', model: 'none' },
      kind: 'decision', payload: {}, refs: [], promptVersion: 'n/a', createdAt: 'x',
    });
    expect(promptStoreGaps(s)).toEqual(['missing1']);
  });
});
