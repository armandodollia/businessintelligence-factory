import { afterEach, describe, expect, it, vi } from 'vitest';
import { recordFeedback } from '../../../src/core/feedback/events.js';
import { evaluateLessons } from '../../../src/core/learning/lessons/engine.js';
import { collectLessonSignals, failureClass, policyActionKey, recordLessonSignal } from '../../../src/core/learning/lessons/signals.js';
import { recordOutcome } from '../../../src/core/learning/outcomes.js';
import { recordRetrieval } from '../../../src/core/knowledge/retrievalLog.js';
import { recordPolicyEvent } from '../../../src/core/policy/policyEvents.js';
import type { Store } from '../../../src/core/store/db.js';
import { newId } from '../../../src/core/store/repos.js';
import { usageRepos } from '../../../src/core/store/usageRepos.js';
import { lessonsSetup } from './fixture.js';

const opened: Store[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const s of opened.splice(0)) s.close();
});

const cats = (t: ReturnType<typeof lessonsSetup>, ws: string) =>
  collectLessonSignals(t.store, ws, {}, t.config).map((s) => `${s.role}|${s.category}|${s.unit}`);

describe('lesson signals (one business tree, every source)', () => {
  it('maps review issues, outcomes, failures, policy denials, feedback and ratings to role + category + task', () => {
    const t = lessonsSetup(opened);
    const x = t.task(t.aChild.id);
    t.issue(x, 'scope_expansion');
    // Outcome (negative label) on the worker's decision.
    const d = t.store.decisions.insert({
      id: newId('dec'), workspaceId: t.aChild.id, agentRunId: x.worker.id, role: 'worker', model: x.worker.model, kind: 'decision',
      payload: { tool: 'submit_result' }, refs: [], promptVersion: x.worker.promptVersion!, createdAt: t.at(),
    });
    recordOutcome(t.store, { decisionId: d.id, outcome: 'unverified', label: 'missed-evidence', source: 'review_loop', taskId: x.task.id });
    recordOutcome(t.store, { decisionId: d.id, outcome: 'verified', label: 'confirmed', source: 'review_loop', taskId: x.task.id }); // not a lesson
    // Failures: an idle timeout is a lesson; a rate limit is infrastructure.
    t.run(t.a.id, { role: 'orchestrator', status: 'failed', failureReason: 'idle timeout: no output for 5000 ms' });
    t.run(t.a.id, { role: 'orchestrator', status: 'failed', failureReason: 'rate limited; gave up after 3 attempts' });
    usageRepos(t.store).agentRunAttempts.insert({
      id: newId('att'), workspaceId: t.aChild.id, runId: x.worker.id, attempt: 1, startedAt: t.at(), endedAt: t.at(), exitCode: 1, rateLimited: false,
      failureReason: 'tool crashed',
    });
    // Policy: a configured action and a free-text one (never a category part); out-of-tree blocks are left out.
    t.config.actionPolicy.approvalRequired = ['request a demo'];
    recordPolicyEvent(t.store, { workspaceId: t.a.id, agentRunId: x.worker.id, taskId: x.task.id, role: 'worker', kind: 'approval_denied', action: 'Request a demo from Acme sales' });
    recordPolicyEvent(t.store, { workspaceId: t.a.id, agentRunId: x.worker.id, taskId: x.task.id, role: 'worker', kind: 'approval_denied', action: 'call the CFO at home' });
    recordPolicyEvent(t.store, { workspaceId: t.a.id, agentRunId: x.worker.id, role: 'worker', kind: 'blocked', action: 'expand', site: 'knowledge:out_of_tree' });
    // Human feedback on the worker's output, and a rating disagreement.
    recordFeedback(t.store, { workspaceId: t.aChild.id, kind: 'include_override', targetType: 'finding', targetId: 'fnd_1', afterJson: { include: false }, agentRunId: x.worker.id, promptVersion: x.worker.promptVersion! });
    recordFeedback(t.store, { workspaceId: t.aChild.id, kind: 'include_override', targetType: 'finding', targetId: 'fnd_2', afterJson: { include: true }, agentRunId: x.worker.id, promptVersion: x.worker.promptVersion! });
    t.store.ratings.insert({
      id: newId('rat'), workspaceId: t.aChild.id, targetType: 'finding', targetId: 'fnd_1', criterion: 'impact', agentValue: 2, verdict: 'disagree', userValue: 4,
      createdAt: t.at(), agentRunId: x.worker.id,
    });
    // Another tree's signals never appear.
    const y = t.task(t.b.id);
    t.issue(y, 'nit');

    const got = cats(t, t.a.id);
    const tk = x.task.id;
    expect(got).toEqual(expect.arrayContaining([
      `worker|review:scope_expansion:news_scan|${tk}`,
      `worker|outcome:missed-evidence|${tk}`,
      `worker|failure:error|${tk}`,
      `worker|policy:approval_denied:request_a_demo|${tk}`,
      `worker|policy:approval_denied:other|${tk}`,
      `worker|feedback:exclude:finding|${tk}`,
      `worker|rating:finding:impact|${tk}`,
    ]));
    expect(got.filter((c) => c.startsWith('orchestrator|failure:timeout'))).toHaveLength(1);
    expect(got.join('\n')).not.toMatch(/confirmed|rate_limited|out_of_tree|CFO|nit/);
    expect(cats(t, t.b.id)).toEqual([`worker|review:nit:news_scan|${y.task.id}`]);
  });

  it('knowledge signals: a rate kind counts only at a rate of at least 0.5', () => {
    const t = lessonsSetup(opened);
    const xs = [t.task(t.a.id), t.task(t.a.id), t.task(t.a.id)];
    for (const x of xs) {
      recordRetrieval({ store: t.store }, { workspaceId: t.a.id, agentRunId: x.worker.id, taskId: x.task.id, role: 'worker', promptVersion: x.worker.promptVersion! }, {
        tool: 'search', query: 'q', scope: 'node', results: [], tokensReturned: 5, latencyMs: 1, uploadDerived: false,
      });
    }
    expect(cats(t, t.a.id).filter((c) => c.includes('knowledge:zero_result'))).toHaveLength(3);
    const [p] = evaluateLessons(t, t.a.id);
    expect(p).toMatchObject({ category: 'knowledge:zero_result', role: 'worker' });
    expect(p!.text).toMatch(/fewer, broader terms/);
  });

  it('classifies failures and keeps free-text policy actions out of categories', () => {
    expect(failureClass('idle timeout: no activity for 100 ms')).toBe('timeout');
    expect(failureClass('rate limited; gave up after 3 attempts')).toBe('rate_limited');
    expect(failureClass('aborted')).toBe('interrupted');
    expect(failureClass('run failed (exit 1; boom)')).toBe('error');
    const cfg = { actionPolicy: { allowed: [], approvalRequired: ['payment entry'], never: [] } };
    expect(policyActionKey('save_finding', cfg)).toBe('save_finding');
    expect(policyActionKey('Payment entry on checkout page', cfg)).toBe('payment_entry');
    expect(policyActionKey('quote the private memo', cfg)).toBe('other');
  });
});

describe('recordLessonSignal (WP-F reviewer-audit misses and other packages)', () => {
  it('is idempotent per source + key, stays in its tree, and feeds the engine like any signal', () => {
    const t = lessonsSetup(opened);
    const xs = [t.task(t.a.id), t.task(t.aChild.id), t.task(t.a.id)];
    const other = t.task(t.b.id);
    const rec = (i: number) =>
      recordLessonSignal(t.store, { workspaceId: t.a.id, role: 'reviewer', category: 'audit:missed_issue', source: 'reviewer_audit', sourceKey: `aud_${i}`, taskId: xs[i]!.task.id, note: `missed: claim ${i} unsupported` });
    const first = rec(0);
    expect(rec(0).id).toBe(first.id);
    expect(() => recordLessonSignal(t.store, { workspaceId: t.a.id, role: 'reviewer', category: 'audit:missed_issue', source: 'x', taskId: other.task.id })).toThrow(/not found/);
    expect(() => recordLessonSignal(t.store, { workspaceId: t.a.id, role: 'reviewer', category: 'Bad Category', source: 'x' })).toThrow(/invalid/);
    expect(() => recordLessonSignal(t.store, { workspaceId: t.a.id, role: 'nobody' as never, category: 'audit:x', source: 'x' })).toThrow(/unknown role/);
    rec(1);
    expect(evaluateLessons(t, t.a.id)).toEqual([]);
    rec(2);
    const [p] = evaluateLessons(t, t.a.id);
    expect(p).toMatchObject({ role: 'reviewer', category: 'audit:missed_issue', action: 'add', stats: { tasks: 3 } });
    expect(p!.text).not.toContain('claim'); // the note is never rule text
    expect(p!.evidence.some((e) => e.quote?.startsWith('missed: claim'))).toBe(true);
    expect(evaluateLessons(t, t.b.id)).toEqual([]);
  });
});
