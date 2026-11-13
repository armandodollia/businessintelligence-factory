import { afterEach, describe, expect, it } from 'vitest';
import type { FakeScript } from '../../src/core/harness/adapter.js';
import { defaultTaskModel, orchestratorPrompt, startPhase } from '../../src/core/research/orchestrator.js';
import { researchToolHandlers } from '../../src/core/research/tools.js';
import type { Store } from '../../src/core/store/db.js';
import { researchSetup, type Picker } from './helpers/research.js';

const opened: Store[] = [];
afterEach(() => {
  for (const s of opened.splice(0)) s.close();
});

function setup(pick: Picker) {
  const s = researchSetup(opened, {
    extraHandlers: () => researchToolHandlers(),
    config: (c) => {
      c.roles.workers.news_scan = { provider: 'claude', model: 'haiku' };
      c.roles.synthesizer = { provider: 'claude', model: 'opus' };
    },
    pick,
  });
  s.store.workspaces.insert({ id: 'ws_a', name: 'Acme', sector: 'saas', createdAt: 'now' });
  return s;
}

const task = (type: string, extra: Record<string, unknown> = {}) => ({
  type, brief: `do ${type}`, needs_browser: false, acceptance_criteria: ['c'], ...extra,
});

describe('propose_tasks model defaults', () => {
  it('defaultTaskModel: per-type worker, else default worker; synthesis uses the synthesizer', () => {
    const s = setup(() => undefined);
    expect(defaultTaskModel(s.config, 'news_scan')).toEqual({ provider: 'claude', model: 'haiku' });
    expect(defaultTaskModel(s.config, 'discover_competitors')).toEqual(s.config.roles.workers.default);
    expect(defaultTaskModel(s.config, 'synthesize_recommendations')).toEqual({ provider: 'claude', model: 'opus' });
  });

  it('omitted model takes the configured default; an explicit override is recorded as such', async () => {
    const results: unknown[] = [];
    const orchestrate: FakeScript = async (t) => {
      results.push(
        await t.call('propose_tasks', {
          tasks: [
            task('news_scan'),
            task('discover_competitors'),
            task('discover_competitors', { brief: 'sweep 2', model: { provider: 'codex', model: 'gpt-6.1-sol' } }),
            task('news_scan', { brief: 'same as default', model: { provider: 'claude', model: 'haiku' } }),
          ],
        }),
      );
    };
    const s = setup((r) => (r.kind === 'orchestrate' && r.round === 1 ? orchestrate : r.kind === 'orchestrate' ? async () => {} : undefined));
    // Tasks are created and then fail (no worker script); only the proposal matters here.
    await startPhase('ws_a', 'competitor_discovery', s.deps);
    const prompt = s.requests.find((r) => r.kind === 'orchestrate')!.prompt;
    expect(prompt).toContain('## Default model per task type');
    expect(prompt).toContain('- news_scan: {"provider":"claude","model":"haiku"}');
    expect(prompt).toContain(`- discover_competitors: ${JSON.stringify(s.config.roles.workers.default)}`);

    const tasks = s.store.tasks.list({ workspaceId: 'ws_a' });
    expect(tasks.map((t) => t.model)).toEqual([
      { provider: 'claude', model: 'haiku' },
      s.config.roles.workers.default,
      { provider: 'codex', model: 'gpt-6.1-sol' },
      { provider: 'claude', model: 'haiku' },
    ]);
    const res = results[0] as { accepted: Array<{ modelSource: string }>; modelOverrides: Array<{ index: number; model: unknown; defaultModel: unknown }> };
    expect(res.accepted.map((a) => a.modelSource)).toEqual(['default', 'default', 'override', 'default']);
    expect(res.modelOverrides).toEqual([
      expect.objectContaining({ index: 2, model: { provider: 'codex', model: 'gpt-6.1-sol' }, defaultModel: s.config.roles.workers.default }),
    ]);
    const decision = s.store.decisions.list({ workspaceId: 'ws_a', kind: 'task_proposal' })[0]!;
    expect((decision.payload as { result: { modelOverrides: unknown[] } }).result.modelOverrides).toHaveLength(1);
  });

  it('orchestratorPrompt lists synthesizer default for synthesis', () => {
    const s = setup(() => undefined);
    s.store.researchRuns.insert({ id: 'rrun_s', workspaceId: 'ws_a', phase: 'synthesis', status: 'running', startedAt: 'now' });
    const p = orchestratorPrompt(s.store, s.config, s.store.researchRuns.get('rrun_s')!, 1);
    expect(p).toContain('- synthesize_recommendations: {"provider":"claude","model":"opus"}');
  });
});
