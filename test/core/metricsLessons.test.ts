/**
 * Learning-loop wave 2 integration, wiring 4: the metrics report's WP-E slot carries the lessons
 * engine's `rulesWithEffect` — the effect per rule and per prompt version — for the business tree.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { acceptLessonProposalAsUser } from '../../src/core/feedback/actions.js';
import { evaluateLessons, rulesWithEffect } from '../../src/core/learning/lessons/engine.js';
import { lessonRepos } from '../../src/core/learning/lessons/store.js';
import { metricsReport } from '../../src/core/metrics/report.js';
import type { Store } from '../../src/core/store/db.js';
import { lessonsSetup } from './lessons/fixture.js';

const opened: Store[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const s of opened.splice(0)) s.close();
});

describe('metrics: lessons effect per rule and prompt version', () => {
  it('is the tree’s rulesWithEffect, also from a child node, never another tree', () => {
    const t = lessonsSetup(opened);
    expect(metricsReport(t.store, { workspaceId: t.a.id }).lessons).toEqual([]);
    for (let i = 0; i < 3; i++) t.issue(t.task(t.a.id), 'substantive');
    evaluateLessons(t, t.a.id);
    const p = lessonRepos(t.store).proposals.list({ rootWorkspaceId: t.a.id, status: 'pending' })[0]!;
    acceptLessonProposalAsUser({ store: t.store, config: t.config }, t.a.id, p.id);
    for (let i = 0; i < 2; i++) t.task(t.aChild.id); // under the rule

    const lessons = metricsReport(t.store, { workspaceId: t.aChild.id, scope: 'node' }).lessons!;
    const [expected] = rulesWithEffect(t.store, t.a.id);
    expect(lessons).toHaveLength(1);
    expect(lessons[0]).toEqual({
      ruleId: expected!.rule.id, marker: expected!.rule.marker, version: expected!.rule.version, role: 'worker',
      category: 'review:substantive:news_scan', label: 'review issues: substantive (news_scan)', status: 'active', text: expected!.rule.text,
      effect: expected!.effect,
    });
    // Per prompt version: the versions before the rule and the one carrying it.
    expect(lessons[0]!.effect.versions.some((v) => v.ruleVersion === 1 && v.tasks === 2)).toBe(true);
    expect(lessons[0]!.effect.versions.some((v) => v.ruleVersion === undefined && v.tasks === 3)).toBe(true);
    expect(metricsReport(t.store, { workspaceId: t.b.id }).lessons).toEqual([]);
  });
});
