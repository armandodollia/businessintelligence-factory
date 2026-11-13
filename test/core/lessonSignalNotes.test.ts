/**
 * Orchestrator ruling R2 (wave 2): a `recordLessonSignal` note needs provenance. Without a task, run or
 * ref id only the category is kept (the note text is dropped); with ids, the note is kept only when
 * none of them is upload-derived or upload-exposed (the export's rule, `LessonPrivacy`).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { recordRetrieval } from '../../src/core/knowledge/retrievalLog.js';
import { collectLessonSignals, recordLessonSignal } from '../../src/core/learning/lessons/signals.js';
import { lessonRepos } from '../../src/core/learning/lessons/store.js';
import type { Store } from '../../src/core/store/db.js';
import { newId } from '../../src/core/store/repos.js';
import { lessonsSetup } from './lessons/fixture.js';

const opened: Store[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const s of opened.splice(0)) s.close();
});

describe('R2: lesson-signal notes need provenance', () => {
  it('drops an id-less note, and a note resting on an upload-exposed task or run; keeps a clean one', () => {
    const t = lessonsSetup(opened);
    const clean = t.task(t.a.id);
    const exposed = t.task(t.a.id);
    recordRetrieval({ store: t.store }, { workspaceId: t.a.id, agentRunId: exposed.worker.id, taskId: exposed.task.id, role: 'worker' }, {
      tool: 'read_artifact', query: 'x', scope: 'node', results: [{ id: 'art_up', kind: 'artifact' }], tokensReturned: 10, latencyMs: 1, uploadDerived: true,
    });
    const base = { workspaceId: t.a.id, role: 'reviewer' as const, category: 'audit:missed_issue', source: 'test' };
    const bare = recordLessonSignal(t.store, { ...base, sourceKey: 'bare', note: 'BARE NOTE' });
    const onExposedTask = recordLessonSignal(t.store, { ...base, sourceKey: 'task', taskId: exposed.task.id, note: 'EXPOSED TASK NOTE' });
    const onExposedRun = recordLessonSignal(t.store, { ...base, sourceKey: 'run', agentRunId: exposed.worker.id, note: 'EXPOSED RUN NOTE' });
    const viaRef = recordLessonSignal(t.store, { ...base, sourceKey: 'ref', refId: exposed.worker.id, note: 'EXPOSED REF NOTE' });
    const ok = recordLessonSignal(t.store, { ...base, sourceKey: 'ok', taskId: clean.task.id, note: 'clean note' });

    for (const r of [bare, onExposedTask, onExposedRun, viaRef]) {
      expect(r.note, r.sourceKey).toBeUndefined();
      expect(r.category).toBe('audit:missed_issue');
    }
    expect(ok.note).toBe('clean note');

    // A row stored without ids by older code keeps only its category when collected.
    lessonRepos(t.store).signals.insert({
      id: newId('lsig'), workspaceId: t.a.id, rootWorkspaceId: t.a.id, role: 'reviewer', category: 'audit:legacy', source: 'old', note: 'LEGACY NOTE',
      createdAt: new Date().toISOString(),
    });
    const recorded = collectLessonSignals(t.store, t.a.id).filter((s) => s.source === 'recorded');
    expect(recorded.map((s) => s.category).sort()).toEqual([...Array(5).fill('audit:missed_issue'), 'audit:legacy'].sort());
    expect(recorded.filter((s) => s.text).map((s) => s.text)).toEqual(['clean note']);
    expect(JSON.stringify(recorded)).not.toMatch(/BARE|EXPOSED|LEGACY/);
  });
});
