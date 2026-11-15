/**
 * Seeds for the flow feedback tests (core and API): a research harness with the ranking round's tool
 * handlers, node ws_a "Acme" (tree A), verified personas and competitors, verified primary sign-up
 * flows, new versions, stored verdicts, check answers, and scripted persona answers for the round.
 * Every seed takes the workspace, so a second tree (ws_b) can be seeded alongside.
 */
import { join } from 'node:path';
import type { BifConfig } from '../../../src/core/config/schema.js';
import { activeChecklists, flowTypeByKey } from '../../../src/core/flows/catalog.js';
import { applyFlowStatus, saveFlow, type FlowStepInput, type SaveFlowInput } from '../../../src/core/flows/flows.js';
import { flowRepos } from '../../../src/core/flows/repos.js';
import { flowRoundToolHandlers } from '../../../src/core/flows/round.js';
import type { Flow, FlowVerdict } from '../../../src/core/flows/types.js';
import { recordVerdicts, type VerdictInput } from '../../../src/core/flows/verdicts.js';
import type { FakeScript } from '../../../src/core/harness/adapter.js';
import { linkCompetitor } from '../../../src/core/knowledge/entityLinks.js';
import type { AgentRequest } from '../../../src/core/research/deps.js';
import { PERSONA_FIELDS } from '../../../src/core/scoring/criteria.js';
import type { Store } from '../../../src/core/store/db.js';
import { newId } from '../../../src/core/store/repos.js';
import type { Persona } from '../../../src/core/types.js';
import { addTask, researchSetup, type SetupOptions } from '../helpers/research.js';

export const T0 = '2026-11-14T10:00:00.000Z';

export const STEPS: FlowStepInput[] = [
  { action: 'Open the sign-up page', observation: 'A form with email and password', asked: ['email', 'password'] },
  { action: 'Submit the form', observation: 'A check-your-inbox screen' },
];

type Verdict = { a: string; b: string; winner: 'a' | 'b' | 'tie'; strength: 1 | 2 | 3; confidence: number; reason: string };
/** What a persona answers for one listed pair (undefined: leaves it out). */
export type Judge = (slug: string, a: string, b: string, focused: boolean) => Verdict | undefined;

export const pairsOf = (prompt: string): Array<[string, string]> => [...prompt.matchAll(/^- (flw_\w+) vs (flw_\w+)$/gm)].map((m) => [m[1]!, m[2]!]);
export const isFocused = (req: AgentRequest) => req.prompt.startsWith('# Focused head-to-head');
const slugOf = (req: AgentRequest) => /^name: (\S+)$/m.exec(req.systemPrompt)![1]!;
const flowTypeOf = (req: AgentRequest) => /`flow_type`: (\w+)/.exec(req.prompt)![1]!;

/** `extraHandlers`: tool handlers registered beside the ranking round's (e.g. the retro's and persona learning's). */
export function flowSetup(opened: Store[], config?: (c: BifConfig) => void, extraHandlers?: SetupOptions['extraHandlers']) {
  const t = researchSetup(opened, {
    extraHandlers: (deps) => ({ ...flowRoundToolHandlers(), ...(extraHandlers?.(deps) ?? {}) }),
    ...(config ? { config } : {}),
  });
  t.store.workspaces.insert({ id: 'ws_a', name: 'Acme', sector: 'saas', createdAt: T0 });
  const typeId = flowTypeByKey(t.store, 'ws_a', 'sign_up')!.id;

  const persona = (slug: string, ws = 'ws_a'): Persona => {
    const profile = Object.fromEntries(PERSONA_FIELDS.map((f) => [f, { value: `${f} of ${slug}`, confidence: 0.7, evidence: [] }]));
    return t.store.personas.insert({
      id: `per_${slug}`, workspaceId: ws, slug, segment: `${slug} segment`, profile, version: 1, status: 'verified',
      agentMdPath: join(t.dir, 'personas', `${slug}.md`),
    });
  };
  const competitor = (name: string, ws: string) => {
    const c = t.store.competitors.insert({
      id: newId('cmp'), workspaceId: ws, name, threat: 3, directness: 3, comparison: { pricing: 3, onboarding: 3, ux: 3, features: 3 },
      evidence: [], createdAt: T0, updatedAt: T0, status: 'verified',
    });
    linkCompetitor(t.store, c);
  };
  /** A verified current primary sign-up flow of `subject` (the node's own company when it is the node's name). */
  const flow = (subject: string, ws = 'ws_a', extra: Partial<SaveFlowInput> = {}): Flow => {
    const kind = subject === t.store.workspaces.get(ws)!.name ? 'company' : 'competitor';
    if (kind === 'competitor' && !t.store.competitors.list({ workspaceId: ws }).some((c) => c.name === subject)) competitor(subject, ws);
    const r = saveFlow(t.store, { workspaceId: ws }, {
      subject: { kind, name: subject }, flowTypeKey: 'sign_up', variant: 'Email', primary: true, name: `${subject} sign-up`,
      goal: 'Create an account', reachedGoal: true, steps: STEPS, ...extra,
    });
    if (!r.saved) throw new Error('not saved');
    return flowRepos(t.store).flows.update(r.flow.id, { status: 'verified' });
  };
  /** A new verified version of `old` that becomes current. */
  const newVersion = (old: Flow, steps: FlowStepInput[] = [{ action: 'Click Sign up with Google', observation: 'Account created' }]): Flow => {
    const task = addTask(t.store, { workspaceId: old.workspaceId, type: 'flow_walkthrough', status: 'verified' });
    const r = saveFlow(t.store, { workspaceId: old.workspaceId, taskId: task.id, taskRound: 1 }, {
      subject: { id: old.subjectEntityId }, flowTypeKey: 'sign_up', variant: old.variant, primary: old.isPrimary, name: old.name, goal: old.goal,
      reachedGoal: true, steps, relation: { replaces: old.id },
    });
    if (!r.saved) throw new Error('not saved');
    flowRepos(t.store).flows.update(r.flow.id, { status: 'verified' });
    applyFlowStatus(t.store, task, 'verified');
    return flowRepos(t.store).flows.get(r.flow.id)!;
  };
  /** Stores one verdict of `persona` (as a run would), returns its row. */
  const verdict = (p: Persona, winner: Flow, loser: Flow, extra: Partial<VerdictInput> & { stage?: 'broad' | 'focused'; agentRunId?: string } = {}): FlowVerdict => {
    const { stage = 'broad', agentRunId, ...v } = extra;
    recordVerdicts(
      t.store,
      { workspaceId: p.workspaceId, flowTypeId: winner.flowTypeId, persona: p, stage, allowed: [winner.id, loser.id], ...(agentRunId ? { agentRunId } : {}) },
      [{ a: winner.id, b: loser.id, winner: 'a', strength: 2, confidence: 0.9, reason: 'Fewer steps to the goal.', ...v }],
    );
    return flowRepos(t.store).flowVerdicts.list({ personaId: p.id }).at(-1)!;
  };
  /** Answers a scored item of the general checklist for a flow. */
  const check = (f: Flow, key: string, answer: 'pass' | 'fail') => {
    const general = activeChecklists(t.store, f.workspaceId, f.flowTypeId).general;
    flowRepos(t.store).flowChecks.insert({ flowId: f.id, checklistId: general.id, itemKey: key, answer, stepRefs: [1], mentionRefs: [], origin: 'walkthrough', updatedAt: T0 });
  };
  /** Persona runs answer every listed pair through `judge`. */
  const answer = (judge: Judge) => {
    t.state.pick = (req): FakeScript | undefined => {
      if (req.role !== 'persona') return undefined;
      const verdicts = pairsOf(req.prompt).flatMap(([a, b]) => judge(slugOf(req), a, b, isFocused(req)) ?? []);
      return async (tools) => {
        await tools.call('submit_flow_verdicts', { flow_type: flowTypeOf(req), verdicts });
      };
    };
  };
  const personaRuns = () => t.requests.filter((r) => r.role === 'persona');
  /** A second business tree, ws_b "Beta", with its own catalog. */
  const otherTree = () => {
    t.store.workspaces.insert({ id: 'ws_b', name: 'Beta', sector: 'saas', createdAt: T0 });
    return flowTypeByKey(t.store, 'ws_b', 'sign_up')!.id;
  };
  return { ...t, typeId, persona, flow, newVersion, verdict, check, answer, personaRuns, otherTree };
}

/** The flow named first in the pair wins clearly, confidently. */
export const firstWins: Judge = (_slug, a, b) => ({ a, b, winner: 'a', strength: 2, confidence: 0.9, reason: 'Fewer steps to the goal.' });
