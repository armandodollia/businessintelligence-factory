/**
 * Persona adjustments (design §9, §10): accepting or rejecting a proposal, retiring an adjustment,
 * the corrections section of the persona's agent.md, and the effect numbers of an adjustment.
 */
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { listFeedback } from '../../../src/core/feedback/events.js';
import { reactToVerdict } from '../../../src/core/flows/feedback.js';
import { liveVerdicts } from '../../../src/core/flows/verdicts.js';
import { versionedAgentMdPath, writeAgentMd } from '../../../src/core/market/personas.js';
import {
  acceptPersonaProposal,
  activeAdjustments,
  adjustmentEffect,
  newMarker,
  PersonaLearningError,
  rejectPersonaProposal,
  retireAdjustment,
} from '../../../src/core/personas/adjustments.js';
import { personaLearningRepos } from '../../../src/core/personas/store.js';
import type { PersonaAdjustment, PersonaProposal } from '../../../src/core/personas/types.js';
import type { Store } from '../../../src/core/store/db.js';
import { newId } from '../../../src/core/store/repos.js';
import type { Decision, Persona } from '../../../src/core/types.js';
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

const clock = (minutes: number) => vi.setSystemTime(new Date(Date.parse(T0) + minutes * 60_000));
const HEADING = '## Corrections from people who know your segment';
type Payload = Record<string, unknown>;
const STATS = { n: 8, agree: 2, disagree: 6, items: 5, lower: 0.41 };

function seed() {
  const t = flowSetup(opened);
  const smb = t.persona('smb');
  writeAgentMd(t.store, smb);
  const repos = personaLearningRepos(t.store);
  /** A pending proposal for `persona`. */
  const proposal = (persona: Persona, extra: Partial<PersonaProposal> = {}): PersonaProposal =>
    repos.proposals.insert({
      id: newId('ppr'), rootWorkspaceId: 'ws_a', workspaceId: persona.workspaceId, personaId: persona.id, action: 'add',
      field: 'buying_behavior', text: 'You compare on total yearly cost, not the monthly price.', rationale: 'r', evidence: ['fbk_1'],
      stats: STATS, source: 'retro', status: 'pending', createdAt: T0, ...extra,
    });
  const persona = () => t.store.personas.get(smb.id)!;
  const agentMd = () => readFileSync(persona().agentMdPath, 'utf8');
  const decisions = () =>
    t.store.decisions.list().filter((d) => (d.payload as Payload).tool === 'persona_learning') as Array<Decision & { payload: Payload }>;
  return { ...t, smb, repos, proposal, persona, agentMd, decisions };
}

/** Accepts an `add` proposal and returns the new adjustment. */
function added(t: ReturnType<typeof seed>, extra: Partial<PersonaProposal> = {}): PersonaAdjustment {
  return acceptPersonaProposal(t.store, 'local-user', 'ws_a', t.proposal(t.smb, extra).id).adjustment;
}

function refusal(fn: () => unknown): PersonaLearningError {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(PersonaLearningError);
    return e as PersonaLearningError;
  }
  throw new Error('expected a refusal');
}

describe('acceptPersonaProposal', () => {
  it('add: an active adjustment with a marker, persona version +1, agent.md, one event, one Decision', () => {
    const t = seed();
    const p = t.proposal(t.smb);
    clock(1);
    const out = acceptPersonaProposal(t.store, 'local-user', 'ws_a', p.id, { reason: 'right, they look at the yearly bill' });

    expect(out.adjustment).toMatchObject({
      personaId: t.smb.id, rootWorkspaceId: 'ws_a', workspaceId: 'ws_a', field: 'buying_behavior', text: p.text, version: 1,
      status: 'active', source: 'retro', proposalId: p.id, actor: 'local-user', stats: STATS, internal: false,
    });
    expect(out.adjustment.marker).toMatch(/^A-[0-9A-F]{6}$/);
    expect(out.adjustment.id).toMatch(/^pad_/);
    expect(out.persona.version).toBe(2);
    expect(t.persona().version).toBe(2);
    expect(activeAdjustments(t.store, t.smb.id).map((a) => a.id)).toEqual([out.adjustment.id]);

    const md = t.agentMd();
    expect(md).toContain('version: 2');
    expect(md).toContain(`- [${out.adjustment.marker}.v1] (buying_behavior) ${p.text}`);
    expect(readFileSync(versionedAgentMdPath(t.smb.agentMdPath, 2), 'utf8')).toBe(md);

    const events = listFeedback(t.store, { workspaceId: 'ws_a', kind: 'persona_learning_accept' });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ targetType: 'persona_proposal', targetId: p.id, actor: 'local-user', reason: 'right, they look at the yearly bill' });

    const ds = t.decisions();
    expect(ds).toHaveLength(1);
    expect(ds[0]).toMatchObject({
      kind: 'decision', agentRunId: 'local-user',
      payload: { tool: 'persona_learning', actor: 'user', actorId: 'local-user', action: 'add', personaId: t.smb.id, proposalId: p.id, adjustmentId: out.adjustment.id, personaVersion: 2 },
    });

    expect(out.proposal).toMatchObject({
      status: 'accepted', actor: 'local-user', reason: 'right, they look at the yearly bill', decisionId: ds[0]!.id, feedbackEventId: events[0]!.id,
      decidedAt: new Date(Date.parse(T0) + 60_000).toISOString(),
    });
    expect(out.proposal.finalText).toBeUndefined();
  });

  it('edited text is stored as finalText and used, cut at 400 characters; blank text is refused', () => {
    const t = seed();
    const p = t.proposal(t.smb);
    const out = acceptPersonaProposal(t.store, 'local-user', 'ws_a', p.id, { text: '  You add up the yearly bill, setup fees included.  ' });
    expect(out.proposal.finalText).toBe('You add up the yearly bill, setup fees included.');
    expect(out.adjustment.text).toBe('You add up the yearly bill, setup fees included.');
    expect(t.agentMd()).toContain('You add up the yearly bill, setup fees included.');
    expect(t.agentMd()).not.toContain(p.text);

    const long = acceptPersonaProposal(t.store, 'local-user', 'ws_a', t.proposal(t.smb).id, { text: 'x'.repeat(500) });
    expect(long.adjustment.text).toBe(`${'x'.repeat(399)}…`); // 400 characters, the ellipsis included
    const exact = acceptPersonaProposal(t.store, 'local-user', 'ws_a', t.proposal(t.smb).id, { text: 'y'.repeat(400) });
    expect(exact.adjustment.text).toBe('y'.repeat(400));

    const same = acceptPersonaProposal(t.store, 'local-user', 'ws_a', t.proposal(t.smb).id, { text: p.text });
    expect(same.proposal.finalText).toBeUndefined();

    expect(refusal(() => acceptPersonaProposal(t.store, 'local-user', 'ws_a', t.proposal(t.smb).id, { text: '   ' })).status).toBe(400);
  });

  it('add: the adjustment records the persona version it created', () => {
    const t = seed();
    const out = acceptPersonaProposal(t.store, 'local-user', 'ws_a', t.proposal(t.smb).id);
    expect(out.adjustment.personaVersion).toBe(2);
    expect(t.repos.adjustments.get(out.adjustment.id)!.personaVersion).toBe(2);
  });

  it('replace: changes the text, bumps the adjustment version, the marker reads .v2', () => {
    const t = seed();
    const a = added(t);
    clock(1);
    const REPLACED = { n: 10, agree: 3, disagree: 7, items: 6, lower: 0.4 };
    const out = acceptPersonaProposal(t.store, 'local-user', 'ws_a', t.proposal(t.smb, { action: 'replace', adjustmentId: a.id, text: 'You compare on cost over three years.', stats: REPLACED }).id);
    expect(out.adjustment).toMatchObject({ id: a.id, marker: a.marker, version: 2, status: 'active', text: 'You compare on cost over three years.' });
    expect(out.persona.version).toBe(3);
    // The rate the engine compares against is the one when it was replaced; the persona version it made.
    expect(out.adjustment.stats).toEqual(REPLACED);
    expect(out.adjustment.personaVersion).toBe(3);
    expect(t.repos.adjustments.get(a.id)).toMatchObject({ stats: REPLACED, personaVersion: 3 });
    const md = t.agentMd();
    expect(md).toContain(`- [${a.marker}.v2] (buying_behavior) You compare on cost over three years.`);
    expect(md).not.toContain(`${a.marker}.v1`);
    expect(t.decisions().map((d) => d.payload.action)).toEqual(['add', 'replace']);
  });

  it('retire: ends the adjustment and removes it from agent.md', () => {
    const t = seed();
    const a = added(t);
    clock(1);
    const out = acceptPersonaProposal(t.store, 'local-user', 'ws_a', t.proposal(t.smb, { action: 'retire', adjustmentId: a.id }).id);
    expect(out.adjustment).toMatchObject({ id: a.id, status: 'retired', endedAt: new Date(Date.parse(T0) + 60_000).toISOString() });
    expect(out.persona.version).toBe(3);
    expect(activeAdjustments(t.store, t.smb.id)).toEqual([]);
    expect(t.agentMd()).not.toContain(HEADING);
    expect(t.agentMd()).not.toContain(a.marker);
  });

  it('a replace or retire of an adjustment that is not active is refused (409) and the proposal is superseded', () => {
    const t = seed();
    const a = added(t);
    const retire = t.proposal(t.smb, { action: 'retire', adjustmentId: a.id });
    const replace = t.proposal(t.smb, { action: 'replace', adjustmentId: a.id, text: 'new' });
    acceptPersonaProposal(t.store, 'local-user', 'ws_a', retire.id);
    expect(refusal(() => acceptPersonaProposal(t.store, 'local-user', 'ws_a', replace.id)).status).toBe(409);
    expect(t.repos.proposals.get(replace.id)!.status).toBe('superseded');
    expect(t.persona().version).toBe(3);
  });

  it('an accepted retire or replace supersedes every other pending proposal of that adjustment, in the same transaction', () => {
    const t = seed();
    const a = added(t);
    const other = added(t, { text: 'You never buy on a first call.' });
    const replace = t.proposal(t.smb, { action: 'replace', adjustmentId: a.id, text: 'You compare on cost over three years.' });
    const engineRetire = t.proposal(t.smb, { action: 'retire', adjustmentId: a.id, source: 'engine' });
    const untouched = t.proposal(t.smb, { action: 'retire', adjustmentId: other.id });
    const fresh = t.proposal(t.smb);
    clock(1);
    acceptPersonaProposal(t.store, 'local-user', 'ws_a', replace.id);
    expect(t.repos.proposals.get(engineRetire.id)).toMatchObject({ status: 'superseded', decidedAt: new Date(Date.parse(T0) + 60_000).toISOString() });
    expect(t.repos.proposals.get(replace.id)!.status).toBe('accepted');
    expect(t.repos.proposals.get(untouched.id)!.status).toBe('pending');
    expect(t.repos.proposals.get(fresh.id)!.status).toBe('pending');

    const retire = t.proposal(t.smb, { action: 'retire', adjustmentId: other.id, source: 'engine' });
    acceptPersonaProposal(t.store, 'local-user', 'ws_a', retire.id);
    expect(t.repos.proposals.get(untouched.id)!.status).toBe('superseded');
    expect(t.repos.proposals.list({ personaId: t.smb.id, status: 'pending' }).map((p) => p.id)).toEqual([fresh.id]);
  });

  it('a second accept is refused (409) and the persona version stays', () => {
    const t = seed();
    const p = t.proposal(t.smb);
    acceptPersonaProposal(t.store, 'local-user', 'ws_a', p.id);
    expect(refusal(() => acceptPersonaProposal(t.store, 'local-user', 'ws_a', p.id)).status).toBe(409);
    expect(t.persona().version).toBe(2);
    expect(activeAdjustments(t.store, t.smb.id)).toHaveLength(1);
    expect(t.decisions()).toHaveLength(1);
  });

  it('an add beyond maxAdjustments active adjustments is refused (409)', () => {
    const t = seed();
    added(t);
    added(t);
    const third = t.proposal(t.smb);
    expect(refusal(() => acceptPersonaProposal(t.store, 'local-user', 'ws_a', third.id, { maxAdjustments: 2 })).status).toBe(409);
    expect(t.repos.proposals.get(third.id)!.status).toBe('pending');
    expect(t.persona().version).toBe(3);
  });

  it('a proposal of another tree is refused like an unknown one (404)', () => {
    const t = seed();
    t.otherTree();
    const p = t.proposal(t.smb);
    expect(refusal(() => acceptPersonaProposal(t.store, 'local-user', 'ws_b', p.id)).status).toBe(404);
    expect(refusal(() => acceptPersonaProposal(t.store, 'local-user', 'ws_a', 'ppr_missing')).status).toBe(404);
    expect(refusal(() => rejectPersonaProposal(t.store, 'local-user', 'ws_b', p.id)).status).toBe(404);
    expect(t.repos.proposals.get(p.id)!.status).toBe('pending');
    expect(t.persona().version).toBe(1);
  });

  it('the persona’s live flow verdicts stop being live after an accept', () => {
    const t = seed();
    const v = t.verdict(t.store.personas.get(t.smb.id)!, t.flow('Globex'), t.flow('Initech'));
    expect(liveVerdicts(t.store, 'ws_a', t.typeId).map((x) => x.id)).toEqual([v.id]);
    added(t);
    expect(liveVerdicts(t.store, 'ws_a', t.typeId)).toEqual([]);
  });
});

describe('rejectPersonaProposal', () => {
  it('changes nothing but the proposal; writes persona_learning_reject and one Decision', () => {
    const t = seed();
    const p = t.proposal(t.smb);
    const before = t.agentMd();
    const out = rejectPersonaProposal(t.store, 'local-user', 'ws_a', p.id, { reason: 'they do look at the monthly price' });
    expect(out).toMatchObject({ status: 'rejected', actor: 'local-user', reason: 'they do look at the monthly price', decidedAt: T0 });
    const events = listFeedback(t.store, { workspaceId: 'ws_a', kind: 'persona_learning_reject' });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ targetType: 'persona_proposal', targetId: p.id, reason: 'they do look at the monthly price' });
    expect(out.feedbackEventId).toBe(events[0]!.id);
    const ds = t.decisions();
    expect(ds).toHaveLength(1);
    expect(ds[0]).toMatchObject({
      kind: 'decision', agentRunId: 'local-user',
      payload: { tool: 'persona_learning', actor: 'user', actorId: 'local-user', action: 'reject', personaId: t.smb.id, proposalId: p.id, proposalAction: 'add' },
    });
    expect(out.decisionId).toBe(ds[0]!.id);
    expect(events[0]!.afterJson).toMatchObject({ decisionId: ds[0]!.id });
    expect(t.persona().version).toBe(1);
    expect(t.repos.adjustments.list()).toEqual([]);
    expect(t.agentMd()).toBe(before);
    expect(refusal(() => rejectPersonaProposal(t.store, 'local-user', 'ws_a', p.id)).status).toBe(409);
  });
});

describe('retireAdjustment', () => {
  it('ends an active adjustment directly: persona version +1, agent.md, one event, one Decision', () => {
    const t = seed();
    const a = added(t);
    const kept = added(t, { field: undefined, text: 'You never buy on a first call.' });
    clock(1);
    const out = retireAdjustment(t.store, 'local-user', 'ws_a', a.id, { reason: 'no longer true' });
    expect(out.adjustment).toMatchObject({ id: a.id, status: 'retired' });
    expect(out.persona.version).toBe(4);
    expect(activeAdjustments(t.store, t.smb.id).map((x) => x.id)).toEqual([kept.id]);
    const md = t.agentMd();
    expect(md).not.toContain(a.marker);
    expect(md).toContain(`- [${kept.marker}.v1] You never buy on a first call.`);
    const events = listFeedback(t.store, { workspaceId: 'ws_a', kind: 'persona_adjustment_retire' });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ targetType: 'persona_adjustment', targetId: a.id, reason: 'no longer true' });
    expect(t.decisions().at(-1)!.payload).toMatchObject({ tool: 'persona_learning', action: 'retire', adjustmentId: a.id, personaVersion: 4 });
    expect(t.decisions().at(-1)!.payload.proposalId).toBeUndefined();

    expect(refusal(() => retireAdjustment(t.store, 'local-user', 'ws_a', a.id)).status).toBe(409);
    t.otherTree();
    expect(refusal(() => retireAdjustment(t.store, 'local-user', 'ws_b', kept.id)).status).toBe(404);
  });
});

describe('retireAdjustment and pending proposals', () => {
  it('an engine retire pending for the adjustment is superseded when the user retires it from the card', () => {
    const t = seed();
    const a = added(t);
    const engine = t.proposal(t.smb, { action: 'retire', adjustmentId: a.id, source: 'engine' });
    const replace = t.proposal(t.smb, { action: 'replace', adjustmentId: a.id, text: 'You compare on cost over three years.' });
    clock(1);
    retireAdjustment(t.store, 'local-user', 'ws_a', a.id);
    for (const p of [engine, replace]) {
      expect(t.repos.proposals.get(p.id)).toMatchObject({ status: 'superseded', decidedAt: new Date(Date.parse(T0) + 60_000).toISOString() });
    }
    expect(t.repos.proposals.list({ rootWorkspaceId: 'ws_a', status: 'pending' })).toEqual([]);
  });
});

describe('newMarker and adjustmentEffect', () => {
  it('newMarker retries on a marker already taken', () => {
    const t = seed();
    const a = added(t);
    const bytes = (hex: string) => Buffer.from(hex, 'hex');
    const taken = a.marker.slice(2);
    let calls = 0;
    const out = newMarker(t.store, () => bytes(calls++ === 0 ? taken : 'ABCDEF'));
    expect(out).toBe('A-ABCDEF');
    expect(calls).toBe(2);
  });

  it('since: the gate numbers of signals after the adjustment changed; before: its stats', () => {
    const t = seed();
    const smb = t.persona();
    const v1 = t.verdict(smb, t.flow('Globex'), t.flow('Initech'));
    clock(1);
    reactToVerdict(t.store, 'local-user', v1.id, 'disagree');
    clock(2);
    const a = added(t);
    const v2 = t.verdict(t.persona(), t.flow('Hooli'), t.flow('Umbrella'));
    clock(3);
    reactToVerdict(t.store, 'local-user', v2.id, 'agree');
    const effect = adjustmentEffect(t.store, a);
    expect(effect.before).toEqual(STATS);
    expect(effect.since).toMatchObject({ n: 1, agree: 1, disagree: 0, items: 1 });
  });

  it('since: a reaction made after the adjustment to a verdict of an older persona version does not count', () => {
    const t = seed();
    const old = t.verdict(t.persona(), t.flow('Globex'), t.flow('Initech')); // persona version 1
    clock(1);
    const a = added(t); // persona version 2
    const fresh = t.verdict(t.persona(), t.flow('Hooli'), t.flow('Umbrella'));
    clock(2);
    reactToVerdict(t.store, 'local-user', old.id, 'disagree');
    expect(adjustmentEffect(t.store, a).since).toMatchObject({ n: 0 });
    clock(3);
    reactToVerdict(t.store, 'local-user', fresh.id, 'disagree');
    expect(adjustmentEffect(t.store, a).since).toMatchObject({ n: 1, disagree: 1 });
  });
});
