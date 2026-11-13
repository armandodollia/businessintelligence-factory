// @vitest-environment jsdom
import { act, cleanup, render, renderHook, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetRatingIndexes, useFindings, usePersonas, useRecommendations } from '../../web/src/logic/hooks.js';
import { App } from '../../web/src/views/App.js';

let routes: Record<string, () => unknown>;

async function fakeFetch(input: string | URL | Request): Promise<Response> {
  const url = new URL(String(input), 'http://localhost');
  const h = routes[url.pathname];
  return new Response(JSON.stringify(h ? h() : []), { status: 200, headers: { 'content-type': 'application/json' } });
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
  FakeEventSource.instances = [];
  resetRatingIndexes();
  vi.stubGlobal('fetch', vi.fn(fakeFetch));
  vi.stubGlobal('EventSource', FakeEventSource);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.location.hash = '';
});

const taskDone = { type: 'task_status', workspaceId: 'ws_1', taskId: 'tsk_c', status: 'verified' };
const emitAll = (e: unknown) => act(() => FakeEventSource.instances.forEach((es) => es.emit(e)));

describe('live review-status refresh', () => {
  it('Competitors page moves a competitor from "not used" to the rated list when its task finishes review', async () => {
    let status = 'pending';
    routes['/api/workspaces/ws_1/competitors'] = () => [
      {
        id: 'cmp_1', workspaceId: 'ws_1', name: 'Globex', threat: 4, directness: 5, comparison: { pricing: 2, onboarding: 4, ux: 3, features: 5 },
        evidence: [], createdAt: '', updatedAt: '', taskId: 'tsk_c', status,
        criteria: { threat: 4, directness: 5, pricing: 2, onboarding: 4, ux: 3, features: 5 },
      },
    ];
    window.location.hash = '#/w/ws_1/competitors';
    render(<App />);
    expect(await screen.findByText(/1 competitor not used/)).toBeTruthy();
    expect(screen.queryAllByRole('button', { name: 'Agree' })).toHaveLength(0);
    status = 'verified';
    emitAll(taskDone);
    await waitFor(() => expect(screen.getAllByRole('button', { name: 'Agree' })).toHaveLength(6));
    expect(screen.queryByText(/competitor not used/)).toBeNull();
  });

  it('findings, recommendations and personas reload on task_status', async () => {
    let status = 'pending';
    routes['/api/workspaces/ws_1/findings'] = () => [
      { id: 'f1', workspaceId: 'ws_1', runId: 'r', taskId: 'tsk_c', subject: 's', claim: 'c', criteria: {}, evidence: [], status, createdAt: '' },
    ];
    routes['/api/workspaces/ws_1/recommendations'] = () => [
      { id: 'r1', workspaceId: 'ws_1', title: 't', summary: 's', criteria: {}, findingIds: [], personaFeedback: [], priority: 1, createdAt: '', status },
    ];
    routes['/api/workspaces/ws_1/personas'] = () => [
      { id: 'p1', workspaceId: 'ws_1', slug: 'sam', segment: 'SMB', profile: {}, agentMdPath: 'x', version: 1, status },
    ];
    const f = renderHook(() => useFindings('ws_1'));
    const r = renderHook(() => useRecommendations('ws_1'));
    const p = renderHook(() => usePersonas('ws_1'));
    await waitFor(() => expect(f.result.current.findings[0]?.status).toBe('pending'));
    await waitFor(() => expect(r.result.current.recommendations[0]?.status).toBe('pending'));
    await waitFor(() => expect(p.result.current.personas[0]?.status).toBe('pending'));
    status = 'verified';
    emitAll(taskDone);
    await waitFor(() => expect(f.result.current.findings[0]?.status).toBe('verified'));
    await waitFor(() => expect(r.result.current.recommendations[0]?.status).toBe('verified'));
    await waitFor(() => expect(p.result.current.personas[0]?.status).toBe('verified'));
  });
});
