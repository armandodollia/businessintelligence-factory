// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InterviewTurn, UserRequest } from '../../src/core/types.js';
import {
  normalizeTree,
  useBusinessMap,
  useFindings,
  useInterview,
  useRequests,
  useResearch,
} from '../../web/src/logic/hooks.js';

// ---------------------------------------------------------------------------
// fakes

type Handler = (body: unknown, url: URL) => unknown;
let routes: Record<string, Handler>;
let calls: Array<{ method: string; path: string; body: unknown }>;

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

async function fakeFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const url = new URL(String(input), 'http://localhost');
  const method = (init?.method ?? 'GET').toUpperCase();
  const body =
    typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : (init?.body ?? null);
  calls.push({ method, path: url.pathname + url.search, body });
  const handler = routes[`${method} ${url.pathname}`];
  if (!handler) return json({ error: 'not found' }, 404);
  return json(handler(body, url));
}

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  readonly url: string;
  closed = false;
  private readonly listeners = new Map<string, Set<(e: { data: string; type: string }) => void>>();
  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }
  addEventListener(type: string, fn: (e: { data: string; type: string }) => void): void {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(fn);
  }
  removeEventListener(type: string, fn: (e: { data: string; type: string }) => void): void {
    this.listeners.get(type)?.delete(fn);
  }
  close(): void {
    this.closed = true;
  }
  emit(data: unknown, type = 'message'): void {
    for (const fn of this.listeners.get(type) ?? []) fn({ data: JSON.stringify(data), type });
  }
}

const turn = (id: string, role: InterviewTurn['role'], text: string): InterviewTurn => ({
  id,
  workspaceId: 'ws_1',
  role,
  text,
  createdAt: '2026-11-12T00:00:00.000Z',
});

const request = (id: string): UserRequest => ({
  id,
  workspaceId: 'ws_1',
  agentRunId: 'ar_1',
  taskId: 'tk_1',
  kind: 'register',
  site: 'example.com',
  details: 'please register',
  status: 'pending',
  createdAt: '2026-11-12T00:00:00.000Z',
});

beforeEach(() => {
  routes = {};
  calls = [];
  FakeEventSource.instances = [];
  vi.stubGlobal('fetch', vi.fn(fakeFetch));
  vi.stubGlobal('EventSource', FakeEventSource);
});

afterEach(() => {
  cleanup(); // unmounts hooks → closes shared SSE channels
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------

describe('web logic hooks', () => {
  it('useInterview.send appends turn', async () => {
    const stored: InterviewTurn[] = [turn('t1', 'agent', 'What does your business do?')];
    routes['GET /api/workspaces/ws_1/interview'] = () => ({
      turns: stored,
      coverage: { basics: stored.length > 1 },
    });
    routes['POST /api/workspaces/ws_1/interview'] = (body) => {
      const text = (body as { text: string }).text;
      stored.push(turn('t2', 'user', text), turn('t3', 'agent', 'Who are your customers?'));
      return stored[2];
    };

    const { result } = renderHook(() => useInterview('ws_1'));
    await waitFor(() => expect(result.current.turns).toHaveLength(1));

    await act(async () => {
      await result.current.send('We sell accounting software');
    });

    expect(calls).toContainEqual({
      method: 'POST',
      path: '/api/workspaces/ws_1/interview',
      body: { text: 'We sell accounting software' },
    });
    await waitFor(() => expect(result.current.turns).toHaveLength(3));
    expect(result.current.turns[1]).toMatchObject({ role: 'user', text: 'We sell accounting software' });
    expect(result.current.turns[2]).toMatchObject({ role: 'agent' });
    expect(result.current.coverage.basics).toBe(true);
    expect(result.current.sending).toBe(false);
  });

  it('useRequests.resolve posts and removes from pending', async () => {
    routes['GET /api/workspaces/ws_1/requests'] = () => [request('rq_1'), request('rq_2')];
    routes['POST /api/requests/rq_1'] = (body) => ({
      ...request('rq_1'),
      ...(body as object),
    });

    const { result } = renderHook(() => useRequests('ws_1'));
    await waitFor(() => expect(result.current.pending).toHaveLength(2));
    expect(calls[0]?.path).toBe('/api/workspaces/ws_1/requests?status=pending');

    await act(async () => {
      await result.current.resolve('rq_1', 'resolved', 'registered as bot@example.com');
    });

    expect(calls).toContainEqual({
      method: 'POST',
      path: '/api/requests/rq_1',
      body: { status: 'resolved', response: 'registered as bot@example.com' },
    });
    expect(result.current.pending.map((r) => r.id)).toEqual(['rq_2']);
  });

  it('useRequests adds pending requests pushed over SSE', async () => {
    routes['GET /api/workspaces/ws_1/requests'] = () => [];
    const { result } = renderHook(() => useRequests('ws_1'));
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    act(() => {
      FakeEventSource.instances[0]!.emit({
        type: 'user_request',
        workspaceId: 'ws_1',
        request: request('rq_9'),
      });
    });
    expect(result.current.pending.map((r) => r.id)).toEqual(['rq_9']);
  });

  it('SSE event updates useResearch.liveEvents', async () => {
    routes['GET /api/workspaces/ws_1/runs'] = () => [];
    const { result, unmount } = renderHook(() => useResearch('ws_1'));
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    const source = FakeEventSource.instances[0]!;
    expect(source.url).toBe('/api/events?workspaceId=ws_1');

    act(() => {
      source.emit({
        type: 'run_event',
        workspaceId: 'ws_1',
        agentRunId: 'ar_1',
        event: { t: 'message', text: 'browsing competitor.com' },
      });
    });
    expect(result.current.liveEvents).toHaveLength(1);
    expect(result.current.liveEvents[0]).toMatchObject({ type: 'run_event', agentRunId: 'ar_1' });

    // named SSE events (event: run_status) are understood too
    act(() => {
      source.emit(
        { workspaceId: 'ws_1', agentRunId: 'ar_1', status: 'done' },
        'run_status',
      );
    });
    expect(result.current.liveEvents[1]).toMatchObject({ type: 'run_status', status: 'done' });

    unmount();
    expect(source.closed).toBe(true);
  });

  it('useBusinessMap builds tree, accepts proposals and reloads', async () => {
    const ws = (id: string, parentWorkspaceId?: string) => ({
      id,
      name: id,
      sector: 'saas',
      createdAt: '2026-11-12T00:00:00.000Z',
      ...(parentWorkspaceId ? { parentWorkspaceId } : {}),
    });
    let accepted = false;
    routes['GET /api/workspaces/root/tree'] = () =>
      accepted ? [ws('root'), ws('child', 'root')] : [ws('root')];
    routes['GET /api/workspaces/root/rollup'] = () => ({ symptoms: [], recommendations: [], findings: [] });
    routes['GET /api/workspaces/root/unit-proposals'] = () => [
      {
        id: 'up_1',
        workspaceId: 'root',
        name: 'Payments',
        description: 'payments division',
        level: 'division',
        audiences: ['external'],
        evidence: [],
        reasoning: 'separate P&L',
        status: accepted ? 'accepted' : 'proposed',
      },
    ];
    routes['GET /api/workspaces/child/unit-proposals'] = () => [];
    routes['POST /api/unit-proposals/up_1'] = () => {
      accepted = true;
      return ws('child', 'root');
    };

    const { result } = renderHook(() => useBusinessMap('root'));
    await waitFor(() => expect(result.current.proposals).toHaveLength(1));
    expect(result.current.tree?.workspace.id).toBe('root');

    await act(async () => {
      await result.current.accept('up_1', { name: 'Payments EU' });
    });
    expect(calls).toContainEqual({
      method: 'POST',
      path: '/api/unit-proposals/up_1',
      body: { action: 'accept', edits: { name: 'Payments EU' } },
    });
    await waitFor(() => expect(result.current.tree?.children).toHaveLength(1));
  });

  it('useFindings.setIncludeInSynthesis posts the override and reloads', async () => {
    const stored: Array<Record<string, unknown>> = [
      { id: 'f1', workspaceId: 'ws_1', runId: 'r', taskId: 't', subject: 's', claim: 'c', criteria: {}, evidence: [], status: 'unverified', createdAt: '' },
      { id: 'f2', workspaceId: 'ws_1', runId: 'r', taskId: 't', subject: 's', claim: 'd', criteria: {}, evidence: [], status: 'verified', createdAt: '' },
    ];
    routes['GET /api/workspaces/ws_1/findings'] = () => stored;
    routes['GET /api/workspaces/ws_1/symptoms'] = () => [];
    routes['POST /api/findings/f1/include'] = (body) => {
      stored[0] = { ...stored[0], includeInSynthesis: (body as { include: boolean }).include };
      return stored[0];
    };
    const { result } = renderHook(() => useFindings('ws_1'));
    await waitFor(() => expect(result.current.findings).toHaveLength(2));
    const [f1, f2] = result.current.findings;
    expect(result.current.usedInSynthesis(f1!)).toBe(false);
    expect(result.current.usedInSynthesis(f2!)).toBe(true);

    await act(async () => {
      await result.current.setIncludeInSynthesis('f1', true);
    });
    expect(calls).toContainEqual({ method: 'POST', path: '/api/findings/f1/include', body: { include: true } });
    await waitFor(() => expect(result.current.usedInSynthesis(result.current.findings[0]!)).toBe(true));
  });

  it('normalizeTree accepts nested or flat shapes', () => {
    const a = { id: 'a', name: 'a', sector: '', createdAt: '' };
    const b = { ...a, id: 'b', parentWorkspaceId: 'a' };
    const c = { ...a, id: 'c', parentWorkspaceId: 'b' };
    const flat = normalizeTree([c, a, b]);
    expect(flat?.workspace.id).toBe('a');
    expect(flat?.children[0]?.children[0]?.workspace.id).toBe('c');
    const nested = normalizeTree({ workspace: a, children: [{ workspace: b, children: [] }] });
    expect(nested?.children[0]?.workspace.id).toBe('b');
  });
});
