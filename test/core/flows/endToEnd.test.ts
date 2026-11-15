/**
 * Flow records and flow ranking end to end (design 2026-11-14-flow-records-and-ranking-design.md §16;
 * fake adapter, real supervisor, real scheduler, real tool handlers, real HTTP routes):
 * a scheduled run walks sign-up for the own company and two competitors and collects reviews; the
 * review loop verifies; the `flow_ranking` runner phase runs the round with two personas; the user
 * disagrees with one verdict and overrides one pair over HTTP; a second scheduled run re-walks the
 * three flows, one of which changed. Asserts: three ranked flows with explanations, the override
 * holding, one new version and two confirmations, only pairs with the changed flow judged again, "what
 * changed" listing the new version and the rank moves, no persona row changed, and the two reactions
 * with their reasons in `feedback_events`.
 */
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../../../src/api/routes.js';
import { listFeedback } from '../../../src/core/feedback/events.js';
import { flowTypeByKey } from '../../../src/core/flows/catalog.js';
import { explainPosition, nodeRanking } from '../../../src/core/flows/rankings.js';
import { flowRepos } from '../../../src/core/flows/repos.js';
import { flowRankingRunner, flowRoundToolHandlers, ROUND_ACTOR } from '../../../src/core/flows/round.js';
import { flowToolHandlers } from '../../../src/core/flows/tools.js';
import type { Flow } from '../../../src/core/flows/types.js';
import type { FakeScript, ToolClient } from '../../../src/core/harness/adapter.js';
import { linkCompetitor } from '../../../src/core/knowledge/entityLinks.js';
import type { AgentRequest } from '../../../src/core/research/deps.js';
import { researchToolHandlers } from '../../../src/core/research/tools.js';
import { startScheduler } from '../../../src/core/scheduler/scheduler.js';
import { PERSONA_FIELDS } from '../../../src/core/scoring/criteria.js';
import { exportTrainingData } from '../../../src/core/scoring/export.js';
import type { Store } from '../../../src/core/store/db.js';
import { knowledgeRepos, newId } from '../../../src/core/store/repos.js';
import type { Decision } from '../../../src/core/types.js';
import { researchSetup, review } from '../helpers/research.js';
import { isFocused, pairsOf } from './flowFixture.js';

const opened: Store[] = [];
afterEach(() => {
  for (const s of opened.splice(0)) s.close();
});

const DAY = 86_400_000;
const T0 = new Date().toISOString();
const SUBJECTS = ['Acme', 'Globex', 'Initech'] as const;
type Subject = (typeof SUBJECTS)[number];

/** The steps each subject's sign-up shows; Globex's change in the second run (a phone number and a card up front). */
const STEPS: Record<Subject, Array<{ action: string; observation: string; asked?: string[] }>> = {
  Acme: [
    { action: 'Open the sign-up page', observation: 'A form asking for email and password', asked: ['email', 'password'] },
    { action: 'Submit the form', observation: 'The dashboard opens with a short tour' },
  ],
  Globex: [
    { action: 'Click Sign up with Google', observation: 'The workspace is created at once' },
  ],
  Initech: [
    { action: 'Open the sign-up page', observation: 'A form asking for email, password and company size', asked: ['email', 'password', 'company size'] },
    { action: 'Confirm the email', observation: 'A code arrives within a minute' },
    { action: 'Submit the code', observation: 'An empty project list opens' },
  ],
};
const GLOBEX_V2 = [
  { action: 'Open the sign-up page', observation: 'A form asking for a phone number before anything else', asked: ['phone'] },
  { action: 'Enter the phone number', observation: 'A card form appears: the trial needs a credit card', asked: ['credit card'] },
  { action: 'Submit the card', observation: 'The workspace is created' },
];
const REVIEWS: Record<Subject, string> = {
  Acme: 'The Acme sign-up took me two minutes and the tour was helpful.',
  Globex: 'Signing up to Globex with Google was instant, no forms at all.',
  Initech: 'The Initech code email went to spam twice before I could sign up.',
};

/** How much the personas like a flow (higher is better): Globex first, then Acme, then Initech; Globex's new version last. */
function liking(store: Store, flowId: string): number {
  const f = flowRepos(store).flows.get(flowId)!;
  const subject = knowledgeRepos(store).entities.get(f.subjectEntityId)!.name;
  if (subject === 'Globex') return f.version === 1 ? 3 : 0;
  return subject === 'Acme' ? 2 : 1;
}

const slugOf = (req: AgentRequest) => /^name: (\S+)$/m.exec(req.systemPrompt)![1]!;
const pairKey = (a: string, b: string) => [a, b].sort().join('|');

describe('flow records and ranking end to end', () => {
  it('walk, collect reviews, verify, rank, react, re-run with one changed flow: what changed is right and only stale pairs are judged again', async () => {
    const env = researchSetup(opened, {
      extraHandlers: () => ({ ...researchToolHandlers(), ...flowRoundToolHandlers(), ...flowToolHandlers() }), // as src/api/main.ts
      config: (c) => {
        c.lessons = { ...(c.lessons ?? {}), retro: { enabled: false } }; // only the research schedule runs
        c.user = { id: 'ana@acme' };
      },
    });
    const { store } = env;
    env.deps.phaseRunners = { flow_ranking: flowRankingRunner };
    store.workspaces.insert({ id: 'ws_a', name: 'Acme', sector: 'saas', createdAt: T0 });
    const signUp = flowTypeByKey(store, 'ws_a', 'sign_up')!.id;
    for (const name of ['Globex', 'Initech']) {
      linkCompetitor(store, store.competitors.insert({
        id: newId('cmp'), workspaceId: 'ws_a', name, threat: 3, directness: 3, comparison: { pricing: 3, onboarding: 3, ux: 3, features: 3 },
        evidence: [], createdAt: T0, updatedAt: T0, status: 'verified',
      }));
    }
    for (const slug of ['smb', 'ops']) {
      const profile = Object.fromEntries(PERSONA_FIELDS.map((f) => [f, { value: `${f} of ${slug}`, confidence: 0.7, evidence: [] }]));
      store.personas.insert({
        id: `per_${slug}`, workspaceId: 'ws_a', slug, segment: `${slug} segment`, profile, version: 1, status: 'verified',
        agentMdPath: join(env.dir, 'personas', `${slug}.md`),
      });
    }
    const personasBefore = JSON.stringify(store.personas.list({ workspaceId: 'ws_a' }));

    const app = createApp({ store, artifacts: env.artifacts, events: env.events, config: env.config, research: env.deps });
    const call = async (method: string, path: string, body?: unknown) => {
      const init: RequestInit = { method, headers: { 'content-type': 'application/json' } };
      if (body !== undefined) init.body = JSON.stringify(body);
      const res = await app.request(`/api/workspaces/ws_a/flows${path}`, init);
      return { status: res.status, body: (await res.json()) as any };
    };

    // --- the fake agents -------------------------------------------------------------------------------
    let runNo = 1;
    const handshakes: Array<{ subject: string; existing: string[] }> = [];
    const personaRuns: Array<{ run: number; req: AgentRequest }> = [];
    const taskInput = (type: string, subject: string, brief: string) => ({
      type, brief, subject, needs_browser: false, acceptance_criteria: ['every step cites a saved page'],
    });
    const subjectRef = (s: string) => ({ kind: s === 'Acme' ? 'company' : 'competitor', name: s });
    const saveText = async (tools: ToolClient, content: string) =>
      ((await tools.call('save_artifact', { kind: 'text', mime: 'text/plain', content })) as { artifactId: string }).artifactId;

    const walk = (subject: Subject): FakeScript => async (tools) => {
      const steps = runNo === 2 && subject === 'Globex' ? GLOBEX_V2 : STEPS[subject];
      const shots: string[] = [];
      for (const [i, s] of steps.entries()) shots.push(await saveText(tools, `${subject} sign-up, screen ${i + 1}: ${s.observation}`));
      const input = {
        subject: subjectRef(subject), flow_type_key: 'sign_up', variant: 'Email', primary: true, name: `${subject} sign-up`,
        goal: 'Create an account', entry_url: `https://${subject.toLowerCase()}.test/signup`, reached_goal: true,
        steps: steps.map((s, i) => ({ ...s, artifact_id: shots[i] })),
      };
      let saved = (await tools.call('save_flow', input)) as { saved: boolean; existing?: Array<{ id: string }>; flow?: { id: string }; relation?: string };
      if (!saved.saved) {
        // The duplicate handshake: the flow changed, so the walk replaces the current version.
        handshakes.push({ subject, existing: saved.existing!.map((e) => e.id) });
        saved = (await tools.call('save_flow', { ...input, relation: { replaces: saved.existing![0]!.id } })) as typeof saved;
      }
      if (saved.relation !== 'confirmed') {
        await tools.call('save_flow_checks', {
          flow_id: saved.flow!.id,
          answers: [
            { checklist: 'general', key: 'goal_reached_without_help', value: 'yes', steps: [steps.length] },
            { checklist: 'general', key: 'dead_ends', value: 0, steps: [1] },
            { checklist: 'specific', key: 'sign_up_options', value: subject === 'Globex' ? 'google' : 'email' },
          ],
        });
      }
      await tools.call('submit_result', { summary: `${subject} sign-up walked`, flows: [saved.flow!.id] });
    };

    const collectReviews: FakeScript = async (tools) => {
      for (const subject of SUBJECTS) {
        const page = await saveText(tools, `Reviews of ${subject} on a review site.\n${REVIEWS[subject]}\nOther unrelated text.`);
        const r = (await tools.call('save_review_mentions', {
          subject: subjectRef(subject),
          mentions: [{
            source_type: 'review_site', source_url: `https://reviews.test/${subject.toLowerCase()}`, artifact_id: page, quote: REVIEWS[subject],
            published_at: new Date(Date.now() - 20 * DAY).toISOString().slice(0, 10), polarity: subject === 'Initech' ? 'negative' : 'positive',
            flow_type_key: 'sign_up', confidence: 0.9,
          }],
        })) as { saved: number; rejected: unknown[] };
        expect(r).toMatchObject({ saved: 1, rejected: [] });
      }
      await tools.call('submit_result', { summary: 'reviews collected' });
    };

    env.state.pick = (r): FakeScript | undefined => {
      if (r.kind === 'orchestrate') {
        if (r.round > 1) return async () => {};
        const tasks = SUBJECTS.map((s) => taskInput(s === 'Acme' ? 'own_company_audit' : 'flow_walkthrough', s, `Walk the ${s} sign-up`));
        if (runNo === 1) tasks.push(taskInput('flow_reviews', 'Acme', 'Collect public reviews of the sign-up of Acme, Globex and Initech'));
        return async (tools) => void (await tools.call('propose_tasks', { tasks }));
      }
      if (r.kind === 'review') return review(9);
      if (r.role === 'persona') {
        personaRuns.push({ run: runNo, req: r });
        const slug = slugOf(r);
        const verdicts = pairsOf(r.prompt).map(([a, b]) => {
          const [la, lb] = [liking(store, a), liking(store, b)];
          return { a, b, winner: la > lb ? 'a' : 'b', strength: slug === 'smb' ? 2 : 1, confidence: 0.9, reason: `As ${slug}: the shorter way to an account.` };
        });
        return async (tools) => void (await tools.call('submit_flow_verdicts', { flow_type: 'sign_up', verdicts }));
      }
      if (r.kind !== 'work') return undefined;
      const t = r.task!;
      return t.type === 'flow_reviews' ? collectReviews : walk(t.subject as Subject);
    };

    // --- run 1 through the real scheduler --------------------------------------------------------------
    let clock = Date.now();
    store.schedules.insert({
      id: 'sch_1', workspaceId: 'ws_a', name: 'weekly', cron: '0 0 * * 1', phases: ['deep_dives', 'flow_ranking'], enabled: true,
      activatedAt: new Date(clock - 8 * DAY).toISOString(),
    });
    const scheduler = startScheduler({ ...env.deps, intervalMs: 3_600_000 }, () => clock);
    await scheduler.idle();
    const runs1 = store.researchRuns.list({ workspaceId: 'ws_a' });
    expect(runs1.map((x) => [x.phase, x.status, x.scheduleId])).toEqual([['deep_dives', 'done', 'sch_1'], ['flow_ranking', 'done', 'sch_1']]);
    expect(store.tasks.list({ workspaceId: 'ws_a' }).map((x) => x.status)).toEqual(['verified', 'verified', 'verified', 'verified']);

    const flows = flowRepos(store).flows;
    const flowOf = (subject: Subject): Flow =>
      flows.list({ flowTypeId: signUp }).find((f) => f.name === `${subject} sign-up` && f.lifecycle === 'current')!;
    const [acme, globex, initech] = SUBJECTS.map(flowOf) as [Flow, Flow, Flow];
    for (const f of [acme, globex, initech]) expect(f).toMatchObject({ status: 'verified', version: 1, isPrimary: true });
    expect(flowRepos(store).reviewMentions.list({ rootWorkspaceId: 'ws_a' })).toHaveLength(3);

    // Three ranked flows, each position explained (checks, simulated verdicts, reviews, coverage).
    const ranking1 = nodeRanking(store, env.config, 'ws_a', signUp);
    expect(ranking1.ranked.map((f) => f.flowId)).toEqual([globex.id, acme.id, initech.id]);
    for (const f of ranking1.ranked) {
      expect(f.comparisons).toBe(4); // two personas, two opponents
      expect(f.reviews.total).toBe(1);
      const why = explainPosition(store, env.config, 'ws_a', f.flowId);
      expect(why.coverage).toBe(0.6);
      expect(why.checklist).toBe(100);
      expect(why.checks.find((c) => c.itemKey === 'goal_reached_without_help')).toMatchObject({ answer: 'pass', scored: true });
      expect(why.checks.find((c) => c.itemKey === 'works_for_real_users')).toMatchObject({ answer: 'no_signal' });
      expect(why.verdicts.length).toBeGreaterThanOrEqual(4);
      expect(why.verdicts.every((v) => v.simulated === true && v.reason.length > 0)).toBe(true);
      expect(why.mentions).toHaveLength(1);
    }
    expect(ranking1.ranked.find((f) => f.flowId === initech.id)!.reviews).toEqual({ total: 1, negative: 1 });
    // Round 1: one broad sitting per persona (three pairs), then the two adjacent top-three pairs per persona.
    const run1 = personaRuns.filter((p) => p.run === 1).map((p) => p.req);
    expect(run1.filter((r) => !isFocused(r))).toHaveLength(2);
    expect(run1.filter(isFocused)).toHaveLength(4);
    const verdictsAfter1 = flowRepos(store).flowVerdicts.list({ workspaceId: 'ws_a' });
    expect(verdictsAfter1).toHaveLength(10);

    // --- the user reacts over HTTP: disagrees with one verdict, overrides one pair ------------------------
    const globexAcme = verdictsAfter1.find((v) => v.personaId === 'per_smb' && v.stage === 'focused' && pairKey(v.flowAId, v.flowBId) === pairKey(globex.id, acme.id))!;
    const disagree = await call('POST', `/verdicts/${globexAcme.id}/reaction`, { reaction: 'disagree', reason: 'Globex hides the price until the end.' });
    expect(disagree.status).toBe(200);
    const override = await call('POST', '/overrides', {
      flowTypeId: signUp, winnerFlowId: initech.id, loserFlowId: acme.id, reason: 'Initech works with our single sign-on.',
    });
    expect(override.status).toBe(201);
    const overrideId = override.body.id as string;
    const afterOverride = await call('GET', `/rankings/${signUp}`);
    expect(afterOverride.body.ranked.map((f: { flowId: string }) => f.flowId)).toEqual([globex.id, initech.id, acme.id]);
    expect(afterOverride.body.ranked.find((f: { flowId: string }) => f.flowId === initech.id).overriddenBy).toEqual([overrideId]);

    // --- run 2: Globex's sign-up changed; Acme and Initech are re-walked unchanged ---------------------------
    runNo = 2;
    clock += 8 * DAY;
    await scheduler.tick();
    await scheduler.idle();
    scheduler.stop();
    const all = store.researchRuns.list({ workspaceId: 'ws_a' });
    expect(all).toHaveLength(4);
    const runs2 = all.slice(2);
    expect(runs2.map((x) => [x.phase, x.status])).toEqual([['deep_dives', 'done'], ['flow_ranking', 'done']]);

    // One new version (through the duplicate handshake), two confirmations applied at save.
    expect(handshakes).toEqual([{ subject: 'Globex', existing: [globex.id] }]);
    const globex2 = flowOf('Globex');
    expect(globex2).toMatchObject({ version: 2, replacesId: globex.id, lineageId: globex.lineageId, status: 'verified', runId: runs2[0]!.id });
    expect(flows.get(globex.id)!.lifecycle).toBe('replaced');
    for (const f of [acme, initech]) expect(flows.get(f.id)).toMatchObject({ lifecycle: 'current', confirmCount: 1, status: 'verified', version: 1 });
    expect(flows.list({ flowTypeId: signUp })).toHaveLength(4);

    // Only pairs with the changed flow were judged again.
    const run2 = personaRuns.filter((p) => p.run === 2).map((p) => p.req);
    expect(run2.length).toBeGreaterThan(0);
    for (const req of run2) {
      const pairs = pairsOf(req.prompt);
      expect(pairs.length).toBeGreaterThan(0);
      for (const pair of pairs) expect(pair).toContain(globex2.id);
    }
    expect(run2.filter((r) => !isFocused(r)).map((r) => pairsOf(r.prompt).map(([a, b]) => pairKey(a, b)).sort())).toEqual([
      [pairKey(acme.id, globex2.id), pairKey(initech.id, globex2.id)].sort(),
      [pairKey(acme.id, globex2.id), pairKey(initech.id, globex2.id)].sort(),
    ]);
    const newVerdicts = flowRepos(store).flowVerdicts.list({ workspaceId: 'ws_a' }).filter((v) => !verdictsAfter1.some((o) => o.id === v.id));
    expect(newVerdicts.length).toBeGreaterThan(0);
    for (const v of newVerdicts) expect([v.flowAId, v.flowBId]).toContain(globex2.id);
    // Earlier verdicts are kept, none rewritten.
    for (const v of verdictsAfter1) expect(flowRepos(store).flowVerdicts.get(v.id)!.reason).toBe(v.reason);

    // The override holds (neither of its flows changed, so nothing to confirm); Globex's new version drops to last.
    const ranking2 = await call('GET', `/rankings/${signUp}`);
    expect(ranking2.body.ranked.map((f: { flowId: string }) => f.flowId)).toEqual([initech.id, acme.id, globex2.id]);
    expect(ranking2.body.overrides).toEqual([expect.objectContaining({ id: overrideId, needsConfirm: false, winnerFlowId: initech.id, loserFlowId: acme.id })]);
    expect(ranking2.body.ranked.find((f: { flowId: string }) => f.flowId === initech.id).overriddenBy).toEqual([overrideId]);

    // --- what changed --------------------------------------------------------------------------------------
    const whatChanged = store.decisions
      .list({ workspaceId: 'ws_a' })
      .filter((d) => (d.payload as { event?: string }).event === 'what_changed')
      .map((d) => d.payload as { phase: string; nextRunId: string; flows: { newFlows: string[]; newVersions: unknown[]; confirmed: number; rankMoves: unknown[] } });
    expect(whatChanged.map((p) => p.phase).sort()).toEqual(['deep_dives', 'flow_ranking']);
    const deepDives = whatChanged.find((p) => p.phase === 'deep_dives')!;
    expect(deepDives).toMatchObject({ nextRunId: runs2[0]!.id, flows: { newFlows: [], newVersions: [{ from: globex.id, to: globex2.id }], confirmed: 2 } });
    const ranked = whatChanged.find((p) => p.phase === 'flow_ranking')!;
    expect(ranked.nextRunId).toBe(runs2[1]!.id);
    expect(ranked.flows.rankMoves).toEqual(expect.arrayContaining([
      { flowTypeId: signUp, flowId: globex2.id, from: 1, to: 3 },
      { flowTypeId: signUp, flowId: initech.id, from: 3, to: 1 },
    ]));
    expect(ranked.flows.rankMoves).toHaveLength(2);

    // Persona verdicts and the round's own records stay out of the training export.
    const exported = exportTrainingData('ws_a', { store }).trim().split('\n').map((l) => JSON.parse(l) as { type: string; decision?: Decision });
    const decisions = exported.flatMap((l) => (l.type === 'decision' && l.decision ? [l.decision] : []));
    expect(decisions.length).toBeGreaterThan(0);
    // The persona verdict runs (and the round's own actor) did log decisions, and none of them is exported.
    const verdictRuns = new Set([...flowRepos(store).flowVerdicts.list({ workspaceId: 'ws_a' }).flatMap((v) => (v.agentRunId ? [v.agentRunId] : [])), ROUND_ACTOR]);
    expect(verdictRuns.size).toBeGreaterThan(1);
    expect(store.decisions.list({ workspaceId: 'ws_a' }).filter((d) => verdictRuns.has(d.agentRunId)).length).toBeGreaterThan(0);
    for (const d of decisions) {
      expect(d.kind).not.toBe('flow_verdicts');
      expect(verdictRuns.has(d.agentRunId)).toBe(false);
    }

    // --- nothing changed a persona; the two reactions are stored with their reasons -------------------------
    expect(JSON.stringify(store.personas.list({ workspaceId: 'ws_a' }))).toBe(personasBefore);
    const events = listFeedback(store, { workspaceId: 'ws_a' }).filter((e) => e.kind.startsWith('flow_'));
    expect(events.map((e) => [e.kind, e.actor, e.reason])).toEqual([
      ['flow_verdict_reaction', 'ana@acme', 'Globex hides the price until the end.'],
      ['flow_override', 'ana@acme', 'Initech works with our single sign-on.'],
    ]);
    expect(events[0]).toMatchObject({
      targetType: 'flow_verdict', targetId: globexAcme.id,
      afterJson: { reaction: 'disagree', personaId: 'per_smb', personaVersion: 1, stage: 'focused', flowAVersion: 1, flowBVersion: 1 },
    });
    expect(events[1]!.afterJson).toMatchObject({ action: 'create', overrideId, winnerFlowId: initech.id, loserFlowId: acme.id });
  });
});
