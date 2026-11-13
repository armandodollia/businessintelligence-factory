// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { decisionCriteria } from '../../web/src/logic/format.js';
import { asOutcomeReport, outcomeColumns, useOutcomes } from '../../web/src/logic/outcomes.js';
import type { OutcomeReport } from '../../web/src/logic/types.js';

let calls: string[];
let report: OutcomeReport;

beforeEach(() => {
  calls = [];
  report = {
    labels: ['confirmed', 'weak-review', 'stale', 'worker-miss'],
    rows: [
      { role: 'worker', taskType: 'news_scan', promptVersion: 'v1', counts: { confirmed: 2, stale: 1 }, total: 3 },
      { role: 'reviewer', taskType: 'news_scan', promptVersion: 'r1', counts: { 'weak-review': 1 }, total: 1 },
    ],
  };
  vi.stubGlobal('fetch', async (input: string | URL | Request) => {
    const url = new URL(String(input), 'http://localhost');
    calls.push(`${url.pathname}${url.search}`);
    return new Response(JSON.stringify(report), { status: 200, headers: { 'content-type': 'application/json' } });
  });
  vi.stubGlobal(
    'EventSource',
    class {
      addEventListener() {}
      removeEventListener() {}
      close() {}
    },
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('outcomes report (web logic)', () => {
  it('outcomeColumns keeps report label order and drops labels nobody has', () => {
    expect(outcomeColumns(report)).toEqual(['confirmed', 'weak-review', 'stale']);
    expect(outcomeColumns(null)).toEqual([]);
    expect(outcomeColumns([] as unknown as OutcomeReport)).toEqual([]);
    expect(asOutcomeReport([])).toBeNull();
    expect(asOutcomeReport(report)).toBe(report);
  });

  it('useOutcomes loads the workspace report and switches to the business tree', async () => {
    const { result } = renderHook(() => useOutcomes('ws_1'));
    await waitFor(() => expect(result.current.report).not.toBeNull());
    expect(result.current.columns).toEqual(['confirmed', 'weak-review', 'stale']);
    expect(calls).toEqual(['/api/workspaces/ws_1/outcomes']);
    act(() => result.current.setTree(true));
    await waitFor(() => expect(calls).toContain('/api/workspaces/ws_1/outcomes?scope=tree'));
    expect(result.current.tree).toBe(true);
  });

  it('pushback decisions are ratable in the decision log', () => {
    expect(decisionCriteria({ kind: 'pushback', payload: { tool: 'respond_to_review', issueId: 'I1', action: 'pushback', reason: 'r' } })).toEqual({
      pushback: 1,
    });
    expect(decisionCriteria({ kind: 'decision', payload: { tool: 'respond_to_review', action: 'fix' } })).toEqual({});
  });
});
