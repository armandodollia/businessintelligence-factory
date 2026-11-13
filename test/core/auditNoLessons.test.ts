/**
 * Orchestrator ruling R5 (wave 2): reviewer audits run without lessons. The audit run is stored with
 * `lessons_off`, and its prompt leaves the reviewer's lesson rules out, so the auditor stays
 * independent of what the reviewer learned. The audited task keeps its lessons.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { LESSONS_HEADING } from '../../src/core/learning/lessons/appendix.js';
import { lessonRepos } from '../../src/core/learning/lessons/store.js';
import { runReviewerAudit } from '../../src/core/learning/reviewerAudit.js';
import { lessonsOff, runTags } from '../../src/core/learning/runTags.js';
import { runTaskWithReview } from '../../src/core/research/reviewLoop.js';
import type { Store } from '../../src/core/store/db.js';
import { newId } from '../../src/core/store/repos.js';
import { createWorkspace } from '../../src/core/workspace/tree.js';
import { addTask, researchSetup, review, submitWork } from './helpers/research.js';

const opened: Store[] = [];
afterEach(() => {
  for (const s of opened.splice(0)) s.close();
});

describe('R5: auditors run without lessons', () => {
  it('stores lessons_off on the audit run and builds its prompt without the reviewer rules', async () => {
    const s = researchSetup(opened, {
      pick: (r) => (r.kind === 'work' ? submitWork() : r.kind === 'review' || r.kind === 'audit' ? review(9) : undefined),
    });
    const ws = createWorkspace(s.store, { name: 'Acme', sector: 'saas' });
    const now = new Date().toISOString();
    lessonRepos(s.store).rules.insert({
      id: newId('lrule'), rootWorkspaceId: ws.id, role: 'reviewer', category: 'outcome:weak-review', marker: 'L-RVWR01', text: 'Judge only against the brief.',
      strength: 1, version: 1, status: 'active', source: 'engine', actor: 'local-user', createdAt: now, changedAt: now,
    });
    const task = await runTaskWithReview(addTask(s.store, { workspaceId: ws.id }), s.deps);
    const reviewReq = s.requests.find((r) => r.kind === 'review')!;
    expect(reviewReq.systemPrompt).toContain('L-RVWR01');

    const [audit] = await runReviewerAudit(s.deps, { workspaceId: ws.id });
    expect(audit).toMatchObject({ status: 'done', verdict: 'agree' });
    const auditReq = s.requests.find((r) => r.kind === 'audit')!;
    expect(auditReq.systemPrompt).not.toContain(LESSONS_HEADING);
    expect(auditReq.runTags).toMatchObject({ auditId: audit!.id, lessonsOff: true });
    expect(runTags(s.store, audit!.auditRunId!)).toMatchObject({ auditId: audit!.id, lessonsOff: true });
    expect(audit!.auditPromptVersion).not.toBe(reviewReq.promptVersion);

    // The audited task is not switched to lessons-off by its audit run.
    expect(lessonsOff(s.store, { taskId: task.id })).toBe(false);
  });
});
