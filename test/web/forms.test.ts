// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BifConfig } from '../../src/core/config/schema.js';
import type { InterviewTurn } from '../../src/core/types.js';
import { decisionCriteria } from '../../web/src/logic/format.js';
import { useConfigEditor, useInterview, useSchedules } from '../../web/src/logic/hooks.js';

type Reply = { status?: number; body: unknown };
let routes: Record<string, (body: unknown) => Reply>;

async function fakeFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const url = new URL(String(input), 'http://localhost');
  const method = (init?.method ?? 'GET').toUpperCase();
  const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : null;
  const h = routes[`${method} ${url.pathname}`];
  const r = h ? h(body) : { status: 404, body: { error: 'not found' } };
  return new Response(JSON.stringify(r.body), { status: r.status ?? 200, headers: { 'content-type': 'application/json' } });
}

class NoopEventSource {
  addEventListener() {}
  removeEventListener() {}
  close() {}
}

beforeEach(() => {
  routes = {};
  vi.stubGlobal('fetch', vi.fn(fakeFetch));
  vi.stubGlobal('EventSource', NoopEventSource);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const turn = (id: string, role: InterviewTurn['role'], text: string): InterviewTurn => ({
  id, workspaceId: 'ws_1', role, text, createdAt: '2026-11-12T00:00:00.000Z',
});

describe('settings editor save', () => {
  const cfg = { scoring: { personaWeight: 0, weights: {} }, loop: { maxRounds: 3 } } as unknown as BifConfig;

  it('keeps the draft and shows the error when the save fails', async () => {
    routes['GET /api/config'] = () => ({ body: cfg });
    routes['PUT /api/config'] = () => ({ status: 400, body: { error: 'loop.maxRounds: too small', issues: [] } });
    const { result } = renderHook(() => useConfigEditor());
    await waitFor(() => expect(result.current.text).toContain('maxRounds'));
    const draft = result.current.text.replace('"maxRounds": 3', '"maxRounds": 0');
    act(() => result.current.setText(draft));
    let ok: boolean | undefined;
    await act(async () => {
      ok = await result.current.save();
    });
    expect(ok).toBe(false);
    expect(result.current.text).toBe(draft);
    expect(result.current.dirty).toBe(true);
    expect(result.current.error).toBe('loop.maxRounds: too small');
    expect(result.current.savedAt).toBeNull();
  });

  it('clears the draft only on success', async () => {
    let stored: unknown = cfg;
    routes['GET /api/config'] = () => ({ body: stored });
    routes['PUT /api/config'] = (b) => {
      stored = b;
      return { body: b };
    };
    const { result } = renderHook(() => useConfigEditor());
    await waitFor(() => expect(result.current.text).toContain('maxRounds'));
    act(() => result.current.setText(result.current.text.replace('"maxRounds": 3', '"maxRounds": 4')));
    await act(async () => {
      expect(await result.current.save()).toBe(true);
    });
    expect(result.current.dirty).toBe(false);
    expect(result.current.text).toContain('"maxRounds": 4');
    expect(result.current.error).toBeNull();
  });
});

describe('schedule create', () => {
  it('resolves false with an error on failure and true on success', async () => {
    const list: unknown[] = [];
    routes['GET /api/workspaces/ws_1/schedules'] = () => ({ body: list });
    routes['POST /api/workspaces/ws_1/schedules'] = (b) => {
      const input = b as { cron: string };
      if (input.cron === 'bad') return { status: 400, body: { error: "invalid cron expression 'bad'" } };
      const s = { id: 'sch_1', workspaceId: 'ws_1', ...(b as object) };
      list.push(s);
      return { status: 201, body: s };
    };
    const { result } = renderHook(() => useSchedules('ws_1'));
    await waitFor(() => expect(result.current.loading).toBe(false));
    await act(async () => {
      expect(await result.current.create({ name: 'x', cron: 'bad', phases: ['deep_dives'], enabled: true })).toBe(false);
    });
    expect(result.current.error).toMatch(/invalid cron/);
    await act(async () => {
      expect(await result.current.create({ name: 'x', cron: '0 9 * * 1', phases: ['deep_dives'], enabled: true })).toBe(true);
    });
    expect(result.current.schedules).toHaveLength(1);
    expect(result.current.error).toBeNull();
  });
});

describe('interview send failures', () => {
  it('not stored (400/network): resolves false and drops the optimistic turn', async () => {
    routes['GET /api/workspaces/ws_1/interview'] = () => ({ body: { turns: [turn('t1', 'agent', 'Hi')], coverage: {} } });
    routes['POST /api/workspaces/ws_1/interview'] = () => ({ status: 400, body: { error: 'text must not be empty' } });
    const { result } = renderHook(() => useInterview('ws_1'));
    await waitFor(() => expect(result.current.turns).toHaveLength(1));
    let stored: boolean | undefined;
    await act(async () => {
      stored = await result.current.send('hello');
    });
    expect(stored).toBe(false);
    expect(result.current.turns).toHaveLength(1);
    expect(result.current.error).toBe('text must not be empty');
  });

  it('interviewer failed (502): applies the stored turns + coverage from the error body', async () => {
    routes['GET /api/workspaces/ws_1/interview'] = () => ({ body: { turns: [turn('t1', 'agent', 'Hi')], coverage: {} } });
    routes['POST /api/workspaces/ws_1/interview'] = () => ({
      status: 502,
      body: { error: 'interviewer run failed', turns: [turn('t1', 'agent', 'Hi'), turn('t2', 'user', 'hello')], coverage: { basics: false } },
    });
    const { result } = renderHook(() => useInterview('ws_1'));
    await waitFor(() => expect(result.current.turns).toHaveLength(1));
    let stored: boolean | undefined;
    await act(async () => {
      stored = await result.current.send('hello');
    });
    expect(stored).toBe(true);
    expect(result.current.turns.map((t) => t.id)).toEqual(['t1', 't2']);
    expect(result.current.coverage).toEqual({ basics: false });
    expect(result.current.error).toBe('interviewer run failed');
  });
});

describe('decision criteria', () => {
  it('lists numeric confidence and review score only', () => {
    expect(decisionCriteria({ payload: { tool: 'log_decision', what: 'x', confidence: 0.8 } })).toEqual({ confidence: 0.8 });
    expect(decisionCriteria({ payload: { tool: 'submit_review', score: 7, issues: [] } })).toEqual({ score: 7 });
    expect(decisionCriteria({ payload: { tool: 'set_scoring_weights', actor: 'user' } })).toEqual({});
    expect(decisionCriteria({ payload: null })).toEqual({});
  });
});
