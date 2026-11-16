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
  const app = createApp({ store: t.store, artifacts: h.artifacts, events: h.events, config: t.config, research: h.deps, interviewFake: async () => 'Thanks.' });
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

// ---------------------------------------------------------------------------
// Re-gate (Opus 4): every mutating route records its actor. The table names, for each route of the real
// app, how: proven in this file, proven by another test file (which must mention the route), or exempt
// (with the reason). A new mutating route fails the enumeration until it is added here.

const HERE = 'test/api/actorRoutes.test.ts';
const ROUTES: Record<string, { test: string } | { exempt: string }> = {
  'POST /api/workspaces': { test: HERE },
  'POST /api/workspaces/:id/interview': { test: HERE },
  'POST /api/workspaces/:id/uploads': { test: HERE },
  'POST /api/workspaces/:id/research': { test: HERE },
  'POST /api/workspaces/:id/schedules': { test: HERE },
  'PATCH /api/workspaces/:id/schedules': { test: HERE },
  'PUT /api/config': { test: HERE },
  'POST /api/workspaces/:id/lessons/retro': { test: HERE },
  'POST /api/audit-schedules/:id': { test: HERE },
  'POST /api/workspaces/:id/lessons/evaluate': { test: HERE },
  'POST /api/workspaces/:id/lessons/rules/:rid/propose-retire': { test: HERE },
  'POST /api/workspaces/:id/calibration/prompt-patch': { exempt: 'computes a proposal and writes nothing; applying it is the actored route below' },
  'POST /api/unit-proposals/:id': { test: 'test/api/feedbackRoutes.test.ts' },
  'POST /api/findings/:id/include': { test: 'test/api/feedbackRoutes.test.ts' },
  'POST /api/recommendations/:id/include': { test: HERE },
  'POST /api/personas/:id/include': { test: HERE },
  'POST /api/competitors/:id/include': { test: HERE },
  'POST /api/hypotheses/:id/include': { test: 'test/api/feedbackRoutes.test.ts' },
  'POST /api/hypotheses/:id/correct': { test: 'test/api/feedbackRoutes.test.ts' },
  'PATCH /api/workspaces/:id/profile': { test: 'test/api/feedbackRoutes.test.ts' },
  'POST /api/requests/:id': { test: 'test/api/feedbackRoutes.test.ts' },
  'POST /api/ratings': { test: 'test/api/feedbackRoutes.test.ts' },
  'PUT /api/workspaces/:id/scoring-weights': { test: 'test/api/feedbackRoutes.test.ts' },
  'POST /api/workspaces/:id/calibration/prompt-patch/apply': { test: 'test/api/usageRoutes.test.ts' },
  'POST /api/workspaces/:id/calibration/versions/:versionId/revert': { test: 'test/api/usageRoutes.test.ts' },
  'POST /api/requests/:id/escalation-answer': { test: 'test/api/oversight.test.ts' },
  'POST /api/workspaces/:id/knowledge/merge-suggestions/:sid/accept': { test: 'test/api/knowledgeRoutes.test.ts' },
  'POST /api/workspaces/:id/knowledge/merge-suggestions/:sid/reject': { test: 'test/api/knowledgeRoutes.test.ts' },
  'POST /api/workspaces/:id/knowledge/entities/merge': { test: 'test/api/knowledgeRoutes.test.ts' },
  'POST /api/workspaces/:id/knowledge/entities/:entityId/rename': { test: 'test/api/knowledgeRoutes.test.ts' },
  'POST /api/workspaces/:id/knowledge/facts/:factId/retract': { test: 'test/api/knowledgeRoutes.test.ts' },
  'PUT /api/workspaces/:id/knowledge/facts/:factId/scopes': { test: 'test/api/knowledgeRoutes.test.ts' },
  'POST /api/workspaces/:id/knowledge/facts/:factId/accept-replacement': { test: 'test/api/knowledgeRoutes.test.ts' },
  'POST /api/workspaces/:id/knowledge/gc/prune': { test: 'test/api/knowledgeRoutes.test.ts' },
  'POST /api/workspaces/:id/lessons/proposals/:pid/accept': { test: 'test/api/lessons.test.ts' },
  'POST /api/workspaces/:id/lessons/proposals/:pid/reject': { test: 'test/api/lessons.test.ts' },
  'POST /api/workspaces/:id/audits': { test: 'test/api/experimentRoutes.test.ts' },
  'POST /api/workspaces/:id/audit-schedules': { test: 'test/api/experimentRoutes.test.ts' },
  'POST /api/workspaces/:id/experiments': { test: 'test/api/experimentRoutes.test.ts' },
  // flow records and ranking
  'POST /api/workspaces/:id/flows/verdicts/:verdictId/reaction': { test: 'test/api/flowRoutes.test.ts' },
  'POST /api/workspaces/:id/flows/:flowId/reaction': { test: 'test/api/flowRoutes.test.ts' },
  'POST /api/workspaces/:id/flows/overrides': { test: 'test/api/flowRoutes.test.ts' },
  'DELETE /api/workspaces/:id/flows/overrides/:overrideId': { test: 'test/api/flowRoutes.test.ts' },
  'POST /api/workspaces/:id/flows/overrides/:overrideId/confirm': { test: 'test/api/flowRoutes.test.ts' },
  'POST /api/workspaces/:id/flows/:flowId/checks': { test: 'test/api/flowRoutes.test.ts' },
  'POST /api/workspaces/:id/flows/types/:typeId/decision': { test: 'test/api/flowRoutes.test.ts' },
  'POST /api/workspaces/:id/flows/checklists/:checklistId/decision': { test: 'test/api/flowRoutes.test.ts' },
  'POST /api/workspaces/:id/flows/checklists/:checklistId/edit': { test: 'test/api/flowRoutes.test.ts' },
  'POST /api/workspaces/:id/flows/mentions/:mentionId/attribution': { test: 'test/api/flowRoutes.test.ts' },
  // persona learning
  'POST /api/workspaces/:id/persona-proposals/:proposalId/accept': { test: 'test/api/personaLearningRoutes.test.ts' },
  'POST /api/workspaces/:id/persona-proposals/:proposalId/reject': { test: 'test/api/personaLearningRoutes.test.ts' },
  'POST /api/workspaces/:id/persona-adjustments/:adjustmentId/retire': { test: 'test/api/personaLearningRoutes.test.ts' },
  // stakeholder personas
  'POST /api/workspaces/:id/stakeholder-questions/answers': { test: 'test/api/stakeholderRoutes.test.ts' },
  'POST /api/workspaces/:id/stakeholders/:personaId/reveal': { test: 'test/api/stakeholderRoutes.test.ts' },
  'POST /api/workspaces/:id/stakeholders/:personaId/notes': { test: 'test/api/stakeholderRoutes.test.ts' },
  'POST /api/workspaces/:id/recommendations/:recId/stakeholder-decisions': { test: 'test/api/stakeholderRoutes.test.ts' },
  'POST /api/workspaces/:id/stakeholder-reads/:readId/reaction': { test: 'test/api/stakeholderRoutes.test.ts' },
  // stakeholder positions: left, moved, promoted, demoted, returned
  'POST /api/workspaces/:id/stakeholders/:personaId/position': { test: 'test/api/stakeholderPositionRoutes.test.ts' },
};

/**
 * Whether test source `src` sends a request for `route` ("METHOD /path/:param"): the method, then a path
 * literal matching the route segment by segment (a `:param` is a `${…}` or a literal id), or
 * `request(<path>, { method })`. Knowledge routes may be written through the knowledge test's prefix
 * helper, `s.k(<workspace>, '/rest')`.
 */
function requestsRoute(src: string, route: string): boolean {
  const [method, path] = route.split(' ') as [string, string];
  const seg = (x: string) => (x.startsWith(':') ? String.raw`(?:\$\{[^}]+\}|[A-Za-z0-9_-]+)` : x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const pattern = (p: string) => p.split('/').map(seg).join('/');
  const q = "['`]";
  const forms = [`'${method}',\\s*${q}${pattern(path)}${q}`, `${q}${pattern(path)}${q},\\s*\\{\\s*method:\\s*'${method}'`];
  const prefix = '/api/workspaces/:id/knowledge';
  if (path.startsWith(prefix)) forms.push(`'${method}',\\s*s\\.k\\([^,]+,\\s*${q}${pattern(path.slice(prefix.length))}${q}\\)`);
  return forms.some((f) => new RegExp(f).test(src));
}

describe('every mutating route records its actor (re-gate, Opus 4)', () => {
  it('the "proven elsewhere" check matches a real request for the route, not a word of its path', () => {
    expect(requestsRoute("call('POST', `/api/findings/${fid}/include`, {})", 'POST /api/findings/:id/include')).toBe(true);
    expect(requestsRoute("call('POST', '/api/hypotheses/hyp_1/correct', {})", 'POST /api/hypotheses/:id/correct')).toBe(true);
    expect(requestsRoute("call('POST', s.k('ws_c', `/facts/${f.id}/retract`), {})", 'POST /api/workspaces/:id/knowledge/facts/:factId/retract')).toBe(true);
    expect(requestsRoute("app.request(`/api/workspaces/${t.a.id}/uploads`, { method: 'POST', body: form })", 'POST /api/workspaces/:id/uploads')).toBe(true);
    // A mention of the last word, another method or another path is not a request for the route.
    expect(requestsRoute('// include the findings', 'POST /api/findings/:id/include')).toBe(false);
    expect(requestsRoute("call('GET', `/api/findings/${fid}/include`)", 'POST /api/findings/:id/include')).toBe(false);
    expect(requestsRoute("call('POST', `/api/recommendations/${id}/include`, {})", 'POST /api/findings/:id/include')).toBe(false);
  });

  it('enumerates the mutating routes of the real app: each is proven, or exempt with a reason', async () => {
    const t = setup();
    const app = createApp({ store: t.store, artifacts: lessonsHarness(t, () => undefined).artifacts, events: lessonsHarness(t, () => undefined).events, config: t.config, research: lessonsHarness(t, () => undefined).deps });
    const mutating = [...new Set((app as unknown as { routes: Array<{ method: string; path: string }> }).routes
      .filter((r) => !['GET', 'ALL', 'HEAD', 'OPTIONS'].includes(r.method)).map((r) => `${r.method} ${r.path}`))].sort();
    expect(mutating).toEqual(Object.keys(ROUTES).sort());
    const { readFileSync } = await import('node:fs');
    for (const [route, how] of Object.entries(ROUTES)) {
      if ('exempt' in how) continue;
      const src = readFileSync(how.test, 'utf8');
      expect(requestsRoute(src, route), `${how.test} sends ${route}`).toBe(true);
      expect(src, `${how.test} checks an actor`).toMatch(/actor/);
    }
  });

  it('including a recommendation, persona or competitor records an include_override with the configured actor', async () => {
    const t = setup();
    const T = '2026-11-01T00:00:00.000Z';
    t.store.recommendations.insert({ id: 'rec_1', workspaceId: t.a.id, title: 'r', summary: 's', criteria: {}, findingIds: [], personaFeedback: [], priority: 1, createdAt: T });
    t.store.personas.insert({ id: 'per_1', workspaceId: t.a.id, slug: 'p', segment: 's', agentMdPath: 'x', version: 1, profile: {} } as never);
    t.store.competitors.insert({ id: 'cmp_1', workspaceId: t.a.id, name: 'c', threat: 3, directness: 3, comparison: { pricing: 3, onboarding: 3, ux: 3, features: 3 }, evidence: [], createdAt: T, updatedAt: T } as never);
    expect((await t.call('POST', `/api/recommendations/rec_1/include`, { include: true, actor: 'mallory' })).status).toBe(200);
    expect((await t.call('POST', `/api/personas/per_1/include`, { include: true })).status).toBe(200);
    expect((await t.call('POST', `/api/competitors/cmp_1/include`, { include: true })).status).toBe(200);
    expect(listFeedback(t.store, { kind: 'include_override' }).map((e) => [e.actor, e.targetType, e.targetId]).sort()).toEqual([
      ['erin', 'competitor', 'cmp_1'], ['erin', 'persona', 'per_1'], ['erin', 'recommendation', 'rec_1'],
    ]);
  });

  it('workspace create, interview message, upload, research start, schedule create / update, config change and the retro record a user_action with the configured actor', async () => {
    const t = setup();
    const actions = () => listFeedback(t.store, { kind: 'user_action' }).map((e) => [e.actor, (e.afterJson as { action: string }).action]);
    const ws = await t.call('POST', '/api/workspaces', { name: 'Newco', sector: 'saas' });
    expect(ws.status).toBe(201);
    expect((await t.call('POST', `/api/workspaces/${t.a.id}/interview`, { text: 'We sell widgets.' })).status).toBe(200);
    const form = new FormData();
    form.set('file', new File([new TextEncoder().encode('kpi,1')], 'kpis.csv', { type: 'text/csv' }));
    const app = createApp({ store: t.store, artifacts: lessonsHarness(t, () => undefined).artifacts, events: lessonsHarness(t, () => undefined).events, config: t.config, research: lessonsHarness(t, () => undefined).deps });
    expect((await app.request(`/api/workspaces/${t.a.id}/uploads`, { method: 'POST', body: form })).status).toBe(201);
    const s = await t.call('POST', `/api/workspaces/${t.a.id}/schedules`, { name: 'weekly', cron: '0 0 * * 1', phases: ['deep_dives'] });
    expect(s.status).toBe(201);
    expect((await t.call('PATCH', `/api/workspaces/${t.a.id}/schedules`, { id: s.body.id, enabled: false })).status).toBe(200);
    const cfg = (await t.call('GET', '/api/config')).body;
    expect((await t.call('PUT', '/api/config', { ...cfg, scoring: { ...cfg.scoring, personaWeight: 0.1 } })).status).toBe(200);
    // Background work (research, retro) fails fast here (no fake agents); wait for it to settle.
    expect((await t.call('POST', `/api/workspaces/${t.b.id}/research`, { phases: ['scoring'] })).status).toBe(202);
    expect((await t.call('POST', `/api/workspaces/${t.a.id}/lessons/retro`, {})).status).toBe(202);
    for (let i = 0; i < 200 && t.store.researchRuns.list({ workspaceId: t.b.id }).some((r) => r.status === 'running'); i++) await new Promise((r) => setTimeout(r, 5));
    await new Promise((r) => setTimeout(r, 50));
    expect(actions()).toEqual(expect.arrayContaining([
      ['erin', 'create_workspace'], ['erin', 'interview_message'], ['erin', 'upload'], ['erin', 'schedule_create'],
      ['erin', 'schedule_update'], ['erin', 'config_change'], ['erin', 'research_start'], ['erin', 'retro_run'],
    ]));
    // Ids and settings only: no user text, no file name.
    const all = JSON.stringify(listFeedback(t.store, { kind: 'user_action' }));
    expect(all).not.toContain('We sell widgets');
    expect(all).not.toContain('kpis.csv');
  });
});
