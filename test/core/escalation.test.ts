import { afterEach, describe, expect, it } from 'vitest';
import type { BifConfig } from '../../src/core/config/schema.js';
import {
  answerEscalation,
  EscalationError,
  escalationToolHandlers,
  runEscalation,
  startEscalations,
  type EscalationService,
} from '../../src/core/escalation/escalation.js';
import { resolveUserRequest } from '../../src/core/harness/tools/handlers.js';
import { ROLE_TOOLS } from '../../src/core/harness/tools/registry.js';
import type { AgentRequest } from '../../src/core/research/deps.js';
import { runTaskWithReview } from '../../src/core/research/reviewLoop.js';
import type { Store } from '../../src/core/store/db.js';
import type { FakeScript } from '../../src/core/harness/adapter.js';
import { addTask, researchSetup, review, revise, submitWork, tick, type Picker } from './helpers/research.js';

const opened: Store[] = [];
const services: EscalationService[] = [];
afterEach(async () => {
  for (const s of services.splice(0)) {
    s.stop();
    await s.idle();
  }
  for (const s of opened.splice(0)) s.close();
});

const QUESTIONS = [
  {
    question: 'Which source should the re-run trust for Acme pricing?',
    options: ['The public pricing page', 'Sales quotes in uploads', 'Skip pricing'],
    recommended: 0,
    why: 'The reviewer could not verify the price.',
  },
  {
    question: 'May the agent request a demo?',
    options: ['Yes', 'No'],
    recommended: 1,
    why: 'A demo reaches a real person.',
  },
];

const escalate =
  (questions: unknown[] = QUESTIONS): FakeScript =>
  async (t) => {
    await t.call('submit_escalation', { questions });
  };

async function until(cond: () => boolean, ms = 3000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out');
    await tick(10);
  }
}

function setup(pick: Picker, config?: (c: BifConfig) => void) {
  const s = researchSetup(opened, {
    pick,
    extraHandlers: () => escalationToolHandlers(),
    ...(config ? { config } : {}),
  });
  return s;
}

/** Worker always scores 5 → unverified after maxRounds (1 here); escalation asks QUESTIONS. */
function unverifiedPicker(onWork?: (r: AgentRequest) => void): Picker {
  let reviews = 0;
  return (r) => {
    if (r.kind === 'escalate') return escalate();
    if (r.kind === 'work') {
      onWork?.(r);
      return submitWork();
    }
    if (r.kind === 'revise') {
      onWork?.(r);
      return revise('fix')(r);
    }
    reviews++;
    // The first review fails (task ends unverified); the review after the re-run passes.
    return reviews === 1 ? review(5, [{ class: 'blocking', description: 'PRICE_NOT_VERIFIED' }]) : review(9);
  };
}

describe('escalation role', () => {
  it('only gets read_artifact, log_decision and submit_escalation', () => {
    expect(new Set(ROLE_TOOLS.escalation)).toEqual(new Set(['log_decision', 'read_artifact', 'submit_escalation']));
    expect(ROLE_TOOLS.worker).not.toContain('submit_escalation');
  });
});

describe('runEscalation', () => {
  it('asks multiple-choice questions as escalation user requests when a task ends unverified', async () => {
    const s = setup(unverifiedPicker(), (c) => (c.loop.maxRounds = 1));
    const svc = startEscalations(s.deps);
    services.push(svc);
    const task = addTask(s.store);
    const out = await runTaskWithReview(task, s.deps);
    expect(out.status).toBe('unverified');
    await until(() => s.store.userRequests.list({ taskId: task.id }).length === 2);
    await svc.idle();

    const reqs = s.store.userRequests.list({ taskId: task.id });
    expect(reqs.map((r) => r.kind)).toEqual(['escalation', 'escalation']);
    expect(reqs[0]).toMatchObject({
      status: 'pending',
      details: QUESTIONS[0]!.question,
      optionsJson: { options: QUESTIONS[0]!.options, recommended: 0, rationale: QUESTIONS[0]!.why },
    });
    // The task keeps its final status: escalation questions never put it in waiting_user.
    expect(s.store.tasks.get(task.id)!.status).toBe('unverified');
    // The escalation agent ran as its own role with the task's outcome in its prompt.
    const req = s.requests.find((r) => r.kind === 'escalate')!;
    expect(req.role).toBe('escalation');
    expect(req.prompt).toContain(task.brief);
    expect(req.prompt).toContain('PRICE_NOT_VERIFIED');
    expect(req.prompt).toMatch(/unverified/);
    expect(req.systemPrompt).toMatch(/submit_escalation/);
    // Live UI: each question is announced like any user request.
    expect(s.seen.filter((e) => e.type === 'user_request').length).toBe(2);
  });

  it('also escalates failed tasks, never verified ones', async () => {
    const s = setup((r) => (r.kind === 'escalate' ? escalate([QUESTIONS[0]]) : r.kind === 'work' ? async () => { throw new Error('boom'); } : review(9)));
    const failed = addTask(s.store);
    expect((await runTaskWithReview(failed, s.deps)).status).toBe('failed');
    expect(await runEscalation(s.deps, failed.id)).toHaveLength(1);

    const ok = setup((r) => (r.kind === 'work' ? submitWork() : r.kind === 'review' ? review(9) : escalate()));
    const task = addTask(ok.store);
    expect((await runTaskWithReview(task, ok.deps)).status).toBe('verified');
    expect(await runEscalation(ok.deps, task.id)).toEqual([]);
    expect(ok.requests.some((r) => r.kind === 'escalate')).toBe(false);
  });

  it('zero questions is fine; invalid questions are rejected', async () => {
    const s = setup((r) => (r.kind === 'escalate' ? escalate([]) : undefined));
    const task = addTask(s.store, { status: 'unverified' });
    expect(await runEscalation(s.deps, task.id)).toEqual([]);
    expect(s.store.userRequests.list({ taskId: task.id })).toEqual([]);

    let error = '';
    const bad = setup((r) =>
      r.kind === 'escalate'
        ? async (t) => {
            try {
              await t.call('submit_escalation', { questions: [{ ...QUESTIONS[0], recommended: 5 }] });
            } catch (e) {
              error = (e as Error).message;
            }
          }
        : undefined,
    );
    const t2 = addTask(bad.store, { status: 'failed' });
    expect(await runEscalation(bad.deps, t2.id)).toEqual([]);
    expect(error).toMatch(/recommended/);
  });

  it('respects escalation.maxQuestions, maxPerTask and enabled=false', async () => {
    let error = '';
    const s = setup(
      (r) =>
        r.kind === 'escalate'
          ? async (t) => {
              try {
                await t.call('submit_escalation', { questions: QUESTIONS });
              } catch (e) {
                error = (e as Error).message;
              }
            }
          : undefined,
      (c) => (c.escalation = { maxQuestions: 1 }),
    );
    const task = addTask(s.store, { status: 'unverified' });
    await runEscalation(s.deps, task.id);
    expect(error).toMatch(/at most 1/);

    const capped = setup((r) => (r.kind === 'escalate' ? escalate([QUESTIONS[0]]) : undefined), (c) => (c.escalation = { maxPerTask: 1 }));
    const t2 = addTask(capped.store, { status: 'unverified' });
    expect(await runEscalation(capped.deps, t2.id)).toHaveLength(1);
    // Pending questions block a second escalation; once answered the per-task cap does.
    expect(await runEscalation(capped.deps, t2.id)).toEqual([]);
    const [q] = capped.store.userRequests.list({ taskId: t2.id });
    resolveUserRequest(capped, q!.id, 'denied');
    expect(await runEscalation(capped.deps, t2.id)).toEqual([]);
    expect(capped.requests.filter((r) => r.kind === 'escalate')).toHaveLength(1);

    const off = setup((r) => (r.kind === 'escalate' ? escalate() : undefined), (c) => (c.escalation = { enabled: false }));
    const t3 = addTask(off.store, { status: 'failed' });
    expect(await runEscalation(off.deps, t3.id)).toEqual([]);
    expect(off.requests).toEqual([]);
  });

  it('a replayed submit_escalation (rate-limit retry) does not ask twice', async () => {
    const s = setup((r) =>
      r.kind === 'escalate'
        ? async (t) => {
            await t.call('submit_escalation', { questions: [QUESTIONS[0]] });
            await t.call('submit_escalation', { questions: [QUESTIONS[0]] });
          }
        : undefined,
    );
    const task = addTask(s.store, { status: 'unverified' });
    await runEscalation(s.deps, task.id);
    expect(s.store.userRequests.list({ taskId: task.id })).toHaveLength(1);
  });
});

describe('answering escalations', () => {
  it('records the chosen option and re-runs the task with the answers in its prior-attempt context', async () => {
    const prompts: string[] = [];
    const s = setup(unverifiedPicker((r) => prompts.push(r.prompt)), (c) => (c.loop.maxRounds = 1));
    const svc = startEscalations(s.deps);
    services.push(svc);
    const task = addTask(s.store);
    await runTaskWithReview(task, s.deps);
    await until(() => s.store.userRequests.list({ taskId: task.id }).length === 2);
    const [q1, q2] = s.store.userRequests.list({ taskId: task.id });

    const a1 = answerEscalation(s, q1!.id, { choice: 1, note: 'use the Q3 quote' });
    expect(a1.status).toBe('resolved');
    expect(a1.optionsJson?.choice).toBe(1);
    expect(a1.response).toContain('Sales quotes in uploads');
    expect(a1.response).toContain('use the Q3 quote');
    // Not re-run until every question of the escalation is answered.
    await tick(30);
    expect(prompts).toHaveLength(1);

    answerEscalation(s, q2!.id, { choice: 1 });
    await until(() => s.store.tasks.get(task.id)!.status === 'verified');
    await svc.idle();

    expect(prompts).toHaveLength(2);
    const rerun = prompts[1]!;
    expect(rerun).toContain('Previous attempt');
    expect(rerun).toContain(QUESTIONS[0]!.question);
    expect(rerun).toContain('Sales quotes in uploads');
    expect(rerun).toContain('use the Q3 quote');
    expect(rerun).toContain('PRICE_NOT_VERIFIED');
    // What the previous run did (prior-attempt summary of its tool calls).
    expect(rerun).toMatch(/save_finding fnd_/);
    // The rerun is a revision of the previous deliverable; its answers appear once, not twice.
    expect(rerun.split(QUESTIONS[0]!.question)).toHaveLength(2);
    // Fresh review budget: the re-run got its own review round although maxRounds is 1.
    const final = s.store.tasks.get(task.id)!;
    expect(final.round).toBe(2);
    // A verified rerun is not escalated again.
    expect(s.requests.filter((r) => r.kind === 'escalate')).toHaveLength(1);
  });

  it('does not re-run when every question was dismissed', async () => {
    const s = setup((r) => (r.kind === 'escalate' ? escalate([QUESTIONS[0]]) : undefined));
    const svc = startEscalations(s.deps);
    services.push(svc);
    const task = addTask(s.store, { status: 'unverified' });
    const [q] = await runEscalation(s.deps, task.id);
    resolveUserRequest(s, q!.id, 'denied');
    await tick(30);
    await svc.idle();
    expect(s.store.tasks.get(task.id)!.status).toBe('unverified');
    expect(s.requests.filter((r) => r.kind !== 'escalate')).toEqual([]);
  });

  it('validates the answer', async () => {
    const s = setup((r) => (r.kind === 'escalate' ? escalate([QUESTIONS[1]]) : undefined));
    const task = addTask(s.store, { status: 'failed' });
    const [q] = await runEscalation(s.deps, task.id);
    expect(() => answerEscalation(s, q!.id, { choice: 2 })).toThrow(EscalationError);
    expect(() => answerEscalation(s, 'ureq_nope', { choice: 0 })).toThrow(/not found/);
    answerEscalation(s, q!.id, { choice: 0 });
    expect(() => answerEscalation(s, q!.id, { choice: 0 })).toThrow(/already/);
    const other = s.store.userRequests.insert({
      id: 'ureq_other', workspaceId: 'ws_a', agentRunId: 'arun_x', kind: 'approval', details: 'x', status: 'pending',
      createdAt: new Date().toISOString(),
    });
    expect(() => answerEscalation(s, other.id, { choice: 0 })).toThrow(/not an escalation/);
  });
});
