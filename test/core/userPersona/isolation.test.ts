/**
 * User persona, task 4 (design 2026-11-15-user-persona-design.md §13, §16): isolation. Two business trees
 * and two people in one tree: the interactions, persona, lines, brief, learning runs and routes of one
 * (tree, person) never return another's. And a user persona is never a knowledge entity: the knowledge
 * backfill and the user's decisions give it no entity, and it shows in no entity card, knowledge search
 * result, node card, persona list or export.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../../src/api/routes.js';
import { recordFeedback } from '../../../src/core/feedback/events.js';
import { rolePromptText } from '../../../src/core/feedback/actions.js';
import { backfillKnowledge } from '../../../src/core/knowledge/backfill.js';
import { orchestratorBriefing } from '../../../src/core/knowledge/briefing.js';
import { acceptPersonaProposal, rejectPersonaProposal, retireAdjustment } from '../../../src/core/personas/adjustments.js';
import { personaLearningToolHandlers } from '../../../src/core/personas/learn.js';
import { personaLearningRepos } from '../../../src/core/personas/store.js';
import type { AgentRequest } from '../../../src/core/research/deps.js';
import { exportTrainingData } from '../../../src/core/scoring/export.js';
import { calibrationScope } from '../../../src/core/scoring/calibration.js';
import type { Store } from '../../../src/core/store/db.js';
import { collectInteractions } from '../../../src/core/userPersona/interactions.js';
import { runUserPersonaLearning } from '../../../src/core/userPersona/learn.js';
import { userBrief, userLines, userPersonaOf, USER_PERSONA_LABEL } from '../../../src/core/userPersona/persona.js';
import { researchSetup } from '../helpers/research.js';

const T0 = '2026-11-14T10:00:00.000Z';
const ANA = 'ana-actor';
const BOB = 'bob-actor';
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

const tick = () => vi.setSystemTime(new Date(Date.parse(T0) + ++minute * 60_000));
const later = () => new Date(Date.parse(T0) + (minute + 1) * 60_000);

/** The line each (tree, person) learns: distinct texts, so a leak shows. */
const TEXTS: Record<string, string> = {
  [`ws_a/${ANA}`]: 'Wants the yearly price shown before anything else.',
  [`ws_a/${BOB}`]: 'Does not act on a claim backed by one source.',
  [`ws_b/${ANA}`]: 'Prefers short summaries with the decision first.',
};
const ALL_TEXTS = Object.values(TEXTS);

function setup() {
  const t = researchSetup(opened, { extraHandlers: () => personaLearningToolHandlers(), config: (c) => (c.user = { id: ANA }) });
  t.store.workspaces.insert({ id: 'ws_a', name: 'Acme', sector: 'saas', createdAt: T0 });
  t.store.workspaces.insert({ id: 'ws_a1', name: 'Acme Payments', sector: 'saas', parentWorkspaceId: 'ws_a', createdAt: T0 });
  t.store.workspaces.insert({ id: 'ws_b', name: 'Beta', sector: 'saas', createdAt: T0 });
  /** 12 exclusions by `actor` in node `ws`, round robin over 6 findings named by `prefix`. */
  const act = (actor: string, ws: string, prefix: string) => {
    for (let i = 0; i < 12; i++) {
      tick();
      recordFeedback(t.store, {
        workspaceId: ws, actor, kind: 'include_override', targetType: 'finding', targetId: `${prefix}_${i % 6}`, afterJson: { include: false },
      });
    }
  };
  // The fake learning run proposes the line of its (tree, person) on the first three actions it was shown.
  t.state.pick = (req: AgentRequest) => {
    if (!req.prompt.startsWith('# User persona learning')) return undefined;
    const personaId = /persona_id `(\w+)`/.exec(req.prompt)![1]!;
    const persona = t.store.personas.get(personaId)!;
    const ids = [...req.prompt.matchAll(/^- (\S+) reject —/gm)].map((m) => m[1]!).slice(0, 3);
    return async (tc) => {
      await tc.call('submit_persona_learning', {
        persona_id: personaId, assumption: 'Excludes much.',
        proposals: [{ action: 'add', field: 'priorities', text: TEXTS[`${persona.workspaceId}/${persona.subjectId}`], why: 'w', evidence: ids }],
      });
    };
  };
  const app = createApp({ store: t.store, artifacts: t.artifacts, events: t.events, config: t.config, research: t.deps });
  const call = async (method: string, path: string, body?: unknown) => {
    const init: RequestInit = { method, headers: { 'content-type': 'application/json' } };
    if (body !== undefined) init.body = JSON.stringify(body);
    const res = await app.request(path, init);
    const text = await res.text();
    return { status: res.status, text, body: text ? (JSON.parse(text) as any) : undefined };
  };
  const repos = personaLearningRepos(t.store);
  return { ...t, act, call, repos };
}

/** Ana and Bob act in tree A (Bob in the child node), Ana in tree B; one learning pass per tree; every proposal accepted by its own person. */
async function learned() {
  const t = setup();
  t.act(ANA, 'ws_a', 'fa');
  t.act(BOB, 'ws_a1', 'fb');
  t.act(ANA, 'ws_b', 'fc');
  expect(await runUserPersonaLearning(t.deps, 'ws_a', { now: later(), actors: [ANA, BOB] })).toMatchObject({ userLearningRuns: 2, userProposals: 2 });
  expect(await runUserPersonaLearning(t.deps, 'ws_b', { now: later() })).toMatchObject({ userLearningRuns: 1, userProposals: 1 });
  const anaA = userPersonaOf(t.store, 'ws_a', ANA)!;
  const bobA = userPersonaOf(t.store, 'ws_a', BOB)!;
  const anaB = userPersonaOf(t.store, 'ws_b', ANA)!;
  const pending = (personaId: string) => t.repos.proposals.list({ personaId, status: 'pending' })[0]!;
  const lineA = acceptPersonaProposal(t.store, ANA, 'ws_a', pending(anaA.id).id, { maxAdjustments: 12 }).adjustment;
  const lineBob = acceptPersonaProposal(t.store, BOB, 'ws_a', pending(bobA.id).id, { maxAdjustments: 12 }).adjustment;
  const lineB = acceptPersonaProposal(t.store, ANA, 'ws_b', pending(anaB.id).id, { maxAdjustments: 12 }).adjustment;
  return { ...t, anaA, bobA, anaB, lineA, lineBob, lineB };
}

const only = (text: string | undefined, own: string) => {
  expect(text).toContain(own);
  for (const other of ALL_TEXTS.filter((x) => x !== own)) expect(text).not.toContain(other);
};

describe('isolation: two trees and two people in one tree', () => {
  it('interactions, personas, lines and briefs are each their own', async () => {
    const t = await learned();
    const ids = (root: string, actor: string) => collectInteractions(t.store, root, actor).map((x) => x.id);
    const [a, bob, b] = [ids('ws_a', ANA), ids('ws_a', BOB), ids('ws_b', ANA)];
    // 12 actions each, plus each person's accept of their own proposal.
    for (const xs of [a, bob, b]) expect(xs).toHaveLength(13);
    expect(new Set([...a, ...bob, ...b]).size).toBe(39);
    expect(ids('ws_b', BOB)).toEqual([]);
    expect(collectInteractions(t.store, 'ws_a1', BOB).map((x) => x.id)).toEqual(bob); // from any node of the tree

    expect(new Set([t.anaA.id, t.bobA.id, t.anaB.id]).size).toBe(3);
    expect([t.anaA, t.bobA, t.anaB].map((p) => p.workspaceId)).toEqual(['ws_a', 'ws_a', 'ws_b']);
    expect(userPersonaOf(t.store, 'ws_b', BOB)).toBeUndefined();
    expect(userPersonaOf(t.store, 'ws_a1', BOB)!.id).toBe(t.bobA.id);

    const texts = (root: string, actor: string) => userLines(t.store, root, actor).flatMap((g) => g.lines.map((l) => l.text));
    expect(texts('ws_a', ANA)).toEqual([TEXTS[`ws_a/${ANA}`]]);
    expect(texts('ws_a', BOB)).toEqual([TEXTS[`ws_a/${BOB}`]]);
    expect(texts('ws_b', ANA)).toEqual([TEXTS[`ws_b/${ANA}`]]);
    expect(texts('ws_b', BOB)).toEqual([]);
    only(userBrief(t.store, 'ws_a', ANA), TEXTS[`ws_a/${ANA}`]!);
    only(userBrief(t.store, 'ws_a', BOB), TEXTS[`ws_a/${BOB}`]!);
    only(userBrief(t.store, 'ws_b', ANA), TEXTS[`ws_b/${ANA}`]!);
    expect(userBrief(t.store, 'ws_b', BOB)).toBeUndefined();
  });

  it('each learning run was shown only its own person\'s actions of its own tree', async () => {
    const t = await learned();
    const runsOf = (personaId: string) => t.repos.runs.list({ personaId });
    for (const [persona, root, actor] of [[t.anaA, 'ws_a', ANA], [t.bobA, 'ws_a', BOB], [t.anaB, 'ws_b', ANA]] as const) {
      const runs = runsOf(persona.id);
      expect(runs).toHaveLength(1);
      expect(runs[0]!.rootWorkspaceId).toBe(root);
      const own = new Set(collectInteractions(t.store, root, actor).map((x) => x.id));
      expect(runs[0]!.shownSignalIds).toHaveLength(12);
      expect(runs[0]!.shownSignalIds.every((id) => own.has(id))).toBe(true);
      for (const p of t.repos.proposals.list({ personaId: persona.id })) expect(p.evidence.every((id) => own.has(id))).toBe(true);
    }
    expect(t.repos.runs.list({ rootWorkspaceId: 'ws_b' }).map((r) => r.personaId)).toEqual([t.anaB.id]);
    // Each learning prompt carried its own person's actions only.
    const prompts = t.requests.filter((r) => r.prompt.startsWith('# User persona learning'));
    expect(prompts).toHaveLength(3);
    for (const req of prompts) {
      const prefixes = new Set([...req.prompt.matchAll(/ on finding (f[abc])_\d/g)].map((m) => m[1]));
      expect(prefixes.size).toBe(1);
    }
  });

  it('the three roles\' prompts carry the brief of the configured person in their own tree only', async () => {
    const t = await learned();
    const prompt = (ws: string) => rolePromptText(t.config, 'orchestrator', calibrationScope(t.store, t.config, ws));
    only(prompt('ws_a'), TEXTS[`ws_a/${ANA}`]!);
    only(prompt('ws_a1'), TEXTS[`ws_a/${ANA}`]!);
    only(prompt('ws_b'), TEXTS[`ws_b/${ANA}`]!);
    t.config.user = { id: BOB };
    only(prompt('ws_a'), TEXTS[`ws_a/${BOB}`]!);
    for (const text of ALL_TEXTS) expect(prompt('ws_b')).not.toContain(text);
  });

  it('routes serve the configured person\'s persona of the caller\'s tree; everything else answers 404', async () => {
    const t = await learned();
    const page = async (ws: string) => (await t.call('GET', `/api/workspaces/${ws}/user-persona`));
    const a = await page('ws_a1');
    expect(a.body.persona).toEqual({ id: t.anaA.id, version: 2 });
    only(a.text, TEXTS[`ws_a/${ANA}`]!);
    const b = await page('ws_b');
    expect(b.body.persona).toEqual({ id: t.anaB.id, version: 2 });
    only(b.text, TEXTS[`ws_b/${ANA}`]!);
    for (const r of [a, b]) {
      expect(r.text).not.toContain(ANA);
      expect(r.text).not.toContain(BOB);
      expect(r.text).not.toContain(t.bobA.id);
    }

    const own = (root: string, actor: string) => new Set(collectInteractions(t.store, root, actor).map((x) => x.id));
    const listed = async (ws: string) => (await t.call('GET', `/api/workspaces/${ws}/user-persona/interactions?limit=200`)).body.interactions.map((x: { id: string }) => x.id);
    expect(new Set(await listed('ws_a'))).toEqual(own('ws_a', ANA));
    expect(new Set(await listed('ws_b'))).toEqual(own('ws_b', ANA));

    // Bob's line and proposal, and tree A's line from tree B: 404, and nothing changes.
    const bobProposal = t.repos.proposals.list({ personaId: t.bobA.id })[0]!;
    const aProposal = t.repos.proposals.list({ personaId: t.anaA.id })[0]!;
    for (const [ws, line] of [['ws_a', t.lineBob.id], ['ws_b', t.lineA.id], ['ws_a', t.lineB.id]] as const) {
      expect((await t.call('GET', `/api/workspaces/${ws}/user-persona/interactions?line=${line}`)).status).toBe(404);
      expect((await t.call('POST', `/api/workspaces/${ws}/persona-adjustments/${line}/retire`, {})).status).toBe(404);
    }
    for (const [ws, p] of [['ws_a', bobProposal.id], ['ws_b', aProposal.id]] as const) {
      for (const what of ['accept', 'reject']) expect((await t.call('POST', `/api/workspaces/${ws}/persona-proposals/${p}/${what}`, {})).status).toBe(404);
    }
    for (const line of [t.lineA, t.lineBob, t.lineB]) expect(t.repos.adjustments.get(line.id)!.status).toBe('active');
  });
});

describe('a user persona is never a knowledge entity', () => {
  it('after the backfill and after accept, reject and retire: no entity id, no card, search hit, persona list or export line', async () => {
    const t = await learned();
    backfillKnowledge(t.store);
    // A second proposal rejected, then the line retired: every decision a user persona can take.
    t.act(ANA, 'ws_a', 'fd');
    await runUserPersonaLearning(t.deps, 'ws_a', { now: later(), actors: [ANA, BOB] });
    const second = t.repos.proposals.list({ personaId: t.anaA.id, status: 'pending' })[0]!;
    rejectPersonaProposal(t.store, ANA, 'ws_a', second.id, { reason: 'not what I meant' });
    retireAdjustment(t.store, ANA, 'ws_a', t.lineA.id);
    backfillKnowledge(t.store);

    const users = t.store.personas.list({ kind: 'user' });
    expect(users).toHaveLength(3);
    for (const p of users) expect(t.store.personas.get(p.id)!.entityId).toBeUndefined();
    const ids = users.map((p) => p.id);
    const leaks = (text: string) => ids.some((id) => text.includes(id)) || text.includes(USER_PERSONA_LABEL) || users.some((p) => text.includes(p.slug));

    for (const ws of ['ws_a', 'ws_a1', 'ws_b']) {
      const k = `/api/workspaces/${ws}/knowledge`;
      const entities = await t.call('GET', `${k}/entities?scope=tree`);
      expect(entities.status).toBe(200);
      expect(leaks(entities.text)).toBe(false);
      for (const e of entities.body as Array<{ id: string }>) {
        const card = await t.call('GET', `${k}/entities/${e.id}?scope=tree`);
        expect(leaks(card.text)).toBe(false);
      }
      const node = await t.call('GET', `${k}/node?scope=tree`);
      expect(node.status).toBe(200);
      expect(leaks(node.text)).toBe(false);
      for (const q of ['person you work for', 'person', ...users.map((p) => p.slug)]) {
        for (const extra of ['', '&include_unverified=true&include_history=true']) {
          const r = await t.call('GET', `${k}/search?q=${encodeURIComponent(q)}&scope=tree&kinds=record,entity${extra}`);
          expect(r.status).toBe(200);
          expect((r.body.hits as Array<{ id: string }>).filter((h) => ids.includes(h.id))).toEqual([]);
        }
      }
      for (const id of ids) expect((await t.call('GET', `${k}/items/${id}?scope=tree`)).status).toBe(404);
      const personas = await t.call('GET', `/api/workspaces/${ws}/personas`);
      expect(personas.body).toEqual([]);
      // The orchestrator's knowledge briefing lists no user persona among the personas.
      for (const phase of ['deep_dives', 'synthesis'] as const) {
        const brief = orchestratorBriefing({ store: t.store, config: t.config }, { workspaceId: ws, phase });
        expect(leaks(brief.section)).toBe(false);
        expect(brief.results.filter((r) => ids.includes(r.id))).toEqual([]);
      }
    }

    // The export lists no user persona as a persona: the only lines naming one are the persona learning
    // records (the run's and the user's decisions on its proposals and lines, the user's feedback events
    // and the learning run's prompt read).
    let named = 0;
    for (const ws of ['ws_a', 'ws_b']) {
      for (const includeUploads of [false, true]) {
        for (const line of exportTrainingData(ws, { store: t.store }, includeUploads).split('\n').filter(Boolean)) {
          if (!ids.some((id) => line.includes(id))) continue;
          named++;
          const row = JSON.parse(line) as {
            decision?: { payload?: { tool?: string } }; feedbackEvent?: { kind?: string }; retrievalEvent?: { role?: string; tool?: string };
          };
          const what = row.decision
            ? `decision:${row.decision.payload?.tool}`
            : row.feedbackEvent
              ? `feedback:${row.feedbackEvent.kind}`
              : `read:${row.retrievalEvent?.role}/${row.retrievalEvent?.tool}`;
          expect([
            'decision:persona_learning', 'decision:submit_persona_learning',
            'feedback:persona_learning_accept', 'feedback:persona_learning_reject', 'feedback:persona_adjustment_retire',
            'read:retro/prompt_context', // what the learning run's prompt was shown
          ]).toContain(what);
        }
      }
    }
    expect(named).toBeGreaterThan(0);
  });
});
