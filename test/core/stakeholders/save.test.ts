/**
 * Stakeholder personas, task 2 (design 2026-11-15-stakeholder-personas-design.md §6, §7): the
 * `save_stakeholder` worker tool — disclosure, versioning, agent.md, refusals, caps, the Decision
 * payload and review status.
 */
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { RunContext } from '../../../src/core/harness/tokens.js';
import { applyTaskStatus } from '../../../src/core/research/outputs.js';
import { STAKEHOLDER_FIELDS } from '../../../src/core/scoring/criteria.js';
import { stakeholderSlug, stakeholderToolHandlers } from '../../../src/core/stakeholders/personas.js';
import type { Store } from '../../../src/core/store/db.js';
import { newId } from '../../../src/core/store/repos.js';
import type { Task, TaskType } from '../../../src/core/types.js';
import { addTask, fixtureStakeholderTask, researchSetup, type SetupOptions } from '../helpers/research.js';

const opened: Store[] = [];
afterEach(() => {
  for (const s of opened.splice(0)) s.close();
});

const NOW = '2026-11-15T10:00:00.000Z';

function setup(config?: SetupOptions['config']) {
  const dir = mkdtempSync(join(tmpdir(), 'bif-stk-save-'));
  const t = researchSetup(opened, { dir, extraHandlers: () => stakeholderToolHandlers({ dataDir: dir }), ...(config ? { config } : {}) });
  t.store.workspaces.insert({
    id: 'ws_a', name: 'Acme', sector: 'saas', createdAt: NOW,
    scope: { level: 'division', name: 'Acme Payments', description: 'payments division' }, audiences: ['external'],
  });
  t.store.workspaces.insert({ id: 'ws_other', name: 'Other', sector: 'saas', createdAt: NOW });
  t.store.competitors.insert({
    id: 'cmp_rival', workspaceId: 'ws_a', name: 'Rival Pay', threat: 4, directness: 5,
    comparison: { pricing: 3, onboarding: 3, ux: 3, features: 3 }, evidence: [], createdAt: NOW, updatedAt: NOW, status: 'verified',
  });
  t.store.competitors.insert({
    id: 'cmp_foreign', workspaceId: 'ws_other', name: 'Foreign Co', threat: 4, directness: 5,
    comparison: { pricing: 3, onboarding: 3, ux: 3, features: 3 }, evidence: [], createdAt: NOW, updatedAt: NOW, status: 'verified',
  });
  const art = t.artifacts.save({ workspaceId: 'ws_a', kind: 'text', mime: 'text/plain', bytes: 'Org chart of Acme Payments' }).id;
  const foreignArt = t.artifacts.save({ workspaceId: 'ws_other', kind: 'text', mime: 'text/plain', bytes: 'other tree' }).id;
  return { ...t, art, foreignArt };
}

const ctx = (extra: Partial<RunContext> = {}): RunContext => ({
  agentRunId: newId('arun'), workspaceId: 'ws_a', role: 'worker', model: { provider: 'claude', model: 'sonnet' },
  promptVersion: 'pv', ...extra,
});

function profile(evidence: string[], over: Record<string, unknown> = {}) {
  const p: Record<string, unknown> = {};
  for (const f of STAKEHOLDER_FIELDS) p[f] = { value: `${f} secret value`, confidence: 0.6, evidence };
  return { ...p, ...over };
}

const input = (evidence: string[], extra: Record<string, unknown> = {}) => ({
  label: 'Chief financial officer',
  stakeholder_type: 'leader',
  subject: 'own',
  relation: 'approves pricing changes',
  profile: profile(evidence),
  ...extra,
});

/** `save_stakeholder` from a run of a stakeholder task of the node matching the subject, unless `c` names a task. */
const save = (t: ReturnType<typeof setup>, c: RunContext, inp: Record<string, unknown>) =>
  t.handle(c.taskId ? c : { ...c, taskId: fixtureStakeholderTask(t.store, c.workspaceId, inp.subject).id }, 'save_stakeholder', inp);

type Saved = { personaId: string; slug: string; version: number; agentMdPath: string };
const data = (r: unknown) => (r as { ok: true; data: Saved }).data;

const task = (t: ReturnType<typeof setup>, type: TaskType, extra: Partial<Task> = {}) =>
  addTask(t.store, { phase: 'stakeholders', type, brief: `do ${type}`, subject: undefined, ...extra });

describe('stakeholderSlug', () => {
  it('prefixes stk- and the competitor slug', () => {
    expect(stakeholderSlug('Chief Financial Officer')).toBe('stk-chief-financial-officer');
    expect(stakeholderSlug('CEO', 'rival-pay')).toBe('stk-rival-pay-ceo');
    expect(stakeholderSlug('!!!')).toBe('');
  });
});

describe('save_stakeholder', () => {
  it('first own save is hidden, version 1, with an agent.md holding the label, the relation and every section', async () => {
    const t = setup();
    const r = await save(t, ctx(), input([t.art]));
    expect(r.ok).toBe(true);
    const d = data(r);
    expect(d).toMatchObject({ slug: 'stk-chief-financial-officer', version: 1 });
    expect(d.agentMdPath).toBe(join(t.dir, 'ws_a', 'personas', 'stk-chief-financial-officer.md'));
    const p = t.store.personas.get(d.personaId)!;
    expect(p).toMatchObject({
      kind: 'stakeholder', stakeholderType: 'leader', subjectKind: 'own', segment: 'Chief financial officer',
      relation: 'approves pricing changes', disclosure: 'hidden', version: 1, status: 'pending',
    });
    expect(p.subjectId ?? undefined).toBeUndefined();
    const md = readFileSync(d.agentMdPath, 'utf8');
    expect(md).toContain('Chief financial officer');
    expect(md).toContain('approves pricing changes');
    expect(md.match(/^## /gm)!.length).toBeGreaterThanOrEqual(11);
    for (const f of STAKEHOLDER_FIELDS) expect(md).toContain(`${f} secret value`);
    expect(md).toMatch(/kind: stakeholder\n/);
    expect(md).toMatch(/simulated: true\n/);
    // versioned copy too
    expect(readFileSync(join(t.dir, 'ws_a', 'personas', 'stk-chief-financial-officer.v1.md'), 'utf8')).toBe(md);
  });

  it('a second save keeps hidden; after opening it keeps open', async () => {
    const t = setup();
    const id = data(await save(t, ctx(), input([t.art]))).personaId;
    const second = await save(t, ctx(), input([t.art], { relation: 'approves budgets' }));
    expect(data(second)).toMatchObject({ personaId: id, version: 2 });
    expect(t.store.personas.get(id)).toMatchObject({ disclosure: 'hidden', relation: 'approves budgets', version: 2 });

    t.store.personas.update(id, { disclosure: 'open' });
    await save(t, ctx(), input([t.art]));
    expect(t.store.personas.get(id)).toMatchObject({ disclosure: 'open', version: 3 });
  });

  it('a competitor save is open and its agent.md names the rival', async () => {
    const t = setup();
    const r = await save(t, ctx(), input([t.art], { label: 'CEO', subject: 'cmp_rival', relation: 'sets the strategy of Rival Pay' }));
    expect(r.ok).toBe(true);
    const d = data(r);
    expect(d.slug).toBe('stk-rival-pay-ceo');
    expect(t.store.personas.get(d.personaId)).toMatchObject({ subjectKind: 'competitor', subjectId: 'cmp_rival', disclosure: 'open' });
    const md = readFileSync(d.agentMdPath, 'utf8');
    expect(md).toContain('You are CEO at Rival Pay, a rival of Acme Payments');
  });

  it('refuses a competitor outside the tree, evidence outside the tree, and the wrong subject for the task type', async () => {
    const t = setup();
    const foreign = await save(t, ctx(), input([t.art], { subject: 'cmp_foreign' }));
    expect(foreign).toMatchObject({ ok: false, error: expect.stringMatching(/cmp_foreign/) });
    const unknown = await save(t, ctx(), input([t.art], { subject: 'cmp_missing' }));
    expect(unknown).toMatchObject({ ok: false, error: expect.stringMatching(/cmp_missing/) });
    const ev = await save(t, ctx(), input([t.foreignArt]));
    expect(ev).toMatchObject({ ok: false, error: expect.stringMatching(new RegExp(t.foreignArt)) });

    const own = task(t, 'own_stakeholders');
    const comp = task(t, 'competitor_stakeholders');
    const wrongOwn = await t.handle(ctx({ taskId: comp.id }), 'save_stakeholder', input([t.art]));
    expect(wrongOwn).toMatchObject({ ok: false, error: expect.stringMatching(/competitor_stakeholders/) });
    const wrongComp = await t.handle(ctx({ taskId: own.id }), 'save_stakeholder', input([t.art], { subject: 'cmp_rival' }));
    expect(wrongComp).toMatchObject({ ok: false, error: expect.stringMatching(/own_stakeholders/) });

    const badType = await save(t, ctx(), input([t.art], { stakeholder_type: 'friend' }));
    expect(badType.ok).toBe(false);
    const longRelation = await save(t, ctx(), input([t.art], { relation: 'x'.repeat(301) }));
    expect(longRelation.ok).toBe(false);
    const missingField = profile([t.art]);
    delete missingField.influence;
    const missing = await save(t, ctx(), input([t.art], { profile: missingField }));
    expect(missing).toMatchObject({ ok: false, error: expect.stringMatching(/influence/) });

    expect(t.store.personas.list()).toHaveLength(0);
    expect(t.store.decisions.list({ kind: 'score' })).toHaveLength(0);
  });

  it('the Decision carries the label, type and confidences, never profile values or the relation', async () => {
    const t = setup();
    const d = data(await save(t, ctx(), input([t.art])));
    const [dec] = t.store.decisions.list({ workspaceId: 'ws_a', kind: 'score' });
    expect(dec!.payload).toEqual({
      tool: 'save_stakeholder', personaId: d.personaId, label: 'Chief financial officer', stakeholderType: 'leader',
      subjectKind: 'own', version: 1, confidence: Object.fromEntries(STAKEHOLDER_FIELDS.map((f) => [f, 0.6])),
    });
    const text = JSON.stringify(dec);
    expect(text).not.toContain('secret value');
    expect(text).not.toContain('approves pricing changes');
    expect(dec!.refs).toEqual([d.personaId, t.art]);
  });

  it('caps count stakeholders, not saves; updates of an existing slug always pass', async () => {
    const t = setup((c) => {
      c.stakeholders = { maxOwn: 2, maxPerCompetitor: 1 };
    });
    expect((await save(t, ctx(), input([t.art], { label: 'A' }))).ok).toBe(true);
    expect((await save(t, ctx(), input([t.art], { label: 'A' }))).ok).toBe(true);
    expect((await save(t, ctx(), input([t.art], { label: 'B' }))).ok).toBe(true);
    const third = await save(t, ctx(), input([t.art], { label: 'C' }));
    expect(third).toMatchObject({ ok: false, error: expect.stringMatching(/maxOwn|at most 2/) });
    expect((await save(t, ctx(), input([t.art], { label: 'B' }))).ok).toBe(true);

    expect((await save(t, ctx(), input([t.art], { label: 'CEO', subject: 'cmp_rival' }))).ok).toBe(true);
    const second = await save(t, ctx(), input([t.art], { label: 'CFO', subject: 'cmp_rival' }));
    expect(second).toMatchObject({ ok: false, error: expect.stringMatching(/at most 1/) });
    expect((await save(t, ctx(), input([t.art], { label: 'CEO', subject: 'cmp_rival' }))).ok).toBe(true);
    expect(t.store.personas.list({ workspaceId: 'ws_a', kind: 'stakeholder' })).toHaveLength(3);
  });

  it('a stakeholder saved by a task takes that task\'s review status', async () => {
    const t = setup();
    const own = task(t, 'own_stakeholders');
    const d = data(await t.handle(ctx({ taskId: own.id }), 'save_stakeholder', input([t.art])));
    expect(t.store.personas.get(d.personaId)).toMatchObject({ taskId: own.id, taskRound: 1, status: 'pending' });
    t.store.transaction(() => applyTaskStatus(t.store, t.store.tasks.get(own.id)!, 'verified'));
    expect(t.store.personas.get(d.personaId)!.status).toBe('verified');
  });
});
