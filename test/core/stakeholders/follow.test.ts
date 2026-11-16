/**
 * Stakeholder positions, task 2 (design 2026-11-15-stakeholder-positions-design.md §7.1): follow
 * research. The `competitor_stakeholders` work prompt lists the former colleagues to follow and nothing
 * else of them; `save_stakeholder` with `follow` stores the public layer and touches nothing else; the
 * stakeholders phase plans the task when there are competitors or former colleagues to follow; a task
 * that failed leaves its layer stored and unused.
 */
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { currentRatedKeys } from '../../../src/core/feedback/provenance.js';
import type { FakeScript } from '../../../src/core/harness/adapter.js';
import { toolInputSchemas, toolJsonSchema } from '../../../src/core/harness/tools/registry.js';
import { personaLearningRepos } from '../../../src/core/personas/store.js';
import type { AgentRequest } from '../../../src/core/research/deps.js';
import { orchestratorPrompt, startPhase } from '../../../src/core/research/orchestrator.js';
import { isOutputUsable } from '../../../src/core/research/outputs.js';
import { reviewerRunInput, reviewSlice, revisePrompt, runTaskWithReview, workPrompt } from '../../../src/core/research/reviewLoop.js';
import { workerSystemPrompt } from '../../../src/core/research/systemPrompts.js';
import { STAKEHOLDER_FIELDS } from '../../../src/core/scoring/criteria.js';
import { exportTrainingData } from '../../../src/core/scoring/export.js';
import { needsCombine, runCombine } from '../../../src/core/stakeholders/combine.js';
import { colleaguesToFollow, stakeholderTaskSection } from '../../../src/core/stakeholders/personas.js';
import { formerColleagues, markLeft, markReturned } from '../../../src/core/stakeholders/positions.js';
import { addNote } from '../../../src/core/stakeholders/statements.js';
import type { Store } from '../../../src/core/store/db.js';
import { newId } from '../../../src/core/store/repos.js';
import type { Persona, Rating } from '../../../src/core/types.js';
import { review } from '../helpers/research.js';
import { ACTOR, followSetup, LEFT, profileOf, resetClock, T0, tick, type FollowSetup } from './followFixture.js';

const opened: Store[] = [];
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  resetClock();
});
afterEach(() => {
  vi.useRealTimers();
  for (const s of opened.splice(0)) s.close();
});

const section = (t: FollowSetup, type: 'competitor_stakeholders' | 'own_stakeholders' = 'competitor_stakeholders', taskId?: string) =>
  stakeholderTaskSection(t.store, t.config, { type, workspaceId: 'ws_a', ...(taskId ? { id: taskId } : {}) });
/** The follow part of a work prompt section ('' when it has none). */
const followPart = (text: string) => (text.includes('## Former colleagues to follow') ? text.slice(text.indexOf('## Former colleagues to follow')) : '');
/** Everything a follow save may not change, and the files of the persona. */
const untouched = (t: FollowSetup, p: Persona) => {
  const now = t.store.personas.get(p.id)!;
  const { publicProfile: _a, publicTaskId: _b, publicSavedAt: _c, publicPosition: _d, ...rest } = now;
  return JSON.stringify({ rest, md: readFileSync(now.agentMdPath, 'utf8') });
};

// ---------------------------------------------------------------------------------------------------
describe('the follow section of the competitor_stakeholders work prompt', () => {
  it('lists each former colleague of the node: id, label, the position held here and until when, and where they went', () => {
    const t = followSetup(opened);
    const text = section(t);
    const part = followPart(text);
    expect(part).not.toBe('');
    // The stored texts are inside an untrusted-data fence; the instructions are outside it.
    const fence = /<<<EVIDENCE former-colleagues\n([\s\S]*?)\n>>>/.exec(part)!;
    expect(fence[1]!.split('\n')).toEqual([
      `- ${t.parked.id}: Head of legal — was leader at Acme Payments until ${LEFT}; now at A law firm`,
      `- ${t.gone.id}: Head of sales — was Head of Sales EMEA at Acme Payments until ${LEFT}; now at Rival Pay`,
    ]);
    const rules = part.slice(0, part.indexOf('<<<EVIDENCE'));
    expect(rules).toContain('`save_stakeholder`');
    expect(rules).toContain('`follow: <id>`');
    expect(rules).toContain('`now_at`');
    expect(rules).toMatch(/never search for, and never put into a search query, a web form or any web request, anything about them that is not in this list/i);
    // Neither the own stakeholder nor the competitor's stakeholder that never worked here is followed.
    expect(part).not.toContain(t.own.id);
    expect(part).not.toContain(t.rival.id);
    // The competitors and the stakeholders already saved are listed as before.
    expect(text).toContain('## Competitors to research');
    expect(text).toContain('- cmp_rival: Rival Pay');
    expect(text.slice(0, text.indexOf('## Former colleagues to follow'))).toContain('stk-rival-pay-chief-executive');
  });

  it('holds nothing of the persona but that: no profile, layer, relation, title elsewhere, adjustment or statement (Review Focus 4)', () => {
    const t = followSetup(opened);
    for (const p of [t.gone, t.parked]) {
      // Every text the persona carries holds a marker no label has.
      t.store.personas.update(p.id, {
        profile: profileOf(p.segment, [t.internalArt], 'COMBINEDMARK'), internalProfile: profileOf(p.segment, [t.internalArt], 'INTERNALMARK'),
        publicProfile: profileOf(p.segment, [t.internalArt], 'PUBLICMARK'), publicPosition: { text: 'POSITIONMARK somewhere', evidence: [t.internalArt] },
        relation: 'TITLEMARK now', positionTitle: 'TITLEMARK now', leftFrom: { ...p.leftFrom!, relation: 'RELATIONMARK then' },
      });
      personaLearningRepos(t.store).adjustments.insert({
        id: newId('pad'), rootWorkspaceId: 'ws_a', workspaceId: 'ws_a', personaId: p.id, marker: `m-${p.slug}`, text: 'ADJUSTMARK you approve only what pays back',
        version: 1, status: 'active', source: 'user', actor: ACTOR, stats: {}, internal: true, createdAt: T0, changedAt: T0,
      });
      addNote(t.store, ACTOR, 'ws_a', { personaId: p.id, text: 'STATEMENTMARK cares about payback' });
    }
    addNote(t.store, ACTOR, 'ws_a', { text: 'STATEMENTMARK about someone not listed yet' });
    const text = section(t);
    expect(followPart(text)).toContain(t.gone.id);
    expect(text).not.toMatch(/[A-Z]+MARK/);
    // The whole work prompt of the task, and of its revision, hold none of it either.
    const task = t.task('competitor_stakeholders', { status: 'queued' });
    for (const prompt of [workPrompt(t.deps, task), revisePrompt(task, [], t.deps)]) {
      expect(followPart(prompt)).toContain(t.gone.id);
      expect(prompt).not.toMatch(/[A-Z]+MARK/);
    }
  });

  it('a former colleague without a recorded title is named by type; one whose destination has no name is "unknown"', () => {
    const t = followSetup(opened);
    const bare = markLeft(t.pos, ACTOR, 'ws_a', t.stakeholder('Head of ops', { stakeholderType: 'manager' }).id, { date: '2026-09-30', to: { elsewhere: {} } });
    expect(followPart(section(t))).toContain(`- ${bare.id}: Head of ops — was manager at Acme Payments until 2026-09-30; now at unknown`);
  });

  it('a parked former colleague given a competitor later is listed with the competitor', () => {
    const t = followSetup(opened);
    markLeft(t.pos, ACTOR, 'ws_a', t.parked.id, { date: LEFT, to: { competitorId: 'cmp_rival' } });
    expect(followPart(section(t))).toContain(`- ${t.parked.id}: Head of legal — was leader at Acme Payments until ${LEFT}; now at Rival Pay`);
  });

  it('at most maxFollowed, those never followed first, then those whose public layer is oldest', () => {
    const t = followSetup(opened, (c) => (c.stakeholders = { maxFollowed: 3 }));
    const a = t.former('Head of ops');
    const b = t.former('Head of risk', 'elsewhere');
    t.store.personas.update(t.gone.id, { publicProfile: profileOf('x'), publicSavedAt: '2026-11-10T00:00:00.000Z' });
    t.store.personas.update(t.parked.id, { publicProfile: profileOf('x'), publicSavedAt: '2026-11-01T00:00:00.000Z' });
    t.store.personas.update(a.id, { publicProfile: profileOf('x'), publicSavedAt: '2026-11-05T00:00:00.000Z' });
    const ids = (text: string) => [...followPart(text).matchAll(/^- (per_\w+):/gm)].map((m) => m[1]);
    // Never followed (b), then the oldest layers: parked (1 Nov), a (5 Nov); gone (10 Nov) waits.
    expect(ids(section(t))).toEqual([b.id, t.parked.id, a.id]);
    expect(colleaguesToFollow(t.store, t.config, 'ws_a').map((p) => p.id)).toEqual([b.id, t.parked.id, a.id]);
    expect(followPart(section(t))).toContain('at most 3');
  });

  it('those the task itself already saved stay listed in its later prompts (a revision names the same people)', () => {
    const t = followSetup(opened, (c) => (c.stakeholders = { maxFollowed: 2 }));
    const a = t.former('Head of ops');
    const task = t.task('competitor_stakeholders', { status: 'running' });
    const ids = (text: string) => [...followPart(text).matchAll(/^- (per_\w+):/gm)].map((m) => m[1]);
    const first = ids(section(t, 'competitor_stakeholders', task.id));
    expect(first).toEqual([t.parked.id, a.id]); // by slug: none was followed yet
    for (const id of first) t.store.personas.update(id!, { publicProfile: profileOf('x'), publicTaskId: task.id, publicSavedAt: tick() });
    expect(ids(section(t, 'competitor_stakeholders', task.id))).toEqual(first);
    // Another task follows the one still waiting first.
    expect(ids(section(t, 'competitor_stakeholders', t.task().id))[0]).toBe(t.gone.id);
  });

  it('a former colleague the user excluded, or whose research is not usable, is not followed', () => {
    const t = followSetup(opened);
    const ids = () => colleaguesToFollow(t.store, t.config, 'ws_a').map((p) => p.id);
    expect(ids()).toEqual([t.parked.id, t.gone.id]);
    // "Use for reads and learning" switched off by the user.
    t.store.personas.update(t.gone.id, { includeOverride: false });
    expect(ids()).toEqual([t.parked.id]);
    expect(followPart(section(t))).not.toContain(t.gone.id);
    // Not usable: any status but verified, unless the user included it.
    for (const status of ['pending', 'unverified', 'failed'] as const) {
      t.store.personas.update(t.parked.id, { status });
      expect(ids(), status).toEqual([]);
      expect(followPart(section(t)), status).toBe('');
    }
    t.store.personas.update(t.parked.id, { status: 'unverified', includeOverride: true });
    expect(ids()).toEqual([t.parked.id]);
  });

  it('a former colleague another task of the same research run already saved is not listed again in that run', () => {
    const t = followSetup(opened);
    const first = t.task('competitor_stakeholders', { status: 'running', runId: 'rrun_1' });
    const second = t.task('competitor_stakeholders', { status: 'queued', runId: 'rrun_1' });
    const later = t.task('competitor_stakeholders', { status: 'queued', runId: 'rrun_2' });
    const ids = (taskId: string) => [...followPart(section(t, 'competitor_stakeholders', taskId)).matchAll(/^- (per_\w+):/gm)].map((m) => m[1]);
    expect(ids(second.id)).toEqual([t.parked.id, t.gone.id]);
    t.store.personas.update(t.gone.id, { publicProfile: profileOf('x'), publicTaskId: first.id, publicSavedAt: tick() });
    // The task that saved it keeps it in its prompts; the other task of the run does not research it again.
    expect(ids(first.id)).toEqual([t.gone.id, t.parked.id]);
    expect(ids(second.id)).toEqual([t.parked.id]);
    // The run itself (planning: no task yet) counts only who is still to follow.
    expect(colleaguesToFollow(t.store, t.config, 'ws_a', { runId: 'rrun_1' }).map((p) => p.id)).toEqual([t.parked.id]);
    // A later research run follows everyone again, the one never followed first.
    expect(ids(later.id)).toEqual([t.parked.id, t.gone.id]);
    expect(colleaguesToFollow(t.store, t.config, 'ws_a', { runId: 'rrun_2' }).map((p) => p.id)).toEqual([t.parked.id, t.gone.id]);
    expect(colleaguesToFollow(t.store, t.config, 'ws_a').map((p) => p.id)).toEqual([t.parked.id, t.gone.id]);

    // Everyone followed in this run: the second task has no follow section left.
    t.store.personas.update(t.parked.id, { publicProfile: profileOf('x'), publicTaskId: first.id, publicSavedAt: tick() });
    expect(followPart(section(t, 'competitor_stakeholders', second.id))).toBe('');
  });

  it('no section: for own_stakeholders, with maxFollowed 0, without former colleagues, for a superseded or returned one', () => {
    const off = followSetup(opened, (c) => (c.stakeholders = { maxFollowed: 0 }));
    expect(followPart(section(off))).toBe('');
    expect(colleaguesToFollow(off.store, off.config, 'ws_a')).toEqual([]);

    const t = followSetup(opened);
    expect(followPart(section(t, 'own_stakeholders'))).toBe('');
    expect(section(t, 'own_stakeholders')).not.toContain(t.gone.id);
    t.store.personas.update(t.parked.id, { status: 'superseded' });
    markReturned(t.pos, ACTOR, 'ws_a', t.gone.id, { date: LEFT, toWorkspaceId: 'ws_a' });
    expect(formerColleagues(t.store, 'ws_a')).toEqual([]);
    expect(followPart(section(t))).toBe('');
    // A former colleague of another node is not this node's to follow.
    t.former('Head of cards', 'rival', 'ws_b');
    expect(followPart(section(t))).toBe('');
    expect(followPart(stakeholderTaskSection(t.store, t.config, { type: 'competitor_stakeholders', workspaceId: 'ws_b' }))).toContain('Head of cards');
  });

  it('with former colleagues and no competitor, the task is told there is no competitor, not that there is nothing to do', () => {
    const t = followSetup(opened);
    t.store.competitors.update('cmp_rival', { status: 'superseded' });
    const text = section(t);
    expect(text).not.toContain('nothing to save');
    expect(text).toMatch(/Pass the id as `subject`:\n- none\n/);
    expect(followPart(text)).toContain(t.parked.id);
    // Without either, as before.
    for (const p of formerColleagues(t.store, 'ws_a')) t.store.personas.update(p.id, { status: 'superseded' });
    expect(section(t)).toContain('- none: finish with `submit_result` and nothing to save');
  });

  it('the worker prompt of the task type explains the follow save; the tool schema carries follow and now_at', () => {
    const t = followSetup(opened);
    const system = workerSystemPrompt(t.config, 'worker', true, 'competitor_stakeholders');
    expect(system).toContain('## Former colleagues to follow');
    expect(system).toContain('`follow`');
    expect(system).toContain('`now_at`');
    expect(system).toMatch(/never search for a person who is not named in public evidence/i);
    const props = (toolJsonSchema('save_stakeholder').properties ?? {}) as Record<string, unknown>;
    expect(Object.keys(props)).toEqual(expect.arrayContaining(['follow', 'now_at', 'label', 'subject', 'relation', 'profile']));
    expect(toolJsonSchema('save_stakeholder').required).not.toEqual(expect.arrayContaining(['follow']));
    const base = { label: 'l', stakeholder_type: 'other', subject: 's', relation: 'r', profile: t.publicInput('l', ['art_1']) };
    expect(toolInputSchemas.save_stakeholder.safeParse({ ...base, follow: 'per_1', now_at: 'x'.repeat(200) }).success).toBe(true);
    expect(toolInputSchemas.save_stakeholder.safeParse({ ...base, follow: 'per_1', now_at: 'x'.repeat(201) }).success).toBe(false);
    expect(toolInputSchemas.save_stakeholder.safeParse({ ...base, follow: '' }).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------------
describe('save_stakeholder with follow: the public layer', () => {
  it('stores the profile as the public layer of the former colleague and touches nothing else', async () => {
    const t = followSetup(opened);
    const task = t.task('competitor_stakeholders', { status: 'running', round: 2 });
    const page = t.art('Rival Pay leadership page');
    for (const p of [t.gone, t.parked]) {
      const before = untouched(t, p);
      const at = tick();
      const r = await t.follow(task, p.id, { profile: t.publicInput(p.segment, [page, page]), now_at: '  VP Sales\n at Rival Pay ' });
      expect(r).toEqual({ ok: true, data: { personaId: p.id, slug: p.slug, layer: 'public', publicSavedAt: at } });
      const after = t.store.personas.get(p.id)!;
      expect(untouched(t, p)).toBe(before);
      // The profile, status, task and version of the persona are as they were: a failed review cannot disable it.
      expect(after).toMatchObject({ profile: p.profile, status: 'verified', version: p.version, segment: p.segment, slug: p.slug, relation: p.relation, stakeholderType: 'leader' });
      expect(after.taskId).toBe(p.taskId);
      expect(after.internalProfile).toEqual(p.internalProfile);
      expect(after).not.toHaveProperty('combinedAt');
      expect(after).toMatchObject({ publicTaskId: task.id, publicSavedAt: at, publicPosition: { text: 'VP Sales at Rival Pay', evidence: [page] } });
      for (const f of STAKEHOLDER_FIELDS) {
        expect(after.publicProfile![f]).toEqual({ value: `PUBLICMARK ${f} of ${p.segment}`, confidence: 0.4, evidence: [page], basis: 'public' });
      }
      expect(Object.keys(after.publicProfile!)).toEqual([...STAKEHOLDER_FIELDS]);
    }
  });

  it('logs a score Decision with the label, the type and the confidences only', async () => {
    const t = followSetup(opened);
    const task = t.task();
    const page = t.art('Rival Pay leadership page');
    await t.follow(task, t.gone.id, { profile: t.publicInput('Head of sales', [page]), now_at: 'NOWATMARK VP Sales at Rival Pay' });
    const [d] = t.store.decisions.list({ workspaceId: 'ws_a', kind: 'score' });
    expect(d!.payload).toEqual({
      tool: 'save_stakeholder', followedPersonaId: t.gone.id, label: 'Head of sales', stakeholderType: 'leader', subjectKind: 'competitor', layer: 'public',
      confidence: Object.fromEntries(STAKEHOLDER_FIELDS.map((f) => [f, 0.4])),
    });
    expect(d!.refs).toEqual([t.gone.id, page]);
    expect(JSON.stringify(d)).not.toMatch(/[A-Z]+MARK|ignored/);
    expect(t.seen.filter((e) => e.type === 'decision')).toHaveLength(1);
  });

  it('is no judgment of the persona: a rating of the persona joins no exported line, and an earlier rating does not go stale', async () => {
    const t = followSetup(opened);
    const rate = (): Rating =>
      t.store.ratings.insert({
        id: newId('rat'), workspaceId: 'ws_a', targetType: 'persona', targetId: t.gone.id, criterion: 'decision_criteria', agentValue: 0.6, verdict: 'disagree',
        userValue: 0.2, reason: 'The profile we hold says otherwise.', createdAt: tick(),
      });
    const earlier = rate();
    tick();
    await t.follow(t.task(), t.gone.id);
    const [followSave] = t.store.decisions.list({ workspaceId: 'ws_a', kind: 'score' });
    // The profile the user rated is the one held from inside: the public layer changed nothing of it.
    expect(currentRatedKeys(t.store, 'ws_a').has(`persona|${t.gone.id}|decision_criteria`)).toBe(true);
    const later = rate();

    for (const includeUploads of [false, true]) {
      const lines = exportTrainingData('ws_a', t, includeUploads).split('\n').filter(Boolean);
      // The follow save is exported as the research decision it is, joined with no rating of the persona.
      const line = lines.map((l) => JSON.parse(l)).find((l) => l.decision?.id === followSave!.id);
      expect(line.ratings, String(includeUploads)).toEqual([]);
      expect(lines.join('\n')).not.toContain(earlier.id);
      expect(lines.join('\n')).not.toContain(later.id);
    }
    // A rating of the follow save itself is its own.
    const own = t.store.ratings.insert({ ...later, id: newId('rat'), targetType: 'decision', targetId: followSave!.id, criterion: 'quality', createdAt: tick() });
    const exported = exportTrainingData('ws_a', t).split('\n').filter(Boolean).map((l) => JSON.parse(l)).find((l) => l.decision?.id === followSave!.id);
    expect(exported.ratings.map((r: Rating) => r.id)).toEqual([own.id]);
  });

  it('a later save replaces the layer; without now_at what research last saw of the position is kept', async () => {
    const t = followSetup(opened);
    const first = t.task();
    await t.follow(first, t.gone.id, { now_at: 'VP Sales at Rival Pay' });
    const seen = t.store.personas.get(t.gone.id)!.publicPosition;
    const second = t.task();
    const at = tick();
    const page = t.art('A newer page');
    expect((await t.follow(second, t.gone.id, { profile: t.publicInput('newer', [page]) })).ok).toBe(true);
    const after = t.store.personas.get(t.gone.id)!;
    expect(after).toMatchObject({ publicTaskId: second.id, publicSavedAt: at, publicPosition: seen });
    expect(after.publicProfile!.role_mandate).toEqual({ value: 'PUBLICMARK role_mandate of newer', confidence: 0.4, evidence: [page], basis: 'public' });
    // A blank now_at is none.
    await t.follow(second, t.gone.id, { now_at: ' \n ' });
    expect(t.store.personas.get(t.gone.id)!.publicPosition).toEqual(seen);
  });

  it('label, subject, relation and type of the call are ignored: a label no slug can be derived from still follows', async () => {
    const t = followSetup(opened);
    const r = await t.follow(t.task(), t.gone.id, { label: '!!!', subject: 'own', relation: 'x', stakeholder_type: 'investor' });
    expect(r.ok).toBe(true);
    expect(t.store.personas.get(t.gone.id)).toMatchObject({ segment: 'Head of sales', subjectKind: 'competitor', subjectId: 'cmp_rival', stakeholderType: 'leader' });
    expect(t.store.personas.list({ workspaceId: 'ws_a' })).toHaveLength(4);
  });

  describe('refusals change nothing', () => {
    const refused = async (t: FollowSetup, call: () => ReturnType<FollowSetup['follow']>) => {
      const before = JSON.stringify([t.store.personas.list(), t.store.decisions.list({})]);
      const r = await call();
      expect(JSON.stringify([t.store.personas.list(), t.store.decisions.list({})])).toBe(before);
      if (r.ok) throw new Error('expected a refusal');
      return r.error;
    };

    it('only in a competitor_stakeholders task', async () => {
      const t = followSetup(opened);
      expect(await refused(t, () => t.follow(t.task('own_stakeholders'), t.gone.id))).toMatch(/follow is not available in an own_stakeholders task/);
      expect(await refused(t, () => t.follow(t.task('news_scan'), t.gone.id))).toMatch(/save_stakeholder is not available in a news_scan task/);
    });

    it('a persona that is not a former colleague of the caller\'s node: the same answer for an unknown id, an own stakeholder, a competitor\'s, another node\'s, another tree\'s, a superseded one', async () => {
      const t = followSetup(opened);
      const task = t.task();
      const child = t.former('Head of cards', 'rival', 'ws_b');
      const foreign = t.stakeholder('Director', { leftAt: LEFT, subjectKind: 'former' }, 'ws_other');
      const old = t.former('Head of ops');
      t.store.personas.update(old.id, { status: 'superseded' });
      t.store.personas.insert({ id: 'per_seg', workspaceId: 'ws_a', slug: 'seg', segment: 'SMB', profile: {}, agentMdPath: '/seg.md', version: 1 });
      const messages: string[] = [];
      for (const id of ['per_nope', t.own.id, t.rival.id, child.id, foreign.id, old.id, 'per_seg']) {
        const error = await refused(t, () => t.follow(task, id));
        messages.push(error.replace(id, '<id>'));
      }
      expect(new Set(messages)).toEqual(new Set(["follow '<id>' is not a former colleague of this node"]));
      // The former colleague of the child node is followed by a task of that node.
      expect((await t.follow(t.task('competitor_stakeholders', { workspaceId: 'ws_b' }), child.id)).ok).toBe(true);
    });

    it('a former colleague the user excluded, or whose research is not usable, is not followed by a save either: the same answer', async () => {
      const t = followSetup(opened);
      const task = t.task();
      const NOT_FOLLOWED = (id: string) => `follow '${id}' is not a former colleague of this node`;
      // "Use for reads and learning" switched off by the user.
      t.store.personas.update(t.gone.id, { includeOverride: false });
      expect(await refused(t, () => t.follow(task, t.gone.id))).toBe(NOT_FOLLOWED(t.gone.id));
      // Not usable: any status but verified, unless the user included it.
      for (const status of ['pending', 'unverified', 'failed'] as const) {
        t.store.personas.update(t.parked.id, { status });
        expect(await refused(t, () => t.follow(task, t.parked.id)), status).toBe(NOT_FOLLOWED(t.parked.id));
      }
      // The list of the work prompt and the save agree: whoever is listed can be saved.
      expect(colleaguesToFollow(t.store, t.config, 'ws_a', { taskId: task.id })).toEqual([]);
      t.store.personas.update(t.parked.id, { status: 'unverified', includeOverride: true });
      t.store.personas.update(t.gone.id, { includeOverride: undefined });
      for (const p of colleaguesToFollow(t.store, t.config, 'ws_a', { taskId: task.id })) expect((await t.follow(task, p.id)).ok, p.slug).toBe(true);
      expect(t.store.personas.get(t.parked.id)!.publicTaskId).toBe(task.id);
      expect(t.store.personas.get(t.gone.id)!.publicTaskId).toBe(task.id);
    });

    it('the save is not held back by the cap of the list or by another task of the same run', async () => {
      const t = followSetup(opened, (c) => (c.stakeholders = { maxFollowed: 1 }));
      const first = t.task('competitor_stakeholders', { status: 'running', runId: 'rrun_1' });
      const second = t.task('competitor_stakeholders', { status: 'running', runId: 'rrun_1' });
      // Beyond the cap of one per task, and saved by another task of the run already: still a former colleague to save.
      expect((await t.follow(first, t.parked.id)).ok).toBe(true);
      expect((await t.follow(first, t.gone.id)).ok).toBe(true);
      expect((await t.follow(second, t.gone.id)).ok).toBe(true);
    });

    it('evidence that is an upload, or rests on one, is refused: the public layer may rest only on public pages', async () => {
      const t = followSetup(opened);
      const task = t.task();
      const upload = t.art('Internal org chart, uploaded', 'ws_a', 'upload');
      const other = t.art('Board minutes, uploaded', 'ws_a', 'upload');
      /** A copy of a public web page, as research captures one. */
      const page = t.artifacts.save({
        workspaceId: 'ws_a', kind: 'page_snapshot', mime: 'text/html', bytes: '<html><body>Rival Pay leadership</body></html>',
        sourceUrl: 'https://rivalpay.example/leadership',
      }).id;
      const error = await refused(t, () => t.follow(task, t.gone.id, { profile: t.publicInput('x', [page, upload]) }));
      expect(error).toMatch(/the public layer may rest only on public pages/);
      expect(error).toContain(upload);
      expect(error).not.toContain(page);
      // Every offending id is named, once.
      const mixed = { ...t.publicInput('x', [page]), influence: { value: 'v', confidence: 0.4, evidence: [other, upload] }, objections: { value: 'v', confidence: 0.4, evidence: [upload] } };
      const both = await refused(t, () => t.follow(task, t.gone.id, { profile: mixed }));
      for (const id of [other, upload]) expect(both.split(id), id).toHaveLength(2);
      expect(both).not.toContain(page);
      // The public page copy alone is what the layer is for.
      expect(await t.follow(task, t.gone.id, { profile: t.publicInput('x', [page]) })).toMatchObject({ ok: true });
      expect(t.store.personas.get(t.gone.id)!.publicProfile!.influence!.evidence).toEqual([page]);
    });

    it('with maxFollowed 0 following is off', async () => {
      const t = followSetup(opened, (c) => (c.stakeholders = { maxFollowed: 0 }));
      expect(await refused(t, () => t.follow(t.task(), t.gone.id))).toMatch(/following former colleagues is off \(stakeholders\.maxFollowed: 0\)/);
    });

    it('evidence ids are checked as for any save: an unknown artifact, or one of another tree', async () => {
      const t = followSetup(opened);
      const task = t.task();
      const foreign = t.art('A page of another business', 'ws_other');
      for (const id of ['art_nope', foreign]) {
        expect(await refused(t, () => t.follow(task, t.gone.id, { profile: t.publicInput('x', [id]) }))).toContain(`evidence references unknown artifacts`);
      }
      const missing = t.publicInput('x', [t.internalArt]);
      delete (missing as Record<string, unknown>).influence;
      expect(await refused(t, () => t.follow(task, t.gone.id, { profile: missing }))).toMatch(/invalid input for save_stakeholder: profile\.influence/);
    });

    it('a save without follow whose slug belongs to a former colleague is refused, naming follow', async () => {
      const t = followSetup(opened);
      const page = t.art('A page');
      const save = (task: ReturnType<FollowSetup['task']>, label: string, subject: string) =>
        t.handle(t.ctx(task), 'save_stakeholder', { label, stakeholder_type: 'leader', subject, relation: 'decides', profile: t.publicInput(label, [page]) });
      // At the competitor they went to: the same label and subject would have overwritten the former colleague.
      const atRival = await refused(t, () => save(t.task(), 'Head of Sales', 'cmp_rival'));
      expect(atRival).toContain(`follow: '${t.gone.id}'`);
      expect(atRival).toMatch(/former colleague/);
      // A parked one keeps its own slug: own-stakeholder research cannot save it again either.
      const parked = await refused(t, () => save(t.task('own_stakeholders'), 'Head of legal', 'own'));
      expect(parked).toContain(`follow: '${t.parked.id}'`);
      // Another label at the same competitor is an ordinary save.
      expect((await save(t.task(), 'Chief revenue officer', 'cmp_rival')).ok).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------------------------------
describe('planning: the stakeholders phase', () => {
  const spec = (type: string) => ({ type, brief: `do ${type}`, model: { provider: 'claude', model: 'sonnet' }, needs_browser: false, acceptance_criteria: ['criterion'] });
  const nothing: FakeScript = async () => {};
  /** Runs the phase with an orchestrator that proposes one competitor_stakeholders task; returns what `propose_tasks` answered. */
  const plan = async (t: FollowSetup) => {
    const results: Array<{ accepted: unknown[]; rejected: Array<{ reason: string }> }> = [];
    t.state.pick = (r: AgentRequest) =>
      r.kind === 'orchestrate'
        ? r.round === 1
          ? async (tc) => void results.push((await tc.call('propose_tasks', { tasks: [spec('competitor_stakeholders')] })) as never)
          : nothing
        : r.kind === 'work'
          ? async (tc) => void (await tc.call('submit_result', { summary: 'nothing found' }))
          : r.kind === 'review'
            ? review(9)
            : undefined;
    await startPhase('ws_a', 'stakeholders', t.deps);
    return results[0]!;
  };

  it('competitor_stakeholders is planned without competitors when the node has former colleagues to follow', async () => {
    const t = followSetup(opened);
    t.store.competitors.update('cmp_rival', { status: 'superseded' });
    // The one who went to Rival Pay still names it; the parked one is followed too.
    const result = await plan(t);
    expect(result.accepted).toHaveLength(1);
    const work = t.requests.find((r) => r.kind === 'work')!;
    expect(followPart(work.prompt)).toContain(t.parked.id);
    expect(work.offline).toBeUndefined();
  });

  it('it is dropped when there is neither: no competitor and no former colleague, or following is off', async () => {
    const none = followSetup(opened);
    none.store.competitors.update('cmp_rival', { status: 'superseded' });
    for (const p of formerColleagues(none.store, 'ws_a')) none.store.personas.update(p.id, { status: 'superseded' });
    const dropped = await plan(none);
    expect(dropped.accepted).toHaveLength(0);
    expect(dropped.rejected[0]!.reason).toMatch(/no competitors yet and this node has no former colleagues to follow/);

    const off = followSetup(opened, (c) => (c.stakeholders = { maxFollowed: 0 }));
    off.store.competitors.update('cmp_rival', { status: 'superseded' });
    expect((await plan(off)).accepted).toHaveLength(0);
    expect(off.requests.some((r) => r.kind === 'work' || r.kind === 'retro')).toBe(false);
  });

  it('once a task of the research run has followed everyone, the run plans no second task for them', async () => {
    const t = followSetup(opened);
    t.store.competitors.update('cmp_rival', { status: 'superseded' });
    const second: Array<{ accepted: unknown[]; rejected: Array<{ reason: string }> }> = [];
    const followAll: FakeScript = async (tc) => {
      const a = (await tc.call('save_artifact', { kind: 'text', mime: 'text/plain', content: 'A public page about both' })) as { artifactId: string };
      for (const p of [t.gone, t.parked]) {
        await tc.call('save_stakeholder', {
          label: p.segment, stakeholder_type: 'leader', subject: 'follow', relation: 'x', follow: p.id, profile: t.publicInput(p.segment, [a.artifactId]),
        });
      }
      await tc.call('submit_result', { summary: 'followed two former colleagues', evidence: [a.artifactId] });
    };
    t.state.pick = (r: AgentRequest) =>
      r.kind === 'orchestrate'
        ? async (tc) => {
            const tasks = [{ ...spec('competitor_stakeholders'), brief: `follow them, round ${r.round}` }];
            const answer = (await tc.call('propose_tasks', { tasks })) as never;
            if (r.round > 1) second.push(answer);
          }
        : r.kind === 'work'
          ? followAll
          : r.kind === 'review'
            ? review(9)
            : undefined;
    await startPhase('ws_a', 'stakeholders', t.deps);
    const rounds = t.requests.filter((r) => r.kind === 'orchestrate');
    expect(rounds[0]!.prompt).toMatch(/## Former colleagues to follow\n2 former colleague\(s\)/);
    // Round 2: both were followed by the task of this run, so there is nobody left to plan a task for.
    expect(rounds[1]!.prompt).not.toContain('Former colleagues to follow');
    expect(second[0]!.accepted).toHaveLength(0);
    expect(second[0]!.rejected[0]!.reason).toMatch(/no former colleagues to follow/);
    expect(t.requests.filter((r) => r.kind === 'work')).toHaveLength(1);
  });

  it('the orchestrator is told how many former colleagues are followed, and nothing about them', () => {
    const t = followSetup(opened);
    const rr = t.store.researchRuns.insert({ id: 'rrun_1', workspaceId: 'ws_a', phase: 'stakeholders', status: 'running', startedAt: T0 });
    const prompt = orchestratorPrompt(t.store, t.config, rr, 1);
    const at = prompt.indexOf('## Former colleagues to follow\n');
    const note = prompt.slice(at, prompt.indexOf('\n\n', at));
    expect(note).toMatch(/^## Former colleagues to follow\n2 former colleague\(s\) of this node/);
    expect(note).toContain('competitor_stakeholders');
    // The note is a count: no id, no label, no text of anyone.
    expect(note).not.toMatch(/per_|Head of|[A-Z]+MARK/);
    // No such note in another phase, nor when nobody is followed.
    const other = t.store.researchRuns.insert({ id: 'rrun_2', workspaceId: 'ws_a', phase: 'deep_dives', status: 'running', startedAt: T0 });
    expect(orchestratorPrompt(t.store, t.config, other, 1)).not.toContain('Former colleagues to follow');
    const off = followSetup(opened, (c) => (c.stakeholders = { maxFollowed: 0 }));
    const rrOff = off.store.researchRuns.insert({ id: 'rrun_1', workspaceId: 'ws_a', phase: 'stakeholders', status: 'running', startedAt: T0 });
    expect(orchestratorPrompt(off.store, off.config, rrOff, 1)).not.toContain('Former colleagues to follow');
  });
});

// ---------------------------------------------------------------------------------------------------
describe('the review of a follow task', () => {
  /** A worker that saves a public layer for the former colleague at Rival Pay and submits. */
  const followWork =
    (t: FollowSetup): FakeScript =>
    async (tc) => {
      const a = (await tc.call('save_artifact', { kind: 'text', mime: 'text/plain', content: 'Rival Pay press release about its new VP Sales' })) as { artifactId: string };
      await tc.call('save_stakeholder', {
        label: 'Head of sales', stakeholder_type: 'leader', subject: 'follow', relation: 'runs sales', follow: t.gone.id, now_at: 'VP Sales at Rival Pay',
        profile: t.publicInput('Head of sales', [a.artifactId]),
      });
      await tc.call('submit_result', { summary: 'followed one former colleague', followed: [t.gone.id], evidence: [a.artifactId] });
    };

  it('the reviewer is shown the public layer the task saved, with its evidence, and nothing of the internal profile', async () => {
    const t = followSetup(opened);
    const task = t.task('competitor_stakeholders', { status: 'queued' });
    t.state.pick = (r) => (r.kind === 'work' ? followWork(t) : r.kind === 'review' ? review(9) : undefined);
    expect((await runTaskWithReview(task, t.deps)).status).toBe('verified');
    const reviewRun = t.requests.find((r) => r.kind === 'review')!;
    expect(reviewRun.prompt).toContain('Public profiles of former colleagues saved by this task');
    expect(reviewRun.prompt).toContain(`[${t.gone.id}] Head of sales`);
    expect(reviewRun.prompt).toContain('PUBLICMARK role_mandate of Head of sales');
    expect(reviewRun.prompt).toContain('now at: VP Sales at Rival Pay');
    expect(reviewRun.prompt).not.toMatch(/INTERNALMARK|RELATIONMARK/);
    // Its evidence is in the reviewer's slice; the persona itself is not (its record holds the internal profile).
    const page = t.store.personas.get(t.gone.id)!.publicProfile!.role_mandate!.evidence[0]!;
    const input = reviewerRunInput(t.deps, t.store.tasks.get(task.id)!, 1);
    expect(input.prompt).toContain(page);
    const slice = reviewSlice(t.deps, t.store.tasks.get(task.id)!);
    expect(slice.artifactIds.has(page)).toBe(true);
    expect(slice.ids.has(t.gone.id)).toBe(false);
    // The prompt read lists the page shown, not the persona record.
    expect(JSON.stringify(input.promptReads)).toContain(page);
    expect(JSON.stringify(input.promptReads)).not.toContain(t.gone.id);
  });

  it('a follow task that failed: the persona is still usable, its profile unchanged, its public layer stored and ignored by the combine run (Review Focus 3)', async () => {
    const t = followSetup(opened);
    const before = t.store.personas.get(t.gone.id)!;
    const task = t.task('competitor_stakeholders', { status: 'queued' });
    // The review does not pass and the revision ends without answering it, twice: the task ends failed.
    t.state.pick = (r) =>
      r.kind === 'work' ? followWork(t) : r.kind === 'review' ? review(2, [{ class: 'blocking', description: 'the page does not say that' }]) : async () => {};
    const done = await runTaskWithReview(task, t.deps);
    expect(done.status).toBe('failed');

    const after = t.store.personas.get(t.gone.id)!;
    expect(after).toMatchObject({ status: 'verified', version: before.version, profile: before.profile, publicTaskId: task.id });
    expect(isOutputUsable(after)).toBe(true);
    expect(after.taskId).toBe(before.taskId);
    expect(after.publicProfile!.role_mandate!.value).toBe('PUBLICMARK role_mandate of Head of sales');
    expect(readFileSync(after.agentMdPath, 'utf8')).not.toContain('PUBLICMARK');

    expect(needsCombine(t.store, after)).toBe(false);
    const asked = t.requests.length;
    expect(await runCombine('ws_a', t.deps)).toEqual({ combined: 0, skipped: [] });
    expect(t.requests).toHaveLength(asked);
    expect(t.store.personas.get(t.gone.id)).toEqual(after);
  });

  it('the save of a follow task that failed is exported with the task\'s status, not as the verified persona\'s', async () => {
    const t = followSetup(opened);
    const followSave = (taskId: string) => {
      const lines = exportTrainingData('ws_a', t).split('\n').filter(Boolean).map((l) => JSON.parse(l));
      const runs = new Set(t.store.agentRuns.list({ taskId }).map((r) => r.id));
      return lines.find((l) => l.decision?.payload?.layer === 'public' && runs.has(l.decision.agentRunId));
    };
    const failed = t.task('competitor_stakeholders', { status: 'queued' });
    t.state.pick = (r) =>
      r.kind === 'work' ? followWork(t) : r.kind === 'review' ? review(2, [{ class: 'blocking', description: 'the page does not say that' }]) : async () => {};
    expect((await runTaskWithReview(failed, t.deps)).status).toBe('failed');
    expect(t.store.personas.get(t.gone.id)!.status).toBe('verified');
    expect(followSave(failed.id)).toMatchObject({ finalReviewStatus: 'failed' });

    const passed = t.task('competitor_stakeholders', { status: 'queued' });
    t.state.pick = (r) => (r.kind === 'work' ? followWork(t) : r.kind === 'review' ? review(9) : undefined);
    expect((await runTaskWithReview(passed, t.deps)).status).toBe('verified');
    expect(followSave(passed.id)).toMatchObject({ finalReviewStatus: 'verified' });
    expect(followSave(failed.id)).toMatchObject({ finalReviewStatus: 'failed' });
  });

  it('the reviewer is shown what research saw of the position only when this task saved it', async () => {
    const t = followSetup(opened);
    // An earlier task saw where the person works now.
    const earlier = t.task();
    const oldPage = t.art('An older page naming the new title');
    await t.follow(earlier, t.gone.id, { profile: t.publicInput('Head of sales', [oldPage]), now_at: 'OLDNOWAT VP Sales at Rival Pay' });
    expect(t.store.personas.get(t.gone.id)!.publicPosition).toEqual({ text: 'OLDNOWAT VP Sales at Rival Pay', evidence: [oldPage], taskId: earlier.id });

    // This task follows the same person and says nothing about the position: the old line stays stored.
    const task = t.task('competitor_stakeholders', { status: 'queued', runId: 'rrun_2' });
    const silentWork: FakeScript = async (tc) => {
      const a = (await tc.call('save_artifact', { kind: 'text', mime: 'text/plain', content: 'A newer interview' })) as { artifactId: string };
      await tc.call('save_stakeholder', {
        label: 'Head of sales', stakeholder_type: 'leader', subject: 'follow', relation: 'runs sales', follow: t.gone.id, profile: t.publicInput('Head of sales', [a.artifactId]),
      });
      await tc.call('submit_result', { summary: 'followed one former colleague', followed: [t.gone.id], evidence: [a.artifactId] });
    };
    t.state.pick = (r) => (r.kind === 'work' ? silentWork : r.kind === 'review' ? review(9) : undefined);
    expect((await runTaskWithReview(task, t.deps)).status).toBe('verified');
    expect(t.store.personas.get(t.gone.id)).toMatchObject({ publicTaskId: task.id, publicPosition: { text: 'OLDNOWAT VP Sales at Rival Pay', taskId: earlier.id } });

    const reviewRun = t.requests.find((r) => r.kind === 'review')!;
    expect(reviewRun.prompt).toContain(`[${t.gone.id}] Head of sales`);
    expect(reviewRun.prompt).not.toContain('now at:');
    expect(reviewRun.prompt).not.toContain('OLDNOWAT');
    // Nor is the page the earlier task cited among what this review is given.
    expect(reviewRun.prompt).not.toContain(oldPage);
    expect(reviewSlice(t.deps, t.store.tasks.get(task.id)!).artifactIds.has(oldPage)).toBe(false);
  });
});
