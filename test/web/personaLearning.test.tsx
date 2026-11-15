// @vitest-environment jsdom
/**
 * Persona learning on the Personas page (design §14): the "What the tool has learned" block on each
 * persona card, the user's accept / edit / reject / retire, the signals on demand, and the count of
 * waiting persona proposals on the Lessons page.
 */
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { asPersonaLearningView, effectLine, evidenceLine, gateLines, reactionsLine, waitingText } from '../../web/src/logic/personaLearning.js';
import type { PersonaLearningView, PersonaProposal, PersonaSignal } from '../../web/src/logic/types.js';
import { Lessons } from '../../web/src/views/Lessons.js';
import { Personas } from '../../web/src/views/Personas.js';

const STATS = { n: 9, agree: 4, disagree: 5, items: 6, lower: 0.27 };
const proposal = (extra: Partial<PersonaProposal> = {}): PersonaProposal => ({
  id: 'ppr_1', rootWorkspaceId: 'ws_1', workspaceId: 'ws_1', personaId: 'per_1', action: 'add', field: 'buying_behavior',
  text: 'You compare on total yearly cost, not the monthly price.', rationale: 'Disagreed on price-first flows.', evidence: ['fbk_1', 'fbk_2'],
  stats: STATS, source: 'retro', status: 'pending', createdAt: '2026-11-16T06:00:00.000Z', ...extra,
});
const signals: PersonaSignal[] = [
  { id: 'fbk_2', source: 'verdict_reaction', personaId: 'per_1', polarity: 'disagree', itemKey: 'a|b', topic: 'flow:sign_up', detail: 'preferred Acme over Globex; you disagreed', reason: '<b>never</b> reads pricing', refs: [], at: '2026-11-12T00:00:00.000Z' },
  { id: 'fbk_1', source: 'verdict_reaction', personaId: 'per_1', polarity: 'agree', itemKey: 'a|c', topic: 'flow:sign_up', detail: 'preferred Acme over Initech; you agreed', refs: [], at: '2026-11-11T00:00:00.000Z' },
  { id: 'fbk_0', source: 'include', personaId: 'per_1', polarity: 'disagree', itemKey: 'persona', topic: 'persona', detail: 'you left the persona out', refs: [], at: '2026-11-10T00:00:00.000Z' },
];

function view(proposals: PersonaProposal[]): PersonaLearningView {
  return {
    enabled: true,
    personas: [
      {
        personaId: 'per_1', segment: 'SMB owner', version: 3,
        gate: { ...STATS, qualifies: false, missing: ['disagreement not clearly above 30%'] },
        adjustments: [
          {
            id: 'pad_1', rootWorkspaceId: 'ws_1', workspaceId: 'ws_1', personaId: 'per_1', marker: 'A-3F9C21', text: 'You distrust flows that ask for a card first.',
            version: 2, status: 'active', source: 'retro', actor: 'local-user', stats: { n: 8, disagree: 5 }, internal: false, createdAt: '', changedAt: '',
            effect: { before: { n: 8, disagree: 5 }, since: { n: 5, agree: 4, disagree: 1, items: 4, lower: 0.04 } },
          },
        ],
        proposals,
        lastRun: { id: 'plr_1', status: 'proposed', assumption: 'This persona overrates short sign-up forms.', createdAt: '2026-11-16T06:00:00.000Z', stats: STATS },
      },
    ],
  };
}

let calls: Array<{ method: string; path: string; body?: unknown }> = [];
let current: PersonaLearningView;
let failSignals = false;

beforeEach(() => {
  calls = [];
  failSignals = false;
  current = view([proposal(), proposal({ id: 'ppr_old', status: 'rejected', text: 'You buy on brand.', decidedAt: '2026-11-01T00:00:00.000Z', reason: 'no' })]);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init?: RequestInit) => {
      const path = new URL(String(input), 'http://localhost').pathname;
      const method = init?.method ?? 'GET';
      calls.push({ method, path, ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) });
      let body: unknown = {};
      if (path === '/api/workspaces/ws_1/personas') {
        body = [{ id: 'per_1', workspaceId: 'ws_1', slug: 'sam', segment: 'SMB owner', profile: {}, agentMdPath: 'sam.md', version: 3, status: 'verified' }];
      } else if (path === '/api/workspaces/ws_1/persona-learning') {
        body = current;
      } else if (path === '/api/workspaces/ws_1/personas/per_1/signals') {
        if (failSignals) return new Response(JSON.stringify({ error: 'boom' }), { status: 500, headers: { 'content-type': 'application/json' } });
        body = { signals };
      } else if (path.endsWith('/accept')) {
        current = view([proposal({ status: 'accepted', decidedAt: '2026-11-16T07:00:00.000Z', finalText: 'You look at the yearly total.' })]);
      } else if (path === '/api/workspaces/ws_1/lessons') {
        body = { rootWorkspaceId: 'ws_1', roles: [], proposals: [], rules: [], retros: [] };
      } else if (method === 'GET') {
        body = [];
      }
      return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
    }),
  );
  vi.stubGlobal('EventSource', class { addEventListener() {} removeEventListener() {} close() {} });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('persona learning wording', () => {
  it('reactions, gate lines, effect, evidence, waiting count, payload shape', () => {
    expect(reactionsLine(STATS)).toBe('Reactions not yet used by a retro: 9 (4 agree, 5 disagree) on 6 different things.');
    expect(gateLines({ qualifies: false, missing: ['4 of 6 reactions', '3 of 4 different things'] }, false)).toEqual([
      'Not enough for a change yet: 4 of 6 reactions.',
      'Not enough for a change yet: 3 of 4 different things.',
    ]);
    expect(gateLines({ qualifies: true, missing: [] }, false)).toEqual(['Enough for a change at the next retro.']);
    expect(gateLines({ qualifies: true, missing: [] }, true)).not.toContain('Enough for a change at the next retro.');
    expect(effectLine({ before: { n: 8, disagree: 5 }, since: { n: 5, agree: 4, disagree: 1, items: 4, lower: 0 } })).toBe('Disagreement before 63% of 8 · since 20% of 5');
    expect(effectLine({ before: {}, since: { n: 0, agree: 0, disagree: 0, items: 0, lower: 0 } })).toBe('Disagreement before — · since —');
    expect(evidenceLine(proposal())).toBe('Rests on 2 reactions');
    expect(evidenceLine(proposal(), signals)).toBe('Rests on 2 reactions (1 disagree, 1 agree)');
    expect(waitingText(2)).toBe('2 persona proposals waiting');
    expect(waitingText(1)).toBe('1 persona proposal waiting');
    expect(asPersonaLearningView([])).toBeNull();
    expect(asPersonaLearningView(current)).toBe(current);
  });
});

describe('Personas page: what the tool has learned', () => {
  it('shows the reactions line, the missing lines, the assumption, the proposal and the active adjustment with its effect', async () => {
    render(<Personas wsId="ws_1" />);
    const block = await screen.findByRole('region', { name: 'what the tool has learned about per_1' });
    const b = within(block);
    expect(b.getByText(/Reactions not yet used by a retro: 9 \(4 agree, 5 disagree\) on 6 different things\./)).toBeTruthy();
    expect(b.getByText('Not enough for a change yet: disagreement not clearly above 30%.')).toBeTruthy();
    expect(b.getByText(/This persona overrates short sign-up forms\./)).toBeTruthy();
    expect(b.getByText(/simulated/)).toBeTruthy();
    expect(b.getByText('"You compare on total yearly cost, not the monthly price."')).toBeTruthy();
    expect(b.getAllByText('add (buying_behavior)')).toHaveLength(2); // the pending one and the decided one
    expect(b.getByText('You buy on brand.')).toBeTruthy();
    expect(b.getByText('A-3F9C21.v2')).toBeTruthy();
    expect(b.getByText('Disagreement before 63% of 8 · since 20% of 5')).toBeTruthy();
    expect(b.getByRole('button', { name: 'Retire' })).toBeTruthy();
  });

  it('Edit then Accept posts the edited text and the reason; the decided proposal no longer shows buttons', async () => {
    render(<Personas wsId="ws_1" />);
    const block = await screen.findByRole('region', { name: 'what the tool has learned about per_1' });
    const b = within(block);
    fireEvent.click(b.getByRole('button', { name: 'Edit' }));
    fireEvent.change(b.getByLabelText('text of ppr_1'), { target: { value: 'You look at the yearly total.' } });
    fireEvent.change(b.getByLabelText('reason for ppr_1'), { target: { value: 'they pay yearly' } });
    await act(async () => {
      fireEvent.click(b.getByRole('button', { name: 'Accept' }));
    });
    expect(calls.find((c) => c.method === 'POST')).toEqual({
      method: 'POST',
      path: '/api/workspaces/ws_1/persona-proposals/ppr_1/accept',
      body: { text: 'You look at the yearly total.', reason: 'they pay yearly' },
    });
    expect(await b.findByText('You look at the yearly total.')).toBeTruthy();
    expect(b.queryByRole('button', { name: 'Accept' })).toBeNull();
    expect(b.queryByRole('button', { name: 'Reject' })).toBeNull();
    expect(b.queryByRole('button', { name: 'Edit' })).toBeNull();
  });

  it('Accept without an edit sends no text; Reject and Retire post the reason', async () => {
    render(<Personas wsId="ws_1" />);
    const b = within(await screen.findByRole('region', { name: 'what the tool has learned about per_1' }));
    fireEvent.change(b.getByLabelText('reason for ppr_1'), { target: { value: 'wrong segment' } });
    await act(async () => {
      fireEvent.click(b.getByRole('button', { name: 'Reject' }));
    });
    fireEvent.change(b.getByLabelText('reason for pad_1'), { target: { value: 'stale' } });
    await act(async () => {
      fireEvent.click(b.getByRole('button', { name: 'Retire' }));
    });
    const posts = calls.filter((c) => c.method === 'POST');
    expect(posts).toEqual([
      { method: 'POST', path: '/api/workspaces/ws_1/persona-proposals/ppr_1/reject', body: { reason: 'wrong segment' } },
      { method: 'POST', path: '/api/workspaces/ws_1/persona-adjustments/pad_1/retire', body: { reason: 'stale' } },
    ]);
  });

  it('"show" loads the signals once and renders the user\'s reason as text', async () => {
    render(<Personas wsId="ws_1" />);
    const b = within(await screen.findByRole('region', { name: 'what the tool has learned about per_1' }));
    expect(calls.some((c) => c.path.endsWith('/signals'))).toBe(false);
    const [all, cited] = b.getAllByRole('button', { name: '▸ show' });
    await act(async () => {
      fireEvent.click(all!);
    });
    expect(b.getByText('you left the persona out')).toBeTruthy();
    expect(b.getByText(/your reason: <b>never<\/b> reads pricing/)).toBeTruthy();
    expect([...block().querySelectorAll('b')].some((e) => e.textContent === 'never')).toBe(false);
    await act(async () => {
      fireEvent.click(cited!);
    });
    expect(b.getByText('Rests on 2 reactions (1 disagree, 1 agree)')).toBeTruthy();
    expect(calls.filter((c) => c.path.endsWith('/signals'))).toHaveLength(1);
  });

  it('after accept, reject or retire the loaded signals are fetched again (they changed)', async () => {
    render(<Personas wsId="ws_1" />);
    const b = within(await screen.findByRole('region', { name: 'what the tool has learned about per_1' }));
    await act(async () => {
      fireEvent.click(b.getAllByRole('button', { name: '▸ show' })[0]!);
    });
    const fetches = () => calls.filter((c) => c.path.endsWith('/signals')).length;
    expect(fetches()).toBe(1);
    await act(async () => {
      fireEvent.click(b.getByRole('button', { name: 'Reject' }));
    });
    expect(fetches()).toBe(2);
    await act(async () => {
      fireEvent.click(b.getByRole('button', { name: 'Retire' }));
    });
    expect(fetches()).toBe(3);
    expect(b.queryByText('loading…')).toBeNull();
    expect(b.getByText('you left the persona out')).toBeTruthy();
  });

  it('after a decision, signals not loaded yet are not fetched', async () => {
    render(<Personas wsId="ws_1" />);
    const b = within(await screen.findByRole('region', { name: 'what the tool has learned about per_1' }));
    await act(async () => {
      fireEvent.click(b.getByRole('button', { name: 'Accept' }));
    });
    expect(calls.some((c) => c.path.endsWith('/signals'))).toBe(false);
  });

  it('a failed signals fetch shows the error and does not stay on "loading…"', async () => {
    failSignals = true;
    render(<Personas wsId="ws_1" />);
    const b = within(await screen.findByRole('region', { name: 'what the tool has learned about per_1' }));
    await act(async () => {
      fireEvent.click(b.getAllByRole('button', { name: '▸ show' })[0]!);
    });
    expect(b.queryByText('loading…')).toBeNull();
    expect(b.getAllByRole('button', { name: '▸ show' })).toHaveLength(2);
    expect(screen.getByText(/boom/)).toBeTruthy();
  });

  it('an edit box that is empty or only spaces disables Accept', async () => {
    render(<Personas wsId="ws_1" />);
    const b = within(await screen.findByRole('region', { name: 'what the tool has learned about per_1' }));
    fireEvent.click(b.getByRole('button', { name: 'Edit' }));
    const accept = () => b.getByRole('button', { name: 'Accept' }) as HTMLButtonElement;
    expect(accept().disabled).toBe(false);
    fireEvent.change(b.getByLabelText('text of ppr_1'), { target: { value: '   ' } });
    expect(accept().disabled).toBe(true);
    await act(async () => {
      fireEvent.click(accept());
    });
    expect(calls.some((c) => c.method === 'POST')).toBe(false);
    fireEvent.change(b.getByLabelText('text of ppr_1'), { target: { value: 'You pay yearly.' } });
    expect(accept().disabled).toBe(false);
  });
});

const block = () => screen.getByRole('region', { name: 'what the tool has learned about per_1' });

describe('Lessons page', () => {
  it('shows the number of waiting persona proposals with a link to the Personas view', async () => {
    current = view([proposal(), proposal({ id: 'ppr_2' }), proposal({ id: 'ppr_3', status: 'accepted' })]);
    render(<Lessons wsId="ws_1" />);
    const link = await screen.findByRole('link', { name: '2 persona proposals waiting' });
    expect(link.getAttribute('href')).toBe('#/w/ws_1/personas');
  });

  it('counts the waiting persona proposals of the whole business tree (pendingInTree), not only this node', async () => {
    current = { ...view([proposal()]), pendingInTree: 3 };
    render(<Lessons wsId="ws_1" />);
    expect(await screen.findByRole('link', { name: '3 persona proposals waiting' })).toBeTruthy();
  });
});
