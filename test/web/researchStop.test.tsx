// @vitest-environment jsdom
/**
 * The Research page offers "Stop research" while a research run is running, asks once before it
 * stops, and then calls `POST /api/workspaces/:id/research/stop`.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { STOP_RESEARCH_NOTE } from '../../web/src/logic/research.js';
import { Research } from '../../web/src/views/Research.js';

type Reply = { status?: number; body: unknown };
let routes: Record<string, () => Reply>;
let calls: Array<{ method: string; path: string }>;
let runStatus: 'running' | 'done' | 'failed';

const T = '2026-11-16T10:00:00.000Z';
const base = '/api/workspaces/ws_1';

beforeEach(() => {
  calls = [];
  runStatus = 'running';
  routes = {
    [`GET ${base}/runs`]: () => ({ body: [{ id: 'rrun_1', workspaceId: 'ws_1', phase: 'deep_dives', status: runStatus, startedAt: T }] }),
    [`GET ${base}/tasks`]: () => ({ body: [] }),
    [`GET ${base}/decisions`]: () => ({ body: [] }),
    [`GET ${base}/changes`]: () => ({ body: [] }),
    [`GET ${base}/requests`]: () => ({ body: [] }),
    [`POST ${base}/research/stop`]: () => {
      runStatus = 'failed';
      return { body: { stopped: true, researchRuns: ['rrun_1'], pipelines: ['pipe_1'], requeuedTasks: [] } };
    },
  };
  vi.stubGlobal('EventSource', class { addEventListener() {} removeEventListener() {} close() {} });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input), 'http://localhost');
      const method = (init?.method ?? 'GET').toUpperCase();
      calls.push({ method, path: url.pathname });
      const r = routes[`${method} ${url.pathname}`]?.() ?? { status: 404, body: { error: 'not found' } };
      return new Response(JSON.stringify(r.body), { status: r.status ?? 200, headers: { 'content-type': 'application/json' } });
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const stopCalls = () => calls.filter((c) => c.method === 'POST' && c.path === `${base}/research/stop`);

describe('Research page: stopping research', () => {
  it('says what stopping does in words that hold', () => {
    expect(STOP_RESEARCH_NOTE).toBe('Running agents are stopped. You can start again later; finished work is kept.');
  });

  it('shows no stop button while nothing runs', async () => {
    runStatus = 'done';
    render(<Research wsId="ws_1" />);
    await screen.findByText(/deep_dives — done/);
    expect(screen.queryByRole('button', { name: 'Stop research' })).toBeNull();
  });

  it('while a run is running: the button, then one line to confirm, and only then the request', async () => {
    render(<Research wsId="ws_1" />);
    const stop = await screen.findByRole('button', { name: 'Stop research' });
    expect(screen.queryByText(STOP_RESEARCH_NOTE)).toBeNull();
    fireEvent.click(stop);
    expect(screen.getByText(STOP_RESEARCH_NOTE)).toBeTruthy();
    expect(stopCalls()).toEqual([]);

    // Changing one's mind sends nothing.
    fireEvent.click(screen.getByRole('button', { name: 'Keep it running' }));
    expect(screen.queryByText(STOP_RESEARCH_NOTE)).toBeNull();
    expect(stopCalls()).toEqual([]);

    fireEvent.click(screen.getByRole('button', { name: 'Stop research' }));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Yes, stop it' }));
    });
    expect(stopCalls()).toHaveLength(1);
    // The runs are read again: the run is no longer running, and the button is gone.
    await screen.findByText(/deep_dives — failed/);
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Stop research' })).toBeNull());
    expect(screen.queryByText(STOP_RESEARCH_NOTE)).toBeNull();
  });

  it('shows the error when the stop fails, and keeps the button', async () => {
    routes[`POST ${base}/research/stop`] = () => ({ status: 500, body: { error: 'the store is busy' } });
    render(<Research wsId="ws_1" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Stop research' }));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Yes, stop it' }));
    });
    expect(await screen.findByText(/the store is busy/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Stop research' })).toBeTruthy();
  });
});
