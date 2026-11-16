import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect } from 'vitest';
import type { BifConfig } from '../../../src/core/config/schema.js';
import type { FakeScript } from '../../../src/core/harness/adapter.js';
import type { RunContext } from '../../../src/core/harness/tokens.js';
import { marketToolHandlers } from '../../../src/core/market/personas.js';
import type { AgentRequest } from '../../../src/core/research/deps.js';
import { PERSONA_FIELDS } from '../../../src/core/scoring/criteria.js';
import type { Store } from '../../../src/core/store/db.js';
import { newId } from '../../../src/core/store/repos.js';
import type { ModelRef, Persona, Recommendation } from '../../../src/core/types.js';
import { researchSetup } from '../helpers/research.js';

/** Fixture of the baseline and rounds tests: three personas, two recommendations, fake persona runs. */

export const SONNET = { provider: 'claude', model: 'sonnet' } as const;
export const CODEX = { provider: 'codex', model: 'gpt-6.1-sol', effort: 'medium' } as const;
export const OPENCODE = { provider: 'opencode', model: 'big-pickle' } as const;

/** The slugs of the three personas, in the order they take seats: with two seats 0, 1, 0. */
export const FIELD = 'field-user';
export const OPS = 'payments-ops-analyst';
export const SMB = 'smb-finance-lead';
/** Who a run with no persona is, in `whoOf`. */
export const BASELINE = 'baseline';

export const ctx = (extra: Partial<RunContext> = {}): RunContext => ({
  agentRunId: newId('arun'), workspaceId: 'ws_a', role: 'worker', model: { provider: 'claude', model: 'sonnet' }, promptVersion: 'pv', ...extra,
});

export function rec(id: string): Recommendation {
  return {
    id, workspaceId: 'ws_a', title: `Rec ${id}`, summary: `Do ${id}`, criteria: { upside: 4 }, findingIds: [],
    personaFeedback: [], priority: 0, createdAt: new Date().toISOString(), status: 'verified',
  };
}

export const recIdOf = (req: AgentRequest) => /Recommendation id: (\S+)/.exec(req.prompt)![1]!;
/** The persona of a run by the `name:` line of its agent.md; a run with no persona is the baseline. */
export const whoOf = (req: AgentRequest) => /^name: (\S+)$/m.exec(req.systemPrompt)?.[1] ?? BASELINE;
export const modelOf = (req: AgentRequest) => (req as AgentRequest & { model: ModelRef }).model;

/** What `who` sends about `recId` unless a test says otherwise: texts that name their author. */
export const answer = (who: string, recId: string, extra: Record<string, unknown> = {}) => ({
  recommendation_id: recId,
  scores: { appeal: 4, adoption: 3, willingness_to_pay: 2, friction: 4 },
  concerns: [`concern of ${who} about ${recId}`],
  reasoning: `reasoning of ${who} about ${recId}`,
  would_change_mind: 'a free tier',
  ...extra,
});

/** What a run does: nothing said (the default answer), fields over the default answer, or a script of its own. */
export type Reply = (who: string, recId: string, req: AgentRequest) => Record<string, unknown> | FakeScript | undefined;

/** A run that ends without calling the tool. */
export const silent: FakeScript = async () => {};

export async function panelFixture(opened: Store[], config?: (c: BifConfig) => void) {
  const dir = mkdtempSync(join(tmpdir(), 'bif-panel-rounds-'));
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

  const state: { reply: Reply } = { reply: () => undefined };
  t.state.pick = (req) => {
    if (req.role !== 'persona') return undefined;
    const who = whoOf(req);
    const recId = recIdOf(req);
    const said = state.reply(who, recId, req);
    if (typeof said === 'function') return said;
    return async (tools) => void (await tools.call('submit_persona_feedback', answer(who, recId, said)));
  };

  const persona = (slug: string): Persona => t.store.personas.list({ workspaceId: 'ws_a' }).find((p) => p.slug === slug)!;
  return {
    ...t,
    /** Says what the runs do from now on. */
    replies: (reply: Reply) => void (state.reply = reply),
    persona,
    feedback: (recId: string, slug: string) => t.store.recommendations.get(recId)!.personaFeedback.find((f) => f.personaId === persona(slug).id),
    /** The panel runs so far (`who`: of one persona, or of the baseline). */
    runs: (who?: string) => t.requests.filter((r) => r.role === 'persona' && (who === undefined || whoOf(r) === who)),
    /** Forgets the runs so far. */
    forgetRuns: () => void (t.requests.length = 0),
    /** Changes the text of a recommendation. */
    edit: (recId: string, summary: string) => void t.store.recommendations.update(recId, { summary }),
    /** The harness Decisions of one event. */
    recorded: (event: string) =>
      t.store.decisions.list({ workspaceId: 'ws_a' }).filter((d) => (d.payload as { event?: string } | null)?.event === event),
  };
}
