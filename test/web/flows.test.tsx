// @vitest-environment jsdom
/**
 * The Flows page (design 2026-11-14-flow-records-and-ranking-design.md §10.5, §11, §12.2): the
 * ranking with its scores and badges, the user's reactions and rulings (each with an optional
 * reason), the proposals waiting on the user, and one flow with its steps, checks and simulated
 * persona verdicts.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { decidedByPersonas, rowBadges, stopText } from '../../web/src/logic/flows.js';
import { parseRoute, WORKSPACE_PAGES } from '../../web/src/logic/router.js';
import type { FlowDetailView, FlowRankingView, FlowTypesView, RankedFlowRow } from '../../web/src/logic/types.js';
import { Flows } from '../../web/src/views/Flows.js';

type Handler = (url: URL, body: unknown) => unknown;
let routes: Record<string, Handler>;
let statusOf: Record<string, number>;
let calls: Array<{ method: string; path: string; body: unknown; contentType: string | undefined }>;

async function fakeFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const url = new URL(String(input), 'http://localhost');
  const method = (init?.method ?? 'GET').toUpperCase();
  const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : null;
  const contentType = (init?.headers as Record<string, string> | undefined)?.['content-type'];
  calls.push({ method, path: url.pathname + url.search, body, contentType });
  const key = `${method} ${url.pathname}`;
  const h = routes[key];
  const data = h ? h(url, body) : { error: 'not found' };
  return new Response(JSON.stringify(data), { status: statusOf[key] ?? (h ? 200 : 404), headers: { 'content-type': 'application/json' } });
}

beforeEach(() => {
  routes = { [`GET ${F}/checklists`]: () => defaultChecklists };
  statusOf = {};
  calls = [];
  vi.stubGlobal('fetch', vi.fn(fakeFetch));
  vi.stubGlobal('EventSource', class { addEventListener() {} removeEventListener() {} close() {} });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const F = '/api/workspaces/ws_1/flows';
const T = '2026-11-10T00:00:00Z';

function flowOf(id: string, subject: string, over: Record<string, unknown> = {}) {
  return {
    id, workspaceId: 'ws_1', rootWorkspaceId: 'ws_1', subjectEntityId: `ent_${subject}`, flowTypeId: 'fty_signup', variant: 'email', variantKey: 'email',
    isPrimary: true, name: 'Sign-up by email', goal: 'Create an account', reachedGoal: true, stepsHash: 'h', lineageId: id, version: 1, lifecycle: 'current' as const,
    status: 'verified' as const, firstSeenAt: T, confirmCount: 0, createdAt: T, ...over,
  };
}

function row(id: string, name: string, over: Partial<RankedFlowRow> & { flow?: Record<string, unknown> } = {}): RankedFlowRow {
  const { flow, ...rest } = over;
  return {
    flowId: id, position: 1, decidedBy: 'blend', subject: { id: `ent_${name}`, name }, primary: true, partial: false, reviews: { total: 0, negative: 0 }, wins: 0, comparisons: 0,
    flow: flowOf(id, name, flow) as RankedFlowRow['flow'],
    ...rest,
  };
}

const signup = { id: 'fty_signup', rootWorkspaceId: 'ws_1', key: 'sign_up', name: 'Sign-up', definition: 'Create a new account', status: 'active' as const, createdAt: T, updatedAt: T };
const invite = { id: 'fty_invite', rootWorkspaceId: 'ws_1', key: 'invite', name: 'Invite a teammate', definition: 'Bring a colleague in', status: 'proposed' as const, createdAt: T, updatedAt: T };
const checklist = {
  id: 'ckl_2', rootWorkspaceId: 'ws_1', flowTypeId: 'fty_signup', version: 2, status: 'proposed' as const, coverage: 0.6, origin: 'agent' as const, createdAt: T,
  items: [{ key: 'sso', question: 'Can you sign up with an existing account?', kind: 'yes_no' as const, pass: { answer: 'yes' as const }, weight: 1, scored: true, answeredBy: 'walkthrough' as const }],
};
const types: FlowTypesView = {
  flowTypes: [
    { ...signup, flowCount: 4, variantCount: 5 },
    { ...invite, flowCount: 0, variantCount: 0 },
  ],
  proposals: { flowTypes: [invite], checklists: [checklist] },
};

const ruling = {
  id: 'fov_1', workspaceId: 'ws_1', flowTypeId: 'fty_signup', winnerFlowId: 'flw_c', loserFlowId: 'flw_a', reason: 'their form is shorter', actor: 'me', needsConfirm: false,
  createdAt: T, winnerName: 'Competitor C', loserName: 'Competitor A',
};
function ranking(over: Partial<FlowRankingView> = {}): FlowRankingView {
  return {
    flowType: signup,
    coverage: 0.6,
    ranked: [
      row('flw_b', 'Competitor B', { position: 1, rankScore: 84.2, checklist: 88, persona: 79, wins: 9, comparisons: 10, reviews: { total: 14, negative: 3 } }),
      row('flw_y', 'Your company', {
        position: 2, rankScore: 71, checklist: 60, persona: 88, wins: 6, comparisons: 10, reviews: { total: 9, negative: 5 }, partial: true,
        flow: { reachedGoal: false, stopReason: 'payment' },
      }),
      row('flw_c', 'Competitor C', { position: 3, rankScore: 52, checklist: 52, decidedBy: 'checklist_only', sharedPosition: true, overriddenBy: ['fov_1'] }),
      row('flw_a', 'Competitor A', { position: 3, rankScore: 52, checklist: 75, persona: 20, wins: 2, comparisons: 10, sharedPosition: true, overriddenBy: ['fov_1'], reviews: { total: 22, negative: 15 } }),
    ],
    isRanked: true,
    ignoredOverrides: [],
    noPersonas: false,
    pendingProposals: { flowTypes: 1, checklists: 1 },
    overrides: [ruling],
    personas: [{ id: 'per_1', slug: 'busy-owner', segment: 'Busy owner', version: 2 }],
    ...over,
  };
}

const rankingCalls = () => calls.filter((c) => c.method === 'GET' && c.path.startsWith(`${F}/rankings/`)).length;
const rowEl = (flowId: string) => document.querySelector(`tr[data-flow="${flowId}"]`) as HTMLElement;

const defaultChecklists = {
  general: {
    id: 'ckl_gen', rootWorkspaceId: 'ws_1', version: 1, status: 'active', coverage: 0.3, origin: 'builtin', createdAt: T,
    items: [{ key: 'dead_ends', question: 'Dead ends', kind: 'count', pass: { max: 0 }, weight: 1, scored: true, answeredBy: 'walkthrough' }],
  },
};

async function renderPage(r: FlowRankingView = ranking()) {
  routes[`GET ${F}/types`] = () => types;
  routes[`GET ${F}/rankings/fty_signup`] = () => r;
  render(<Flows wsId="ws_1" />);
  await screen.findByRole('heading', { name: 'Sign-up' });
}

describe('Flows page', () => {
  it('is a workspace page after Competitors', () => {
    const pages = WORKSPACE_PAGES.map((p) => p.page);
    expect(pages.indexOf('flows')).toBe(pages.indexOf('competitors') + 1);
    expect(parseRoute('#/w/ws_1/flows')).toEqual({ name: 'workspace', wsId: 'ws_1', page: 'flows' });
  });

  it('renders the ranking with scores, wins, review counts and badges', async () => {
    await renderPage();
    const b = within(rowEl('flw_b'));
    expect(b.getByText('1')).toBeTruthy();
    expect(b.getByText('84')).toBeTruthy();
    expect(b.getByText('88')).toBeTruthy();
    expect(b.getByText('wins 9/10')).toBeTruthy();
    expect(b.getByText('14 (3 neg)')).toBeTruthy();
    expect(b.queryByText('partial')).toBeNull();

    const y = within(rowEl('flw_y'));
    expect(y.getByText('partial')).toBeTruthy();
    expect(y.getByText('stopped at: payment')).toBeTruthy();
    expect(y.getByText('9 (5 neg)')).toBeTruthy();

    const c = within(rowEl('flw_c'));
    expect(c.getByText('no comparison')).toBeTruthy();
    expect(c.getByText('overridden')).toBeTruthy();
    expect(c.getByText('shared position')).toBeTruthy();
    expect(c.getByText('Your reason: their form is shorter')).toBeTruthy();
    expect(c.getByText('—')).toBeTruthy(); // no wins to show

    expect(within(rowEl('flw_a')).getByText('22 (15 neg)')).toBeTruthy();
    expect(screen.getByText(/Rank score = 60% checklist \+ 40% personas/)).toBeTruthy();
    expect(screen.getByText('Waiting on you: 1 new flow type, 1 checklist to accept.')).toBeTruthy();
    expect(screen.getByText('4 flows')).toBeTruthy(); // flow count in the type list
    expect(screen.getByText('Personas (simulated)')).toBeTruthy();
    // the ruling is listed with plain names
    const rulings = document.querySelector('[data-override="fov_1"]') as HTMLElement;
    expect(rulings.textContent).toMatch(/Competitor C is better than Competitor A/);
  });

  it('a persona-decided position is labelled', async () => {
    await renderPage(
      ranking({
        ranked: [
          ...ranking().ranked,
          row('flw_p', 'Competitor P', { position: 5, rankScore: 40, persona: 40, decidedBy: 'persona_only', wins: 4, comparisons: 10 }),
        ],
      }),
    );
    // above Competitor A (checklist 75) with a checklist score of 60: the personas decided it
    expect(within(rowEl('flw_y')).getByText('decided by personas')).toBeTruthy();
    // ranked on the personas alone
    expect(within(rowEl('flw_p')).getByText('decided by personas')).toBeTruthy();
    // top on both: not decided by personas; a ruled pair is the user's decision
    expect(within(rowEl('flw_b')).queryByText('decided by personas')).toBeNull();
    expect(within(rowEl('flw_c')).queryByText('decided by personas')).toBeNull();

    const rows = ranking().ranked;
    expect(decidedByPersonas(rows[1]!, rows)).toBe(true);
    expect(decidedByPersonas(rows[0]!, rows)).toBe(false);
    expect(rowBadges(rows[1]!, rows, false)).toEqual(['partial', 'decided by personas']);
    expect(stopText({ reachedGoal: false, stopReason: 'kyc' })).toBe('stopped at: identity check');
    expect(stopText({ reachedGoal: false, stopReason: 'approval_needed' })).toBe('stopped at: approval needed');
  });

  it('disagree with a reason posts the reaction', async () => {
    routes[`POST ${F}/flw_b/reaction`] = () => ({ id: 'fbk_1' });
    await renderPage();
    fireEvent.click(within(rowEl('flw_b')).getByRole('button', { name: 'agree / disagree' }));
    const panel = document.querySelector('[data-panel="react"]') as HTMLElement;
    fireEvent.change(within(panel).getByLabelText('reason'), { target: { value: '  their sign-up needs a phone number  ' } });
    await act(async () => {
      fireEvent.click(within(panel).getByRole('button', { name: 'Disagree' }));
    });
    expect(await screen.findByText('Recorded: you disagree with this position.')).toBeTruthy();
    // agreement is sent the same way, here without a reason
    await act(async () => {
      fireEvent.click(within(panel).getByRole('button', { name: 'Agree' }));
    });
    const posts = calls.filter((c) => c.method === 'POST');
    expect(posts.map((p) => [p.path, p.body])).toEqual([
      [`${F}/flw_b/reaction`, { flowTypeId: 'fty_signup', reaction: 'disagree', reason: 'their sign-up needs a phone number' }],
      [`${F}/flw_b/reaction`, { flowTypeId: 'fty_signup', reaction: 'agree' }],
    ]);
  });

  it('override posts winner, loser and reason and reloads', async () => {
    routes[`POST ${F}/overrides`] = () => ({ ...ruling, id: 'fov_2', winnerFlowId: 'flw_y', loserFlowId: 'flw_b' });
    await renderPage();
    const before = rankingCalls();
    fireEvent.click(within(rowEl('flw_y')).getByRole('button', { name: 'override' }));
    const panel = document.querySelector('[data-panel="override"]') as HTMLElement;
    expect(panel.textContent).toMatch(/Your company is better than/);
    fireEvent.change(within(panel).getByLabelText('better than'), { target: { value: 'flw_b' } });
    fireEvent.change(within(panel).getByLabelText('reason'), { target: { value: 'we ask for less' } });
    await act(async () => {
      fireEvent.click(within(panel).getByRole('button', { name: 'Save ruling' }));
    });
    expect(calls.find((c) => c.method === 'POST')).toMatchObject({
      path: `${F}/overrides`,
      body: { flowTypeId: 'fty_signup', winnerFlowId: 'flw_y', loserFlowId: 'flw_b', reason: 'we ask for less' },
    });
    await waitFor(() => expect(rankingCalls()).toBe(before + 1));
    expect(screen.getByText('Your ruling is saved; the ranking follows it.')).toBeTruthy();
  });

  it('a ruling shows both flow names without another request', async () => {
    // the stale ruling names an earlier version that is not in the ranking: the served names are shown as they are
    const stale = { ...ruling, id: 'fov_9', winnerFlowId: 'flw_y', loserFlowId: 'flw_old', winnerName: 'Your company — email', loserName: 'Competitor B — email', needsConfirm: true };
    await renderPage(ranking({ overrides: [ruling, stale] }));
    const item = document.querySelector('[data-override="fov_9"]') as HTMLElement;
    expect(item.textContent).toMatch(/Your company — email is better than Competitor B — email/);
    expect((document.querySelector('[data-override="fov_1"]') as HTMLElement).textContent).toMatch(/Competitor C is better than Competitor A/);
    expect(calls.filter((c) => c.method === 'GET').map((c) => c.path).sort()).toEqual([
      `${F}/checklists?flowTypeId=fty_signup`, `${F}/rankings/fty_signup`, `${F}/types`,
    ]);
  });

  it('a ruling whose flow was walked again asks whether it still holds; removing one sends a JSON DELETE', async () => {
    routes[`POST ${F}/overrides/fov_9/confirm`] = () => ({});
    routes[`DELETE ${F}/overrides/fov_1`] = () => ({});
    const stale = { ...ruling, id: 'fov_9', winnerFlowId: 'flw_y', loserFlowId: 'flw_old', reason: undefined, needsConfirm: true };
    await renderPage(ranking({ overrides: [ruling, stale] }));
    const item = document.querySelector('[data-override="fov_9"]') as HTMLElement;
    expect(within(item).getByText(/Still holds\?/)).toBeTruthy();
    fireEvent.change(within(item).getByLabelText('reason'), { target: { value: 'still true' } });
    await act(async () => {
      fireEvent.click(within(item).getByRole('button', { name: 'Keep' }));
    });
    const kept = document.querySelector('[data-override="fov_1"]') as HTMLElement;
    await act(async () => {
      fireEvent.click(within(kept).getByRole('button', { name: 'Remove ruling' }));
    });
    const writes = calls.filter((c) => c.method !== 'GET');
    expect(writes.map((w) => [w.method, w.path, w.body, w.contentType])).toEqual([
      ['POST', `${F}/overrides/fov_9/confirm`, { keep: true, reason: 'still true' }, 'application/json'],
      ['DELETE', `${F}/overrides/fov_1`, {}, 'application/json'],
    ]);
  });

  it('proposals waiting on the user can be accepted', async () => {
    routes[`POST ${F}/types/fty_invite/decision`] = () => ({ ...invite, status: 'active' });
    routes[`POST ${F}/checklists/ckl_2/decision`] = () => ({ checklist: { ...checklist, status: 'active' }, needRewalk: ['flw_a', 'flw_b'] });
    await renderPage();
    expect(screen.getByRole('heading', { name: 'Waiting on you (2)' })).toBeTruthy();
    const before = rankingCalls();

    const type = document.querySelector('[data-proposal="fty_invite"]') as HTMLElement;
    fireEvent.change(within(type).getByLabelText('reason'), { target: { value: 'we do this a lot' } });
    await act(async () => {
      fireEvent.click(within(type).getByRole('button', { name: 'Accept' }));
    });
    expect(await screen.findByText('Flow type accepted.')).toBeTruthy();

    const list = document.querySelector('[data-proposal="ckl_2"]') as HTMLElement;
    fireEvent.change(within(list).getByLabelText('coverage'), { target: { value: '70' } });
    await act(async () => {
      fireEvent.click(within(list).getByRole('button', { name: 'Accept' }));
    });
    expect(await screen.findByText('Checklist accepted. 2 flows need a re-walk to answer its new checks.')).toBeTruthy();

    const posts = calls.filter((c) => c.method === 'POST');
    expect(posts.map((p) => [p.path, p.body])).toEqual([
      [`${F}/types/fty_invite/decision`, { action: 'accept', reason: 'we do this a lot' }],
      [`${F}/checklists/ckl_2/decision`, { action: 'accept', coverage: 0.7 }],
    ]);
    await waitFor(() => expect(rankingCalls()).toBeGreaterThanOrEqual(before + 2));
  });

  it("rejecting a flow type that has flows shows the server's message as is", async () => {
    const message = 'flow type invite has flows: merge it into another type instead';
    routes[`POST ${F}/types/fty_invite/decision`] = () => ({ error: message });
    statusOf[`POST ${F}/types/fty_invite/decision`] = 409;
    await renderPage();
    const type = document.querySelector('[data-proposal="fty_invite"]') as HTMLElement;
    await act(async () => {
      fireEvent.click(within(type).getByRole('button', { name: 'Reject' }));
    });
    expect(await screen.findByText(message)).toBeTruthy();
    // merge into an active type
    fireEvent.change(within(type).getByLabelText('merge into'), { target: { value: 'fty_signup' } });
    routes[`POST ${F}/types/fty_invite/decision`] = () => ({ ...invite, status: 'merged' });
    statusOf = {};
    await act(async () => {
      fireEvent.click(within(type).getByRole('button', { name: 'Merge' }));
    });
    expect(calls.filter((c) => c.method === 'POST').at(-1)?.body).toEqual({ action: 'merge', intoId: 'fty_signup' });
  });

  it('the flow detail shows steps in order, checks with answers and verdicts labelled simulated', async () => {
    routes[`GET ${F}/flw_b`] = () => detail();
    routes[`POST ${F}/verdicts/fvd_1/reaction`] = () => ({ id: 'fbk_2' });
    await renderPage();
    fireEvent.click(within(rowEl('flw_b')).getByRole('button', { name: 'open' }));
    expect(await screen.findByRole('heading', { name: 'Competitor B — Sign-up by email' })).toBeTruthy();
    expect(screen.getByText('main way: email')).toBeTruthy(); // served `primary`, not the stored flag (F2)

    const steps = within(screen.getByRole('list', { name: 'steps' })).getAllByRole('listitem');
    expect(steps.map((s) => s.querySelector('dd')?.textContent)).toEqual(['Opened the sign-up page', 'Typed an email', 'Clicked Create account']);
    expect(within(steps[0]!).getByAltText('screenshot of step 1').getAttribute('src')).toBe('/api/artifacts/art_1');
    expect(within(steps[1]!).getByText('email, password')).toBeTruthy();

    const check = document.querySelector('tr[data-check="few_steps"]') as HTMLElement;
    expect(within(check).getByText('Can the goal be reached in five steps or fewer?')).toBeTruthy();
    expect(within(check).getByText('yes, passes')).toBeTruthy();
    expect(within(check).getByRole('button', { name: 'step 2' })).toBeTruthy();
    expect(within(check).getByText('1 review')).toBeTruthy();

    const verdicts = [...document.querySelectorAll('[data-verdict]')] as HTMLElement[];
    expect(verdicts).toHaveLength(2);
    for (const v of verdicts) expect(within(v).getByText('simulated')).toBeTruthy();
    expect(verdicts[0]!.textContent).toMatch(/Busy owner \(v2\) clearly prefers this flow over Competitor A/);
    expect(verdicts[0]!.textContent).toMatch(/broad: judged among all flows at once/);
    // the verdict on a flow outside the ranking is apart, collapsed, and says it is not part of the score
    const apart = screen.getByText(/1 verdict not part of the score/).closest('details') as HTMLDetailsElement;
    expect(apart.open).toBe(false);
    expect(apart.contains(verdicts[1]!)).toBe(true);
    expect(screen.getByText('Sign-up took forever')).toBeTruthy();
    expect(screen.getByText(/app store .* counted in the review numbers/)).toBeTruthy();

    fireEvent.change(within(verdicts[0]!).getByLabelText('reason'), { target: { value: 'fewer fields is not the point' } });
    await act(async () => {
      fireEvent.click(within(verdicts[0]!).getByRole('button', { name: 'Disagree' }));
    });
    expect(calls.find((c) => c.method === 'POST')).toMatchObject({
      path: `${F}/verdicts/fvd_1/reaction`,
      body: { reaction: 'disagree', reason: 'fewer fields is not the point' },
    });
    expect(await screen.findByText(/you disagree with this simulated verdict/)).toBeTruthy();
  });

  it('a review can be marked as not about this flow, with a reason', async () => {
    let detailCalls = 0;
    routes[`GET ${F}/flw_b`] = () => {
      detailCalls += 1;
      return detail();
    };
    routes[`POST ${F}/mentions/rvm_1/attribution`] = () => ({});
    await renderPage();
    fireEvent.click(within(rowEl('flw_b')).getByRole('button', { name: 'open' }));
    await screen.findByRole('heading', { name: 'Competitor B — Sign-up by email' });
    const box = within(document.querySelector('[data-attribution="rvm_1"]') as HTMLElement);

    // (a) not about this flow: no flow type sent
    fireEvent.click(box.getByLabelText('not about this flow'));
    fireEvent.change(box.getByLabelText('reason'), { target: { value: 'this is about their login page' } });
    await act(async () => {
      fireEvent.click(box.getByRole('button', { name: 'Save' }));
    });
    expect(await screen.findByText('Saved: the review is filed where you said.')).toBeTruthy();
    await waitFor(() => expect(detailCalls).toBe(2));

    // (b) a different check of this flow: the flow's own type key plus the check key
    fireEvent.click(box.getByLabelText('about a different check'));
    fireEvent.change(box.getByLabelText('which check'), { target: { value: 'few_steps' } });
    await act(async () => {
      fireEvent.click(box.getByRole('button', { name: 'Save' }));
    });
    // (c) a different flow type
    fireEvent.click(box.getByLabelText('about a different flow type'));
    fireEvent.change(box.getByLabelText('which flow type'), { target: { value: 'invite' } });
    await act(async () => {
      fireEvent.click(box.getByRole('button', { name: 'Save' }));
    });
    const posts = calls.filter((c) => c.method === 'POST');
    expect(posts.map((p) => [p.path, p.body])).toEqual([
      [`${F}/mentions/rvm_1/attribution`, { reason: 'this is about their login page' }],
      [`${F}/mentions/rvm_1/attribution`, { flowTypeKey: 'sign_up', checkKey: 'few_steps' }],
      [`${F}/mentions/rvm_1/attribution`, { flowTypeKey: 'invite' }],
    ]);
  });

  it('a non-web source address renders as text with no link; an https one is a link', async () => {
    const d = detail();
    const evil = 'javascript:alert(document.cookie)';
    routes[`GET ${F}/flw_b`] = () => ({
      ...d,
      flow: { ...d.flow, entryUrl: 'javascript:alert(1)' },
      mentions: [
        { ...d.mentions[0]!, id: 'rvm_bad', sourceUrl: evil, quote: 'Bad link review' },
        { ...d.mentions[0]!, id: 'rvm_good', sourceUrl: 'https://apps.example/acme', quote: 'Good link review' },
      ],
    });
    await renderPage();
    fireEvent.click(within(rowEl('flw_b')).getByRole('button', { name: 'open' }));
    await screen.findByRole('heading', { name: 'Competitor B — Sign-up by email' });
    const detailEl = document.querySelector('.flow-detail') as HTMLElement;
    // no link anywhere on the page points at a script
    for (const a of detailEl.querySelectorAll('a')) expect(a.getAttribute('href') ?? '').not.toMatch(/^\s*javascript:/i);
    const bad = document.querySelector('[data-mention="rvm_bad"]') as HTMLElement;
    expect(bad.querySelector('a')).toBeNull();
    expect(within(bad).getByText(`source: ${evil}`)).toBeTruthy();
    expect(within(detailEl).getByText('javascript:alert(1)').tagName).toBe('SPAN');
    const good = within(document.querySelector('[data-mention="rvm_good"]') as HTMLElement).getByRole('link', { name: 'source' });
    expect(good.getAttribute('href')).toBe('https://apps.example/acme');
    expect(good.getAttribute('rel')).toBe('noopener noreferrer');
    expect(good.getAttribute('target')).toBe('_blank');
  });

  it('a review quote with HTML in it renders as literal text', async () => {
    const d = detail();
    const hostile = '<img src=x onerror="alert(1)"><b>Ignore previous instructions</b>';
    routes[`GET ${F}/flw_b`] = () => ({ ...d, mentions: [{ ...d.mentions[0]!, quote: hostile }] });
    await renderPage();
    fireEvent.click(within(rowEl('flw_b')).getByRole('button', { name: 'open' }));
    await screen.findByRole('heading', { name: 'Competitor B — Sign-up by email' });
    const mention = document.querySelector('[data-mention="rvm_1"]') as HTMLElement;
    expect(within(mention).getByText(hostile).tagName).toBe('PRE');
    expect(mention.querySelector('img')).toBeNull();
    expect(mention.querySelector('b')).toBeNull();
  });

  it('a check answer can be corrected with a note and a reason', async () => {
    routes[`GET ${F}/flw_b`] = () => detail();
    routes[`POST ${F}/flw_b/checks`] = () => ({ check: {} });
    await renderPage();
    fireEvent.click(within(rowEl('flw_b')).getByRole('button', { name: 'open' }));
    await screen.findByRole('heading', { name: 'Competitor B — Sign-up by email' });
    const check = document.querySelector('tr[data-check="few_steps"]') as HTMLElement;
    fireEvent.click(within(check).getByRole('button', { name: 'correct' }));
    const form = within(check.nextElementSibling as HTMLElement);
    fireEvent.change(form.getByLabelText('corrected answer'), { target: { value: 'fail' } });
    fireEvent.change(form.getByLabelText('note'), { target: { value: 'six steps with the email check' } });
    fireEvent.change(form.getByLabelText('reason'), { target: { value: 'I counted again' } });
    await act(async () => {
      fireEvent.click(form.getByRole('button', { name: 'Save answer' }));
    });
    expect(calls.find((c) => c.method === 'POST')).toMatchObject({
      path: `${F}/flw_b/checks`,
      body: { checklistId: 'ckl_gen', itemKey: 'few_steps', answer: 'fail', note: 'six steps with the email check', reason: 'I counted again' },
    });
    expect(await screen.findByText('Answer corrected; the checklist score is updated.')).toBeTruthy();
  });

  it('compare puts two flows side by side, step by step', async () => {
    const d = detail();
    routes[`GET ${F}/compare`] = () => ({
      flowType: signup,
      a: { flow: d.flow, subject: d.subject, primary: true, partial: false, steps: d.steps },
      b: {
        flow: flowOf('flw_y', 'Your company', { reachedGoal: false, stopReason: 'phone' }),
        subject: { id: 'ent_y', name: 'Your company' },
        primary: true,
        partial: true,
        steps: [{ flowId: 'flw_y', seq: 1, action: 'Opened our sign-up page', observation: 'It asked for a phone number', asked: ['phone'] }],
      },
      verdicts: [{ ...d.verdicts[0]!, flowAId: 'flw_b', flowBId: 'flw_y', winner: 'a' }],
      overrides: [],
    });
    await renderPage();
    fireEvent.click(within(rowEl('flw_b')).getByRole('button', { name: 'compare' }));
    const panel = document.querySelector('[data-panel="compare"]') as HTMLElement;
    fireEvent.change(within(panel).getByLabelText('compare with'), { target: { value: 'flw_y' } });
    fireEvent.click(within(panel).getByRole('button', { name: 'Compare' }));
    expect(await screen.findByText('Opened our sign-up page')).toBeTruthy();
    expect(calls.some((c) => c.path === `${F}/compare?a=flw_b&b=flw_y`)).toBe(true);
    const rows = document.querySelectorAll('.flow-compare tbody tr');
    expect(rows).toHaveLength(3);
    expect(rows[0]!.textContent).toMatch(/Opened the sign-up page.*Opened our sign-up page/);
    expect(rows[1]!.textContent).toMatch(/no step 2/);
    expect(screen.getByText('stopped at: phone')).toBeTruthy();
    expect(document.querySelector('.flow-compare .card.simulated')!.textContent).toMatch(/simulated.*clearly prefers Competitor B/);
  });

  it('with no personas the table says so', async () => {
    await renderPage(
      ranking({
        noPersonas: true,
        personas: [],
        ranked: [row('flw_b', 'Competitor B', { checklist: 88, rankScore: 88, decidedBy: 'checklist_only' }), row('flw_a', 'Competitor A', { position: 2, checklist: 50, rankScore: 50, decidedBy: 'checklist_only' })],
        overrides: [],
      }),
    );
    expect(screen.getByText(/No persona judgment/)).toBeTruthy();
    expect(screen.getByText(/Rank score = the checklist score alone/)).toBeTruthy();
    expect(screen.queryByLabelText('persona filter')).toBeNull();
    expect(within(rowEl('flw_b')).queryByText('no comparison')).toBeNull();
  });

  it('an ignored ruling says why: it contradicts a newer one, or one of its flows is not in this list (M1)', async () => {
    await renderPage(
      ranking({
        ignoredOverrides: [
          { id: 'fov_old', reason: 'conflict' },
          { id: 'fov_g1', reason: 'not_ranked' },
          { id: 'fov_g2', reason: 'not_ranked' },
        ],
      }),
    );
    expect(screen.getByText('1 of your rulings was not kept: it contradicts a newer one.')).toBeTruthy();
    expect(
      screen.getByText('2 of your rulings are not used in this list: one of their flows is not in it (another way through, or a flow no longer used).'),
    ).toBeTruthy();
    expect(screen.queryByText(/were not kept: they contradict/)).toBeNull();
  });

  it('a proposed flow type is not the default, and its flows show as not ranked, without reactions or rulings (M2)', async () => {
    routes[`GET ${F}/types`] = () => ({
      ...types,
      flowTypes: [
        { ...invite, flowCount: 2, variantCount: 2 },
        { ...signup, flowCount: 0, variantCount: 0 },
      ],
    });
    routes[`GET ${F}/rankings/fty_signup`] = () => ranking({ ranked: [], overrides: [] });
    routes[`GET ${F}/rankings/fty_invite`] = () =>
      ranking({
        flowType: invite,
        isRanked: false,
        overrides: [],
        ranked: [
          row('flw_i1', 'Competitor B', { position: 0, checklist: 70, decidedBy: 'none' }),
          row('flw_i2', 'Competitor A', { position: 0, decidedBy: 'none' }),
        ],
      });
    render(<Flows wsId="ws_1" />);
    // The active type is chosen by default, though the proposed one comes first and has flows.
    expect(await screen.findByRole('heading', { name: 'Sign-up' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Invite a teammate' }));
    expect(await screen.findByText('Not ranked until you accept this flow type.')).toBeTruthy();
    const r = within(rowEl('flw_i1'));
    expect(r.getByText('70')).toBeTruthy();
    expect(r.getByRole('button', { name: 'open' })).toBeTruthy();
    expect(r.queryByRole('button', { name: 'agree / disagree' })).toBeNull();
    expect(r.queryByRole('button', { name: 'override' })).toBeNull();
    expect(r.queryByText('no comparison')).toBeNull();
    expect(screen.queryByText(/Rank score =/)).toBeNull();
  });

  it('the persona filter ranks on one persona', async () => {
    await renderPage();
    fireEvent.change(screen.getByLabelText('persona filter'), { target: { value: 'per_1' } });
    await waitFor(() => expect(calls.some((c) => c.path === `${F}/rankings/fty_signup?persona=per_1`)).toBe(true));
    expect(await screen.findByText(/Ranked on one persona's simulated verdicts only/)).toBeTruthy();
  });

  it('the Checklist panel shows both checklists, edits weights, questions, removals and coverage, with a reason, and says how many flows need a re-walk (F4)', async () => {
    const item = (key: string, question: string, scored: boolean, weight = 1) => ({
      key, question, kind: 'yes_no' as const, pass: { answer: 'yes' as const }, weight, scored, answeredBy: 'walkthrough' as const,
    });
    const general = {
      id: 'ckl_gen', rootWorkspaceId: 'ws_1', version: 1, status: 'active' as const, coverage: 0.3, origin: 'builtin' as const, createdAt: T,
      items: [item('dead_ends', 'Dead ends (a screen with no way forward)', true), item('notable_copy', 'What the page says about privacy', false)],
    };
    const specific = {
      id: 'ckl_su', rootWorkspaceId: 'ws_1', flowTypeId: 'fty_signup', version: 1, status: 'active' as const, coverage: 0.6, origin: 'builtin' as const, createdAt: T,
      items: [item('sso', 'Can you sign up with an existing account?', true), item('few_fields', 'Few fields to fill', true, 2)],
    };
    let checklistCalls = 0;
    routes[`GET ${F}/checklists`] = () => {
      checklistCalls += 1;
      return { general, specific };
    };
    routes[`POST ${F}/checklists/ckl_su/edit`] = () => ({ checklist: { ...specific, id: 'ckl_su2', version: 2, origin: 'user' }, needRewalk: ['flw_a', 'flw_b'] });
    await renderPage();
    const panel = (await screen.findByRole('heading', { name: 'Checklist' })).closest('section') as HTMLElement;
    expect(calls.some((c) => c.path === `${F}/checklists?flowTypeId=fty_signup`)).toBe(true);
    const su = within(panel.querySelector('[data-checklist="ckl_su"]') as HTMLElement);
    expect(su.getByText('Checks for Sign-up')).toBeTruthy();
    expect(su.getByText(/These checks settle about 60% of judging Sign-up/)).toBeTruthy();
    const ssoRow = within(su.getByText('Can you sign up with an existing account?').closest('tr') as HTMLElement);
    expect(ssoRow.getByText('counts in the score')).toBeTruthy();
    expect(within(su.getByText('Few fields to fill').closest('tr') as HTMLElement).getByText('2')).toBeTruthy();
    const gen = within(panel.querySelector('[data-checklist="ckl_gen"]') as HTMLElement);
    expect(gen.getByText('Checks for every flow')).toBeTruthy();
    expect(within(gen.getByText('What the page says about privacy').closest('tr') as HTMLElement).getByText(/not scored/)).toBeTruthy();

    fireEvent.click(su.getByRole('button', { name: 'Edit' }));
    fireEvent.change(su.getByLabelText('weight of sso'), { target: { value: '3' } });
    fireEvent.change(su.getByLabelText('question of few_fields'), { target: { value: 'Only the fields the next step needs' } });
    fireEvent.click(su.getByLabelText('remove few_fields'));
    fireEvent.click(su.getByLabelText('remove few_fields')); // changed my mind: kept
    fireEvent.change(su.getByLabelText('checklist coverage'), { target: { value: '70' } });
    fireEvent.change(su.getByLabelText('reason'), { target: { value: 'single sign-on matters most to our buyers' } });
    const before = rankingCalls();
    await act(async () => {
      fireEvent.click(su.getByRole('button', { name: 'Save checklist' }));
    });
    expect(calls.find((c) => c.method === 'POST')).toMatchObject({
      path: `${F}/checklists/ckl_su/edit`,
      body: {
        coverage: 0.7,
        items: [{ key: 'sso', weight: 3 }, { key: 'few_fields', question: 'Only the fields the next step needs' }],
        reason: 'single sign-on matters most to our buyers',
      },
    });
    expect(await screen.findByText('Checklist saved. 2 flows need a re-walk to answer all its checks.')).toBeTruthy();
    await waitFor(() => expect(rankingCalls()).toBe(before + 1));
    expect(checklistCalls).toBe(2);
  });

  it('the Checklist editor saves nothing when nothing changed, and keeps at least one check', async () => {
    const one = { key: 'dead_ends', question: 'Dead ends', kind: 'count' as const, pass: { max: 0 }, weight: 1, scored: true, answeredBy: 'walkthrough' as const };
    routes[`GET ${F}/checklists`] = () => ({
      general: { id: 'ckl_gen', rootWorkspaceId: 'ws_1', version: 4, status: 'active', coverage: 0.3, origin: 'user', createdAt: T, items: [one] },
    });
    await renderPage();
    const gen = within((await screen.findByText('Checks for every flow')).closest('[data-checklist]') as HTMLElement);
    expect(gen.getByText(/version 4, edited by you/)).toBeTruthy();
    expect(gen.getByText(/For a flow type with no checks of its own, these checks settle about 30% of judging it/)).toBeTruthy();
    fireEvent.click(gen.getByRole('button', { name: 'Edit' }));
    const save = gen.getByRole('button', { name: 'Save checklist' }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.click(gen.getByLabelText('remove dead_ends'));
    expect(save.disabled).toBe(true);
    expect(gen.getByText('Keep at least one check.')).toBeTruthy();
    fireEvent.click(gen.getByRole('button', { name: 'Cancel' }));
    expect(gen.queryByRole('button', { name: 'Save checklist' })).toBeNull();
    expect(calls.filter((c) => c.method === 'POST')).toEqual([]);
  });

  it('the views never call fetch themselves', () => {
    for (const f of ['Flows.tsx', 'FlowDetail.tsx', 'flows/parts.tsx', 'flows/FlowProposals.tsx', 'flows/RowPanel.tsx', 'flows/FlowCompare.tsx', 'flows/ChecklistPanel.tsx']) {
      const src = readFileSync(join(process.cwd(), 'web/src/views', f), 'utf8');
      expect(src).not.toMatch(/\bfetch\(|from '\.\.\/logic\/api|from '\.\.\/\.\.\/logic\/api/);
    }
  });
});

function detail(): FlowDetailView {
  // The stored flag is off; the served `primary` (the rankings' rule) is what the page shows.
  const base = flowOf('flw_b', 'Competitor B', { isPrimary: false }) as FlowDetailView['flow'];
  const persona = { id: 'per_1', slug: 'busy-owner', segment: 'Busy owner', version: 2 };
  const verdict = {
    workspaceId: 'ws_1', flowTypeId: 'fty_signup', personaId: 'per_1', personaVersion: 2, strength: 2 as const, confidence: 0.8, createdAt: T,
    simulated: true as const, persona,
  };
  return {
    flow: base,
    subject: { id: 'ent_b', name: 'Competitor B' },
    primary: true,
    partial: false,
    upload: false,
    current: true,
    steps: [
      { flowId: 'flw_b', seq: 2, action: 'Typed an email', observation: 'It asked for a password', asked: ['email', 'password'] },
      { flowId: 'flw_b', seq: 1, action: 'Opened the sign-up page', observation: 'A form with two fields', asked: [], artifactId: 'art_1' },
      { flowId: 'flw_b', seq: 3, action: 'Clicked Create account', observation: 'A welcome screen', asked: [] },
    ],
    checks: [
      {
        flowId: 'flw_b', checklistId: 'ckl_gen', itemKey: 'few_steps', answer: 'pass', stepRefs: [2], mentionRefs: ['rvm_1'], origin: 'walkthrough', updatedAt: T,
        question: 'Can the goal be reached in five steps or fewer?', scored: true,
      },
    ],
    verdicts: [
      {
        ...verdict, id: 'fvd_1', flowAId: 'flw_a', flowBId: 'flw_b', stage: 'broad', winner: 'b', reason: 'Fewer fields to fill.', opponentId: 'flw_a',
        opponent: { id: 'flw_a', name: 'Sign-up by email', variant: 'email', subject: { id: 'ent_a', name: 'Competitor A' } }, counted: true,
      },
      {
        ...verdict, id: 'fvd_2', flowAId: 'flw_b', flowBId: 'flw_z', stage: 'focused', winner: 'tie', reason: 'Much the same.', opponentId: 'flw_z',
        opponent: { id: 'flw_z', name: 'Sign-up by phone', variant: 'phone', subject: { id: 'ent_z', name: 'Competitor Z' } }, counted: false,
      },
    ],
    mentions: [
      {
        id: 'rvm_1', workspaceId: 'ws_1', rootWorkspaceId: 'ws_1', subjectEntityId: 'ent_b', sourceType: 'app_store', artifactId: 'art_9', quote: 'Sign-up took forever',
        quoteHash: 'q', polarity: 'negative', attributionConfidence: 0.9, createdAt: T, counted: true,
      },
    ],
    overrides: [],
    checklist: 88,
    persona: 79,
    coverage: 0.6,
  };
}
