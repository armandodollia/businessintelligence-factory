/**
 * Fixture of the follow-research and combine tests (stakeholder positions, task 2): a node with one
 * competitor and four stakeholder personas — `own` (Head of finance), `gone` (Head of sales, left for
 * Rival Pay), `parked` (Head of legal, left for a law firm) and `rival` (the CEO of Rival Pay, who never
 * worked here) — the tool dispatcher with every handler these runs call, and helpers to save a public
 * layer through `save_stakeholder`.
 *
 * The clock is fixed at `T0` (callers install fake timers for `Date`); `tick()` moves it one minute on.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { vi } from 'vitest';
import type { BifConfig } from '../../../src/core/config/schema.js';
import { agentMdPath, writeAgentMd } from '../../../src/core/market/personas.js';
import { researchToolHandlers } from '../../../src/core/research/tools.js';
import { STAKEHOLDER_FIELDS } from '../../../src/core/scoring/criteria.js';
import { submitCombinedProfileHandler } from '../../../src/core/stakeholders/combine.js';
import { stakeholderSlug, stakeholderToolHandlers } from '../../../src/core/stakeholders/personas.js';
import { markLeft, type PositionDeps } from '../../../src/core/stakeholders/positions.js';
import type { Store } from '../../../src/core/store/db.js';
import { newId } from '../../../src/core/store/repos.js';
import type { Persona, PersonaProfileField, Task } from '../../../src/core/types.js';
import { addTask, researchSetup } from '../helpers/research.js';

export const T0 = '2026-11-15T10:00:00.000Z';
export const ACTOR = 'tester';
export const LEFT = '2026-10-31';
export const CODEX = { provider: 'codex' as const, model: 'gpt-6.1-sol' };

/** The default config with Claude and OpenCode disabled: no enabled provider can run offline. */
export const codexOnly = (c: BifConfig) => {
  c.providers.claude = { ...c.providers.claude, enabled: false };
  c.providers.opencode = { ...c.providers.opencode, enabled: false };
};

let minute = 0;
/** Sets the fixed clock back to `T0` (call in `beforeEach`, after installing fake timers). */
export const resetClock = () => {
  minute = 0;
  vi.setSystemTime(new Date(T0));
};
/** Moves the clock one minute on and returns the new time. */
export const tick = (): string => {
  vi.setSystemTime(new Date(Date.parse(T0) + ++minute * 60_000));
  return new Date().toISOString();
};

/** A stored profile: every field `<mark> <field> of <label>`, resting on `evidence`. */
export const profileOf = (label: string, evidence: string[] = [], mark = 'INTERNALMARK'): Record<string, PersonaProfileField> =>
  Object.fromEntries(STAKEHOLDER_FIELDS.map((f) => [f, { value: `${mark} ${f} of ${label}`, confidence: 0.6, evidence }]));

export function followSetup(opened: Store[], configure?: (c: BifConfig) => void) {
  const dir = mkdtempSync(join(tmpdir(), 'bif-stk-follow-'));
  const t = researchSetup(opened, {
    dir,
    extraHandlers: () => ({ ...researchToolHandlers(), ...stakeholderToolHandlers({ dataDir: dir }), submit_combined_profile: submitCombinedProfileHandler }),
    ...(configure ? { config: configure } : {}),
  });
  t.store.workspaces.insert({ id: 'ws_a', name: 'Acme', sector: 'saas', createdAt: T0, scope: { level: 'division', name: 'Acme Payments', description: 'payments' } });
  t.store.workspaces.insert({ id: 'ws_b', name: 'Acme Cards', sector: 'saas', createdAt: T0, parentWorkspaceId: 'ws_a' });
  t.store.workspaces.insert({ id: 'ws_other', name: 'Other', sector: 'saas', createdAt: T0 });
  t.store.competitors.insert({
    id: 'cmp_rival', workspaceId: 'ws_a', name: 'Rival Pay', threat: 4, directness: 5, comparison: { pricing: 3, onboarding: 3, ux: 3, features: 3 }, evidence: [],
    createdAt: T0, updatedAt: T0, status: 'verified',
  });
  const pos: PositionDeps = { store: t.store, dataDir: dir };
  /** A stored text artifact of `workspaceId`; `kind: 'upload'` makes it an internal upload. */
  const art = (text: string, workspaceId = 'ws_a', kind: 'text' | 'upload' = 'text'): string =>
    t.artifacts.save({ workspaceId, kind, mime: 'text/plain', bytes: text }).id;
  const internalArt = art('What we knew from inside');
  /** An open, verified own stakeholder with a full profile and its agent.md on disk. */
  const stakeholder = (label: string, extra: Partial<Persona> = {}, workspaceId = 'ws_a'): Persona => {
    const slug = extra.slug ?? stakeholderSlug(label);
    const p = t.store.personas.insert({
      id: newId('per'), workspaceId, slug, segment: label, profile: profileOf(label, [internalArt]), version: 1, status: 'verified',
      agentMdPath: agentMdPath(dir, workspaceId, slug), kind: 'stakeholder', stakeholderType: 'leader', subjectKind: 'own', relation: `RELATIONMARK of ${label}`,
      disclosure: 'open', ...extra,
    });
    writeAgentMd(t.store, p);
    return t.store.personas.get(p.id)!;
  };
  /** A former colleague: an own stakeholder that left, for Rival Pay or (`to: 'elsewhere'`) a company that is no competitor. */
  const former = (label: string, to: 'rival' | 'elsewhere' = 'rival', workspaceId = 'ws_a'): Persona =>
    markLeft(pos, ACTOR, workspaceId, stakeholder(label, {}, workspaceId).id, { date: LEFT, to: to === 'rival' ? { competitorId: 'cmp_rival' } : { elsewhere: {} } });
  const own = stakeholder('Head of finance');
  const gone = markLeft(pos, ACTOR, 'ws_a', stakeholder('Head of sales', { positionTitle: 'Head of Sales EMEA' }).id, {
    date: LEFT, to: { competitorId: 'cmp_rival' }, title: 'VP Sales',
  });
  const parked = markLeft(pos, ACTOR, 'ws_a', stakeholder('Head of legal').id, { date: LEFT, to: { elsewhere: { companyName: 'A law firm' } } });
  const rival = stakeholder('Chief executive', { slug: 'stk-rival-pay-chief-executive', subjectKind: 'competitor', subjectId: 'cmp_rival' });

  const task = (type: Task['type'] = 'competitor_stakeholders', extra: Partial<Task> = {}): Task =>
    addTask(t.store, { phase: 'stakeholders', type, brief: `do ${type} ${newId('b')}`, subject: undefined, status: 'verified', ...extra });
  const ctx = (of: Task, role: 'worker' | 'reviewer' | 'retro' = 'worker') => ({
    agentRunId: newId('arun'), workspaceId: of.workspaceId, role, model: { provider: 'claude' as const, model: 'sonnet' }, promptVersion: 'pv', taskId: of.id,
  });
  /** The `profile` input of `save_stakeholder`: every field `PUBLICMARK <field> of <label>`, citing `evidence`. */
  const publicInput = (label: string, evidence: string[]) =>
    Object.fromEntries(STAKEHOLDER_FIELDS.map((f) => [f, { value: `PUBLICMARK ${f} of ${label}`, confidence: 0.4, evidence }]));
  /** A `save_stakeholder` call with `follow` by a worker run of `of`. */
  const follow = (of: Task, personaId: string, extra: Record<string, unknown> = {}) =>
    t.handle(ctx(of), 'save_stakeholder', {
      label: 'ignored label', stakeholder_type: 'other', subject: 'follow', relation: 'ignored relation', follow: personaId,
      profile: publicInput(t.store.personas.get(personaId)?.segment ?? 'nobody', [art(`Public page about ${personaId} ${newId('p')}`, of.workspaceId)]), ...extra,
    });
  const harnessEvents = (event: string) =>
    t.store.decisions.list({}).filter((d) => (d.payload as { tool?: string; event?: string }).tool === 'harness' && (d.payload as { event?: string }).event === event);
  return { ...t, pos, art, internalArt, stakeholder, former, own, gone, parked, rival, task, ctx, publicInput, follow, harnessEvents };
}

export type FollowSetup = ReturnType<typeof followSetup>;
