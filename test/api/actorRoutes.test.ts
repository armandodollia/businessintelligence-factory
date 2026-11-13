/**
 * Opus finding 5 (final gate): every human action records its actor (`config.user.id`), never from the
 * body. Updating an audit schedule, requesting a rule's retirement and running the lessons engine go
 * through `feedback/actions.ts` and write a feedback event with the configured actor.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../src/api/routes.js';
import { listFeedback } from '../../src/core/feedback/events.js';
import { createAuditSchedule } from '../../src/core/learning/reviewerAudit.js';
import type { Store } from '../../src/core/store/db.js';
import { lessonsHarness, lessonsSetup } from '../core/lessons/fixture.js';

const opened: Store[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const s of opened.splice(0)) s.close();
});

function setup() {
  const t = lessonsSetup(opened, (c) => (c.user = { id: 'erin' }));
  const h = lessonsHarness(t, () => undefined);
  const app = createApp({ store: t.store, artifacts: h.artifacts, events: h.events, config: t.config, research: h.deps });
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await app.request(path, { method, headers: { 'content-type': 'application/json' }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    return { status: res.status, body: (await res.json()) as any };
  };
  for (let i = 0; i < 3; i++) t.issue(t.task(t.a.id), 'blocking', `missing criterion ${i}`);
  return { ...t, call };
}

describe('human actions record the configured actor (Opus 5)', () => {
  it('POST /api/audit-schedules/:id writes an audit_schedule_change event with before / after', async () => {
    const t = setup();
    const s = createAuditSchedule(t.store, { workspaceId: t.a.id, cron: '0 3 * * 1', n: 2, actor: 'erin' });
    expect((await t.call('POST', `/api/audit-schedules/${s.id}`, { enabled: false, n: 4 })).status).toBe(200);
    const [ev] = listFeedback(t.store, { kind: 'audit_schedule_change' });
    expect(ev).toMatchObject({
      actor: 'erin', targetType: 'audit_schedule', targetId: s.id, workspaceId: t.a.id,
      beforeJson: { enabled: true, cron: '0 3 * * 1', n: 2 }, afterJson: { enabled: false, cron: '0 3 * * 1', n: 4 },
    });
  });

  it('lessons evaluate and propose-retire write lessons_evaluate / lesson_retire_request events', async () => {
    const t = setup();
    const ev = await t.call('POST', `/api/workspaces/${t.a.id}/lessons/evaluate`, {});
    expect(ev.status).toBe(200);
    expect(listFeedback(t.store, { kind: 'lessons_evaluate' })[0]).toMatchObject({
      actor: 'erin', targetType: 'lessons', targetId: t.a.id, afterJson: { proposalIds: ev.body.proposals.map((p: { id: string }) => p.id) },
    });
    const pid = ev.body.proposals[0].id as string;
    const acc = await t.call('POST', `/api/workspaces/${t.a.id}/lessons/proposals/${pid}/accept`, {});
    const pr = await t.call('POST', `/api/workspaces/${t.a.id}/lessons/rules/${acc.body.rule.id}/propose-retire`, {});
    expect(pr.status).toBe(200);
    expect(listFeedback(t.store, { kind: 'lesson_retire_request' })[0]).toMatchObject({
      actor: 'erin', targetType: 'lesson', targetId: pr.body.id, afterJson: { ruleId: acc.body.rule.id },
    });
  });
});
