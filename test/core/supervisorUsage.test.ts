import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { defaultConfig, type BifConfig } from '../../src/core/config/schema.js';
import { EventBus, type BusEvent } from '../../src/core/events.js';
import { ArtifactStore } from '../../src/core/evidence/artifacts.js';
import { BudgetExceededError, budgetStatus } from '../../src/core/harness/budget.js';
import { Supervisor, type RunOptions } from '../../src/core/harness/supervisor.js';
import { TokenRegistry } from '../../src/core/harness/tokens.js';
import { createToolHandlers, resolveUserRequest } from '../../src/core/harness/tools/handlers.js';
import { recordUsage } from '../../src/core/metrics/usage.js';
import { promptVersion } from '../../src/core/prompts/index.js';
import { getPromptText } from '../../src/core/prompts/store.js';
import { openStore, type Store } from '../../src/core/store/db.js';
import { usageRepos } from '../../src/core/store/usageRepos.js';

const FAKE_CLI = join(import.meta.dirname, '../fixtures/fake-cli.mjs');
const CLAUDE_FIXTURE = readFileSync(join(import.meta.dirname, '../fixtures/claude-stream.jsonl'), 'utf8').split('\n').filter(Boolean);
const REJECTED = JSON.stringify({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected' } });

const opened: Store[] = [];
afterEach(() => {
  for (const s of opened.splice(0)) s.close();
});

function setup(cfg: (c: BifConfig) => void = () => {}) {
  const dir = mkdtempSync(join(tmpdir(), 'bif-supu-'));
  const store = openStore(join(dir, 'bif.db'));
  opened.push(store);
  const config = structuredClone(defaultConfig);
  config.providers.claude.command = FAKE_CLI;
  config.limits.idleTimeoutMs = 3000;
  cfg(config);
  const events = new EventBus();
  const seen: BusEvent[] = [];
  events.on((e) => seen.push(e));
  const tokens = new TokenRegistry(store);
  const handle = createToolHandlers({ store, artifacts: new ArtifactStore(store, dir), config, events });
  const sup = new Supervisor({
    store, config, tokens, events, handle, dataDir: dir, mcpBaseUrl: 'http://127.0.0.1:4317',
    backoff: { baseMs: 5, maxMs: 20, maxAttempts: 4 }, killGraceMs: 100,
  });
  return { dir, store, config, events, seen, sup };
}

const SYS = 'You are a worker.';
const ctx: RunOptions['ctx'] = {
  workspaceId: 'ws_a', role: 'worker', model: { provider: 'claude', model: 'sonnet' }, promptVersion: promptVersion(SYS),
};
const cli = (script: object, extra: Partial<RunOptions> = {}): RunOptions => ({
  ctx, prompt: JSON.stringify(script), systemPrompt: SYS, needsBrowser: false, ...extra,
});
const fake = (extra: Partial<RunOptions> = {}): RunOptions => ({
  ctx, prompt: 'p', systemPrompt: SYS, needsBrowser: false, fake: async () => {}, ...extra,
});

describe('supervisor usage, timing and prompt store', () => {
  it('persists usage events as agent_usage rows with cache tokens split and a computed cost', async () => {
    const { store, sup } = setup();
    const res = await sup.run(cli({ lines: CLAUDE_FIXTURE }, { meta: { round: 2, taskType: 'news_scan' } }));
    expect(res.status).toBe('done');
    const rows = usageRepos(store).agentUsage.list({ runId: res.agentRunId });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      workspaceId: 'ws_a', role: 'worker', provider: 'claude', model: 'sonnet', promptVersion: ctx.promptVersion, attempt: 1,
      inputTokens: 6, cacheWriteTokens: 38856, cacheReadTokens: 76960, outputTokens: 253, cliReportedCostUsd: 0.008798899999999998,
      priceVersion: expect.any(String),
    });
    expect(rows[0]!.costUsd).toBeGreaterThan(0);
    expect(store.agentRuns.get(res.agentRunId)).toMatchObject({ attempts: 1, round: 2, taskType: 'news_scan' });
    expect(store.agentRuns.get(res.agentRunId)!.failureReason).toBeUndefined();
  });

  it('saves the full task prompt as prompt.md and stores the prompt version text', async () => {
    const { dir, store, sup } = setup();
    const res = await sup.run(fake({ prompt: 'Research Acme pricing.' }));
    const md = readFileSync(join(dir, 'ws_a', 'runs', res.agentRunId, 'prompt.md'), 'utf8');
    expect(md).toContain(SYS);
    expect(md).toContain('Research Acme pricing.');
    expect(md).toContain(`prompt version ${ctx.promptVersion}`);
    expect(getPromptText(store, ctx.promptVersion)).toMatchObject({ role: 'worker', text: SYS });
  });

  it('records every attempt with back-off, and the attempt count on the run', async () => {
    const { dir, store, sup } = setup();
    const res = await sup.run(
      cli({ counterFile: join(dir, 'count'), attempts: [{ lines: [REJECTED], exitCode: 1 }, { lines: CLAUDE_FIXTURE }] }),
    );
    expect(res).toMatchObject({ status: 'done', attempts: 2 });
    const attempts = usageRepos(store).agentRunAttempts.list({ runId: res.agentRunId });
    expect(attempts.map((a) => [a.attempt, a.rateLimited, a.exitCode])).toEqual([[1, true, 1], [2, false, 0]]);
    expect(attempts[0]!.backoffMs).toBe(5);
    expect(attempts[1]!.backoffMs).toBeUndefined();
    expect(store.agentRuns.get(res.agentRunId)).toMatchObject({ attempts: 2 });
    expect(existsSync(join(dir, 'ws_a', 'runs', res.agentRunId, 'prompt.attempt2.md'))).toBe(true);
  });

  it('records the failure reason of a failed run', async () => {
    const { store, sup } = setup();
    const res = await sup.run(fake({ fake: async () => { throw new Error('boom'); } }));
    expect(res.status).toBe('failed');
    expect(store.agentRuns.get(res.agentRunId)!.failureReason).toBe('boom');
    const res2 = await sup.run(cli({ lines: ['not json'], exitCode: 3 }));
    expect(store.agentRuns.get(res2.agentRunId)!.failureReason).toMatch(/exit 3/);
  });
});

describe('budgets', () => {
  const spend = (store: Store, tokens: number, extra: { pipelineId?: string } = {}) =>
    recordUsage(store, { agentRunId: 'arun_prev', workspaceId: 'ws_a', role: 'worker', model: { provider: 'claude', model: 'sonnet' }, ...extra }, 1, {
      t: 'usage', inputTokens: tokens,
    });

  it('without budgets nothing is checked', async () => {
    const { store, sup } = setup();
    spend(store, 10_000_000);
    expect((await sup.run(fake())).status).toBe('done');
  });

  it('past the workspace cap a run waits for a budget request; approving extends by one cap', async () => {
    const { store, config, events, seen, sup } = setup((c) => (c.budgets = { workspace: { maxTokens: 100 } }));
    spend(store, 150);
    const pending = sup.run(fake());
    await new Promise((r) => setTimeout(r, 20));
    const req = store.userRequests.list({ workspaceId: 'ws_a', status: 'pending' });
    expect(req).toHaveLength(1);
    expect(req[0]).toMatchObject({ kind: 'approval', site: 'budget:workspace:ws_a', agentRunId: 'budget' });
    expect(seen).toContainEqual(expect.objectContaining({ type: 'user_request' }));
    // A second run waits on the same request.
    const second = sup.run(fake());
    await new Promise((r) => setTimeout(r, 20));
    expect(store.userRequests.list({ workspaceId: 'ws_a' })).toHaveLength(1);
    resolveUserRequest({ store, events }, req[0]!.id, 'resolved');
    expect((await pending).status).toBe('done');
    expect((await second).status).toBe('done');
    expect(budgetStatus(store, config, 'ws_a')[0]).toMatchObject({ extensions: 1, effectiveCap: { maxTokens: 200 }, exceeded: false });
  });

  it('denying refuses the run and later runs for the same cap, without asking again', async () => {
    const { store, events, sup, config } = setup((c) => (c.budgets = { workspace: { maxCostUsd: 0.000001 } }));
    spend(store, 1000);
    const pending = sup.run(fake());
    await new Promise((r) => setTimeout(r, 20));
    const [req] = store.userRequests.list({ workspaceId: 'ws_a', status: 'pending' });
    resolveUserRequest({ store, events }, req!.id, 'denied');
    await expect(pending).rejects.toBeInstanceOf(BudgetExceededError);
    await expect(sup.run(fake())).rejects.toBeInstanceOf(BudgetExceededError);
    expect(store.userRequests.list({ workspaceId: 'ws_a' })).toHaveLength(1);
    // Raising the cap in config lifts the denial.
    config.budgets = { workspace: { maxCostUsd: 100 } };
    expect((await sup.run(fake())).status).toBe('done');
  });

  it('pipeline caps count only the pipeline\'s usage', async () => {
    const { store, sup } = setup((c) => (c.budgets = { pipeline: { maxTokens: 100 } }));
    store.researchRuns.insert({ id: 'rrun_1', workspaceId: 'ws_a', phase: 'deep_dives', status: 'running', startedAt: 'x', pipelineId: 'pipe_1' });
    spend(store, 500); // outside any pipeline
    expect((await sup.run(fake({ meta: { researchRunId: 'rrun_1' } }))).status).toBe('done');
    spend(store, 500, { pipelineId: 'pipe_1' });
    const ac = new AbortController();
    const p = sup.run(fake({ meta: { researchRunId: 'rrun_1' }, signal: ac.signal }));
    await new Promise((r) => setTimeout(r, 20));
    expect(store.userRequests.list({ workspaceId: 'ws_a', status: 'pending' })[0]).toMatchObject({ site: 'budget:pipeline:pipe_1' });
    ac.abort();
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('usage rows of a run carry its research run and pipeline', async () => {
    const { store, sup } = setup();
    store.researchRuns.insert({ id: 'rrun_1', workspaceId: 'ws_a', phase: 'deep_dives', status: 'running', startedAt: 'x', pipelineId: 'pipe_1' });
    const res = await sup.run(cli({ lines: CLAUDE_FIXTURE }, { meta: { researchRunId: 'rrun_1' } }));
    expect(usageRepos(store).agentUsage.list({ runId: res.agentRunId })[0]).toMatchObject({ researchRunId: 'rrun_1', pipelineId: 'pipe_1' });
  });
});
