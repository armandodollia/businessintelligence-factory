// @vitest-environment jsdom
/**
 * Stakeholder personas in the web app (design §7, §8, §15): the Stakeholders page (question round,
 * open stakeholder cards, competitor stakeholders), the stakeholder reads on a recommendation on the
 * Strategy page, and withheld research on the pages that show tasks, runs and decisions.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { describeEvent } from '../../web/src/logic/format.js';
import { resetRatingIndexes } from '../../web/src/logic/hooks.js';
import { answersToSend, questionsHeading, WITHHELD_TEXT } from '../../web/src/logic/stakeholders.js';
import type { StakeholderQuestion, StakeholderQuestionGroup, StakeholdersView } from '../../web/src/logic/types.js';
import { DecisionLog } from '../../web/src/views/DecisionLog.js';
import { Research } from '../../web/src/views/Research.js';
import { Stakeholders } from '../../web/src/views/Stakeholders.js';
import { Strategy } from '../../web/src/views/Strategy.js';

const T = '2026-11-15T00:00:00.000Z';
const q = (id: string, personaId: string | undefined, text: string): StakeholderQuestion => ({
  id, rootWorkspaceId: 'ws_1', workspaceId: 'ws_1', ...(personaId ? { personaId } : {}), field: 'decision_criteria', text, status: 'open', createdAt: T,
});
const field = (value: string, confidence = 0.6) => ({ value, confidence, evidence: ['art_1'] });

const CFO_OPEN = {
  id: 'per_cfo', label: 'Chief financial officer', stakeholderType: 'leader', disclosure: 'open', subjectKind: 'own', relation: 'Approves pricing changes',
  profile: { decision_criteria: field('Payback under a year', 0.7) }, version: 1, status: 'pending', statements: 1, questions: 0,
} as const;
const OPS_OPEN = {
  id: 'per_ops', label: 'Billing platform team', stakeholderType: 'team', disclosure: 'open', subjectKind: 'own', relation: 'Runs the invoices',
  profile: { dependencies: field('<b>API</b> access') }, version: 2, status: 'verified', statements: 2, questions: 0,
} as const;
const RIVAL = {
  id: 'per_rival', label: 'Chief executive', stakeholderType: 'leader', disclosure: 'open', subjectKind: 'competitor', relation: 'Sets the rival roadmap',
  profile: {}, version: 1, status: 'pending', statements: 0, questions: 0,
} as const;

let calls: Array<{ method: string; path: string; body?: unknown }> = [];
let list: StakeholdersView;
let groups: StakeholderQuestionGroup[];

function initial() {
  list = {
    enabled: true,
    own: [
      { id: 'per_cfo', label: 'Chief financial officer', stakeholderType: 'leader', disclosure: 'hidden', questions: 2 },
      { id: 'per_leg', label: 'Legal team', stakeholderType: 'team', disclosure: 'hidden', questions: 1 },
      OPS_OPEN,
    ],
    competitors: [{ competitorId: 'cmp_1', name: 'Rival Pay', stakeholders: [RIVAL] }],
  };
  groups = [
    { persona: { id: 'per_cfo', label: 'Chief financial officer', stakeholderType: 'leader' }, questions: [q('stq_1', 'per_cfo', 'When Chief financial officer decides, what matters most?'), q('stq_2', 'per_cfo', 'What do you need from Chief financial officer?')] },
    { persona: { id: 'per_leg', label: 'Legal team', stakeholderType: 'team' }, questions: [q('stq_3', 'per_leg', 'What does Legal team provide to you?')] },
    { questions: [q('stq_n', undefined, 'Is anyone missing from this list whose approval, budget or data you depend on?')] },
  ];
  reads = [READ];
}

const statements: Record<string, unknown[]> = {
  per_ops: [
    { id: 'sst_2', rootWorkspaceId: 'ws_1', workspaceId: 'ws_1', personaId: 'per_ops', source: 'note', text: 'Newest: <i>ships Tuesdays</i>', actor: 'u', createdAt: '2026-11-14T00:00:00.000Z' },
    { id: 'sst_1', rootWorkspaceId: 'ws_1', workspaceId: 'ws_1', personaId: 'per_ops', source: 'question_answer', text: 'Older answer', actor: 'u', createdAt: '2026-11-13T00:00:00.000Z' },
  ],
};

const rec = { id: 'rec_1', workspaceId: 'ws_1', title: 'Raise prices', summary: 's', criteria: {}, findingIds: [], personaFeedback: [], priority: 3, createdAt: T, status: 'verified' };
const READ = {
  id: 'srd_1', rootWorkspaceId: 'ws_1', workspaceId: 'ws_1', recommendationId: 'rec_1', personaId: 'per_ops', personaVersion: 2, stance: 'approve_with_conditions',
  conditions: ['Two weeks of notice'], concerns: ['<script>alert(1)</script>'], reasoning: 'Invoices change.', wouldChangeMind: 'A pilot', agentRunId: 'arun_1',
  simulated: true, createdAt: T, label: 'Billing platform team', stakeholderType: 'team', subjectKind: 'own',
} as Record<string, unknown>;
let reads: Array<Record<string, unknown>>;

const withheldTask = { id: 'tsk_w', workspaceId: 'ws_1', runId: 'rrun_1', phase: 'stakeholders', type: 'own_stakeholders', status: 'verified', round: 1, model: { provider: 'claude', model: 'sonnet' }, createdAt: T, withheld: true };
const withheldDecision = {
  id: 'dec_w', workspaceId: 'ws_1', agentRunId: 'arun_w', role: 'worker', model: { provider: 'claude', model: 'sonnet' }, promptVersion: 'pv1', kind: 'decision',
  payload: { tool: 'log_decision', withheld: true }, refs: [], createdAt: T,
};

function respond(method: string, path: string, body: unknown): unknown {
  const base = '/api/workspaces/ws_1';
  if (path === `${base}/stakeholders`) return list;
  if (path === `${base}/stakeholder-questions`) return { groups };
  if (path === `${base}/stakeholder-questions/answers`) {
    const b = body as { answers: Array<{ questionId: string }>; skip?: string[]; skipAll?: boolean };
    const opened = new Set<string>(b.skip ?? []);
    for (const a of b.answers) {
      const g = groups.find((x) => x.questions.some((y) => y.id === a.questionId));
      if (g?.persona) opened.add(g.persona.id);
    }
    if (b.skipAll) groups.forEach((g) => g.persona && opened.add(g.persona.id));
    groups = groups.filter((g) => !g.persona || !opened.has(g.persona.id));
    list = { ...list, own: list.own.map((v) => (opened.has(v.id) && v.id === 'per_cfo' ? CFO_OPEN : v)) };
    return { opened: [...opened], statements: [] };
  }
  if (path.endsWith('/reveal')) {
    groups = groups.filter((g) => g.persona?.id !== 'per_cfo');
    list = { ...list, own: list.own.map((v) => (v.id === 'per_cfo' ? CFO_OPEN : v)) };
    return CFO_OPEN;
  }
  const st = path.match(/\/stakeholders\/([^/]+)\/statements$/);
  if (st) return { statements: statements[st[1]!] ?? [] };
  if (path.endsWith('/notes')) return { id: 'sst_9', text: (body as { text: string }).text };
  if (path === `${base}/persona-learning`) {
    return {
      enabled: true,
      personas: [{ personaId: 'per_ops', segment: 'Billing platform team', version: 2, gate: { n: 0, agree: 0, disagree: 0, items: 0, lower: 0, qualifies: false, missing: ['1 of 6 reactions'] }, adjustments: [], proposals: [] }],
    };
  }
  if (path === `${base}/recommendations`) return [rec];
  if (path === `${base}/recommendations/rec_1/stakeholder-reads`) return { reads };
  if (path === `${base}/runs`) return [{ id: 'rrun_1', workspaceId: 'ws_1', phase: 'stakeholders', status: 'done', startedAt: T }];
  if (path === `${base}/tasks`) return [withheldTask];
  if (path === `${base}/decisions`) return [withheldDecision];
  if (path === `${base}/calibration`) return { byCriterion: [] };
  if (path.startsWith('/api/artifacts/')) return { id: 'art_1', workspaceId: 'ws_1', kind: 'page', mime: 'text/html', path: 'a.html', sha256: 'x', createdAt: T };
  if (method === 'POST') return {};
  return [];
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
      return new Response(JSON.stringify(respond(method, path, body)), { headers: { 'content-type': 'application/json' } });
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
const questionsBlock = () => within(screen.getByRole('region', { name: 'questions for you' }));

describe('stakeholder wording', () => {
  it('heading counts stakeholders, not node questions; only non-empty answers are sent', () => {
    expect(questionsHeading(groups)).toBe('Questions for you (2 stakeholders)');
    expect(questionsHeading(groups.slice(1))).toBe('Questions for you (1 stakeholder)');
    expect(answersToSend(groups, { stq_1: '  Margin  ', stq_2: '   ', stq_n: 'The auditor' })).toEqual([
      { questionId: 'stq_1', text: 'Margin' },
      { questionId: 'stq_n', text: 'The auditor' },
    ]);
  });
});

describe('Stakeholders page: the question round', () => {
  it('a hidden stakeholder shows only its label, type and questions, with the intro and the activity-log note', async () => {
    render(<Stakeholders wsId="ws_1" />);
    const b = within(await screen.findByRole('region', { name: 'questions for you' }));
    expect(screen.getByText('Questions for you (2 stakeholders)')).toBeTruthy();
    expect(screen.getByText('The tool has drafted a picture of each of these. It will show you after you answer, so your answers are your own.')).toBeTruthy();
    expect(screen.getAllByText('Research on these stakeholders is kept out of the activity log until you answer, skip or choose to see it.')).toHaveLength(1);
    const cfo = within(b.getByRole('group', { name: 'Chief financial officer' }));
    expect(cfo.getByText('Chief financial officer')).toBeTruthy();
    expect(cfo.getByText('leader')).toBeTruthy();
    expect(cfo.getByLabelText('When Chief financial officer decides, what matters most?')).toBeTruthy();
    expect(cfo.getByRole('button', { name: 'Skip' })).toBeTruthy();
    expect(cfo.getByRole('button', { name: 'Show what the tool found' })).toBeTruthy();
    expect(b.getByLabelText('Is anyone missing from this list whose approval, budget or data you depend on?')).toBeTruthy();
    expect(b.getByRole('button', { name: 'Skip all' })).toBeTruthy();
    // Nothing research found about a hidden stakeholder is on the page.
    expect(screen.queryByText('Approves pricing changes')).toBeNull();
    expect(screen.queryByText('Payback under a year')).toBeNull();
    expect(screen.queryByRole('region', { name: 'stakeholder Chief financial officer' })).toBeNull();
  });

  it('Send answers posts only non-empty answers; the answered stakeholder opens with its profile, a blank one stays in the questions', async () => {
    render(<Stakeholders wsId="ws_1" />);
    await screen.findByRole('region', { name: 'questions for you' });
    const send = () => questionsBlock().getByRole('button', { name: 'Send answers' }) as HTMLButtonElement;
    expect(send().disabled).toBe(true);
    fireEvent.change(questionsBlock().getByLabelText('When Chief financial officer decides, what matters most?'), { target: { value: ' Margin ' } });
    fireEvent.change(questionsBlock().getByLabelText('What do you need from Chief financial officer?'), { target: { value: '   ' } });
    expect(send().disabled).toBe(false);
    await act(async () => {
      fireEvent.click(send());
    });
    expect(posts()).toEqual([{ method: 'POST', path: '/api/workspaces/ws_1/stakeholder-questions/answers', body: { answers: [{ questionId: 'stq_1', text: 'Margin' }] } }]);
    const card = within(await screen.findByRole('region', { name: 'stakeholder Chief financial officer' }));
    expect(card.getByText('Approves pricing changes')).toBeTruthy();
    expect(card.getByText('Payback under a year')).toBeTruthy();
    expect(card.getByText('0.70')).toBeTruthy();
    expect(questionsBlock().getByRole('group', { name: 'Legal team' })).toBeTruthy();
    expect(questionsBlock().queryByRole('group', { name: 'Chief financial officer' })).toBeNull();
  });

  it('Skip, Show what the tool found and Skip all each post their request', async () => {
    render(<Stakeholders wsId="ws_1" />);
    await screen.findByRole('region', { name: 'questions for you' });
    await act(async () => {
      fireEvent.click(within(questionsBlock().getByRole('group', { name: 'Chief financial officer' })).getByRole('button', { name: 'Show what the tool found' }));
    });
    expect(await screen.findByRole('region', { name: 'stakeholder Chief financial officer' })).toBeTruthy();
    await act(async () => {
      fireEvent.click(within(questionsBlock().getByRole('group', { name: 'Legal team' })).getByRole('button', { name: 'Skip' }));
    });
    initial();
    await act(async () => {
      fireEvent.click(questionsBlock().getByRole('button', { name: 'Skip all' }));
    });
    expect(posts()).toEqual([
      { method: 'POST', path: '/api/workspaces/ws_1/stakeholders/per_cfo/reveal', body: {} },
      { method: 'POST', path: '/api/workspaces/ws_1/stakeholder-questions/answers', body: { answers: [], skip: ['per_leg'] } },
      { method: 'POST', path: '/api/workspaces/ws_1/stakeholder-questions/answers', body: { answers: [], skipAll: true } },
    ]);
  });
});

describe('Stakeholders page: open stakeholders', () => {
  it('a card shows label, type, relation, status, fields with confidence and evidence, statements newest first as text, and the learning block', async () => {
    render(<Stakeholders wsId="ws_1" />);
    const card = within(await screen.findByRole('region', { name: 'stakeholder Billing platform team' }));
    expect(card.getByText('team')).toBeTruthy();
    expect(card.getByText('Runs the invoices')).toBeTruthy();
    expect(card.getByText('verified')).toBeTruthy();
    expect(card.getByText('<b>API</b> access')).toBeTruthy();
    expect(card.getByText('simulated')).toBeTruthy();
    const told = within(card.getByRole('region', { name: 'what you have told the tool about per_ops' }));
    const items = await told.findAllByRole('listitem');
    expect(items.map((li) => li.textContent)).toEqual([expect.stringContaining('Newest: <i>ships Tuesdays</i>'), expect.stringContaining('Older answer')]);
    expect(document.querySelector('i')).toBeNull();
    expect(card.getByRole('region', { name: 'what the tool has learned about per_ops' })).toBeTruthy();
    // verified: no include box
    expect(card.queryByLabelText('use per_ops for reads and learning')).toBeNull();
  });

  it('Add a note posts the text and reloads the statements; the include box posts the persona include route', async () => {
    list = { ...list, own: [CFO_OPEN, OPS_OPEN] };
    groups = [];
    render(<Stakeholders wsId="ws_1" />);
    const card = within(await screen.findByRole('region', { name: 'stakeholder Billing platform team' }));
    expect(screen.queryByRole('region', { name: 'questions for you' })).toBeNull();
    expect(screen.queryByText(/kept out of the activity log/)).toBeNull();
    fireEvent.change(card.getByLabelText('note about per_ops'), { target: { value: 'They want two weeks of notice.' } });
    await act(async () => {
      fireEvent.click(card.getByRole('button', { name: 'Add a note' }));
    });
    const cfo = within(screen.getByRole('region', { name: 'stakeholder Chief financial officer' }));
    await act(async () => {
      fireEvent.click(cfo.getByLabelText('use per_cfo for reads and learning'));
    });
    expect(posts()).toEqual([
      { method: 'POST', path: '/api/workspaces/ws_1/stakeholders/per_ops/notes', body: { text: 'They want two weeks of notice.' } },
      { method: 'POST', path: '/api/personas/per_cfo/include', body: { include: true } },
    ]);
    expect(calls.filter((c) => c.path.endsWith('/per_ops/statements'))).toHaveLength(2);
    expect((card.getByLabelText('note about per_ops') as HTMLTextAreaElement).value).toBe('');
  });

  it('competitor stakeholders are listed under their company', async () => {
    render(<Stakeholders wsId="ws_1" />);
    const company = within(await screen.findByRole('region', { name: 'stakeholders of Rival Pay' }));
    expect(company.getByText('Rival Pay')).toBeTruthy();
    expect(company.getByRole('region', { name: 'stakeholder Chief executive' })).toBeTruthy();
  });

  it('a competitor with nothing open to show gets no section', async () => {
    list = {
      ...list,
      competitors: [
        ...list.competitors,
        { competitorId: 'cmp_2', name: 'Quiet Co', stakeholders: [{ id: 'per_q', label: 'Owner', stakeholderType: 'owner', disclosure: 'hidden', questions: 0 }] },
      ],
    };
    render(<Stakeholders wsId="ws_1" />);
    await screen.findByRole('region', { name: 'stakeholders of Rival Pay' });
    expect(screen.queryByRole('region', { name: 'stakeholders of Quiet Co' })).toBeNull();
    expect(screen.queryByText('Quiet Co')).toBeNull();
  });

  it('with stakeholder personas off there is no question round, even with questions left from before', async () => {
    list = { ...list, enabled: false };
    render(<Stakeholders wsId="ws_1" />);
    expect(await screen.findByText('Stakeholder personas are off (config stakeholders.enabled).')).toBeTruthy();
    await screen.findByRole('region', { name: 'stakeholder Billing platform team' });
    expect(screen.queryByRole('region', { name: 'questions for you' })).toBeNull();
    expect(screen.queryByText(/kept out of the activity log/)).toBeNull();
  });

  it('with stakeholder personas off, hidden stakeholders are still listed with only "Show what the tool found", which opens one', async () => {
    list = { ...list, enabled: false };
    render(<Stakeholders wsId="ws_1" />);
    const kept = within(await screen.findByRole('region', { name: 'hidden stakeholders' }));
    const cfo = within(kept.getByRole('group', { name: 'Chief financial officer' }));
    expect(cfo.getByText('leader')).toBeTruthy();
    expect(cfo.getAllByRole('button').map((b) => b.textContent)).toEqual(['Show what the tool found']);
    expect(kept.getByRole('group', { name: 'Legal team' })).toBeTruthy();
    expect(kept.queryByRole('textbox')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Skip all' })).toBeNull();
    expect(screen.queryByText('Approves pricing changes')).toBeNull();
    await act(async () => {
      fireEvent.click(cfo.getByRole('button', { name: 'Show what the tool found' }));
    });
    expect(posts()).toEqual([{ method: 'POST', path: '/api/workspaces/ws_1/stakeholders/per_cfo/reveal', body: {} }]);
    expect(await screen.findByRole('region', { name: 'stakeholder Chief financial officer' })).toBeTruthy();
  });
});

describe('Strategy: stakeholder reads on a recommendation', () => {
  it('shows the read as simulated with stance, conditions, concerns and reasoning, as text', async () => {
    render(<Strategy wsId="ws_1" />);
    const r = within(await screen.findByRole('region', { name: 'stakeholder reads of rec_1' }));
    expect(r.getByText('Stakeholder reads (simulated)')).toBeTruthy();
    expect(r.getByText('Billing platform team')).toBeTruthy();
    expect(r.getByText('approve with conditions')).toBeTruthy();
    expect(r.getByText('Two weeks of notice')).toBeTruthy();
    expect(r.getByText('<script>alert(1)</script>')).toBeTruthy();
    expect(r.getByText('Invoices change.')).toBeTruthy();
  });

  it('agree / disagree post the reaction with the reason; Record the real decision posts { personaId, decision, reasoning }', async () => {
    list = { ...list, own: [OPS_OPEN, { id: 'per_leg', label: 'Legal team', stakeholderType: 'team', disclosure: 'hidden', questions: 1 }] };
    render(<Strategy wsId="ws_1" />);
    const r = within(await screen.findByRole('region', { name: 'stakeholder reads of rec_1' }));
    fireEvent.change(r.getByLabelText('reason for srd_1'), { target: { value: 'they always ask for notice' } });
    await act(async () => {
      fireEvent.click(r.getByRole('button', { name: 'Agree' }));
    });
    await act(async () => {
      fireEvent.click(r.getByRole('button', { name: 'Disagree' }));
    });
    fireEvent.click(r.getByRole('button', { name: 'Record the real decision' }));
    const form = within(r.getByRole('group', { name: 'record the real decision on rec_1' }));
    const who = form.getByLabelText('Stakeholder') as HTMLSelectElement;
    expect([...who.options].map((o) => o.textContent)).toEqual(['Billing platform team']);
    fireEvent.change(form.getByLabelText('Decision'), { target: { value: 'rejected' } });
    fireEvent.change(form.getByLabelText('Reasoning'), { target: { value: 'Not this quarter.' } });
    await act(async () => {
      fireEvent.click(form.getByRole('button', { name: 'Save' }));
    });
    expect(posts()).toEqual([
      { method: 'POST', path: '/api/workspaces/ws_1/stakeholder-reads/srd_1/reaction', body: { reaction: 'agree', reason: 'they always ask for notice' } },
      { method: 'POST', path: '/api/workspaces/ws_1/stakeholder-reads/srd_1/reaction', body: { reaction: 'disagree' } },
      { method: 'POST', path: '/api/workspaces/ws_1/recommendations/rec_1/stakeholder-decisions', body: { personaId: 'per_ops', decision: 'rejected', reasoning: 'Not this quarter.' } },
    ]);
    expect(r.queryByRole('group', { name: 'record the real decision on rec_1' })).toBeNull();
    expect(r.getByText(/Recorded: rejected/)).toBeTruthy();
  });

  it('a read the user reacted to before shows that reaction and its reason after a reload; the user can still change it', async () => {
    reads = [{ ...reads[0]!, reaction: 'disagree', reactionReason: 'They never approve in Q4.' }];
    render(<Strategy wsId="ws_1" />);
    const r = within(await screen.findByRole('region', { name: 'stakeholder reads of rec_1' }));
    expect(r.getByText('You disagreed: They never approve in Q4.')).toBeTruthy();
    await act(async () => {
      fireEvent.click(r.getByRole('button', { name: 'Agree' }));
    });
    expect(posts()).toEqual([{ method: 'POST', path: '/api/workspaces/ws_1/stakeholder-reads/srd_1/reaction', body: { reaction: 'agree' } }]);
    expect(r.getByText('You agreed.')).toBeTruthy();
    expect(r.queryByText(/You disagreed/)).toBeNull();
  });
});

describe('withheld research', () => {
  it('a withheld task and a withheld decision say so instead of an empty row', async () => {
    render(<Research wsId="ws_1" />);
    // the task row, and the decision in the orchestrator plan and the review rounds
    await waitFor(() => expect(screen.getAllByText(WITHHELD_TEXT)).toHaveLength(3));
    cleanup();
    render(<DecisionLog wsId="ws_1" />);
    expect(await screen.findByText(WITHHELD_TEXT)).toBeTruthy();
    expect(screen.queryByText(/"withheld":true/)).toBeNull();
  });

  it('a live decision event of withheld research says so', () => {
    expect(describeEvent({ type: 'decision', workspaceId: 'ws_1', decision: withheldDecision } as never)).toBe(`decision by worker: ${WITHHELD_TEXT}`);
  });
});
