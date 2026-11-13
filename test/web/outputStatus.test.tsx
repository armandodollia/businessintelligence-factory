// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { needsReviewFlag, resetRatingIndexes, shownInStrategy, usedInPanel, usedInSynthesis } from '../../web/src/logic/hooks.js';
import { App } from '../../web/src/views/App.js';

type Reply = { status?: number; body: unknown };
let routes: Record<string, (body: unknown, url: URL) => Reply>;
let calls: Array<{ method: string; path: string; search: string; body: unknown }>;

async function fakeFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const url = new URL(String(input), 'http://localhost');
  const method = (init?.method ?? 'GET').toUpperCase();
  const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : null;
  calls.push({ method, path: url.pathname, search: url.search, body });
  const h = routes[`${method} ${url.pathname}`];
  const r = h ? h(body, url) : method === 'GET' && !url.pathname.endsWith('/meta') ? { body: [] } : { status: 404, body: { error: 'not found' } };
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

const rec = (id: string, extra: Record<string, unknown> = {}) => ({
  id, workspaceId: 'ws_1', title: `Title ${id}`, summary: `Summary ${id}`, criteria: {}, findingIds: [], personaFeedback: [],
  priority: 3, createdAt: '', status: 'verified', ...extra,
});

describe('review status logic', () => {
  it('mirrors the core rules', () => {
    expect(usedInSynthesis({ status: 'superseded', includeInSynthesis: true })).toBe(false);
    expect(usedInPanel({ status: 'unverified' })).toBe(false);
    expect(usedInPanel({ status: 'unverified', includeOverride: true })).toBe(true);
    expect(usedInPanel({ status: 'superseded', includeOverride: true })).toBe(false);
    expect(shownInStrategy({ status: 'failed' })).toBe(false);
    expect(shownInStrategy({ status: 'failed', includeOverride: true })).toBe(true);
    expect(shownInStrategy({ status: 'superseded' })).toBe(false);
    expect(needsReviewFlag({ status: 'unverified' })).toBe(true);
    expect(needsReviewFlag({ status: 'verified' })).toBe(false);
  });
});

describe('Strategy review state', () => {
  it('flags unverified with objections, hides failed/superseded, toggles the panel override, resolves cross-node findings', async () => {
    let include: boolean | undefined;
    routes['GET /api/workspaces/ws_1/recommendations'] = () => ({
      body: [
        rec('rc_ok', { findingIds: ['f_parent'] }),
        rec('rc_unv', {
          status: 'unverified', includeOverride: include,
          lastReview: { score: 6, issues: [{ id: 'I1', class: 'substantive', description: 'UPSIDE_NOT_SUPPORTED' }], decisionId: 'd', at: '' },
        }),
        rec('rc_failed', { status: 'failed' }),
        rec('rc_sup', { status: 'superseded' }),
      ],
    });
    routes['POST /api/recommendations/rc_unv/include'] = (b) => {
      include = (b as { include: boolean | null }).include ?? undefined;
      return { body: rec('rc_unv') };
    };
    routes['GET /api/workspaces/ws_1/findings'] = (_b, url) => ({
      body:
        url.searchParams.get('scope') === 'tree'
          ? [{ id: 'f_parent', workspaceId: 'ws_root', sourceWorkspaceId: 'ws_root', runId: 'r', taskId: 't', subject: 'Acme', claim: 'PARENT_CLAIM', criteria: {}, evidence: [], status: 'verified', createdAt: '' }]
          : [],
    });
    window.location.hash = '#/w/ws_1/strategy';
    render(<App />);
    expect(await screen.findByText('Title rc_unv')).toBeTruthy();
    expect(screen.getByText('Title rc_ok')).toBeTruthy();
    expect(screen.queryByText('Title rc_failed')).toBeNull();
    expect(screen.queryByText('Title rc_sup')).toBeNull();
    expect(screen.getByText(/2 recommendations hidden/)).toBeTruthy();
    expect(screen.getByText('6/10')).toBeTruthy();
    expect(screen.getByText(/UPSIDE_NOT_SUPPORTED/)).toBeTruthy();
    // Cross-node finding is resolved and tagged with its source node.
    expect(await screen.findByText(/PARENT_CLAIM/)).toBeTruthy();
    expect(screen.getByText('from ws_root')).toBeTruthy();
    expect(calls.some((c) => c.path === '/api/workspaces/ws_1/findings' && c.search === '?scope=tree')).toBe(true);

    const box = screen.getByLabelText('use rc_unv in persona panel') as HTMLInputElement;
    expect(box.checked).toBe(false);
    await act(async () => {
      box.click();
    });
    expect(calls.find((c) => c.path === '/api/recommendations/rc_unv/include')?.body).toEqual({ include: true });
    await waitFor(() => expect((screen.getByLabelText('use rc_unv in persona panel') as HTMLInputElement).checked).toBe(true));
  });
});

describe('Personas review state', () => {
  it('shows status and objections and toggles the panel override', async () => {
    routes['GET /api/workspaces/ws_1/personas'] = () => ({
      body: [
        {
          id: 'per_1', workspaceId: 'ws_1', slug: 'sam', segment: 'SMB owner', profile: {}, agentMdPath: 'sam.md', version: 2,
          status: 'unverified', lastReview: { score: 4, issues: [{ description: 'THIN_EVIDENCE' }], decisionId: 'd', at: '' },
        },
      ],
    });
    routes['POST /api/personas/per_1/include'] = () => ({ body: {} });
    window.location.hash = '#/w/ws_1/personas';
    render(<App />);
    expect(await screen.findByText('SMB owner')).toBeTruthy();
    expect(screen.getByText('unverified')).toBeTruthy();
    expect(screen.getByText(/THIN_EVIDENCE/)).toBeTruthy();
    await act(async () => {
      (screen.getByLabelText('use per_1 in persona panel') as HTMLInputElement).click();
    });
    expect(calls.find((c) => c.path === '/api/personas/per_1/include')?.body).toEqual({ include: true });
  });
});
