// @vitest-environment jsdom
import { act, cleanup, render, renderHook, screen, waitFor } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  RUN_EVENTS_PAGE, describeRunEvent, formatRate, formatTokens, formatUsd, groupCalibrationVersions, useCalibrationHistory, useCosts,
  useRunEvents,
} from '../../web/src/logic/usage.js';
import { App } from '../../web/src/views/App.js';

type Handler = (url: URL, body: unknown) => unknown;
let routes: Record<string, Handler>;
let calls: Array<{ method: string; path: string }>;

async function fakeFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const url = new URL(String(input), 'http://localhost');
  const method = (init?.method ?? 'GET').toUpperCase();
  calls.push({ method, path: url.pathname + url.search });
  const h = routes[`${method} ${url.pathname}`];
  const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : null;
  const data = h ? h(url, body) : method === 'GET' ? [] : { error: 'not found' };
  return new Response(JSON.stringify(data), { status: h || method === 'GET' ? 200 : 404, headers: { 'content-type': 'application/json' } });
}

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  private readonly listeners = new Map<string, Set<(e: { data: string }) => void>>();
  constructor(readonly url: string) {
    FakeEventSource.instances.push(this);
  }
  addEventListener(type: string, fn: (e: { data: string }) => void) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(fn);
  }
  removeEventListener(type: string, fn: (e: { data: string }) => void) {
    this.listeners.get(type)?.delete(fn);
  }
  close() {}
  emit(data: unknown) {
    for (const fn of this.listeners.get('message') ?? []) fn({ data: JSON.stringify(data) });
  }
}

beforeEach(() => {
  routes = {};
  calls = [];
  FakeEventSource.instances = [];
  vi.stubGlobal('fetch', vi.fn(fakeFetch));
  vi.stubGlobal('EventSource', FakeEventSource);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.location.hash = '';
});

const totals = (costUsd: number, totalTokens = 1000) => ({
  runs: 1, inputTokens: totalTokens, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens, costUsd, cliReportedCostUsd: 0, unpriced: 0,
});
const report = (costUsd: number) => ({
  pricing: { version: '2026-11-03', effectiveDate: '2026-11-03', currency: 'USD' },
  total: totals(costUsd),
  byWorkspace: [], byTask: [], byRole: [{ key: 'worker', label: 'worker', ...totals(costUsd) }], byModel: [], byPromptVersion: [],
  budgets: [],
});
const version = (id: string, role: string, source: string, createdAt: string) => ({
  id, rootWorkspaceId: 'ws_1', role, text: `${id} text`, source, actor: 'local-user', createdAt,
});

describe('usage logic', () => {
  it('formats money, tokens, rates and run events', () => {
    expect(formatUsd(0.01234)).toBe('$0.0123');
    expect(formatUsd(12)).toBe('$12.00');
    expect(formatUsd(null)).toBe('—');
    expect(formatTokens(1500)).toBe('1.5k');
    expect(formatTokens(2_500_000)).toBe('2.5M');
    expect(formatRate(0.625)).toBe('63%');
    expect(formatRate(null)).toBe('—');
    expect(describeRunEvent({ t: 'tool_result', name: 'save_finding', ok: false })).toBe('← save_finding FAILED');
    expect(describeRunEvent({ t: 'usage', inputTokens: 10, outputTokens: 2, cacheReadTokens: 4 })).toContain('cache read 4');
  });

  it('useCosts reloads when a run of the workspace finishes', async () => {
    let cost = 1;
    routes['GET /api/costs'] = () => report(cost);
    const { result } = renderHook(() => useCosts('ws_1'));
    await waitFor(() => expect(result.current.report?.total.costUsd).toBe(1));
    expect(calls[0]!.path).toBe('/api/costs?workspaceId=ws_1');
    cost = 2;
    act(() => FakeEventSource.instances[0]!.emit({ type: 'run_status', workspaceId: 'ws_1', agentRunId: 'a', status: 'done' }));
    await waitFor(() => expect(result.current.report?.total.costUsd).toBe(2));
  });

  it('useRunEvents pages through a run and restarts at page 1 for another run', async () => {
    routes['GET /api/runs/arun_1/events'] = (url) => ({
      runId: 'arun_1', total: 250, offset: Number(url.searchParams.get('offset')), limit: RUN_EVENTS_PAGE,
      events: [{ t: 'message', text: `from ${url.searchParams.get('offset')}` }],
    });
    routes['GET /api/runs/arun_2/events'] = () => ({ runId: 'arun_2', total: 1, offset: 0, limit: RUN_EVENTS_PAGE, events: [] });
    routes['GET /api/runs/arun_1'] = () => ({ run: { id: 'arun_1' }, attempts: [], usage: totals(0), usageRows: [] });
    const { result, rerender } = renderHook(({ id }) => useRunEvents(id), { initialProps: { id: 'arun_1' as string | null } });
    await waitFor(() => expect(result.current.total).toBe(250));
    expect(result.current).toMatchObject({ from: 1, to: 100, canPrev: false, canNext: true });
    act(() => result.current.next());
    await waitFor(() => expect(result.current.events).toEqual([{ t: 'message', text: 'from 100' }]));
    act(() => result.current.next());
    await waitFor(() => expect(result.current).toMatchObject({ from: 201, to: 250, canNext: false }));
    rerender({ id: 'arun_2' });
    await waitFor(() => expect(result.current.total).toBe(1));
    expect(result.current.offset).toBe(0);
  });

  it('groups calibration versions per role (last = current) and reverts on request only', async () => {
    const versions = [
      version('cal_1', 'worker', 'import', '1'), version('cal_2', 'worker', 'apply', '2'), version('cal_3', 'reviewer', 'apply', '3'),
    ];
    routes['GET /api/workspaces/ws_1/calibration/versions'] = () => versions;
    routes['POST /api/workspaces/ws_1/calibration/versions/cal_1/revert'] = () => {
      versions.push({ ...version('cal_4', 'worker', 'revert', '4'), revertedFrom: 'cal_1' } as never);
      return { path: '/x/worker.md', version: versions.at(-1), decisionId: 'dec_9' };
    };
    expect(groupCalibrationVersions(versions as never).map((g) => [g.role, g.current.id])).toEqual([['reviewer', 'cal_3'], ['worker', 'cal_2']]);
    const { result } = renderHook(() => useCalibrationHistory('ws_1'));
    await waitFor(() => expect(result.current.roles).toHaveLength(2));
    expect(calls.some((c) => c.method === 'POST')).toBe(false);
    await act(async () => {
      await result.current.revert('cal_1');
    });
    expect(result.current.reverted).toMatchObject({ decisionId: 'dec_9' });
    await waitFor(() => expect(result.current.roles.find((g) => g.role === 'worker')!.current.id).toBe('cal_4'));
  });
});

describe('usage page', () => {
  it('shows costs, prompt-version trend, calibration history and the run event viewer', async () => {
    routes['GET /api/costs'] = () => ({
      ...report(1.5),
      budgets: [{ kind: 'workspace', id: 'ws_1', cap: { maxCostUsd: 10 }, extensions: 0, effectiveCap: { maxCostUsd: 10 }, spent: { tokens: 1000, costUsd: 1.5 }, exceeded: false, denied: false }],
    });
    routes['GET /api/workspaces/ws_1/metrics/prompt-versions'] = () => [
      { role: 'worker', promptVersion: 'aaaa0001', firstSeen: '2026-01-01', lastSeen: '2026-01-02', runs: 3, failedRuns: 0, ratings: 4, agreeRate: 0.5, meanDelta: 0.25, tasks: 2, verified: 1, unverified: 1, failed: 0, passRate: 0.5, firstRoundPassRate: 0.5, meanRounds: 2, costUsd: 1, totalTokens: 900 },
    ];
    routes['GET /api/workspaces/ws_1/calibration/versions'] = () => [version('cal_1', 'worker', 'import', '1'), version('cal_2', 'worker', 'apply', '2')];
    routes['GET /api/workspaces/ws_1/agent-runs'] = () => [
      { id: 'arun_1', workspaceId: 'ws_1', role: 'worker', model: { provider: 'claude', model: 'sonnet' }, status: 'failed', startedAt: '2026-01-01', promptVersion: 'aaaa0001', attempts: 2, failureReason: 'idle timeout', usage: totals(0.5) },
    ];
    routes['GET /api/runs/arun_1/events'] = () => ({ runId: 'arun_1', total: 1, offset: 0, limit: 100, events: [{ t: 'message', text: 'hello from the agent' }] });
    routes['GET /api/runs/arun_1'] = () => ({ run: { id: 'arun_1' }, attempts: [{ id: 'att', attempt: 1, exitCode: 1, rateLimited: true, backoffMs: 30000, startedAt: 'a', endedAt: 'b', runId: 'arun_1', workspaceId: 'ws_1' }], usage: totals(0.5), usageRows: [] });
    routes['GET /api/prompts/aaaa0001'] = () => ({ hash: 'aaaa0001', role: 'worker', text: 'You are a worker (prompt text).', createdAt: '' });

    window.location.hash = '#/w/ws_1/usage';
    render(<App />);
    expect((await screen.findAllByText('$1.50')).length).toBeGreaterThan(0);
    expect(screen.getByText(/pricing 2026-11-03/)).toBeTruthy();
    expect(await screen.findByText('idle timeout')).toBeTruthy();
    expect(screen.getAllByText('aaaa0001').length).toBeGreaterThan(0);
    // Only an older version can be reverted to.
    expect(screen.getAllByRole('button', { name: 'Revert to this' })).toHaveLength(1);

    await act(async () => {
      screen.getByRole('button', { name: 'Events' }).click();
    });
    expect(await screen.findByText('hello from the agent')).toBeTruthy();
    expect(screen.getByText(/rate limited/)).toBeTruthy();

    await act(async () => {
      screen.getAllByRole('button', { name: 'aaaa0001' })[0]!.click();
    });
    expect(await screen.findByText('You are a worker (prompt text).')).toBeTruthy();
  });

  it('the view never calls fetch itself', () => {
    const src = readFileSync(join(import.meta.dirname, '../../web/src/views/Usage.tsx'), 'utf8');
    expect(src).not.toMatch(/\bfetch\(/);
    expect(src).not.toMatch(/logic\/api/);
  });
});
