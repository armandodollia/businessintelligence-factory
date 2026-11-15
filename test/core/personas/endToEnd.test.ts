/**
 * Persona learning end to end (design §17): flows and a persona's verdicts → the user reacts (6
 * reactions, 5 disagree, on 4 pairs) → nothing changes at reaction time → the weekly retro proposes →
 * the user accepts → the persona's agent.md carries the correction, its version goes up by one and its
 * verdicts stop being live → later reactions disagree as often → the next retro proposes retiring the
 * adjustment (engine step, no agent).
 */
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { reactToVerdict } from '../../../src/core/flows/feedback.js';
import { liveVerdicts } from '../../../src/core/flows/verdicts.js';
import type { FakeScript } from '../../../src/core/harness/adapter.js';
import { retroToolHandlers, runRetro } from '../../../src/core/learning/lessons/retro.js';
import { writeAgentMd } from '../../../src/core/market/personas.js';
import { acceptPersonaProposal } from '../../../src/core/personas/adjustments.js';
import { personaLearningToolHandlers } from '../../../src/core/personas/learn.js';
import { collectPersonaSignals } from '../../../src/core/personas/signals.js';
import { personaLearningRepos } from '../../../src/core/personas/store.js';
import type { AgentRequest } from '../../../src/core/research/deps.js';
import type { Store } from '../../../src/core/store/db.js';
import type { Flow } from '../../../src/core/flows/types.js';
import type { Persona } from '../../../src/core/types.js';
import { flowSetup, T0 } from '../flows/flowFixture.js';

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
/** A time after every action so far (the retro's "now"). */
const later = () => new Date(Date.parse(T0) + (minute + 1) * 60_000);
const isLearning = (req: AgentRequest) => req.role === 'retro' && req.prompt.startsWith('# Persona learning');
const CORRECTION = 'You compare on total yearly cost, not the monthly price.';

describe('persona learning end to end', () => {
  it('reactions → retro → proposal → accept → new agent.md, version +1, verdicts not live → later reactions → engine retire', async () => {
    const t = flowSetup(opened, undefined, () => ({ ...retroToolHandlers(), ...personaLearningToolHandlers() }));
    const smb = t.persona('smb');
    writeAgentMd(t.store, smb);
    const agentMd = () => readFileSync(smb.agentMdPath, 'utf8');
    const persona = () => t.store.personas.get(smb.id)!;
    const repos = personaLearningRepos(t.store);
    const flows = ['Acme', 'Globex', 'Initech', 'Hooli'].map((n) => t.flow(n));

    // Retro runs: the persona learning run cites three disagreements on different pairs; the lessons retro proposes nothing.
    t.state.pick = (req): FakeScript | undefined => {
      if (req.role !== 'retro') return undefined;
      if (!isLearning(req)) return async (tc) => void (await tc.call('submit_retro', { summary: 'A quiet week.', proposals: [] }));
      return async (tc) => {
        const seen = new Set<string>();
        const evidence = collectPersonaSignals(t.store, smb.id)
          .filter((s) => s.polarity === 'disagree' && req.prompt.includes(s.id) && !seen.has(s.itemKey) && seen.add(s.itemKey))
          .slice(0, 3)
          .map((s) => s.id);
        await tc.call('submit_persona_learning', {
          persona_id: smb.id, assumption: 'This persona reads the monthly price; you judged on the yearly total.',
          proposals: [{ action: 'add', field: 'buying_behavior', text: CORRECTION, why: 'Most disagreements turn on the yearly cost.', evidence }],
        });
      };
    };

    /** Six verdicts of `p` on four pairs (two pairs judged twice), each reacted to: five disagree, one agree. */
    const react = (p: Persona) => {
      const pairs: Array<[Flow, Flow]> = [[flows[0]!, flows[1]!], [flows[0]!, flows[2]!], [flows[0]!, flows[3]!], [flows[1]!, flows[2]!]];
      const judged = [...pairs, pairs[0]!, pairs[1]!].map(([a, b], i) => {
        tick();
        return t.verdict(p, a, b, i >= pairs.length ? { stage: 'focused' } : {});
      });
      judged.forEach((v, i) => {
        tick();
        reactToVerdict(t.store, 'local-user', v.id, i === 0 ? 'agree' : 'disagree', i === 1 ? 'they pay yearly' : undefined);
      });
      return judged;
    };

    // --- 1. reactions: nothing changes at reaction time ---------------------------------------------
    const mdBefore = agentMd();
    const first = react(persona());
    const signals = collectPersonaSignals(t.store, smb.id);
    expect(signals).toHaveLength(6);
    expect(signals.filter((s) => s.polarity === 'disagree')).toHaveLength(5);
    expect(new Set(signals.map((s) => s.itemKey)).size).toBe(4);
    expect(persona().version).toBe(1);
    expect(agentMd()).toBe(mdBefore);
    expect(repos.adjustments.list()).toEqual([]);
    expect(repos.proposals.list()).toEqual([]);
    expect(repos.runs.list()).toEqual([]);

    // --- 2. the retro proposes; the persona still has not changed -----------------------------------
    const retro = (await runRetro(t.deps, 'ws_a', { now: later() }))!;
    expect(retro.digest).toMatchObject({ personasEvaluated: 1, personasQualified: 1, personaLearningRuns: 1, personaProposals: 1 });
    const [proposal] = repos.proposals.list({ personaId: smb.id });
    expect(proposal).toMatchObject({ action: 'add', status: 'pending', text: CORRECTION, source: 'retro', stats: { n: 6, disagree: 5, items: 4 } });
    expect(repos.runs.list({ personaId: smb.id })[0]).toMatchObject({ status: 'proposed', retroId: retro.id });
    expect(persona().version).toBe(1);
    expect(agentMd()).toBe(mdBefore);
    const live = liveVerdicts(t.store, 'ws_a', t.typeId).filter((v) => v.personaId === smb.id);
    expect(live).toHaveLength(4); // one per pair
    expect(first.map((v) => v.id)).toEqual(expect.arrayContaining(live.map((v) => v.id)));

    // --- 3. the user accepts --------------------------------------------------------------------------
    tick();
    const { adjustment } = acceptPersonaProposal(t.store, 'local-user', 'ws_a', proposal!.id, { reason: 'right, they budget per year' });
    expect(persona().version).toBe(2);
    expect(agentMd()).toContain('## Corrections from people who know your segment');
    expect(agentMd()).toContain(`- [${adjustment.marker}.v1] (buying_behavior) ${CORRECTION}`);
    expect(liveVerdicts(t.store, 'ws_a', t.typeId).filter((v) => v.personaId === smb.id)).toEqual([]);

    // --- 4. six later reactions with the same disagreement rate → the next retro proposes a retire ---
    react(persona());
    const requestsBefore = t.requests.filter(isLearning).length;
    const next = (await runRetro(t.deps, 'ws_a', { now: later() }))!;
    expect(next.digest).toMatchObject({ personasQualified: 1, personaLearningRuns: 0, personaProposals: 1 });
    expect(t.requests.filter(isLearning)).toHaveLength(requestsBefore); // the pending retire skips the agent
    const retire = repos.proposals.list({ personaId: smb.id, status: 'pending' });
    expect(retire).toHaveLength(1);
    expect(retire[0]).toMatchObject({ action: 'retire', source: 'engine', adjustmentId: adjustment.id });
    expect(retire[0]!.evidence).toHaveLength(6);
    // Still nothing changes until the user answers.
    expect(persona().version).toBe(2);
    expect(repos.adjustments.get(adjustment.id)!.status).toBe('active');
  });
});
