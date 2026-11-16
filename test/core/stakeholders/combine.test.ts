/**
 * Stakeholder positions, task 2 (design 2026-11-15-stakeholder-positions-design.md §7.2, §7.3): the
 * combine run. After the stakeholders phase, each former colleague whose public layer is newer than its
 * combined profile gets one offline run that writes one profile from both layers; the evidence of each
 * field is computed from the layers, never taken from the model; its records are internal for export.
 */
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setIncludeOverride } from '../../../src/core/feedback/actions.js';
import { currentRatedKeys, judgmentIndex } from '../../../src/core/feedback/provenance.js';
import type { FakeScript, ToolClient } from '../../../src/core/harness/adapter.js';
import { NO_OFFLINE_MODEL } from '../../../src/core/harness/offline.js';
import { ROLE_TOOLS, toolInputSchemas } from '../../../src/core/harness/tools/registry.js';
import { STAKEHOLDER_AGENT_MD_HEADINGS } from '../../../src/core/market/agentMd.js';
import { promptTemplate } from '../../../src/core/prompts/index.js';
import { promptStoreGaps } from '../../../src/core/prompts/store.js';
import type { AgentRequest } from '../../../src/core/research/deps.js';
import { startPhase } from '../../../src/core/research/orchestrator.js';
import { STAKEHOLDER_FIELDS, type StakeholderField } from '../../../src/core/scoring/criteria.js';
import { exportTrainingData, exportTrainingDataWithSummary } from '../../../src/core/scoring/export.js';
import { needsCombine, runCombine } from '../../../src/core/stakeholders/combine.js';
import { markLeft, markReturned } from '../../../src/core/stakeholders/positions.js';
import type { Store } from '../../../src/core/store/db.js';
import { newId } from '../../../src/core/store/repos.js';
import type { Persona, PersonaProfileField, Rating } from '../../../src/core/types.js';
import { review } from '../helpers/research.js';
import { ACTOR, CODEX, codexOnly, followSetup, LEFT, resetClock, T0, tick, type FollowSetup } from './followFixture.js';

const opened: Store[] = [];
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  resetClock();
});
afterEach(() => {
  vi.useRealTimers();
  for (const s of opened.splice(0)) s.close();
});

type Basis = NonNullable<PersonaProfileField['basis']>;
type FieldInput = { value: string; confidence: number; basis: Basis; conflict?: string };

/** The `profile` input of `submit_combined_profile`: every field `COMBINEDMARK <field>`, basis `both` unless given. */
const combinedInput = (bases: Partial<Record<StakeholderField, Basis>> = {}, extra: Partial<Record<StakeholderField, Partial<FieldInput>>> = {}) =>
  Object.fromEntries(STAKEHOLDER_FIELDS.map((f) => [f, { value: `COMBINEDMARK ${f}`, confidence: 0.7, basis: bases[f] ?? 'both', ...extra[f] }]));

const personaOf = (prompt: string) => /persona_id `(\w+)`/.exec(prompt)![1]!;
const retroRuns = (t: FollowSetup) => t.requests.filter((r) => r.role === 'retro');

/** Every combine run answers with `input(personaId)`; the results of its calls are collected. */
function answering(t: FollowSetup, input: (personaId: string) => Record<string, unknown> = (id) => ({ persona_id: id, profile: combinedInput() })) {
  const results: Array<{ personaId: string; ok: boolean; error?: string }> = [];
  t.state.pick = (r) => {
    if (r.role !== 'retro') return undefined;
    const personaId = personaOf(r.prompt);
    return async (tc) => {
      try {
        await tc.call('submit_combined_profile', input(personaId));
        results.push({ personaId, ok: true });
      } catch (e) {
        results.push({ personaId, ok: false, error: (e as Error).message });
      }
    };
  };
  return results;
}

/** A public layer for `p`, saved by a task that ended `status`. */
async function followed(t: FollowSetup, p: Persona, status: 'verified' | 'unverified' | 'failed' | 'running' = 'verified', extra: Record<string, unknown> = {}) {
  const task = t.task('competitor_stakeholders', { status, workspaceId: p.workspaceId });
  tick();
  const r = await t.follow(task, p.id, extra);
  if (!r.ok) throw new Error(r.error);
  tick();
  return task;
}

// ---------------------------------------------------------------------------------------------------
describe('needsCombine', () => {
  it('a former colleague whose public layer is newer than its combined profile and whose follow task ended verified or unverified', async () => {
    const t = followSetup(opened);
    const now = (p: Persona) => needsCombine(t.store, t.store.personas.get(p.id)!);
    // No public layer yet; not a former colleague.
    expect([t.gone, t.parked, t.own, t.rival].map(now)).toEqual([false, false, false, false]);

    const task = await followed(t, t.gone, 'running');
    expect(now(t.gone)).toBe(false); // its task has not ended
    for (const [status, needs] of [['queued', false], ['reviewing', false], ['waiting_user', false], ['failed', false], ['unverified', true], ['verified', true]] as const) {
      t.store.tasks.update(task.id, { status });
      expect(now(t.gone), status).toBe(needs);
    }
    // Combined since: nothing to do until a newer layer is saved.
    t.store.personas.update(t.gone.id, { combinedAt: new Date().toISOString() });
    expect(now(t.gone)).toBe(false);
    await followed(t, t.gone);
    expect(now(t.gone)).toBe(true);

    // A parked former colleague is combined like one at a competitor.
    await followed(t, t.parked, 'unverified');
    expect(now(t.parked)).toBe(true);
    // A layer whose task is gone, a superseded persona, and one who returned (the layers are cleared).
    t.store.personas.update(t.parked.id, { publicTaskId: 'tsk_gone' });
    expect(now(t.parked)).toBe(false);
    t.store.personas.update(t.gone.id, { status: 'superseded' });
    expect(now(t.gone)).toBe(false);
    // One whose research is not usable, or whom the user excluded: not followed, so not combined either.
    for (const status of ['pending', 'unverified', 'failed'] as const) {
      t.store.personas.update(t.gone.id, { status });
      expect(now(t.gone), status).toBe(false);
    }
    t.store.personas.update(t.gone.id, { status: 'unverified', includeOverride: true });
    expect(now(t.gone)).toBe(true);
    t.store.personas.update(t.gone.id, { status: 'verified', includeOverride: false });
    expect(now(t.gone)).toBe(false);
    t.store.personas.update(t.gone.id, { includeOverride: undefined });
    expect(now(t.gone)).toBe(true);
    markReturned(t.pos, ACTOR, 'ws_a', t.gone.id, { date: LEFT, toWorkspaceId: 'ws_a' });
    expect(now(t.gone)).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------------
describe('runCombine', () => {
  it('one offline retro run per former colleague that needs it, shown both layers fenced, the internal one as of the leaving date', async () => {
    const t = followSetup(opened);
    await followed(t, t.gone, 'verified', { now_at: 'VP Sales at Rival Pay' });
    await followed(t, t.parked, 'unverified');
    answering(t);
    expect(await runCombine('ws_a', t.deps)).toEqual({ combined: 2, skipped: [] });

    const runs = retroRuns(t);
    expect(runs.map((r) => personaOf(r.prompt))).toEqual([t.parked.id, t.gone.id]); // by slug
    for (const r of runs) {
      expect(r).toMatchObject({ kind: 'retro', role: 'retro', offline: true, workspaceId: 'ws_a', round: 1, attempt: 1 });
      expect((r as AgentRequest & { needsBrowser: boolean }).needsBrowser).toBe(false);
      expect((r as AgentRequest & { model: { provider: string } }).model.provider).not.toBe('codex');
      expect(r.task).toBeUndefined(); // a combine run is no research task
      expect(r.systemPrompt).toBe(promptTemplate('stakeholder_combine'));
      expect(r.promptReads ?? []).toEqual([]);
    }
    const prompt = runs[1]!.prompt;
    const fence = (label: string) => new RegExp(`<<<EVIDENCE ${label}\\n([\\s\\S]*?)\\n>>>`).exec(prompt)![1]!;
    const internal = fence('internal-layer').split('\n');
    const pub = fence('public-layer').split('\n');
    expect(internal).toHaveLength(STAKEHOLDER_FIELDS.length);
    expect(pub).toHaveLength(STAKEHOLDER_FIELDS.length);
    for (const f of STAKEHOLDER_FIELDS) {
      expect(internal).toContain(`- ${f} (as of ${LEFT}, confidence 0.6): INTERNALMARK ${f} of Head of sales`);
      expect(pub).toContain(`- ${f} (confidence 0.4): PUBLICMARK ${f} of Head of sales`);
    }
    // Every stored text is inside a fence: outside there are ids, dates, enums and instructions only.
    const outside = prompt.replace(/<<<EVIDENCE[\s\S]*?\n>>>/g, '');
    expect(outside).not.toMatch(/INTERNALMARK|PUBLICMARK|Head of sales|Rival Pay|VP Sales/);
    expect(outside).toContain(`persona_id \`${t.gone.id}\``);
    expect(outside).toContain(LEFT);
    expect(outside).toContain('submit_combined_profile');
    for (const f of STAKEHOLDER_FIELDS) expect(outside).toContain(f);
    expect(fence('former-colleague')).toContain('Head of sales');
    expect(fence('former-colleague')).toContain('Rival Pay');
    expect(fence('former-colleague')).toContain('VP Sales at Rival Pay');
    // What the node needed from them then is part of what was known from inside; nothing else of the persona is shown.
    expect(prompt).not.toContain('ignored');
  });

  it('the profile is replaced, the evidence of each field computed from the layers, the version raised and agent.md rewritten', async () => {
    const t = followSetup(opened);
    await followed(t, t.gone);
    const before = t.store.personas.get(t.gone.id)!;
    const page = before.publicProfile!.role_mandate!.evidence[0]!;
    const bases = { role_mandate: 'internal', goals_incentives: 'public', decision_criteria: 'both', constraints: 'inferred' } as const;
    const results = answering(t, (id) => ({
      persona_id: id,
      profile: combinedInput(bases, {
        decision_criteria: { conflict: '  Inside she asked for payback;\n her talks stress reach. ' },
        // Evidence named by the model is not taken.
        role_mandate: { evidence: ['art_from_the_model'] } as never,
        constraints: { conflict: '   ' },
      }),
    }));
    const at = tick();
    expect(await runCombine('ws_a', t.deps)).toEqual({ combined: 1, skipped: [] });
    expect(results).toEqual([{ personaId: t.gone.id, ok: true }]);

    const after = t.store.personas.get(t.gone.id)!;
    expect(after).toMatchObject({ version: before.version + 1, combinedAt: at, status: 'verified', publicSavedAt: before.publicSavedAt, publicTaskId: before.publicTaskId });
    expect(after.internalProfile).toEqual(before.internalProfile);
    expect(after.publicProfile).toEqual(before.publicProfile);
    expect(after.profile.role_mandate).toEqual({ value: 'COMBINEDMARK role_mandate', confidence: 0.7, evidence: [t.internalArt], basis: 'internal' });
    expect(after.profile.goals_incentives).toEqual({ value: 'COMBINEDMARK goals_incentives', confidence: 0.7, evidence: [page], basis: 'public' });
    expect(after.profile.decision_criteria).toEqual({
      value: 'COMBINEDMARK decision_criteria', confidence: 0.7, evidence: [t.internalArt, page], basis: 'both', conflict: 'Inside she asked for payback; her talks stress reach.',
    });
    expect(after.profile.constraints).toEqual({ value: 'COMBINEDMARK constraints', confidence: 0.7, evidence: [t.internalArt, page], basis: 'inferred' });
    expect(after.profile.influence).toEqual({ value: 'COMBINEDMARK influence', confidence: 0.7, evidence: [t.internalArt, page], basis: 'both' });
    expect(Object.keys(after.profile)).toEqual([...STAKEHOLDER_FIELDS]);
    expect(JSON.stringify(after.profile)).not.toContain('art_from_the_model');
    expect(needsCombine(t.store, after)).toBe(false);

    const md = readFileSync(after.agentMdPath, 'utf8');
    expect(md).toContain(`version: ${after.version}`);
    const part = (f: StakeholderField) => {
      const start = md.indexOf(`\n## ${STAKEHOLDER_AGENT_MD_HEADINGS[f]}\n`);
      return md.slice(start, md.indexOf('\n## ', start + 4));
    };
    expect(part('role_mandate')).toContain(`_Rests on: internal knowledge (as of ${LEFT})_`);
    expect(part('goals_incentives')).toContain('_Rests on: public sources_');
    expect(part('decision_criteria')).toContain('_Conflict: Inside she asked for payback; her talks stress reach._');
    expect(part('constraints')).toContain('_Rests on: a conclusion from both_');
    expect(md.match(/_Conflict: /g)).toHaveLength(1);
    expect(readFileSync(after.agentMdPath.replace(/\.md$/, `.v${after.version}.md`), 'utf8')).toBe(md);

    // One Decision: ids, the basis of each field and the confidences; no value and no conflict text.
    const [d] = t.store.decisions.list({ workspaceId: 'ws_a' }).filter((x) => (x.payload as { tool?: string }).tool === 'submit_combined_profile');
    expect(d).toMatchObject({ kind: 'decision', role: 'retro' });
    expect(d!.payload).toEqual({
      tool: 'submit_combined_profile', personaId: t.gone.id, version: after.version,
      basis: Object.fromEntries(STAKEHOLDER_FIELDS.map((f) => [f, (bases as Record<string, string>)[f] ?? 'both'])),
      conflicts: ['decision_criteria'],
      confidence: Object.fromEntries(STAKEHOLDER_FIELDS.map((f) => [f, 0.7])),
    });
    expect(d!.refs).toEqual([t.gone.id, t.internalArt, page]);
    expect(JSON.stringify(d)).not.toMatch(/COMBINEDMARK|payback/);
    expect(t.store.decisions.list({ agentRunId: d!.agentRunId })).toHaveLength(1);
  });

  it('is safe to call again: nothing runs until a newer public layer was saved', async () => {
    const t = followSetup(opened);
    await followed(t, t.gone);
    answering(t);
    expect((await runCombine('ws_a', t.deps)).combined).toBe(1);
    const once = t.store.personas.get(t.gone.id)!;
    expect(await runCombine('ws_a', t.deps)).toEqual({ combined: 0, skipped: [] });
    expect(retroRuns(t)).toHaveLength(1);
    expect(t.store.personas.get(t.gone.id)).toEqual(once);

    await followed(t, t.gone);
    expect((await runCombine('ws_a', t.deps)).combined).toBe(1);
    expect(retroRuns(t)).toHaveLength(2);
    expect(t.store.personas.get(t.gone.id)!.version).toBe(once.version + 1);
    // The second combination starts from the internal layer again, not from the first combination.
    expect(retroRuns(t)[1]!.prompt).not.toContain('COMBINEDMARK');
  });

  it('only the former colleagues of the node; nothing when stakeholders are off', async () => {
    const t = followSetup(opened);
    const child = t.former('Head of cards', 'rival', 'ws_b');
    await followed(t, child);
    await followed(t, t.gone);
    answering(t);
    expect(await runCombine('ws_a', t.deps)).toEqual({ combined: 1, skipped: [] });
    expect(retroRuns(t).map((r) => personaOf(r.prompt))).toEqual([t.gone.id]);
    expect(await runCombine('ws_b', t.deps)).toEqual({ combined: 1, skipped: [] });
    expect(retroRuns(t).at(-1)!.workspaceId).toBe('ws_b');

    const off = followSetup(opened);
    await followed(off, off.gone);
    off.config.stakeholders = { enabled: false };
    answering(off);
    expect(await runCombine('ws_a', off.deps)).toEqual({ combined: 0, skipped: [] });
    expect(retroRuns(off)).toEqual([]);
  });

  it('a run that ends without the call leaves the profile as it was and records why; the layer waits for the next phase', async () => {
    const t = followSetup(opened);
    await followed(t, t.gone);
    await followed(t, t.parked);
    const before = [t.gone, t.parked].map((p) => t.store.personas.get(p.id)!);
    const rated = t.store.ratings.insert({
      id: newId('rat'), workspaceId: 'ws_a', targetType: 'persona', targetId: t.gone.id, criterion: 'decision_criteria', agentValue: 0.6, verdict: 'agree', createdAt: tick(),
    });
    tick();
    // The first run says nothing; the second run fails.
    t.state.pick = (r) => {
      if (r.role !== 'retro') return undefined;
      const silent: FakeScript = async () => {};
      const failing: FakeScript = async () => {
        throw new Error('model unavailable');
      };
      return personaOf(r.prompt) === t.gone.id ? silent : failing;
    };
    const report = await runCombine('ws_a', t.deps);
    expect(report.combined).toBe(0);
    expect(report.skipped.map((s) => s.personaId)).toEqual([t.parked.id, t.gone.id]);
    expect(report.skipped[1]!.reason).toBe('the run ended without submit_combined_profile');
    expect(report.skipped[0]!.reason).toMatch(/^the run failed/);
    expect([t.gone, t.parked].map((p) => t.store.personas.get(p.id)!)).toEqual(before);
    const why = t.harnessEvents('stakeholder_combine_missing');
    expect(why.map((d) => (d.payload as { formerColleagueId: string }).formerColleagueId).sort()).toEqual([t.gone.id, t.parked.id].sort());
    for (const d of why) {
      expect(d.role).toBe('retro');
      expect(d.refs).toEqual([(d.payload as { formerColleagueId: string }).formerColleagueId]);
      // The record judges nothing: it does not name the person under the key that marks a judgment of a persona.
      expect(d.payload).not.toHaveProperty('personaId');
      expect(t.store.agentRuns.get(d.agentRunId)).toBeDefined();
    }
    // So it is no judgment of the persona, and a rating made before it does not go stale by it.
    const index = judgmentIndex(t.store, 'ws_a');
    for (const p of [t.gone, t.parked]) expect(index.get(p.id) ?? []).toEqual([]);
    expect(currentRatedKeys(t.store, 'ws_a').has(`persona|${t.gone.id}|${rated.criterion}`)).toBe(true);
    expect([t.gone, t.parked].map((p) => needsCombine(t.store, t.store.personas.get(p.id)!))).toEqual([true, true]);
    // The next call tries again.
    answering(t);
    expect((await runCombine('ws_a', t.deps)).combined).toBe(2);
    // Every prompt version these runs and records carry resolves in the prompt store ('pv' is the fixture's own follow save).
    expect(promptStoreGaps(t.store)).toEqual(['pv']);
  });

  it('with no provider that can run offline nothing runs: the former colleagues are skipped with one harness Decision', async () => {
    const t = followSetup(opened, (c) => {
      codexOnly(c);
      c.personaLearning = { model: CODEX };
    });
    await followed(t, t.gone);
    await followed(t, t.parked);
    const before = t.store.personas.list();
    answering(t);
    expect(await runCombine('ws_a', t.deps)).toEqual({
      combined: 0, skipped: [{ personaId: t.parked.id, reason: NO_OFFLINE_MODEL }, { personaId: t.gone.id, reason: NO_OFFLINE_MODEL }],
    });
    expect(retroRuns(t)).toEqual([]);
    expect(t.store.personas.list()).toEqual(before);
    const why = t.harnessEvents('stakeholder_combine_offline_unavailable');
    expect(why).toHaveLength(1);
    expect(why[0]).toMatchObject({ role: 'retro', workspaceId: 'ws_a', refs: [t.parked.id, t.gone.id] });
    expect(why[0]!.payload).not.toHaveProperty('personaId');
    expect(judgmentIndex(t.store, 'ws_a').size).toBe(0);
    expect(why[0]!.payload).toMatchObject({ reason: NO_OFFLINE_MODEL, personaIds: [t.parked.id, t.gone.id] });
  });

  it('a model that cannot run offline is swapped for one that can', async () => {
    const t = followSetup(opened, (c) => (c.personaLearning = { model: CODEX }));
    await followed(t, t.gone);
    answering(t);
    expect((await runCombine('ws_a', t.deps)).combined).toBe(1);
    const [run] = retroRuns(t) as Array<AgentRequest & { model: { provider: string } }>;
    expect(run!.offline).toBe(true);
    expect(run!.model.provider).not.toBe('codex');
  });
});

// ---------------------------------------------------------------------------------------------------
describe('submit_combined_profile: refusals', () => {
  /** One combine run for the former colleague at Rival Pay that makes `calls` in order; the error of each ('' when accepted). */
  async function attempts(t: FollowSetup, calls: (personaId: string) => Array<Record<string, unknown>>) {
    const errors: string[] = [];
    t.state.pick = (r) =>
      r.role !== 'retro'
        ? undefined
        : async (tc: ToolClient) => {
            for (const input of calls(personaOf(r.prompt))) {
              try {
                await tc.call('submit_combined_profile', input);
                errors.push('');
              } catch (e) {
                errors.push((e as Error).message);
              }
            }
          };
    const report = await runCombine('ws_a', t.deps);
    return { errors, report };
  }
  const without = (field: StakeholderField) => {
    const { [field]: _dropped, ...rest } = combinedInput();
    return rest;
  };

  it('the tool is the retro role\'s; a run that was not asked is refused', async () => {
    const t = followSetup(opened);
    await followed(t, t.gone);
    expect(ROLE_TOOLS.retro).toContain('submit_combined_profile');
    for (const role of ['worker', 'reviewer', 'persona', 'orchestrator', 'synthesizer', 'interviewer', 'escalation'] as const) {
      expect(ROLE_TOOLS[role]).not.toContain('submit_combined_profile');
    }
    const before = t.store.personas.get(t.gone.id);
    const r = await t.handle(t.ctx(t.task(), 'retro'), 'submit_combined_profile', { persona_id: t.gone.id, profile: combinedInput() });
    expect(r).toEqual({ ok: false, error: 'this run was not asked to combine a profile' });
    expect(t.store.personas.get(t.gone.id)).toEqual(before);
  });

  it('another persona than the one asked, a missing field, an unknown field, a value that is none: refused, and the run can still answer', async () => {
    const t = followSetup(opened);
    await followed(t, t.gone);
    await followed(t, t.parked);
    const before = t.store.personas.get(t.parked.id)!;
    const { errors, report } = await attempts(t, (id) =>
      id !== t.gone.id
        ? []
        : [
            { persona_id: t.parked.id, profile: combinedInput() },
            { persona_id: id, profile: without('influence') },
            { persona_id: id, profile: { ...combinedInput(), buying_behavior: { value: 'v', confidence: 0.5, basis: 'public' } } },
            { persona_id: id, profile: combinedInput({}, { objections: { value: '  ' } }) },
            { persona_id: id, profile: combinedInput({}, { objections: { basis: 'guess' as never } }) },
            { persona_id: id, profile: combinedInput() },
          ],
    );
    expect(errors[0]).toContain(`persona_id must be '${t.gone.id}'`);
    expect(errors[1]).toMatch(/influence/);
    expect(errors[2]).toMatch(/buying_behavior/);
    expect(errors[3]).toMatch(/objections/);
    expect(errors[4]).toMatch(/objections/);
    expect(errors[5]).toBe('');
    expect(report.combined).toBe(1);
    // The persona named by mistake is as it was (its own run said nothing).
    expect(t.store.personas.get(t.parked.id)).toEqual(before);
    expect(t.store.personas.get(t.gone.id)!.profile.influence!.value).toBe('COMBINEDMARK influence');
  });

  it('a basis that names a layer the field is not in: public or both without the public field, internal or both without the internal one', async () => {
    const t = followSetup(opened);
    await followed(t, t.gone);
    const p = t.store.personas.get(t.gone.id)!;
    const { influence: _pub, ...publicProfile } = p.publicProfile!;
    const { objections: _int, ...internalProfile } = p.internalProfile!;
    t.store.personas.update(p.id, { publicProfile, internalProfile });
    const { errors, report } = await attempts(t, (id) => [
      { persona_id: id, profile: combinedInput({ influence: 'public', objections: 'public' }) },
      { persona_id: id, profile: combinedInput({ influence: 'both', objections: 'public' }) },
      { persona_id: id, profile: combinedInput({ influence: 'internal', objections: 'internal' }) },
      { persona_id: id, profile: combinedInput({ influence: 'internal', objections: 'both' }) },
      { persona_id: id, profile: combinedInput({ influence: 'internal', objections: 'public' }) },
    ]);
    expect(errors[0]).toMatch(/profile\.influence: basis 'public' needs the field in the public layer/);
    expect(errors[1]).toMatch(/profile\.influence: basis 'both' needs the field in the public layer/);
    expect(errors[2]).toMatch(/profile\.objections: basis 'internal' needs the field in the internal layer/);
    expect(errors[3]).toMatch(/profile\.objections: basis 'both' needs the field in the internal layer/);
    expect(errors[4]).toBe('');
    expect(report.combined).toBe(1);
    const after = t.store.personas.get(p.id)!;
    expect(after.profile.influence!.evidence).toEqual([t.internalArt]);
    expect(after.profile.objections!.evidence).toEqual(p.publicProfile!.objections!.evidence);
  });

  it('a conclusion from both rests on the evidence of whichever layer holds the field', async () => {
    const t = followSetup(opened);
    await followed(t, t.gone);
    const p = t.store.personas.get(t.gone.id)!;
    const { influence: _pub, ...publicProfile } = p.publicProfile!;
    t.store.personas.update(p.id, { publicProfile });
    const { errors } = await attempts(t, (id) => [{ persona_id: id, profile: combinedInput({ influence: 'inferred' }) }]);
    expect(errors).toEqual(['']);
    expect(t.store.personas.get(p.id)!.profile.influence).toMatchObject({ basis: 'inferred', evidence: [t.internalArt] });
  });

  it('a conflict of null or an empty text is no conflict: the call is accepted and the field carries none', async () => {
    const t = followSetup(opened);
    await followed(t, t.gone);
    const profile = combinedInput({}, {
      influence: { conflict: null as never }, objections: { conflict: '' }, constraints: { conflict: '  \n ' }, dependencies: { conflict: 'We knew two; the press names one.' },
    });
    for (const conflict of [null, '']) {
      expect(toolInputSchemas.submit_combined_profile.safeParse({ persona_id: 'per_1', profile: combinedInput({}, { influence: { conflict: conflict as never } }) }).success).toBe(true);
    }
    const { errors, report } = await attempts(t, (id) => [{ persona_id: id, profile }]);
    expect(errors).toEqual(['']);
    expect(report.combined).toBe(1);
    const after = t.store.personas.get(t.gone.id)!;
    for (const f of ['influence', 'objections', 'constraints'] as const) expect(after.profile[f], f).not.toHaveProperty('conflict');
    expect(after.profile.dependencies!.conflict).toBe('We knew two; the press names one.');
    const [d] = t.store.decisions.list({ workspaceId: 'ws_a' }).filter((x) => (x.payload as { tool?: string }).tool === 'submit_combined_profile');
    expect((d!.payload as { conflicts: string[] }).conflicts).toEqual(['dependencies']);
  });

  it('a second call of the same run changes nothing more', async () => {
    const t = followSetup(opened);
    await followed(t, t.gone);
    const { errors, report } = await attempts(t, (id) => [
      { persona_id: id, profile: combinedInput() },
      { persona_id: id, profile: combinedInput({}, { influence: { value: 'SECONDMARK' } }) },
    ]);
    expect(errors).toEqual(['', '']);
    expect(report.combined).toBe(1);
    const after = t.store.personas.get(t.gone.id)!;
    expect(after.version).toBe(t.gone.version + 1);
    expect(JSON.stringify(after.profile)).not.toContain('SECONDMARK');
    expect(t.store.decisions.list({ workspaceId: 'ws_a' }).filter((d) => (d.payload as { tool?: string }).tool === 'submit_combined_profile')).toHaveLength(1);
  });

  it('the schema bounds the texts and takes no evidence', () => {
    const ok = { persona_id: 'per_1', profile: combinedInput() };
    expect(toolInputSchemas.submit_combined_profile.safeParse(ok).success).toBe(true);
    const parsed = toolInputSchemas.submit_combined_profile.parse({ persona_id: 'per_1', profile: combinedInput({}, { influence: { evidence: ['art_1'] } as never }) });
    expect(parsed.profile.influence).not.toHaveProperty('evidence');
    for (const bad of [
      combinedInput({}, { influence: { confidence: 1.2 } }),
      combinedInput({}, { influence: { value: 'x'.repeat(4001) } }),
      combinedInput({}, { influence: { conflict: 'x'.repeat(601) } }),
    ]) {
      expect(toolInputSchemas.submit_combined_profile.safeParse({ persona_id: 'per_1', profile: bad }).success).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------------------------------
describe('export', () => {
  const combineTool = (line: string) => line.includes('submit_combined_profile') || line.includes('stakeholder_combine_');

  it('the Decision of submit_combined_profile, and every record of its run, are internal: left out by default', async () => {
    const t = followSetup(opened);
    await followed(t, t.gone);
    await followed(t, t.parked);
    // One run logs a decision of its own and answers; the other says nothing.
    t.state.pick = (r) =>
      r.role !== 'retro'
        ? undefined
        : async (tc) => {
            if (personaOf(r.prompt) !== t.gone.id) return;
            await tc.call('log_decision', { what: 'LOGMARK weighed the press release lightly', why: 'it is favourable to its subject', confidence: 0.6 });
            await tc.call('submit_combined_profile', { persona_id: t.gone.id, profile: combinedInput() });
          };
    await runCombine('ws_a', t.deps);
    const byDefault = exportTrainingData('ws_a', t).split('\n').filter(Boolean);
    expect(byDefault.filter(combineTool)).toEqual([]);
    expect(byDefault.join('\n')).not.toMatch(/LOGMARK|COMBINEDMARK/);
    const all = exportTrainingData('ws_a', t, true).split('\n').filter(Boolean);
    expect(all.filter((l) => l.includes('"tool":"submit_combined_profile"'))).toHaveLength(1);
    expect(all.filter((l) => l.includes('stakeholder_combine_missing'))).toHaveLength(1);
    expect(all.join('\n')).toContain('LOGMARK');
  });

  it('the skipped-offline record is internal too', async () => {
    const t = followSetup(opened, (c) => {
      codexOnly(c);
      c.personaLearning = { model: CODEX };
    });
    await followed(t, t.gone);
    await runCombine('ws_a', t.deps);
    expect(exportTrainingData('ws_a', t)).not.toContain('stakeholder_combine_offline_unavailable');
    expect(exportTrainingData('ws_a', t, true)).toContain('stakeholder_combine_offline_unavailable');
  });

  // -- what the user says about a persona that holds internal knowledge is internal, whatever Decision it would join --
  const REASON = 'REASONMARK they never decided that way while here';
  const rate = (t: FollowSetup, p: Persona): Rating =>
    t.store.ratings.insert({
      id: newId('rat'), workspaceId: 'ws_a', targetType: 'persona', targetId: p.id, criterion: 'decision_criteria', agentValue: 0.6, verdict: 'disagree', userValue: 0.2,
      reason: 'RATINGMARK the profile we hold says otherwise', createdAt: tick(),
    });
  const exported = (t: FollowSetup, includeUploads = false) => exportTrainingDataWithSummary('ws_a', t, includeUploads);
  const internalCount = (t: FollowSetup) => {
    const { summary } = exported(t);
    const of = (c: typeof summary.excludedJudgments) => c.byCause.find((x) => x.cause === 'internal')!.count;
    return { judgments: of(summary.excludedJudgments), others: of(summary.excludedOtherLines) };
  };
  /** A worker of a competitor research task logs a decision of its own that names `p` in its refs. */
  const workerLog = async (t: FollowSetup, p: Persona) => {
    const r = await t.handle(t.ctx(t.task()), 'log_decision', { what: `WORKERMARK looked at ${p.id}`, why: 'to compare', confidence: 0.5, refs: [p.id] });
    if (!r.ok) throw new Error(r.error);
    tick();
  };

  it('an include override with a reason on a former colleague after a combine run: left out by default, exported with includeUploads', async () => {
    const t = followSetup(opened);
    await followed(t, t.gone);
    answering(t);
    expect((await runCombine('ws_a', t.deps)).combined).toBe(1);
    tick();
    const before = internalCount(t);
    setIncludeOverride(t.store, 'persona', t.gone.id, false, { actor: ACTOR, reason: REASON });
    const byDefault = exported(t);
    expect(byDefault.jsonl).not.toContain('REASONMARK');
    expect(byDefault.jsonl).not.toContain('"kind":"include_override"');
    expect(internalCount(t)).toEqual({ judgments: before.judgments, others: before.others + 1 });
    const all = exported(t, true).jsonl.split('\n').filter((l) => l.includes('"kind":"include_override"'));
    expect(all).toHaveLength(1);
    expect(all[0]).toContain(REASON);
    expect(all[0]).toContain(t.gone.id);
  });

  it('a rating of a former colleague\'s profile after a combine that ended without the call: left out by default', async () => {
    const t = followSetup(opened);
    await followed(t, t.gone);
    t.state.pick = (r) => (r.role === 'retro' ? async () => {} : undefined);
    expect((await runCombine('ws_a', t.deps)).skipped.map((x) => x.personaId)).toEqual([t.gone.id]);
    tick();
    const rating = rate(t, t.gone);
    const byDefault = exported(t).jsonl;
    expect(byDefault).not.toContain(rating.id);
    expect(byDefault).not.toContain('RATINGMARK');
    // With the switch it leaves with the record of the run that did not combine.
    const all = exported(t, true).jsonl.split('\n').filter((l) => l.includes(rating.id));
    expect(all).toHaveLength(1);
    expect(all[0]).toContain('stakeholder_combine_missing');
  });

  it('a rating of a former colleague joins no exported line, not even a worker\'s own decision whose refs name the person; it is counted as internal', async () => {
    const t = followSetup(opened);
    for (const p of [t.gone, t.parked]) await workerLog(t, p);
    const before = internalCount(t);
    const ratings = [rate(t, t.gone), rate(t, t.parked)];
    // The worker's decisions are research decisions and are exported, without what the user said about the person.
    const lines = exported(t).jsonl.split('\n').filter((l) => l.includes('WORKERMARK')).map((l) => JSON.parse(l));
    expect(lines).toHaveLength(2);
    for (const line of lines) expect(line.ratings).toEqual([]);
    expect(exported(t).jsonl).not.toMatch(/RATINGMARK/);
    for (const r of ratings) expect(exported(t).jsonl).not.toContain(r.id);
    // Each rating kept out of a line that is exported counts once under `internal`, however many lines it would have joined.
    await workerLog(t, t.gone);
    expect(internalCount(t)).toEqual({ judgments: before.judgments, others: before.others + 2 });
    expect(exported(t).summary.note).toMatch(/^Left out by default/);
    const all = exported(t, true).jsonl.split('\n').filter((l) => l.includes('WORKERMARK')).map((l) => JSON.parse(l));
    expect(all.map((l) => l.ratings.map((r: Rating) => r.id))).toEqual([[ratings[0]!.id], [ratings[1]!.id], [ratings[0]!.id]]);
  });

  /** `t.own` as research leaves it: its profile saved by own-stakeholder research, whose every Decision is internal. */
  const ownSave = (t: FollowSetup) => {
    const task = t.task('own_stakeholders');
    const run = t.store.agentRuns.insert({
      id: newId('arun'), workspaceId: 'ws_a', taskId: task.id, role: 'worker', model: { provider: 'claude', model: 'sonnet' }, token: 'tok_own', status: 'done',
      startedAt: T0, endedAt: T0, promptVersion: 'pv', taskType: 'own_stakeholders',
    });
    return t.store.decisions.insert({
      id: newId('dec'), workspaceId: 'ws_a', agentRunId: run.id, role: 'worker', model: run.model, kind: 'score',
      payload: { tool: 'save_stakeholder', personaId: t.own.id, label: 'OWNSAVEMARK' }, refs: [t.own.id], promptVersion: 'pv', createdAt: tick(),
    });
  };

  it('an ordinary own stakeholder, as before: a rating of its profile leaves only with the save of its research, which is internal', async () => {
    const t = followSetup(opened);
    const saved = ownSave(t);
    const before = internalCount(t);
    expect(before.judgments).toBeGreaterThan(0);
    const rating = rate(t, t.own);
    const byDefault = exported(t).jsonl;
    expect(byDefault).not.toContain(rating.id);
    expect(byDefault).not.toContain('OWNSAVEMARK');
    // The save is the judgment left out; a rating that only goes with it is not counted on its own.
    expect(internalCount(t)).toEqual(before);
    const line = exported(t, true).jsonl.split('\n').filter(Boolean).map((l) => JSON.parse(l)).find((l) => l.decision?.id === saved.id);
    expect(line.ratings.map((r: Rating) => r.id)).toEqual([rating.id]);
  });

  it('an ordinary own stakeholder holds internal knowledge too: its rating joins no other line, and an include override with a reason is internal', async () => {
    const t = followSetup(opened);
    ownSave(t);
    await workerLog(t, t.own);
    const rating = rate(t, t.own);
    setIncludeOverride(t.store, 'persona', t.own.id, false, { actor: ACTOR, reason: REASON });
    const byDefault = exported(t).jsonl;
    expect(byDefault).toContain('WORKERMARK');
    expect(byDefault).not.toContain(rating.id);
    expect(byDefault).not.toContain('REASONMARK');
    expect(exported(t, true).jsonl).toContain(REASON);
  });

  it('a competitor\'s stakeholder that never worked here is unaffected: its rating and its include override are exported as before', async () => {
    const t = followSetup(opened);
    const before = internalCount(t);
    await workerLog(t, t.rival);
    const rating = rate(t, t.rival);
    setIncludeOverride(t.store, 'persona', t.rival.id, false, { actor: ACTOR, reason: REASON });
    const { jsonl } = exported(t);
    const line = jsonl.split('\n').filter((l) => l.includes('WORKERMARK')).map((l) => JSON.parse(l));
    expect(line.map((l) => l.ratings.map((r: Rating) => r.id))).toEqual([[rating.id]]);
    const override = jsonl.split('\n').filter((l) => l.includes('"kind":"include_override"'));
    expect(override).toHaveLength(1);
    expect(override[0]).toContain(REASON);
    expect(internalCount(t)).toEqual(before);
  });

  it('a combined field resting on upload-derived internal evidence keeps the persona\'s judgments out of the export, as before (Review Focus 5)', async () => {
    const t = followSetup(opened);
    const upload = t.art('Internal org chart, uploaded', 'ws_a', 'upload');
    /** A former colleague whose internal profile rests on the upload, followed from public pages, combined with `bases`. */
    const colleague = async (label: string, bases: Partial<Record<StakeholderField, Basis>>, base: Basis) => {
      const own = t.stakeholder(label);
      t.store.personas.update(own.id, { profile: Object.fromEntries(Object.entries(own.profile).map(([f, v]) => [f, { ...v, evidence: [upload] }])) });
      const p = markLeft(t.pos, ACTOR, 'ws_a', own.id, { date: LEFT, to: { competitorId: 'cmp_rival' } });
      await followed(t, p);
      answering(t, (id) => ({ persona_id: id, profile: combinedInput(Object.fromEntries(STAKEHOLDER_FIELDS.map((f) => [f, bases[f] ?? base]))) }));
      expect((await runCombine('ws_a', t.deps)).combined).toBe(1);
      return t.store.personas.get(p.id)!;
    };
    // Every field from public sources: no field of the combined profile rests on the upload.
    const open = await colleague('Head of ops', {}, 'public');
    expect(Object.values(open.profile).flatMap((f) => f.evidence)).not.toContain(upload);
    const exported = (p: Persona, includeUploads = false) =>
      exportTrainingData('ws_a', t, includeUploads).split('\n').filter((l) => l.includes(p.id) && l.includes('"tool":"save_stakeholder"')).length;
    expect(exported(open)).toBe(1);

    // One field kept from inside, one resting on both, one concluded from both: each carries the upload.
    for (const basis of ['internal', 'both', 'inferred'] as const) {
      const p = await colleague(`Head of ${basis}`, { decision_criteria: basis }, 'public');
      expect(p.profile.decision_criteria!.evidence, basis).toContain(upload);
      expect(p.profile.role_mandate!.evidence, basis).not.toContain(upload);
      expect(exported(p), basis).toBe(0);
      expect(exported(p, true), basis).toBe(1);
    }
    expect(exported(open)).toBe(1);
  });
});

// ---------------------------------------------------------------------------------------------------
describe('the stakeholders phase', () => {
  it('combines after its tasks have ended: a follow save by a verified task becomes the combined profile in the same phase', async () => {
    const t = followSetup(opened);
    const order: string[] = [];
    t.state.pick = (r) => {
      order.push(r.kind);
      if (r.kind === 'orchestrate') {
        return r.round === 1
          ? async (tc) =>
              void (await tc.call('propose_tasks', {
                tasks: [{ type: 'competitor_stakeholders', brief: 'follow the former colleagues', model: { provider: 'claude', model: 'sonnet' }, needs_browser: false, acceptance_criteria: ['c'] }],
              }))
          : async () => {};
      }
      if (r.kind === 'work') {
        return async (tc) => {
          const a = (await tc.call('save_artifact', { kind: 'text', mime: 'text/plain', content: 'Rival Pay press release' })) as { artifactId: string };
          await tc.call('save_stakeholder', {
            label: 'x', stakeholder_type: 'other', subject: 'follow', relation: 'x', follow: t.gone.id, profile: t.publicInput('Head of sales', [a.artifactId]),
          });
          await tc.call('submit_result', { summary: 'followed', evidence: [a.artifactId] });
        };
      }
      if (r.kind === 'review') return review(9);
      if (r.role === 'retro') return async (tc) => void (await tc.call('submit_combined_profile', { persona_id: personaOf(r.prompt), profile: combinedInput() }));
      return undefined;
    };
    const rr = await startPhase('ws_a', 'stakeholders', t.deps);
    expect(rr.status).toBe('done');
    // The combine run comes last, after the tasks and the orchestrator's second round.
    expect(order.at(-1)).toBe('retro');
    expect(order.filter((k) => k === 'retro')).toHaveLength(1);
    const after = t.store.personas.get(t.gone.id)!;
    expect(after.profile.role_mandate).toMatchObject({ value: 'COMBINEDMARK role_mandate', basis: 'both' });
    expect(after.version).toBe(t.gone.version + 1);
    expect(after.combinedAt).toBeDefined();
    expect(t.store.personas.get(t.parked.id)).toEqual(t.parked); // not followed: nothing to combine
    expect(t.harnessEvents('stakeholder_combine_failed')).toEqual([]);
  });

  it('a combined profile whose agent.md cannot be written is rolled back; the phase ends done and the run is recorded as one that did not combine', async () => {
    const t = followSetup(opened);
    await followed(t, t.gone);
    // A file stands where a directory of the path would be.
    t.store.personas.update(t.gone.id, { agentMdPath: `${t.own.agentMdPath}/nested/x.md` });
    const errors: string[] = [];
    t.state.pick = (r) => {
      if (r.kind === 'orchestrate') return async () => {};
      if (r.role === 'retro') {
        return async (tc) => void (await tc.call('submit_combined_profile', { persona_id: personaOf(r.prompt), profile: combinedInput() }).catch((e: Error) => errors.push(e.message)));
      }
      return undefined;
    };
    const before = t.store.personas.get(t.gone.id)!;
    const rr = await startPhase('ws_a', 'stakeholders', t.deps);
    expect(rr.status).toBe('done');
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/^submit_combined_profile failed/);
    expect(t.store.personas.get(t.gone.id)).toEqual(before);
    expect(t.store.decisions.list({ workspaceId: 'ws_a' }).some((d) => (d.payload as { tool?: string }).tool === 'submit_combined_profile')).toBe(false);
    expect(t.harnessEvents('stakeholder_combine_missing')).toHaveLength(1);
  });

  it('a combine that throws never fails the phase: it is logged and recorded', async () => {
    const t = followSetup(opened);
    await followed(t, t.gone);
    // The record of a run that did not combine cannot be stored.
    t.store.db.exec(
      "CREATE TRIGGER test_no_missing BEFORE INSERT ON decisions WHEN NEW.payload LIKE '%stakeholder_combine_missing%' BEGIN SELECT RAISE(ABORT, 'decision log is down'); END",
    );
    t.state.pick = (r) => (r.kind === 'orchestrate' || r.role === 'retro' ? async () => {} : undefined);
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const rr = await startPhase('ws_a', 'stakeholders', t.deps);
      expect(rr.status).toBe('done');
      expect(log).toHaveBeenCalledWith(expect.stringMatching(/combining the layers of former colleagues after research run .* failed: .*decision log is down/));
      const [d] = t.harnessEvents('stakeholder_combine_failed');
      expect(d).toMatchObject({ agentRunId: `stakeholders:${rr.id}`, refs: [rr.id] });
      expect(d!.payload).toMatchObject({ researchRunId: rr.id, error: expect.stringContaining('decision log is down') });
    } finally {
      log.mockRestore();
    }
  });

  it('stakeholders off: the phase is skipped and nothing is combined', async () => {
    const t = followSetup(opened);
    await followed(t, t.gone);
    t.config.stakeholders = { enabled: false };
    const rr = await startPhase('ws_a', 'stakeholders', t.deps);
    expect(rr.status).toBe('done');
    expect(t.requests).toEqual([]);
    expect(t.store.personas.get(t.gone.id)).not.toHaveProperty('combinedAt');
  });
});
