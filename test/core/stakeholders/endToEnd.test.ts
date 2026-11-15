/**
 * Stakeholder personas end to end (design 2026-11-15-stakeholder-personas-design.md §18): offline
 * research saves two own stakeholders (hidden, research withheld) → the end of the `stakeholders` phase
 * creates the question round → the user answers → the stakeholders open → the panel gives simulated
 * reads → the user records a real decision that contradicts a read → nothing about the personas has
 * changed → the weekly retro proposes a correction citing the user's answer → the user accepts → the
 * persona's agent.md carries it and its version went up by one.
 */
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FakeScript } from '../../../src/core/harness/adapter.js';
import { retroToolHandlers, runRetro } from '../../../src/core/learning/lessons/retro.js';
import { acceptPersonaProposal } from '../../../src/core/personas/adjustments.js';
import { personaLearningToolHandlers } from '../../../src/core/personas/learn.js';
import { collectPersonaSignals } from '../../../src/core/personas/signals.js';
import { personaLearningRepos } from '../../../src/core/personas/store.js';
import type { AgentRequest } from '../../../src/core/research/deps.js';
import { startPhase } from '../../../src/core/research/orchestrator.js';
import { researchToolHandlers } from '../../../src/core/research/tools.js';
import { STAKEHOLDER_FIELDS } from '../../../src/core/scoring/criteria.js';
import { isHidden, stakeholderPersonas, stakeholderToolHandlers } from '../../../src/core/stakeholders/personas.js';
import { answerQuestions, openQuestions } from '../../../src/core/stakeholders/questions.js';
import { readsOf, runStakeholderReads, submitStakeholderReadHandler } from '../../../src/core/stakeholders/reads.js';
import { recordDecision } from '../../../src/core/stakeholders/statements.js';
import { stakeholderRepos } from '../../../src/core/stakeholders/store.js';
import { withholding } from '../../../src/core/stakeholders/withheld.js';
import type { Store } from '../../../src/core/store/db.js';
import type { Persona } from '../../../src/core/types.js';
import { researchSetup, review } from '../helpers/research.js';

const T0 = '2026-11-15T10:00:00.000Z';
const ACTOR = 'tester';
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

const tick = () => {
  minute++;
  vi.setSystemTime(new Date(Date.parse(T0) + minute * 60_000));
};
const later = () => new Date(Date.parse(T0) + (minute + 1) * 60_000);

const isLearning = (req: AgentRequest) => req.role === 'retro' && req.prompt.startsWith('# Persona learning');
const personaOf = (prompt: string) => /persona_id `(\w+)`/.exec(prompt)![1]!;
const slugOf = (req: AgentRequest) => /^name: (\S+)$/m.exec(req.systemPrompt)?.[1] ?? '';
const recOf = (req: AgentRequest) => /^Recommendation id: (\S+)$/m.exec(req.prompt)?.[1] ?? '';
/** Ids of the statements a learning prompt shows, with their source (`- sst_… (source) — text`). */
const statementsIn = (prompt: string) => [...prompt.matchAll(/^- (sst_\w+) \((\w+)[,)]/gm)].map((m) => ({ id: m[1]!, source: m[2]! }));

const ANSWER = 'She signs off only on what pays back within a year.';
const DECISION = 'Turned it down: a three-year payback, and she wants one year.';
const CORRECTION = 'You approve a proposal only when it pays back within a year.';
const SECRET = 'payback secret value';

const profile = (evidence: string[]) =>
  Object.fromEntries(STAKEHOLDER_FIELDS.map((f) => [f, { value: `${f}: ${SECRET}`, confidence: 0.6, evidence }]));

function setup() {
  const t = researchSetup(opened, {
    extraHandlers: ({ config }) => ({
      ...researchToolHandlers(),
      ...stakeholderToolHandlers({ dataDir: config.dataDir }),
      ...retroToolHandlers(),
      ...personaLearningToolHandlers(),
      submit_stakeholder_read: submitStakeholderReadHandler,
    }),
  });
  t.store.workspaces.insert({
    id: 'ws_a', name: 'Acme', sector: 'saas', createdAt: T0, scope: { level: 'division', name: 'Acme Payments', description: 'payments division' },
  });
  const note = t.artifacts.save({ workspaceId: 'ws_a', kind: 'text', mime: 'text/plain', bytes: 'Org notes: the CFO approves budgets; billing runs invoices.' }).id;
  return { ...t, note };
}

describe('stakeholder personas end to end', () => {
  it('research → hidden → questions → answers → open → reads → a real decision → retro → proposal citing the answer → accept', async () => {
    const t = setup();
    const repos = stakeholderRepos(t.store);
    const learning = personaLearningRepos(t.store);
    const offline: boolean[] = [];

    // --- 1. offline research saves two own stakeholders; the phase end creates the question round -----
    t.state.pick = (req): FakeScript | undefined => {
      if (req.kind === 'orchestrate') {
        if (req.round !== 1) return async () => undefined;
        return async (tc) => {
          await tc.call('propose_tasks', {
            tasks: [{ type: 'own_stakeholders', brief: 'who this node depends on', model: { provider: 'claude', model: 'sonnet' }, needs_browser: true, acceptance_criteria: ['evidence'] }],
          });
        };
      }
      if (req.kind === 'work' && req.role === 'worker') {
        offline.push(req.offline === true);
        return async (tc) => {
          await tc.call('save_stakeholder', { label: 'Chief financial officer', stakeholder_type: 'leader', subject: 'own', relation: 'approves budgets', profile: profile([t.note]) });
          await tc.call('save_stakeholder', { label: 'Billing platform team', stakeholder_type: 'team', subject: 'own', relation: 'runs the invoices', profile: profile([t.note]) });
          await tc.call('submit_result', { summary: 'two stakeholders' });
        };
      }
      if (req.role === 'reviewer') return review(9);
      return undefined;
    };
    const rr = await startPhase('ws_a', 'stakeholders', t.deps);
    expect(rr.status).toBe('done');
    expect(offline).toEqual([true]);
    const [task] = t.store.tasks.list({ runId: rr.id });
    expect(task).toMatchObject({ type: 'own_stakeholders', needsBrowser: false, status: 'verified' });

    const bySlug = (slug: string) => stakeholderPersonas(t.store, 'ws_a').find((p) => p.slug === slug)!;
    const cfo = bySlug('stk-chief-financial-officer');
    const ops = bySlug('stk-billing-platform-team');
    expect([cfo, ops].map((p) => [p.disclosure, p.status, p.version])).toEqual([['hidden', 'verified', 1], ['hidden', 'verified', 1]]);
    // While hidden, the research is withheld and the questions hold the label and nothing it found.
    expect(withholding(t.store).task(task)).toBe(true);
    const groups = openQuestions(t.store, 'ws_a');
    expect(groups.map((g) => [g.persona?.label, g.questions.length])).toEqual([['Chief financial officer', 4], ['Billing platform team', 4], [undefined, 2]]);
    expect(JSON.stringify(groups)).not.toContain(SECRET);
    expect(JSON.stringify(groups)).not.toContain('approves budgets');
    // Hidden stakeholders give no reads.
    t.store.recommendations.insert({
      id: 'rec_1', workspaceId: 'ws_a', title: 'Raise prices', summary: 'A 10% price rise', criteria: {}, findingIds: [], priority: 3, personaFeedback: [],
      createdAt: T0, status: 'verified',
    });
    expect(await runStakeholderReads('ws_a', t.deps)).toMatchObject({ reads: 0 });

    // --- 2. the user answers one question of each; both open, the round closes ---------------------
    tick();
    const question = (personaId: string, field: string) => groups.find((g) => g.persona?.id === personaId)!.questions.find((q) => q.field === field)!;
    const answered = answerQuestions(t.store, ACTOR, 'ws_a', {
      answers: [
        { questionId: question(cfo.id, 'decision_criteria').id, text: ANSWER },
        { questionId: question(ops.id, 'dependencies').id, text: 'They need two weeks of notice for any invoice change.' },
      ],
    });
    expect(answered.opened.sort()).toEqual([cfo.id, ops.id].sort());
    const answer = answered.statements.find((s) => s.personaId === cfo.id)!;
    expect(answer).toMatchObject({ source: 'question_answer', field: 'decision_criteria', text: ANSWER });
    expect(openQuestions(t.store, 'ws_a')).toEqual([]);
    expect(withholding(t.store).task(task)).toBe(false);
    const persona = (p: Persona) => t.store.personas.get(p.id)!;
    expect(isHidden(persona(cfo))).toBe(false);
    const snapshot = () => [cfo, ops].map((p) => ({ version: persona(p).version, md: readFileSync(p.agentMdPath, 'utf8') }));
    const afterAnswer = snapshot();

    // --- 3. the panel: each open stakeholder reads the recommendation --------------------------------
    t.state.pick = (req) => {
      if (req.role !== 'persona') return undefined;
      const stance = slugOf(req) === cfo.slug ? 'approve' : 'approve_with_conditions';
      return async (tc) => {
        await tc.call('submit_stakeholder_read', {
          recommendation_id: recOf(req), stance, conditions: ['a pilot first'], concerns: ['cost'], reasoning: `${slugOf(req)} reads it`, would_change_mind: 'numbers',
        });
      };
    };
    tick();
    expect(await runStakeholderReads('ws_a', t.deps)).toEqual({ reads: 2, missing: [], skippedByCap: 0 });
    const reads = readsOf(t.store, 'ws_a', 'rec_1');
    expect(reads.map((r) => [r.personaId, r.stance, r.simulated])).toEqual([[ops.id, 'approve_with_conditions', true], [cfo.id, 'approve', true]]);
    expect(t.store.recommendations.get('rec_1')!.priority).toBe(3); // reads never change the priority

    // --- 4. the user records the real decision, which contradicts the CFO's read --------------------
    tick();
    const decision = recordDecision(t.store, ACTOR, 'ws_a', { recommendationId: 'rec_1', personaId: cfo.id, decision: 'rejected', reasoning: DECISION });
    expect(decision).toMatchObject({ source: 'decision_record', decision: 'rejected', recommendationId: 'rec_1' });
    expect(collectPersonaSignals(t.store, cfo.id)).toEqual([
      expect.objectContaining({ source: 'decision_record', polarity: 'disagree', itemKey: 'rec:rec_1', topic: 'decision' }),
    ]);

    // Nothing changed between the answer and the retro.
    expect(snapshot()).toEqual(afterAnswer);
    expect(learning.proposals.list()).toEqual([]);
    expect(learning.adjustments.list()).toEqual([]);
    expect(learning.runs.list()).toEqual([]);

    // --- 5. the retro: the CFO's learning run cites the answer; the team's proposes nothing ----------
    const shown: Record<string, Array<{ id: string; source: string }>> = {};
    t.state.pick = (req) => {
      if (req.role !== 'retro') return undefined;
      if (!isLearning(req)) return async (tc) => void (await tc.call('submit_retro', { summary: 'A quiet week.', proposals: [] }));
      const id = personaOf(req.prompt);
      shown[id] = statementsIn(req.prompt);
      const cited = shown[id].filter((s) => s.source === 'question_answer').map((s) => s.id);
      return async (tc) => {
        await tc.call('submit_persona_learning', {
          persona_id: id,
          assumption: 'Approves on strategic fit; the user says she decides on payback.',
          proposals: id === cfo.id ? [{ action: 'add', field: 'decision_criteria', text: CORRECTION, why: 'The user said so.', evidence: cited }] : [],
        });
      };
    };
    tick();
    const retro = (await runRetro(t.deps, 'ws_a', { now: later() }))!;
    expect(retro.digest).toMatchObject({ personasEvaluated: 2, personasQualified: 2, personaLearningRuns: 2, personaProposals: 1 });
    expect(shown[cfo.id]!.map((s) => s.id).sort()).toEqual([answer.id, decision.id].sort());
    const [proposal] = learning.proposals.list({ personaId: cfo.id });
    expect(proposal).toMatchObject({ action: 'add', status: 'pending', internal: true, field: 'decision_criteria', text: CORRECTION, evidence: [answer.id] });
    expect(learning.proposals.list({ personaId: ops.id })).toEqual([]);
    expect(learning.runs.list({ personaId: ops.id })[0]).toMatchObject({ status: 'no_change' });
    // The runs consumed the statements; the personas still have not changed.
    expect(repos.statements.list({ workspaceId: 'ws_a' }).every((s) => !!s.consumedByRunId)).toBe(true);
    expect(snapshot()).toEqual(afterAnswer);

    // --- 6. the user accepts: a new version whose agent.md carries the correction --------------------
    tick();
    const { adjustment } = acceptPersonaProposal(t.store, ACTOR, 'ws_a', proposal!.id, { reason: 'right, payback is all she asks about' });
    expect(adjustment).toMatchObject({ status: 'active', internal: true });
    expect(persona(cfo).version).toBe(2);
    const md = readFileSync(cfo.agentMdPath, 'utf8');
    expect(md).toContain(`- [${adjustment.marker}.v1] (decision_criteria) ${CORRECTION}`);
    expect(md).toContain('version: 2');
    expect(persona(ops).version).toBe(1);
  });
});
