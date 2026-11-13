// @vitest-environment jsdom
import { act, cleanup, render, renderHook, screen, waitFor } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  EMPTY_EXPERIMENT_FORM,
  auditLabel,
  buildExperimentBody,
  comparisonRows,
  modelOptions,
  parseModel,
  useAudits,
  useExperiments,
} from '../../web/src/logic/experiments.js';
import { App } from '../../web/src/views/App.js';

type Handler = (url: URL, body: unknown) => unknown;
let routes: Record<string, Handler>;
let calls: Array<{ method: string; path: string; body: unknown }>;

async function fakeFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const url = new URL(String(input), 'http://localhost');
  const method = (init?.method ?? 'GET').toUpperCase();
  const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : null;
  calls.push({ method, path: url.pathname + url.search, body });
  const h = routes[`${method} ${url.pathname}`];
  const data = h ? h(url, body) : method === 'GET' ? [] : { error: 'not found' };
  return new Response(JSON.stringify(data), { status: h || method === 'GET' ? 200 : 404, headers: { 'content-type': 'application/json' } });
}

beforeEach(() => {
  routes = {};
  calls = [];
  vi.stubGlobal('fetch', vi.fn(fakeFetch));
  vi.stubGlobal(
    'EventSource',
    class {
      addEventListener() {}
      removeEventListener() {}
      close() {}
    },
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.location.hash = '';
});

const totals = (costUsd: number) => ({
  runs: 2, inputTokens: 10, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 10, costUsd, cliReportedCostUsd: 0, unpriced: 0,
});
const arm = (name: 'A' | 'B', model: string, passRate: number, costUsd: number) => ({
  arm: name, model: { provider: 'claude', model }, workerPromptVersions: ['aaaa0001'], reviewerModels: [{ provider: 'codex', model: 'gpt-6.1-sol' }],
  tasks: [{ taskId: `tsk_${name}`, status: 'verified', round: 1, finalScore: 9 }], finished: 1, verified: passRate, passRate, firstRoundPassRate: passRate,
  meanRounds: 1, reviewScores: [9], meanReviewScore: 9, userRatings: { count: 0, agree: 0, agreeRate: null }, cost: totals(costUsd), costPerTask: costUsd,
});
const audit = (id: string, verdict: string, status = 'done') => ({
  id, batchId: 'abat', workspaceId: 'ws_1', rootWorkspaceId: 'ws_1', taskId: 'tsk_1', taskType: 'news_scan', startedBy: 'api', actor: 'local-user',
  status, verdict, passThreshold: 8, originalDecisionId: 'dec_1', originalModel: { provider: 'codex', model: 'gpt-6.1-sol' }, originalScore: 9,
  auditModel: { provider: 'claude', model: 'opus' }, auditScore: verdict === 'miss' ? 3 : 9,
  auditIssues: verdict === 'miss' ? [{ class: 'blocking', description: 'AUDITOR_ISSUE_TEXT' }] : [], createdAt: '2026-11-13T10:00:00Z',
});

describe('experiments logic', () => {
  it('parses models, builds bodies and formats comparisons', () => {
    expect(parseModel('claude/haiku')).toEqual({ provider: 'claude', model: 'haiku' });
    expect(parseModel('nope')).toBeUndefined();
    expect(parseModel('gpt/x')).toBeUndefined();
    expect(modelOptions({ providers: { claude: { enabled: true, command: 'c', models: ['opus'] }, codex: { enabled: false, command: 'x', models: ['m'] }, opencode: { enabled: true, command: 'o', models: [] } } })).toEqual(['claude/opus']);
    expect(buildExperimentBody(EMPTY_EXPERIMENT_FORM)).toEqual({ error: 'pick a finished task' });
    expect(buildExperimentBody({ ...EMPTY_EXPERIMENT_FORM, taskId: 't' })).toMatchObject({ error: expect.stringMatching(/same/) });
    expect(buildExperimentBody({ ...EMPTY_EXPERIMENT_FORM, taskId: 't', repeats: '9', b: { model: 'claude/haiku', promptVersion: '' } })).toMatchObject({ error: expect.stringMatching(/repeats/) });
    expect(buildExperimentBody({ ...EMPTY_EXPERIMENT_FORM, taskId: 't', name: ' x ', repeats: '2', b: { model: 'claude/haiku', promptVersion: ' abcd1234 ' } })).toEqual({
      body: { taskId: 't', name: 'x', repeats: 2, arms: [{}, { model: { provider: 'claude', model: 'haiku' }, promptVersion: 'abcd1234' }] },
    });
    const rows = comparisonRows([arm('A', 'sonnet', 1, 0.5), arm('B', 'haiku', 0, 0.1)] as never);
    expect(rows.find((r) => r.label === 'Review pass rate')!.cells).toEqual(['100%', '0%']);
    expect(rows.find((r) => r.label === 'Cost')!.cells).toEqual(['$0.5000', '$0.1000']);
    expect(auditLabel({ status: 'done', verdict: 'miss' })).toMatch(/MISS/);
    expect(auditLabel({ status: 'running' })).toBe('running…');
  });

  it('useAudits runs an audit and reloads; useExperiments starts one from the form', async () => {
    let audits = [audit('aud_1', 'agree')];
    routes['GET /api/workspaces/ws_1/audits'] = () => ({ rootWorkspaceId: 'ws_1', summary: { total: audits.length, agree: 1, miss: audits.length - 1, invalid: 0, skipped: 0, running: 0, missRate: 0 }, audits, schedules: [] });
    routes['POST /api/workspaces/ws_1/audits'] = () => {
      audits = [audit('aud_2', 'miss'), ...audits];
      return { batchId: 'abat', audits: [] };
    };
    const a = renderHook(() => useAudits('ws_1'));
    await waitFor(() => expect(a.result.current.view?.audits).toHaveLength(1));
    await act(async () => {
      await a.result.current.runAudit(3);
    });
    expect(calls.find((c) => c.method === 'POST')!.body).toEqual({ n: 3 });
    await waitFor(() => expect(a.result.current.view?.audits).toHaveLength(2));

    routes['GET /api/workspaces/ws_1/tasks'] = () => [
      { id: 'tsk_done', status: 'verified', runId: 'rr_1', type: 'news_scan' },
      { id: 'tsk_arm', status: 'verified', runId: 'rr_exp', type: 'news_scan' },
      { id: 'tsk_live', status: 'running', runId: 'rr_1', type: 'news_scan' },
    ];
    routes['GET /api/workspaces/ws_1/experiments'] = () => [{ id: 'exp_0', researchRunId: 'rr_exp', status: 'done', arms: [], createdAt: '' }];
    routes['GET /api/config'] = () => ({ providers: { claude: { enabled: true, command: 'c', models: ['sonnet', 'haiku'] }, codex: { enabled: false, command: 'x', models: [] }, opencode: { enabled: false, command: 'o', models: [] } } });
    routes['POST /api/workspaces/ws_1/experiments'] = (_u, body) => ({ id: 'exp_1', ...(body as object), status: 'running', arms: [], createdAt: '' });
    const x = renderHook(() => useExperiments('ws_1'));
    await waitFor(() => expect(x.result.current.sourceTasks.map((t) => t.id)).toEqual(['tsk_done']));
    expect(x.result.current.models).toEqual(['claude/sonnet', 'claude/haiku']);
    act(() => x.result.current.setForm({ ...EMPTY_EXPERIMENT_FORM, taskId: 'tsk_done', b: { model: 'claude/haiku', promptVersion: '' } }));
    await act(async () => {
      await x.result.current.start();
    });
    expect(calls.filter((c) => c.method === 'POST').at(-1)!.body).toEqual({ taskId: 'tsk_done', arms: [{}, { model: { provider: 'claude', model: 'haiku' } }] });
    expect(x.result.current.selected).toBe('exp_1');
  });
});

describe('audits & experiments page', () => {
  it('shows audits with misses, schedules and an experiment comparison', async () => {
    routes['GET /api/workspaces/ws_1'] = () => ({ id: 'ws_1', name: 'Acme', sector: 'saas' });
    routes['GET /api/workspaces/ws_1/audits'] = () => ({
      rootWorkspaceId: 'ws_1', summary: { total: 2, agree: 1, miss: 1, invalid: 0, skipped: 0, running: 0, missRate: 0.5 },
      audits: [audit('aud_2', 'miss'), audit('aud_1', 'agree')],
      schedules: [{ id: 'asch_1', workspaceId: 'ws_1', rootWorkspaceId: 'ws_1', cron: '0 3 * * 1', n: 5, enabled: true, actor: 'local-user', createdAt: '' }],
    });
    routes['GET /api/workspaces/ws_1/experiments'] = () => [
      { id: 'exp_1', name: 'haiku vs sonnet', researchRunId: 'rr', status: 'done', createdAt: '2026-11-13T10:00:00Z', arms: [{ arm: 'A', model: { provider: 'claude', model: 'sonnet' }, taskIds: [] }, { arm: 'B', model: { provider: 'claude', model: 'haiku' }, taskIds: [] }] },
    ];
    routes['GET /api/experiments/exp_1'] = () => ({ experiment: { id: 'exp_1', name: 'haiku vs sonnet', status: 'done', arms: [] }, arms: [arm('A', 'sonnet', 1, 0.5), arm('B', 'haiku', 0, 0.1)] });
    window.location.hash = '#/w/ws_1/experiments';
    render(<App />);
    expect(await screen.findByText(/AUDITOR_ISSUE_TEXT/)).toBeTruthy();
    expect(screen.getByText(/miss rate 50%/)).toBeTruthy();
    expect(screen.getByText('0 3 * * 1')).toBeTruthy();
    await act(async () => {
      (await screen.findByRole('button', { name: 'haiku vs sonnet' })).click();
    });
    expect(await screen.findByText('Review pass rate')).toBeTruthy();
    expect(screen.getAllByText('$0.1000')).toHaveLength(2); // cost and cost per task of arm B
  });

  it('the view never calls fetch itself', () => {
    const src = readFileSync(join(import.meta.dirname, '../../web/src/views/Experiments.tsx'), 'utf8');
    expect(src).not.toMatch(/\bfetch\(/);
    expect(src).not.toMatch(/logic\/api/);
  });
});
