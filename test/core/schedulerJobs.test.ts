/**
 * Learning-loop wave 2 integration, wiring 3: one scheduler hook. The weekly retro (WP-E) and the
 * reviewer-audit schedules (WP-F) are both `ScheduledJobSource`s, registered as the scheduler's
 * built-in job sources; `startScheduler(deps)` runs both with no extra option.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { retroJobSource } from '../../src/core/learning/lessons/retro.js';
import { lessonRepos } from '../../src/core/learning/lessons/store.js';
import { createAuditSchedule, listAudits } from '../../src/core/learning/reviewerAudit.js';
import { runTaskWithReview } from '../../src/core/research/reviewLoop.js';
import { builtInJobSources } from '../../src/core/scheduler/jobSources.js';
import { startScheduler } from '../../src/core/scheduler/scheduler.js';
import type { Store } from '../../src/core/store/db.js';
import { createWorkspace } from '../../src/core/workspace/tree.js';
import { addTask, researchSetup, review, submitWork } from './helpers/research.js';

const opened: Store[] = [];
afterEach(() => {
  for (const s of opened.splice(0)) s.close();
});

describe('one scheduler mechanism for non-pipeline jobs', () => {
  it('registers the retro and the audit schedules as job sources and runs each once per occurrence', async () => {
    const s = researchSetup(opened, {
      config: (c) => (c.lessons = { retro: { cron: '* * * * *' } }),
      pick: (r) => (r.kind === 'work' ? submitWork() : r.kind === 'review' || r.kind === 'audit' ? review(9) : undefined),
    });
    expect(builtInJobSources(s.deps).map((x) => x.name)).toEqual(['reviewer-audit', 'retro']);
    const root = createWorkspace(s.store, { name: 'Acme', sector: 'saas' });
    await runTaskWithReview(addTask(s.store, { workspaceId: root.id }), s.deps);
    createAuditSchedule(s.store, { workspaceId: root.id, cron: '* * * * *', n: 1 });
    expect(retroJobSource(s.deps).list().map((j) => j.id)).toEqual([root.id]);

    let now = Date.now();
    const handle = startScheduler({ ...s.deps, intervalMs: 3_600_000 }, () => now);
    try {
      await handle.idle();
      expect(lessonRepos(s.store).retros.list()).toHaveLength(0);
      now += 61_000;
      await handle.tick();
      await handle.idle();
      await handle.tick(); // same occurrence: nothing runs twice
      await handle.idle();
      expect(lessonRepos(s.store).retros.list({ rootWorkspaceId: root.id })).toHaveLength(1);
      expect(listAudits(s.store, { rootWorkspaceId: root.id })).toHaveLength(1);
      now += 61_000;
      await handle.tick();
      await handle.idle();
      expect(lessonRepos(s.store).retros.list({ rootWorkspaceId: root.id })).toHaveLength(2);
    } finally {
      handle.stop();
    }
    s.config.lessons = { retro: { enabled: false } };
    expect(retroJobSource(s.deps).list()).toEqual([]);
  });
});
