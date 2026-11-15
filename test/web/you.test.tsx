// @vitest-environment jsdom
/**
 * User persona, task 3 (design 2026-11-15-user-persona-design.md §12): the You page — lines by field
 * with Retire and the interactions they rest on, proposals with Accept / Edit / Reject and a reason,
 * the statistics and the next-retro line — the "You" nav entry, and the Lessons count.
 */
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseRoute, WORKSPACE_PAGES } from '../../web/src/logic/router.js';
import type { PersonaLearningView, PersonaProposal, UserInteraction, UserPersonaView } from '../../web/src/logic/types.js';
import { asUserPersonaView, lineEvidenceText, nextRetroLine, statsLine, usedByLine } from '../../web/src/logic/userPersona.js';
import { Lessons } from '../../web/src/views/Lessons.js';
import { You } from '../../web/src/views/You.js';

const STATS = { n: 12, agree: 4, disagree: 8, items: 6, lower: 0.4 };
const proposal = (extra: Partial<PersonaProposal> = {}): PersonaProposal => ({
  id: 'ppr_u1', rootWorkspaceId: 'ws_1', workspaceId: 'ws_1', personaId: 'per_u', action: 'add', field: 'evidence_standards',
  text: 'Does not act on a claim backed by one source.', rationale: 'Several exclusions point the same way.', evidence: ['fbk_1', 'fbk_2', 'fbk_3'],
  stats: STATS, source: 'retro', status: 'pending', createdAt: '2026-11-16T06:00:00.000Z', ...extra,
});
const line = {
  id: 'pad_u1', rootWorkspaceId: 'ws_1', workspaceId: 'ws_1', personaId: 'per_u', field: 'priorities', marker: 'A-71C0DE',
  text: 'Prefers changes that ship <b>within a quarter</b>.', version: 1, status: 'active' as const, source: 'retro' as const, stats: STATS, internal: false,
  createdAt: '2026-11-10T00:00:00.000Z', changedAt: '2026-11-10T00:00:00.000Z', evidence: 5,
};
const interactions: UserInteraction[] = [
  { id: 'fbk_9', kind: 'include_override', stance: 'reject', target: 'finding:fnd_1', topic: 'include_override', detail: 'include_override on finding fnd_1: include=false', reason: '<i>one</i> review site', refs: [], at: '2026-11-12T00:00:00.000Z' },
  { id: 'fbk_8', kind: 'proposal_accept', stance: 'accept', target: 'decision:dec_1', topic: 'proposal_accept', detail: 'proposal_accept on decision dec_1', refs: [], at: '2026-11-11T00:00:00.000Z' },
];

function view(extra: Partial<UserPersonaView> = {}): UserPersonaView {
  return {
    enabled: true,
    usedBy: ['orchestrator', 'synthesizer', 'interviewer'],
    useInPrompts: true,
    gate: { n: 7, targets: 6, qualifies: false, missing: ['7 of 12 actions'] },
    stats: { byKind: { include_override: { accept: 14, reject: 9 }, proposal_edit: { edit: 3 }, user_action: { neutral: 2 } }, total: 28 },
    persona: { id: 'per_u', version: 2 },
    fields: [{ field: 'priorities', lines: [line] }],
    proposals: [proposal(), proposal({ id: 'ppr_old', status: 'rejected', text: 'Trusts vendor claims.', decidedAt: '2026-11-01T00:00:00.000Z', reason: 'no' })],
    lastRun: { id: 'plr_1', status: 'proposed', assumption: 'Excludes findings that rest on a single review site.', createdAt: '2026-11-16T06:00:00.000Z' },
    ...extra,
  };
}

let calls: Array<{ method: string; path: string; search: string; body?: unknown }> = [];
let current: UserPersonaView;
let learning: PersonaLearningView;
let failPosts = false;

beforeEach(() => {
  calls = [];
  failPosts = false;
  current = view();
  learning = { enabled: true, personas: [], pendingInTree: 0, pendingUser: 0 };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init?: RequestInit) => {
      const url = new URL(String(input), 'http://localhost');
      const method = init?.method ?? 'GET';
      calls.push({ method, path: url.pathname, search: url.search, ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) });
      const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
      if (method === 'POST' && failPosts) return json({ error: 'server unavailable' }, 500);
      if (url.pathname === '/api/workspaces/ws_1/user-persona') return json(current);
      if (url.pathname === '/api/workspaces/ws_1/user-persona/interactions') return json({ interactions });
      if (url.pathname === '/api/workspaces/ws_1/persona-learning') return json(learning);
      if (url.pathname === '/api/workspaces/ws_1/lessons') return json({ rootWorkspaceId: 'ws_1', roles: [], proposals: [], rules: [], retros: [] });
      if (url.pathname.endsWith('/accept')) {
        current = view({ proposals: [proposal({ status: 'accepted', finalText: 'Wants two sources for a claim.', decidedAt: '2026-11-16T07:00:00.000Z' })] });
      }
      return json(method === 'GET' ? [] : {});
    }),
  );
  vi.stubGlobal('EventSource', class { addEventListener() {} removeEventListener() {} close() {} });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('You page wording', () => {
  it('statistics, next retro, used by, evidence, payload shape', () => {
    expect(statsLine(view().stats)).toBe('Accepted 14 · rejected 9 · edited 3 · other 2 (28 actions)');
    expect(statsLine({ byKind: {}, total: 0 })).toBe('Nothing yet.');
    expect(nextRetroLine({ n: 7, targets: 4, qualifies: false, missing: ['7 of 12 actions', '4 of 6 different things'] }, false)).toBe(
      'Next retro: 7 of 12 actions, 4 of 6 different things since the last learning run.',
    );
    expect(nextRetroLine({ n: 12, targets: 6, qualifies: true, missing: [] }, false)).toBe('Enough for the next retro.');
    expect(nextRetroLine({ n: 12, targets: 6, qualifies: true, missing: [] }, true)).toBe('Enough for the next retro, once you have answered the proposals below.');
    expect(usedByLine(view())).toBe('Used by: orchestrator, synthesizer, interviewer');
    expect(lineEvidenceText(5)).toBe('Rests on 5 of your actions');
    expect(lineEvidenceText(1)).toBe('Rests on 1 of your actions');
    expect(asUserPersonaView([])).toBeNull();
    expect(asUserPersonaView(current)).toBe(current);
  });
});

describe('You page', () => {
  it('is a workspace page named "You"', () => {
    expect(WORKSPACE_PAGES.find((p) => p.page === 'you')?.label).toBe('You');
    expect(parseRoute('#/w/ws_1/you')).toEqual({ name: 'workspace', wsId: 'ws_1', page: 'you' });
  });

  it('renders fields, lines, the proposal with the assumption, statistics and the next-retro line; text as text', async () => {
    render(<You wsId="ws_1" />);
    expect(await screen.findByRole('heading', { name: 'How the tool sees you' })).toBeTruthy();
    expect(screen.getByText(/^Used by: orchestrator, synthesizer, interviewer · on$/)).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'priorities' })).toBeTruthy();
    expect(screen.getByText('A-71C0DE.v1')).toBeTruthy();
    expect(screen.getByText('Prefers changes that ship <b>within a quarter</b>.')).toBeTruthy();
    expect([...document.querySelectorAll('b')].some((e) => e.textContent === 'within a quarter')).toBe(false);
    expect(screen.getByText(/Rests on 5 of your actions/)).toBeTruthy();
    expect(screen.getByText(/Excludes findings that rest on a single review site\./)).toBeTruthy();
    expect(screen.getByText('"Does not act on a claim backed by one source."')).toBeTruthy();
    expect(screen.getByText('Trusts vendor claims.')).toBeTruthy();
    expect(screen.getByText('Accepted 14 · rejected 9 · edited 3 · other 2 (28 actions)')).toBeTruthy();
    expect(screen.getByText('Next retro: 7 of 12 actions since the last learning run.')).toBeTruthy();
  });

  it('with nothing learned yet: says so, and "Enough for the next retro" when the gate passes', async () => {
    current = view({ persona: undefined, fields: [], proposals: [], lastRun: undefined, gate: { n: 12, targets: 6, qualifies: true, missing: [] } });
    render(<You wsId="ws_1" />);
    expect(await screen.findByText(/Nothing learned yet/)).toBeTruthy();
    expect(screen.getByText('Enough for the next retro.')).toBeTruthy();
  });

  it('Edit then Accept posts the edited text and the reason to the persona learning accept route', async () => {
    render(<You wsId="ws_1" />);
    await screen.findByRole('heading', { name: 'How the tool sees you' });
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    fireEvent.change(screen.getByLabelText('text of ppr_u1'), { target: { value: 'Wants two sources for a claim.' } });
    fireEvent.change(screen.getByLabelText('reason for ppr_u1'), { target: { value: 'two is enough' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Accept' }));
    });
    expect(calls.filter((c) => c.method === 'POST')).toEqual([
      { method: 'POST', path: '/api/workspaces/ws_1/persona-proposals/ppr_u1/accept', search: '', body: { text: 'Wants two sources for a claim.', reason: 'two is enough' } },
    ]);
    expect(await screen.findByText('Wants two sources for a claim.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Accept' })).toBeNull();
  });

  it('Reject and Retire post the reason', async () => {
    render(<You wsId="ws_1" />);
    await screen.findByRole('heading', { name: 'How the tool sees you' });
    fireEvent.change(screen.getByLabelText('reason for ppr_u1'), { target: { value: 'too strict' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Reject' }));
    });
    fireEvent.change(screen.getByLabelText('reason for pad_u1'), { target: { value: 'not any more' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Retire' }));
    });
    expect(calls.filter((c) => c.method === 'POST')).toEqual([
      { method: 'POST', path: '/api/workspaces/ws_1/persona-proposals/ppr_u1/reject', search: '', body: { reason: 'too strict' } },
      { method: 'POST', path: '/api/workspaces/ws_1/persona-adjustments/pad_u1/retire', search: '', body: { reason: 'not any more' } },
    ]);
  });

  it('a failed request keeps the typed reason and shows the error', async () => {
    failPosts = true;
    render(<You wsId="ws_1" />);
    await screen.findByRole('heading', { name: 'How the tool sees you' });
    fireEvent.change(screen.getByLabelText('reason for pad_u1'), { target: { value: 'my long reason' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Retire' }));
    });
    expect(await screen.findByText(/server unavailable/)).toBeTruthy();
    expect((screen.getByLabelText('reason for pad_u1') as HTMLInputElement).value).toBe('my long reason');
  });

  it('a failed Accept keeps the edited text and the reason in their boxes', async () => {
    failPosts = true;
    render(<You wsId="ws_1" />);
    await screen.findByRole('heading', { name: 'How the tool sees you' });
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    fireEvent.change(screen.getByLabelText('text of ppr_u1'), { target: { value: 'Copies someone@example.com.' } });
    fireEvent.change(screen.getByLabelText('reason for ppr_u1'), { target: { value: 'my typed reason' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Accept' }));
    });
    expect(await screen.findByText(/server unavailable/)).toBeTruthy();
    expect((screen.getByLabelText('text of ppr_u1') as HTMLTextAreaElement).value).toBe('Copies someone@example.com.');
    expect((screen.getByLabelText('reason for ppr_u1') as HTMLInputElement).value).toBe('my typed reason');
  });

  it('a replaced line (new version) loads its own evidence, not the old version\'s', async () => {
    render(<You wsId="ws_1" />);
    await screen.findByRole('heading', { name: 'How the tool sees you' });
    await act(async () => {
      fireEvent.click(within(screen.getByRole('region', { name: 'line A-71C0DE' })).getByRole('button', { name: '▸ show' }));
    });
    current = view({ fields: [{ field: 'priorities', lines: [{ ...line, version: 2, text: 'Prefers changes that ship within a month.' }] }] });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Reject' }));
    });
    expect(await screen.findByText('A-71C0DE.v2')).toBeTruthy();
    const card = within(screen.getByRole('region', { name: 'line A-71C0DE' }));
    expect(card.queryByText('include_override on finding fnd_1: include=false')).toBeNull();
    await act(async () => {
      fireEvent.click(card.getByRole('button', { name: '▸ show' }));
    });
    expect(calls.filter((c) => c.path.endsWith('/interactions'))).toHaveLength(2);
  });

  it('"show" loads the interactions a line rests on once, with stance, detail, reason (as text) and date', async () => {
    render(<You wsId="ws_1" />);
    await screen.findByRole('heading', { name: 'How the tool sees you' });
    expect(calls.some((c) => c.path.endsWith('/interactions'))).toBe(false);
    const lineCard = within(screen.getByRole('region', { name: 'line A-71C0DE' }));
    await act(async () => {
      fireEvent.click(lineCard.getByRole('button', { name: '▸ show' }));
    });
    expect(calls.filter((c) => c.path === '/api/workspaces/ws_1/user-persona/interactions').map((c) => c.search)).toEqual(['?line=pad_u1']);
    expect(lineCard.getByText('include_override on finding fnd_1: include=false')).toBeTruthy();
    expect(lineCard.getByText('reject')).toBeTruthy();
    expect(lineCard.getByText(/your reason: <i>one<\/i> review site/)).toBeTruthy();
    expect([...document.querySelectorAll('i')].some((e) => e.textContent === 'one')).toBe(false);
    await act(async () => {
      fireEvent.click(lineCard.getByRole('button', { name: '▾ hide' }));
    });
    expect(lineCard.queryByText('include_override on finding fnd_1: include=false')).toBeNull();
    await act(async () => {
      fireEvent.click(lineCard.getByRole('button', { name: '▸ show' }));
    });
    expect(calls.filter((c) => c.path.endsWith('/interactions'))).toHaveLength(1);
  });
});

describe('Lessons page', () => {
  it('links the waiting proposals about you to the You page, and the rest to Audience & Personas', async () => {
    learning = { enabled: true, personas: [], pendingInTree: 3, pendingUser: 1 };
    render(<Lessons wsId="ws_1" />);
    expect((await screen.findByRole('link', { name: '2 persona proposals waiting' })).getAttribute('href')).toBe('#/w/ws_1/personas');
    expect(screen.getByRole('link', { name: '1 proposal about you waiting' }).getAttribute('href')).toBe('#/w/ws_1/you');
  });
});
