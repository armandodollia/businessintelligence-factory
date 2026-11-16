/**
 * Stakeholder positions, task 1 (design 2026-11-15-stakeholder-positions-design.md §4, §5): migration 28
 * (the persona columns and the append-only `stakeholder_positions`), the four actions of the user
 * (left, moved / promoted / demoted, returned), every refusal, and that a refusal changes nothing.
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bifConfigSchema, defaultConfig, type BifConfig } from '../../../src/core/config/schema.js';
import { FEEDBACK_KINDS, listFeedback } from '../../../src/core/feedback/events.js';
import { knowledgeRepos } from '../../../src/core/store/repos.js';
import { agentMdPath, writeAgentMd } from '../../../src/core/market/personas.js';
import { STAKEHOLDER_FIELDS } from '../../../src/core/scoring/criteria.js';
import { exportTrainingData } from '../../../src/core/scoring/export.js';
import { stakeholderSlug, stakeholderToolHandlers, wentTo } from '../../../src/core/stakeholders/personas.js';
import {
  changePosition,
  formerColleagues,
  holdsInternal,
  isFormerColleague,
  isParked,
  markLeft,
  markReturned,
  positionsOf,
  type PositionDeps,
} from '../../../src/core/stakeholders/positions.js';
import { stakeholdersSettings } from '../../../src/core/stakeholders/settings.js';
import { addNote, StakeholderError } from '../../../src/core/stakeholders/statements.js';
import { stakeholderRepos } from '../../../src/core/stakeholders/store.js';
import { POSITION_CHANGES, type StakeholderPosition } from '../../../src/core/stakeholders/types.js';
import { openStore, type Store } from '../../../src/core/store/db.js';
import { MIGRATIONS } from '../../../src/core/store/migrations.js';
import { newId } from '../../../src/core/store/repos.js';
import { STANCE_BY_KIND } from '../../../src/core/userPersona/interactions.js';
import type { Persona, PersonaProfileField } from '../../../src/core/types.js';
import { researchSetup } from '../helpers/research.js';

const T0 = '2026-11-15T10:00:00.000Z';
const ACTOR = 'tester';
/** Dates around the fixed clock: one that has passed in every time zone, one that has not come in any. */
const PAST = '2026-10-31';
const FUTURE = '2026-11-17';
/** Today as the code computes it: the calendar day of this machine (the fixed clock may be another day elsewhere). */
const localToday = (): string => {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
};

const opened: Store[] = [];
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(T0));
});
afterEach(() => {
  vi.useRealTimers();
  for (const s of opened.splice(0)) s.close();
});

const profileOf = (label: string): Record<string, PersonaProfileField> =>
  Object.fromEntries(STAKEHOLDER_FIELDS.map((f) => [f, { value: `${f} of ${label}`, confidence: 0.6, evidence: ['art_1'] }]));

function setup(configure?: (c: BifConfig) => void) {
  const dir = mkdtempSync(join(tmpdir(), 'bif-stk-pos-'));
  const t = researchSetup(opened, { dir, extraHandlers: () => stakeholderToolHandlers({ dataDir: dir }), ...(configure ? { config: configure } : {}) });
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
  const deps: PositionDeps = { store: t.store, dataDir: dir };
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
  const positions = (personaId?: string) => stakeholderRepos(t.store).positions.list(personaId ? { personaId } : {});
  const files = () =>
    ['ws_a', 'ws_b', 'ws_other'].flatMap((ws) => {
      const d = join(dir, ws, 'personas');
      return existsSync(d) ? readdirSync(d).sort().map((f) => `${ws}/${f}`) : [];
    });
  /** Everything an action may change: a refused action leaves it as it was. */
  const state = () =>
    JSON.stringify({
      personas: t.store.personas.list(), positions: positions(), feedback: listFeedback(t.store), competitors: t.store.competitors.list(),
      questions: stakeholderRepos(t.store).questions.list(), files: files(),
    });
  const events = () => listFeedback(t.store, { kind: 'stakeholder_position_change' });
  return { ...t, deps, stakeholder, positions, files, state, events };
}

/** The refusal of `fn`; `changed` is false when the store and the files are as they were. */
function refusal(t: ReturnType<typeof setup>, fn: () => unknown): { status: number; message: string; changed: boolean } {
  const before = t.state();
  try {
    fn();
  } catch (e) {
    if (e instanceof StakeholderError) return { status: e.status, message: e.message, changed: t.state() !== before };
    throw e;
  }
  throw new Error('expected a refusal');
}

// ---------------------------------------------------------------------------------------------------
describe('migration 28: storage', () => {
  it('a persona row round-trips the position columns, and a profile field its basis and conflict', () => {
    const t = setup();
    const p = t.store.personas.insert({
      id: 'per_x', workspaceId: 'ws_a', slug: 'stk-rival-pay-x', segment: 'X', version: 2, agentMdPath: '/x.md', kind: 'stakeholder',
      stakeholderType: 'manager', subjectKind: 'competitor', subjectId: 'cmp_rival', relation: '', disclosure: 'open',
      profile: { role_mandate: { value: 'v', confidence: 0.5, evidence: ['art_1'], basis: 'inferred', conflict: 'The site says otherwise.' } },
      leftAt: PAST,
      leftFrom: { workspaceId: 'ws_a', scopeName: 'Acme Group', stakeholderType: 'leader', title: 'Head of sales', relation: 'approves discounts' },
      positionTitle: 'VP Sales',
      internalProfile: { role_mandate: { value: 'i', confidence: 0.6, evidence: ['art_1'], basis: 'internal' } },
      publicProfile: { role_mandate: { value: 'p', confidence: 0.4, evidence: ['art_2'] } },
      publicTaskId: 'tsk_1', publicSavedAt: T0, combinedAt: T0,
      publicPosition: { text: 'VP Sales at Rival Pay', evidence: ['art_2'] },
    });
    expect(t.store.personas.get('per_x')).toMatchObject(p);
    t.store.personas.insert({ id: 'per_y', workspaceId: 'ws_a', slug: 'stk-y', segment: 'Y', version: 1, agentMdPath: '/y.md', kind: 'stakeholder', subjectKind: 'former', profile: {} });
    expect(t.store.personas.get('per_y')!.subjectKind).toBe('former');
  });

  it('a database stored before migration 28 keeps its personas, without any position field, and gets the history table', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'bif-stk-m28-')), 'bif.db');
    const raw = new DatabaseSync(path);
    for (const [i, m] of MIGRATIONS.slice(0, 27).entries()) {
      raw.exec(m);
      raw.exec(`PRAGMA user_version = ${i + 1}`);
    }
    raw.exec(
      `INSERT INTO personas (id, workspace_id, slug, segment, profile, agent_md_path, version, kind, subject_kind, relation)
       VALUES ('per_old', 'ws_a', 'stk-cfo', 'CFO', '{}', '/cfo.md', 3, 'stakeholder', 'own', 'approves')`,
    );
    raw.close();
    const store = openStore(path);
    opened.push(store);
    expect(store.schemaVersion()).toBe(MIGRATIONS.length);
    const old = store.personas.get('per_old')!;
    expect(old).toMatchObject({ slug: 'stk-cfo', subjectKind: 'own', version: 3 });
    for (const k of ['leftAt', 'leftFrom', 'positionTitle', 'internalProfile', 'publicProfile', 'publicTaskId', 'publicSavedAt', 'combinedAt', 'publicPosition']) {
      expect(old).not.toHaveProperty(k);
    }
    expect(stakeholderRepos(store).positions.list()).toEqual([]);
    expect(isFormerColleague(old)).toBe(false);
  });

  it('stakeholder_positions stores a row and refuses UPDATE and DELETE', () => {
    const t = setup();
    const repo = stakeholderRepos(t.store).positions;
    const row: StakeholderPosition = {
      id: 'spo_1', rootWorkspaceId: 'ws_a', personaId: 'per_x', change: 'left', placeKind: 'competitor', workspaceId: 'ws_a', competitorId: 'cmp_rival',
      companyName: 'Rival Pay', stakeholderType: 'leader', title: 'VP Sales', relation: 'approves discounts', effectiveOn: PAST, actor: ACTOR,
      note: 'Told us in the all-hands.', createdAt: T0,
    };
    repo.insert(row);
    expect(repo.get('spo_1')).toEqual(row);
    const minimal: StakeholderPosition = { id: 'spo_2', rootWorkspaceId: 'ws_a', personaId: 'per_x', change: 'joined', placeKind: 'node', actor: ACTOR, createdAt: T0 };
    repo.insert(minimal);
    expect(repo.get('spo_2')).toEqual(minimal);
    expect(POSITION_CHANGES).toEqual(['joined', 'moved', 'promoted', 'demoted', 'left', 'returned']);

    // The repository offers no way to change or remove a row; the table refuses it from anywhere else.
    expect(Object.keys(repo).sort()).toEqual(['get', 'insert', 'list']);
    for (const method of ['update', 'delete', 'upsert']) expect(repo).not.toHaveProperty(method);
    expect(() => t.store.db.exec("UPDATE stakeholder_positions SET note = 'changed' WHERE id = 'spo_1'")).toThrow(/append-only/);
    expect(() => t.store.db.exec("UPDATE stakeholder_positions SET actor = 'someone' WHERE id = 'spo_1'")).toThrow(/append-only/);
    expect(() => t.store.db.exec("DELETE FROM stakeholder_positions WHERE id = 'spo_1'")).toThrow(/append-only/);
    expect(() => t.store.db.exec('DELETE FROM stakeholder_positions')).toThrow(/append-only/);
    expect(repo.list()).toEqual([row, minimal]);
  });

  it('settings: maxFollowed defaults to 5 and may be 0; the feedback kind exists and is neutral', () => {
    expect(stakeholdersSettings({}).maxFollowed).toBe(5);
    expect(stakeholdersSettings({ stakeholders: { maxFollowed: 0 } }).maxFollowed).toBe(0);
    const base = structuredClone(defaultConfig);
    expect(bifConfigSchema.safeParse({ ...base, stakeholders: { maxFollowed: 0 } }).success).toBe(true);
    expect(bifConfigSchema.safeParse({ ...base, stakeholders: { maxFollowed: -1 } }).success).toBe(false);
    expect(bifConfigSchema.safeParse({ ...base, stakeholders: { maxFollowed: 1.5 } }).success).toBe(false);
    expect(FEEDBACK_KINDS).toContain('stakeholder_position_change');
    expect(STANCE_BY_KIND.stakeholder_position_change).toBe('neutral');
  });
});

// ---------------------------------------------------------------------------------------------------
describe('who is a former colleague, and whose text is internal', () => {
  it('isFormerColleague: a stakeholder with a leaving date', () => {
    expect(isFormerColleague({ kind: 'stakeholder', leftAt: PAST })).toBe(true);
    expect(isFormerColleague({ kind: 'stakeholder' })).toBe(false);
    expect(isFormerColleague({ kind: 'segment', leftAt: PAST })).toBe(false);
    expect(isFormerColleague({ leftAt: PAST })).toBe(false);
  });

  it('holdsInternal: every stakeholder persona except a competitor\'s stakeholder that never worked here', () => {
    expect(holdsInternal({ kind: 'stakeholder', subjectKind: 'own' })).toBe(true);
    expect(holdsInternal({ kind: 'stakeholder' })).toBe(true);
    expect(holdsInternal({ kind: 'stakeholder', subjectKind: 'former', leftAt: PAST })).toBe(true);
    expect(holdsInternal({ kind: 'stakeholder', subjectKind: 'former' })).toBe(true);
    expect(holdsInternal({ kind: 'stakeholder', subjectKind: 'competitor', leftAt: PAST })).toBe(true);
    expect(holdsInternal({ kind: 'stakeholder', subjectKind: 'competitor' })).toBe(false);
    expect(holdsInternal({ kind: 'segment' })).toBe(false);
    expect(holdsInternal({})).toBe(false);
  });

  it('isParked: a stakeholder that went somewhere that is no competitor', () => {
    expect(isParked({ kind: 'stakeholder', subjectKind: 'former' })).toBe(true);
    expect(isParked({ kind: 'stakeholder', subjectKind: 'competitor' })).toBe(false);
    expect(isParked({ kind: 'stakeholder', subjectKind: 'own' })).toBe(false);
    expect(isParked({ kind: 'segment', subjectKind: 'former' })).toBe(false);
    expect(isParked({})).toBe(false);
  });

  it('formerColleagues: those of the node, not superseded, by slug', () => {
    const t = setup();
    t.stakeholder('Head of finance');
    const sales = t.stakeholder('Head of sales');
    const legal = t.stakeholder('Head of legal');
    const ops = t.stakeholder('Head of ops');
    const child = t.stakeholder('Head of risk', {}, 'ws_b');
    t.stakeholder('CEO', { slug: 'stk-rival-pay-ceo', subjectKind: 'competitor', subjectId: 'cmp_rival' });
    markLeft(t.deps, ACTOR, 'ws_a', sales.id, { date: PAST, to: { competitorId: 'cmp_rival' } });
    markLeft(t.deps, ACTOR, 'ws_a', legal.id, { date: PAST, to: { elsewhere: {} } });
    markLeft(t.deps, ACTOR, 'ws_a', ops.id, { date: PAST, to: { elsewhere: {} } });
    markLeft(t.deps, ACTOR, 'ws_a', child.id, { date: PAST, to: { elsewhere: {} } });
    t.store.personas.update(ops.id, { status: 'superseded' });
    expect(formerColleagues(t.store, 'ws_a').map((p) => p.slug)).toEqual(['stk-head-of-legal', 'stk-rival-pay-head-of-sales']);
    expect(formerColleagues(t.store, 'ws_b').map((p) => p.id)).toEqual([child.id]);
    expect(formerColleagues(t.store, 'ws_other')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------------
describe('markLeft', () => {
  it('to a competitor of the tree: the persona becomes that competitor\'s stakeholder and keeps what was known as its internal layer', () => {
    const t = setup();
    const before = t.stakeholder('Head of sales', { positionTitle: 'Head of Sales EMEA' });
    stakeholderRepos(t.store).questions.insert({
      id: 'stq_1', rootWorkspaceId: 'ws_a', workspaceId: 'ws_a', personaId: before.id, field: 'objections', text: 'What makes them hesitate?', status: 'open', createdAt: T0,
    });
    stakeholderRepos(t.store).questions.insert({
      id: 'stq_2', rootWorkspaceId: 'ws_a', workspaceId: 'ws_a', personaId: before.id, field: 'dependencies', text: 'What do you need?', status: 'answered', createdAt: T0,
    });

    const after = markLeft(t.deps, ACTOR, 'ws_a', before.id, {
      date: PAST, to: { competitorId: 'cmp_rival' }, title: '  VP  Sales\n', note: '  Announced at the all-hands.  ',
    });

    expect(after).toEqual(t.store.personas.get(before.id));
    expect(after).toMatchObject({
      id: before.id, workspaceId: 'ws_a', segment: 'Head of sales', slug: 'stk-rival-pay-head-of-sales', subjectKind: 'competitor', subjectId: 'cmp_rival',
      leftAt: PAST, positionTitle: 'VP Sales', relation: 'VP Sales', version: 2, status: 'verified', disclosure: 'open', stakeholderType: 'leader',
      agentMdPath: agentMdPath(t.dir, 'ws_a', 'stk-rival-pay-head-of-sales'),
      leftFrom: { workspaceId: 'ws_a', scopeName: 'Acme Group', stakeholderType: 'leader', title: 'Head of Sales EMEA', relation: 'approves the budget (Head of sales)' },
    });
    // Every profile field rests on internal knowledge, and the internal layer is a copy of the profile.
    for (const f of STAKEHOLDER_FIELDS) {
      expect(after.profile[f]).toEqual({ value: `${f} of Head of sales`, confidence: 0.6, evidence: ['art_1'], basis: 'internal' });
    }
    expect(after.internalProfile).toEqual(after.profile);
    expect(after).not.toHaveProperty('publicProfile');
    expect(after).not.toHaveProperty('combinedAt');
    expect(isFormerColleague(after)).toBe(true);

    // Open questions are closed as skipped; an answered one stays.
    expect(stakeholderRepos(t.store).questions.get('stq_1')!.status).toBe('skipped');
    expect(stakeholderRepos(t.store).questions.get('stq_2')!.status).toBe('answered');

    // agent.md: the new path holds the new version.
    const md = readFileSync(after.agentMdPath, 'utf8');
    expect(md).toContain('name: stk-rival-pay-head-of-sales');
    expect(md).toContain('version: 2');
    expect(md).toContain('former_colleague: true');
    expect(t.files()).toContain('ws_a/stk-rival-pay-head-of-sales.v2.md');

    // History: where the person was (no date), then the change; newest first.
    const history = positionsOf(t.store, before.id);
    expect(history.map((h) => h.change)).toEqual(['left', 'joined']);
    expect(history[1]).toMatchObject({
      rootWorkspaceId: 'ws_a', personaId: before.id, placeKind: 'node', workspaceId: 'ws_a', stakeholderType: 'leader', title: 'Head of Sales EMEA',
      relation: 'approves the budget (Head of sales)', actor: ACTOR,
    });
    expect(history[1]).not.toHaveProperty('effectiveOn');
    expect(history[0]).toMatchObject({
      rootWorkspaceId: 'ws_a', personaId: before.id, placeKind: 'competitor', competitorId: 'cmp_rival', stakeholderType: 'leader', title: 'VP Sales',
      effectiveOn: PAST, actor: ACTOR, note: 'Announced at the all-hands.',
    });
    for (const h of history) expect(h.id).toMatch(/^spo_/);

    // One feedback event: ids, enums and the date; the note as its reason; no label and no title.
    const ev = t.events();
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({
      workspaceId: 'ws_a', actor: ACTOR, targetType: 'stakeholder', targetId: before.id, reason: 'Announced at the all-hands.',
      afterJson: { change: 'left', placeKind: 'competitor', personaId: before.id, workspaceId: 'ws_a', competitorId: 'cmp_rival', date: PAST },
    });
    const { reason: _reason, ...rest } = ev[0]!;
    expect(JSON.stringify(rest)).not.toMatch(/Head of sales|VP Sales|all-hands/);
  });

  it('a competitor of another node of the tree is accepted; a new label renames the persona', () => {
    const t = setup();
    const p = t.stakeholder('Head of sales');
    const after = markLeft(t.deps, ACTOR, 'ws_b', p.id, { date: PAST, to: { competitorId: 'cmp_child' }, label: '  The\tsales lead ' });
    expect(after).toMatchObject({ segment: 'The sales lead', slug: 'stk-child-rival-the-sales-lead', subjectId: 'cmp_child', workspaceId: 'ws_a', relation: '' });
    expect(after).not.toHaveProperty('positionTitle');
    expect(after.leftFrom).toEqual({ workspaceId: 'ws_a', scopeName: 'Acme Group', stakeholderType: 'leader', relation: 'approves the budget (Head of sales)' });
    expect(positionsOf(t.store, p.id)[0]).not.toHaveProperty('note');
    expect(t.events()[0]).not.toHaveProperty('reason');
  });

  it('to a new competitor by name: the competitor is created at the node, rated 1 and 1, unverified, linked in the knowledge store', () => {
    const t = setup();
    const p = t.stakeholder('Head of sales', {}, 'ws_b');
    const after = markLeft(t.deps, ACTOR, 'ws_a', p.id, { date: PAST, to: { newCompetitor: { name: '  New   Rival ', site: ' newrival.test ' } } });
    const created = t.store.competitors.list({ workspaceId: 'ws_b' }).find((c) => c.name === 'New Rival')!;
    expect(created).toMatchObject({ workspaceId: 'ws_b', name: 'New Rival', site: 'newrival.test', threat: 1, directness: 1, comparison: {}, evidence: [], status: 'unverified' });
    expect(created.id).toMatch(/^cmp_/);
    expect(created).not.toHaveProperty('taskId');
    expect(knowledgeRepos(t.store).entities.get(created.entityId!)).toMatchObject({ kind: 'competitor', name: 'New Rival' });
    expect(after).toMatchObject({ subjectKind: 'competitor', subjectId: created.id, slug: 'stk-new-rival-head-of-sales', workspaceId: 'ws_b' });
    expect(positionsOf(t.store, p.id)[0]).toMatchObject({ change: 'left', placeKind: 'competitor', competitorId: created.id });
    expect(t.events()[0]!.afterJson).toMatchObject({ competitorId: created.id, workspaceId: 'ws_b' });
    expect(readFileSync(after.agentMdPath, 'utf8')).toContain('at New Rival, a rival of Acme Payments');
  });

  it('a new competitor whose name the node already has is that competitor (no second row): a live one as it is, a superseded one reset to an unresearched one', () => {
    const t = setup();
    const a = t.stakeholder('Head of sales');
    const b = t.stakeholder('Head of legal');
    t.store.competitors.update('cmp_rival', { evidence: ['art_1'], taskId: 'tsk_live', taskRound: 1 });
    t.store.competitors.update('cmp_gone', { evidence: ['art_1'], taskId: 'tsk_old', taskRound: 2, site: 'gone.test' });
    const live = t.store.competitors.get('cmp_rival')!;
    const count = t.store.competitors.list().length;

    expect(markLeft(t.deps, ACTOR, 'ws_a', a.id, { date: PAST, to: { newCompetitor: { name: 'rival  PAY' } } }).subjectId).toBe('cmp_rival');
    expect(t.store.competitors.get('cmp_rival')).toEqual(live);

    expect(markLeft(t.deps, ACTOR, 'ws_a', b.id, { date: PAST, to: { newCompetitor: { name: 'Gone Corp' } } }).subjectId).toBe('cmp_gone');
    const reset = t.store.competitors.get('cmp_gone')!;
    // What research once rated was withdrawn: nothing of it comes back with the row.
    expect(reset).toMatchObject({ id: 'cmp_gone', name: 'Gone Corp', site: 'gone.test', status: 'unverified', threat: 1, directness: 1, comparison: {}, evidence: [] });
    expect(reset).not.toHaveProperty('taskId');
    expect(reset).not.toHaveProperty('taskRound');
    expect(t.store.competitors.list()).toHaveLength(count);
  });

  it('elsewhere: the persona is parked under its slug, with the company name in the history only', () => {
    const t = setup();
    const p = t.stakeholder('Head of legal');
    const after = markLeft(t.deps, ACTOR, 'ws_a', p.id, { date: PAST, to: { elsewhere: { companyName: ' A  law firm ' } }, label: 'The legal lead', title: 'Partner' });
    expect(after).toMatchObject({
      subjectKind: 'former', slug: 'stk-head-of-legal', segment: 'The legal lead', leftAt: PAST, positionTitle: 'Partner', relation: 'Partner', version: 2,
      agentMdPath: p.agentMdPath,
    });
    expect(after).not.toHaveProperty('subjectId');
    expect(after.internalProfile).toEqual(after.profile);
    expect(after.profile.role_mandate!.basis).toBe('internal');
    const [left, joined] = positionsOf(t.store, p.id);
    expect(left).toMatchObject({ change: 'left', placeKind: 'elsewhere', companyName: 'A law firm', title: 'Partner', effectiveOn: PAST });
    expect(left).not.toHaveProperty('competitorId');
    expect(joined).toMatchObject({ change: 'joined', placeKind: 'node', workspaceId: 'ws_a' });
    expect(t.events()[0]!.afterJson).toEqual({ change: 'left', placeKind: 'elsewhere', personaId: p.id, workspaceId: 'ws_a', date: PAST });
    expect(JSON.stringify(t.events()[0])).not.toContain('law firm');
    expect(readFileSync(after.agentMdPath, 'utf8')).toContain(`You left Acme Group on ${PAST}`);

    const bare = markLeft(t.deps, ACTOR, 'ws_a', t.stakeholder('Head of ops').id, { date: PAST, to: { elsewhere: {} } });
    expect(positionsOf(t.store, bare.id)[0]).not.toHaveProperty('companyName');
  });

  it('a parked former colleague is given a competitor later ("attach") and keeps its leaving date and layers', () => {
    const t = setup();
    const p = t.stakeholder('Head of legal');
    const parked = markLeft(t.deps, ACTOR, 'ws_a', p.id, { date: '2026-09-30', to: { elsewhere: { companyName: 'Unknown' } } });
    // What the combine run will have written by then stays as it is.
    const combined = { ...parked.profile, role_mandate: { ...parked.profile.role_mandate!, value: 'Now advises on deals', basis: 'both' as const } };
    t.store.personas.update(p.id, { profile: combined, publicProfile: { role_mandate: { value: 'p', confidence: 0.3, evidence: ['art_9'] } }, publicSavedAt: T0, combinedAt: T0 });

    const after = markLeft(t.deps, ACTOR, 'ws_a', p.id, { date: PAST, to: { competitorId: 'cmp_rival' }, title: 'General counsel' });
    expect(after).toMatchObject({
      subjectKind: 'competitor', subjectId: 'cmp_rival', slug: 'stk-rival-pay-head-of-legal', leftAt: '2026-09-30', version: 3, positionTitle: 'General counsel',
      relation: 'General counsel', publicSavedAt: T0, combinedAt: T0,
    });
    expect(after.leftFrom).toEqual(parked.leftFrom);
    expect(after.internalProfile).toEqual(parked.internalProfile);
    expect(after.profile).toEqual(combined);
    expect(after.publicProfile).toEqual({ role_mandate: { value: 'p', confidence: 0.3, evidence: ['art_9'] } });
    expect(positionsOf(t.store, p.id).map((h) => `${h.change}:${h.placeKind}:${h.effectiveOn ?? ''}`)).toEqual([
      `moved:competitor:${PAST}`, 'left:elsewhere:2026-09-30', 'joined:node:',
    ]);
    expect(t.events()).toHaveLength(2);
    expect(t.events().at(-1)!.afterJson).toEqual({ change: 'moved', placeKind: 'competitor', personaId: p.id, workspaceId: 'ws_a', competitorId: 'cmp_rival', date: PAST });
  });

  it('404: an unknown persona, one of another tree, a segment persona; an unknown, superseded or foreign competitor', () => {
    const t = setup();
    const p = t.stakeholder('Head of sales');
    const foreign = t.stakeholder('Director', {}, 'ws_other');
    t.store.personas.insert({ id: 'per_seg', workspaceId: 'ws_a', slug: 'seg', segment: 'SMB', profile: {}, agentMdPath: '/seg.md', version: 1 });
    const left = (workspaceId: string, personaId: string, to: Parameters<typeof markLeft>[4]['to'] = { competitorId: 'cmp_rival' }) =>
      refusal(t, () => markLeft(t.deps, ACTOR, workspaceId, personaId, { date: PAST, to }));
    expect(left('ws_a', 'per_nope')).toMatchObject({ status: 404, changed: false });
    expect(left('ws_a', foreign.id)).toMatchObject({ status: 404, changed: false });
    expect(left('ws_other', p.id)).toMatchObject({ status: 404, changed: false });
    expect(left('ws_nope', p.id)).toMatchObject({ status: 404, changed: false });
    expect(left('ws_a', 'per_seg')).toMatchObject({ status: 404, changed: false });
    // An id of another tree answers exactly like an unknown one.
    expect(left('ws_a', foreign.id).message).toBe(left('ws_a', 'per_nope').message.replace('per_nope', foreign.id));
    expect(left('ws_a', p.id, { competitorId: 'cmp_nope' })).toMatchObject({ status: 404, changed: false });
    expect(left('ws_a', p.id, { competitorId: 'cmp_gone' })).toMatchObject({ status: 404, changed: false });
    expect(left('ws_a', p.id, { competitorId: 'cmp_foreign' })).toMatchObject({ status: 404, changed: false });
    expect(left('ws_a', p.id, { competitorId: 'cmp_foreign' }).message).toBe(left('ws_a', p.id, { competitorId: 'cmp_nope' }).message.replace('cmp_nope', 'cmp_foreign'));
  });

  it('409: a hidden stakeholder; a slug another persona of the node uses, naming its label, and nothing changes', () => {
    const t = setup();
    const hidden = t.stakeholder('Head of finance', { disclosure: 'hidden' });
    const r = refusal(t, () => markLeft(t.deps, ACTOR, 'ws_a', hidden.id, { date: PAST, to: { elsewhere: {} } }));
    expect(r).toMatchObject({ status: 409, changed: false });
    expect(r.message).toMatch(/answer or skip its questions first/);
    // Hidden comes first: the answer for a hidden stakeholder says nothing about the state of its research.
    for (const status of ['pending', 'failed', 'unverified', 'superseded'] as const) {
      const unusable = t.stakeholder(`Hidden ${status}`, { disclosure: 'hidden', status });
      const answers = [
        refusal(t, () => markLeft(t.deps, ACTOR, 'ws_a', unusable.id, { date: PAST, to: { elsewhere: {} } })),
        refusal(t, () => changePosition(t.deps, ACTOR, 'ws_a', unusable.id, { change: 'promoted', date: PAST })),
        refusal(t, () => markReturned(t.deps, ACTOR, 'ws_a', unusable.id, { date: PAST, toWorkspaceId: 'ws_a' })),
      ];
      for (const a of answers) {
        expect(a, status).toMatchObject({ status: 409, changed: false });
        expect(a.message, status).toBe(r.message.replace(hidden.id, unusable.id));
        expect(a.message, status).not.toMatch(/research/);
      }
    }

    const p = t.stakeholder('Head of sales');
    t.stakeholder('Chief of Sales', { slug: 'stk-rival-pay-head-of-sales', subjectKind: 'competitor', subjectId: 'cmp_rival' });
    const conflict = refusal(t, () => markLeft(t.deps, ACTOR, 'ws_a', p.id, { date: PAST, to: { competitorId: 'cmp_rival' }, note: 'n' }));
    expect(conflict).toMatchObject({ status: 409, changed: false });
    expect(conflict.message).toContain('Chief of Sales');
    expect(conflict.message).toContain('stk-rival-pay-head-of-sales');
    expect(t.store.personas.get(p.id)).toEqual(p);
    expect(t.positions()).toEqual([]);
    expect(t.events()).toEqual([]);

    // A new competitor made for the action is rolled back with it.
    t.stakeholder('Someone', { slug: 'stk-brand-new-head-of-sales', subjectKind: 'competitor', subjectId: 'cmp_rival' });
    const rolled = refusal(t, () => markLeft(t.deps, ACTOR, 'ws_a', p.id, { date: PAST, to: { newCompetitor: { name: 'Brand New' } } }));
    expect(rolled).toMatchObject({ status: 409, changed: false });
    expect(t.store.competitors.list().some((c) => c.name === 'Brand New')).toBe(false);

    // Another label avoids the conflict.
    expect(markLeft(t.deps, ACTOR, 'ws_a', p.id, { date: PAST, to: { competitorId: 'cmp_rival' }, label: 'Second sales head' }).slug).toBe('stk-rival-pay-second-sales-head');
  });

  it('400: a date that is no date or lies in the future', () => {
    const t = setup();
    const p = t.stakeholder('Head of sales');
    for (const date of ['', '15.11.2026', '2026-13-01', '2026-02-30', '2026-11-1', ' 2026-10-31', '2026-10-31T00:00:00Z', FUTURE, 20261031 as unknown as string, undefined as unknown as string]) {
      const r = refusal(t, () => markLeft(t.deps, ACTOR, 'ws_a', p.id, { date, to: { elsewhere: {} } }));
      expect(r, String(date)).toMatchObject({ status: 400, changed: false });
      expect(r.message).toMatch(/^date/);
    }
    // Today itself is no future date.
    expect(markLeft(t.deps, ACTOR, 'ws_a', p.id, { date: localToday(), to: { elsewhere: {} } }).leftAt).toBe(localToday());
  });

  it('400: a competitor\'s stakeholder that never worked here cannot leave', () => {
    const t = setup();
    const rival = t.stakeholder('CEO', { slug: 'stk-rival-pay-ceo', subjectKind: 'competitor', subjectId: 'cmp_rival' });
    for (const to of [{ elsewhere: {} }, { competitorId: 'cmp_child' }, { newCompetitor: { name: 'New Rival' } }]) {
      const r = refusal(t, () => markLeft(t.deps, ACTOR, 'ws_a', rival.id, { date: PAST, to }));
      expect(r).toMatchObject({ status: 400, changed: false });
      expect(r.message).toMatch(/only an own stakeholder can leave/);
    }
  });

  it('400: an empty or too long text, a label without letters, a destination that is none', () => {
    const t = setup();
    const p = t.stakeholder('Head of sales');
    const left = (input: Partial<Parameters<typeof markLeft>[4]>) =>
      refusal(t, () => markLeft(t.deps, ACTOR, 'ws_a', p.id, { date: PAST, to: { competitorId: 'cmp_rival' }, ...input }));
    expect(left({ label: ' \n ' })).toMatchObject({ status: 400, changed: false });
    expect(left({ label: 'x'.repeat(81) })).toMatchObject({ status: 400, changed: false });
    expect(left({ label: '!!!' })).toMatchObject({ status: 400, changed: false });
    expect(left({ label: 7 as unknown as string })).toMatchObject({ status: 400, changed: false });
    expect(left({ title: 'x'.repeat(301) })).toMatchObject({ status: 400, changed: false });
    expect(left({ note: 'x'.repeat(2001) })).toMatchObject({ status: 400, changed: false });
    expect(left({ note: 5 as unknown as string })).toMatchObject({ status: 400, changed: false });
    expect(left({ to: { newCompetitor: { name: '   ' } } })).toMatchObject({ status: 400, changed: false });
    expect(left({ to: { newCompetitor: { name: 'x'.repeat(81) } } })).toMatchObject({ status: 400, changed: false });
    expect(left({ to: { newCompetitor: { name: 'Fine', site: 'x'.repeat(301) } } })).toMatchObject({ status: 400, changed: false });
    expect(left({ to: { elsewhere: { companyName: 'x'.repeat(81) } } })).toMatchObject({ status: 400, changed: false });
    expect(left({ to: {} as never })).toMatchObject({ status: 400, changed: false });
    expect(left({ to: undefined as never })).toMatchObject({ status: 400, changed: false });
    expect(left({ to: { competitorId: 'cmp_rival', elsewhere: {} } as never })).toMatchObject({ status: 400, changed: false });
    // The longest texts allowed pass.
    const ok = markLeft(t.deps, ACTOR, 'ws_a', p.id, { date: PAST, to: { elsewhere: { companyName: 'c'.repeat(80) } }, label: 'l'.repeat(80), title: 't'.repeat(300), note: 'n'.repeat(2000) });
    expect(ok.segment).toHaveLength(80);
  });

  it('the note is cleaned like other reasons: identity secrets are redacted', () => {
    const t = setup();
    t.store.identities.insert({ id: 'idn_1', workspaceId: 'ws_a', site: 'x.test', name: 'n', email: 'n@x.test', password: 'Zq9xK2mPw7Lr', createdAt: T0 });
    const p = t.stakeholder('Head of sales');
    markLeft(t.deps, ACTOR, 'ws_a', p.id, { date: PAST, to: { elsewhere: {} }, note: 'Their login was Zq9xK2mPw7Lr' });
    expect(JSON.stringify([positionsOf(t.store, p.id), t.events()])).not.toContain('Zq9xK2mPw7Lr');
    expect(positionsOf(t.store, p.id)[0]!.note).toContain('Their login was');
  });
});

// ---------------------------------------------------------------------------------------------------
describe('markLeft for a former colleague: moved on to another company', () => {
  /** A former colleague at Rival Pay, followed and combined since: everything a move must keep. */
  const followed = (t: ReturnType<typeof setup>, label = 'Head of sales') => {
    const gone = markLeft(t.deps, ACTOR, 'ws_a', t.stakeholder(label, { positionTitle: 'Head of Sales EMEA' }).id, {
      date: '2026-09-30', to: { competitorId: 'cmp_rival' }, title: 'VP Sales',
    });
    const combined = { ...gone.profile, role_mandate: { ...gone.profile.role_mandate!, value: 'Now sells against us', basis: 'both' as const } };
    return t.store.personas.update(gone.id, {
      profile: combined, publicProfile: { role_mandate: { value: 'p', confidence: 0.3, evidence: ['art_9'], basis: 'public' } }, publicTaskId: 'tsk_1', publicSavedAt: T0,
      combinedAt: T0, publicPosition: { text: 'Chief revenue officer at Child Rival', evidence: ['art_9'], taskId: 'tsk_1' },
    });
  };
  /** What a move never touches. */
  const kept = (p: Persona) => ({
    leftAt: p.leftAt, leftFrom: p.leftFrom, internalProfile: p.internalProfile, publicProfile: p.publicProfile, publicTaskId: p.publicTaskId,
    publicSavedAt: p.publicSavedAt, combinedAt: p.combinedAt, publicPosition: p.publicPosition, profile: p.profile, workspaceId: p.workspaceId, segment: p.segment,
    stakeholderType: p.stakeholderType, status: p.status, disclosure: p.disclosure,
  });
  const rows = (t: ReturnType<typeof setup>, personaId: string) => positionsOf(t.store, personaId).map((h) => `${h.change}:${h.placeKind}:${h.effectiveOn ?? ''}`);

  it('from a competitor to another competitor of the tree: the persona is that competitor\'s, both layers and the leaving date are kept, the row is moved', () => {
    const t = setup();
    const before = followed(t);
    const after = markLeft(t.deps, ACTOR, 'ws_a', before.id, { date: PAST, to: { competitorId: 'cmp_child' }, title: 'Chief revenue officer', note: 'Seen in the press.' });
    expect(after).toMatchObject({
      subjectKind: 'competitor', subjectId: 'cmp_child', slug: 'stk-child-rival-head-of-sales', version: before.version + 1, positionTitle: 'Chief revenue officer',
      relation: 'Chief revenue officer', agentMdPath: agentMdPath(t.dir, 'ws_a', 'stk-child-rival-head-of-sales'),
    });
    expect(kept(after)).toEqual(kept(before));
    expect(after.leftAt).toBe('2026-09-30');
    expect(after.leftFrom).toMatchObject({ title: 'Head of Sales EMEA', scopeName: 'Acme Group' });
    expect(isFormerColleague(after) && !isParked(after) && holdsInternal(after)).toBe(true);

    expect(rows(t, before.id)).toEqual([`moved:competitor:${PAST}`, 'left:competitor:2026-09-30', 'joined:node:']);
    expect(positionsOf(t.store, before.id)[0]).toMatchObject({
      competitorId: 'cmp_child', title: 'Chief revenue officer', stakeholderType: 'leader', actor: ACTOR, note: 'Seen in the press.',
    });
    const ev = t.events();
    expect(ev).toHaveLength(2);
    expect(ev[1]).toMatchObject({
      actor: ACTOR, targetId: before.id, reason: 'Seen in the press.',
      afterJson: { change: 'moved', placeKind: 'competitor', personaId: before.id, workspaceId: 'ws_a', competitorId: 'cmp_child', date: PAST },
    });

    // agent.md follows the new place and still says what the person knew when they left.
    const md = readFileSync(after.agentMdPath, 'utf8');
    expect(md).toContain('name: stk-child-rival-head-of-sales');
    expect(md).toContain('former_colleague: true');
    expect(md).toContain('Child Rival');
    expect(md).toContain('2026-09-30');
    expect(md).toContain(`version: ${after.version}`);
    expect(formerColleagues(t.store, 'ws_a').map((p) => p.id)).toEqual([before.id]);
  });

  it('to a company not listed: the competitor is created as for someone leaving; a new label renames the persona', () => {
    const t = setup();
    const before = followed(t);
    const after = markLeft(t.deps, ACTOR, 'ws_a', before.id, { date: PAST, to: { newCompetitor: { name: 'New Rival', site: 'newrival.test' } }, label: 'The sales lead' });
    const created = t.store.competitors.list({ workspaceId: 'ws_a' }).find((c) => c.name === 'New Rival')!;
    expect(created).toMatchObject({ threat: 1, directness: 1, status: 'unverified', site: 'newrival.test' });
    expect(after).toMatchObject({ subjectKind: 'competitor', subjectId: created.id, slug: 'stk-new-rival-the-sales-lead', segment: 'The sales lead', relation: '' });
    expect(after).not.toHaveProperty('positionTitle');
    expect(kept({ ...after, segment: before.segment })).toEqual(kept(before));
    expect(rows(t, before.id)[0]).toBe(`moved:competitor:${PAST}`);
  });

  it('from a competitor to somewhere that is no competitor: parked under the slug of its label, the company name in the history', () => {
    const t = setup();
    const before = followed(t);
    const after = markLeft(t.deps, ACTOR, 'ws_a', before.id, { date: PAST, to: { elsewhere: { companyName: 'A consultancy' } }, title: 'Partner' });
    expect(after).toMatchObject({ subjectKind: 'former', slug: 'stk-head-of-sales', positionTitle: 'Partner', relation: 'Partner', version: before.version + 1 });
    expect(after).not.toHaveProperty('subjectId');
    expect(isParked(after)).toBe(true);
    expect(kept(after)).toEqual(kept(before));
    expect(positionsOf(t.store, before.id)[0]).toMatchObject({ change: 'moved', placeKind: 'elsewhere', companyName: 'A consultancy', title: 'Partner', effectiveOn: PAST });
    expect(positionsOf(t.store, before.id)[0]).not.toHaveProperty('competitorId');
    expect(t.events()[1]!.afterJson).toEqual({ change: 'moved', placeKind: 'elsewhere', personaId: before.id, workspaceId: 'ws_a', date: PAST });
    expect(wentTo(t.store, after)).toBe('A consultancy');
    expect(readFileSync(after.agentMdPath, 'utf8')).toContain('You left Acme Group on 2026-09-30');
    expect(readFileSync(after.agentMdPath, 'utf8')).not.toContain('former_colleague: true');
  });

  it('a parked former colleague goes to another company that is no competitor: the slug stays, where they went is the newest row', () => {
    const t = setup();
    const parked = markLeft(t.deps, ACTOR, 'ws_a', t.stakeholder('Head of legal').id, { date: '2026-09-30', to: { elsewhere: { companyName: 'A law firm' } } });
    expect(wentTo(t.store, parked)).toBe('A law firm');
    const after = markLeft(t.deps, ACTOR, 'ws_a', parked.id, { date: PAST, to: { elsewhere: { companyName: 'Another firm' } } });
    expect(after).toMatchObject({ subjectKind: 'former', slug: parked.slug, agentMdPath: parked.agentMdPath, leftAt: '2026-09-30', version: parked.version + 1 });
    expect(kept(after)).toEqual(kept(parked));
    expect(rows(t, parked.id)).toEqual([`moved:elsewhere:${PAST}`, 'left:elsewhere:2026-09-30', 'joined:node:']);
    expect(wentTo(t.store, after)).toBe('Another firm');
    // On to a company the user does not name: the old name is not carried over.
    const unnamed = markLeft(t.deps, ACTOR, 'ws_a', parked.id, { date: PAST, to: { elsewhere: {} } });
    expect(wentTo(t.store, unnamed)).toBeUndefined();
    // Back at a competitor, where they went is the competitor.
    const attached = markLeft(t.deps, ACTOR, 'ws_a', parked.id, { date: PAST, to: { competitorId: 'cmp_rival' } });
    expect(wentTo(t.store, attached)).toBe('Rival Pay');
  });

  it('400: the place the person is at already, and nothing changes', () => {
    const t = setup();
    const gone = followed(t);
    const same = refusal(t, () => markLeft(t.deps, ACTOR, 'ws_a', gone.id, { date: PAST, to: { competitorId: 'cmp_rival' } }));
    expect(same).toMatchObject({ status: 400, changed: false });
    expect(same.message).toMatch(/is at that company already/);
    // By name too: the competitor of that name is the one they are at.
    expect(refusal(t, () => markLeft(t.deps, ACTOR, 'ws_a', gone.id, { date: PAST, to: { newCompetitor: { name: 'rival pay' } } }))).toMatchObject({ status: 400, changed: false });

    const parked = markLeft(t.deps, ACTOR, 'ws_a', t.stakeholder('Head of legal').id, { date: PAST, to: { elsewhere: { companyName: 'A law firm' } } });
    expect(refusal(t, () => markLeft(t.deps, ACTOR, 'ws_a', parked.id, { date: PAST, to: { elsewhere: { companyName: ' A  law firm ' } } }))).toMatchObject({ status: 400, changed: false });
    const nameless = markLeft(t.deps, ACTOR, 'ws_a', t.stakeholder('Head of ops').id, { date: PAST, to: { elsewhere: {} } });
    expect(refusal(t, () => markLeft(t.deps, ACTOR, 'ws_a', nameless.id, { date: PAST, to: { elsewhere: {} } }))).toMatchObject({ status: 400, changed: false });
  });

  it('the refusals of leaving hold: 404 for a competitor of another tree or a superseded one, 409 for a slug in use (rolled back), 400 for a bad date', () => {
    const t = setup();
    const gone = followed(t);
    for (const competitorId of ['cmp_nope', 'cmp_gone', 'cmp_foreign']) {
      expect(refusal(t, () => markLeft(t.deps, ACTOR, 'ws_a', gone.id, { date: PAST, to: { competitorId } })), competitorId).toMatchObject({ status: 404, changed: false });
    }
    expect(refusal(t, () => markLeft(t.deps, ACTOR, 'ws_other', gone.id, { date: PAST, to: { elsewhere: {} } }))).toMatchObject({ status: 404, changed: false });
    expect(refusal(t, () => markLeft(t.deps, ACTOR, 'ws_a', gone.id, { date: FUTURE, to: { elsewhere: {} } }))).toMatchObject({ status: 400, changed: false });

    // The slug at the new place is taken: at a competitor, at a company created for the move, and when parked.
    t.stakeholder('Sales chief', { slug: 'stk-child-rival-head-of-sales', subjectKind: 'competitor', subjectId: 'cmp_child' });
    const conflict = refusal(t, () => markLeft(t.deps, ACTOR, 'ws_a', gone.id, { date: PAST, to: { competitorId: 'cmp_child' } }));
    expect(conflict).toMatchObject({ status: 409, changed: false });
    expect(conflict.message).toContain('Sales chief');
    t.stakeholder('Someone', { slug: 'stk-brand-new-head-of-sales', subjectKind: 'competitor', subjectId: 'cmp_rival' });
    expect(refusal(t, () => markLeft(t.deps, ACTOR, 'ws_a', gone.id, { date: PAST, to: { newCompetitor: { name: 'Brand New' } } }))).toMatchObject({ status: 409, changed: false });
    expect(t.store.competitors.list().some((c) => c.name === 'Brand New')).toBe(false);
    // Their successor here holds the own slug by now.
    t.stakeholder('Head of sales');
    expect(refusal(t, () => markLeft(t.deps, ACTOR, 'ws_a', gone.id, { date: PAST, to: { elsewhere: {} } }))).toMatchObject({ status: 409, changed: false });
    expect(rows(t, gone.id)).toEqual(['left:competitor:2026-09-30', 'joined:node:']);
    // Another label avoids the conflict.
    expect(markLeft(t.deps, ACTOR, 'ws_a', gone.id, { date: PAST, to: { elsewhere: {} }, label: 'Former sales head' }).slug).toBe('stk-former-sales-head');
  });

  it('a hidden or unusable former colleague answers 409 as for every action', () => {
    const t = setup();
    const gone = followed(t);
    t.store.personas.update(gone.id, { status: 'superseded' });
    expect(refusal(t, () => markLeft(t.deps, ACTOR, 'ws_a', gone.id, { date: PAST, to: { elsewhere: {} } }))).toMatchObject({ status: 409, changed: false });
  });
});

// ---------------------------------------------------------------------------------------------------
describe('changePosition', () => {
  it('promoted in place: type and title change, the history starts with where the person was', () => {
    const t = setup();
    const p = t.stakeholder('Head of finance', { stakeholderType: 'manager' });
    const after = changePosition(t.deps, ACTOR, 'ws_a', p.id, { change: 'promoted', date: PAST, stakeholderType: 'leader', title: ' Chief financial  officer ', note: 'Board decision.' });
    expect(after).toMatchObject({
      workspaceId: 'ws_a', slug: 'stk-head-of-finance', subjectKind: 'own', stakeholderType: 'leader', positionTitle: 'Chief financial officer', version: 2,
      relation: p.relation, agentMdPath: p.agentMdPath, disclosure: 'open',
    });
    expect(after.profile).toEqual(p.profile);
    expect(after).not.toHaveProperty('leftAt');
    const [change, joined] = positionsOf(t.store, p.id);
    expect(joined).toMatchObject({ change: 'joined', placeKind: 'node', workspaceId: 'ws_a', stakeholderType: 'manager', relation: p.relation });
    expect(joined).not.toHaveProperty('effectiveOn');
    expect(joined).not.toHaveProperty('title');
    expect(change).toMatchObject({
      change: 'promoted', placeKind: 'node', workspaceId: 'ws_a', stakeholderType: 'leader', title: 'Chief financial officer', relation: p.relation, effectiveOn: PAST,
      note: 'Board decision.', actor: ACTOR,
    });
    expect(readFileSync(after.agentMdPath, 'utf8')).toMatch(/version: 2\n[\s\S]*stakeholder_type: leader/);
    expect(t.events()).toHaveLength(1);
    expect(t.events()[0]).toMatchObject({
      workspaceId: 'ws_a', targetType: 'stakeholder', targetId: p.id, reason: 'Board decision.',
      afterJson: { change: 'promoted', placeKind: 'node', personaId: p.id, workspaceId: 'ws_a', date: PAST },
    });

    // A second change adds one row: the baseline is written once.
    const again = changePosition(t.deps, ACTOR, 'ws_a', p.id, { change: 'demoted', date: '2026-11-10' });
    expect(again).toMatchObject({ version: 3, stakeholderType: 'leader', positionTitle: 'Chief financial officer' });
    expect(positionsOf(t.store, p.id).map((h) => h.change)).toEqual(['demoted', 'promoted', 'joined']);
  });

  it('moved: the node, the agent.md path and the open questions follow; reads and statements stay; maxOwn at the target does not hold it back', () => {
    const t = setup((c) => (c.stakeholders = { maxOwn: 1 }));
    t.stakeholder('Head of risk', {}, 'ws_b');
    const p = t.stakeholder('Head of finance');
    const repos = stakeholderRepos(t.store);
    repos.questions.insert({ id: 'stq_open', rootWorkspaceId: 'ws_a', workspaceId: 'ws_a', personaId: p.id, field: 'objections', text: 'q', status: 'open', createdAt: T0 });
    repos.questions.insert({ id: 'stq_done', rootWorkspaceId: 'ws_a', workspaceId: 'ws_a', personaId: p.id, field: 'objections', text: 'q', status: 'skipped', createdAt: T0 });
    repos.questions.insert({ id: 'stq_node', rootWorkspaceId: 'ws_a', workspaceId: 'ws_a', field: 'missing', text: 'q', status: 'open', createdAt: T0 });
    const note = addNote(t.store, ACTOR, 'ws_a', { personaId: p.id, text: 'Cares about payback' });
    repos.reads.insert({
      id: 'srd_1', rootWorkspaceId: 'ws_a', workspaceId: 'ws_a', recommendationId: 'rec_1', personaId: p.id, personaVersion: 1, stance: 'approve', conditions: [],
      concerns: [], reasoning: 'r', wouldChangeMind: 'w', agentRunId: 'arun_1', simulated: true, createdAt: T0,
    });

    const after = changePosition(t.deps, ACTOR, 'ws_a', p.id, { change: 'moved', date: PAST, toWorkspaceId: 'ws_b', title: 'Head of finance, Payments' });
    expect(after).toMatchObject({
      workspaceId: 'ws_b', slug: 'stk-head-of-finance', subjectKind: 'own', stakeholderType: 'leader', positionTitle: 'Head of finance, Payments', version: 2,
      agentMdPath: agentMdPath(t.dir, 'ws_b', 'stk-head-of-finance'),
    });
    const md = readFileSync(after.agentMdPath, 'utf8');
    expect(md).toContain('a stakeholder of Acme Payments');
    expect(md).toContain('version: 2');
    expect(t.files()).toEqual(expect.arrayContaining(['ws_b/stk-head-of-finance.md', 'ws_b/stk-head-of-finance.v2.md']));
    expect(repos.questions.get('stq_open')).toMatchObject({ workspaceId: 'ws_b', status: 'open' });
    expect(repos.questions.get('stq_done')!.workspaceId).toBe('ws_a');
    expect(repos.questions.get('stq_node')!.workspaceId).toBe('ws_a');
    expect(repos.statements.get(note.id)!.workspaceId).toBe('ws_a');
    expect(repos.reads.get('srd_1')!.workspaceId).toBe('ws_a');
    expect(positionsOf(t.store, p.id)[0]).toMatchObject({ change: 'moved', placeKind: 'node', workspaceId: 'ws_b', title: 'Head of finance, Payments', effectiveOn: PAST });
    expect(positionsOf(t.store, p.id)[1]).toMatchObject({ change: 'joined', workspaceId: 'ws_a' });
    expect(t.events()[0]).toMatchObject({ workspaceId: 'ws_b', afterJson: { change: 'moved', placeKind: 'node', personaId: p.id, workspaceId: 'ws_b', fromWorkspaceId: 'ws_a', date: PAST } });
  });

  it('a promotion may come with a move to another node', () => {
    const t = setup();
    const p = t.stakeholder('Head of finance', {}, 'ws_b');
    const after = changePosition(t.deps, ACTOR, 'ws_b', p.id, { change: 'promoted', date: PAST, toWorkspaceId: 'ws_a' });
    expect(after).toMatchObject({ workspaceId: 'ws_a', agentMdPath: agentMdPath(t.dir, 'ws_a', 'stk-head-of-finance') });
    expect(positionsOf(t.store, p.id)[0]).toMatchObject({ change: 'promoted', workspaceId: 'ws_a' });
  });

  it('400: moved without another node, an unknown kind of change or type, a bad date, too long a text; 404: an unknown or foreign node', () => {
    const t = setup();
    const p = t.stakeholder('Head of finance');
    const change = (input: Partial<Parameters<typeof changePosition>[4]>) =>
      refusal(t, () => changePosition(t.deps, ACTOR, 'ws_a', p.id, { change: 'promoted', date: PAST, ...input }));
    expect(change({ change: 'moved' })).toMatchObject({ status: 400, changed: false });
    expect(change({ change: 'moved', toWorkspaceId: 'ws_a' })).toMatchObject({ status: 400, changed: false });
    expect(change({ change: 'left' as never })).toMatchObject({ status: 400, changed: false });
    expect(change({ change: 'joined' as never })).toMatchObject({ status: 400, changed: false });
    expect(change({ stakeholderType: 'king' as never })).toMatchObject({ status: 400, changed: false });
    expect(change({ date: FUTURE })).toMatchObject({ status: 400, changed: false });
    expect(change({ date: 'yesterday' })).toMatchObject({ status: 400, changed: false });
    expect(change({ title: 'x'.repeat(301) })).toMatchObject({ status: 400, changed: false });
    expect(change({ note: 'x'.repeat(2001) })).toMatchObject({ status: 400, changed: false });
    expect(change({ change: 'moved', toWorkspaceId: 'ws_nope' })).toMatchObject({ status: 404, changed: false });
    expect(change({ change: 'moved', toWorkspaceId: 'ws_other' })).toMatchObject({ status: 404, changed: false });
    expect(change({ toWorkspaceId: 'ws_other' })).toMatchObject({ status: 404, changed: false });
    expect(change({ change: 'moved', toWorkspaceId: 'ws_other' }).message).toBe(change({ change: 'moved', toWorkspaceId: 'ws_nope' }).message.replace('ws_nope', 'ws_other'));
    expect(refusal(t, () => changePosition(t.deps, ACTOR, 'ws_other', p.id, { change: 'promoted', date: PAST }))).toMatchObject({ status: 404, changed: false });
    expect(refusal(t, () => changePosition(t.deps, ACTOR, 'ws_a', 'per_nope', { change: 'promoted', date: PAST }))).toMatchObject({ status: 404, changed: false });
  });

  it('409: a hidden stakeholder; a slug in use at the target node, and nothing changes (no row, no file)', () => {
    const t = setup();
    const hidden = t.stakeholder('Head of ops', { disclosure: 'hidden' });
    expect(refusal(t, () => changePosition(t.deps, ACTOR, 'ws_a', hidden.id, { change: 'promoted', date: PAST }))).toMatchObject({ status: 409, changed: false });

    const p = t.stakeholder('Head of finance');
    t.stakeholder('Head of Finance', {}, 'ws_b');
    const r = refusal(t, () => changePosition(t.deps, ACTOR, 'ws_a', p.id, { change: 'moved', date: PAST, toWorkspaceId: 'ws_b' }));
    expect(r).toMatchObject({ status: 409, changed: false });
    expect(r.message).toContain('Head of Finance');
    expect(t.store.personas.get(p.id)).toEqual(p);
    expect(t.positions()).toEqual([]);
    expect(t.files().filter((f) => f.startsWith('ws_b/'))).toEqual(['ws_b/stk-head-of-finance.md', 'ws_b/stk-head-of-finance.v1.md']);
    expect(readFileSync(agentMdPath(t.dir, 'ws_b', 'stk-head-of-finance'), 'utf8')).toContain('# Head of Finance');
  });

  it('400: only an own stakeholder that has not left can be moved or change position', () => {
    const t = setup();
    const rival = t.stakeholder('CEO', { slug: 'stk-rival-pay-ceo', subjectKind: 'competitor', subjectId: 'cmp_rival' });
    const gone = markLeft(t.deps, ACTOR, 'ws_a', t.stakeholder('Head of sales').id, { date: PAST, to: { competitorId: 'cmp_rival' } });
    const parked = markLeft(t.deps, ACTOR, 'ws_a', t.stakeholder('Head of legal').id, { date: PAST, to: { elsewhere: {} } });
    for (const p of [rival, gone, parked]) {
      expect(refusal(t, () => changePosition(t.deps, ACTOR, 'ws_a', p.id, { change: 'promoted', date: PAST })), p.slug).toMatchObject({ status: 400, changed: false });
      expect(refusal(t, () => changePosition(t.deps, ACTOR, 'ws_a', p.id, { change: 'moved', date: PAST, toWorkspaceId: 'ws_b' })), p.slug).toMatchObject({ status: 400, changed: false });
    }
  });
});

// ---------------------------------------------------------------------------------------------------
describe('markReturned', () => {
  it('from a competitor: an own stakeholder of the node again, open, the layers cleared, the profile kept with its basis marks', () => {
    const t = setup();
    const p = t.stakeholder('Head of sales');
    const gone = markLeft(t.deps, ACTOR, 'ws_a', p.id, { date: '2026-06-30', to: { competitorId: 'cmp_rival' }, title: 'VP Sales' });
    // What follow research and the combine run will have written by then.
    const combined = { ...gone.profile, role_mandate: { value: 'Runs sales at the rival', confidence: 0.7, evidence: ['art_1', 'art_2'], basis: 'both' as const, conflict: 'Titles differ.' } };
    t.store.personas.update(p.id, {
      profile: combined, publicProfile: { role_mandate: { value: 'p', confidence: 0.3, evidence: ['art_2'] } }, publicTaskId: 'tsk_1', publicSavedAt: T0, combinedAt: T0,
      publicPosition: { text: 'VP Sales at Rival Pay', evidence: ['art_2'] },
    });

    const after = markReturned(t.deps, ACTOR, 'ws_a', p.id, { date: PAST, toWorkspaceId: 'ws_b', stakeholderType: 'manager', title: 'Sales lead', note: 'Rehired.' });
    expect(after).toEqual(t.store.personas.get(p.id));
    expect(after).toMatchObject({
      workspaceId: 'ws_b', slug: 'stk-head-of-sales', subjectKind: 'own', disclosure: 'open', stakeholderType: 'manager', positionTitle: 'Sales lead',
      relation: 'Sales lead', version: 3, agentMdPath: agentMdPath(t.dir, 'ws_b', 'stk-head-of-sales'), status: 'verified',
    });
    for (const k of ['subjectId', 'leftAt', 'leftFrom', 'internalProfile', 'publicProfile', 'publicTaskId', 'publicSavedAt', 'combinedAt', 'publicPosition']) {
      expect(after, k).not.toHaveProperty(k);
    }
    expect(after.profile).toEqual(combined);
    expect(isFormerColleague(after)).toBe(false);
    const md = readFileSync(after.agentMdPath, 'utf8');
    expect(md).toContain('You are Head of sales, a stakeholder of Acme Payments: Sales lead.');
    expect(md).toContain('subject: own');
    expect(md).not.toContain('former_colleague');
    expect(md).not.toContain('Rests on');
    expect(positionsOf(t.store, p.id).map((h) => h.change)).toEqual(['returned', 'left', 'joined']);
    expect(positionsOf(t.store, p.id)[0]).toMatchObject({
      change: 'returned', placeKind: 'node', workspaceId: 'ws_b', stakeholderType: 'manager', title: 'Sales lead', effectiveOn: PAST, note: 'Rehired.', actor: ACTOR,
    });
    expect(t.events().at(-1)).toMatchObject({
      workspaceId: 'ws_b', targetId: p.id, reason: 'Rehired.', afterJson: { change: 'returned', placeKind: 'node', personaId: p.id, workspaceId: 'ws_b', date: PAST },
    });
  });

  it('from parked: back at its node under its slug, keeping its type when none is given', () => {
    const t = setup();
    const p = t.stakeholder('Head of legal', { stakeholderType: 'manager' });
    markLeft(t.deps, ACTOR, 'ws_a', p.id, { date: '2026-06-30', to: { elsewhere: {} }, title: 'Partner' });
    const after = markReturned(t.deps, ACTOR, 'ws_a', p.id, { date: PAST, toWorkspaceId: 'ws_a' });
    expect(after).toMatchObject({ workspaceId: 'ws_a', slug: 'stk-head-of-legal', subjectKind: 'own', stakeholderType: 'manager', relation: '', version: 3 });
    expect(after).not.toHaveProperty('positionTitle');
    expect(after).not.toHaveProperty('leftAt');
    expect(after.profile.role_mandate!.basis).toBe('internal');
    expect(readFileSync(after.agentMdPath, 'utf8')).not.toContain('You left');
    // And can leave again: the history goes on.
    markLeft(t.deps, ACTOR, 'ws_a', p.id, { date: '2026-11-10', to: { competitorId: 'cmp_rival' } });
    expect(positionsOf(t.store, p.id).map((h) => h.change)).toEqual(['left', 'returned', 'left', 'joined']);
  });

  it('a former colleague without history (stored by other means): the baseline says where they were, a competitor or elsewhere', () => {
    const t = setup();
    const left = { leftAt: '2026-06-30', leftFrom: { workspaceId: 'ws_a', scopeName: 'Acme Group', stakeholderType: 'leader' as const } };
    const gone = t.stakeholder('Head of sales', { slug: 'stk-rival-pay-head-of-sales', subjectKind: 'competitor', subjectId: 'cmp_rival', relation: 'VP Sales', positionTitle: 'VP Sales', ...left });
    const parked = t.stakeholder('Head of legal', { subjectKind: 'former', relation: '', ...left });
    markReturned(t.deps, ACTOR, 'ws_a', gone.id, { date: PAST, toWorkspaceId: 'ws_a' });
    markReturned(t.deps, ACTOR, 'ws_a', parked.id, { date: PAST, toWorkspaceId: 'ws_a' });
    const [, goneBase] = positionsOf(t.store, gone.id);
    expect(goneBase).toMatchObject({ change: 'joined', placeKind: 'competitor', competitorId: 'cmp_rival', stakeholderType: 'leader', title: 'VP Sales', relation: 'VP Sales' });
    expect(goneBase).not.toHaveProperty('workspaceId');
    const [, parkedBase] = positionsOf(t.store, parked.id);
    expect(parkedBase).toMatchObject({ change: 'joined', placeKind: 'elsewhere', stakeholderType: 'leader' });
    expect(parkedBase).not.toHaveProperty('workspaceId');
    expect(parkedBase).not.toHaveProperty('competitorId');
    expect(parkedBase).not.toHaveProperty('relation');
  });

  it('400: not a former colleague, a bad date or type; 404: an unknown or foreign node or persona; 409: the slug is in use at the node', () => {
    const t = setup();
    const own = t.stakeholder('Head of finance');
    const rival = t.stakeholder('CEO', { slug: 'stk-rival-pay-ceo', subjectKind: 'competitor', subjectId: 'cmp_rival' });
    const gone = markLeft(t.deps, ACTOR, 'ws_a', t.stakeholder('Head of sales').id, { date: PAST, to: { competitorId: 'cmp_rival' } });
    const back = (personaId: string, input: Partial<Parameters<typeof markReturned>[4]> = {}, workspaceId = 'ws_a') =>
      refusal(t, () => markReturned(t.deps, ACTOR, workspaceId, personaId, { date: PAST, toWorkspaceId: 'ws_a', ...input }));
    expect(back(own.id)).toMatchObject({ status: 400, changed: false });
    expect(back(rival.id)).toMatchObject({ status: 400, changed: false });
    expect(back(gone.id, { date: FUTURE })).toMatchObject({ status: 400, changed: false });
    expect(back(gone.id, { date: '31-10-2026' })).toMatchObject({ status: 400, changed: false });
    expect(back(gone.id, { stakeholderType: 'king' as never })).toMatchObject({ status: 400, changed: false });
    expect(back(gone.id, { title: 'x'.repeat(301) })).toMatchObject({ status: 400, changed: false });
    expect(back(gone.id, { toWorkspaceId: undefined as never })).toMatchObject({ status: 400, changed: false });
    expect(back(gone.id, { toWorkspaceId: 'ws_nope' })).toMatchObject({ status: 404, changed: false });
    expect(back(gone.id, { toWorkspaceId: 'ws_other' })).toMatchObject({ status: 404, changed: false });
    expect(back('per_nope')).toMatchObject({ status: 404, changed: false });
    expect(back(gone.id, {}, 'ws_other')).toMatchObject({ status: 404, changed: false });

    t.stakeholder('Head of Sales');
    const r = back(gone.id);
    expect(r).toMatchObject({ status: 409, changed: false });
    expect(r.message).toContain('Head of Sales');
    expect(t.store.personas.get(gone.id)).toEqual(gone);
    expect(positionsOf(t.store, gone.id).map((h) => h.change)).toEqual(['left', 'joined']);
    // The other node is free.
    expect(markReturned(t.deps, ACTOR, 'ws_a', gone.id, { date: PAST, toWorkspaceId: 'ws_b' }).workspaceId).toBe('ws_b');
  });

  it('a new label renames the returning person, so a slug in use at the node is no dead end', () => {
    const t = setup();
    const gone = markLeft(t.deps, ACTOR, 'ws_a', t.stakeholder('Head of sales').id, { date: '2026-06-30', to: { competitorId: 'cmp_rival' } });
    // Someone else holds the position, and the slug, by now.
    t.stakeholder('Head of Sales');
    const back = (label: unknown) => refusal(t, () => markReturned(t.deps, ACTOR, 'ws_a', gone.id, { date: PAST, toWorkspaceId: 'ws_a', label: label as string }));
    const taken = refusal(t, () => markReturned(t.deps, ACTOR, 'ws_a', gone.id, { date: PAST, toWorkspaceId: 'ws_a' }));
    expect(taken).toMatchObject({ status: 409, changed: false });
    expect(taken.message).toContain('stk-head-of-sales');
    expect(taken.message).toContain('give this stakeholder another label');
    // The rules of a label on leaving: one line with text, at most 80 characters, letters or digits for the slug.
    expect(back('   ')).toMatchObject({ status: 400, changed: false });
    expect(back('x'.repeat(81))).toMatchObject({ status: 400, changed: false });
    expect(back('!!!')).toMatchObject({ status: 400, changed: false });
    expect(back(7)).toMatchObject({ status: 400, changed: false });
    // A label that is taken too answers 409 like the stored one.
    expect(back('head of SALES')).toMatchObject({ status: 409, changed: false });

    const after = markReturned(t.deps, ACTOR, 'ws_a', gone.id, { date: PAST, toWorkspaceId: 'ws_a', label: ' Former head\n of sales ' });
    expect(after).toMatchObject({
      segment: 'Former head of sales', slug: 'stk-former-head-of-sales', subjectKind: 'own', workspaceId: 'ws_a',
      agentMdPath: agentMdPath(t.dir, 'ws_a', 'stk-former-head-of-sales'),
    });
    expect(after).toEqual(t.store.personas.get(gone.id));
    expect(readFileSync(after.agentMdPath, 'utf8')).toContain('You are Former head of sales, a stakeholder of Acme Group');
    expect(positionsOf(t.store, gone.id).map((h) => h.change)).toEqual(['returned', 'left', 'joined']);
  });
});

describe('a stakeholder whose research is not finished or was not usable', () => {
  it('409 for every action while the persona is pending, failed, superseded or unverified without the user\'s include; nothing changes', () => {
    const t = setup();
    const MESSAGE = /its research is not finished or was not usable/;
    for (const status of ['pending', 'failed', 'superseded', 'unverified'] as const) {
      const own = t.stakeholder(`Head of ${status}`, { status });
      const gone = t.stakeholder(`Former ${status}`, {
        status, slug: `stk-rival-pay-former-${status}`, subjectKind: 'competitor', subjectId: 'cmp_rival', leftAt: PAST,
        leftFrom: { workspaceId: 'ws_a', scopeName: 'Acme Group', stakeholderType: 'leader' },
      });
      const refusals = [
        refusal(t, () => markLeft(t.deps, ACTOR, 'ws_a', own.id, { date: PAST, to: { elsewhere: {} } })),
        refusal(t, () => changePosition(t.deps, ACTOR, 'ws_a', own.id, { change: 'promoted', date: PAST })),
        refusal(t, () => changePosition(t.deps, ACTOR, 'ws_a', own.id, { change: 'moved', date: PAST, toWorkspaceId: 'ws_b' })),
        refusal(t, () => markReturned(t.deps, ACTOR, 'ws_a', gone.id, { date: PAST, toWorkspaceId: 'ws_a' })),
      ];
      for (const r of refusals) {
        expect(r, status).toMatchObject({ status: 409, changed: false });
        expect(r.message, status).toMatch(MESSAGE);
      }
    }
    expect(t.positions()).toEqual([]);
  });

  it('an unverified stakeholder the user included can leave, like a verified one', () => {
    const t = setup();
    const p = t.stakeholder('Head of sales', { status: 'unverified', includeOverride: true });
    expect(markLeft(t.deps, ACTOR, 'ws_a', p.id, { date: PAST, to: { elsewhere: {} } }).leftAt).toBe(PAST);
    // And a verified one the user left out cannot.
    const out = t.stakeholder('Head of legal', { includeOverride: false });
    expect(refusal(t, () => markLeft(t.deps, ACTOR, 'ws_a', out.id, { date: PAST, to: { elsewhere: {} } }))).toMatchObject({ status: 409, changed: false });
  });
});

describe('export', () => {
  it('a position change is internal: its event and its note are left out of the export by default', () => {
    const t = setup();
    const p = t.stakeholder('Head of sales');
    markLeft(t.deps, ACTOR, 'ws_a', p.id, { date: PAST, to: { competitorId: 'cmp_rival' }, title: 'VP Sales', note: 'Announced at the all-hands.' });
    changePosition(t.deps, ACTOR, 'ws_a', t.stakeholder('Head of finance').id, { change: 'promoted', date: PAST, note: 'Board decision.' });
    const byDefault = exportTrainingData('ws_a', t);
    expect(byDefault).not.toContain('stakeholder_position_change');
    expect(byDefault).not.toMatch(/all-hands|Board decision|VP Sales|spo_/);
    const all = exportTrainingData('ws_a', t, true);
    expect(all.match(/"kind":"stakeholder_position_change"/g)).toHaveLength(2);
  });
});

describe('a failed write of agent.md rolls the action back', () => {
  it('the persona, the history and the event are as before', () => {
    const t = setup();
    const p = t.stakeholder('Head of sales');
    const before = t.state();
    // The personas directory of the target node cannot be created: a file stands in its place.
    const broken: PositionDeps = { store: t.store, dataDir: p.agentMdPath };
    expect(() => changePosition(broken, ACTOR, 'ws_a', p.id, { change: 'moved', date: PAST, toWorkspaceId: 'ws_b' })).toThrow();
    expect(t.state()).toBe(before);
  });
});

describe('agent.md is written last: a failed insert leaves no rewritten file', () => {
  it('when the feedback event cannot be stored, the file of every action is as it was and no version file is added', () => {
    const t = setup();
    const own = t.stakeholder('Head of sales');
    const gone = markLeft(t.deps, ACTOR, 'ws_a', t.stakeholder('Head of legal').id, { date: PAST, to: { competitorId: 'cmp_rival' } });
    const before = t.state();
    const texts = () => [own, gone].map((p) => readFileSync(t.store.personas.get(p.id)!.agentMdPath, 'utf8'));
    const written = texts();
    t.store.db.exec("CREATE TRIGGER test_no_feedback BEFORE INSERT ON feedback_events BEGIN SELECT RAISE(ABORT, 'feedback log is down'); END");
    const down = /feedback log is down/;
    expect(() => markLeft(t.deps, ACTOR, 'ws_a', own.id, { date: PAST, to: { elsewhere: {} } })).toThrow(down);
    expect(() => markLeft(t.deps, ACTOR, 'ws_a', own.id, { date: PAST, to: { competitorId: 'cmp_rival' } })).toThrow(down);
    expect(() => changePosition(t.deps, ACTOR, 'ws_a', own.id, { change: 'promoted', date: PAST, title: 'Chief' })).toThrow(down);
    expect(() => changePosition(t.deps, ACTOR, 'ws_a', own.id, { change: 'moved', date: PAST, toWorkspaceId: 'ws_b' })).toThrow(down);
    expect(() => markReturned(t.deps, ACTOR, 'ws_a', gone.id, { date: PAST, toWorkspaceId: 'ws_b' })).toThrow(down);
    t.store.db.exec('DROP TRIGGER test_no_feedback');
    expect(t.state()).toBe(before);
    expect(texts()).toEqual(written);
  });
});
