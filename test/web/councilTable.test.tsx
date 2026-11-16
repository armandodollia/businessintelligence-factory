// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { reviewDecisionLabel } from '../../web/src/logic/council.js';
import { CouncilTable } from '../../web/src/views/CouncilTable.js';
import { LastReviewNote } from '../../web/src/views/LastReviewNote.js';
import { Settings } from '../../web/src/views/Settings.js';

type Reply = { status?: number; body: unknown };
let routes: Record<string, () => Reply>;
let calls: Array<{ method: string; path: string; search: string }>;

beforeEach(() => {
  routes = {};
  calls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input), 'http://localhost');
      const method = (init?.method ?? 'GET').toUpperCase();
      calls.push({ method, path: url.pathname, search: url.search });
      const r = routes[`${method} ${url.pathname}`]?.() ?? { status: 404, body: { error: 'not found' } };
      return new Response(JSON.stringify(r.body), { status: r.status ?? 200, headers: { 'content-type': 'application/json' } });
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const REVENUE = 'The revenue figure in the finding does not match the cited filing';
const STALE = 'The pricing claim rests on a page captured two years ago';

const member = (name: string, lens: string, extra: Record<string, unknown> = {}) => ({
  name, provider: 'claude', model: 'opus', lens, blocking: true, state: 'reviewed', ...extra,
});

/** Two rounds: in round 1 one member has no score and one is unavailable; in round 2 the non-blocking one is not waited for. */
const VIEW = {
  stage: { rounds: 3, passScore: 9, blockOn: 'any', onUnavailable: 'report' },
  rounds: [
    {
      round: 1, decisionId: 'dec_1', at: '2026-11-16T10:00:00.000Z',
      result: {
        pass: false, score: 7,
        issues: [{ id: 'I1', class: 'blocking', description: 'An issue of the first round that was fixed', raisedBy: ['evidence'], standing: 'upheld' }],
        dropped: [], questions: [{ text: 'A question of the first round', raisedBy: ['evidence'] }],
        followUps: [{ text: 'Check the pricing page of the second product', raisedBy: ['reasoning'] }],
        members: [
          member('evidence', 'evidence', { score: 7, countedScore: 7 }),
          member('reasoning', 'reasoning', { provider: 'codex', model: 'gpt-6.1-sol', state: 'no_score', reason: 'the run ended without a review' }),
          member('private', 'privacy', { provider: 'opencode', model: 'big-pickle', state: 'unavailable', reason: "provider 'opencode' is not enabled" }),
          member('redo', 'rewrite', { blocking: false, score: 8 }),
        ],
      },
    },
    {
      round: 2, decisionId: 'dec_2', at: '2026-11-16T11:00:00.000Z',
      result: {
        pass: false, score: 8,
        issues: [
          { id: 'I2', class: 'substantive', description: REVENUE, where: ['fnd_x'], raisedBy: ['evidence', 'reasoning'], standing: 'upheld' },
          { id: 'I3', class: 'substantive', description: STALE, raisedBy: ['reasoning'], standing: 'advisory' },
        ],
        dropped: [{ issue: { id: 'I4', class: 'nit', description: 'The title is long' }, raisedBy: ['reasoning'], rule: 'nit' }],
        questions: [{ text: 'Is the filing the latest one?', raisedBy: ['evidence'] }],
        followUps: [{ text: 'Compare the churn of the two plans', raisedBy: ['evidence', 'reasoning'] }],
        members: [
          member('evidence', 'evidence', { score: 8, countedScore: 8 }),
          member('reasoning', 'reasoning', { provider: 'codex', model: 'gpt-6.1-sol', score: 6, countedScore: 9, unsupportedScore: true }),
          member('private', 'privacy', { provider: 'opencode', model: 'big-pickle', state: 'unavailable', reason: "provider 'opencode' is not enabled" }),
          member('redo', 'rewrite', { blocking: false, state: 'not_waited', reason: 'cancelled' }),
        ],
      },
    },
  ],
};

const rowOf = (name: string) => screen.getByRole('rowheader', { name: new RegExp(`^${name}\\b`) }).closest('tr')!;
const cellsOf = (name: string) => within(rowOf(name)).getAllByRole('cell').map((c) => c.textContent);

describe('CouncilTable', () => {
  it('members down, rounds across, each cell the score or why there is none; the task is read from the node the page is on', async () => {
    routes['GET /api/workspaces/ws_1/tasks/tsk_1/council'] = () => ({ body: VIEW });
    render(<CouncilTable taskId="tsk_1" wsId="ws_1" />);
    await screen.findByRole('table');
    expect(calls).toEqual([{ method: 'GET', path: '/api/workspaces/ws_1/tasks/tsk_1/council', search: '' }]);

    expect(screen.getAllByRole('columnheader').map((h) => h.textContent)).toEqual(['Member', 'Round 1', 'Round 2']);
    expect(cellsOf('evidence')).toEqual(['7/10', '8/10']);
    expect(cellsOf('reasoning')).toEqual(['no score', '6/10 (counted as 9: no upheld issue backs it)']);
    expect(cellsOf('private')).toEqual(['unavailable', 'unavailable']);
    expect(cellsOf('redo')).toEqual(['8/10', 'not waited for']);
    // Who each member is: CLI, model, lens, and whether its score counts.
    expect(rowOf('evidence').textContent).toContain('claude/opus');
    expect(rowOf('reasoning').textContent).toContain('codex/gpt-6.1-sol');
    expect(within(rowOf('redo')).getByText('non-blocking')).toBeTruthy();
    expect(within(rowOf('evidence')).queryByText('non-blocking')).toBeNull();
    expect(cellsOf('Result')).toEqual(['not passed (7)', 'not passed (8)']);
    // The rules of the stage.
    expect(screen.getByText(/pass score 9/).textContent).toBe('Council: pass score 9, at most 3 rounds, an issue blocks when any blocking member raises it, unavailable member: report');
    // Why a member has no score.
    expect(screen.getByText(/the run ended without a review/).textContent).toBe('Round 1, reasoning: no score (the run ended without a review)');
    expect(screen.getAllByText(/is not enabled/).map((e) => e.textContent)).toEqual([
      "Round 1, private: unavailable (provider 'opencode' is not enabled)",
      "Round 2, private: unavailable (provider 'opencode' is not enabled)",
    ]);
  });

  it('a member that was not seated in a round has an empty mark in that round', async () => {
    const view = structuredClone(VIEW);
    view.rounds[0]!.result.members = view.rounds[0]!.result.members.filter((m) => m.name !== 'redo');
    routes['GET /api/workspaces/ws_1/tasks/tsk_1/council'] = () => ({ body: view });
    render(<CouncilTable taskId="tsk_1" wsId="ws_1" />);
    await screen.findByRole('table');
    expect(cellsOf('redo')).toEqual(['—', 'not waited for']);
    expect(cellsOf('evidence')).toEqual(['7/10', '8/10']);
  });

  it('below the table: the open issues of the latest round with who raised each, what does not block, the questions and the follow-ups of every round', async () => {
    routes['GET /api/workspaces/ws_1/tasks/tsk_1/council'] = () => ({ body: VIEW });
    render(<CouncilTable taskId="tsk_1" wsId="ws_1" />);
    const open = within(await screen.findByRole('list', { name: 'Open issues' })).getAllByRole('listitem');
    expect(open.map((li) => li.textContent)).toEqual([`I2 substantive ${REVENUE} (about fnd_x) raised by evidence, reasoning`]);
    const advisory = within(screen.getByRole('list', { name: 'Not blocking' })).getAllByRole('listitem');
    expect(advisory.map((li) => li.textContent)).toEqual([`I3 substantive ${STALE} raised by reasoning`]);
    const questions = within(screen.getByRole('list', { name: 'Questions' })).getAllByRole('listitem');
    expect(questions.map((li) => li.textContent)).toEqual(['Is the filing the latest one? asked by evidence']);
    const followUps = within(screen.getByRole('list', { name: 'Follow-ups' })).getAllByRole('listitem');
    expect(followUps.map((li) => li.textContent)).toEqual([
      'Check the pricing page of the second product raised by reasoning (round 1)',
      'Compare the churn of the two plans raised by evidence, reasoning (round 2)',
    ]);
    // An issue of an earlier round that is no longer raised is not open.
    expect(screen.queryByText(/An issue of the first round/)).toBeNull();
    expect(screen.queryByText(/A question of the first round/)).toBeNull();
    // A dropped nit is not put to anyone.
    expect(screen.queryByText(/The title is long/)).toBeNull();
  });

  it('a round that failed says why, and puts nothing to the worker', async () => {
    const failed = "council member 'reasoning' (codex/gpt-6.1-sol) gave no review: the run ended without a review";
    routes['GET /api/workspaces/ws_1/tasks/tsk_1/council'] = () => ({
      body: {
        stage: VIEW.stage,
        rounds: [{ ...VIEW.rounds[0]!, failed, result: { ...VIEW.rounds[0]!.result, score: 0, issues: [{ ...VIEW.rounds[0]!.result.issues[0]!, standing: 'advisory' }] } }],
      },
    });
    render(<CouncilTable taskId="tsk_1" wsId="ws_1" />);
    await screen.findByRole('table');
    expect(cellsOf('Result')).toEqual(['did not count']);
    expect(screen.getByText(/did not count:/).textContent).toBe(`Round 1 did not count: ${failed}`);
    expect(screen.queryByRole('list', { name: 'Open issues' })).toBeNull();
    expect(screen.getByRole('list', { name: 'Not blocking' })).toBeTruthy();
  });

  it('a passed round has no open issues; private research is shown as withheld; a task without rounds says so', async () => {
    const passed = { ...VIEW.rounds[1]!, result: { ...VIEW.rounds[1]!.result, pass: true, score: 9, issues: [], questions: [], followUps: [], dropped: [] } };
    routes['GET /api/workspaces/ws_1/tasks/tsk_1/council'] = () => ({ body: { stage: VIEW.stage, rounds: [passed] } });
    const first = render(<CouncilTable taskId="tsk_1" wsId="ws_1" />);
    await screen.findByRole('table');
    expect(cellsOf('Result')).toEqual(['passed (9)']);
    for (const name of ['Open issues', 'Not blocking', 'Questions', 'Follow-ups']) expect(screen.queryByRole('list', { name })).toBeNull();
    first.unmount();

    routes['GET /api/workspaces/ws_1/tasks/tsk_1/council'] = () => ({ body: { withheld: true, rounds: [{ round: 1, decisionId: 'dec_1', at: '', withheld: true }] } });
    const second = render(<CouncilTable taskId="tsk_1" wsId="ws_1" />);
    expect((await screen.findByText(/withheld/)).textContent).toBe('1 council round, withheld while this research is private.');
    expect(screen.queryByRole('table')).toBeNull();
    second.unmount();

    routes['GET /api/workspaces/ws_1/tasks/tsk_1/council'] = () => ({ body: { rounds: [] } });
    render(<CouncilTable taskId="tsk_1" wsId="ws_1" />);
    expect(await screen.findByText('No council round is recorded for this task.')).toBeTruthy();
  });

  it('shows the server error', async () => {
    routes['GET /api/workspaces/ws_1/tasks/tsk_1/council'] = () => ({ status: 404, body: { error: "task 'tsk_1' not found" } });
    render(<CouncilTable taskId="tsk_1" wsId="ws_1" />);
    expect(await screen.findByText("task 'tsk_1' not found")).toBeTruthy();
  });
});

describe('LastReviewNote', () => {
  const review = { score: 8, issues: [{ id: 'I2', class: 'substantive', description: REVENUE }], decisionId: 'dec_2', at: '' };

  it('a council review offers the council table, loaded when it is opened', async () => {
    routes['GET /api/workspaces/ws_1/tasks/tsk_1/council'] = () => ({ body: VIEW });
    render(<LastReviewNote review={{ ...review, council: { taskId: 'tsk_1' } }} wsId="ws_1" />);
    expect(screen.getByText('Last review score').parentElement!.textContent).toContain('8/10');
    expect(screen.getByText(/by a council/)).toBeTruthy();
    expect(calls).toEqual([]);
    const toggle = screen.getByRole('button', { name: 'Show the council' });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    await act(async () => {
      fireEvent.click(toggle);
    });
    await screen.findByRole('table');
    expect(calls.map((c) => c.path)).toEqual(['/api/workspaces/ws_1/tasks/tsk_1/council']);
    expect(cellsOf('evidence')).toEqual(['7/10', '8/10']);
    const hide = screen.getByRole('button', { name: 'Hide the council' });
    expect(hide.getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(hide);
    expect(screen.queryByRole('table')).toBeNull();
  });

  it('a council round that did not count is not called a failed reviewer run', () => {
    render(<LastReviewNote review={{ ...review, score: 0, issues: [], synthetic: true, council: { taskId: 'tsk_1' } }} wsId="ws_1" />);
    expect(screen.getByText(/the council round did not count/)).toBeTruthy();
    expect(screen.queryByText(/reviewer run failed/)).toBeNull();
  });

  it('a single review shows no council, as before', () => {
    render(<LastReviewNote review={review} wsId="ws_1" />);
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.queryByText(/council/)).toBeNull();
    cleanup();
    render(<LastReviewNote review={{ ...review, score: 0, synthetic: true }} wsId="ws_1" />);
    expect(screen.getByText(/reviewer run failed; recorded by the harness/)).toBeTruthy();
  });
});

describe('Research page: where a council-reviewed task and its reviews are listed', () => {
  const T = '2026-11-16T10:00:00.000Z';
  const task = (id: string, extra: Record<string, unknown> = {}) => ({
    id, workspaceId: 'ws_1', runId: 'rrun_1', phase: 'deep_dives', type: 'news_scan', brief: `brief of ${id}`, model: { provider: 'claude', model: 'sonnet' },
    needsBrowser: false, acceptanceCriteria: [], status: 'verified', round: 2, createdAt: T, ...extra,
  });
  const review = (id: string, payload: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
    id, workspaceId: 'ws_1', agentRunId: `arun_${id}`, role: 'reviewer', model: { provider: 'claude', model: 'opus' }, promptVersion: 'pv', kind: 'review',
    payload, refs: ['tsk_1'], createdAt: T, ...extra,
  });
  const base = '/api/workspaces/ws_1';

  beforeEach(() => {
    vi.stubGlobal('EventSource', class { addEventListener() {} removeEventListener() {} close() {} });
    routes[`GET ${base}/runs`] = () => ({ body: [{ id: 'rrun_1', workspaceId: 'ws_1', phase: 'deep_dives', status: 'done', startedAt: T }] });
    routes[`GET ${base}/tasks`] = () => ({ body: [task('tsk_1', { councilReviewed: true }), task('tsk_2', { type: 'public_filings' })] });
    routes[`GET ${base}/decisions`] = () => ({
      body: [
        review('dec_m1', { tool: 'submit_review', score: 7, issues: [] }, { councilMember: { name: 'evidence', lens: 'evidence' } }),
        review('dec_m2', { tool: 'submit_review', withheld: true }, { councilMember: { name: 'second' } }),
        review('dec_c', { tool: 'harness', event: 'council_review', round: 1, score: 7 }),
        review('dec_s', { tool: 'submit_review', score: 9, issues: [] }),
      ],
    });
    routes[`GET ${base}/changes`] = () => ({ body: [] });
    routes[`GET ${base}/requests`] = () => ({ body: [] });
    routes[`GET ${base}/tasks/tsk_1/council`] = () => ({ body: VIEW });
  });

  const taskRow = (brief: string) => screen.getByText(brief).closest('tr')!;

  it('a task a council reviewed offers its council table in its row, also when it passed; a task with a single reviewer does not', async () => {
    const { Research } = await import('../../web/src/views/Research.js');
    render(<Research wsId="ws_1" />);
    await screen.findByText('brief of tsk_1');
    expect(within(taskRow('brief of tsk_1')).getByText('verified')).toBeTruthy();
    expect(within(taskRow('brief of tsk_2')).queryByRole('button')).toBeNull();
    // Nothing is loaded until the table is opened.
    expect(calls.some((c) => c.path.endsWith('/council'))).toBe(false);
    const toggle = within(taskRow('brief of tsk_1')).getByRole('button', { name: 'Show the council' });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    await act(async () => {
      fireEvent.click(toggle);
    });
    const council = within(await screen.findByRole('region', { name: 'council of task tsk_1' }));
    await council.findByRole('table');
    expect(calls.filter((c) => c.path.endsWith('/council')).map((c) => c.path)).toEqual([`${base}/tasks/tsk_1/council`]);
    expect(council.getAllByRole('columnheader').map((h) => h.textContent)).toEqual(['Member', 'Round 1', 'Round 2']);
    expect(cellsOf('evidence')).toEqual(['7/10', '8/10']);
    const hide = within(taskRow('brief of tsk_1')).getByRole('button', { name: 'Hide the council' });
    expect(hide.getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(hide);
    expect(screen.queryByRole('region', { name: 'council of task tsk_1' })).toBeNull();
  });

  it("a member's own review is labelled with the member's name and lens, the round's review as the council's; a single review has no label", async () => {
    const { Research } = await import('../../web/src/views/Research.js');
    render(<Research wsId="ws_1" />);
    const list = (await screen.findByRole('heading', { name: 'Review rounds' })).nextElementSibling!;
    await within(list as HTMLElement).findAllByRole('listitem');
    const labels = within(list as HTMLElement).getAllByRole('listitem').map((li) => li.querySelector('.tag')?.textContent ?? null);
    expect(labels).toEqual(['council member: evidence (evidence)', 'council member: second', 'council review', null]);
    // A withheld member review keeps its label and shows no payload.
    expect(within(list as HTMLElement).getAllByRole('listitem')[1]!.textContent).not.toContain('"withheld"');
  });
});

describe('reviewDecisionLabel', () => {
  it("names a council member's review and the round's review; nothing else", () => {
    expect(reviewDecisionLabel({ payload: { tool: 'submit_review' }, councilMember: { name: 'a', lens: 'brief' } })).toBe('council member: a (brief)');
    expect(reviewDecisionLabel({ payload: { tool: 'submit_review' }, councilMember: { name: 'a' } })).toBe('council member: a');
    expect(reviewDecisionLabel({ payload: { tool: 'harness', event: 'council_review' } })).toBe('council review');
    expect(reviewDecisionLabel({ payload: { tool: 'harness', event: 'synthetic_review' } })).toBeUndefined();
    expect(reviewDecisionLabel({ payload: { tool: 'submit_review' } })).toBeUndefined();
    expect(reviewDecisionLabel({ payload: null })).toBeUndefined();
  });
});

describe('Settings: the configured council', () => {
  const council = {
    rounds: 3, passScore: 9, blockOn: 'majority', onUnavailable: 'fail',
    members: [
      { name: 'evidence', provider: 'claude', model: 'opus', lens: 'evidence', blocking: true, available: true, stages: ['symptom_hypotheses', 'synthesize_recommendations'] },
      { name: 'second', provider: 'codex', model: 'gpt-6.1-sol', effort: 'high', lens: 'evidence', blocking: true, available: false, reason: "provider 'codex' is not enabled", stages: ['synthesize_recommendations'] },
      { name: 'redo', provider: 'claude', model: 'opus', lens: 'rewrite', blocking: false, available: true, stages: [] },
    ],
    stages: [
      { taskType: 'symptom_hypotheses', rounds: 3, passScore: 9, members: ['evidence'] },
      { taskType: 'synthesize_recommendations', rounds: 4, passScore: 9, members: ['evidence', 'second'] },
    ],
  };

  it('lists the rules, each member available or not and why, and the stages; nothing in it can be edited', async () => {
    routes['GET /api/config'] = () => ({ body: { providers: {} } });
    routes['GET /api/council'] = () => ({ body: { council } });
    render(<Settings />);
    const section = (await screen.findByRole('heading', { name: 'Review council' })).closest('section')!;
    const s = within(section);
    expect(s.getByText(/At most 3 rounds/).textContent).toBe(
      'At most 3 rounds, pass score 9, an issue blocks when more than half of the blocking members raise it, a blocking member that is unavailable ends the task unverified.',
    );
    const rows = s.getAllByRole('row').map((r) => within(r).queryAllByRole('cell').map((c) => c.textContent));
    expect(rows).toEqual([
      [],
      ['evidence', 'claude/opus', 'evidence', 'yes', 'available', 'symptom_hypotheses, synthesize_recommendations'],
      ['second', 'codex/gpt-6.1-sol (effort high)', 'evidence', 'yes', "unavailable: provider 'codex' is not enabled", 'synthesize_recommendations'],
      ['redo', 'claude/opus', 'rewrite', 'no', 'available', 'not seated'],
      [],
      ['symptom_hypotheses', 'evidence', '3', '9'],
      ['synthesize_recommendations', 'evidence, second', '4', '9'],
    ]);
    expect(s.queryAllByRole('textbox')).toEqual([]);
    expect(s.queryAllByRole('button')).toEqual([]);
  });

  it('is read again after the configuration was saved', async () => {
    let configured: typeof council | null = null;
    routes['GET /api/config'] = () => ({ body: { providers: {} } });
    routes['PUT /api/config'] = () => ({ body: { providers: {}, council: {} } });
    routes['GET /api/council'] = () => ({ body: { council: configured } });
    render(<Settings />);
    await screen.findByText(/No council is configured/);
    configured = council;
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '{"providers":{},"council":{}}' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    });
    expect(await screen.findByText(/At most 3 rounds/)).toBeTruthy();
    expect(calls.filter((c) => c.path === '/api/council')).toHaveLength(2);
  });

  it('says so when no council is configured', async () => {
    routes['GET /api/config'] = () => ({ body: { providers: {} } });
    routes['GET /api/council'] = () => ({ body: { council: null } });
    render(<Settings />);
    const section = (await screen.findByRole('heading', { name: 'Review council' })).closest('section')!;
    expect(await within(section).findByText(/No council is configured/)).toBeTruthy();
    expect(within(section).queryByRole('table')).toBeNull();
  });
});
