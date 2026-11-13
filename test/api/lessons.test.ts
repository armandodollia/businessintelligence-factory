import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../src/api/routes.js';
import { listFeedback } from '../../src/core/feedback/events.js';
import { lessonRepos } from '../../src/core/learning/lessons/store.js';
import { workerSystemPrompt } from '../../src/core/research/systemPrompts.js';
import { calibrationScope } from '../../src/core/scoring/calibration.js';
import type { Store } from '../../src/core/store/db.js';
import { lessonsHarness, lessonsSetup } from '../core/lessons/fixture.js';

const opened: Store[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const s of opened.splice(0)) s.close();
});

function setup() {
  const t = lessonsSetup(opened, (c) => (c.user = { id: 'dana' }));
  const h = lessonsHarness(t, () => undefined);
  const app = createApp({ store: t.store, artifacts: h.artifacts, events: h.events, config: t.config, research: h.deps });
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await app.request(path, { method, headers: { 'content-type': 'application/json' }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    return { status: res.status, body: (await res.json()) as any };
  };
  for (let i = 0; i < 3; i++) t.issue(t.task(i === 1 ? t.aChild.id : t.a.id), 'blocking', `missing criterion ${i}`);
  return { ...t, call };
}

describe('lessons API (WP-E)', () => {
  it('evaluate → page → accept: the actor comes from config, never the body; the rule shows with its effect', async () => {
    const t = setup();
    const ev = await t.call('POST', `/api/workspaces/${t.aChild.id}/lessons/evaluate`, {});
    expect(ev.status).toBe(200);
    expect(ev.body.proposals).toHaveLength(1);
    const pid = ev.body.proposals[0].id as string;

    const page = await t.call('GET', `/api/workspaces/${t.a.id}/lessons`);
    expect(page.body).toMatchObject({ rootWorkspaceId: t.a.id, settings: { enabled: true, maxRulesPerRole: 15, retro: { cron: '0 6 * * 1' } }, rules: [] });
    expect(page.body.proposals.map((p: any) => [p.id, p.status])).toEqual([[pid, 'pending']]);
    expect(page.body.roles).toEqual([{ role: 'worker', active: 0, pending: 1, cap: 15 }]);

    const acc = await t.call('POST', `/api/workspaces/${t.a.id}/lessons/proposals/${pid}/accept`, { reason: 'yes', actor: 'mallory' });
    expect(acc.status).toBe(200);
    expect(acc.body.rule.actor).toBe('dana');
    expect(listFeedback(t.store, { kind: 'lesson_accept' })[0]).toMatchObject({ actor: 'dana', reason: 'yes' });
    expect(workerSystemPrompt(t.config, 'worker', false, 'news_scan', calibrationScope(t.store, t.dir, t.a.id))).toContain(acc.body.rule.marker);

    const after = await t.call('GET', `/api/workspaces/${t.a.id}/lessons`);
    expect(after.body.rules).toHaveLength(1);
    expect(after.body.rules[0]).toMatchObject({ rule: { id: acc.body.rule.id, status: 'active' }, effect: { beforeRule: 3, beforeRuleHits: 3, withRule: 0 } });
    expect((await t.call('POST', `/api/workspaces/${t.a.id}/lessons/proposals/${pid}/accept`, {})).status).toBe(409);

    // Propose taking it out, then reject that proposal: the rule stays.
    const pr = await t.call('POST', `/api/workspaces/${t.a.id}/lessons/rules/${acc.body.rule.id}/propose-retire`, {});
    expect(pr.body).toMatchObject({ action: 'retire', status: 'pending' });
    const rej = await t.call('POST', `/api/workspaces/${t.a.id}/lessons/proposals/${pr.body.id}/reject`, {});
    expect(rej.status).toBe(200);
    expect(listFeedback(t.store, { kind: 'lesson_reject' })[0]).toMatchObject({ actor: 'dana', targetId: pr.body.id });
    expect(lessonRepos(t.store).rules.get(acc.body.rule.id)!.status).toBe('active');
  });

  it('isolates business trees: another tree sees nothing and gets 404 for a proposal or rule of this one', async () => {
    const t = setup();
    const ev = await t.call('POST', `/api/workspaces/${t.a.id}/lessons/evaluate`, {});
    const pid = ev.body.proposals[0].id as string;
    const other = await t.call('GET', `/api/workspaces/${t.b.id}/lessons`);
    expect(other.body).toMatchObject({ rootWorkspaceId: t.b.id, proposals: [], rules: [] });
    expect((await t.call('POST', `/api/workspaces/${t.b.id}/lessons/proposals/${pid}/accept`, {})).status).toBe(404);
    expect((await t.call('POST', `/api/workspaces/${t.b.id}/lessons/proposals/${pid}/reject`, {})).status).toBe(404);
    expect((await t.call('POST', `/api/workspaces/${t.b.id}/lessons/rules/lrule_x/propose-retire`, {})).status).toBe(404);
    expect((await t.call('GET', '/api/workspaces/ws_missing/lessons')).status).toBe(404);
    expect(lessonRepos(t.store).proposals.get(pid)!.status).toBe('pending');
  });

  it('starts a retro in the background (202), or 409 when the retro is disabled', async () => {
    const t = setup();
    const res = await t.call('POST', `/api/workspaces/${t.b.id}/lessons/retro`, {});
    expect(res.status).toBe(202);
    for (let i = 0; i < 50 && !lessonRepos(t.store).retros.list().length; i++) await new Promise((r) => setTimeout(r, 5));
    expect(lessonRepos(t.store).retros.list()).toEqual([expect.objectContaining({ rootWorkspaceId: t.b.id, status: 'skipped', triggeredBy: 'user' })]);
    t.config.lessons = { retro: { enabled: false } };
    expect((await t.call('POST', `/api/workspaces/${t.b.id}/lessons/retro`, {})).status).toBe(409);
  });
});
