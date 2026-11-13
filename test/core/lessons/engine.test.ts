import { afterEach, describe, expect, it, vi } from 'vitest';
import { acceptLessonProposalAsUser, FeedbackActionError, rejectLessonProposalAsUser, rolePromptVersion } from '../../../src/core/feedback/actions.js';
import { listFeedback } from '../../../src/core/feedback/events.js';
import { recordRetrieval } from '../../../src/core/knowledge/retrievalLog.js';
import { evaluateLessons, proposeRuleRetirement, ruleEffect, rulesWithEffect } from '../../../src/core/learning/lessons/engine.js';
import { withLessons } from '../../../src/core/learning/lessons/mode.js';
import { recordLessonSignal } from '../../../src/core/learning/lessons/signals.js';
import { lessonRepos } from '../../../src/core/learning/lessons/store.js';
import { getPromptText, promptStoreGaps } from '../../../src/core/prompts/store.js';
import { reviewerSystemPrompt, workerSystemPrompt } from '../../../src/core/research/systemPrompts.js';
import { calibrationScope } from '../../../src/core/scoring/calibration.js';
import type { Store } from '../../../src/core/store/db.js';
import { lessonsSetup } from './fixture.js';

const opened: Store[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const s of opened.splice(0)) s.close();
});

const workerPrompt = (t: ReturnType<typeof lessonsSetup>, ws: string) =>
  workerSystemPrompt(t.config, 'worker', false, 'news_scan', calibrationScope(t.store, t.dir, ws));

/** `n` tasks in `ws`, the first `hits` with a substantive review issue. */
function tasks(t: ReturnType<typeof lessonsSetup>, ws: string, n: number, hits: number, text = 'the figure has no source') {
  for (let i = 0; i < n; i++) {
    const x = t.task(ws);
    if (i < hits) t.issue(x, 'substantive', `${text} (${i})`);
  }
}

function acceptFirst(t: ReturnType<typeof lessonsSetup>, ws: string, action?: string) {
  evaluateLessons(t, ws);
  const p = lessonRepos(t.store).proposals.list({ rootWorkspaceId: ws, status: 'pending' }).find((x) => !action || x.action === action)!;
  return acceptLessonProposalAsUser({ store: t.store, config: t.config }, ws, p.id);
}

describe('lessons engine: adding rules', () => {
  it('proposes a rule once a category recurs in ≥ 3 tasks of the tree (child nodes count), never across trees', () => {
    const t = lessonsSetup(opened);
    tasks(t, t.a.id, 2, 2);
    tasks(t, t.b.id, 2, 2);
    expect(evaluateLessons(t, t.a.id)).toEqual([]);
    tasks(t, t.aChild.id, 1, 1);
    const [p, ...rest] = evaluateLessons(t, t.a.id);
    expect(rest).toEqual([]);
    expect(p).toMatchObject({ rootWorkspaceId: t.a.id, role: 'worker', action: 'add', category: 'review:substantive:news_scan', status: 'pending', stats: { tasks: 3 } });
    // B (2 tasks) has nothing, and A's evidence names only A's tree.
    expect(evaluateLessons(t, t.b.id)).toEqual([]);
    const bTasks = t.store.tasks.list({ workspaceId: t.b.id }).map((x) => x.id);
    for (const e of p!.evidence) expect(bTasks).not.toContain(e.taskId);
    // Idempotent: a second evaluation adds nothing.
    expect(evaluateLessons(t, t.a.id)).toEqual([]);
  });

  it('rule text comes from templates only; examples quote non-exposed issues and name upload-exposed ones by id', () => {
    const t = lessonsSetup(opened);
    const xs = [t.task(t.a.id), t.task(t.a.id), t.task(t.a.id)];
    const issues = xs.map((x, i) => t.issue(x, 'substantive', i === 0 ? 'SECRET-UPLOAD-TEXT from the board deck' : `public claim ${i} lacks a date`));
    // The first task's worker read upload-derived text: its run, task and the task's outputs are exposed.
    recordRetrieval({ store: t.store }, { workspaceId: t.a.id, agentRunId: xs[0]!.worker.id, taskId: xs[0]!.task.id, role: 'worker' }, {
      tool: 'read_artifact', query: 'x', scope: 'node', results: [{ id: 'art_up', kind: 'artifact' }], tokensReturned: 10, latencyMs: 1, uploadDerived: true,
    });
    const [p] = evaluateLessons(t, t.a.id);
    expect(p!.text).not.toMatch(/SECRET|public claim/);
    expect(JSON.stringify(p)).not.toContain('SECRET-UPLOAD-TEXT');
    const exposed = p!.evidence.find((e) => e.id === issues[0]!.id)!;
    expect(exposed).toEqual({ kind: 'review_issue', id: issues[0]!.id, taskId: xs[0]!.task.id });
    expect(p!.evidence.find((e) => e.id === issues[1]!.id)!.quote).toBe('public claim 1 lacks a date');
  });

  it('caps proposals plus active rules at 15 per role', () => {
    const t = lessonsSetup(opened);
    const xs = [t.task(t.a.id), t.task(t.a.id), t.task(t.a.id)];
    for (let c = 1; c <= 17; c++) {
      for (const x of xs) recordLessonSignal(t.store, { workspaceId: t.a.id, role: 'reviewer', category: `audit:miss_${c}`, source: 'test', taskId: x.task.id });
    }
    expect(evaluateLessons(t, t.a.id).filter((p) => p.role === 'reviewer')).toHaveLength(15);
    expect(evaluateLessons(t, t.a.id)).toEqual([]);
  });
});

describe('accepting and rejecting (user control)', () => {
  it('nothing changes a prompt until the user accepts; accept appends the marked rule and records version, decision and event', () => {
    const t = lessonsSetup(opened, (c) => (c.user = { id: 'alice' }));
    tasks(t, t.a.id, 3, 3);
    const before = rolePromptVersion(t.config, 'worker', calibrationScope(t.store, t.dir, t.a.id));
    const promptBefore = workerPrompt(t, t.a.id);
    const [p] = evaluateLessons(t, t.a.id);
    expect(workerPrompt(t, t.a.id)).toBe(promptBefore);

    const res = acceptLessonProposalAsUser({ store: t.store, config: t.config }, t.aChild.id, p!.id);
    const rule = res.rule!;
    expect(rule).toMatchObject({ status: 'active', role: 'worker', version: 1, strength: 1, actor: 'alice', marker: expect.stringMatching(/^L-[0-9A-Z]{6}$/) });
    const after = workerPrompt(t, t.a.id);
    expect(after).toContain(`[${rule.marker}.v1] ${p!.text}`);
    expect(workerPrompt(t, t.aChild.id)).toContain(rule.marker); // the whole tree
    expect(workerPrompt(t, t.b.id)).not.toContain(rule.marker); // never another tree
    expect(reviewerSystemPrompt(t.config, calibrationScope(t.store, t.dir, t.a.id))).not.toContain(rule.marker); // per role
    expect(res.previousPromptVersion).toBe(before);
    expect(res.promptVersion).not.toBe(before);
    expect(rule.promptVersionAfter).toBe(res.promptVersion);
    expect(getPromptText(t.store, res.promptVersion!)?.text).toContain(rule.marker);
    expect(promptStoreGaps(t.store)).toEqual([]);
    const [ev] = listFeedback(t.store, { kind: 'lesson_accept' });
    expect(ev).toMatchObject({ actor: 'alice', targetType: 'lesson', targetId: p!.id, promptVersion: res.promptVersion, afterJson: { ruleId: rule.id, marker: rule.marker } });
    const decision = t.store.decisions.get(res.decisionId!)!;
    expect(decision.payload).toMatchObject({ tool: 'accept_lesson', actor: 'user', actorId: 'alice', proposalId: p!.id });
    expect(lessonRepos(t.store).proposals.get(p!.id)).toMatchObject({ status: 'accepted', actor: 'alice', feedbackEventId: ev!.id });
    // Decided proposals cannot be decided again; another tree's caller sees "not found".
    expect(() => acceptLessonProposalAsUser({ store: t.store, config: t.config }, t.a.id, p!.id)).toThrow(/already accepted/);
  });

  it('rejects from another tree as unknown, and reject records an event and changes nothing', () => {
    const t = lessonsSetup(opened, (c) => (c.user = { id: 'bob' }));
    tasks(t, t.a.id, 3, 3);
    const [p] = evaluateLessons(t, t.a.id);
    const err = (() => {
      try {
        acceptLessonProposalAsUser({ store: t.store, config: t.config }, t.b.id, p!.id);
      } catch (e) {
        return e as FeedbackActionError;
      }
    })();
    expect(err).toBeInstanceOf(FeedbackActionError);
    expect(err!.status).toBe(404);
    const prompt = workerPrompt(t, t.a.id);
    rejectLessonProposalAsUser({ store: t.store, config: t.config }, t.a.id, p!.id, { reason: 'too generic' });
    expect(workerPrompt(t, t.a.id)).toBe(prompt);
    expect(listFeedback(t.store, { kind: 'lesson_reject' })).toEqual([
      expect.objectContaining({ actor: 'bob', targetId: p!.id, reason: 'too generic', afterJson: expect.objectContaining({ status: 'rejected', category: p!.category }) }),
    ]);
    // Proposed again only after the category recurs in 3 tasks that started after the rejection.
    expect(evaluateLessons(t, t.a.id)).toEqual([]);
    tasks(t, t.a.id, 2, 2);
    expect(evaluateLessons(t, t.a.id)).toEqual([]);
    tasks(t, t.a.id, 1, 1);
    expect(evaluateLessons(t, t.a.id)).toHaveLength(1);
  });
});

describe('rule lifecycle: strengthen, retire, revert (tracking marker per prompt version)', () => {
  it('strengthens a rule whose category keeps recurring under it (new rule version in the prompt)', () => {
    const t = lessonsSetup(opened);
    tasks(t, t.a.id, 10, 5); // 50 % before
    acceptFirst(t, t.a.id);
    tasks(t, t.a.id, 3, 3); // under v1: 3 of 3 (fewer than 5 tasks: not judged yet)
    const [s] = evaluateLessons(t, t.a.id);
    expect(s).toMatchObject({ action: 'strengthen', stats: { withRule: 3, withRuleHits: 3 } });
    expect(s!.text).toMatch(/^Important: /);
    const res = acceptFirst(t, t.a.id, 'strengthen');
    expect(res.rule).toMatchObject({ version: 2, strength: 2, status: 'active' });
    expect(workerPrompt(t, t.a.id)).toContain(`[${res.rule!.marker}.v2] Important: `);
    expect(workerPrompt(t, t.a.id)).not.toContain(`[${res.rule!.marker}.v1]`);
  });

  it('proposes a revert when the rate did not drop under the rule; accepting takes the rule out of the prompt', () => {
    const t = lessonsSetup(opened);
    tasks(t, t.a.id, 5, 3); // 60 % before
    const { rule } = acceptFirst(t, t.a.id);
    tasks(t, t.a.id, 5, 3); // 60 % under v1
    const eff = ruleEffect(t.store, rule!);
    expect(eff).toMatchObject({ withRule: 5, withRuleHits: 3, rateWithRule: 0.6, beforeRule: 5, beforeRuleHits: 3, rateBeforeRule: 0.6 });
    const markerVersions = eff.versions.filter((v) => v.ruleVersion === 1);
    expect(markerVersions).toHaveLength(1);
    expect(markerVersions[0]).toMatchObject({ tasks: 5, hits: 3, rate: 0.6 });
    const [r] = evaluateLessons(t, t.a.id);
    expect(r).toMatchObject({ action: 'revert', ruleId: rule!.id });
    acceptFirst(t, t.a.id, 'revert');
    expect(lessonRepos(t.store).rules.get(rule!.id)).toMatchObject({ status: 'reverted' });
    expect(workerPrompt(t, t.a.id)).not.toContain(rule!.marker);
  });

  it('proposes retirement after 10 clean tasks under the rule, not after 9', () => {
    const t = lessonsSetup(opened);
    tasks(t, t.a.id, 3, 3);
    const { rule } = acceptFirst(t, t.a.id);
    tasks(t, t.a.id, 9, 0);
    expect(evaluateLessons(t, t.a.id)).toEqual([]);
    tasks(t, t.a.id, 1, 0);
    const [r] = evaluateLessons(t, t.a.id);
    expect(r).toMatchObject({ action: 'retire', ruleId: rule!.id, stats: { cleanStreak: 10 } });
    acceptFirst(t, t.a.id, 'retire');
    expect(workerPrompt(t, t.a.id)).not.toContain(rule!.marker);
    expect(rulesWithEffect(t.store, t.a.id)[0]!.rule.status).toBe('retired');
  });

  it('a user can propose retiring any active rule; the accept still decides', () => {
    const t = lessonsSetup(opened);
    tasks(t, t.a.id, 3, 3);
    const { rule } = acceptFirst(t, t.a.id);
    expect(proposeRuleRetirement(t.store, rule!.id, t.b.id)).toBeUndefined(); // other tree
    const p = proposeRuleRetirement(t.store, rule!.id, t.a.id)!;
    expect(proposeRuleRetirement(t.store, rule!.id, t.a.id)!.id).toBe(p.id);
    expect(workerPrompt(t, t.a.id)).toContain(rule!.marker);
    acceptLessonProposalAsUser({ store: t.store, config: t.config }, t.a.id, p.id);
    expect(workerPrompt(t, t.a.id)).not.toContain(rule!.marker);
  });
});

describe('lessons off per run (experiments)', () => {
  it('withLessons("off") builds prompts without the rules, across awaits', async () => {
    const t = lessonsSetup(opened);
    tasks(t, t.a.id, 3, 3);
    const { rule } = acceptFirst(t, t.a.id);
    expect(workerPrompt(t, t.a.id)).toContain(rule!.marker);
    const off = await withLessons('off', async () => {
      await new Promise((r) => setTimeout(r, 1));
      return workerPrompt(t, t.a.id);
    });
    expect(off).not.toContain(rule!.marker);
    expect(workerPrompt(t, t.a.id)).toContain(rule!.marker);
  });
});
