// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { acceptEffect, asLessonsPage, effectVerdict, pctText, type LessonsPage } from '../../web/src/logic/lessons.js';
import { parseRoute } from '../../web/src/logic/router.js';
import { Lessons } from '../../web/src/views/Lessons.js';

const effect = {
  ruleId: 'lrule_1', marker: 'L-ABC123', version: 1, withRule: 6, withRuleHits: 1, rateWithRule: 0.167, anyVersion: 6, beforeRule: 5, beforeRuleHits: 3,
  rateBeforeRule: 0.6, cleanStreak: 4,
  versions: [
    { promptVersion: 'aaaa1111', firstSeen: '2026-11-01T00:00:00Z', tasks: 5, hits: 3, rate: 0.6, passRate: 0.4, agreeRate: null, costUsd: 1.5 },
    { promptVersion: 'bbbb2222', ruleVersion: 1, firstSeen: '2026-11-08T00:00:00Z', tasks: 6, hits: 1, rate: 0.167, passRate: 0.83, agreeRate: 1, costUsd: 2 },
  ],
};
const page: LessonsPage = {
  rootWorkspaceId: 'ws_1',
  settings: { enabled: true, minTasks: 3, retireAfterCleanTasks: 10, minEffectTasks: 5, maxRulesPerRole: 15, retro: { enabled: true, cron: '0 6 * * 1', windowDays: 7, maxProposals: 5, nextAt: null } },
  roles: [{ role: 'worker', active: 1, pending: 1, cap: 15 }],
  proposals: [
    {
      id: 'lprop_1', rootWorkspaceId: 'ws_1', role: 'worker', action: 'add', category: 'review:substantive:news_scan', text: 'In news_scan tasks, check each claim.',
      rationale: 'review issues: substantive (news_scan) recurred in 3 tasks of the worker role.', source: 'engine', status: 'pending', createdAt: '2026-11-13T00:00:00Z',
      stats: { tasks: 3 }, evidence: [{ kind: 'review_issue', id: 'rvi_1', taskId: 'tsk_1', quote: 'figure lacks a date' }, { kind: 'review_issue', id: 'rvi_2', taskId: 'tsk_2' }],
    },
  ],
  rules: [
    {
      rule: {
        id: 'lrule_1', rootWorkspaceId: 'ws_1', role: 'worker', category: 'review:blocking:news_scan', marker: 'L-ABC123', text: 'Check every acceptance criterion.', strength: 1,
        version: 1, status: 'active', source: 'engine', actor: 'local-user', createdAt: '2026-11-07T00:00:00Z', changedAt: '2026-11-07T00:00:00Z',
        promptVersionBefore: 'aaaa1111', promptVersionAfter: 'bbbb2222',
      },
      effect,
    },
  ],
  retros: [
    { id: 'retro_1', rootWorkspaceId: 'ws_1', status: 'done', triggeredBy: 'schedule', windowStart: '2026-11-06T00:00:00Z', windowEnd: '2026-11-13T00:00:00Z', digest: {}, evidenceIds: [], proposalIds: [], summary: 'A quiet week.', createdAt: '2026-11-13T00:00:00Z' },
  ],
};

let calls: Array<{ method: string; path: string; body?: unknown }> = [];

beforeEach(() => {
  calls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init?: RequestInit) => {
      const path = new URL(String(input), 'http://localhost').pathname;
      const method = init?.method ?? 'GET';
      calls.push({ method, path, ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) });
      return new Response(JSON.stringify(method === 'GET' ? page : {}), { headers: { 'content-type': 'application/json' } });
    }),
  );
  vi.stubGlobal('EventSource', class { addEventListener() {} removeEventListener() {} close() {} });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('lessons page (web logic)', () => {
  it('helpers: verdicts, percentages, what an accept does, payload shape', () => {
    expect(pctText(0.167)).toBe('17%');
    expect(pctText(null)).toBe('—');
    expect(effectVerdict(effect)).toBe('working: 60% → 17%');
    expect(effectVerdict({ ...effect, rateWithRule: 0.6 })).toBe('not working: 60% → 60%');
    expect(effectVerdict({ ...effect, withRule: 2 })).toMatch(/too early/);
    expect(acceptEffect({ action: 'add', role: 'worker' })).toMatch(/Appends this rule to the worker prompt/);
    expect(acceptEffect({ action: 'retire', role: 'reviewer' })).toMatch(/Takes the rule out/);
    expect(asLessonsPage(page)).toBe(page);
    expect(asLessonsPage({})).toBeNull();
    expect(parseRoute('#/w/ws_1/lessons')).toEqual({ name: 'workspace', wsId: 'ws_1', page: 'lessons' });
  });

  it('renders proposals with evidence (quotes as text) and per-version effect; accept / reject post with the reason only', async () => {
    render(<Lessons wsId="ws_1" />);
    expect(await screen.findByText('In news_scan tasks, check each claim.')).toBeTruthy();
    expect(screen.getByText('figure lacks a date').tagName).toBe('PRE');
    expect(screen.getByText(/working: 60% → 17%/)).toBeTruthy();
    expect(screen.getByText('bbbb2222')).toBeTruthy();
    expect(screen.getByText('A quiet week.')).toBeTruthy();

    fireEvent.change(screen.getByPlaceholderText('Reason (optional)'), { target: { value: 'makes sense' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Accept' }));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Reject' }));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Propose taking it out' }));
    });
    const posts = calls.filter((c) => c.method === 'POST');
    expect(posts).toEqual([
      { method: 'POST', path: '/api/workspaces/ws_1/lessons/proposals/lprop_1/accept', body: { reason: 'makes sense' } },
      { method: 'POST', path: '/api/workspaces/ws_1/lessons/proposals/lprop_1/reject', body: { reason: 'makes sense' } },
      { method: 'POST', path: '/api/workspaces/ws_1/lessons/rules/lrule_1/propose-retire', body: {} },
    ]);
  });

  it('the view never calls fetch itself', () => {
    const src = readFileSync(join(process.cwd(), 'web/src/views/Lessons.tsx'), 'utf8');
    expect(src).not.toMatch(/\bfetch\(|from '\.\.\/logic\/api/);
  });
});
