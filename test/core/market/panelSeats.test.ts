import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BifConfig } from '../../../src/core/config/schema.js';
import { flowRepos } from '../../../src/core/flows/repos.js';
import { runFlowRanking } from '../../../src/core/flows/round.js';
import type { FakeScript } from '../../../src/core/harness/adapter.js';
import type { RunContext } from '../../../src/core/harness/tokens.js';
import { PANEL_ACTOR, aboutOthers, personaPanelRunner, runPersonaPanel } from '../../../src/core/market/panel.js';
import { marketToolHandlers } from '../../../src/core/market/personas.js';
import { promptTemplate, promptVersion, renderTemplate } from '../../../src/core/prompts/index.js';
import { getPromptText } from '../../../src/core/prompts/store.js';
import type { AgentRequest } from '../../../src/core/research/deps.js';
import { startPhase } from '../../../src/core/research/orchestrator.js';
import { PERSONA_FIELDS } from '../../../src/core/scoring/criteria.js';
import { exportTrainingData } from '../../../src/core/scoring/export.js';
import { rateCriterion } from '../../../src/core/scoring/ratings.js';
import type { Store } from '../../../src/core/store/db.js';
import { newId } from '../../../src/core/store/repos.js';
import type { ModelRef, Persona, Recommendation } from '../../../src/core/types.js';
import { firstWins, flowSetup } from '../flows/flowFixture.js';
import { researchSetup } from '../helpers/research.js';

const opened: Store[] = [];
afterEach(() => {
  for (const s of opened.splice(0)) s.close();
  vi.restoreAllMocks();
});

const SONNET = { provider: 'claude', model: 'sonnet' } as const;
const CODEX = { provider: 'codex', model: 'gpt-6.1-sol', effort: 'medium' } as const;
const OPENCODE = { provider: 'opencode', model: 'big-pickle' } as const;

/** The slugs of the three personas, in the order they take seats: with two seats 0, 1, 0. */
const FIELD = 'field-user';
const OPS = 'payments-ops-analyst';
const SMB = 'smb-finance-lead';

const ctx = (extra: Partial<RunContext> = {}): RunContext => ({
  agentRunId: newId('arun'), workspaceId: 'ws_a', role: 'worker', model: { provider: 'claude', model: 'sonnet' }, promptVersion: 'pv', ...extra,
});

function rec(id: string): Recommendation {
  return {
    id, workspaceId: 'ws_a', title: `Rec ${id}`, summary: `Do ${id}`, criteria: { upside: 4 }, findingIds: [],
    personaFeedback: [], priority: 0, createdAt: new Date().toISOString(), status: 'verified',
  };
}

const recIdOf = (req: AgentRequest) => /Recommendation id: (\S+)/.exec(req.prompt)![1]!;
const slugOf = (req: AgentRequest) => /^name: (\S+)$/m.exec(req.systemPrompt)![1]!;
const modelOf = (req: AgentRequest) => (req as AgentRequest & { model: ModelRef }).model;

/** What a persona sends: today's fields, plus `extra`. */
const answer = (recId: string, extra: Record<string, unknown> = {}) => ({
  recommendation_id: recId,
  scores: { appeal: 4, adoption: 3, willingness_to_pay: 2, friction: 4 },
  concerns: ['price'],
  reasoning: 'in character',
  would_change_mind: 'a free tier',
  ...extra,
});

/** Three verified personas, two verified recommendations, every persona run answering through `extra`. */
async function seeded(config?: (c: BifConfig) => void, extra: (req: AgentRequest) => Record<string, unknown> = () => ({})) {
  const dir = mkdtempSync(join(tmpdir(), 'bif-panel-seats-'));
  const t = researchSetup(opened, { dir, extraHandlers: () => marketToolHandlers({ dataDir: dir }), ...(config ? { config } : {}) });
  t.store.workspaces.insert({
    id: 'ws_a', name: 'Acme', sector: 'saas', createdAt: 'now',
    scope: { level: 'division', name: 'Acme Payments', description: 'payments division' }, audiences: ['external', 'internal'],
  });
  const art = t.artifacts.save({ workspaceId: 'ws_a', kind: 'text', mime: 'text/plain', bytes: 'G2 reviews of Acme' }).id;
  for (const segment of ['SMB finance lead', 'Payments ops analyst', 'Field user']) {
    const profile = Object.fromEntries(PERSONA_FIELDS.map((f) => [f, { value: `${f} value`, confidence: 0.6, evidence: [art] }]));
    expect((await t.handle(ctx(), 'save_persona', { segment, audience: 'external', profile })).ok).toBe(true);
  }
  for (const p of t.store.personas.list({ workspaceId: 'ws_a' })) t.store.personas.update(p.id, { status: 'verified' });
  t.store.recommendations.insert(rec('rec_1'));
  t.store.recommendations.insert(rec('rec_2'));
  const answering = (also: (req: AgentRequest) => FakeScript | undefined = () => undefined) => {
    t.state.pick = (req) => {
      if (req.role !== 'persona') return undefined;
      return also(req) ?? (async (tools) => void (await tools.call('submit_persona_feedback', answer(recIdOf(req), extra(req)))));
    };
  };
  answering();
  const persona = (slug: string): Persona => t.store.personas.list({ workspaceId: 'ws_a' }).find((p) => p.slug === slug)!;
  const feedback = (recId: string, slug: string) => t.store.recommendations.get(recId)!.personaFeedback.find((f) => f.personaId === persona(slug).id);
  const runsOf = (slug: string) => t.requests.filter((r) => r.role === 'persona' && slugOf(r) === slug);
  const unavailableDecisions = () =>
    t.store.decisions.list({ workspaceId: 'ws_a' }).filter((d) => (d.payload as { event?: string } | null)?.event === 'persona_unavailable');
  return { ...t, answering, persona, feedback, runsOf, unavailableDecisions };
}

/** These tests are about seats: the run with no persona is off (it has its own tests, panelBaseline.test.ts). */
const twoSeats = (c: BifConfig) => {
  c.personaPanel = { baseline: false, seats: [SONNET, CODEX] };
};
/** Seat 1 is a CLI this machine does not have: the persona on it (`OPS`) cannot be started. */
const withOpencodeSeat = (onUnavailable: 'fail' | 'report') => (c: BifConfig) => {
  c.personaPanel = { baseline: false, onUnavailable, seats: [SONNET, OPENCODE] };
};
/** A new text for both recommendations: a configured panel reads a recommendation again only when its text changed (panelRounds.test.ts). */
const changeTexts = (t: { store: Store }) => {
  for (const id of ['rec_1', 'rec_2']) t.store.recommendations.update(id, { summary: `Do ${id}, with a pilot first` });
};

/** `persona_panel.md` as rendered for a recommendation before this project. */
const legacyPrompt = (recId: string) =>
  renderTemplate(promptTemplate('persona_panel'), { recommendation_id: recId, title: `Rec ${recId}`, summary: `Do ${recId}`, scope: 'Acme Payments' });

describe('without a personaPanel block nothing changes', () => {
  it('the panel prompt file is the one of before this project', () => {
    // The version of persona_panel.md on 2026-11-16. A change of that file gives every persona run a new prompt version.
    expect(promptVersion(promptTemplate('persona_panel'))).toBe('d6358177');
  });

  it('same prompt text and version, same runs, same stored feedback, same report', async () => {
    // The personas send the new fields too: without the block they are not stored.
    const t = await seeded(undefined, () => ({ other_side: 'o', instead: 'i', unsure: ['u'], concern_basis: ['goals'], rulings: [{ concern: 1, ruling: 'stands', reason: 'r' }] }));
    const report = await runPersonaPanel('ws_a', t.deps);

    expect(Object.keys(report).sort()).toEqual(['feedback', 'missing', 'stakeholderReads']);
    expect(report).toMatchObject({ feedback: 6, missing: [] });

    const runs = t.requests.filter((r) => r.role === 'persona');
    expect(runs).toHaveLength(6);
    const versions = new Set<string>();
    for (const req of runs) {
      const agentMd = readFileSync(t.persona(slugOf(req)).agentMdPath, 'utf8');
      expect(req.systemPrompt).toBe(agentMd);
      expect(req.prompt).toBe(legacyPrompt(recIdOf(req)));
      expect(modelOf(req)).toEqual(t.config.roles.persona);
      expect('effort' in req).toBe(false);
      // promptVersion(system + template): the version every persona run had before.
      const version = promptVersion(`${agentMd}\n${promptTemplate('persona_panel')}`);
      expect((req as AgentRequest & { promptVersion: string }).promptVersion).toBe(version);
      expect(getPromptText(t.store, version)!.text).toBe(`${agentMd}\n${promptTemplate('persona_panel')}`);
      versions.add(version);
    }
    // The prompt store holds those versions and no other for the role.
    const stored = t.store.db.prepare("SELECT hash FROM prompt_versions WHERE role = 'persona'").all() as Array<{ hash: string }>;
    expect(new Set(stored.map((r) => r.hash))).toEqual(versions);

    for (const id of ['rec_1', 'rec_2']) {
      for (const slug of [FIELD, OPS, SMB]) {
        expect(t.feedback(id, slug)).toEqual({
          personaId: t.persona(slug).id,
          scores: { appeal: 4, adoption: 3, willingnessToPay: 2, friction: 4 },
          concerns: ['price'], reasoning: 'in character', wouldChangeMind: 'a free tier', simulated: true,
        });
      }
    }
    expect(t.unavailableDecisions()).toEqual([]);
  });

  it('a persona without an answer is skipped as before: missing, never "unavailable"', async () => {
    const t = await seeded();
    t.answering((req) => (slugOf(req) === SMB && recIdOf(req) === 'rec_1' ? async () => {} : undefined));
    const report = await runPersonaPanel('ws_a', t.deps);
    expect(report.missing).toEqual([{ recommendationId: 'rec_1', personaId: t.persona(SMB).id, reason: 'no submit_persona_feedback call' }]);
    expect('unavailable' in report).toBe(false);
    expect('failed' in report).toBe(false);
    expect(t.unavailableDecisions()).toEqual([]);
  });

  it('flow verdict runs use flows.model, else roles.persona', async () => {
    const t = flowSetup(opened);
    t.persona('admin');
    t.flow('Acme');
    t.flow('Rival');
    t.answer(firstWins);
    await runFlowRanking('ws_a', t.deps);
    expect(t.personaRuns().length).toBeGreaterThan(0);
    for (const req of t.personaRuns()) {
      expect(modelOf(req)).toEqual(t.config.roles.persona);
      expect('effort' in req).toBe(false);
    }
  });
});

describe('seats', () => {
  it('each persona runs on its own seat, with the seat model and effort', async () => {
    const t = await seeded(twoSeats);
    const report = await runPersonaPanel('ws_a', t.deps);
    expect(report).toMatchObject({ feedback: 6, missing: [], unavailable: [] });
    expect(report.failed).toBeUndefined();

    // One run per persona per recommendation, each on the persona's seat and on no other.
    for (const [slug, seat] of [[FIELD, SONNET], [OPS, CODEX], [SMB, SONNET]] as const) {
      const runs = t.runsOf(slug);
      expect(runs.map(recIdOf).sort(), slug).toEqual(['rec_1', 'rec_2']);
      for (const req of runs) {
        expect(modelOf(req), slug).toEqual({ provider: seat.provider, model: seat.model });
        expect(req.effort, slug).toBe('effort' in seat ? seat.effort : undefined);
        expect(req.systemPrompt).toBe(readFileSync(t.persona(slug).agentMdPath, 'utf8'));
      }
      for (const id of ['rec_1', 'rec_2']) expect(t.feedback(id, slug)!.seat, slug).toEqual(seat);
    }
    // The stored run carries the seat's model.
    const stored = t.store.agentRuns.list({ role: 'persona' });
    expect(stored.filter((r) => r.model.provider === 'codex')).toHaveLength(2);
  });

  it('the seating is stable: a new recommendation, or a second run, moves no persona', async () => {
    const t = await seeded(twoSeats);
    await runPersonaPanel('ws_a', t.deps);
    const seating = () => Object.fromEntries(t.requests.filter((r) => r.role === 'persona').map((r) => [`${slugOf(r)} ${recIdOf(r)}`, modelOf(r).model]));
    const first = seating();
    t.store.recommendations.insert(rec('rec_0'));
    changeTexts(t);
    t.requests.length = 0;
    await runPersonaPanel('ws_a', t.deps);
    const second = seating();
    for (const [pair, model] of Object.entries(first)) expect(second[pair], pair).toBe(model);
    expect(second).toMatchObject({ [`${FIELD} rec_0`]: 'sonnet', [`${OPS} rec_0`]: 'gpt-6.1-sol', [`${SMB} rec_0`]: 'sonnet' });
  });

  it('a pinned persona runs on its pinned seat, and nobody else moves', async () => {
    const t = await seeded((c) => {
      c.personaPanel = { baseline: false, seats: [SONNET, CODEX], personas: { [SMB]: { seat: 1 }, 'no-such-persona': { seat: 1 } } };
    });
    await runPersonaPanel('ws_a', t.deps);
    expect(new Set(t.runsOf(SMB).map((r) => modelOf(r).model))).toEqual(new Set(['gpt-6.1-sol']));
    expect(new Set(t.runsOf(FIELD).map((r) => modelOf(r).model))).toEqual(new Set(['sonnet']));
    expect(new Set(t.runsOf(OPS).map((r) => modelOf(r).model))).toEqual(new Set(['gpt-6.1-sol']));
  });

  it('with only the block, every persona runs on the one seat with roles.persona', async () => {
    const t = await seeded((c) => {
      c.personaPanel = {};
    });
    await runPersonaPanel('ws_a', t.deps);
    for (const req of t.requests.filter((r) => r.role === 'persona')) {
      expect(modelOf(req)).toEqual(t.config.roles.persona);
      expect('effort' in req).toBe(false);
    }
    expect(t.feedback('rec_1', OPS)!.seat).toEqual(SONNET);
  });

  it('the configured prompt is the panel prompt with the persona rules after it, under its own version', async () => {
    const t = await seeded(twoSeats);
    await runPersonaPanel('ws_a', t.deps);
    const rules = promptTemplate('persona_panel_rules');
    for (const title of [
      'You are one person.', 'Ground it or say you are unsure.', 'Do not please.', 'Judge it as given.', 'Nothing here is precious.',
      'No numbers about other people.', 'Argue the other side before you finish.', 'Work alone.',
    ]) expect(rules, title).toContain(`**${title}**`);
    for (const field of ['concern_basis', 'other_side', 'instead', 'unsure']) expect(rules, field).toContain(`\`${field}\``);
    expect(rules).not.toContain('rulings'); // asked for from round 2 only

    for (const req of t.requests.filter((r) => r.role === 'persona')) {
      expect(req.prompt).toBe(`${legacyPrompt(recIdOf(req)).trimEnd()}\n\n${rules}`);
      const agentMd = readFileSync(t.persona(slugOf(req)).agentMdPath, 'utf8');
      const version = (req as AgentRequest & { promptVersion: string }).promptVersion;
      expect(version).not.toBe(promptVersion(`${agentMd}\n${promptTemplate('persona_panel')}`));
      expect(getPromptText(t.store, version)!.text).toBe(`${agentMd}\n${promptTemplate('persona_panel').trimEnd()}\n\n${rules}`);
      // A run's prompt holds nothing of another persona.
      for (const other of [FIELD, OPS, SMB].filter((s) => s !== slugOf(req))) expect(`${req.systemPrompt}\n${req.prompt}`).not.toContain(other);
    }
  });
});

describe('unavailable personas', () => {
  it('a configured panel always reports who was unavailable, also with nothing to read', async () => {
    const t = await seeded(twoSeats);
    for (const r of t.store.recommendations.list({ workspaceId: 'ws_a' })) t.store.recommendations.update(r.id, { status: 'failed' });
    const report = await runPersonaPanel('ws_a', t.deps);
    expect(report).toMatchObject({ feedback: 0, missing: [], unavailable: [] });
    expect(t.requests.filter((r) => r.role === 'persona')).toEqual([]);
  });

  it('report: a persona whose seat cannot be started is not run, never on another seat, and the panel goes on', async () => {
    const t = await seeded(withOpencodeSeat('report'));
    const report = await runPersonaPanel('ws_a', t.deps);

    expect(t.runsOf(OPS)).toEqual([]);
    expect(t.requests.filter((r) => r.role === 'persona').map((r) => modelOf(r))).toEqual(Array.from({ length: 4 }, () => ({ provider: 'claude', model: 'sonnet' })));
    expect(report.feedback).toBe(4);
    expect(report.missing).toEqual([]);
    expect(report.failed).toBeUndefined();
    const ops = t.persona(OPS).id;
    expect([...report.unavailable!].sort((a, b) => a.recommendationId.localeCompare(b.recommendationId))).toEqual(
      ['rec_1', 'rec_2'].map((recommendationId) => ({
        recommendationId, personaId: ops, slug: OPS, seat: { index: 1, ...OPENCODE }, reason: "provider 'opencode' is not enabled",
      })),
    );
    for (const id of ['rec_1', 'rec_2']) {
      expect(t.feedback(id, OPS)).toBeUndefined();
      expect(t.feedback(id, FIELD)).toBeDefined();
      expect(t.feedback(id, SMB)).toBeDefined();
    }
    // Recorded per pair, with the reason and the seat, by the panel itself (no run exists).
    const recorded = t.unavailableDecisions();
    expect(recorded).toHaveLength(2);
    for (const d of recorded) {
      expect(d).toMatchObject({ agentRunId: PANEL_ACTOR, role: 'persona', model: OPENCODE, promptVersion: 'n/a' });
      expect(d.payload).toMatchObject({ tool: 'harness', persona: ops, slug: OPS, seat: { index: 1, ...OPENCODE }, reason: "provider 'opencode' is not enabled" });
    }
    expect(recorded.map((d) => (d.payload as { recommendation: string }).recommendation).sort()).toEqual(['rec_1', 'rec_2']);
  });

  it('the record of an unavailable persona is no judgment: it names its recommendation and persona in plain fields, and joins no rating', async () => {
    const t = await seeded(withOpencodeSeat('report'));
    // What saved each recommendation: its judgment, which its ratings join.
    const saved = Object.fromEntries(['rec_1', 'rec_2'].map((id) => [id, t.store.decisions.insert({
      id: `dec_saved_${id}`, workspaceId: 'ws_a', agentRunId: 'arun_syn', role: 'synthesizer', model: SONNET, kind: 'decision',
      payload: { tool: 'save_recommendation', recommendationId: id }, refs: [id], promptVersion: 'pv', createdAt: '2020-01-01T00:00:00.000Z',
    })]));
    const ops = t.persona(OPS).id;
    const savedPersona = t.store.decisions.list({ workspaceId: 'ws_a' }).filter((d) => (d.payload as { personaId?: string } | null)?.personaId === ops);
    expect(savedPersona).toHaveLength(1);
    await runPersonaPanel('ws_a', t.deps);

    const recorded = t.unavailableDecisions();
    expect(recorded).toHaveLength(2);
    for (const d of recorded) {
      // Not under a key the export reads as the subject of a judgment, and with no refs a rating could join by.
      expect('recommendationId' in (d.payload as object)).toBe(false);
      expect('personaId' in (d.payload as object)).toBe(false);
      expect(d.refs).toEqual([]);
    }
    // Ratings made after the persona was unavailable: of each recommendation, and of the persona.
    const ofRec = Object.fromEntries(['rec_1', 'rec_2'].map((id) => [id, rateCriterion({ workspaceId: 'ws_a', targetType: 'recommendation', targetId: id, criterion: 'upside', verdict: 'agree' }, t)]));
    const ofPersona = rateCriterion({ workspaceId: 'ws_a', targetType: 'persona', targetId: ops, criterion: 'goals', verdict: 'agree' }, t);

    const exported = exportTrainingData('ws_a', t).trim().split('\n')
      .map((l) => JSON.parse(l) as { type: string; decision: { id: string; payload: { event?: string } }; ratings: Array<{ id: string }> })
      .filter((l) => l.type === 'decision');
    const unavailable = exported.filter((l) => l.decision.payload.event === 'persona_unavailable');
    expect(unavailable.map((l) => l.decision.id).sort()).toEqual(recorded.map((d) => d.id).sort());
    for (const l of unavailable) expect(l.ratings).toEqual([]);
    const joinedBy = (ratingId: string) => exported.filter((l) => l.ratings.some((r) => r.id === ratingId)).map((l) => l.decision.id);
    for (const id of ['rec_1', 'rec_2']) expect(joinedBy(ofRec[id]!.id), id).toEqual([saved[id]!.id]);
    expect(joinedBy(ofPersona.id)).toEqual([savedPersona[0]!.id]);
  });

  it('report: a run without an answer is retried once on the same seat, then the pair is unavailable', async () => {
    const t = await seeded(twoSeats);
    t.answering((req) => (slugOf(req) === OPS && recIdOf(req) === 'rec_1' ? async () => {} : undefined));
    const report = await runPersonaPanel('ws_a', t.deps);

    const silent = t.runsOf(OPS).filter((r) => recIdOf(r) === 'rec_1');
    expect(silent.map((r) => r.attempt)).toEqual([1, 2]);
    for (const req of silent) expect(modelOf(req)).toEqual({ provider: 'codex', model: 'gpt-6.1-sol' });
    const pair = { recommendationId: 'rec_1', personaId: t.persona(OPS).id, reason: 'no submit_persona_feedback call' };
    expect(report.missing).toEqual([pair]);
    expect(report.unavailable).toEqual([{ ...pair, slug: OPS, seat: { index: 1, ...CODEX } }]);
    expect(report.feedback).toBe(5);
    expect(report.failed).toBeUndefined();
    expect(t.feedback('rec_1', OPS)).toBeUndefined();
    expect(t.feedback('rec_2', OPS)).toBeDefined();
    const [recorded, ...more] = t.unavailableDecisions();
    expect(more).toEqual([]);
    expect(recorded!.payload).toMatchObject({ recommendation: 'rec_1', persona: t.persona(OPS).id, slug: OPS, reason: 'no submit_persona_feedback call' });
    // On the last run that gave no answer.
    expect(t.store.agentRuns.get(recorded!.agentRunId)).toMatchObject({ role: 'persona', model: { provider: 'codex', model: 'gpt-6.1-sol' } });
    // As a phase: done.
    const rr = await startPhase('ws_a', 'persona_panel', { ...t.deps, phaseRunners: { persona_panel: personaPanelRunner } });
    expect(rr.status).toBe('done');
  });

  it('fail: the phase fails naming the persona, its seat and the cause; reactions already stored are kept', async () => {
    const t = await seeded((c) => {
      c.personaPanel = { baseline: false, onUnavailable: 'fail', seats: [SONNET, CODEX] };
    });
    const phase = () => startPhase('ws_a', 'persona_panel', { ...t.deps, phaseRunners: { persona_panel: personaPanelRunner } });
    expect((await phase()).status).toBe('done');
    const earlier = t.feedback('rec_1', OPS)!;
    expect(earlier.scores.appeal).toBe(4);

    // Now the texts change, the persona on seat 1 gives no answer for rec_1, and the others answer differently.
    changeTexts(t);
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    t.answering((req) => {
      if (slugOf(req) === OPS && recIdOf(req) === 'rec_1') return async () => {};
      return async (tools) => void (await tools.call('submit_persona_feedback', answer(recIdOf(req), { scores: { appeal: 1, adoption: 1, willingness_to_pay: 1, friction: 1 } })));
    });
    const rr = await phase();
    expect(rr.status).toBe('failed');
    expect(rr.failureReason).toBe(
      `persona panel failed (personaPanel.onUnavailable: fail): persona '${OPS}' on seat 1 (codex/gpt-6.1-sol) is unavailable for rec_1: no submit_persona_feedback call`,
    );
    expect(logged).toHaveBeenCalledTimes(1);
    // The reaction it stored in the earlier run is still there; what the others stored in this run is kept too.
    expect(t.feedback('rec_1', OPS)).toEqual(earlier);
    expect(t.feedback('rec_1', FIELD)!.scores.appeal).toBe(1);
    expect(t.feedback('rec_2', OPS)!.scores.appeal).toBe(1);
  });

  it('fail: a seat that cannot be started fails the phase with the reason, after the personas that can run have run', async () => {
    const t = await seeded((c) => {
      c.providers.opencode = { enabled: true, command: 'opencode', models: ['big-pickle'] };
      c.personaPanel = { baseline: false, onUnavailable: 'fail', seats: [SONNET, OPENCODE] };
    });
    await runPersonaPanel('ws_a', t.deps);
    const earlier = t.feedback('rec_2', OPS)!;
    expect(earlier.seat).toEqual(OPENCODE);

    t.config.providers.opencode.enabled = false;
    changeTexts(t);
    t.requests.length = 0;
    const report = await runPersonaPanel('ws_a', t.deps);
    expect(report.failed).toBe(
      `persona panel failed (personaPanel.onUnavailable: fail): persona '${OPS}' on seat 1 (opencode/big-pickle) is unavailable for rec_1, rec_2: provider 'opencode' is not enabled`,
    );
    expect(t.runsOf(OPS)).toEqual([]);
    expect(report.feedback).toBe(4);
    expect(t.feedback('rec_2', OPS)).toEqual(earlier);

    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const rr = await startPhase('ws_a', 'persona_panel', { ...t.deps, phaseRunners: { persona_panel: personaPanelRunner } });
    expect(rr).toMatchObject({ status: 'failed', failureReason: report.failed });
    expect(logged).toHaveBeenCalledTimes(1);
  });
});

describe('the answer', () => {
  it('submit_persona_feedback takes the new fields, all optional', async () => {
    const t = await seeded();
    const call = (extra: Record<string, unknown>) => t.handle(ctx({ role: 'persona' }), 'submit_persona_feedback', answer('rec_1', extra));
    expect((await call({})).ok).toBe(true);
    expect((await call({
      other_side: 'a pilot', instead: 'a monthly plan', unsure: ['how procurement works'], concern_basis: ['buying_behavior'],
      rulings: [{ concern: 1, ruling: 'resolved', reason: 'the price is now stated' }, { concern: 2, ruling: 'stands', reason: 'still no pilot' }],
    })).ok).toBe(true);
    expect((await call({ rulings: [{ concern: 1, ruling: 'maybe', reason: 'r' }] })).ok).toBe(false);
    expect((await call({ rulings: [{ concern: 0, ruling: 'stands', reason: 'r' }] })).ok).toBe(false);
    expect((await call({ unsure: 'everything' })).ok).toBe(false);
    expect((await call({ concern_basis: [3] })).ok).toBe(false);
  });

  it('a ruling needs a reason only when the concern stands: `resolved` is taken without one', async () => {
    const t = await seeded();
    const call = (rulings: unknown) => t.handle(ctx({ role: 'persona' }), 'submit_persona_feedback', answer('rec_1', { rulings }));
    // The round prompt asks for a reason with `stands` only: a persona that follows it must not lose its whole answer.
    expect(await call([{ concern: 1, ruling: 'resolved' }, { concern: 2, ruling: 'stands', reason: 'still no pilot' }])).toMatchObject({ ok: true });
    expect(await call([{ concern: 1, ruling: 'resolved', reason: '' }])).toMatchObject({ ok: true });
    for (const reason of [undefined, '', '   ']) {
      const refused = await call([{ concern: 1, ruling: 'resolved' }, { concern: 2, ruling: 'stands', ...(reason !== undefined ? { reason } : {}) }]);
      expect(refused.ok, JSON.stringify(reason)).toBe(false);
      expect(refused.ok ? '' : refused.error).toContain('rulings.1.reason: a concern that stands needs a reason: what in the recommendation as it stands now still causes it');
    }
  });

  it('the new fields are stored with the reaction; a concern without a basis is ungrounded', async () => {
    const t = await seeded(twoSeats, () => ({
      concerns: ['The price is too high for my budget', 'I have no time to migrate', 'My team will not like it', 'Support is slow'],
      concern_basis: ['socioeconomic', '  ', 'what I did last time: I rolled back a migration'],
      other_side: 'A pilot with my own data would make me take it up',
      instead: 'Sell it as an add-on to what I already use',
      unsure: ['Whether my procurement rules allow it'],
    }));
    await runPersonaPanel('ws_a', t.deps);
    expect(t.feedback('rec_1', OPS)).toEqual({
      personaId: t.persona(OPS).id,
      scores: { appeal: 4, adoption: 3, willingnessToPay: 2, friction: 4 },
      concerns: ['The price is too high for my budget', 'I have no time to migrate', 'My team will not like it', 'Support is slow'],
      reasoning: 'in character',
      wouldChangeMind: 'a free tier',
      simulated: true,
      seat: CODEX,
      // One entry per concern, in order; '' where the persona gave none.
      concernBasis: ['socioeconomic', '', 'what I did last time: I rolled back a migration', ''],
      ungrounded: [1, 3],
      aboutOthers: [],
      otherSide: 'A pilot with my own data would make me take it up',
      instead: 'Sell it as an add-on to what I already use',
      unsure: ['Whether my procurement rules allow it'],
      // The first read: round 1 of this text, and no rulings (those are of a later round, panelRounds.test.ts).
      round: 1,
      textHash: expect.any(String),
      // The text the read was made on, kept for its next round.
      textRead: { title: 'Rec rec_1', summary: 'Do rec_1' },
    });
  });

  it('with none of the new fields sent, every concern is ungrounded and nothing else is added', async () => {
    const t = await seeded(twoSeats, () => ({ concern_basis: ['goals', 'needs', 'one more than there are concerns'] }));
    await runPersonaPanel('ws_a', t.deps);
    expect(t.feedback('rec_1', FIELD)).toEqual({
      personaId: t.persona(FIELD).id, scores: { appeal: 4, adoption: 3, willingnessToPay: 2, friction: 4 },
      concerns: ['price'], reasoning: 'in character', wouldChangeMind: 'a free tier', simulated: true,
      seat: SONNET, concernBasis: ['goals'], ungrounded: [], aboutOthers: [], round: 1, textHash: expect.any(String),
      textRead: { title: 'Rec rec_1', summary: 'Do rec_1' },
    });
    const none = await seeded(twoSeats);
    await runPersonaPanel('ws_a', none.deps);
    expect(none.feedback('rec_1', FIELD)).toMatchObject({ concernBasis: [''], ungrounded: [0], aboutOthers: [] });
  });

  it('text about other people in numbers is flagged, with where it is and why, and nothing is deleted', async () => {
    const t = await seeded(twoSeats, () => ({
      concerns: ['I would pay 20% more for a version that works offline', '40% of customers will never switch'],
      concern_basis: ['buying_behavior', 'alternatives_switching'],
      reasoning: 'I rate it 2 out of 5 for appeal. Most people like me would walk away. It is a $4 billion market anyway.',
      would_change_mind: 'A discount of 30% on my first year',
      other_side: 'If many small businesses in my area used it, I would look again',
      unsure: ['All users in my company may need training', 'What it costs me per month'],
    }));
    await runPersonaPanel('ws_a', t.deps);
    const fb = t.feedback('rec_2', SMB)!;
    expect(fb.aboutOthers).toEqual([
      { field: 'concerns', index: 1, text: '40% of customers will never switch', reason: 'a share of other people' },
      { field: 'reasoning', text: 'Most people like me would walk away.', reason: 'a claim about most, many or all of a group' },
      { field: 'reasoning', text: 'It is a $4 billion market anyway.', reason: 'a market size' },
      { field: 'otherSide', text: 'If many small businesses in my area used it, I would look again', reason: 'a claim about most, many or all of a group' },
      { field: 'unsure', index: 0, text: 'All users in my company may need training', reason: 'a claim about most, many or all of a group' },
    ]);
    // Flagged, not deleted: the reaction is stored whole.
    expect(fb.concerns).toHaveLength(2);
    expect(fb.reasoning).toContain('Most people like me would walk away.');
    expect(fb.scores).toEqual({ appeal: 4, adoption: 3, willingnessToPay: 2, friction: 4 });
  });
});

describe('aboutOthers', () => {
  const reasons = (text: string) => aboutOthers(text).map((f) => f.reason);

  it('hits: a share of people, most / many / all of a group, a market size', () => {
    for (const text of [
      '40% of customers will not switch',
      'About 12.5 percent of users churn in the first month',
      '9 out of 10 buyers ask for a discount',
      'One in 3 people would not notice',
      'customers leave at a rate of 30%',
    ]) expect(reasons(text), text).toEqual(['a share of other people']);
    for (const text of [
      'Most customers want this',
      'most people like me would pass',
      'Many of our users are on mobile',
      'All small-business buyers compare three quotes',
      'The majority of the people I work with hate dashboards',
    ]) expect(reasons(text), text).toEqual(['a claim about most, many or all of a group']);
    for (const text of [
      'This is a $4 billion market',
      'The market size is around 2 million seats',
      'The addressable market is 300k companies',
      'They have a market share of 30%',
      'The TAM is €500m',
    ]) expect(reasons(text), text).toEqual(['a market size']);
  });

  it('near misses: the persona about itself, its own scores, prices and plain quantities', () => {
    for (const text of [
      'I would pay 20% more',
      'A 20% discount would not cover my setup cost',
      'I give it 2 out of 5 for appeal',
      'My adoption score is 4',
      'Most of my time goes into reconciliation',
      'All my budget is committed until March',
      'There are too many steps',
      'I went to the market twice last week',
      'The market for this looks small to me',
      'I manage 3 people and none of them asked for this',
      'It would cost me $2 million over five years',
      'I talk to customers every day',
    ]) expect(reasons(text), text).toEqual([]);
  });

  it('flags the sentence, not the whole text, and a sentence once', () => {
    expect(aboutOthers('I like it. 60% of users will not. I would still buy it.')).toEqual([{ text: '60% of users will not.', reason: 'a share of other people' }]);
    expect(aboutOthers('Most customers, about 70% of customers, will leave')).toHaveLength(1);
    expect(aboutOthers('')).toEqual([]);
  });
});

describe('flow verdict runs', () => {
  const seatedFlows = (panel: NonNullable<BifConfig['personaPanel']>) => {
    const t = flowSetup(opened, (c) => {
      c.personaPanel = panel;
      c.flows = { model: { provider: 'claude', model: 'opus' } };
    });
    for (const slug of ['admin', 'buyer', 'clerk']) t.persona(slug);
    t.flow('Acme');
    t.flow('Rival');
    t.answer(firstWins);
    return t;
  };

  it('a persona judges flows on the seat it has in the panel', async () => {
    const t = seatedFlows({ seats: [SONNET, CODEX] });
    await runFlowRanking('ws_a', t.deps);
    const bySlug = (slug: string) => t.personaRuns().filter((r) => slugOf(r) === slug);
    for (const [slug, seat] of [['admin', SONNET], ['buyer', CODEX], ['clerk', SONNET]] as const) {
      expect(bySlug(slug).length, slug).toBeGreaterThan(0);
      for (const req of bySlug(slug)) {
        expect(modelOf(req), slug).toEqual({ provider: seat.provider, model: seat.model });
        expect(req.effort, slug).toBe('effort' in seat ? seat.effort : undefined);
      }
    }
    expect(new Set(flowRepos(t.store).flowVerdicts.list().map((v) => v.personaId))).toEqual(new Set(['per_admin', 'per_buyer', 'per_clerk']));
  });

  it('a persona whose seat cannot be started judges nothing, on no other model', async () => {
    const t = seatedFlows({ seats: [SONNET, OPENCODE] });
    const report = await runFlowRanking('ws_a', t.deps);
    expect(t.personaRuns().filter((r) => slugOf(r) === 'buyer')).toEqual([]);
    for (const req of t.personaRuns()) expect(modelOf(req)).toEqual({ provider: 'claude', model: 'sonnet' });
    expect(report.notJudged).toEqual([{ flowTypeId: t.typeId, personaId: 'per_buyer', pairs: 1 }]);
    const failed = t.store.decisions.list({ workspaceId: 'ws_a' }).map((d) => d.payload as { event?: string; personaId?: string; reason?: string }).filter((p) => p.event === 'flow_verdicts_failed');
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({ personaId: 'per_buyer', reason: "persona 'buyer' is unavailable on seat 1 (opencode/big-pickle): provider 'opencode' is not enabled" });
    expect(new Set(flowRepos(t.store).flowVerdicts.list().map((v) => v.personaId))).toEqual(new Set(['per_admin', 'per_clerk']));
  });

  it('a persona with no pair left to judge records nothing, whatever its seat', async () => {
    const t = flowSetup(opened, (c) => {
      c.providers.opencode = { enabled: true, command: 'opencode', models: ['big-pickle'] };
      c.personaPanel = { seats: [SONNET, OPENCODE] };
    });
    for (const slug of ['admin', 'buyer', 'clerk']) t.persona(slug);
    t.flow('Acme');
    t.flow('Rival');
    t.answer(firstWins);
    await runFlowRanking('ws_a', t.deps);
    expect(flowRepos(t.store).flowVerdicts.list({ personaId: 'per_buyer' }).length).toBeGreaterThan(0);
    const failures = () => t.store.decisions.list({ workspaceId: 'ws_a' }).map((d) => d.payload as { event?: string }).filter((p) => p.event === 'flow_verdicts_failed');
    expect(failures()).toEqual([]);

    // Its seat can no longer be started, but it has judged every pair: the round has nothing to ask it, and says nothing of it.
    t.config.providers.opencode.enabled = false;
    t.requests.length = 0;
    const report = await runFlowRanking('ws_a', t.deps);
    expect(t.personaRuns()).toEqual([]);
    expect(report.notJudged).toEqual([]);
    expect(failures()).toEqual([]);
  });
});
