/**
 * Stakeholder positions end to end (design 2026-11-15-stakeholder-positions-design.md §11), with fake
 * agents:
 *
 * research saves an own stakeholder (hidden) → the user opens it → records that the person left for a
 * company not listed (a competitor is created) → a first follow research fails review (the persona stays
 * usable, its public layer stored and unused) → a second one passes → the combine run writes one profile
 * from both layers, offline → the former colleague reads a recommendation as a rival, offline → the
 * user records that the person returned. Checked on the way: the history, both layers, what each
 * combined field rests on, and what the export leaves out.
 *
 * And across two business trees: every new action and route answers 404 for the other tree's ids,
 * exactly like for an unknown id, and changes nothing.
 */
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../../src/api/routes.js';
import { listFeedback } from '../../../src/core/feedback/events.js';
import type { FakeScript } from '../../../src/core/harness/adapter.js';
import { agentMdPath, writeAgentMd } from '../../../src/core/market/personas.js';
import type { AgentRequest } from '../../../src/core/research/deps.js';
import { startPhase } from '../../../src/core/research/orchestrator.js';
import { isOutputUsable } from '../../../src/core/research/outputs.js';
import { researchToolHandlers } from '../../../src/core/research/tools.js';
import { STAKEHOLDER_FIELDS } from '../../../src/core/scoring/criteria.js';
import { exportTrainingDataWithSummary } from '../../../src/core/scoring/export.js';
import { needsCombine, runCombine, submitCombinedProfileHandler } from '../../../src/core/stakeholders/combine.js';
import {
  colleaguesToFollow,
  isCurrentOwn,
  isHidden,
  stakeholderPersonas,
  stakeholderTaskSection,
  stakeholderToolHandlers,
  treeCompetitors,
} from '../../../src/core/stakeholders/personas.js';
import { changePosition, formerColleagues, markLeft, markReturned, positionsOf, type PositionDeps } from '../../../src/core/stakeholders/positions.js';
import { openQuestions, revealStakeholder } from '../../../src/core/stakeholders/questions.js';
import { readsOf, runStakeholderReads, submitStakeholderReadHandler } from '../../../src/core/stakeholders/reads.js';
import { StakeholderError } from '../../../src/core/stakeholders/statements.js';
import { stakeholderRepos } from '../../../src/core/stakeholders/store.js';
import { RIVAL_STANCES } from '../../../src/core/stakeholders/types.js';
import type { Store } from '../../../src/core/store/db.js';
import type { Persona, PersonaProfileField } from '../../../src/core/types.js';
import { addTask, researchSetup, review } from '../helpers/research.js';

const T0 = '2026-11-15T10:00:00.000Z';
const ACTOR = 'tester';
/** Days that have passed in every time zone at the fixed clock. */
const LEFT = '2026-10-31';
const BACK = '2026-11-10';

const opened: Store[] = [];
let minute = 0;
beforeEach(() => {
  minute = 0;
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(T0));
});
afterEach(() => {
  vi.useRealTimers();
  for (const s of opened.splice(0)) s.close();
});
const tick = (): string => {
  vi.setSystemTime(new Date(Date.parse(T0) + ++minute * 60_000));
  return new Date().toISOString();
};

function setup() {
  const t = researchSetup(opened, {
    extraHandlers: ({ config }) => ({
      ...researchToolHandlers(),
      ...stakeholderToolHandlers({ dataDir: config.dataDir }),
      submit_combined_profile: submitCombinedProfileHandler,
      submit_stakeholder_read: submitStakeholderReadHandler,
    }),
  });
  const pos: PositionDeps = { store: t.store, dataDir: t.dir };
  return { ...t, pos };
}

type Basis = NonNullable<PersonaProfileField['basis']>;
/** What the fake combine run says each field rests on: one field per basis, the others on both layers. */
const BASES: Record<string, Basis> = { role_mandate: 'public', decision_criteria: 'internal', goals_incentives: 'both', objections: 'inferred' };
const basisOf = (field: string): Basis => BASES[field] ?? 'both';
const CONFLICT = 'Inside they decided on margin; the press says on growth.';

const followPart = (text: string) => (text.includes('## Former colleagues to follow') ? text.slice(text.indexOf('## Former colleagues to follow')) : '');
type Line = Record<string, any>;
const linesOf = (jsonl: string): Line[] => jsonl.split('\n').filter(Boolean).map((l) => JSON.parse(l) as Line);

// ---------------------------------------------------------------------------------------------------
// The journey

/**
 * Runs the journey on a fresh store, checking each step, and returns what the export is checked
 * against. `internalKind`: what the company's own knowledge of the person rests on, a note research
 * captured (`text`) or a document the user uploaded (`upload`).
 */
async function journey(internalKind: 'text' | 'upload') {
  const t = setup();
  t.store.workspaces.insert({
    id: 'ws_a', name: 'Acme', sector: 'saas', createdAt: T0, scope: { level: 'division', name: 'Acme Payments', description: 'payments division' },
  });
  const source = t.artifacts.save({ workspaceId: 'ws_a', kind: internalKind, mime: 'text/plain', bytes: 'INTERNALMARK org notes: who signs off on discounts' }).id;

  // What the fake agents do in the phase being run: which research, and how its review scores it.
  const plan: { type: 'own_stakeholders' | 'competitor_stakeholders'; score: number } = { type: 'own_stakeholders', score: 9 };
  const nothing: FakeScript = async () => {};
  const ownWork: FakeScript = async (tc) => {
    await tc.call('save_stakeholder', {
      label: 'Head of sales', stakeholder_type: 'leader', subject: 'own', relation: 'INTERNALMARK approves every discount over ten percent',
      profile: Object.fromEntries(STAKEHOLDER_FIELDS.map((f) => [f, { value: `INTERNALMARK ${f} as known from inside`, confidence: 0.7, evidence: [source] }])),
    });
    await tc.call('submit_result', { summary: 'one stakeholder' });
  };
  /** Follows whoever its prompt lists: the id comes from the prompt, as for a real worker. */
  const followWork =
    (req: AgentRequest): FakeScript =>
    async (tc) => {
      const listed = [...followPart(req.prompt).matchAll(/^- (per_\w+): /gm)].map((m) => m[1]!);
      const page = (await tc.call('save_artifact', { kind: 'text', mime: 'text/plain', content: `PUBLICMARK press release (${new Date().toISOString()})` })) as { artifactId: string };
      for (const id of listed) {
        await tc.call('save_stakeholder', {
          label: 'someone', stakeholder_type: 'other', subject: 'follow', relation: 'x', follow: id, now_at: 'VP Sales at Rival Pay',
          profile: Object.fromEntries(STAKEHOLDER_FIELDS.map((f) => [f, { value: `PUBLICMARK ${f} as the press shows it`, confidence: 0.4, evidence: [page.artifactId] }])),
        });
      }
      await tc.call('submit_result', { summary: `followed ${listed.length} former colleague(s)`, evidence: [page.artifactId] });
    };
  const combine =
    (req: AgentRequest): FakeScript =>
    async (tc) => {
      await tc.call('submit_combined_profile', {
        persona_id: /persona_id `(\w+)`/.exec(req.prompt)![1]!,
        profile: Object.fromEntries(
          STAKEHOLDER_FIELDS.map((f) => [
            f,
            { value: `COMBINEDMARK ${f} from both layers`, confidence: 0.5, basis: basisOf(f), ...(f === 'goals_incentives' ? { conflict: CONFLICT } : {}) },
          ]),
        ),
      });
    };
  const read =
    (req: AgentRequest): FakeScript =>
    async (tc) => {
      await tc.call('submit_stakeholder_read', {
        recommendation_id: /^Recommendation id: (\S+)$/m.exec(req.prompt)![1]!, stance: 'counter', conditions: [], concerns: ['they know our price floor'],
        reasoning: 'READMARK would answer with a discount', would_change_mind: 'a patent',
      });
    };
  t.state.pick = (req) => {
    if (req.kind === 'orchestrate') {
      if (req.round !== 1) return nothing;
      return async (tc) => {
        await tc.call('propose_tasks', {
          tasks: [{ type: plan.type, brief: `do ${plan.type}, planned ${new Date().toISOString()}`, model: { provider: 'claude', model: 'sonnet' }, needs_browser: false, acceptance_criteria: ['evidence'] }],
        });
      };
    }
    if (req.role === 'reviewer') return review(plan.score, plan.score < 5 ? [{ class: 'blocking', description: 'the page does not say that' }] : []);
    if (req.role === 'retro') return combine(req);
    if (req.role === 'persona') return read(req);
    if (req.kind === 'work') return plan.type === 'own_stakeholders' ? ownWork : followWork(req);
    return nothing; // a revision that does not answer its review: the task ends failed
  };
  /** One run of the stakeholders phase; returns its task and the agent runs it asked for. */
  const phase = async (type: typeof plan.type, score: number) => {
    Object.assign(plan, { type, score });
    tick();
    const before = t.requests.length;
    const rr = await startPhase('ws_a', 'stakeholders', t.deps);
    const tasks = t.store.tasks.list({ runId: rr.id });
    expect(tasks).toHaveLength(1);
    return { task: tasks[0]!, requests: t.requests.slice(before) };
  };
  const persona = (): Persona => {
    const all = stakeholderPersonas(t.store, 'ws_a');
    expect(all).toHaveLength(1);
    return all[0]!;
  };

  // --- 1. research saves an own stakeholder: hidden, with its question round ----------------------
  const own = await phase('own_stakeholders', 9);
  expect(own.task).toMatchObject({ type: 'own_stakeholders', status: 'verified' });
  const saved = persona();
  expect(saved).toMatchObject({ slug: 'stk-head-of-sales', subjectKind: 'own', disclosure: 'hidden', status: 'verified', version: 1 });
  expect(openQuestions(t.store, 'ws_a').some((g) => g.persona?.id === saved.id)).toBe(true);
  // A hidden stakeholder cannot change position yet.
  expect(() => markLeft(t.pos, ACTOR, 'ws_a', saved.id, { date: LEFT, to: { elsewhere: {} } })).toThrow(/answer or skip its questions first/);
  expect(positionsOf(t.store, saved.id)).toEqual([]);

  // --- 2. the user opens it, then records that the person left for a company not listed -----------
  tick();
  revealStakeholder(t.store, ACTOR, 'ws_a', saved.id);
  expect(isHidden(persona())).toBe(false);
  tick();
  const gone = markLeft(t.pos, ACTOR, 'ws_a', saved.id, {
    date: LEFT, to: { newCompetitor: { name: 'Rival Pay', site: 'rivalpay.example' } }, title: 'VP Sales', note: 'NOTEMARK announced at the all-hands',
  });
  const competitor = treeCompetitors(t.store, 'ws_a')[0]!;
  expect(competitor).toMatchObject({ name: 'Rival Pay', site: 'rivalpay.example', threat: 1, directness: 1, status: 'unverified', evidence: [] });
  expect(gone).toMatchObject({
    subjectKind: 'competitor', subjectId: competitor.id, slug: 'stk-rival-pay-head-of-sales', leftAt: LEFT, version: 2, status: 'verified', relation: 'VP Sales',
    leftFrom: { workspaceId: 'ws_a', scopeName: 'Acme Payments', stakeholderType: 'leader', relation: 'INTERNALMARK approves every discount over ten percent' },
  });
  // What was known is the internal layer now; every field of the working profile rests on it.
  for (const f of STAKEHOLDER_FIELDS) {
    expect(gone.internalProfile![f]).toEqual({ value: `INTERNALMARK ${f} as known from inside`, confidence: 0.7, evidence: [source], basis: 'internal' });
  }
  expect(gone.profile).toEqual(gone.internalProfile);
  expect(gone).not.toHaveProperty('publicProfile');
  expect(formerColleagues(t.store, 'ws_a').map((p) => p.id)).toEqual([gone.id]);

  // --- 3. follow research that fails review: the layer is stored and not used (Review Focus 3) ----
  const failed = await phase('competitor_stakeholders', 2);
  expect(failed.task).toMatchObject({ type: 'competitor_stakeholders', status: 'failed' });
  const work = failed.requests.find((r) => r.kind === 'work')!;
  // The research works on the web: it is told who to follow and nothing that is known from inside.
  expect(work.offline).toBeUndefined();
  expect(followPart(work.prompt)).toContain(`- ${gone.id}: Head of sales — was leader at Acme Payments until ${LEFT}; now at Rival Pay`);
  for (const r of failed.requests.filter((x) => x.role !== 'retro')) expect(`${r.systemPrompt}\n${r.prompt}`).not.toContain('INTERNALMARK');
  const afterFailed = persona();
  expect(afterFailed).toMatchObject({ status: 'verified', version: gone.version, profile: gone.profile, internalProfile: gone.internalProfile, publicTaskId: failed.task.id });
  expect(isOutputUsable(afterFailed)).toBe(true);
  expect(afterFailed.publicProfile!.role_mandate!.value).toBe('PUBLICMARK role_mandate as the press shows it');
  expect(afterFailed).not.toHaveProperty('combinedAt');
  expect(needsCombine(t.store, afterFailed)).toBe(false);
  expect(failed.requests.some((r) => r.role === 'retro')).toBe(false);
  expect(readFileSync(afterFailed.agentMdPath, 'utf8')).not.toContain('PUBLICMARK');
  // A former colleague is asked nothing in the question round the phase end opens (Review Focus 1).
  expect(openQuestions(t.store, 'ws_a').some((g) => g.persona?.id === gone.id)).toBe(false);
  expect(stakeholderRepos(t.store).questions.list({ personaId: gone.id, status: 'open' })).toEqual([]);

  // --- 4. follow research that passes, then the combine run at the end of the phase -----------------
  const passed = await phase('competitor_stakeholders', 9);
  expect(passed.task).toMatchObject({ type: 'competitor_stakeholders', status: 'verified' });
  for (const r of passed.requests.filter((x) => x.role !== 'retro')) expect(`${r.systemPrompt}\n${r.prompt}`).not.toContain('INTERNALMARK');
  const retro = passed.requests.filter((r) => r.role === 'retro');
  expect(retro).toHaveLength(1);
  // After the tasks have ended, without web access, shown both layers.
  expect(passed.requests.at(-1)).toBe(retro[0]);
  expect(retro[0]).toMatchObject({ kind: 'retro', offline: true });
  expect(retro[0]!.prompt).toContain('INTERNALMARK decision_criteria as known from inside');
  expect(retro[0]!.prompt).toContain('PUBLICMARK decision_criteria as the press shows it');
  expect(retro[0]!.prompt).toContain(`as of ${LEFT}`);

  const combined = persona();
  const page = combined.publicProfile!.role_mandate!.evidence[0]!;
  expect(combined).toMatchObject({
    version: gone.version + 1, status: 'verified', subjectKind: 'competitor', subjectId: competitor.id, leftAt: LEFT, publicTaskId: passed.task.id,
    publicPosition: { text: 'VP Sales at Rival Pay', evidence: [page], taskId: passed.task.id },
  });
  expect(combined.combinedAt! >= combined.publicSavedAt!).toBe(true);
  expect(needsCombine(t.store, combined)).toBe(false);
  // The two layers are stored apart, each as it was.
  expect(combined.internalProfile).toEqual(gone.internalProfile);
  for (const f of STAKEHOLDER_FIELDS) {
    expect(combined.publicProfile![f]).toEqual({ value: `PUBLICMARK ${f} as the press shows it`, confidence: 0.4, evidence: [page], basis: 'public' });
  }
  // The combined profile: every field says what it rests on, and its evidence is taken from the layers.
  const evidenceBy: Record<Basis, string[]> = { internal: [source], public: [page], both: [source, page], inferred: [source, page] };
  for (const f of STAKEHOLDER_FIELDS) {
    expect(combined.profile[f], f).toEqual({
      value: `COMBINEDMARK ${f} from both layers`, confidence: 0.5, basis: basisOf(f), evidence: evidenceBy[basisOf(f)], ...(f === 'goals_incentives' ? { conflict: CONFLICT } : {}),
    });
  }
  expect(new Set(STAKEHOLDER_FIELDS.map(basisOf))).toEqual(new Set(['internal', 'public', 'both', 'inferred']));
  const md = readFileSync(combined.agentMdPath, 'utf8');
  expect(md).toContain('former_colleague: true');
  expect(md).toContain(`version: ${combined.version}`);
  expect(md).toContain(`Until ${LEFT} you worked at Acme Payments`);
  expect(md).toContain('COMBINEDMARK decision_criteria from both layers');
  expect(md).toContain(`_Rests on: internal knowledge (as of ${LEFT})_`);
  expect(md).toContain('_Rests on: public sources_');
  expect(md).toContain(`_Conflict: ${CONFLICT}_`);
  // Run again, nothing is combined twice.
  expect(await runCombine('ws_a', t.deps)).toEqual({ combined: 0, skipped: [] });

  // --- 5. a recommendation is read as a rival, offline (Review Focus 1) --------------------------
  t.store.recommendations.insert({
    id: 'rec_1', workspaceId: 'ws_a', title: 'Raise prices', summary: 'A 10% price rise', criteria: {}, findingIds: [], priority: 3, personaFeedback: [],
    createdAt: T0, status: 'verified',
  });
  tick();
  const asked = t.requests.length;
  expect(await runStakeholderReads('ws_a', t.deps)).toEqual({ reads: 1, missing: [], skippedByCap: 0 });
  const readRuns = t.requests.slice(asked);
  expect(readRuns).toHaveLength(1);
  expect(readRuns[0]).toMatchObject({ role: 'persona', offline: true });
  // Its agent.md (what the company knew from inside) is the system prompt: the reason the run is offline.
  expect(readRuns[0]!.systemPrompt).toContain('former_colleague: true');
  expect(readRuns[0]!.prompt).toContain('your rival');
  expect(readRuns[0]!.prompt).not.toContain('Would you approve this');
  const reads = readsOf(t.store, 'ws_a', 'rec_1');
  expect(reads).toHaveLength(1);
  expect(reads[0]).toMatchObject({ personaId: gone.id, personaVersion: combined.version, stance: 'counter', simulated: true });
  expect(RIVAL_STANCES).toContain(reads[0]!.stance);
  expect(t.store.recommendations.get('rec_1')!.priority).toBe(3);

  // --- 6. the person returns ---------------------------------------------------------------------
  tick();
  const back = markReturned(t.pos, ACTOR, 'ws_a', gone.id, { date: BACK, toWorkspaceId: 'ws_a', title: 'Chief revenue officer' });
  expect(back).toMatchObject({
    id: saved.id, subjectKind: 'own', slug: 'stk-head-of-sales', disclosure: 'open', positionTitle: 'Chief revenue officer', version: combined.version + 1, status: 'verified',
  });
  expect(isCurrentOwn(back)).toBe(true);
  // The combined profile stays as the working profile, with what each field rests on; the layers go.
  expect(back.profile).toEqual(combined.profile);
  for (const key of ['leftAt', 'leftFrom', 'internalProfile', 'publicProfile', 'publicTaskId', 'publicSavedAt', 'combinedAt', 'publicPosition', 'subjectId']) {
    expect(back, key).not.toHaveProperty(key);
  }
  expect(formerColleagues(t.store, 'ws_a')).toEqual([]);
  expect(readFileSync(back.agentMdPath, 'utf8')).not.toContain('former_colleague');

  // The history: where the person was, then each change, newest first.
  const history = positionsOf(t.store, saved.id);
  expect(history.map((h) => [h.change, h.placeKind, h.effectiveOn, h.title])).toEqual([
    ['returned', 'node', BACK, 'Chief revenue officer'],
    ['left', 'competitor', LEFT, 'VP Sales'],
    ['joined', 'node', undefined, undefined],
  ]);
  expect(history[1]).toMatchObject({ competitorId: competitor.id, actor: ACTOR, note: 'NOTEMARK announced at the all-hands', rootWorkspaceId: 'ws_a' });
  expect(history[2]).toMatchObject({ workspaceId: 'ws_a', relation: 'INTERNALMARK approves every discount over ten percent' });
  const changes = listFeedback(t.store, { kind: 'stakeholder_position_change' });
  expect(changes.map((e) => (e.afterJson as { change: string }).change)).toEqual(['left', 'returned']);

  const runsOf = (taskId: string) => new Set(t.store.agentRuns.list({ taskId }).map((r) => r.id));
  return { t, personaId: saved.id, source, page, tasks: { own: own.task, failed: failed.task, passed: passed.task }, runsOf, combined };
}

/** The exported lines, and those of a kind. */
function exported(j: Awaited<ReturnType<typeof journey>>, includeUploads = false) {
  const { jsonl, summary } = exportTrainingDataWithSummary('ws_a', j.t, includeUploads);
  const all = linesOf(jsonl);
  const tool = (name: string) => all.filter((l) => l.decision?.payload?.tool === name);
  return {
    jsonl, summary, all, tool,
    followSaves: all.filter((l) => l.decision?.payload?.layer === 'public'),
    positionChanges: all.filter((l) => l.feedbackEvent?.kind === 'stakeholder_position_change'),
    ofTask: (taskId: string) => all.filter((l) => l.decision && j.runsOf(taskId).has(l.decision.agentRunId)),
  };
}

describe('stakeholder positions end to end', () => {
  it('own → left for a new competitor → follow research (failed, then passed) → combined → read as a rival, offline → returned; the export leaves the internal records out', async () => {
    const j = await journey('text');

    // By default: nothing the company knew from inside, said or decided about the person.
    const byDefault = exported(j);
    expect(byDefault.positionChanges).toEqual([]);
    expect(byDefault.all.filter((l) => String(l.feedbackEvent?.kind ?? '').startsWith('stakeholder_'))).toEqual([]);
    expect(byDefault.tool('submit_combined_profile')).toEqual([]);
    expect(byDefault.tool('submit_stakeholder_read')).toEqual([]);
    expect(byDefault.all.filter((l) => ['stakeholder_read', 'stakeholder_statement', 'stakeholder_question'].includes(l.type))).toEqual([]);
    // Own-stakeholder research is internal as before.
    expect(byDefault.ofTask(j.tasks.own.id)).toEqual([]);
    expect(byDefault.jsonl).not.toMatch(/INTERNALMARK|COMBINEDMARK|NOTEMARK|READMARK|stakeholder_combine/);
    // The follow research is public research: its saves are exported like any competitor stakeholder's,
    // each with the status of its own task and not as a judgment of the persona.
    expect(byDefault.followSaves.map((l) => [l.decision.payload.followedPersonaId, l.finalReviewStatus])).toEqual([
      [j.personaId, 'failed'],
      [j.personaId, 'verified'],
    ]);
    for (const l of byDefault.followSaves) expect(l.decision.payload).not.toHaveProperty('personaId');
    expect(byDefault.summary.excludedJudgments.byCause.find((c) => c.cause === 'internal')!.count).toBeGreaterThan(0);

    // With the switch, the internal records are there (the checks above are not vacuous).
    const all = exported(j, true);
    expect(all.positionChanges.map((l) => l.feedbackEvent.afterJson.change)).toEqual(['left', 'returned']);
    expect(all.positionChanges[0]!.feedbackEvent.reason).toContain('NOTEMARK');
    expect(all.tool('submit_combined_profile')).toHaveLength(1);
    expect(all.tool('submit_stakeholder_read')).toHaveLength(1);
    expect(all.all.filter((l) => l.type === 'stakeholder_read')).toHaveLength(1);
    expect(all.ofTask(j.tasks.own.id).length).toBeGreaterThan(0);
    expect(all.followSaves).toHaveLength(2);
  });

  it('what was known from inside rests on an upload: the combined fields that keep it carry it, and nothing judged about the person is exported by default (Review Focus 5)', async () => {
    const j = await journey('upload');
    // Fields kept from inside, resting on both, or concluded from both carry the upload; the public one does not.
    for (const f of STAKEHOLDER_FIELDS) {
      const field = j.combined.profile[f]!;
      expect(field.evidence.includes(j.source), `${f} (${field.basis})`).toBe(field.basis !== 'public');
    }
    expect(j.combined.profile.role_mandate!.evidence).toEqual([j.page]);

    const byDefault = exported(j);
    // The existing provenance rule: a judgment that names the persona reaches the upload through its profile.
    expect(byDefault.followSaves).toEqual([]);
    expect(byDefault.ofTask(j.tasks.failed.id)).toEqual([]);
    expect(byDefault.ofTask(j.tasks.passed.id)).toEqual([]);
    expect(byDefault.all.filter((l) => JSON.stringify(l).includes(j.personaId))).toEqual([]);
    expect(byDefault.jsonl).not.toMatch(/INTERNALMARK|COMBINEDMARK|NOTEMARK|READMARK/);
    expect(byDefault.summary.excludedJudgments.byCause.find((c) => c.cause === 'cites_upload')!.count).toBeGreaterThan(0);

    const all = exported(j, true);
    expect(all.followSaves).toHaveLength(2);
    expect(all.tool('submit_combined_profile')).toHaveLength(1);
    expect(all.ofTask(j.tasks.passed.id).length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------------------------------
// Two business trees

const TREES = { a: { ws: 'ws_a', child: 'ws_a_child', mark: 'MARK_TREE_A' }, b: { ws: 'ws_b', child: 'ws_b_child', mark: 'MARK_TREE_B' } } as const;
type Tree = keyof typeof TREES;
const other = (x: Tree): Tree => (x === 'a' ? 'b' : 'a');

/** What one tree holds: an own stakeholder, a former colleague at its competitor (followed), a parked one. */
type Seeded = { own: Persona; gone: Persona; parked: Persona; competitorId: string; taskId: string };

async function twoTrees() {
  const t = setup();
  const seed = async (x: Tree): Promise<Seeded> => {
    const { ws, child, mark } = TREES[x];
    t.store.workspaces.insert({ id: ws, name: `Company ${mark}`, sector: 'saas', createdAt: T0 });
    t.store.workspaces.insert({ id: child, name: `Payments ${mark}`, sector: 'saas', createdAt: T0, parentWorkspaceId: ws });
    const competitorId = `cmp_${x}`;
    t.store.competitors.insert({
      id: competitorId, workspaceId: ws, name: `Rival ${mark}`, threat: 4, directness: 4, comparison: { pricing: 3, onboarding: 3, ux: 3, features: 3 }, evidence: [],
      createdAt: T0, updatedAt: T0, status: 'verified',
    });
    // The same labels in both trees, so the same slugs.
    const stakeholder = (name: string, label: string): Persona => {
      const slug = `stk-${label.toLowerCase().replace(/ /g, '-')}`;
      const p = t.store.personas.insert({
        id: `per_${name}_${x}`, workspaceId: ws, slug, segment: label, version: 1, status: 'verified', agentMdPath: agentMdPath(t.dir, ws, slug), kind: 'stakeholder',
        stakeholderType: 'leader', subjectKind: 'own', relation: `approves budgets ${mark}`, disclosure: 'open',
        profile: Object.fromEntries(STAKEHOLDER_FIELDS.map((f) => [f, { value: `${f} ${mark}`, confidence: 0.6, evidence: [] }])),
      });
      writeAgentMd(t.store, p);
      return p;
    };
    const own = stakeholder('own', 'Head of finance');
    tick();
    markLeft(t.pos, ACTOR, ws, stakeholder('gone', 'Head of sales').id, { date: LEFT, to: { competitorId }, note: `left ${mark}` });
    markLeft(t.pos, ACTOR, ws, stakeholder('parked', 'Head of legal').id, { date: LEFT, to: { elsewhere: { companyName: `Firm ${mark}` } } });
    // Research of this tree has followed the one at the competitor: its layers wait to be combined.
    const task = addTask(t.store, { workspaceId: ws, runId: `rrun_${x}`, phase: 'stakeholders', type: 'competitor_stakeholders', brief: `follow ${mark}`, subject: undefined, status: 'verified' });
    const page = t.artifacts.save({ workspaceId: ws, kind: 'text', mime: 'text/plain', bytes: `press ${mark}` }).id;
    tick();
    const followed = await t.handle(
      { agentRunId: `arun_follow_${x}`, workspaceId: ws, role: 'worker', model: { provider: 'claude', model: 'sonnet' }, promptVersion: 'pv', taskId: task.id },
      'save_stakeholder',
      {
        label: 'x', stakeholder_type: 'other', subject: 'follow', relation: 'x', follow: `per_gone_${x}`, now_at: `VP Sales at Rival ${mark}`,
        profile: Object.fromEntries(STAKEHOLDER_FIELDS.map((f) => [f, { value: `public ${f} ${mark}`, confidence: 0.4, evidence: [page] }])),
      },
    );
    expect(followed.ok).toBe(true);
    const get = (name: string) => t.store.personas.get(`per_${name}_${x}`)!;
    return { own: get('own'), gone: get('gone'), parked: get('parked'), competitorId, taskId: task.id };
  };
  const seeded = { a: await seed('a'), b: await seed('b') } as Record<Tree, Seeded>;

  /** Everything an action may change, files included: a refused action leaves it as it was. */
  const snapshot = () =>
    JSON.stringify({
      personas: t.store.personas.list({}), positions: stakeholderRepos(t.store).positions.list({}), competitors: t.store.competitors.list({}),
      feedback: listFeedback(t.store), questions: stakeholderRepos(t.store).questions.list({}), decisions: t.store.decisions.list({}).length,
      files: t.store.personas.list({}).map((p) => readFileSync(p.agentMdPath, 'utf8')),
    });
  /** The marker and every id of tree `x`. */
  const traces = (x: Tree): string[] => {
    const s = seeded[x];
    const rows = [s.own, s.gone, s.parked].flatMap((p) => positionsOf(t.store, p.id).map((h) => h.id));
    return [TREES[x].mark, s.own.id, s.gone.id, s.parked.id, s.competitorId, s.taskId, ...rows];
  };
  const app = createApp({ store: t.store, artifacts: t.artifacts, events: t.events, config: t.config, research: t.deps });
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await app.request(path, { method, headers: { 'content-type': 'application/json' }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    const text = await res.text();
    return { status: res.status, text, error: (JSON.parse(text || '{}') as { error?: string }).error };
  };
  return { ...t, seeded, snapshot, traces, call };
}

/** The refusal of `fn`: its status and message. */
const refusal = (fn: () => unknown): { status: number; message: string } => {
  try {
    fn();
  } catch (e) {
    if (e instanceof StakeholderError) return { status: e.status, message: e.message };
    throw e;
  }
  return { status: 200, message: '' };
};

describe('stakeholder positions stay inside their business tree', () => {
  it('both trees hold the same shape of data under the same slugs', async () => {
    const t = await twoTrees();
    for (const x of ['a', 'b'] as const) {
      const s = t.seeded[x];
      expect([s.own.slug, s.gone.slug, s.parked.slug]).toEqual(['stk-head-of-finance', `stk-rival-mark-tree-${x}-head-of-sales`, 'stk-head-of-legal']);
      expect(s.gone).toMatchObject({ workspaceId: TREES[x].ws, subjectKind: 'competitor', subjectId: s.competitorId, leftAt: LEFT, publicTaskId: s.taskId });
      expect(s.parked).toMatchObject({ subjectKind: 'former', leftAt: LEFT });
      expect(needsCombine(t.store, s.gone)).toBe(true);
    }
  });

  it('what one tree lists (former colleagues, who to follow, competitors, history) holds nothing of the other', async () => {
    const t = await twoTrees();
    for (const x of ['a', 'b'] as const) {
      const { ws, child } = TREES[x];
      const mine = t.seeded[x];
      const foreign = t.traces(other(x));
      const leaks = (v: unknown) => foreign.filter((id) => JSON.stringify(v).includes(id));
      expect(formerColleagues(t.store, ws).map((p) => p.id)).toEqual([mine.parked.id, mine.gone.id]);
      expect(colleaguesToFollow(t.store, t.config, ws).map((p) => p.id)).toEqual([mine.parked.id, mine.gone.id]);
      for (const node of [ws, child]) {
        expect(treeCompetitors(t.store, node).map((c) => c.id)).toEqual([mine.competitorId]);
        const section = stakeholderTaskSection(t.store, t.config, { type: 'competitor_stakeholders', workspaceId: node });
        expect(leaks(section)).toEqual([]);
        expect(section).toContain(mine.competitorId);
      }
      expect(stakeholderTaskSection(t.store, t.config, { type: 'competitor_stakeholders', workspaceId: ws })).toContain(mine.gone.id);
      expect(leaks(stakeholderRepos(t.store).positions.list({ rootWorkspaceId: ws }))).toEqual([]);
      expect(stakeholderRepos(t.store).positions.list({ rootWorkspaceId: ws })).toHaveLength(4);
    }
  });

  it('every action with an id of the other tree answers 404, exactly like an unknown id, and changes nothing', async () => {
    const t = await twoTrees();
    for (const x of ['a', 'b'] as const) {
      const { ws } = TREES[x];
      const mine = t.seeded[x];
      const theirs = t.seeded[other(x)];
      const there = TREES[other(x)];
      const before = t.snapshot();
      const left = { date: LEFT, to: { elsewhere: {} } };
      const actions: Array<[string, () => unknown, () => unknown, string, string]> = [
        // [what, with the other tree's id, with an unknown id, the foreign id, the unknown id]
        ['left: persona', () => markLeft(t.pos, ACTOR, ws, theirs.own.id, left), () => markLeft(t.pos, ACTOR, ws, 'per_nope', left), theirs.own.id, 'per_nope'],
        [
          'left: competitor', () => markLeft(t.pos, ACTOR, ws, mine.own.id, { date: LEFT, to: { competitorId: theirs.competitorId } }),
          () => markLeft(t.pos, ACTOR, ws, mine.own.id, { date: LEFT, to: { competitorId: 'cmp_nope' } }), theirs.competitorId, 'cmp_nope',
        ],
        [
          'moved on: competitor', () => markLeft(t.pos, ACTOR, ws, mine.gone.id, { date: LEFT, to: { competitorId: theirs.competitorId } }),
          () => markLeft(t.pos, ACTOR, ws, mine.gone.id, { date: LEFT, to: { competitorId: 'cmp_nope' } }), theirs.competitorId, 'cmp_nope',
        ],
        [
          'moved on: a parked one', () => markLeft(t.pos, ACTOR, ws, mine.parked.id, { date: LEFT, to: { competitorId: theirs.competitorId } }),
          () => markLeft(t.pos, ACTOR, ws, mine.parked.id, { date: LEFT, to: { competitorId: 'cmp_nope' } }), theirs.competitorId, 'cmp_nope',
        ],
        ['moved on: persona', () => markLeft(t.pos, ACTOR, ws, theirs.gone.id, left), () => markLeft(t.pos, ACTOR, ws, 'per_nope', left), theirs.gone.id, 'per_nope'],
        [
          'promoted: persona', () => changePosition(t.pos, ACTOR, ws, theirs.own.id, { change: 'promoted', date: LEFT }),
          () => changePosition(t.pos, ACTOR, ws, 'per_nope', { change: 'promoted', date: LEFT }), theirs.own.id, 'per_nope',
        ],
        [
          'moved: node', () => changePosition(t.pos, ACTOR, ws, mine.own.id, { change: 'moved', date: LEFT, toWorkspaceId: there.ws }),
          () => changePosition(t.pos, ACTOR, ws, mine.own.id, { change: 'moved', date: LEFT, toWorkspaceId: 'ws_nope' }), there.ws, 'ws_nope',
        ],
        [
          'demoted: node', () => changePosition(t.pos, ACTOR, ws, mine.own.id, { change: 'demoted', date: LEFT, toWorkspaceId: there.child }),
          () => changePosition(t.pos, ACTOR, ws, mine.own.id, { change: 'demoted', date: LEFT, toWorkspaceId: 'ws_nope' }), there.child, 'ws_nope',
        ],
        [
          'returned: persona', () => markReturned(t.pos, ACTOR, ws, theirs.gone.id, { date: BACK, toWorkspaceId: ws }),
          () => markReturned(t.pos, ACTOR, ws, 'per_nope', { date: BACK, toWorkspaceId: ws }), theirs.gone.id, 'per_nope',
        ],
        [
          'returned: a parked one', () => markReturned(t.pos, ACTOR, ws, theirs.parked.id, { date: BACK, toWorkspaceId: there.ws }),
          () => markReturned(t.pos, ACTOR, ws, 'per_nope', { date: BACK, toWorkspaceId: there.ws }), theirs.parked.id, 'per_nope',
        ],
        [
          'returned: node', () => markReturned(t.pos, ACTOR, ws, mine.gone.id, { date: BACK, toWorkspaceId: there.ws }),
          () => markReturned(t.pos, ACTOR, ws, mine.gone.id, { date: BACK, toWorkspaceId: 'ws_nope' }), there.ws, 'ws_nope',
        ],
      ];
      for (const [what, foreign, unknown, foreignId, unknownId] of actions) {
        const r = refusal(foreign);
        expect([what, r.status]).toEqual([what, 404]);
        expect([what, r.message]).toEqual([what, refusal(unknown).message.replace(unknownId, foreignId)]);
      }
      // A caller of the other tree cannot act on this tree's stakeholders either.
      expect(refusal(() => markLeft(t.pos, ACTOR, there.ws, mine.own.id, left)).status).toBe(404);
      expect(refusal(() => markReturned(t.pos, ACTOR, there.child, mine.gone.id, { date: BACK, toWorkspaceId: there.ws })).status).toBe(404);

      // Research of this tree cannot save a public layer for the other tree's former colleague.
      const ctx = { agentRunId: `arun_cross_${x}`, workspaceId: ws, role: 'worker' as const, model: { provider: 'claude' as const, model: 'sonnet' }, promptVersion: 'pv', taskId: mine.taskId };
      const input = (follow: string) => ({
        label: 'x', stakeholder_type: 'other', subject: 'follow', relation: 'x', follow,
        profile: Object.fromEntries(STAKEHOLDER_FIELDS.map((f) => [f, { value: 'crossed', confidence: 0.4, evidence: mine.gone.publicProfile!.role_mandate!.evidence }])),
      });
      const crossed = await t.handle(ctx, 'save_stakeholder', input(theirs.gone.id));
      const unknown = await t.handle(ctx, 'save_stakeholder', input('per_nope'));
      expect(crossed.ok).toBe(false);
      expect((crossed as { error: string }).error).toBe((unknown as { error: string }).error.replace('per_nope', theirs.gone.id));
      expect(t.snapshot()).toBe(before);
    }
  });

  it('the combine run of one tree combines its own former colleague only and is shown nothing of the other', async () => {
    const t = await twoTrees();
    t.state.pick = (req) =>
      req.role !== 'retro'
        ? undefined
        : async (tc) => {
            await tc.call('submit_combined_profile', {
              persona_id: /persona_id `(\w+)`/.exec(req.prompt)![1]!,
              profile: Object.fromEntries(STAKEHOLDER_FIELDS.map((f) => [f, { value: `combined ${f}`, confidence: 0.5, basis: 'both' }])),
            });
          };
    const theirs = JSON.stringify(t.store.personas.list({ workspaceId: 'ws_b' }));
    tick();
    expect(await runCombine('ws_a', t.deps)).toEqual({ combined: 1, skipped: [] });
    expect(t.requests).toHaveLength(1);
    const shown = `${t.requests[0]!.systemPrompt}\n${t.requests[0]!.prompt}`;
    expect(shown).toContain(t.seeded.a.gone.id);
    expect(t.traces('b').filter((id) => shown.includes(id))).toEqual([]);
    expect(t.store.personas.get(t.seeded.a.gone.id)!.combinedAt).toBeTruthy();
    expect(JSON.stringify(t.store.personas.list({ workspaceId: 'ws_b' }))).toBe(theirs);
    expect(needsCombine(t.store, t.store.personas.get(t.seeded.b.gone.id)!)).toBe(true);
  });

  it('the routes of one tree serve nothing of the other; its ids answer 404 there, like unknown ones, and nothing changes', async () => {
    const t = await twoTrees();
    for (const x of ['a', 'b'] as const) {
      const { ws } = TREES[x];
      const mine = t.seeded[x];
      const theirs = t.seeded[other(x)];
      const there = TREES[other(x)];
      const foreign = t.traces(other(x));
      const w = (path: string) => `/api/workspaces/${ws}${path}`;
      const before = t.snapshot();

      // The list, and the history with both layers, of this tree.
      for (const path of ['/stakeholders', `/stakeholders/${mine.gone.id}/positions`, `/stakeholders/${mine.parked.id}/positions`, `/stakeholders/${mine.own.id}/positions`]) {
        const r = await t.call('GET', w(path));
        expect([path, r.status]).toEqual([path, 200]);
        expect([path, foreign.filter((id) => r.text.includes(id))]).toEqual([path, []]);
      }
      const list = JSON.parse((await t.call('GET', w('/stakeholders'))).text);
      expect(list.own.map((v: { id: string }) => v.id)).toEqual([mine.own.id]);
      expect(list.former.map((v: { id: string }) => v.id)).toEqual([mine.parked.id]);
      expect(list.competitors.map((c: { competitorId: string }) => c.competitorId)).toEqual([mine.competitorId]);
      expect(list.places.competitors.map((c: { competitorId: string }) => c.competitorId)).toEqual([mine.competitorId]);
      expect(list.places.nodes.map((n: { workspaceId: string }) => n.workspaceId)).toEqual([TREES[x].ws, TREES[x].child]);
      const history = JSON.parse((await t.call('GET', w(`/stakeholders/${mine.gone.id}/positions`))).text);
      expect(Object.keys(history).sort()).toEqual(['internalProfile', 'positions', 'publicLayerStatus', 'publicLayerUsed', 'publicProfile', 'publicSavedAt']);

      // The history of the other tree's stakeholders.
      const noPersona = await t.call('GET', w('/stakeholders/per_nope/positions'));
      expect(noPersona.status).toBe(404);
      for (const id of [theirs.own.id, theirs.gone.id, theirs.parked.id]) {
        const r = await t.call('GET', w(`/stakeholders/${id}/positions`));
        expect([id, r.status, r.error]).toEqual([id, 404, noPersona.error!.replace('per_nope', id)]);
      }

      // Every change: on the other tree's stakeholders, and on this tree's with the other tree's competitor or node.
      const changes = (toWs: string): Array<Record<string, unknown>> => [
        { change: 'left', date: LEFT, to: { elsewhere: {} } },
        { change: 'left', date: LEFT, to: { competitorId: mine.competitorId } },
        { change: 'left', date: LEFT, to: { newCompetitor: { name: 'Somewhere new' } } },
        { change: 'moved', date: LEFT, toWorkspaceId: toWs },
        { change: 'promoted', date: LEFT },
        { change: 'demoted', date: LEFT },
        { change: 'returned', date: BACK, toWorkspaceId: toWs },
      ];
      for (const id of [theirs.own.id, theirs.gone.id, theirs.parked.id, 'per_nope']) {
        for (const body of changes(TREES[x].child)) {
          const r = await t.call('POST', w(`/stakeholders/${id}/position`), body);
          expect([id, body.change, r.status]).toEqual([id, body.change, 404]);
          expect(r.error).toBe(`stakeholder '${id}' not found`);
        }
      }
      for (const [id, body, foreignId, unknownId] of [
        [mine.own.id, { change: 'left', date: LEFT, to: { competitorId: theirs.competitorId } }, theirs.competitorId, 'cmp_nope'],
        [mine.gone.id, { change: 'left', date: LEFT, to: { competitorId: theirs.competitorId } }, theirs.competitorId, 'cmp_nope'],
        [mine.parked.id, { change: 'left', date: LEFT, to: { competitorId: theirs.competitorId } }, theirs.competitorId, 'cmp_nope'],
        [mine.own.id, { change: 'moved', date: LEFT, toWorkspaceId: there.ws }, there.ws, 'ws_nope'],
        [mine.own.id, { change: 'promoted', date: LEFT, toWorkspaceId: there.child }, there.child, 'ws_nope'],
        [mine.gone.id, { change: 'returned', date: BACK, toWorkspaceId: there.ws }, there.ws, 'ws_nope'],
        [mine.parked.id, { change: 'returned', date: BACK, toWorkspaceId: there.child }, there.child, 'ws_nope'],
      ] as Array<[string, Record<string, unknown>, string, string]>) {
        const r = await t.call('POST', w(`/stakeholders/${id}/position`), body);
        const unknown = await t.call('POST', w(`/stakeholders/${id}/position`), JSON.parse(JSON.stringify(body).replace(foreignId, unknownId)));
        expect([id, body.change, r.status, unknown.status]).toEqual([id, body.change, 404, 404]);
        expect(r.error).toBe(unknown.error!.replace(unknownId, foreignId));
      }
      expect(t.snapshot()).toBe(before);
    }
  });
});
