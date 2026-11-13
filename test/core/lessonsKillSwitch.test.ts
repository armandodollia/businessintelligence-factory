/**
 * Orchestrator ruling R1 (wave 2): `lessons.enabled: false` also leaves ACCEPTED rules out of every
 * prompt (not only new proposals and the retro). The switch changes the role's prompt version, and
 * that version is recorded in the prompt store (`recordLessonsPromptVersions`, called at boot and by
 * `PUT /api/config` when the switch changes).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../src/api/routes.js';
import { acceptLessonProposalAsUser, rolePromptVersion } from '../../src/core/feedback/actions.js';
import { evaluateLessons } from '../../src/core/learning/lessons/engine.js';
import { lessonRepos } from '../../src/core/learning/lessons/store.js';
import { recordLessonsPromptVersions } from '../../src/core/learning/lessons/switch.js';
import { getPromptText } from '../../src/core/prompts/store.js';
import { reviewerSystemPrompt, workerSystemPrompt } from '../../src/core/research/systemPrompts.js';
import { calibrationScope } from '../../src/core/scoring/calibration.js';
import type { Store } from '../../src/core/store/db.js';
import { lessonsHarness, lessonsSetup } from './lessons/fixture.js';

const opened: Store[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const s of opened.splice(0)) s.close();
});

function withRule() {
  const t = lessonsSetup(opened);
  for (let i = 0; i < 3; i++) t.issue(t.task(t.a.id), 'substantive');
  evaluateLessons(t, t.a.id);
  const p = lessonRepos(t.store).proposals.list({ rootWorkspaceId: t.a.id, status: 'pending' })[0]!;
  const { rule } = acceptLessonProposalAsUser({ store: t.store, config: t.config }, t.a.id, p.id);
  return { ...t, rule: rule! };
}

describe('R1: lessons.enabled false is a kill switch for prompts too', () => {
  it('leaves accepted rules out of prompts and records the changed prompt version', () => {
    const t = withRule();
    const prompt = () => workerSystemPrompt(t.config, 'worker', false, 'news_scan', calibrationScope(t.store, t.config, t.a.id));
    const on = rolePromptVersion(t.config, 'worker', calibrationScope(t.store, t.config, t.a.id));
    expect(prompt()).toContain(t.rule.marker);

    t.config.lessons = { ...t.config.lessons, enabled: false };
    expect(prompt()).not.toContain(t.rule.marker);
    expect(reviewerSystemPrompt(t.config, calibrationScope(t.store, t.config, t.a.id))).not.toContain('## Lessons from past work');
    const recorded = recordLessonsPromptVersions(t.store, t.config);
    expect(recorded).toEqual([{ rootWorkspaceId: t.a.id, role: 'worker', promptVersion: expect.any(String) }]);
    const off = recorded[0]!.promptVersion;
    expect(off).not.toBe(on);
    expect(getPromptText(t.store, off)!.text).not.toContain(t.rule.marker);

    t.config.lessons = { ...t.config.lessons, enabled: true };
    expect(prompt()).toContain(t.rule.marker);
    expect(recordLessonsPromptVersions(t.store, t.config)[0]!.promptVersion).toBe(on);
    expect(getPromptText(t.store, on)!.text).toContain(t.rule.marker);
  });

  it('PUT /api/config that flips the switch records the new prompt version', async () => {
    const t = withRule();
    const h = lessonsHarness(t, () => undefined);
    const app = createApp({ store: t.store, artifacts: h.artifacts, events: h.events, config: t.config, research: h.deps });
    const off = structuredClone(t.config);
    off.lessons = { ...off.lessons, enabled: false };
    const res = await app.request('/api/config', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(off) });
    expect(res.status).toBe(200);
    const version = rolePromptVersion(t.config, 'worker', calibrationScope(t.store, t.config, t.a.id));
    expect(getPromptText(t.store, version)).toBeDefined();
    expect(getPromptText(t.store, version)!.text).not.toContain(t.rule.marker);
  });
});
