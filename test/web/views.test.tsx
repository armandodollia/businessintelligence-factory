// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../../web/src/views/App.js';

const rec = {
  id: 'rc_1',
  workspaceId: 'ws_1',
  title: 'Simplify onboarding',
  summary: 'cut steps',
  criteria: { upside: 4, difficulty: 2 },
  findingIds: [],
  personaFeedback: [
    {
      personaId: 'ps_1',
      scores: { appeal: 4, adoption: 3, willingnessToPay: 2, friction: 2 },
      concerns: ['price'],
      reasoning: 'r',
      wouldChangeMind: 'w',
      simulated: true,
    },
  ],
  priority: 3.2,
  createdAt: '2026-11-12T00:00:00.000Z',
};

const pending = {
  id: 'rq_1',
  workspaceId: 'ws_1',
  agentRunId: 'ar_1',
  taskId: 'tk_1',
  kind: 'approval',
  site: 'vendor.com',
  details: 'Request a demo?',
  status: 'pending',
  createdAt: '2026-11-12T00:00:00.000Z',
};

function respond(path: string): unknown {
  if (path.endsWith('/recommendations')) return [rec];
  if (path.includes('/requests')) return [pending];
  if (path.endsWith('/interview')) return { turns: [], coverage: { basics: false } };
  if (path.endsWith('/rollup')) return { symptoms: [], recommendations: [], findings: [] };
  if (path.endsWith('/tree')) return [{ id: 'ws_1', name: 'Acme', sector: 'saas', createdAt: '' }];
  if (path.endsWith('/calibration')) return { byCriterion: [] };
  if (path === '/api/config') return { scoring: { personaWeight: 0, weights: {} } };
  if (path.endsWith('/profile')) return { workspaceId: 'ws_1', data: {} };
  return [];
}

class NoopEventSource {
  addEventListener(): void {}
  removeEventListener(): void {}
  close(): void {}
}

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string) => {
      const path = new URL(String(input), 'http://localhost').pathname;
      return new Response(JSON.stringify(respond(path)), { headers: { 'content-type': 'application/json' } });
    }),
  );
  vi.stubGlobal('EventSource', NoopEventSource);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.location.hash = '';
});

const PAGES = ['map', 'interview', 'personas', 'research', 'findings', 'strategy', 'review', 'decisions', 'schedule'];

describe('web views', () => {
  it.each(PAGES)('renders workspace page %s with pending requests banner', async (page) => {
    window.location.hash = `#/w/ws_1/${page}`;
    render(<App />);
    expect(await screen.findByText('Waiting on you (1)')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Approve' })).toBeTruthy();
  });

  it('strategy shows persona feedback in a separate Simulated column with rating controls', async () => {
    window.location.hash = '#/w/ws_1/strategy';
    render(<App />);
    expect(await screen.findByText('Simplify onboarding')).toBeTruthy();
    expect(screen.getByRole('columnheader', { name: 'Simulated' })).toBeTruthy();
    expect(screen.getAllByRole('button', { name: 'Agree' }).length).toBe(6);
    await act(async () => {
      screen.getAllByRole('button', { name: 'Disagree' })[0]!.click();
    });
    expect(screen.getByRole('button', { name: 'Save' })).toBeTruthy();
  });

  it('renders weights editor, prompt patch panel and what-changed list', async () => {
    window.location.hash = '#/w/ws_1/strategy';
    render(<App />);
    expect(await screen.findByText('Priority weights')).toBeTruthy();
    expect(screen.getByLabelText('weight upside')).toBeTruthy();
    cleanup();
    window.location.hash = '#/w/ws_1/decisions';
    render(<App />);
    expect(await screen.findByRole('button', { name: 'Propose patch' })).toBeTruthy();
    cleanup();
    window.location.hash = '#/w/ws_1/research';
    render(<App />);
    expect(await screen.findByText('What changed')).toBeTruthy();
  });

  it('renders workspaces and settings', async () => {
    window.location.hash = '#/settings';
    render(<App />);
    expect(await screen.findByText(/Persona weight/)).toBeTruthy();
    cleanup();
    window.location.hash = '#/';
    render(<App />);
    expect(await screen.findByText('New workspace')).toBeTruthy();
  });
});
