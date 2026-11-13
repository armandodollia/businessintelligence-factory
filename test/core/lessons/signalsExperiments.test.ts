/**
 * KS-8 (ruling R3 applied to lessons): signals from experiment arm runs and reviewer-audit runs are left
 * out of `collectLessonSignals` by default — ratings and feedback on their outputs, their failures,
 * policy denials and review issues — through WP-F's run / decision tags. `includeExperiments` keeps them.
 * Audit misses still reach lessons by their own path (`auditMisses`, about the audited normal task).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { recordFeedback } from '../../../src/core/feedback/events.js';
import { collectLessonSignals } from '../../../src/core/learning/lessons/signals.js';
import { tagRun } from '../../../src/core/learning/runTags.js';
import { recordPolicyEvent } from '../../../src/core/policy/policyEvents.js';
import type { Store } from '../../../src/core/store/db.js';
import { newId } from '../../../src/core/store/repos.js';
import type { AgentRun } from '../../../src/core/types.js';
import { lessonsSetup } from './fixture.js';

const opened: Store[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const s of opened.splice(0)) s.close();
});

describe('lesson signals leave experiment and audit runs out by default', () => {
  it('drops ratings, feedback, failures, policy denials and review issues of tagged runs and tasks', () => {
    const t = lessonsSetup(opened);
    const normal = t.task(t.a.id);
    const arm = t.task(t.a.id);
    // Make `arm` an experiment arm task: its runs carry the tag (as the insert trigger would set it).
    t.store.db.prepare("UPDATE tasks SET experiment_id = 'exp_1', arm = 'B' WHERE id = ?").run(arm.task.id);
    t.store.db.prepare("UPDATE agent_runs SET experiment_id = 'exp_1', arm = 'B', lessons_off = 1 WHERE task_id = ?").run(arm.task.id);
    // A reviewer-audit run of the normal task.
    const audit = t.run(t.a.id, { role: 'reviewer', taskId: normal.task.id, promptVersion: normal.reviewer.promptVersion! });
    tagRun(t.store, audit.id, { auditId: 'aud_1', lessonsOff: true });

    const decision = (run: AgentRun) =>
      t.store.decisions.insert({
        id: newId('dec'), workspaceId: t.a.id, agentRunId: run.id, role: run.role, model: run.model, kind: 'decision',
        payload: { tool: 'log_decision' }, refs: [], promptVersion: run.promptVersion ?? 'pv', createdAt: t.at(),
      });
    const signalsFor = (run: AgentRun, taskId: string) => {
      const d = decision(run);
      t.store.ratings.insert({
        id: newId('rat'), workspaceId: t.a.id, targetType: 'decision', targetId: d.id, criterion: 'confidence', agentValue: 0.9,
        verdict: 'disagree', userValue: 0.2, createdAt: t.at(), agentRunId: run.id,
      });
      recordFeedback(t.store, {
        workspaceId: t.a.id, kind: 'include_override', targetType: 'finding', targetId: newId('fnd'), afterJson: { include: false },
        agentRunId: run.id, promptVersion: run.promptVersion ?? 'pv',
      });
      recordPolicyEvent(t.store, { workspaceId: t.a.id, agentRunId: run.id, taskId, role: run.role, kind: 'blocked', action: 'expand', site: 'knowledge:out_of_slice' });
      t.store.db.prepare("UPDATE agent_runs SET status = 'failed', failure_reason = 'tool crashed' WHERE id = ?").run(run.id);
    };
    signalsFor(normal.worker, normal.task.id);
    signalsFor(arm.worker, arm.task.id);
    signalsFor(audit, normal.task.id);
    t.issue(arm, 'scope_expansion');
    t.issue(normal, 'scope_expansion');

    const sources = (opts?: { includeExperiments?: boolean }) =>
      collectLessonSignals(t.store, t.a.id, {}, t.config, opts).map((s) => `${s.source}|${s.agentRunId ?? s.taskId}`);

    const byDefault = sources();
    const wanted = ['rating', 'feedback', 'policy', 'failure'].map((src) => `${src}|${normal.worker.id}`);
    expect(byDefault).toEqual(expect.arrayContaining([...wanted, `review_issue|${normal.worker.id}`]));
    for (const run of [arm.worker, audit]) expect(byDefault.filter((s) => s.endsWith(`|${run.id}`))).toEqual([]);
    expect(collectLessonSignals(t.store, t.a.id, {}, t.config).filter((s) => s.taskId === arm.task.id)).toEqual([]);

    // Opt-in keeps them.
    const all = sources({ includeExperiments: true });
    for (const run of [arm.worker, audit]) {
      expect(all).toEqual(expect.arrayContaining(['rating', 'feedback', 'policy', 'failure'].map((src) => `${src}|${run.id}`)));
    }
    expect(all).toContain(`review_issue|${arm.worker.id}`);
  });

  it('drops a rating that names no run when it rates a tagged decision', () => {
    const t = lessonsSetup(opened);
    const x = t.task(t.a.id);
    const audit = t.run(t.a.id, { role: 'reviewer', taskId: x.task.id, promptVersion: 'pv' });
    tagRun(t.store, audit.id, { auditId: 'aud_2', lessonsOff: true });
    const d = t.store.decisions.insert({
      id: newId('dec'), workspaceId: t.a.id, agentRunId: audit.id, role: 'reviewer', model: audit.model, kind: 'decision',
      payload: { tool: 'log_decision' }, refs: [], promptVersion: 'pv', createdAt: t.at(),
    });
    // The rating names the normal worker run but rates the audit's decision.
    t.store.ratings.insert({
      id: newId('rat'), workspaceId: t.a.id, targetType: 'decision', targetId: d.id, criterion: 'confidence', agentValue: 0.9,
      verdict: 'disagree', userValue: 0.2, createdAt: t.at(), agentRunId: x.worker.id,
    });
    expect(collectLessonSignals(t.store, t.a.id, {}, t.config).filter((s) => s.source === 'rating')).toEqual([]);
    expect(collectLessonSignals(t.store, t.a.id, {}, t.config, { includeExperiments: true }).filter((s) => s.source === 'rating')).toHaveLength(1);
  });
});
