/**
 * Persona learning in the training export (design §15): learning proposals and their decisions follow
 * the export's treatment of lesson proposals. Their Decisions (the run's `submit_persona_learning`, the
 * user's accept / reject / retire) are lines of their own that join only ratings of themselves; they
 * are never a judgment of the persona they name, so ratings of the persona keep joining the persona's
 * own judgment; their feedback events are `feedback_event` lines; the proposal rows are not lines; and
 * the upload rule applies to them as to any decision.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { acceptPersonaProposal, rejectPersonaProposal, retireAdjustment } from '../../../src/core/personas/adjustments.js';
import { submitPersonaLearningHandler } from '../../../src/core/personas/learn.js';
import { personaLearningRepos } from '../../../src/core/personas/store.js';
import type { PersonaProposal } from '../../../src/core/personas/types.js';
import { exportTrainingData } from '../../../src/core/scoring/export.js';
import type { Store } from '../../../src/core/store/db.js';
import { newId } from '../../../src/core/store/repos.js';
import type { Decision, Persona, Rating } from '../../../src/core/types.js';
import { writeAgentMd } from '../../../src/core/market/personas.js';
import { flowSetup, T0 } from '../flows/flowFixture.js';

const opened: Store[] = [];
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(T0));
});
afterEach(() => {
  vi.useRealTimers();
  for (const s of opened.splice(0)) s.close();
});

const at = (minutes: number) => new Date(Date.parse(T0) + minutes * 60_000).toISOString();
type Line = { type: string; decision?: Decision; ratings?: Rating[]; feedbackEvent?: { kind: string; targetId: string } };
const lines = (jsonl: string): Line[] => jsonl.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as Line);
const isLearning = (d: Decision | undefined) => ['persona_learning', 'submit_persona_learning'].includes(String((d?.payload as { tool?: unknown } | null)?.tool));

function seed() {
  const t = flowSetup(opened);
  const smb = t.persona('smb');
  writeAgentMd(t.store, smb);
  // The persona's own judgment (as a research run records it).
  const judgment = t.store.decisions.insert({
    id: newId('dec'), workspaceId: 'ws_a', agentRunId: 'run_research', role: 'worker', model: { provider: 'claude', model: 'm' }, kind: 'decision',
    payload: { tool: 'save_persona', personaId: smb.id }, refs: [smb.id], promptVersion: 'v1', createdAt: at(0),
  });
  const repos = personaLearningRepos(t.store);
  const proposal = (p: Persona, extra: Partial<PersonaProposal> = {}): PersonaProposal =>
    repos.proposals.insert({
      id: newId('ppr'), rootWorkspaceId: 'ws_a', workspaceId: p.workspaceId, personaId: p.id, action: 'add', field: 'buying_behavior',
      text: 'You compare on total yearly cost.', rationale: 'r', evidence: ['fbk_1'], stats: { n: 6, disagree: 5 }, source: 'retro', status: 'pending',
      createdAt: at(1), ...extra,
    });
  // A learning run's own record (as `submit_persona_learning` writes it).
  const submitted = t.store.decisions.insert({
    id: newId('dec'), workspaceId: 'ws_a', agentRunId: 'run_learning', role: 'retro', model: { provider: 'claude', model: 'm' }, kind: 'decision',
    payload: { tool: 'submit_persona_learning', runId: 'plr_1', personaId: smb.id, assumption: 'Overrates short forms.', proposalIds: [] },
    refs: ['plr_1'], promptVersion: 'v1', createdAt: at(1),
  });
  const rate = (targetType: Rating['targetType'], targetId: string, minutes: number) =>
    t.store.ratings.insert({
      id: newId('rat'), workspaceId: 'ws_a', targetType, targetId, criterion: 'pains', agentValue: 'x', verdict: 'disagree', createdAt: at(minutes),
    } as Rating);
  return { ...t, smb, judgment, submitted, proposal, rate };
}

describe('training export: persona learning rows follow the lesson-proposal rule', () => {
  it('learning Decisions are lines that join only their own ratings; ratings of the persona stay with its judgment', () => {
    const t = seed();
    vi.setSystemTime(new Date(at(2)));
    const accepted = acceptPersonaProposal(t.store, 'local-user', 'ws_a', t.proposal(t.smb).id, { reason: 'they pay yearly' });
    vi.setSystemTime(new Date(at(3)));
    rejectPersonaProposal(t.store, 'local-user', 'ws_a', t.proposal(t.smb).id, { reason: 'not my audience' });
    vi.setSystemTime(new Date(at(4)));
    retireAdjustment(t.store, 'local-user', 'ws_a', accepted.adjustment.id);
    const profileRating = t.rate('persona', t.smb.id, 5); // after every learning decision
    const learningDecisions = t.store.decisions.list({ workspaceId: 'ws_a' }).filter(isLearning);
    expect(learningDecisions).toHaveLength(4); // submit, accept, reject, retire
    const own = t.rate('decision', learningDecisions[1]!.id, 6);

    const out = lines(exportTrainingData('ws_a', t));
    const decisionLines = out.filter((l) => l.type === 'decision');
    const learning = decisionLines.filter((l) => isLearning(l.decision));
    expect(learning.map((l) => l.decision!.id).sort()).toEqual(learningDecisions.map((d) => d.id).sort());
    for (const l of learning) expect(l.ratings!.map((r) => r.id)).toEqual(l.decision!.id === learningDecisions[1]!.id ? [own.id] : []);
    expect(decisionLines.find((l) => l.decision!.id === t.judgment.id)!.ratings!.map((r) => r.id)).toEqual([profileRating.id]);

    const kinds = out.filter((l) => l.type === 'feedback_event').map((l) => l.feedbackEvent!.kind);
    expect(kinds).toEqual(expect.arrayContaining(['persona_learning_accept', 'persona_learning_reject', 'persona_adjustment_retire']));
    // The proposal and adjustment rows are not lines of their own.
    expect(new Set(out.map((l) => l.type))).toEqual(new Set(['decision', 'feedback_event']));
  });

  it('a learning Decision stays a line when the persona it names was superseded (it is not a judgment of the persona)', () => {
    const t = seed();
    vi.setSystemTime(new Date(at(2)));
    acceptPersonaProposal(t.store, 'local-user', 'ws_a', t.proposal(t.smb).id);
    t.store.personas.update(t.smb.id, { status: 'superseded' });
    const ids = lines(exportTrainingData('ws_a', t)).filter((l) => l.type === 'decision').map((l) => l.decision!.id);
    expect(ids).not.toContain(t.judgment.id);
    expect(ids).toEqual(expect.arrayContaining(t.store.decisions.list({ workspaceId: 'ws_a' }).filter(isLearning).map((d) => d.id)));
  });

  it('the upload rule applies: a learning Decision citing an upload is left out by default and kept on opt-in', () => {
    const t = seed();
    const upload = t.artifacts.save({ workspaceId: 'ws_a', kind: 'upload', mime: 'text/plain', bytes: 'internal notes' });
    t.store.personas.update(t.smb.id, { profile: { ...t.smb.profile, pains: { value: 'p', confidence: 0.7, evidence: [upload.id] } } });
    vi.setSystemTime(new Date(at(2)));
    acceptPersonaProposal(t.store, 'local-user', 'ws_a', t.proposal(t.smb).id);
    const accepts = (jsonl: string) => lines(jsonl).filter((l) => l.type === 'decision' && (l.decision!.payload as { tool?: string }).tool === 'persona_learning').length;
    expect(accepts(exportTrainingData('ws_a', t))).toBe(0);
    expect(accepts(exportTrainingData('ws_a', t, true))).toBe(1);
  });

  it('the upload rule applies to the learning run\'s own Decision: it names the persona, so a persona resting on an upload keeps it out by default', async () => {
    const t = seed();
    const upload = t.artifacts.save({ workspaceId: 'ws_a', kind: 'upload', mime: 'text/plain', bytes: 'internal notes' });
    t.store.personas.update(t.smb.id, { profile: { ...t.smb.profile, pains: { value: 'p', confidence: 0.7, evidence: [upload.id] } } });
    const run = personaLearningRepos(t.store).runs.insert({
      id: newId('plr'), rootWorkspaceId: 'ws_a', personaId: t.smb.id, status: 'running', signalsThrough: at(1), shownSignalIds: [],
      stats: { n: 0, agree: 0, disagree: 0, items: 0, lower: 0 }, createdAt: at(1),
    });
    vi.setSystemTime(new Date(at(2)));
    const ctx = { agentRunId: 'run_learning_2', workspaceId: 'ws_a', role: 'retro' as const, model: { provider: 'claude' as const, model: 'm' }, promptVersion: 'v1' };
    const res = await submitPersonaLearningHandler(ctx, { persona_id: t.smb.id, assumption: 'Overrates short forms.', proposals: [] }, t, {} as never);
    expect(res.ok).toBe(true);
    const own = t.store.decisions.list({ workspaceId: 'ws_a' }).find((d) => (d.payload as { runId?: string }).runId === run.id)!;
    expect(own.refs).toContain(t.smb.id);
    const has = (jsonl: string) => lines(jsonl).some((l) => l.type === 'decision' && l.decision!.id === own.id);
    expect(has(exportTrainingData('ws_a', t))).toBe(false);
    expect(has(exportTrainingData('ws_a', t, true))).toBe(true);
  });
});
