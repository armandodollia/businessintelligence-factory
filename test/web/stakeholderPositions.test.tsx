// @vitest-environment jsdom
/**
 * Stakeholder positions on the Stakeholders page (design 2026-11-15-stakeholder-positions-design.md §10):
 * the "Position" line and the "Change position" form of an own stakeholder, a former colleague in its
 * competitor's group with the three profiles, "Moved to another company" and "Returned", and the "Former
 * stakeholders" group.
 */
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetRatingIndexes } from '../../web/src/logic/hooks.js';
import { ELSEWHERE, localToday, newPositionDraft, NOT_LISTED, positionInput, positionLine, publicLayerNotes } from '../../web/src/logic/stakeholders.js';
import type { OpenStakeholderView, StakeholderPlaces, StakeholderPositionsView, StakeholdersView } from '../../web/src/logic/types.js';
import { Stakeholders } from '../../web/src/views/Stakeholders.js';

const T = '2026-11-15T00:00:00.000Z';
const LEFT = '2026-10-31';
const field = (value: string, extra: Record<string, unknown> = {}) => ({ value, confidence: 0.6, evidence: ['art_1'], ...extra });

const FIN: OpenStakeholderView = {
  id: 'per_fin', label: 'Head of finance', stakeholderType: 'leader', disclosure: 'open', subjectKind: 'own', relation: 'Approves pricing changes',
  profile: { decision_criteria: field('Payback under a year') }, version: 2, status: 'verified', statements: 0, questions: 0, positionTitle: 'Finance director',
};
const RIVAL: OpenStakeholderView = {
  id: 'per_rival', label: 'Chief executive', stakeholderType: 'leader', disclosure: 'open', subjectKind: 'competitor', relation: 'Sets the rival roadmap',
  profile: { decision_criteria: field('Growth first') }, version: 1, status: 'verified', statements: 0, questions: 0,
};
const GONE: OpenStakeholderView = {
  id: 'per_gone', label: 'Head of sales', stakeholderType: 'leader', disclosure: 'open', subjectKind: 'competitor', relation: 'VP Sales', positionTitle: 'VP Sales',
  profile: {
    decision_criteria: field('Closes on margin', { basis: 'internal' }),
    priorities: field('Enterprise accounts', { basis: 'public' }),
    objections: field('Long pilots', { basis: 'both', conflict: 'We knew short pilots; the <i>press</i> says long ones.' }),
    incentives: field('Will target our accounts', { basis: 'inferred' }),
  },
  version: 3, status: 'verified', statements: 0, questions: 0, leftAt: LEFT,
  leftFrom: { workspaceId: 'ws_1', scopeName: 'Acme Group', stakeholderType: 'leader', title: 'Head of Sales EMEA', relation: 'Owns the sales plan' },
  publicPosition: { text: 'VP Sales at Rival Pay', evidence: ['art_2'] }, hasPublicLayer: true,
};
const PARKED: OpenStakeholderView = {
  id: 'per_parked', label: 'Head of legal', stakeholderType: 'leader', disclosure: 'open', subjectKind: 'former', relation: '',
  profile: { decision_criteria: field('Reads every clause', { basis: 'internal' }) }, version: 2, status: 'verified', statements: 0, questions: 0, leftAt: LEFT,
  leftFrom: { workspaceId: 'ws_1', scopeName: 'Acme Group', stakeholderType: 'leader' }, hasPublicLayer: false,
};
const PLACES: StakeholderPlaces = {
  competitors: [{ competitorId: 'cmp_1', name: 'Rival Pay' }, { competitorId: 'cmp_2', name: 'Other Rival' }],
  nodes: [{ workspaceId: 'ws_1', name: 'Acme Group' }, { workspaceId: 'ws_2', name: 'Acme Payments' }],
};

const row = (id: string, personaId: string, change: string, extra: Record<string, unknown>) =>
  ({ id, rootWorkspaceId: 'ws_1', personaId, change, actor: 'u', createdAt: T, ...extra }) as StakeholderPositionsView['positions'][number];

let calls: Array<{ method: string; path: string; body?: unknown }> = [];
let list: StakeholdersView;
let histories: Record<string, StakeholderPositionsView>;
/** When set, `POST …/position` is refused with this status and message. */
let refuse: { status: number; error: string } | null;
/** The persona whose history never arrives (its request stays open), or null. */
let historyPending: string | null;

function initial() {
  list = { enabled: true, own: [FIN], competitors: [{ competitorId: 'cmp_1', name: 'Rival Pay', stakeholders: [RIVAL, GONE] }], former: [PARKED], places: PLACES };
  histories = {
    per_fin: {
      positions: [
        row('spo_2', 'per_fin', 'promoted', { placeKind: 'node', workspaceId: 'ws_1', placeName: 'Acme Group', title: 'Finance director', effectiveOn: '2026-09-01' }),
        row('spo_1', 'per_fin', 'joined', { placeKind: 'node', workspaceId: 'ws_1', placeName: 'Acme Group' }),
      ],
    },
    per_gone: {
      positions: [row('spo_4', 'per_gone', 'left', { placeKind: 'competitor', competitorId: 'cmp_1', placeName: 'Rival Pay', title: 'VP Sales', effectiveOn: LEFT })],
      internalProfile: { decision_criteria: field('Closes on margin, as we knew', { basis: 'internal' }) },
      publicProfile: { priorities: field('Enterprise accounts, as the press says', { basis: 'public' }) },
    },
    per_parked: {
      positions: [row('spo_6', 'per_parked', 'left', { placeKind: 'elsewhere', companyName: 'A law firm', placeName: 'A law firm', effectiveOn: LEFT })],
      internalProfile: { decision_criteria: field('Reads every clause, as we knew', { basis: 'internal' }) },
    },
  };
  refuse = null;
  historyPending = null;
}

function respond(method: string, path: string): { status: number; body: unknown } {
  const base = '/api/workspaces/ws_1';
  const ok = (body: unknown) => ({ status: 200, body });
  if (path === `${base}/stakeholders`) return ok(list);
  if (path === `${base}/stakeholder-questions`) return ok({ groups: [] });
  const positions = path.match(/\/stakeholders\/([^/]+)\/positions$/);
  if (positions) return ok(histories[positions[1]!] ?? { positions: [] });
  const position = path.match(/\/stakeholders\/([^/]+)\/position$/);
  if (position && method === 'POST') return refuse ? { status: refuse.status, body: { error: refuse.error } } : ok({ id: position[1] });
  if (path.endsWith('/statements')) return ok({ statements: [] });
  if (path === `${base}/persona-learning`) return ok({ enabled: true, personas: [] });
  if (path.startsWith('/api/artifacts/')) return ok({ id: 'art_1', workspaceId: 'ws_1', kind: 'page', mime: 'text/html', path: 'a.html', sha256: 'x', createdAt: T });
  return ok(method === 'POST' ? {} : []);
}

beforeEach(() => {
  calls = [];
  initial();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init?: RequestInit) => {
      const path = new URL(String(input), 'http://localhost').pathname;
      const method = init?.method ?? 'GET';
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ method, path, ...(body !== undefined ? { body } : {}) });
      if (historyPending && path.endsWith(`/stakeholders/${historyPending}/positions`)) return new Promise<Response>(() => {});
      const r = respond(method, path);
      return new Response(JSON.stringify(r.body), { status: r.status, headers: { 'content-type': 'application/json' } });
    }),
  );
  vi.stubGlobal('EventSource', class { addEventListener() {} removeEventListener() {} close() {} });
});
afterEach(() => {
  cleanup();
  resetRatingIndexes();
  vi.unstubAllGlobals();
});

const posts = () => calls.filter((c) => c.method === 'POST');
const gets = (suffix: string) => calls.filter((c) => c.method === 'GET' && c.path.endsWith(suffix));
const card = async (label: string) => within(await screen.findByRole('region', { name: `stakeholder ${label}` }));
const options = (select: HTMLElement) => [...(select as HTMLSelectElement).options].map((o) => o.textContent);
const click = async (el: HTMLElement) => {
  await act(async () => {
    fireEvent.click(el);
  });
};
const type = (el: HTMLElement, value: string) => fireEvent.change(el, { target: { value } });

describe('position wording and the body of a change', () => {
  const draft = (form: 'change' | 'movedOn' | 'returned', v = FIN) => newPositionDraft(form, v, 'ws_1', PLACES);

  it('a new draft: today, the first competitor, the stakeholder\'s own type', () => {
    expect(localToday()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(draft('change')).toMatchObject({ form: 'change', change: 'left', date: localToday(), destination: 'cmp_1', stakeholderType: 'leader', toWorkspaceId: '' });
    expect(draft('movedOn', PARKED)).toMatchObject({ form: 'movedOn', change: 'left', destination: 'cmp_1' });
    expect(draft('returned', GONE)).toMatchObject({ form: 'returned', change: 'returned', toWorkspaceId: 'ws_1' });
    // No competitor in the tree yet: a company not listed.
    expect(newPositionDraft('change', FIN, 'ws_1', { competitors: [], nodes: PLACES.nodes }).destination).toBe(NOT_LISTED);
  });

  it('left: one destination; blank optional texts are not sent', () => {
    const d = { ...draft('change'), date: LEFT };
    expect(positionInput(d)).toEqual({ change: 'left', date: LEFT, to: { competitorId: 'cmp_1' } });
    expect(positionInput({ ...d, destination: NOT_LISTED })).toBeNull();
    expect(positionInput({ ...d, destination: NOT_LISTED, companyName: ' New Rival ', site: ' https://newrival.example ' })).toEqual({
      change: 'left', date: LEFT, to: { newCompetitor: { name: 'New Rival', site: 'https://newrival.example' } },
    });
    expect(positionInput({ ...d, destination: ELSEWHERE, companyName: '  ', label: ' The finance lead ', title: ' Partner ', note: ' Told us in May. ' })).toEqual({
      change: 'left', date: LEFT, to: { elsewhere: {} }, label: 'The finance lead', title: 'Partner', note: 'Told us in May.',
    });
    expect(positionInput({ ...d, destination: ELSEWHERE, companyName: 'A law firm' })).toEqual({ change: 'left', date: LEFT, to: { elsewhere: { companyName: 'A law firm' } } });
    // A former colleague who moved on can be renamed too (the way out when the name is taken where they go); the destinations are those of a leave.
    expect(positionInput({ ...draft('movedOn', PARKED), date: LEFT, label: ' Someone ' })).toEqual({ change: 'left', date: LEFT, to: { competitorId: 'cmp_1' }, label: 'Someone' });
    expect(positionInput({ ...draft('movedOn', PARKED), date: LEFT, label: '  ' })).toEqual({ change: 'left', date: LEFT, to: { competitorId: 'cmp_1' } });
    expect(positionInput({ ...draft('movedOn', GONE), date: LEFT, destination: ELSEWHERE, companyName: 'A consultancy', title: 'Partner' })).toEqual({
      change: 'left', date: LEFT, to: { elsewhere: { companyName: 'A consultancy' } }, title: 'Partner',
    });
    expect(positionInput({ ...d, date: '' })).toBeNull();
  });

  it('moved needs another node; promoted and demoted may name one; the type is sent only when it changed; returned names its node', () => {
    const d = { ...draft('change'), date: LEFT };
    expect(positionInput({ ...d, change: 'moved' })).toBeNull();
    expect(positionInput({ ...d, change: 'moved', toWorkspaceId: 'ws_2' })).toEqual({ change: 'moved', date: LEFT, toWorkspaceId: 'ws_2' });
    expect(positionInput({ ...d, change: 'promoted', title: 'Chief financial officer' })).toEqual({ change: 'promoted', date: LEFT, title: 'Chief financial officer' });
    expect(positionInput({ ...d, change: 'demoted', toWorkspaceId: 'ws_2', stakeholderType: 'manager' })).toEqual({
      change: 'demoted', date: LEFT, toWorkspaceId: 'ws_2', stakeholderType: 'manager',
    });
    expect(positionInput({ ...draft('returned', GONE), date: LEFT })).toEqual({ change: 'returned', date: LEFT, toWorkspaceId: 'ws_1' });
    expect(positionInput({ ...draft('returned', GONE), date: LEFT, label: ' The sales lead ' })).toEqual({ change: 'returned', date: LEFT, toWorkspaceId: 'ws_1', label: 'The sales lead' });
    // Moved, promoted and demoted never rename.
    expect(positionInput({ ...d, change: 'promoted', label: 'Someone' })).toEqual({ change: 'promoted', date: LEFT });
    expect(positionInput({ ...draft('returned', GONE), date: LEFT, toWorkspaceId: '' })).toBeNull();
  });

  it('the position line: title (else the type) and since when; for a former colleague the title and the company', () => {
    expect(positionLine(FIN, histories.per_fin!.positions)).toBe('Position: Finance director, since 2026-09-01');
    expect(positionLine(FIN, [])).toBe('Position: Finance director');
    expect(positionLine({ ...FIN, positionTitle: undefined }, [histories.per_fin!.positions[1]!])).toBe('Position: leader');
    expect(positionLine(GONE, histories.per_gone!.positions)).toBe('Position: VP Sales at Rival Pay');
    expect(positionLine(PARKED, histories.per_parked!.positions)).toBe('Position: A law firm');
    expect(positionLine(PARKED, [])).toBe('Position: not known');
    // Moved on since: the newest place counts, whatever the row is called.
    const on = row('spo_7', 'per_gone', 'moved', { placeKind: 'competitor', competitorId: 'cmp_2', placeName: 'Other Rival', effectiveOn: '2026-11-10' });
    expect(positionLine(GONE, [on, ...histories.per_gone!.positions])).toBe('Position: VP Sales at Other Rival');
    const out = row('spo_8', 'per_gone', 'moved', { placeKind: 'elsewhere', effectiveOn: '2026-11-12' });
    expect(positionLine({ ...GONE, positionTitle: undefined }, [out, on, ...histories.per_gone!.positions])).toBe('Position: not known');
  });

  it('the notes under "What is public": not used when its research failed, used although not verified, not combined yet while newer than the combined profile', () => {
    const publicProfile = { priorities: field('x') };
    const NOT_USED = 'Not used: the research that found this failed';
    const UNVERIFIED = 'Used, although the research that found this was not verified';
    const LATER = '2026-11-16T00:00:00.000Z';
    expect(publicLayerNotes({ positions: [] })).toEqual([]);
    expect(publicLayerNotes({ positions: [], publicProfile, publicLayerUsed: false, publicLayerStatus: 'failed', publicSavedAt: T })).toEqual([NOT_USED]);
    // Not used says it all: such a layer is never combined.
    expect(publicLayerNotes({ positions: [], publicProfile, publicLayerUsed: false, publicLayerStatus: 'failed', publicSavedAt: T, combinedAt: '2026-11-01T00:00:00.000Z' })).toEqual([NOT_USED]);
    expect(publicLayerNotes({ positions: [], publicProfile, publicLayerUsed: true, publicLayerStatus: 'pending', publicSavedAt: T })).toEqual(['Not combined yet']);
    expect(publicLayerNotes({ positions: [], publicProfile, publicLayerUsed: true, publicLayerStatus: 'verified', publicSavedAt: T, combinedAt: '2026-11-01T00:00:00.000Z' })).toEqual(['Not combined yet']);
    expect(publicLayerNotes({ positions: [], publicProfile, publicLayerUsed: true, publicLayerStatus: 'verified', publicSavedAt: T, combinedAt: LATER })).toEqual([]);
    // Research that ended unverified is used, and the page says so, before and after it was combined.
    expect(publicLayerNotes({ positions: [], publicProfile, publicLayerUsed: true, publicLayerStatus: 'unverified', publicSavedAt: T })).toEqual([UNVERIFIED, 'Not combined yet']);
    expect(publicLayerNotes({ positions: [], publicProfile, publicLayerUsed: true, publicLayerStatus: 'unverified', publicSavedAt: T, combinedAt: LATER })).toEqual([UNVERIFIED]);
    // A server older than `publicLayerStatus` says what it can; one older than both fields says nothing.
    expect(publicLayerNotes({ positions: [], publicProfile, publicLayerUsed: false, publicSavedAt: T })).toEqual([NOT_USED]);
    expect(publicLayerNotes({ positions: [], publicProfile, publicLayerUsed: true, publicSavedAt: T })).toEqual(['Not combined yet']);
    expect(publicLayerNotes({ positions: [], publicProfile })).toEqual([]);
  });
});

describe('Stakeholders page: the position of an own stakeholder', () => {
  it('shows the Position line and, behind "Change position", a form with a date input set to today and the places of the tree', async () => {
    render(<Stakeholders wsId="ws_1" />);
    const c = await card('Head of finance');
    expect(await c.findByText('Position: Finance director, since 2026-09-01')).toBeTruthy();
    expect(c.queryByRole('group', { name: 'position of per_fin' })).toBeNull();
    expect(c.queryByRole('button', { name: 'Returned' })).toBeNull();
    await click(c.getByRole('button', { name: 'Change position' }));
    const form = within(c.getByRole('group', { name: 'position of per_fin' }));
    expect(options(form.getByLabelText('What changed'))).toEqual(['Left the company', 'Moved to another team or division', 'Promoted', 'Demoted']);
    const date = form.getByLabelText('Date') as HTMLInputElement;
    expect(date.type).toBe('date');
    expect(date.value).toBe(localToday());
    expect(date.max).toBe(localToday());
    expect(options(form.getByLabelText('Where to'))).toEqual(['Rival Pay', 'Other Rival', 'A company not listed', 'Elsewhere']);
    await click(form.getByRole('button', { name: 'Cancel' }));
    expect(c.queryByRole('group', { name: 'position of per_fin' })).toBeNull();
    expect(posts()).toEqual([]);
  });

  it('Left the company posts the destination: a competitor, a company not listed (name and site), or elsewhere', async () => {
    render(<Stakeholders wsId="ws_1" />);
    const c = await card('Head of finance');
    const open = async () => {
      await click(c.getByRole('button', { name: 'Change position' }));
      return within(c.getByRole('group', { name: 'position of per_fin' }));
    };
    let form = await open();
    type(form.getByLabelText('Date'), LEFT);
    type(form.getByLabelText('Where to'), 'cmp_2');
    await click(form.getByRole('button', { name: 'Save' }));
    // Saved: the form closes, the list and the history are loaded again.
    expect(c.queryByRole('group', { name: 'position of per_fin' })).toBeNull();
    expect(gets('/stakeholders')).toHaveLength(2);
    expect(gets('/per_fin/positions')).toHaveLength(2);

    form = await open();
    type(form.getByLabelText('Date'), LEFT);
    type(form.getByLabelText('Where to'), NOT_LISTED);
    const save = () => form.getByRole('button', { name: 'Save' }) as HTMLButtonElement;
    expect(save().disabled).toBe(true);
    type(form.getByLabelText('Company name'), 'New Rival');
    type(form.getByLabelText('Site'), 'https://newrival.example');
    expect(save().disabled).toBe(false);
    await click(save());

    form = await open();
    type(form.getByLabelText('Date'), LEFT);
    type(form.getByLabelText('Where to'), ELSEWHERE);
    expect(form.queryByLabelText('Site')).toBeNull();
    type(form.getByLabelText('Company name'), 'A law firm');
    type(form.getByLabelText('New name'), 'The finance lead');
    type(form.getByLabelText('Title there'), 'Partner');
    type(form.getByLabelText('Note'), 'Told us in May.');
    await click(form.getByRole('button', { name: 'Save' }));

    const path = '/api/workspaces/ws_1/stakeholders/per_fin/position';
    expect(posts()).toEqual([
      { method: 'POST', path, body: { change: 'left', date: LEFT, to: { competitorId: 'cmp_2' } } },
      { method: 'POST', path, body: { change: 'left', date: LEFT, to: { newCompetitor: { name: 'New Rival', site: 'https://newrival.example' } } } },
      { method: 'POST', path, body: { change: 'left', date: LEFT, to: { elsewhere: { companyName: 'A law firm' } }, label: 'The finance lead', title: 'Partner', note: 'Told us in May.' } },
    ]);
  });

  it('Moved lists the other nodes of the tree; Promoted and Demoted may stay; each posts its body with today as the date', async () => {
    render(<Stakeholders wsId="ws_1" />);
    const c = await card('Head of finance');
    await click(c.getByRole('button', { name: 'Change position' }));
    let form = within(c.getByRole('group', { name: 'position of per_fin' }));
    type(form.getByLabelText('What changed'), 'moved');
    expect(form.queryByLabelText('Where to')).toBeNull();
    expect(form.queryByLabelText('New name')).toBeNull();
    expect(options(form.getByLabelText('Team or division'))).toEqual(['Acme Payments']);
    type(form.getByLabelText('Title'), 'Head of finance, payments');
    await click(form.getByRole('button', { name: 'Save' }));

    await click(c.getByRole('button', { name: 'Change position' }));
    form = within(c.getByRole('group', { name: 'position of per_fin' }));
    type(form.getByLabelText('What changed'), 'promoted');
    expect(options(form.getByLabelText('Team or division'))).toEqual(['Stays here', 'Acme Payments']);
    expect((form.getByLabelText('Type') as HTMLSelectElement).value).toBe('leader');
    type(form.getByLabelText('Type'), 'board');
    type(form.getByLabelText('Title'), 'Chief financial officer');
    await click(form.getByRole('button', { name: 'Save' }));

    await click(c.getByRole('button', { name: 'Change position' }));
    form = within(c.getByRole('group', { name: 'position of per_fin' }));
    type(form.getByLabelText('What changed'), 'demoted');
    type(form.getByLabelText('Team or division'), 'ws_2');
    await click(form.getByRole('button', { name: 'Save' }));

    const path = '/api/workspaces/ws_1/stakeholders/per_fin/position';
    const date = localToday();
    expect(posts()).toEqual([
      { method: 'POST', path, body: { change: 'moved', date, toWorkspaceId: 'ws_2', title: 'Head of finance, payments' } },
      { method: 'POST', path, body: { change: 'promoted', date, stakeholderType: 'board', title: 'Chief financial officer' } },
      { method: 'POST', path, body: { change: 'demoted', date, toWorkspaceId: 'ws_2' } },
    ]);
  });

  it('a business with one node cannot record a move', async () => {
    list = { ...list, places: { ...PLACES, nodes: [PLACES.nodes[0]!] } };
    render(<Stakeholders wsId="ws_1" />);
    const c = await card('Head of finance');
    await click(c.getByRole('button', { name: 'Change position' }));
    const form = within(c.getByRole('group', { name: 'position of per_fin' }));
    const moved = [...(form.getByLabelText('What changed') as HTMLSelectElement).options].find((o) => o.value === 'moved')!;
    expect(moved.disabled).toBe(true);
  });

  it('a refused change shows the reason in the card and keeps the form', async () => {
    refuse = { status: 409, error: "slug 'stk-rival-pay-head-of-finance' already names 'Head of finance' at that node: give this stakeholder another label" };
    render(<Stakeholders wsId="ws_1" />);
    const c = await card('Head of finance');
    await click(c.getByRole('button', { name: 'Change position' }));
    await click(within(c.getByRole('group', { name: 'position of per_fin' })).getByRole('button', { name: 'Save' }));
    // The server's own words, next to the form that was refused.
    expect(within(c.getByRole('group', { name: 'position of per_fin' })).getByText(refuse.error)).toBeTruthy();
    expect(c.getAllByText(refuse.error)).toHaveLength(1);
    expect(gets('/stakeholders')).toHaveLength(1);
    // A form opened again starts without the old refusal.
    await click(within(c.getByRole('group', { name: 'position of per_fin' })).getByRole('button', { name: 'Cancel' }));
    expect(c.queryByText(refuse.error)).toBeNull();
    await click(c.getByRole('button', { name: 'Change position' }));
    expect(c.queryByText(refuse.error)).toBeNull();
  });
});

describe('Stakeholders page: a former colleague at a competitor', () => {
  it('is shown in the competitor\'s group as a former colleague, with what research last saw and "Returned"; the competitor\'s own stakeholder has no position', async () => {
    render(<Stakeholders wsId="ws_1" />);
    const company = within(await screen.findByRole('region', { name: 'stakeholders of Rival Pay' }));
    const c = within(company.getByRole('region', { name: 'stakeholder Head of sales' }));
    expect(c.getByText('Former colleague, left 2026-10-31. Was Head of Sales EMEA at Acme Group.')).toBeTruthy();
    expect(await c.findByText('Position: VP Sales at Rival Pay')).toBeTruthy();
    expect(c.getByText('What research last saw: VP Sales at Rival Pay')).toBeTruthy();
    expect(c.getByRole('button', { name: 'Returned' })).toBeTruthy();
    expect(c.getByRole('button', { name: 'Moved to another company' })).toBeTruthy();
    expect(c.queryByRole('button', { name: 'Change position' })).toBeNull();
    // The title is shown once, in the Position line.
    expect(c.queryByText('VP Sales')).toBeNull();

    const rival = within(company.getByRole('region', { name: 'stakeholder Chief executive' }));
    expect(rival.queryByText(/^Position:/)).toBeNull();
    expect(rival.queryByText(/Former colleague/)).toBeNull();
    expect(rival.queryByRole('button', { name: /Change position|Returned|Moved to another company/ })).toBeNull();
    expect(rival.queryByRole('columnheader', { name: 'Rests on' })).toBeNull();
    // Nobody ever recorded a position for the competitor's own stakeholder: its history is not asked for.
    expect(gets('/per_rival/positions')).toEqual([]);
  });

  it('shows the three profiles: Combined with what each field rests on and where the sources disagree, What we knew, What is public', async () => {
    render(<Stakeholders wsId="ws_1" />);
    const c = await card('Head of sales');
    const combined = within(c.getByRole('region', { name: 'combined profile of per_gone' }));
    expect(combined.getByText('Combined')).toBeTruthy();
    const rows = combined.getAllByRole('row').slice(1).map((r) => r.textContent);
    expect(rows[0]).toContain('Closes on margin');
    expect(rows[0]).toContain('from what we knew');
    expect(rows[1]).toContain('from public sources');
    expect(rows[2]).toContain('from both');
    expect(rows[3]).toContain('concluded from both');
    expect(combined.getByText('Sources disagree: We knew short pilots; the <i>press</i> says long ones.')).toBeTruthy();
    expect(document.querySelector('i')).toBeNull();

    const knew = within(await c.findByRole('region', { name: 'what we knew about per_gone' }));
    expect(knew.getByText('What we knew')).toBeTruthy();
    expect(knew.getByText('Closes on margin, as we knew')).toBeTruthy();
    const found = within(c.getByRole('region', { name: 'what is public about per_gone' }));
    expect(found.getByText('What is public')).toBeTruthy();
    expect(found.getByText('Enterprise accounts, as the press says')).toBeTruthy();
    // Each layer is shown in its own section only.
    expect(combined.queryByText('Closes on margin, as we knew')).toBeNull();
    expect(knew.queryByText('Enterprise accounts, as the press says')).toBeNull();
  });

  it('says under "What is public" when the layer is not used or not combined yet', async () => {
    histories.per_gone = { ...histories.per_gone!, publicSavedAt: T, publicLayerUsed: false, publicLayerStatus: 'failed' };
    const view = render(<Stakeholders wsId="ws_1" />);
    let found = within(await (await card('Head of sales')).findByRole('region', { name: 'what is public about per_gone' }));
    expect(found.getByText('Not used: the research that found this failed')).toBeTruthy();
    expect(found.getByText('Enterprise accounts, as the press says')).toBeTruthy();
    expect(found.queryByText('Not combined yet')).toBeNull();
    view.unmount();

    histories.per_gone = { ...histories.per_gone!, publicLayerUsed: true, publicLayerStatus: 'verified' };
    render(<Stakeholders wsId="ws_1" />);
    found = within(await (await card('Head of sales')).findByRole('region', { name: 'what is public about per_gone' }));
    expect(found.getByText('Not combined yet')).toBeTruthy();
    expect(found.queryByText(/Not used|^Used/)).toBeNull();
    // Nothing is said about a layer that does not exist.
    const parked = within(await (await card('Head of legal')).findByRole('region', { name: 'what is public about per_parked' }));
    expect(parked.queryByText(/Not used|Not combined yet/)).toBeNull();
  });

  it('a combined layer carries no note', async () => {
    histories.per_gone = { ...histories.per_gone!, publicSavedAt: T, publicLayerUsed: true, publicLayerStatus: 'verified', combinedAt: '2026-11-15T01:00:00.000Z' };
    render(<Stakeholders wsId="ws_1" />);
    const found = within(await (await card('Head of sales')).findByRole('region', { name: 'what is public about per_gone' }));
    expect(found.getByText('Enterprise accounts, as the press says')).toBeTruthy();
    expect(found.queryByText(/Not used|Not combined yet|^Used/)).toBeNull();
  });

  it('says that a layer is used although the research that found it was not verified', async () => {
    histories.per_gone = { ...histories.per_gone!, publicSavedAt: T, publicLayerUsed: true, publicLayerStatus: 'unverified', combinedAt: '2026-11-15T01:00:00.000Z' };
    render(<Stakeholders wsId="ws_1" />);
    const found = within(await (await card('Head of sales')).findByRole('region', { name: 'what is public about per_gone' }));
    expect(found.getByText('Used, although the research that found this was not verified')).toBeTruthy();
    expect(found.getByText('Enterprise accounts, as the press says')).toBeTruthy();
    expect(found.queryByText(/Not used|Not combined yet/)).toBeNull();
  });

  it('Moved to another company offers the other competitors, a company not listed and elsewhere, and posts the destination', async () => {
    render(<Stakeholders wsId="ws_1" />);
    const c = await card('Head of sales');
    await c.findByText('Position: VP Sales at Rival Pay');
    const open = async () => {
      await click(c.getByRole('button', { name: 'Moved to another company' }));
      return within(c.getByRole('group', { name: 'position of per_gone' }));
    };
    let form = await open();
    expect(form.queryByLabelText('What changed')).toBeNull();
    expect((form.getByLabelText('New name') as HTMLInputElement).value).toBe('');
    // Rival Pay is where the person is: it is not offered again.
    expect(options(form.getByLabelText('Where to'))).toEqual(['Other Rival', 'A company not listed', 'Elsewhere']);
    expect((form.getByLabelText('Where to') as HTMLSelectElement).value).toBe('cmp_2');
    type(form.getByLabelText('Date'), '2026-11-10');
    type(form.getByLabelText('Title there'), 'Chief revenue officer');
    await click(form.getByRole('button', { name: 'Save' }));
    expect(c.queryByRole('group', { name: 'position of per_gone' })).toBeNull();
    expect(gets('/stakeholders')).toHaveLength(2);

    form = await open();
    type(form.getByLabelText('Date'), '2026-11-12');
    type(form.getByLabelText('Where to'), ELSEWHERE);
    type(form.getByLabelText('Company name'), 'A consultancy');
    await click(form.getByRole('button', { name: 'Save' }));

    const path = '/api/workspaces/ws_1/stakeholders/per_gone/position';
    expect(posts()).toEqual([
      { method: 'POST', path, body: { change: 'left', date: '2026-11-10', to: { competitorId: 'cmp_2' }, title: 'Chief revenue officer' } },
      { method: 'POST', path, body: { change: 'left', date: '2026-11-12', to: { elsewhere: { companyName: 'A consultancy' } } } },
    ]);
  });

  it('the company the person is at is never offered or preselected, also before the history has loaded', async () => {
    historyPending = 'per_gone';
    render(<Stakeholders wsId="ws_1" />);
    const c = await card('Head of sales');
    await click(c.getByRole('button', { name: 'Moved to another company' }));
    const form = within(c.getByRole('group', { name: 'position of per_gone' }));
    expect(options(form.getByLabelText('Where to'))).toEqual(['Other Rival', 'A company not listed', 'Elsewhere']);
    expect((form.getByLabelText('Where to') as HTMLSelectElement).value).toBe('cmp_2');
    type(form.getByLabelText('Date'), '2026-11-10');
    await click(form.getByRole('button', { name: 'Save' }));
    expect(posts()).toEqual([
      { method: 'POST', path: '/api/workspaces/ws_1/stakeholders/per_gone/position', body: { change: 'left', date: '2026-11-10', to: { competitorId: 'cmp_2' } } },
    ]);
  });

  it('with no other competitor in the tree, the form of someone at the only one starts at a company not listed', async () => {
    list = { ...list, places: { ...PLACES, competitors: [PLACES.competitors[0]!] } };
    historyPending = 'per_gone';
    render(<Stakeholders wsId="ws_1" />);
    const c = await card('Head of sales');
    await click(c.getByRole('button', { name: 'Moved to another company' }));
    const where = within(c.getByRole('group', { name: 'position of per_gone' })).getByLabelText('Where to') as HTMLSelectElement;
    expect(options(where)).toEqual(['A company not listed', 'Elsewhere']);
    expect(where.value).toBe(NOT_LISTED);
  });

  it('a name in use where the person goes: the 409 is shown next to the form with the server\'s message, and a new name is the way out', async () => {
    const TAKEN = "slug 'stk-other-rival-head-of-sales' already names 'Head of Sales' at that node: give this stakeholder another label";
    refuse = { status: 409, error: TAKEN };
    render(<Stakeholders wsId="ws_1" />);
    const c = await card('Head of sales');
    await c.findByText('Position: VP Sales at Rival Pay');
    await click(c.getByRole('button', { name: 'Moved to another company' }));
    const form = () => within(c.getByRole('group', { name: 'position of per_gone' }));
    type(form().getByLabelText('Date'), '2026-11-10');
    await click(form().getByRole('button', { name: 'Save' }));
    expect(form().getByText(TAKEN)).toBeTruthy();
    refuse = null;
    type(form().getByLabelText('New name'), ' Former head of sales ');
    await click(form().getByRole('button', { name: 'Save' }));
    expect(c.queryByRole('group', { name: 'position of per_gone' })).toBeNull();
    expect(c.queryByText(TAKEN)).toBeNull();
    const path = '/api/workspaces/ws_1/stakeholders/per_gone/position';
    expect(posts()).toEqual([
      { method: 'POST', path, body: { change: 'left', date: '2026-11-10', to: { competitorId: 'cmp_2' } } },
      { method: 'POST', path, body: { change: 'left', date: '2026-11-10', to: { competitorId: 'cmp_2' }, label: 'Former head of sales' } },
    ]);
  });

  it('Returned to a node where the name is in use: the 409 is shown next to the form, and a new name is the way out', async () => {
    const TAKEN = "slug 'stk-head-of-sales' already names 'Head of Sales' at that node: give this stakeholder another label";
    refuse = { status: 409, error: TAKEN };
    render(<Stakeholders wsId="ws_1" />);
    const c = await card('Head of sales');
    await click(c.getByRole('button', { name: 'Returned' }));
    const form = () => within(c.getByRole('group', { name: 'position of per_gone' }));
    expect((form().getByLabelText('New name') as HTMLInputElement).maxLength).toBe(80);
    type(form().getByLabelText('Date'), '2026-11-10');
    await click(form().getByRole('button', { name: 'Save' }));
    expect(form().getByText(TAKEN)).toBeTruthy();
    refuse = null;
    type(form().getByLabelText('New name'), 'Former head of sales');
    await click(form().getByRole('button', { name: 'Save' }));
    expect(c.queryByRole('group', { name: 'position of per_gone' })).toBeNull();
    const path = '/api/workspaces/ws_1/stakeholders/per_gone/position';
    expect(posts()).toEqual([
      { method: 'POST', path, body: { change: 'returned', date: '2026-11-10', toWorkspaceId: 'ws_1' } },
      { method: 'POST', path, body: { change: 'returned', date: '2026-11-10', toWorkspaceId: 'ws_1', label: 'Former head of sales' } },
    ]);
  });

  it('Returned posts the date and the node the person returns to', async () => {
    render(<Stakeholders wsId="ws_1" />);
    const c = await card('Head of sales');
    await click(c.getByRole('button', { name: 'Returned' }));
    const form = within(c.getByRole('group', { name: 'position of per_gone' }));
    expect(form.queryByLabelText('What changed')).toBeNull();
    expect(form.queryByLabelText('Where to')).toBeNull();
    const node = form.getByLabelText('Team or division') as HTMLSelectElement;
    expect(options(node)).toEqual(['Acme Group', 'Acme Payments']);
    expect(node.value).toBe('ws_1');
    type(form.getByLabelText('Date'), '2026-11-10');
    type(node, 'ws_2');
    type(form.getByLabelText('Title'), 'Head of sales');
    await click(form.getByRole('button', { name: 'Save' }));
    expect(posts()).toEqual([
      { method: 'POST', path: '/api/workspaces/ws_1/stakeholders/per_gone/position', body: { change: 'returned', date: '2026-11-10', toWorkspaceId: 'ws_2', title: 'Head of sales' } },
    ]);
  });
});

describe('Stakeholders page: former stakeholders', () => {
  it('lists parked former colleagues in their own group, never among the own stakeholders, with a note when research found nothing public yet', async () => {
    render(<Stakeholders wsId="ws_1" />);
    const group = within(await screen.findByRole('region', { name: 'former stakeholders' }));
    expect(group.getByText('Former stakeholders')).toBeTruthy();
    const c = within(group.getByRole('region', { name: 'stakeholder Head of legal' }));
    expect(c.getByText('Former colleague, left 2026-10-31. Was leader at Acme Group.')).toBeTruthy();
    expect(await c.findByText('Position: A law firm')).toBeTruthy();
    expect(c.getByRole('button', { name: 'Moved to another company' })).toBeTruthy();
    expect(c.getByRole('button', { name: 'Returned' })).toBeTruthy();
    expect(c.queryByRole('button', { name: 'Change position' })).toBeNull();
    expect(within(await c.findByRole('region', { name: 'what we knew about per_parked' })).getByText('Reads every clause, as we knew')).toBeTruthy();
    expect(within(c.getByRole('region', { name: 'what is public about per_parked' })).getByText('Nothing found yet.')).toBeTruthy();
    expect(c.queryByText(/What research last saw/)).toBeNull();
    expect(screen.getAllByRole('region', { name: 'stakeholder Head of legal' })).toHaveLength(1);
  });

  it('Moved to another company gives a parked former colleague a competitor: every competitor, a company not listed, or elsewhere again', async () => {
    render(<Stakeholders wsId="ws_1" />);
    const c = await card('Head of legal');
    await c.findByText('Position: A law firm');
    await click(c.getByRole('button', { name: 'Moved to another company' }));
    const form = within(c.getByRole('group', { name: 'position of per_parked' }));
    expect(form.queryByLabelText('What changed')).toBeNull();
    expect(form.getByLabelText('New name')).toBeTruthy();
    expect(options(form.getByLabelText('Where to'))).toEqual(['Rival Pay', 'Other Rival', 'A company not listed', 'Elsewhere']);
    type(form.getByLabelText('Date'), '2026-11-10');
    type(form.getByLabelText('Where to'), 'cmp_2');
    type(form.getByLabelText('Title there'), 'General counsel');
    await click(form.getByRole('button', { name: 'Save' }));
    expect(posts()).toEqual([
      { method: 'POST', path: '/api/workspaces/ws_1/stakeholders/per_parked/position', body: { change: 'left', date: '2026-11-10', to: { competitorId: 'cmp_2' }, title: 'General counsel' } },
    ]);
  });

  it('no group without parked former colleagues; a server that sends neither former nor places still shows the page', async () => {
    list = { enabled: true, own: [FIN], competitors: [] };
    render(<Stakeholders wsId="ws_1" />);
    const c = await card('Head of finance');
    expect(screen.queryByRole('region', { name: 'former stakeholders' })).toBeNull();
    expect(screen.queryByText('Former stakeholders')).toBeNull();
    await click(c.getByRole('button', { name: 'Change position' }));
    expect(options(within(c.getByRole('group', { name: 'position of per_fin' })).getByLabelText('Where to'))).toEqual(['A company not listed', 'Elsewhere']);
  });

  it('a node with only parked former colleagues is not empty', async () => {
    list = { enabled: true, own: [], competitors: [], former: [PARKED], places: PLACES };
    render(<Stakeholders wsId="ws_1" />);
    await screen.findByRole('region', { name: 'former stakeholders' });
    expect(screen.queryByText('No stakeholders yet — run research.')).toBeNull();
  });
});
