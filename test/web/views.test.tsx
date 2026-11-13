// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetRatingIndexes } from '../../web/src/logic/hooks.js';
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

const loggedDecision = {
  id: 'dec_1',
  workspaceId: 'ws_1',
  agentRunId: 'ar_1',
  role: 'worker',
  model: { provider: 'claude', model: 'sonnet' },
  promptVersion: 'v1',
  kind: 'decision',
  payload: { tool: 'log_decision', what: 'Focus on pricing pages', why: 'w', confidence: 0.7 },
  refs: [],
  createdAt: '2026-11-12T00:00:00.000Z',
};

function respond(path: string): unknown {
  if (path.endsWith('/recommendations')) return [rec];
  if (path.endsWith('/decisions')) return [loggedDecision];
  if (path.includes('/requests')) return [pending];
  if (path.endsWith('/interview')) return { turns: [], coverage: { basics: false } };
  if (path.endsWith('/rollup')) return { symptoms: [], recommendations: [], findings: [] };
  if (path.endsWith('/tree')) return [{ id: 'ws_1', name: 'Acme', sector: 'saas', createdAt: '' }];
  if (path.endsWith('/calibration')) {
    return {
      byCriterion: [],
      byRoleTask: [{ role: 'worker', taskType: 'flow_walkthrough', targetType: 'competitor', criterion: 'pricing', n: 1, agreeRate: 0, meanDelta: 0.5 }],
    };
  }
  if (path.endsWith('/competitors')) {
    return [
      {
        id: 'cmp_1', workspaceId: 'ws_1', name: 'Globex', site: 'globex.com', threat: 4, directness: 5,
        comparison: { pricing: 2, onboarding: 4, ux: 3, features: 5 }, evidence: [], createdAt: '', updatedAt: '',
        criteria: { threat: 4, directness: 5, pricing: 2, onboarding: 4, ux: 3, features: 5 },
      },
    ];
  }
  if (path === '/api/config') return { scoring: { personaWeight: 0, weights: {} } };
  if (path.endsWith('/profile')) return { workspaceId: 'ws_1', data: {} };
  if (path.endsWith('/findings')) {
    return [
      { id: 'fnd_v', workspaceId: 'ws_1', runId: 'r', taskId: 't', subject: 'Rival', claim: 'Verified claim', criteria: { relevance: 4, threat: 5 }, evidence: [], status: 'verified', createdAt: '' },
      { id: 'fnd_u', workspaceId: 'ws_1', runId: 'r', taskId: 't', subject: 'Rival', claim: 'Unverified claim', criteria: {}, evidence: [], status: 'unverified', createdAt: '' },
    ];
  }
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
  resetRatingIndexes();
  vi.unstubAllGlobals();
  window.location.hash = '';
});

const PAGES = ['map', 'interview', 'personas', 'research', 'findings', 'competitors', 'strategy', 'review', 'decisions', 'schedule'];

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
    // 2 recommendation criteria + priority + 4 simulated persona scores.
    expect(screen.getAllByRole('button', { name: 'Agree' }).length).toBe(7);
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

  it('findings page shows a use-in-synthesis toggle (unverified excluded by default)', async () => {
    window.location.hash = '#/w/ws_1/findings';
    render(<App />);
    const verified = (await screen.findByLabelText('use fnd_v in synthesis')) as HTMLInputElement;
    const unverified = screen.getByLabelText('use fnd_u in synthesis') as HTMLInputElement;
    expect(verified.checked).toBe(true);
    expect(unverified.checked).toBe(false);
    expect(screen.getByText(/excluded: not verified/)).toBeTruthy();
  });

  it('competitors page rates each competitor criterion (final review C4)', async () => {
    window.location.hash = '#/w/ws_1/competitors';
    render(<App />);
    expect(await screen.findByText('Globex')).toBeTruthy();
    for (const k of ['threat', 'directness', 'pricing', 'onboarding', 'ux', 'features']) expect(screen.getByText(k)).toBeTruthy();
    expect(screen.getAllByRole('button', { name: 'Agree' })).toHaveLength(6);
    await act(async () => {
      screen.getAllByRole('button', { name: 'Disagree' })[2]!.click();
    });
    expect(screen.getByLabelText('Your pricing')).toBeTruthy();
  });

  it('findings offer finding criteria only, never competitor keys', async () => {
    window.location.hash = '#/w/ws_1/findings';
    render(<App />);
    expect(await screen.findByText('relevance')).toBeTruthy();
    expect(screen.queryByText('threat')).toBeNull();
  });

  it('decision log shows calibration per role and task type', async () => {
    window.location.hash = '#/w/ws_1/decisions';
    render(<App />);
    expect(await screen.findByText('flow_walkthrough')).toBeTruthy();
    expect(screen.getByRole('columnheader', { name: 'Task type' })).toBeTruthy();
  });

  it('decision log rates a decision confidence inline', async () => {
    window.location.hash = '#/w/ws_1/decisions';
    render(<App />);
    expect(await screen.findByText('confidence')).toBeTruthy();
    expect(screen.getAllByRole('button', { name: 'Agree' }).length).toBeGreaterThan(0);
  });

  it('renders workspaces and settings', async () => {
    window.location.hash = '#/settings';
    render(<App />);
    expect(await screen.findByText(/Strategy page/)).toBeTruthy();
    expect(screen.queryByText(/Persona weight in priority/)).toBeNull();
    cleanup();
    window.location.hash = '#/';
    render(<App />);
    expect(await screen.findByText('New workspace')).toBeTruthy();
  });
});
