// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { feedbackChange, hypothesisCorrection, hypothesisUsed } from '../../web/src/logic/feedback.js';
import { resetRatingIndexes } from '../../web/src/logic/hooks.js';
import { FeedbackLog } from '../../web/src/views/FeedbackLog.js';
import { Hypotheses } from '../../web/src/views/Hypotheses.js';

type Reply = { status?: number; body: unknown };
let routes: Record<string, (body: unknown) => Reply>;
let calls: Array<{ method: string; path: string; body: unknown }>;

async function fakeFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const url = new URL(String(input), 'http://localhost');
  const method = (init?.method ?? 'GET').toUpperCase();
  const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : null;
  calls.push({ method, path: url.pathname, body });
  const h = routes[`${method} ${url.pathname}`];
  const r = h ? h(body) : method === 'GET' ? { body: [] } : { status: 404, body: { error: 'not found' } };
  return new Response(JSON.stringify(r.body), { status: r.status ?? 200, headers: { 'content-type': 'application/json' } });
}

class NoopEventSource {
  addEventListener() {}
  removeEventListener() {}
  close() {}
}

beforeEach(() => {
  routes = {};
  calls = [];
  resetRatingIndexes();
  vi.stubGlobal('fetch', vi.fn(fakeFetch));
  vi.stubGlobal('EventSource', NoopEventSource);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const hyp = {
  id: 'hyp_1', workspaceId: 'ws_1', symptomId: 'sym_1', hypothesis: 'Price rise drives churn', confidence: 60, evidence: [],
  createdAt: '2026-11-13T10:00:00.000Z', status: 'unverified',
};

describe('feedback log', () => {
  it('shows actor, time, action, change and reason of each feedback item', async () => {
    routes['GET /api/workspaces/ws_1/feedback'] = () => ({
      body: [
        {
          id: 'fbk_1', workspaceId: 'ws_1', actor: 'ana@acme', createdAt: '2026-11-13T10:00:00.000Z', kind: 'include_override',
          targetType: 'finding', targetId: 'fnd_1', beforeJson: { include: null, status: 'verified' }, afterJson: { include: false },
          reason: 'outdated pricing', agentRunId: 'arun_w', promptVersion: 'pv_w1',
        },
      ],
    });
    render(<FeedbackLog wsId="ws_1" />);
    expect(await screen.findByText('ana@acme')).toBeTruthy();
    expect(screen.getByText('include override')).toBeTruthy();
    expect(screen.getByText('outdated pricing')).toBeTruthy();
    expect(screen.getByText('default → exclude (was verified)')).toBeTruthy();
    expect(screen.getByText('arun_w')).toBeTruthy();
    expect(screen.getByRole('columnheader', { name: 'Who' })).toBeTruthy();
    expect(screen.getByRole('columnheader', { name: 'When' })).toBeTruthy();
  });

  it('summarizes changes per kind', () => {
    expect(feedbackChange({ kind: 'hypothesis_correction', beforeJson: { symptomId: 's', confidence: 60 }, afterJson: { confidence: 20 } })).toBe('confidence: 60 → 20');
    expect(feedbackChange({ kind: 'request_answer', beforeJson: { status: 'pending' }, afterJson: { status: 'denied', response: 'no' } })).toBe('denied: no');
    expect(feedbackChange({ kind: 'prompt_patch_apply', beforeJson: { promptVersion: 'a' }, afterJson: { promptVersion: 'b' } })).toBe('prompt a → b');
  });
});

describe('symptom hypotheses', () => {
  it('include toggle and user correction call the API', async () => {
    let current = { ...hyp };
    routes['GET /api/workspaces/ws_1/hypotheses'] = () => ({ body: [current] });
    routes['GET /api/workspaces/ws_1/symptoms'] = () => ({ body: [{ id: 'sym_1', workspaceId: 'ws_1', kind: 'symptom', title: 'Churn up', detail: '', criteria: {}, evidence: [] }] });
    routes['POST /api/hypotheses/hyp_1/include'] = (b) => {
      current = { ...current, includeOverride: (b as { include: boolean }).include } as typeof current;
      return { body: current };
    };
    routes['POST /api/hypotheses/hyp_1/correct'] = (b) => {
      current = { ...current, ...(b as object) };
      return { body: current };
    };
    render(<Hypotheses wsId="ws_1" />);
    expect(await screen.findByText(/Price rise drives churn/, { selector: 'p' })).toBeTruthy();
    expect(screen.getByText('Symptom: Churn up')).toBeTruthy();
    const box = screen.getByLabelText('use hyp_1 in interview drill-down') as HTMLInputElement;
    expect(box.checked).toBe(false);
    await act(async () => {
      box.click();
    });
    expect(calls.find((c) => c.method === 'POST')).toEqual({ method: 'POST', path: '/api/hypotheses/hyp_1/include', body: { include: true } });
    await waitFor(() => expect((screen.getByLabelText('use hyp_1 in interview drill-down') as HTMLInputElement).checked).toBe(true));

    const save = screen.getByRole('button', { name: 'Save correction' }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('confidence hyp_1'), { target: { value: '20' } });
    fireEvent.change(screen.getByLabelText('reason hyp_1'), { target: { value: 'tickets' } });
    await act(async () => {
      (screen.getByRole('button', { name: 'Save correction' }) as HTMLButtonElement).click();
    });
    expect(calls.filter((c) => c.path.endsWith('/correct')).map((c) => c.body)).toEqual([{ confidence: 20, reason: 'tickets' }]);
  });

  it('pure helpers mirror core rules', () => {
    expect(hypothesisUsed({ status: 'verified' })).toBe(true);
    expect(hypothesisUsed({ status: 'unverified', includeOverride: true })).toBe(true);
    expect(hypothesisUsed({ status: 'superseded', includeOverride: true })).toBe(false);
    expect(hypothesisCorrection(hyp, { hypothesis: hyp.hypothesis, confidence: '60', reason: 'x' })).toBeUndefined();
    expect(hypothesisCorrection(hyp, { hypothesis: hyp.hypothesis, confidence: '150', reason: '' })).toBeUndefined();
    expect(hypothesisCorrection(hyp, { hypothesis: ' New text ', confidence: '60', reason: '' })).toEqual({ hypothesis: 'New text' });
  });
});
