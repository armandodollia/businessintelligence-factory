// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Decision } from '../../src/core/types.js';
import { changedArtifactLabel } from '../../web/src/logic/format.js';
import {
  findingCriteriaKeys,
  parseWeight,
  toChangeEntry,
  useChanges,
  usePromptPatch,
  useScoringWeights,
} from '../../web/src/logic/hooks.js';

type Handler = (body: unknown) => unknown;
let routes: Record<string, Handler>;
let calls: Array<{ method: string; path: string; body: unknown }>;

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });

async function fakeFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const url = new URL(String(input), 'http://localhost');
  const method = (init?.method ?? 'GET').toUpperCase();
  const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : null;
  calls.push({ method, path: url.pathname, body });
  const h = routes[`${method} ${url.pathname}`];
  return h ? json(h(body)) : json({ error: 'not found' }, 404);
}

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  private readonly listeners = new Map<string, Set<(e: { data: string }) => void>>();
  constructor(readonly url: string) {
    FakeEventSource.instances.push(this);
  }
  addEventListener(type: string, fn: (e: { data: string }) => void) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(fn);
  }
  removeEventListener(type: string, fn: (e: { data: string }) => void) {
    this.listeners.get(type)?.delete(fn);
  }
  close() {}
  emit(data: unknown) {
    for (const fn of this.listeners.get('message') ?? []) fn({ data: JSON.stringify(data) });
  }
}

const decision = (id: string, payload: unknown, createdAt = '2026-11-12T00:00:00.000Z'): Decision => ({
  id,
  workspaceId: 'ws_1',
  agentRunId: 'scheduler',
  role: 'orchestrator',
  model: { provider: 'claude', model: 'none' },
  promptVersion: 'n/a',
  kind: 'decision',
  payload,
  refs: [],
  createdAt,
});

const whatChanged = (over: Record<string, unknown> = {}) => ({
  actor: 'scheduler',
  tool: 'scheduler',
  event: 'what_changed',
  scheduleId: 'sc_1',
  scheduleName: 'weekly',
  phase: 'competitor_discovery',
  prevRunId: 'r1',
  nextRunId: 'r2',
  newFindings: ['f9'],
  removedSubjects: ['Acme'],
  changedArtifacts: [{ flow: 'checkout', step: 2, prev: 'a1', next: 'a2' }],
  ...over,
});

beforeEach(() => {
  routes = {};
  calls = [];
  FakeEventSource.instances = [];
  vi.stubGlobal('fetch', vi.fn(fakeFetch));
  vi.stubGlobal('EventSource', FakeEventSource);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('prompt patch', () => {
  it('proposes, lets the user edit, and applies the edited text only on approval', async () => {
    routes['POST /api/workspaces/ws_1/calibration/prompt-patch'] = (b) => ({
      role: (b as { role: string }).role,
      examples: [{ criterion: 'severity', agentValue: 4, userValue: 2, reason: 'overstated' }],
      patchText: 'Be less dramatic.',
    });
    routes['POST /api/workspaces/ws_1/calibration/prompt-patch/apply'] = () => ({ path: '/x/reviewer.md', decisionId: 'd1' });

    const { result } = renderHook(() => usePromptPatch('ws_1'));
    act(() => result.current.setRole('reviewer'));
    expect(result.current.canApply).toBe(false);
    await act(async () => {
      await result.current.propose();
    });
    expect(result.current.text).toBe('Be less dramatic.');
    expect(calls.filter((c) => c.path.endsWith('/apply'))).toHaveLength(0);

    act(() => result.current.setText('Rate severity conservatively.'));
    expect(result.current.edited).toBe(true);
    await act(async () => {
      await result.current.apply();
    });
    const applyCall = calls.find((c) => c.path.endsWith('/apply'));
    expect(applyCall?.body).toMatchObject({ role: 'reviewer', patchText: 'Rate severity conservatively.' });
    expect(result.current.applied).toEqual({ path: '/x/reviewer.md', decisionId: 'd1' });
    expect(result.current.proposal).toBeNull();
  });

  it('surfaces API errors', async () => {
    const { result } = renderHook(() => usePromptPatch('ws_1'));
    await act(async () => {
      await result.current.propose();
    });
    expect(result.current.error).toBe('not found');
    expect(result.current.proposal).toBeNull();
  });
});

describe('scoring weights', () => {
  it('parseWeight rejects negatives, blanks and non-numbers', () => {
    expect(parseWeight('1.5')).toBe(1.5);
    expect(parseWeight('0')).toBe(0);
    expect(parseWeight('-1')).toBeUndefined();
    expect(parseWeight('')).toBeUndefined();
    expect(parseWeight('abc')).toBeUndefined();
  });

  it('edits, blocks invalid input, adopts proposal and saves all weights', async () => {
    let stored = { weights: { upside: 2, risk: 1 }, personaWeight: 0 };
    routes['GET /api/workspaces/ws_1/scoring-weights'] = () => ({ ...stored, proposedWeights: { upside: 3, risk: 0.5 } });
    routes['PUT /api/workspaces/ws_1/scoring-weights'] = (b) => {
      stored = b as typeof stored;
      return { ...stored, decisionId: 'd7' };
    };

    const { result } = renderHook(() => useScoringWeights('ws_1'));
    await waitFor(() => expect(result.current.values.upside).toBe('2'));
    expect(result.current.values.cost).toBe('1'); // missing keys default to 1
    expect(result.current.hasProposal).toBe(true);

    act(() => result.current.set('cost', '-2'));
    expect(result.current.invalid).toEqual(['cost']);
    await act(async () => {
      await result.current.save();
    });
    expect(calls.some((c) => c.method === 'PUT')).toBe(false);

    act(() => result.current.set('cost', '0.5'));
    act(() => result.current.adoptProposed());
    expect(result.current.values.upside).toBe('3');
    expect(result.current.values.cost).toBe('0.5');
    act(() => result.current.set('personaWeight', '0.2'));
    await act(async () => {
      await result.current.save();
    });
    const put = calls.find((c) => c.method === 'PUT');
    expect(put?.body).toMatchObject({ weights: { upside: 3, risk: 0.5, cost: 0.5, difficulty: 1 }, personaWeight: 0.2 });
    expect(result.current.dirty).toBe(false);
    expect(result.current.savedDecisionId).toBe('d7');
    expect(result.current.values.upside).toBe('3');
  });
});

describe('what changed', () => {
  it('toChangeEntry maps scheduler diffs and ignores other decisions', () => {
    const e = toChangeEntry(decision('d1', whatChanged()));
    expect(e).toMatchObject({ scheduleName: 'weekly', phase: 'competitor_discovery', newFindings: ['f9'], empty: false });
    expect(
      toChangeEntry(decision('d2', whatChanged({ newFindings: [], removedSubjects: [], changedArtifacts: [] })))?.empty,
    ).toBe(true);
    // KS-5: a run that only confirmed, replaced or retracted facts is not "no changes".
    const lineage = toChangeEntry(decision('d5', whatChanged({ newFindings: [], removedSubjects: [], changedArtifacts: [], replaced: [{ from: 'f1', to: 'f2' }], retracted: ['f3'], confirmed: 2 })));
    expect(lineage).toMatchObject({ replaced: [{ from: 'f1', to: 'f2' }], retracted: ['f3'], confirmed: 2, empty: false });
    expect(toChangeEntry(decision('d6', whatChanged({ newFindings: [], removedSubjects: [], changedArtifacts: [], confirmed: 1 })))?.empty).toBe(false);
    expect(toChangeEntry(decision('d3', { tool: 'set_scoring_weights' }))).toBeNull();
    expect(toChangeEntry(decision('d4', null))).toBeNull();
  });

  it('changed screenshots are labelled with their competitor (older diffs without subject still render)', () => {
    expect(changedArtifactLabel({ subject: 'Globex', flow: 'signup', step: 1 })).toBe('Globex · signup step 1');
    expect(changedArtifactLabel({ flow: 'checkout', step: 2 })).toBe('checkout step 2');
  });

  it('findingCriteriaKeys keeps finding criteria only (competitor keys are rated on competitors)', () => {
    expect(findingCriteriaKeys({ threat: 5, relevance: 4, pricing: 2, novelty: 3 })).toEqual(['relevance', 'novelty']);
    expect(findingCriteriaKeys({})).toEqual([]);
  });

  it('lists changes newest first and appends live what_changed events', async () => {
    routes['GET /api/workspaces/ws_1/changes'] = () => [
      decision('d1', whatChanged(), '2026-11-10T00:00:00.000Z'),
      decision('d2', whatChanged({ scheduleName: 'daily' }), '2026-11-11T00:00:00.000Z'),
    ];
    const { result } = renderHook(() => useChanges('ws_1'));
    await waitFor(() => expect(result.current.changes).toHaveLength(2));
    expect(result.current.changes[0]?.scheduleName).toBe('daily');

    const es = FakeEventSource.instances[0]!;
    act(() => {
      es.emit({ type: 'decision', workspaceId: 'ws_1', decision: decision('d3', { tool: 'other' }) });
      es.emit({
        type: 'decision',
        workspaceId: 'ws_1',
        decision: decision('d4', whatChanged({ scheduleName: 'hourly' }), '2026-11-12T00:00:00.000Z'),
      });
    });
    await waitFor(() => expect(result.current.changes).toHaveLength(3));
    expect(result.current.changes[0]?.scheduleName).toBe('hourly');
  });
});
