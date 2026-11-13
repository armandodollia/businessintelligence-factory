// @vitest-environment jsdom
import { act, cleanup, render, renderHook, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Rating } from '../../src/core/types.js';
import {
  resetRatingIndexes,
  useCriterionRating,
  useFindingIndex,
  useFindings,
  useScoringWeights,
} from '../../web/src/logic/hooks.js';
import { App } from '../../web/src/views/App.js';

type Reply = { status?: number; body: unknown };
let routes: Record<string, (body: unknown) => Reply>;
let calls: Array<{ method: string; path: string; body: unknown }>;

async function fakeFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const url = new URL(String(input), 'http://localhost');
  const method = (init?.method ?? 'GET').toUpperCase();
  const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : null;
  calls.push({ method, path: url.pathname, body });
  const h = routes[`${method} ${url.pathname}`];
  const r = h ? h(body) : method === 'GET' && !url.pathname.endsWith('/meta') ? { body: [] } : { status: 404, body: { error: 'not found' } };
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
  window.location.hash = '';
});

const finding = (id: string, extra: Record<string, unknown> = {}) => ({
  id, workspaceId: 'ws_1', runId: 'r', taskId: 'tsk_1', subject: 'Rival', claim: `claim ${id}`, criteria: {},
  evidence: ['art_1'], status: 'verified', createdAt: '2026-11-12T00:00:00.000Z', ...extra,
});

const rating = (extra: Partial<Rating> = {}): Rating => ({
  id: 'rt_1', workspaceId: 'ws_1', targetType: 'recommendation', targetId: 'rc_1', criterion: 'upside', verdict: 'agree',
  agentValue: 4, createdAt: '2026-11-12T00:00:00.000Z', ...extra,
});

describe('existing rating state', () => {
  const target = { workspaceId: 'ws_1', targetType: 'recommendation' as const, targetId: 'rc_1', criterion: 'upside', agentValue: 4 };

  it('starts from the existing rating and does not post the same rating again', async () => {
    routes['GET /api/workspaces/ws_1/ratings'] = () => ({ body: [rating()] });
    const { result } = renderHook(() => useCriterionRating(target));
    await waitFor(() => expect(result.current.mode).toBe('done'));
    expect(result.current.verdict).toBe('agree');
    act(() => result.current.change());
    await act(async () => {
      await result.current.agree();
    });
    expect(result.current.mode).toBe('done');
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(0);
  });

  it('a changed rating posts a new row and becomes the current one', async () => {
    routes['GET /api/workspaces/ws_1/ratings'] = () => ({ body: [rating()] });
    routes['POST /api/ratings'] = (b) => ({ status: 201, body: { ...rating(), ...(b as object), id: 'rt_2', createdAt: '2026-11-12T01:00:00.000Z' } });
    const { result } = renderHook(() => useCriterionRating(target));
    await waitFor(() => expect(result.current.mode).toBe('done'));
    act(() => result.current.startDisagree());
    act(() => result.current.setValue('2'));
    await act(async () => {
      await result.current.submitDisagree();
    });
    expect(calls.filter((c) => c.method === 'POST').map((c) => c.body)).toEqual([
      expect.objectContaining({ verdict: 'disagree', userValue: 2, criterion: 'upside' }),
    ]);
    // A second control for the same criterion sees the new rating.
    const other = renderHook(() => useCriterionRating(target));
    expect(other.result.current.verdict).toBe('disagree');
    expect(other.result.current.value).toBe('2');
  });

  it('unrated criteria start idle', async () => {
    routes['GET /api/workspaces/ws_1/ratings'] = () => ({ body: [] });
    const { result } = renderHook(() => useCriterionRating({ ...target, criterion: 'risk' }));
    await waitFor(() => expect(calls.some((c) => c.path.endsWith('/ratings'))).toBe(true));
    expect(result.current.mode).toBe('idle');
  });
});

describe('recommendation → findings', () => {
  it('useFindingIndex resolves cited ids in order and reports missing ones', async () => {
    routes['GET /api/workspaces/ws_1/findings'] = () => ({ body: [finding('f1'), finding('f2')] });
    const { result } = renderHook(() => useFindingIndex('ws_1'));
    await waitFor(() => expect(result.current.loading).toBe(false));
    const r = result.current.resolve(['f2', 'f9', 'f1']);
    expect(r.found.map((f) => f.id)).toEqual(['f2', 'f1']);
    expect(r.missing).toEqual(['f9']);
  });

  it('Strategy lists cited findings with their evidence and rates priority inline', async () => {
    routes['GET /api/workspaces/ws_1/recommendations'] = () => ({
      body: [{ id: 'rc_1', workspaceId: 'ws_1', title: 'Cut steps', summary: 's', criteria: { upside: 4 }, findingIds: ['f1'], personaFeedback: [], priority: 3.5, createdAt: '' }],
    });
    routes['GET /api/workspaces/ws_1/findings'] = () => ({ body: [finding('f1')] });
    routes['GET /api/artifacts/art_1/meta'] = () => ({
      body: { id: 'art_1', workspaceId: 'ws_1', kind: 'page_snapshot', mime: 'text/html', path: 'p', sha256: 'x', title: 'Pricing page', createdAt: '' },
    });
    window.location.hash = '#/w/ws_1/strategy';
    render(<App />);
    expect(await screen.findByText(/claim f1/)).toBeTruthy();
    expect(await screen.findByText('Pricing page')).toBeTruthy();
    expect(screen.getByText('priority')).toBeTruthy();
    expect(screen.getByText('3.50')).toBeTruthy();
  });
});

describe('findings review state', () => {
  it('unverified finding shows the last review score and issues; override can be reset', async () => {
    let include: boolean | undefined = true;
    routes['GET /api/workspaces/ws_1/findings'] = () => ({
      body: [
        finding('f1', {
          status: 'unverified',
          includeInSynthesis: include,
          lastReview: { score: 5, issues: [{ id: 'I1', class: 'blocking', description: 'no source for pricing' }], decisionId: 'd', at: '' },
        }),
      ],
    });
    routes['POST /api/findings/f1/include'] = (b) => {
      include = (b as { include: boolean | null }).include ?? undefined;
      return { body: finding('f1') };
    };
    window.location.hash = '#/w/ws_1/findings';
    render(<App />);
    expect(await screen.findByText('5/10')).toBeTruthy();
    expect(screen.getByText(/no source for pricing/)).toBeTruthy();
    await act(async () => {
      screen.getByRole('button', { name: 'reset to default' }).click();
    });
    expect(calls.find((c) => c.path === '/api/findings/f1/include')?.body).toEqual({ include: null });
    await waitFor(() => expect(screen.queryByRole('button', { name: 'reset to default' })).toBeNull());
  });

  it('useFindings.setIncludeInSynthesis(null) resets the override', async () => {
    routes['GET /api/workspaces/ws_1/findings'] = () => ({ body: [finding('f1', { includeInSynthesis: false })] });
    routes['POST /api/findings/f1/include'] = () => ({ body: finding('f1') });
    const { result } = renderHook(() => useFindings('ws_1'));
    await waitFor(() => expect(result.current.findings).toHaveLength(1));
    await act(async () => {
      await result.current.setIncludeInSynthesis('f1', null);
    });
    expect(calls.find((c) => c.method === 'POST')?.body).toEqual({ include: null });
  });
});

describe('weights save result', () => {
  it('resolves false on failure (no reload) and true on success', async () => {
    let fail = true;
    routes['GET /api/workspaces/ws_1/scoring-weights'] = () => ({ body: { weights: {}, personaWeight: 0 } });
    routes['PUT /api/workspaces/ws_1/scoring-weights'] = (b) => (fail ? { status: 500, body: { error: 'disk full' } } : { body: b });
    const { result } = renderHook(() => useScoringWeights('ws_1'));
    await waitFor(() => expect(result.current.loading).toBe(false));
    act(() => result.current.set('upside', '2'));
    await act(async () => {
      expect(await result.current.save()).toBe(false);
    });
    expect(result.current.dirty).toBe(true);
    expect(result.current.error).toBe('disk full');
    fail = false;
    await act(async () => {
      expect(await result.current.save()).toBe(true);
    });
    expect(result.current.dirty).toBe(false);
  });
});
