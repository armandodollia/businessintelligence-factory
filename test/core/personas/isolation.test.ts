/**
 * Persona learning across business trees (design §2 anti-goals, §15): two trees, each with a persona of
 * the same slug and the same reactions. Signals, the gate, learning runs (and what their prompts show),
 * proposals and the routes of one tree never return the other's rows.
 */
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../../src/api/routes.js';
import { reactToVerdict } from '../../../src/core/flows/feedback.js';
import type { Flow } from '../../../src/core/flows/types.js';
import type { FakeScript } from '../../../src/core/harness/adapter.js';
import { writeAgentMd } from '../../../src/core/market/personas.js';
import { personaGate } from '../../../src/core/personas/gate.js';
import { personaLearningToolHandlers, runPersonaLearning } from '../../../src/core/personas/learn.js';
import { personaLearningSettings } from '../../../src/core/personas/settings.js';
import { collectPersonaSignals, openSignals } from '../../../src/core/personas/signals.js';
import { personaLearningRepos } from '../../../src/core/personas/store.js';
import type { AgentRequest } from '../../../src/core/research/deps.js';
import type { Store } from '../../../src/core/store/db.js';
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
const later = () => new Date(Date.parse(T0) + (minute + 1) * 60_000);
const isLearning = (req: AgentRequest) => req.role === 'retro' && req.prompt.startsWith('# Persona learning');
const personaOf = (prompt: string) => /persona_id `(\w+)`/.exec(prompt)![1]!;

function setup() {
  const t = flowSetup(opened, (c) => (c.user = { id: 'ana@acme' }), () => personaLearningToolHandlers());
  t.otherTree();
  const a = t.persona('smb'); // tree A (ws_a)
  const b = t.store.personas.insert({ ...a, id: 'per_smb_beta', workspaceId: 'ws_b', agentMdPath: join(t.dir, 'personas', 'beta', 'smb.md') }); // tree B, same slug
  writeAgentMd(t.store, a);
  writeAgentMd(t.store, b);
  /** Six reactions (5 disagree) on six pairs of the tree's flows, with a reason naming the tree. */
  const react = (p: Persona, names: string[]) => {
    const flows: Flow[] = names.map((n) => t.flow(n, p.workspaceId));
    const pairs: Array<[number, number]> = [[0, 1], [0, 2], [0, 3], [1, 2], [1, 3], [2, 3]];
    pairs.forEach(([x, y], i) => {
      tick();
      const v = t.verdict(p, flows[x]!, flows[y]!);
      tick();
      reactToVerdict(t.store, 'ana@acme', v.id, i === 0 ? 'agree' : 'disagree', `reason of ${p.workspaceId}`);
    });
  };
  react(a, ['Acme', 'Globex', 'Initech', 'Hooli']);
  react(b, ['Beta', 'Umbrella', 'Wonka', 'Stark']);
  const app = createApp({ store: t.store, artifacts: t.artifacts, events: t.events, config: t.config, research: t.deps });
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await app.request(path, { method, headers: { 'content-type': 'application/json' }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    const text = await res.text();
    return { status: res.status, body: text ? (JSON.parse(text) as any) : undefined };
  };
  // Each learning run proposes one add from three of the disagreements it was shown.
  t.state.pick = (req): FakeScript | undefined =>
    isLearning(req)
      ? async (tc) => {
          const id = personaOf(req.prompt);
          const seen = new Set<string>();
          const evidence = collectPersonaSignals(t.store, id)
            .filter((s) => s.polarity === 'disagree' && !seen.has(s.itemKey) && seen.add(s.itemKey))
            .slice(0, 3)
            .map((s) => s.id);
          await tc.call('submit_persona_learning', {
            persona_id: id, assumption: 'Reads the monthly price.',
            proposals: [{ action: 'add', field: 'buying_behavior', text: 'You compare on total yearly cost.', why: 'w', evidence }],
          });
        }
      : undefined;
  return { ...t, a, b, call, repos: personaLearningRepos(t.store) };
}

describe('persona learning: no rows cross business trees', () => {
  it('signals and the gate of a persona are its own tree\'s only', () => {
    const t = setup();
    const sa = collectPersonaSignals(t.store, t.a.id);
    const sb = collectPersonaSignals(t.store, t.b.id);
    expect(sa).toHaveLength(6);
    expect(sb).toHaveLength(6);
    expect(sa.filter((s) => sb.some((x) => x.id === s.id))).toEqual([]);
    expect(sa.every((s) => s.personaId === t.a.id && s.reason === 'reason of ws_a')).toBe(true);
    expect(sb.every((s) => s.personaId === t.b.id && s.reason === 'reason of ws_b')).toBe(true);
    const settings = personaLearningSettings(t.config);
    const gate = personaGate(openSignals(t.store, settings, t.a.id, later()), settings);
    expect(gate).toMatchObject({ n: 6, disagree: 5, items: 6, qualifies: true });
  });

  it('a learning run of one tree evaluates, shows and proposes for its own personas only', async () => {
    const t = setup();
    const report = await runPersonaLearning(t.deps, 'ws_a', { now: later() });
    expect(report).toMatchObject({ personasEvaluated: 1, personaLearningRuns: 1, personaProposals: 1 });
    const prompts = t.requests.filter(isLearning).map((r) => r.prompt);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain(t.a.id);
    expect(prompts[0]).not.toContain(t.b.id);
    expect(prompts[0]).not.toContain('reason of ws_b');
    for (const s of collectPersonaSignals(t.store, t.b.id)) expect(prompts[0]).not.toContain(s.id);
    expect(t.repos.runs.list().map((r) => [r.rootWorkspaceId, r.personaId])).toEqual([['ws_a', t.a.id]]);
    expect(t.repos.proposals.list().map((p) => [p.rootWorkspaceId, p.personaId])).toEqual([['ws_a', t.a.id]]);
    // Tree B's signals are still open: tree A's run consumed nothing of B.
    expect(openSignals(t.store, personaLearningSettings(t.config), t.b.id, later())).toHaveLength(6);
  });

  it('the routes of one tree never serve or act on the other tree\'s rows', async () => {
    const t = setup();
    await runPersonaLearning(t.deps, 'ws_a', { now: later() });
    await runPersonaLearning(t.deps, 'ws_b', { now: later() });
    const [pA] = t.repos.proposals.list({ personaId: t.a.id });
    const [pB] = t.repos.proposals.list({ personaId: t.b.id });

    const viewA = (await t.call('GET', '/api/workspaces/ws_a/persona-learning')).body;
    expect(viewA.personas.map((p: any) => p.personaId)).toEqual([t.a.id]);
    expect(viewA.personas[0].proposals.map((p: any) => p.id)).toEqual([pA!.id]);
    expect(viewA.pendingInTree).toBe(1);
    expect(JSON.stringify(viewA)).not.toContain(t.b.id);

    const signalsA = (await t.call('GET', `/api/workspaces/ws_a/personas/${t.a.id}/signals`)).body.signals as Array<{ personaId: string }>;
    expect(signalsA.every((s) => s.personaId === t.a.id)).toBe(true);
    expect((await t.call('GET', `/api/workspaces/ws_a/personas/${t.b.id}/signals`)).status).toBe(404);
    expect((await t.call('POST', `/api/workspaces/ws_a/persona-proposals/${pB!.id}/accept`, {})).status).toBe(404);
    expect((await t.call('POST', `/api/workspaces/ws_a/persona-proposals/${pB!.id}/reject`, {})).status).toBe(404);
    expect(t.repos.proposals.get(pB!.id)!.status).toBe('pending');

    const accepted = await t.call('POST', `/api/workspaces/ws_b/persona-proposals/${pB!.id}/accept`, {});
    expect(accepted.status).toBe(200);
    expect((await t.call('POST', `/api/workspaces/ws_a/persona-adjustments/${accepted.body.adjustment.id}/retire`, {})).status).toBe(404);
    expect(t.store.personas.get(t.a.id)!.version).toBe(1);
    expect(t.repos.adjustments.list({ personaId: t.a.id })).toEqual([]);
  });
});
