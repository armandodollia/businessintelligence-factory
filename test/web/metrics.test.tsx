// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_METRICS_FILTER, chartGeometry, formatMetric, metricsQuery, useExportSummaryOnDemand, useMetrics,
} from '../../web/src/logic/metrics.js';
import { App } from '../../web/src/views/App.js';

let calls: string[];
const emptyRow = {
  runs: 0, failedRuns: 0, failureRate: null, attempts: 0, rateLimitedAttempts: 0, tasks: 0, verified: 0, unverified: 0, failed: 0,
  passRate: null, firstRoundPassRate: null, meanRounds: null, reviewIssues: 0, ratings: 0, agrees: 0, agreeRate: null, meanDelta: null,
  costUsd: 0, totalTokens: 0, outcomes: 0, outcomeCounts: {},
};
const report = (groupBy = 'role') => ({
  rootWorkspaceId: 'ws_1', workspaceIds: ['ws_1'], scope: 'tree', window: { since: null, until: null }, groupBy, bucket: 'day',
  experiments: { included: false, excludedRuns: 2 },
  totals: { ...emptyRow, runs: 3, tasks: 2, verified: 1, passRate: 0.5, costUsd: 1.25 },
  groups: [{ key: 'worker', firstSeen: null, lastSeen: null, ...emptyRow, runs: 3, tasks: 2, verified: 1, passRate: 0.5, outcomes: 1, outcomeCounts: { confirmed: 1 } }],
  series: [
    { bucket: '2026-11-02', ...emptyRow, runs: 2, tasks: 1, verified: 1, passRate: 1, costUsd: 1 },
    { bucket: '2026-11-03', ...emptyRow },
    { bucket: '2026-11-04', ...emptyRow, runs: 1, tasks: 1, passRate: 0, costUsd: 0.25 },
  ],
  groupSeries: [],
  failuresByReason: [{ reason: 'idle timeout', runs: 1 }],
  reviewIssuesByClass: [{ class: 'substantive', issues: 2, tasks: 1 }],
  outcomeLabels: ['confirmed', 'run-failed'],
  knowledge: {
    store: { facts: { candidate: 0, current: 3, replaced: 0, retracted: 0, total: 3 }, observations: 0, artifacts: 1, imagesWithoutDescription: 0, chunks: 4, textChars: 10, fileBytes: null, entities: 0, relations: 0 },
    freshness: { currentFacts: 3, stale: 1, staleShare: 0.333 },
    retrieval: { retrievals: 4, user: { reads: 7, searches: 2, zeroResultSearches: 1, tokensReturned: 90 }, runs: 2, withUse: 1, hitRate: 0.25, searches: 2, zeroResultSearches: 1, zeroResultRate: 0.5, retrievedTokens: 400, usedTokens: 100 },
    retrievedShare: 0.1,
    byGroup: [],
  },
  lessons: null,
});

async function fakeFetch(input: string | URL | Request): Promise<Response> {
  const url = new URL(String(input), 'http://localhost');
  calls.push(url.pathname + url.search);
  let body: unknown = [];
  if (url.pathname === '/api/workspaces/ws_1/metrics') body = report(url.searchParams.get('groupBy') ?? 'role');
  else if (url.pathname === '/api/workspaces/ws_1/export/summary') {
    body = {
      includeUploads: false, note: 'Export with includeUploads to include them.',
      excludedJudgments: { total: 2, byCause: [{ cause: 'cites_upload', label: 'cites an upload', count: 2 }] },
      excludedOtherLines: { total: 0, byCause: [] },
    };
  } else if (url.pathname === '/api/workspaces/ws_1') body = { id: 'ws_1', name: 'Acme', sector: 'saas' };
  else if (url.pathname === '/api/workspaces') body = [{ id: 'ws_1', name: 'Acme', sector: 'saas', children: [] }];
  return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
}

class NoopEventSource {
  addEventListener() {}
  removeEventListener() {}
  close() {}
}

beforeEach(() => {
  calls = [];
  vi.stubGlobal('fetch', vi.fn(fakeFetch));
  vi.stubGlobal('EventSource', NoopEventSource);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.location.hash = '';
});

describe('metrics logic (WP-G)', () => {
  it('builds the query: defaults, a date-only until covers its whole day, experiments only when on', () => {
    expect(metricsQuery(DEFAULT_METRICS_FILTER)).toBe('scope=tree&groupBy=role&bucket=day');
    expect(metricsQuery({ ...DEFAULT_METRICS_FILTER, scope: 'node', groupBy: 'model', bucket: 'week', since: '2026-11-01', until: '2026-11-07', includeExperiments: true })).toBe(
      'scope=node&groupBy=model&bucket=week&since=2026-11-01T00%3A00%3A00.000Z&until=2026-11-07T23%3A59%3A59.999Z&includeExperiments=1',
    );
  });

  it('formats rates, money, rounds and counts', () => {
    expect(formatMetric(0.625, 'rate')).toBe('63%');
    expect(formatMetric(0.0123, 'usd')).toBe('$0.0123');
    expect(formatMetric(1.5, 'rounds')).toBe('1.5');
    expect(formatMetric(null, 'rounds')).toBe('—');
    expect(formatMetric(3, 'count')).toBe('3');
  });

  it('chart geometry: rates on 0–100 %, other values from 0 to their max, a gap breaks the line', () => {
    const g = chartGeometry([{ bucket: 'a', value: 1 }, { bucket: 'b', value: null }, { bucket: 'c', value: 0 }, { bucket: 'd', value: 0.5 }], 'rate', { width: 100, height: 50, pad: 0 });
    expect(g.yMax).toBe(1);
    expect(g.dots.map((d) => [d.x, d.y])).toEqual([[0, 0], [66.667, 50], [100, 25]]);
    expect(g.path).toBe('M0 0 M66.667 50 L100 25');
    const c = chartGeometry([{ bucket: 'a', value: 2 }, { bucket: 'b', value: 4 }], 'usd', { width: 10, height: 10, pad: 0 });
    expect(c.yMax).toBe(4);
    expect(c.path).toBe('M0 5 L10 0');
    expect(chartGeometry([], 'count', { width: 10, height: 10, pad: 0 }).dots).toEqual([]);
    // One bucket: centred.
    expect(chartGeometry([{ bucket: 'a', value: 1 }], 'count', { width: 10, height: 10, pad: 0 }).dots[0]!.x).toBe(5);
  });

  it('useMetrics loads the report and reloads on a filter change', async () => {
    const { result } = renderHook(() => useMetrics('ws_1'));
    await waitFor(() => expect(result.current.report?.totals.runs).toBe(3));
    expect(calls).toContain('/api/workspaces/ws_1/metrics?scope=tree&groupBy=role&bucket=day');
    act(() => result.current.setFilter({ groupBy: 'prompt_version' }));
    await waitFor(() => expect(result.current.report?.groupBy).toBe('prompt_version'));
    expect(calls).toContain('/api/workspaces/ws_1/metrics?scope=tree&groupBy=prompt_version&bucket=day');
  });

  it('the export summary is fetched only when asked for', async () => {
    const { result } = renderHook(() => useExportSummaryOnDemand('ws_1'));
    expect(result.current.view).toBeNull();
    expect(calls.filter((c) => c.includes('/export/summary'))).toEqual([]);
    await act(async () => {
      await result.current.compute();
    });
    expect(calls.filter((c) => c.includes('/export/summary'))).toHaveLength(1);
    expect(result.current.view?.headline).toMatch(/leaves out 2 judgment/);
  });
});

describe('Metrics page', () => {
  it('renders charts, tables, the lessons slot and the on-demand export summary', async () => {
    window.location.hash = '#/w/ws_1/metrics';
    render(<App />);
    expect(await screen.findByRole('heading', { name: 'Metrics' })).toBeTruthy();
    expect((await screen.findAllByText('Review pass rate')).length).toBeGreaterThan(0);
    expect(screen.getAllByRole('img').length).toBeGreaterThanOrEqual(4); // one SVG chart per metric
    expect(screen.getByText('idle timeout')).toBeTruthy();
    expect(screen.getByText(/2 experiment \/ audit runs left out/)).toBeTruthy();
    expect(screen.getByText(/Human reads \(not agent context\): 7/)).toBeTruthy();
    expect(screen.getByTestId('lessons-slot')).toBeTruthy();
    // Opening the page never runs the export.
    expect(calls.filter((c) => c.includes('/export/summary'))).toEqual([]);
    fireEvent.click(screen.getByRole('button', { name: 'Compute export exclusions' }));
    expect(await screen.findByText(/leaves out 2 judgment/)).toBeTruthy();
    // Grouping is a filter control.
    fireEvent.change(screen.getByLabelText('Group by'), { target: { value: 'model' } });
    await waitFor(() => expect(calls).toContain('/api/workspaces/ws_1/metrics?scope=tree&groupBy=model&bucket=day'));
  });
});
