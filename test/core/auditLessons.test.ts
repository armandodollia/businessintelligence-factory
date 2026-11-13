/**
 * Learning-loop wave 2 integration, wiring 2: WP-F reviewer-audit misses feed WP-E's lesson signals.
 * One path only: `collectLessonSignals` reads `auditMisses` directly (`audit:<class>` for the
 * reviewer). The `weak-review` outcome an audit miss writes is not counted again as an outcome signal,
 * and a repeated miss (the same review audited again) does not add a count.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { evaluateLessons } from '../../src/core/learning/lessons/engine.js';
import { collectLessonSignals } from '../../src/core/learning/lessons/signals.js';
import { lessonRepos } from '../../src/core/learning/lessons/store.js';
import { listOutcomes } from '../../src/core/learning/outcomes.js';
import { auditMisses, runReviewerAudit } from '../../src/core/learning/reviewerAudit.js';
import { runTaskWithReview } from '../../src/core/research/reviewLoop.js';
import type { Store } from '../../src/core/store/db.js';
import { createWorkspace } from '../../src/core/workspace/tree.js';
import { addTask, researchSetup, review, submitWork } from './helpers/research.js';

const opened: Store[] = [];
afterEach(() => {
  for (const s of opened.splice(0)) s.close();
});

describe('reviewer-audit misses are lesson signals', () => {
  it('count once per (class, task) as audit:<class> for the reviewer, never as a second outcome signal', async () => {
    const s = researchSetup(opened, {
      pick: (r) => {
        if (r.kind === 'audit') return review(3, [{ class: 'blocking', description: 'no dated source' }, { class: 'nit', description: 'typo' }]);
        if (r.kind === 'work') return submitWork();
        return r.kind === 'review' ? review(9) : undefined;
      },
    });
    const root = createWorkspace(s.store, { name: 'Acme', sector: 'saas' });
    const other = createWorkspace(s.store, { name: 'Globex', sector: 'saas' });
    const tasks = [];
    for (let i = 0; i < 3; i++) tasks.push(await runTaskWithReview(addTask(s.store, { workspaceId: root.id }), s.deps));
    await runTaskWithReview(addTask(s.store, { workspaceId: other.id }), s.deps);
    await runReviewerAudit(s.deps, { workspaceId: root.id, n: 3 });
    // The same review of the first task audited again: a second miss row for the same task.
    await runReviewerAudit(s.deps, { workspaceId: root.id, taskIds: [tasks[0]!.id] });
    expect(auditMisses(s.store, { rootWorkspaceId: root.id })).toHaveLength(4);
    expect(listOutcomes(s.store, { workspaceIds: [root.id], source: 'reviewer_audit' }).length).toBeGreaterThan(0);

    const signals = collectLessonSignals(s.store, root.id);
    const audit = signals.filter((x) => x.source === 'audit');
    const count = (category: string) => audit.filter((x) => x.category === category).map((x) => x.taskId).sort();
    const ids = tasks.map((t) => t.id).sort();
    expect(count('audit:blocking')).toEqual(ids);
    expect(count('audit:nit')).toEqual(ids);
    expect(audit.every((x) => x.role === 'reviewer')).toBe(true);
    // The audit's weak-review outcome is not a second path into lessons.
    expect(signals.filter((x) => x.category === 'outcome:weak-review')).toEqual([]);
    // Reading the signals again changes nothing.
    expect(collectLessonSignals(s.store, root.id).filter((x) => x.source === 'audit')).toHaveLength(audit.length);
    // Never across trees.
    expect(collectLessonSignals(s.store, other.id).filter((x) => x.source === 'audit')).toEqual([]);

    // The engine proposes reviewer rules from them, counting 3 tasks (not 4 misses).
    const proposals = evaluateLessons({ store: s.store, config: s.config }, root.id);
    const blocking = proposals.find((p) => p.category === 'audit:blocking');
    expect(blocking).toMatchObject({ role: 'reviewer', action: 'add', stats: { tasks: 3 } });
    expect(blocking!.text).toMatch(/before you pass work/i);
    expect(proposals.some((p) => p.category === 'outcome:weak-review')).toBe(false);
    expect(lessonRepos(s.store).signals.list({ rootWorkspaceId: root.id })).toEqual([]); // nothing recorded twice
  });
});
