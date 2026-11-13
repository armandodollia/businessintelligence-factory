import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readRunEvents } from '../../src/core/harness/runEvents.js';
import { promptVersionMetrics } from '../../src/core/metrics/promptMetrics.js';
import { recordUsage } from '../../src/core/metrics/usage.js';
import { calibrationAppendix, loadPrompt } from '../../src/core/prompts/index.js';
import {
  actorOf, applyPromptPatchVersioned, calibrationHistory, revertCalibration,
} from '../../src/core/scoring/calibrationHistory.js';
import { defaultConfig } from '../../src/core/config/schema.js';
import { openStore, type Store } from '../../src/core/store/db.js';
import type { AgentRun, Task } from '../../src/core/types.js';

const opened: Store[] = [];
afterEach(() => {
  for (const s of opened.splice(0)) s.close();
});
function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'bif-lm-'));
  const store = openStore(':memory:');
  opened.push(store);
  return { dir, store };
}

const patch = (n: number) => ({
  role: 'worker' as const,
  examples: [],
  patchText: `## Calibration examples (approved by the user)\n\n${n}. finding "F${n}" — \`impact\`: you said 2; the user says 4.\n`,
});

describe('versioned calibration', () => {
  it('keeps every applied version and reverts to any of them (prompt version follows)', () => {
    const { dir, store } = setup();
    const scope = { dataDir: dir, rootWorkspaceId: 'ws_root' };
    const v0 = loadPrompt('worker', scope).version;
    const a1 = applyPromptPatchVersioned(store, patch(1), scope, 'alice');
    const v1 = loadPrompt('worker', scope).version;
    const a2 = applyPromptPatchVersioned(store, patch(2), scope, 'alice');
    expect(a2.text).toContain('F1');
    expect(a2.text).toContain('F2');
    const hist = calibrationHistory(store, scope, 'worker');
    expect(hist.map((h) => h.source)).toEqual(['import', 'apply', 'apply']);
    expect(hist[0]!.text).toBe(''); // baseline: no calibration before the first patch
    expect(hist[1]).toMatchObject({ id: a1.version.id, actor: 'alice', rootWorkspaceId: 'ws_root' });

    const r = revertCalibration(store, scope, a1.version.id, 'alice');
    expect(readFileSync(r.path, 'utf8')).toBe(a1.text);
    expect(loadPrompt('worker', scope).version).toBe(v1);
    expect(calibrationHistory(store, scope, 'worker').at(-1)).toMatchObject({ source: 'revert', revertedFrom: a1.version.id });

    revertCalibration(store, scope, hist[0]!.id);
    expect(calibrationAppendix('worker', scope)).toBe('');
    expect(loadPrompt('worker', scope).version).toBe(v0);
  });

  it('imports a file written without history (before migration 15 or by hand)', () => {
    const { dir, store } = setup();
    const scope = { dataDir: dir, rootWorkspaceId: 'ws_root' };
    mkdirSync(join(dir, 'ws_root', 'calibration'), { recursive: true });
    writeFileSync(join(dir, 'ws_root', 'calibration', 'reviewer.md'), 'legacy appendix\n');
    expect(calibrationHistory(store, scope, 'reviewer')).toEqual([
      expect.objectContaining({ source: 'import', text: 'legacy appendix\n', actor: 'local-user' }),
    ]);
    writeFileSync(join(dir, 'ws_root', 'calibration', 'reviewer.md'), 'edited\n');
    expect(calibrationHistory(store, scope, 'reviewer').map((h) => h.text)).toEqual(['legacy appendix\n', 'edited\n']);
    expect(calibrationHistory(store, scope, 'worker')).toEqual([]);
  });

  it('never reverts a version of another business tree', () => {
    const { dir, store } = setup();
    const a = applyPromptPatchVersioned(store, patch(1), { dataDir: dir, rootWorkspaceId: 'ws_a' });
    expect(() => revertCalibration(store, { dataDir: dir, rootWorkspaceId: 'ws_b' }, a.version.id)).toThrow(/not found/);
    expect(existsSync(join(dir, 'ws_b', 'calibration', 'worker.md'))).toBe(false);
  });

  it('actor comes from config.user.id, default local-user', () => {
    expect(actorOf(structuredClone(defaultConfig))).toBe('local-user');
    expect(actorOf({ ...structuredClone(defaultConfig), user: { id: 'bob' } } as never)).toBe('bob');
  });
});

describe('prompt version metrics', () => {
  const run = (store: Store, id: string, extra: Partial<AgentRun>) =>
    store.agentRuns.insert({
      id, workspaceId: 'ws_a', role: 'worker', model: { provider: 'claude', model: 'sonnet' }, token: `t_${id}`, status: 'done',
      startedAt: '2026-01-01T00:00:00Z', ...extra,
    });
  const task = (store: Store, id: string, extra: Partial<Task>) =>
    store.tasks.insert({
      id, workspaceId: 'ws_a', runId: 'rrun_1', phase: 'deep_dives', type: 'news_scan', brief: 'b', model: { provider: 'claude', model: 'sonnet' },
      needsBrowser: false, acceptanceCriteria: [], status: 'verified', round: 1, createdAt: 'x', ...extra,
    });

  it('groups agreement, pass rates and cost by the producing run\'s prompt version, oldest version first', () => {
    const { store } = setup();
    // Version A (older): two tasks, one verified in round 1, one unverified after 3 rounds.
    task(store, 't1', { status: 'verified', round: 1 });
    task(store, 't2', { status: 'unverified', round: 3 });
    run(store, 'r1', { taskId: 't1', promptVersion: 'aaaa0001', startedAt: '2026-01-01T00:00:00Z' });
    run(store, 'r1rev', { taskId: 't1', role: 'reviewer', promptVersion: 'rrrr0001', startedAt: '2026-01-01T00:01:00Z' });
    run(store, 'r2', { taskId: 't2', promptVersion: 'aaaa0001', startedAt: '2026-01-02T00:00:00Z', status: 'failed' });
    run(store, 'r2b', { taskId: 't2', promptVersion: 'bbbb0002', startedAt: '2026-01-02T01:00:00Z' }); // retry, not the first worker run
    // Version B (newer): one task verified in round 2.
    task(store, 't3', { status: 'verified', round: 2 });
    run(store, 'r3', { taskId: 't3', promptVersion: 'bbbb0002', startedAt: '2026-02-01T00:00:00Z' });
    // A finding saved by r1 (version A), rated: one disagree (relevance 2 → 4 on 1-5 = +0.5) and one agree.
    store.findings.insert({
      id: 'fnd_1', workspaceId: 'ws_a', runId: 'rrun_1', taskId: 't1', subject: 'Acme', claim: 'c', criteria: { relevance: 2, reliability: 4 },
      evidence: [], status: 'verified', createdAt: 'x',
    });
    store.decisions.insert({
      id: 'dec_1', workspaceId: 'ws_a', agentRunId: 'r1', role: 'worker', model: { provider: 'claude', model: 'sonnet' }, kind: 'decision',
      payload: { tool: 'save_finding', findingId: 'fnd_1' }, refs: [], promptVersion: 'aaaa0001', createdAt: 'x',
    });
    for (const [criterion, verdict, userValue] of [['relevance', 'disagree', 4], ['reliability', 'agree', undefined]] as const) {
      store.ratings.insert({
        id: `rat_${criterion}`, workspaceId: 'ws_a', targetType: 'finding', targetId: 'fnd_1', criterion,
        agentValue: criterion === 'relevance' ? 2 : 4, verdict, ...(userValue !== undefined ? { userValue } : {}), createdAt: 'x',
      });
    }
    recordUsage(store, { agentRunId: 'r1', workspaceId: 'ws_a', role: 'worker', model: { provider: 'claude', model: 'sonnet' }, promptVersion: 'aaaa0001' }, 1, {
      t: 'usage', inputTokens: 1_000_000,
    });

    const rows = promptVersionMetrics(store, 'ws_a', { role: 'worker' });
    expect(rows.map((r) => r.promptVersion)).toEqual(['aaaa0001', 'bbbb0002']);
    expect(rows[0]).toMatchObject({
      runs: 2, failedRuns: 1, ratings: 2, agreeRate: 0.5, meanDelta: 0.25, tasks: 2, verified: 1, unverified: 1,
      passRate: 0.5, firstRoundPassRate: 0.5, meanRounds: 2, costUsd: 2, totalTokens: 1_000_000,
    });
    expect(rows[1]).toMatchObject({
      runs: 2, ratings: 0, agreeRate: null, meanDelta: null, tasks: 1, passRate: 1, firstRoundPassRate: 0, meanRounds: 2,
    });
    expect(promptVersionMetrics(store, 'ws_a').map((r) => r.role)).toContain('reviewer');
  });
});

describe('run events page', () => {
  it('pages events.jsonl and skips torn lines', () => {
    const { dir } = setup();
    const runDir = join(dir, 'ws_a', 'runs', 'arun_1');
    mkdirSync(runDir, { recursive: true });
    const lines = Array.from({ length: 5 }, (_, i) => JSON.stringify({ t: 'message', text: `m${i}` }));
    writeFileSync(join(runDir, 'events.jsonl'), `${lines.join('\n')}\n{"t":"mess`);
    const page = readRunEvents(dir, { id: 'arun_1', workspaceId: 'ws_a' }, { offset: 3, limit: 10 });
    expect(page).toMatchObject({ total: 6, offset: 3, limit: 10 });
    expect(page.events).toEqual([{ t: 'message', text: 'm3' }, { t: 'message', text: 'm4' }]);
    expect(readRunEvents(dir, { id: 'nope', workspaceId: 'ws_a' })).toMatchObject({ total: 0, events: [] });
  });
});
