/**
 * Stakeholder position routes (design 2026-11-15-stakeholder-positions-design.md §9): `GET /stakeholders`
 * with former colleagues (at a competitor in that competitor's group, parked ones under `former`), the
 * position history with the two layers, and `POST …/position` for the four actions of the user.
 *
 * The actor of every change is the configured one, never the body. An id of another business tree
 * answers exactly like an unknown one (404), a hidden stakeholder 409, and a refusal changes nothing.
 *
 * Fixture: tree A — ws_a "Acme Group" with its child ws_b "Acme Payments", the competitors Rival Pay
 * (ws_a), Child Rival (ws_b) and the superseded Gone Corp; own stakeholders Head of finance and Head of
 * sales (open), Chief of staff (hidden) and Rival Pay's chief executive; tree B — ws_other with its own
 * stakeholder and competitor.
 */
import { existsSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../src/api/routes.js';
import { listFeedback } from '../../src/core/feedback/events.js';
import { agentMdPath, writeAgentMd } from '../../src/core/market/personas.js';
import { STAKEHOLDER_FIELDS } from '../../src/core/scoring/criteria.js';
import { stakeholderSlug, stakeholderToolHandlers } from '../../src/core/stakeholders/personas.js';
import { ensureQuestions } from '../../src/core/stakeholders/questions.js';
import { stakeholderRepos } from '../../src/core/stakeholders/store.js';
import type { Store } from '../../src/core/store/db.js';
import { newId } from '../../src/core/store/repos.js';
import type { Persona, PersonaProfileField } from '../../src/core/types.js';
import { addTask, researchSetup } from '../core/helpers/research.js';

const T0 = '2026-11-15T10:00:00.000Z';
const ACTOR = 'ana@acme';
/** Dates around the fixed clock: one that has passed in every time zone, one that has not come in any. */
const PAST = '2026-10-31';
const LATER = '2026-11-05';
const FUTURE = '2026-11-17';
/** Marks the text of the hidden stakeholder: it may appear in no response. */
const MARK = 'LEAKMARK';

const opened: Store[] = [];
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(T0));
});
afterEach(() => {
  vi.useRealTimers();
  for (const s of opened.splice(0)) s.close();
});

const profileOf = (label: string, mark = 'known'): Record<string, PersonaProfileField> =>
  Object.fromEntries(STAKEHOLDER_FIELDS.map((f) => [f, { value: `${mark} ${f} of ${label}`, confidence: 0.6, evidence: ['art_1'] }]));

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'bif-stk-pos-api-'));
  const t = researchSetup(opened, { dir, extraHandlers: () => stakeholderToolHandlers({ dataDir: dir }), config: (c) => (c.user = { id: ACTOR }) });
  t.store.workspaces.insert({ id: 'ws_a', name: 'Acme', sector: 'saas', createdAt: T0, scope: { level: 'company', name: 'Acme Group', description: '' } });
  t.store.workspaces.insert({ id: 'ws_b', name: 'Acme Payments', sector: 'saas', createdAt: T0, parentWorkspaceId: 'ws_a' });
  t.store.workspaces.insert({ id: 'ws_other', name: 'Other', sector: 'saas', createdAt: T0 });
  const competitor = (id: string, workspaceId: string, name: string, status: 'verified' | 'superseded' = 'verified') =>
    t.store.competitors.insert({
      id, workspaceId, name, threat: 4, directness: 5, comparison: { pricing: 3, onboarding: 3, ux: 3, features: 3 }, evidence: [], createdAt: T0,
      updatedAt: T0, status,
    });
  competitor('cmp_rival', 'ws_a', 'Rival Pay');
  competitor('cmp_child', 'ws_b', 'Child Rival');
  competitor('cmp_gone', 'ws_a', 'Gone Corp', 'superseded');
  competitor('cmp_foreign', 'ws_other', 'Foreign Inc');
  /** An open, verified own stakeholder with a full profile and its agent.md on disk. */
  const stakeholder = (label: string, extra: Partial<Persona> = {}, workspaceId = 'ws_a'): Persona => {
    const slug = extra.slug ?? stakeholderSlug(label);
    const p = t.store.personas.insert({
      id: newId('per'), workspaceId, slug, segment: label, profile: profileOf(label), version: 1, status: 'verified',
      agentMdPath: agentMdPath(dir, workspaceId, slug), kind: 'stakeholder', stakeholderType: 'leader', subjectKind: 'own',
      relation: `approves the budget (${label})`, disclosure: 'open', ...extra,
    });
    writeAgentMd(t.store, p);
    return t.store.personas.get(p.id)!;
  };
  const fin = stakeholder('Head of finance');
  const sales = stakeholder('Head of sales', { positionTitle: 'Head of Sales EMEA' });
  const hidden = stakeholder('Chief of staff', { disclosure: 'hidden', relation: `${MARK}-relation`, profile: profileOf('Chief of staff', MARK) });
  const rivalCeo = stakeholder('Chief executive', { slug: 'stk-rival-pay-chief-executive', subjectKind: 'competitor', subjectId: 'cmp_rival' });
  const foreign = stakeholder('Head of finance', {}, 'ws_other');
  ensureQuestions(t.store, 'ws_a');

  const app = createApp({ store: t.store, artifacts: t.artifacts, events: t.events, config: t.config, research: t.deps });
  const call = async (method: string, path: string, body?: unknown) => {
    const init: RequestInit = { method, headers: { 'content-type': 'application/json' } };
    if (body !== undefined) init.body = JSON.stringify(body);
    const res = await app.request(path, init);
    const text = await res.text();
    let json: any;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      json = undefined;
    }
    return { status: res.status, body: json, text };
  };
  const w = (rest: string, ws = 'ws_a') => `/api/workspaces/${ws}${rest}`;
  const list = (ws = 'ws_a') => call('GET', w('/stakeholders', ws)).then((r) => r.body);
  const position = (personaId: string, body: unknown, ws = 'ws_a') => call('POST', `/api/workspaces/${ws}/stakeholders/${personaId}/position`, body);
  const history = (personaId: string, ws = 'ws_a') => call('GET', w(`/stakeholders/${personaId}/positions`, ws));
  const files = () =>
    ['ws_a', 'ws_b', 'ws_other'].flatMap((ws) => {
      const d = join(dir, ws, 'personas');
      return existsSync(d) ? readdirSync(d).sort().map((f) => `${ws}/${f}`) : [];
    });
  /** Everything an action may change: a refused action leaves it as it was. */
  const state = () =>
    JSON.stringify({
      personas: t.store.personas.list(), positions: stakeholderRepos(t.store).positions.list({}), feedback: listFeedback(t.store),
      competitors: t.store.competitors.list(), questions: stakeholderRepos(t.store).questions.list(), files: files(),
    });
  const events = () => listFeedback(t.store, { kind: 'stakeholder_position_change' });
  return { ...t, app, call, w, list, position, history, state, events, stakeholder, fin, sales, hidden, rivalCeo, foreign };
}

const keysOf = (o: object) => Object.keys(o).sort();
const ids = (views: Array<{ id: string }>) => views.map((v) => v.id);
const HIDDEN_KEYS = ['disclosure', 'id', 'label', 'questions', 'stakeholderType'];
const OPEN_KEYS = [...HIDDEN_KEYS, 'profile', 'relation', 'statements', 'status', 'subjectKind', 'version'].sort();

describe('GET /stakeholders with former colleagues', () => {
  it('a node where nobody changed position: the views are as before, former is empty, places names the competitors and nodes of the tree', async () => {
    const s = setup();
    const body = await s.list();
    expect(ids(body.own)).toEqual([s.hidden.id, s.fin.id, s.sales.id]); // by slug
    expect(body.own[0]).toEqual({ id: s.hidden.id, label: 'Chief of staff', stakeholderType: 'leader', disclosure: 'hidden', questions: expect.any(Number) });
    expect(keysOf(body.own[0])).toEqual(HIDDEN_KEYS);
    expect(keysOf(body.own[1])).toEqual(OPEN_KEYS);
    // A title the stakeholder has is served; nothing else is added to a stakeholder that never left.
    expect(body.own[2].positionTitle).toBe('Head of Sales EMEA');
    expect(keysOf(body.own[2])).toEqual([...OPEN_KEYS, 'positionTitle'].sort());
    expect(body.former).toEqual([]);
    expect(body.places).toEqual({
      competitors: [{ competitorId: 'cmp_rival', name: 'Rival Pay' }, { competitorId: 'cmp_child', name: 'Child Rival' }],
      nodes: [{ workspaceId: 'ws_a', name: 'Acme Group' }, { workspaceId: 'ws_b', name: 'Acme Payments' }],
    });
    // Another tree: its own competitors and nodes only.
    expect((await s.list('ws_other')).places).toEqual({ competitors: [{ competitorId: 'cmp_foreign', name: 'Foreign Inc' }], nodes: [{ workspaceId: 'ws_other', name: 'Other' }] });
  });

  it('own holds only own stakeholders that have not left; a former colleague at a competitor is in that competitor\'s group; a parked one under former', async () => {
    const s = setup();
    const legal = s.stakeholder('Head of legal');
    expect((await s.position(s.sales.id, { change: 'left', date: PAST, to: { competitorId: 'cmp_rival' }, title: 'VP Sales' })).status).toBe(200);
    expect((await s.position(legal.id, { change: 'left', date: PAST, to: { elsewhere: { companyName: 'A law firm' } } })).status).toBe(200);
    const body = await s.list();
    expect(ids(body.own)).toEqual([s.hidden.id, s.fin.id]);
    expect(body.competitors).toHaveLength(1);
    expect(body.competitors[0]).toMatchObject({ competitorId: 'cmp_rival', name: 'Rival Pay' });
    expect(ids(body.competitors[0].stakeholders)).toEqual([s.rivalCeo.id, s.sales.id]);
    const [ceo, gone] = body.competitors[0].stakeholders;
    // A competitor's stakeholder that never worked here is served as before.
    expect(keysOf(ceo)).toEqual(OPEN_KEYS);
    expect(gone).toMatchObject({
      disclosure: 'open', subjectKind: 'competitor', relation: 'VP Sales', positionTitle: 'VP Sales', leftAt: PAST, hasPublicLayer: false,
      leftFrom: { workspaceId: 'ws_a', scopeName: 'Acme Group', stakeholderType: 'leader', title: 'Head of Sales EMEA', relation: 'approves the budget (Head of sales)' },
    });
    expect(gone).not.toHaveProperty('publicPosition');
    expect(gone.profile.decision_criteria).toMatchObject({ value: 'known decision_criteria of Head of sales', basis: 'internal' });
    expect(body.former).toHaveLength(1);
    expect(body.former[0]).toMatchObject({ id: legal.id, label: 'Head of legal', disclosure: 'open', subjectKind: 'former', leftAt: PAST, hasPublicLayer: false });
    expect(body.former[0].leftFrom).toMatchObject({ workspaceId: 'ws_a', scopeName: 'Acme Group' });
  });

  it('a former colleague research has followed: hasPublicLayer and what research last saw of the position', async () => {
    const s = setup();
    await s.position(s.sales.id, { change: 'left', date: PAST, to: { competitorId: 'cmp_rival' } });
    s.store.personas.update(s.sales.id, {
      publicProfile: profileOf('Head of sales', 'public'), publicTaskId: 'tsk_1', publicSavedAt: T0, publicPosition: { text: 'VP Sales at Rival Pay', evidence: ['art_9'] },
    });
    let gone = (await s.list()).competitors[0].stakeholders.find((v: any) => v.id === s.sales.id);
    expect(gone).toMatchObject({ hasPublicLayer: true, publicPosition: { text: 'VP Sales at Rival Pay', evidence: ['art_9'] } });
    // The task that saw it is the store's own note: the view serves the line and its evidence.
    s.store.personas.update(s.sales.id, { publicPosition: { text: 'VP Sales at Rival Pay', evidence: ['art_9'], taskId: 'tsk_1' } });
    gone = (await s.list()).competitors[0].stakeholders.find((v: any) => v.id === s.sales.id);
    expect(gone.publicPosition).toEqual({ text: 'VP Sales at Rival Pay', evidence: ['art_9'] });
    // The layers themselves are served by the positions route only.
    expect(gone).not.toHaveProperty('publicProfile');
    expect(gone).not.toHaveProperty('internalProfile');
  });
});

describe('GET /stakeholders/:personaId/positions', () => {
  it('a stakeholder that never changed position: an empty history and no layer', async () => {
    const s = setup();
    const r = await s.history(s.fin.id);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ positions: [] });
  });

  it('the history newest first, each row with the name of its place, and both layers of a former colleague', async () => {
    const s = setup();
    await s.position(s.sales.id, { change: 'promoted', date: PAST, title: 'Chief revenue officer', note: 'Announced at the offsite.' });
    await s.position(s.sales.id, { change: 'left', date: LATER, to: { competitorId: 'cmp_rival' }, title: 'VP Sales' });
    let r = await s.history(s.sales.id);
    expect(r.status).toBe(200);
    expect(r.body.positions.map((p: any) => [p.change, p.placeKind, p.placeName, p.title, p.effectiveOn])).toEqual([
      ['left', 'competitor', 'Rival Pay', 'VP Sales', LATER],
      ['promoted', 'node', 'Acme Group', 'Chief revenue officer', PAST],
      ['joined', 'node', 'Acme Group', 'Head of Sales EMEA', undefined],
    ]);
    expect(r.body.positions[1]).toMatchObject({ personaId: s.sales.id, actor: ACTOR, note: 'Announced at the offsite.' });
    expect(r.body.internalProfile.decision_criteria).toEqual({ value: 'known decision_criteria of Head of sales', confidence: 0.6, evidence: ['art_1'], basis: 'internal' });
    expect(r.body).not.toHaveProperty('publicProfile');

    s.store.personas.update(s.sales.id, { publicProfile: profileOf('Head of sales', 'public'), publicTaskId: 'tsk_1', publicSavedAt: T0 });
    r = await s.history(s.sales.id);
    expect(r.body.publicProfile.decision_criteria).toMatchObject({ value: 'public decision_criteria of Head of sales' });
    expect(keysOf(r.body)).toEqual(['internalProfile', 'positions', 'publicLayerStatus', 'publicLayerUsed', 'publicProfile', 'publicSavedAt']);
  });

  it('says whether the public layer is used and when the profile was last combined', async () => {
    const s = setup();
    await s.position(s.sales.id, { change: 'left', date: PAST, to: { competitorId: 'cmp_rival' } });
    // No public layer yet: nothing is said about one.
    expect(keysOf((await s.history(s.sales.id)).body)).toEqual(['internalProfile', 'positions']);

    const task = addTask(s.store, { phase: 'stakeholders', type: 'competitor_stakeholders', status: 'running' });
    const SAVED = '2026-11-15T09:00:00.000Z';
    s.store.personas.update(s.sales.id, { publicProfile: profileOf('Head of sales', 'public'), publicTaskId: task.id, publicSavedAt: SAVED });
    const layer = async () => {
      const { publicLayerUsed, publicSavedAt, combinedAt } = (await s.history(s.sales.id)).body;
      return { publicLayerUsed, publicSavedAt, combinedAt };
    };
    const status = async () => (await s.history(s.sales.id)).body.publicLayerStatus;
    // While its research runs, and once it ended verified or unverified, the layer counts.
    expect(await layer()).toEqual({ publicLayerUsed: true, publicSavedAt: SAVED, combinedAt: undefined });
    // How the research that saved it ended: still pending while its task has not.
    for (const running of ['queued', 'running', 'reviewing', 'waiting_user'] as const) {
      s.store.tasks.update(task.id, { status: running });
      expect(await status(), running).toBe('pending');
      expect((await layer()).publicLayerUsed, running).toBe(true);
    }
    for (const status of ['verified', 'unverified'] as const) {
      s.store.tasks.update(task.id, { status });
      expect((await layer()).publicLayerUsed, status).toBe(true);
      // A layer of research that was not verified is used; the page is told so it can say it.
      expect((await s.history(s.sales.id)).body.publicLayerStatus, status).toBe(status);
    }
    // Combined since.
    s.store.personas.update(s.sales.id, { combinedAt: T0 });
    expect(await layer()).toEqual({ publicLayerUsed: true, publicSavedAt: SAVED, combinedAt: T0 });
    // The research that found it did not pass review: stored, shown, not used.
    s.store.tasks.update(task.id, { status: 'failed' });
    expect(await layer()).toEqual({ publicLayerUsed: false, publicSavedAt: SAVED, combinedAt: T0 });
    expect(await status()).toBe('failed');
    expect((await s.history(s.sales.id)).body.publicProfile).toBeTruthy();
    // A task that is gone will never be combined either.
    s.store.personas.update(s.sales.id, { publicTaskId: 'tsk_gone' });
    expect((await layer()).publicLayerUsed).toBe(false);
    expect(await status()).toBe('failed');
  });

  it('a parked former colleague: the company the user named is the place of the row', async () => {
    const s = setup();
    await s.position(s.sales.id, { change: 'left', date: PAST, to: { elsewhere: { companyName: 'A law firm' } } });
    const r = await s.history(s.sales.id);
    expect(r.body.positions[0]).toMatchObject({ change: 'left', placeKind: 'elsewhere', companyName: 'A law firm', placeName: 'A law firm' });
    expect(r.body.internalProfile).toBeTruthy();
  });

  it('a hidden stakeholder answers 409 and nothing of it; another tree\'s, an unknown one and a segment persona answer 404', async () => {
    const s = setup();
    const r = await s.history(s.hidden.id);
    expect(r.status).toBe(409);
    expect(keysOf(r.body)).toEqual(['error']);
    expect(r.body.error).toContain('answer or skip its questions first');
    expect(r.text).not.toContain(MARK);
    // Even with layers stored on it (which no action allows), nothing of a hidden stakeholder is served.
    s.store.personas.update(s.hidden.id, { leftAt: PAST, internalProfile: profileOf('Chief of staff', MARK), publicProfile: profileOf('Chief of staff', MARK) });
    const again = await s.history(s.hidden.id);
    expect(again.status).toBe(409);
    expect(again.text).not.toContain(MARK);

    const segment = s.store.personas.insert({ id: 'per_seg', workspaceId: 'ws_a', slug: 'smb', segment: 'Small businesses', profile: {}, version: 1, status: 'verified', agentMdPath: join(s.dir, 'smb.md') });
    const unknown = await s.history('per_nope');
    expect(unknown.status).toBe(404);
    for (const [personaId, ws] of [[s.foreign.id, 'ws_a'], [s.fin.id, 'ws_other'], [segment.id, 'ws_a']] as const) {
      const other = await s.history(personaId, ws);
      expect(other.status, personaId).toBe(404);
      // The same answer as for an id that does not exist.
      expect(other.body.error).toBe(unknown.body.error.replace('per_nope', personaId));
    }
    expect((await s.history(s.fin.id, 'ws_nope')).status).toBe(404);
  });
});

describe('POST /stakeholders/:personaId/position', () => {
  it('left for a competitor of the tree: answers the stakeholder\'s view; the configured actor, never the body\'s, is on the history and the event', async () => {
    const s = setup();
    const r = await s.position(s.sales.id, { change: 'left', date: PAST, to: { competitorId: 'cmp_child' }, label: 'Sales lead', title: 'VP Sales', note: 'Said so at the all-hands.', actor: 'someone-else' });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      id: s.sales.id, label: 'Sales lead', disclosure: 'open', subjectKind: 'competitor', relation: 'VP Sales', positionTitle: 'VP Sales', leftAt: PAST,
      hasPublicLayer: false, version: 2,
    });
    const stored = s.store.personas.get(s.sales.id)!;
    expect(stored).toMatchObject({ subjectKind: 'competitor', subjectId: 'cmp_child', slug: 'stk-child-rival-sales-lead', leftAt: PAST });
    expect(stakeholderRepos(s.store).positions.list({ personaId: s.sales.id }).map((p) => [p.change, p.actor])).toEqual([['joined', ACTOR], ['left', ACTOR]]);
    expect(s.events()).toHaveLength(1);
    expect(s.events()[0]).toMatchObject({ actor: ACTOR, targetId: s.sales.id, reason: 'Said so at the all-hands.' });
    expect(JSON.stringify(s.events())).not.toContain('someone-else');
  });

  it('left for a company not listed creates the competitor; left for elsewhere parks; a parked one can be attached to a competitor later', async () => {
    const s = setup();
    const created = await s.position(s.sales.id, { change: 'left', date: PAST, to: { newCompetitor: { name: 'New Rival', site: 'https://newrival.example' } } });
    expect(created.status).toBe(200);
    const competitor = s.store.competitors.list({ workspaceId: 'ws_a' }).find((c) => c.name === 'New Rival')!;
    expect(competitor).toMatchObject({ threat: 1, directness: 1, status: 'unverified', site: 'https://newrival.example' });
    expect(s.store.personas.get(s.sales.id)).toMatchObject({ subjectKind: 'competitor', subjectId: competitor.id });
    expect((await s.list()).places.competitors.map((c: any) => c.name)).toContain('New Rival');

    const parked = await s.position(s.fin.id, { change: 'left', date: PAST, to: { elsewhere: {} } });
    expect(parked.status).toBe(200);
    expect(parked.body).toMatchObject({ subjectKind: 'former', leftAt: PAST });
    expect(ids((await s.list()).former)).toEqual([s.fin.id]);

    const attached = await s.position(s.fin.id, { change: 'left', date: LATER, to: { competitorId: 'cmp_rival' } });
    expect(attached.status).toBe(200);
    // The leaving date is the first one: the attach keeps it.
    expect(attached.body).toMatchObject({ subjectKind: 'competitor', leftAt: PAST });
    expect((await s.history(s.fin.id)).body.positions.map((p: any) => [p.change, p.placeKind, p.effectiveOn])).toEqual([
      ['moved', 'competitor', LATER], ['left', 'elsewhere', PAST], ['joined', 'node', undefined],
    ]);
    const body = await s.list();
    expect(body.former).toEqual([]);
    expect(ids(body.competitors.find((c: any) => c.competitorId === 'cmp_rival').stakeholders)).toContain(s.fin.id);
  });

  it('a former colleague moved on to another company: "left" with the new destination keeps the leaving date and the layers, and the history says moved', async () => {
    const s = setup();
    await s.position(s.sales.id, { change: 'left', date: PAST, to: { competitorId: 'cmp_rival' }, title: 'VP Sales' });
    s.store.personas.update(s.sales.id, { publicProfile: profileOf('Head of sales', 'public'), publicTaskId: 'tsk_1', publicSavedAt: T0 });
    const internal = (await s.history(s.sales.id)).body.internalProfile;

    // On to another competitor of the tree.
    const moved = await s.position(s.sales.id, { change: 'left', date: LATER, to: { competitorId: 'cmp_child' }, title: 'Chief revenue officer', actor: 'someone-else' });
    expect(moved.status).toBe(200);
    expect(moved.body).toMatchObject({ id: s.sales.id, subjectKind: 'competitor', leftAt: PAST, positionTitle: 'Chief revenue officer', hasPublicLayer: true, version: 3 });
    expect(moved.body.leftFrom).toMatchObject({ scopeName: 'Acme Group', title: 'Head of Sales EMEA' });
    let body = await s.list();
    expect(ids(body.competitors.find((c: any) => c.competitorId === 'cmp_child').stakeholders)).toEqual([s.sales.id]);
    expect(ids(body.competitors.find((c: any) => c.competitorId === 'cmp_rival').stakeholders)).toEqual([s.rivalCeo.id]);
    let history = (await s.history(s.sales.id)).body;
    expect(history.positions.map((p: any) => [p.change, p.placeKind, p.placeName, p.title, p.effectiveOn, p.actor])).toEqual([
      ['moved', 'competitor', 'Child Rival', 'Chief revenue officer', LATER, ACTOR],
      ['left', 'competitor', 'Rival Pay', 'VP Sales', PAST, ACTOR],
      ['joined', 'node', 'Acme Group', 'Head of Sales EMEA', undefined, ACTOR],
    ]);
    expect(history.internalProfile).toEqual(internal);
    expect(history.publicProfile).toBeTruthy();

    // On to a company that is no competitor: listed under former.
    const parked = await s.position(s.sales.id, { change: 'left', date: LATER, to: { elsewhere: { companyName: 'A consultancy' } } });
    expect(parked.status).toBe(200);
    expect(parked.body).toMatchObject({ subjectKind: 'former', leftAt: PAST, hasPublicLayer: true });
    body = await s.list();
    expect(ids(body.former)).toEqual([s.sales.id]);
    expect(body.competitors.some((c: any) => ids(c.stakeholders).includes(s.sales.id))).toBe(false);
    history = (await s.history(s.sales.id)).body;
    expect(history.positions[0]).toMatchObject({ change: 'moved', placeKind: 'elsewhere', placeName: 'A consultancy' });

    // On to a company not listed: it becomes a competitor.
    const created = await s.position(s.sales.id, { change: 'left', date: LATER, to: { newCompetitor: { name: 'New Rival' } } });
    expect(created.status).toBe(200);
    const competitor = s.store.competitors.list({ workspaceId: 'ws_a' }).find((c) => c.name === 'New Rival')!;
    expect(s.store.personas.get(s.sales.id)).toMatchObject({ subjectKind: 'competitor', subjectId: competitor.id, leftAt: PAST });
    expect(s.events().map((e) => (e.afterJson as { change: string }).change)).toEqual(['left', 'moved', 'moved', 'moved']);
    expect(JSON.stringify(s.events())).not.toContain('someone-else');

    // Refused like a leave, and nothing changes: the company the person is at, another tree's competitor, a slug in use.
    const before = s.state();
    expect((await s.position(s.sales.id, { change: 'left', date: LATER, to: { competitorId: competitor.id } })).status).toBe(400);
    expect((await s.position(s.sales.id, { change: 'left', date: LATER, to: { competitorId: 'cmp_foreign' } })).status).toBe(404);
    s.stakeholder('Sales chief', { slug: 'stk-rival-pay-head-of-sales', subjectKind: 'competitor', subjectId: 'cmp_rival' });
    const after = s.state();
    expect(after).not.toBe(before);
    expect((await s.position(s.sales.id, { change: 'left', date: LATER, to: { competitorId: 'cmp_rival' } })).status).toBe(409);
    expect(s.state()).toBe(after);
  });

  it('moved: the stakeholder is listed at the other node; promoted and demoted change the title and the type', async () => {
    const s = setup();
    const moved = await s.position(s.sales.id, { change: 'moved', date: PAST, toWorkspaceId: 'ws_b', title: 'Head of sales, payments' });
    expect(moved.status).toBe(200);
    expect(moved.body).toMatchObject({ id: s.sales.id, subjectKind: 'own', positionTitle: 'Head of sales, payments' });
    expect(moved.body).not.toHaveProperty('leftAt');
    expect(ids((await s.list()).own)).not.toContain(s.sales.id);
    expect(ids((await s.list('ws_b')).own)).toEqual([s.sales.id]);

    const promoted = await s.position(s.fin.id, { change: 'promoted', date: PAST, title: 'Chief financial officer', stakeholderType: 'board' });
    expect(promoted.body).toMatchObject({ positionTitle: 'Chief financial officer', stakeholderType: 'board', version: 2 });
    const demoted = await s.position(s.fin.id, { change: 'demoted', date: LATER, title: 'Controller', stakeholderType: 'manager' });
    expect(demoted.body).toMatchObject({ positionTitle: 'Controller', stakeholderType: 'manager', version: 3 });
    expect((await s.history(s.fin.id)).body.positions.map((p: any) => p.change)).toEqual(['demoted', 'promoted', 'joined']);
  });

  it('returned: an own stakeholder of the node again, without leaving date or layers', async () => {
    const s = setup();
    await s.position(s.sales.id, { change: 'left', date: PAST, to: { competitorId: 'cmp_rival' } });
    const r = await s.position(s.sales.id, { change: 'returned', date: LATER, toWorkspaceId: 'ws_b', title: 'Head of sales' });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ id: s.sales.id, subjectKind: 'own', disclosure: 'open', positionTitle: 'Head of sales' });
    for (const gone of ['leftAt', 'leftFrom', 'hasPublicLayer', 'publicPosition']) expect(r.body).not.toHaveProperty(gone);
    expect(ids((await s.list('ws_b')).own)).toEqual([s.sales.id]);
    expect(ids((await s.list()).competitors[0].stakeholders)).toEqual([s.rivalCeo.id]);
    const history = (await s.history(s.sales.id, 'ws_b')).body;
    expect(history.positions.map((p: any) => p.change)).toEqual(['returned', 'left', 'joined']);
    expect(keysOf(history)).toEqual(['positions']);
  });

  it('returned to a node where the slug is in use: 409 with the way out, and a new label in the body is that way out', async () => {
    const s = setup();
    await s.position(s.sales.id, { change: 'left', date: PAST, to: { competitorId: 'cmp_rival' } });
    // Someone else is head of sales by now.
    s.stakeholder('Head of Sales');
    const before = s.state();
    const taken = await s.position(s.sales.id, { change: 'returned', date: LATER, toWorkspaceId: 'ws_a' });
    expect(taken.status).toBe(409);
    expect(taken.body.error).toContain('Head of Sales');
    expect(taken.body.error).toContain('give this stakeholder another label');
    expect((await s.position(s.sales.id, { change: 'returned', date: LATER, toWorkspaceId: 'ws_a', label: 'x'.repeat(81) })).status).toBe(400);
    expect((await s.position(s.sales.id, { change: 'returned', date: LATER, toWorkspaceId: 'ws_a', label: 7 })).status).toBe(400);
    expect(s.state()).toBe(before);

    const r = await s.position(s.sales.id, { change: 'returned', date: LATER, toWorkspaceId: 'ws_a', label: 'Former head of sales' });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ id: s.sales.id, label: 'Former head of sales', subjectKind: 'own' });
    expect(s.store.personas.get(s.sales.id)).toMatchObject({ slug: 'stk-former-head-of-sales', segment: 'Former head of sales', workspaceId: 'ws_a' });
  });

  it('a body that is not one of the changes answers 400 and changes nothing', async () => {
    const s = setup();
    const before = s.state();
    const bad: unknown[] = [
      {}, { change: 'fired', date: PAST }, { change: 'left', to: { elsewhere: {} } }, { change: 'left', date: PAST }, { change: 'left', date: PAST, to: 'cmp_rival' },
      { change: 'left', date: PAST, to: { competitorId: 7 } }, { change: 'left', date: PAST, to: { newCompetitor: {} } },
      { change: 'left', date: PAST, to: { elsewhere: {} }, label: 7 }, { change: 'moved', date: PAST, toWorkspaceId: 7 },
      { change: 'promoted', date: PAST, stakeholderType: 'emperor' }, { change: 'promoted', date: 20261031 }, { change: 'returned', date: PAST },
      // refused by the action itself
      { change: 'left', date: PAST, to: {} }, { change: 'left', date: PAST, to: { competitorId: 'cmp_rival', elsewhere: {} } },
      { change: 'left', date: FUTURE, to: { elsewhere: {} } }, { change: 'left', date: '31.10.2026', to: { elsewhere: {} } },
      { change: 'left', date: PAST, to: { elsewhere: {} }, label: '   ' }, { change: 'moved', date: PAST }, { change: 'moved', date: PAST, toWorkspaceId: 'ws_a' },
      { change: 'promoted', date: PAST, note: 'x'.repeat(2001) }, { change: 'returned', date: PAST, toWorkspaceId: 'ws_a' },
    ];
    for (const body of bad) {
      const r = await s.position(s.sales.id, body);
      expect(r.status, JSON.stringify(body)).toBe(400);
      expect(typeof r.body.error).toBe('string');
    }
    const notJson = await s.app.request(s.w(`/stakeholders/${s.sales.id}/position`), { method: 'POST', headers: { 'content-type': 'application/json' }, body: 'left' });
    expect(notJson.status).toBe(400);
    expect(s.state()).toBe(before);
  });

  it('ids of another tree answer 404 exactly like unknown ones, and change nothing', async () => {
    const s = setup();
    await s.position(s.fin.id, { change: 'left', date: PAST, to: { competitorId: 'cmp_rival' } });
    const before = s.state();
    const left = { change: 'left', date: PAST, to: { elsewhere: {} } };
    const unknown = await s.position('per_nope', left);
    expect(unknown.status).toBe(404);
    // the persona
    for (const [personaId, ws] of [[s.foreign.id, 'ws_a'], [s.sales.id, 'ws_other']] as const) {
      for (const body of [left, { change: 'promoted', date: PAST }, { change: 'returned', date: PAST, toWorkspaceId: ws }]) {
        const r = await s.position(personaId, body, ws);
        expect(r.status, `${personaId} ${body.change}`).toBe(404);
        expect(r.body.error).toBe(unknown.body.error.replace('per_nope', personaId));
      }
    }
    expect((await s.position(s.sales.id, left, 'ws_nope')).status).toBe(404);
    // the competitor: another tree's, an unknown one, a superseded one
    const noCompetitor = await s.position(s.sales.id, { change: 'left', date: PAST, to: { competitorId: 'cmp_nope' } });
    expect(noCompetitor.status).toBe(404);
    for (const competitorId of ['cmp_foreign', 'cmp_gone']) {
      const r = await s.position(s.sales.id, { change: 'left', date: PAST, to: { competitorId } });
      expect(r.status, competitorId).toBe(404);
      expect(r.body.error).toBe(noCompetitor.body.error.replace('cmp_nope', competitorId));
    }
    // the node
    const noNode = await s.position(s.sales.id, { change: 'moved', date: PAST, toWorkspaceId: 'ws_nope' });
    expect(noNode.status).toBe(404);
    const foreignNode = await s.position(s.sales.id, { change: 'moved', date: PAST, toWorkspaceId: 'ws_other' });
    expect(foreignNode.status).toBe(404);
    expect(foreignNode.body.error).toBe(noNode.body.error.replace('ws_nope', 'ws_other'));
    expect((await s.position(s.fin.id, { change: 'returned', date: PAST, toWorkspaceId: 'ws_other' })).status).toBe(404);
    expect(s.state()).toBe(before);
  });

  it('a hidden stakeholder answers 409 for every change, with nothing of it in the answer; so do a slug in use and research that is not usable', async () => {
    const s = setup();
    const ceo = s.stakeholder('Chief executive');
    const pending = s.stakeholder('Head of product', { status: 'pending' });
    const before = s.state();
    for (const body of [
      { change: 'left', date: PAST, to: { competitorId: 'cmp_rival' } }, { change: 'left', date: PAST, to: { elsewhere: {} } },
      { change: 'moved', date: PAST, toWorkspaceId: 'ws_b' }, { change: 'promoted', date: PAST }, { change: 'demoted', date: PAST },
      { change: 'returned', date: PAST, toWorkspaceId: 'ws_a' },
    ]) {
      const r = await s.position(s.hidden.id, body);
      expect(r.status, body.change).toBe(409);
      expect(keysOf(r.body)).toEqual(['error']);
      expect(r.body.error).toContain('answer or skip its questions first');
      expect(r.text).not.toContain(MARK);
    }
    // Rival Pay already has a chief executive: leaving for it under the same label would take its slug.
    const taken = await s.position(ceo.id, { change: 'left', date: PAST, to: { competitorId: 'cmp_rival' } });
    expect(taken.status).toBe(409);
    expect(taken.body.error).toContain('Chief executive');
    expect((await s.position(pending.id, { change: 'promoted', date: PAST })).status).toBe(409);
    expect(s.state()).toBe(before);
    expect(s.events()).toEqual([]);
  });

  it('only the kind of stakeholder a change is for can make it: 400 otherwise', async () => {
    const s = setup();
    // has not left
    expect((await s.position(s.fin.id, { change: 'returned', date: PAST, toWorkspaceId: 'ws_a' })).status).toBe(400);
    // a competitor's stakeholder that never worked here
    for (const body of [{ change: 'left', date: PAST, to: { elsewhere: {} } }, { change: 'promoted', date: PAST }, { change: 'returned', date: PAST, toWorkspaceId: 'ws_a' }]) {
      expect((await s.position(s.rivalCeo.id, body)).status, body.change).toBe(400);
    }
    // has left already: no position here to change, and no second leave for the company the person is at
    await s.position(s.sales.id, { change: 'left', date: PAST, to: { competitorId: 'cmp_rival' } });
    expect((await s.position(s.sales.id, { change: 'left', date: PAST, to: { competitorId: 'cmp_rival' } })).status).toBe(400);
    expect((await s.position(s.sales.id, { change: 'demoted', date: PAST })).status).toBe(400);
    expect((await s.position(s.sales.id, { change: 'moved', date: PAST, toWorkspaceId: 'ws_b' })).status).toBe(400);
  });
});
