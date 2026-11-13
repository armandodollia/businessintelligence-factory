/**
 * Learning-loop wave 2 integration, wiring 1: prompt assembly reads the STORED lessons-off flag
 * (WP-F `lessonsOff`: experiment task tag / `agent_runs.lessons_off`), so a run keeps lessons off after
 * a restart or resume. `withLessons('off', fn)` (WP-E) is only a convenience that marks the runs it
 * starts with the stored flag.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { LESSONS_HEADING } from '../../src/core/learning/lessons/appendix.js';
import { withLessons } from '../../src/core/learning/lessons/mode.js';
import { lessonRepos } from '../../src/core/learning/lessons/store.js';
import { runTags } from '../../src/core/learning/runTags.js';
import { runTaskWithReview } from '../../src/core/research/reviewLoop.js';
import type { Store } from '../../src/core/store/db.js';
import { newId } from '../../src/core/store/repos.js';
import { createWorkspace } from '../../src/core/workspace/tree.js';
import { addTask, researchSetup, review, submitWork, type Picker } from './helpers/research.js';

const opened: Store[] = [];
afterEach(() => {
  for (const s of opened.splice(0)) s.close();
});

const pick: Picker = (r) => (r.kind === 'work' ? submitWork() : r.kind === 'review' ? review(9) : undefined);

/** Active worker + reviewer rules in the tree of `root`. */
function rules(store: Store, root: string): void {
  const now = new Date().toISOString();
  for (const role of ['worker', 'reviewer'] as const) {
    lessonRepos(store).rules.insert({
      id: newId('lrule'), rootWorkspaceId: root, role, category: `review:substantive:${role}`, marker: `L-${role === 'worker' ? 'WWWWW1' : 'RRRRR1'}`,
      text: `Cite a source (${role}).`, strength: 1, version: 1, status: 'active', source: 'engine', actor: 'local-user', createdAt: now, changedAt: now,
    });
  }
}

const systemPrompts = (s: ReturnType<typeof researchSetup>, taskId: string) =>
  s.requests.filter((r) => r.task?.id === taskId).map((r) => [r.kind, r.systemPrompt.includes(LESSONS_HEADING)] as const);

describe('lessons off is read from the store by prompt assembly', () => {
  it('an experiment arm task gets no lessons in any prompt, with no in-memory context (restart / resume)', async () => {
    const s = researchSetup(opened, { pick });
    const ws = createWorkspace(s.store, { name: 'Acme', sector: 'saas' });
    rules(s.store, ws.id);
    const normal = await runTaskWithReview(addTask(s.store, { workspaceId: ws.id }), s.deps);
    expect(systemPrompts(s, normal.id)).toEqual([['work', true], ['review', true]]);

    // An arm task as a fresh process sees it: only the stored tag says it is an experiment.
    const arm = addTask(s.store, { workspaceId: ws.id });
    s.store.db.prepare("UPDATE tasks SET experiment_id = 'exp_x', arm = 'A' WHERE id = ?").run(arm.id);
    await runTaskWithReview(arm, s.deps);
    expect(systemPrompts(s, arm.id)).toEqual([['work', false], ['review', false]]);
    for (const r of s.store.agentRuns.list({ taskId: arm.id })) expect(runTags(s.store, r.id)?.lessonsOff).toBe(true);
  });

  it('withLessons("off") stores the flag on its runs; a resumed task in a new process keeps lessons off', async () => {
    const s = researchSetup(opened, { pick });
    const ws = createWorkspace(s.store, { name: 'Acme', sector: 'saas' });
    rules(s.store, ws.id);
    const task = addTask(s.store, { workspaceId: ws.id });
    await withLessons('off', () => runTaskWithReview(task, s.deps));
    expect(systemPrompts(s, task.id)).toEqual([['work', false], ['review', false]]);
    const first = s.store.agentRuns.list({ taskId: task.id });
    for (const r of first) expect(runTags(s.store, r.id)?.lessonsOff).toBe(true);

    // Restart: a new process on the same database requeues the task and runs it outside any context.
    const again = researchSetup(opened, { dir: s.dir, pick });
    again.store.tasks.update(task.id, { status: 'queued' });
    await runTaskWithReview(again.store.tasks.get(task.id)!, again.deps);
    // The review loop continues from the stored deliverable: the resumed step is the review.
    expect(systemPrompts(again, task.id)).toEqual([['review', false]]);
    const resumed = again.store.agentRuns.list({ taskId: task.id }).filter((r) => !first.some((f) => f.id === r.id));
    expect(resumed.length).toBe(1);
    for (const r of resumed) expect(runTags(again.store, r.id)?.lessonsOff).toBe(true);

    // Another task of the same tree, outside the context, still gets the rules.
    const other = await runTaskWithReview(addTask(again.store, { workspaceId: ws.id }), again.deps);
    expect(systemPrompts(again, other.id)).toEqual([['work', true], ['review', true]]);
  });
});
