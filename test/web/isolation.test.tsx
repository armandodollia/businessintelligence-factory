// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetRatingIndexes, useCriterionRating, usePromptPatch, useRequests } from '../../web/src/logic/hooks.js';

type Reply = { status?: number; body: unknown };
let routes: Record<string, (body: unknown) => Reply | Promise<Reply>>;
let calls: Array<{ method: string; path: string; body: unknown }>;

async function fakeFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const url = new URL(String(input), 'http://localhost');
  const method = (init?.method ?? 'GET').toUpperCase();
  const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : null;
  calls.push({ method, path: url.pathname, body });
  const h = routes[`${method} ${url.pathname}`];
  const r = h ? await h(body) : method === 'GET' ? { body: [] } : { status: 404, body: { error: 'not found' } };
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

const patch = (text: string) => ({ role: 'worker', examples: [], patchText: text });

describe('workspace switch', () => {
  it('a patch proposed in A is not shown or applied in B', async () => {
    routes['POST /api/workspaces/A/calibration/prompt-patch'] = () => ({ body: patch('A patch') });
    const { result, rerender } = renderHook(({ ws }) => usePromptPatch(ws), { initialProps: { ws: 'A' } });
    await act(async () => {
      await result.current.propose();
    });
    expect(result.current.text).toBe('A patch');
    rerender({ ws: 'B' });
    expect(result.current.proposal).toBeNull();
    expect(result.current.canApply).toBe(false);
    await act(async () => {
      await result.current.apply();
    });
    expect(calls.filter((c) => c.path.endsWith('/apply'))).toEqual([]);
  });

  it('a proposal that arrives after switching is not shown in the new workspace', async () => {
    let release!: () => void;
    routes['POST /api/workspaces/A/calibration/prompt-patch'] = () =>
      new Promise<Reply>((r) => {
        release = () => r({ body: patch('late A patch') });
      });
    const { result, rerender } = renderHook(({ ws }) => usePromptPatch(ws), { initialProps: { ws: 'A' } });
    let pending!: Promise<void>;
    act(() => {
      pending = result.current.propose();
    });
    await waitFor(() => expect(calls).toHaveLength(1));
    rerender({ ws: 'B' });
    await act(async () => {
      release();
      await pending;
    });
    expect(result.current.proposal).toBeNull();
    await act(async () => {
      await result.current.apply();
    });
    expect(calls.filter((c) => c.path.includes('/B/'))).toEqual([]);
    // Back in A, the late proposal belongs there.
    rerender({ ws: 'A' });
    expect(result.current.text).toBe('late A patch');
  });
});

describe('request resolution conflicts', () => {
  const req = (id: string) => ({
    id, workspaceId: 'ws_1', agentRunId: 'ar', kind: 'approval', site: 's', details: 'd', status: 'pending', createdAt: '',
  });

  it('409/404 drop the request and reload instead of leaving a stuck banner', async () => {
    let pending = [req('rq_1'), req('rq_2')];
    routes['GET /api/workspaces/ws_1/requests'] = () => ({ body: pending });
    routes['POST /api/requests/rq_1'] = () => {
      pending = [req('rq_2')];
      return { status: 409, body: { error: "user request 'rq_1' is already resolved" } };
    };
    routes['POST /api/requests/rq_2'] = () => ({ status: 500, body: { error: 'boom' } });
    const { result } = renderHook(() => useRequests('ws_1'));
    await waitFor(() => expect(result.current.pending).toHaveLength(2));
    await act(async () => {
      await result.current.resolve('rq_1', 'resolved');
    });
    expect(result.current.pending.map((r) => r.id)).toEqual(['rq_2']);
    expect(result.current.error).toBeNull();
    expect(calls.filter((c) => c.method === 'GET' && c.path.endsWith('/requests')).length).toBe(2);
    // Other errors keep the request and surface the error.
    await act(async () => {
      await result.current.resolve('rq_2', 'denied');
    });
    expect(result.current.pending.map((r) => r.id)).toEqual(['rq_2']);
    expect(result.current.error).toBe('boom');
  });
});

describe('rating index', () => {
  it('is refetched when controls mount again after all unmounted', async () => {
    let list: unknown[] = [];
    routes['GET /api/workspaces/ws_1/ratings'] = () => ({ body: list });
    const target = { workspaceId: 'ws_1', targetType: 'finding' as const, targetId: 'f1', criterion: 'relevance', agentValue: 3 };
    const first = renderHook(() => useCriterionRating(target));
    await waitFor(() => expect(calls.filter((c) => c.path.endsWith('/ratings'))).toHaveLength(1));
    expect(first.result.current.mode).toBe('idle');
    first.unmount();
    // Rated elsewhere (e.g. review queue in another tab).
    list = [{ id: 'r', workspaceId: 'ws_1', targetType: 'finding', targetId: 'f1', criterion: 'relevance', verdict: 'agree', agentValue: 3, createdAt: '' }];
    const second = renderHook(() => useCriterionRating(target));
    await waitFor(() => expect(second.result.current.mode).toBe('done'));
    expect(calls.filter((c) => c.path.endsWith('/ratings'))).toHaveLength(2);
  });
});
