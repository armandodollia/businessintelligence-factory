/**
 * User persona, task 1 (design 2026-11-15-user-persona-design.md §5, §9, §16): the persona row (one per
 * person per business tree), its lines and the brief; it is never a segment or stakeholder persona.
 */
import { createHash } from 'node:crypto';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_ACTOR } from '../../../src/core/feedback/events.js';
import { usablePersonaIds } from '../../../src/core/flows/rankings.js';
import { backfillKnowledge } from '../../../src/core/knowledge/backfill.js';
import { runPersonaPanel } from '../../../src/core/market/panel.js';
import { writeAgentMd } from '../../../src/core/market/personas.js';
import { acceptPersonaProposal } from '../../../src/core/personas/adjustments.js';
import { runPersonaLearning } from '../../../src/core/personas/learn.js';
import { personaLearningRepos } from '../../../src/core/personas/store.js';
import type { PersonaAdjustment } from '../../../src/core/personas/types.js';
import { segmentPersonas, stakeholderPersonas } from '../../../src/core/stakeholders/personas.js';
import type { Store } from '../../../src/core/store/db.js';
import { ensureUserPersona, userBrief, userLines, userPersonaOf } from '../../../src/core/userPersona/persona.js';
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

const OTHER = 'second-person';
const hash8 = (actor: string) => createHash('sha256').update(actor).digest('hex').slice(0, 8);

function seed() {
  const t = flowSetup(opened);
  t.store.workspaces.insert({ id: 'ws_a1', name: 'Acme Payments', sector: 'saas', parentWorkspaceId: 'ws_a', createdAt: T0 });
  return t;
}

let n = 0;
function line(store: Store, personaId: string, field: string | undefined, text: string, extra: Partial<PersonaAdjustment> = {}): PersonaAdjustment {
  n++;
  const at = new Date(Date.parse(T0) + n * 60_000).toISOString();
  return personaLearningRepos(store).adjustments.insert({
    id: `pad_${n}`, rootWorkspaceId: 'ws_a', workspaceId: 'ws_a', personaId, ...(field ? { field } : {}), marker: `A-${String(n).padStart(6, '0')}`,
    text, version: 1, status: 'active', source: 'retro', actor: DEFAULT_ACTOR, stats: {}, internal: false, createdAt: at, changedAt: at, ...extra,
  });
}

describe('ensureUserPersona and userPersonaOf', () => {
  it('creates one row per tree and person, at the root, keyed by the actor', () => {
    const t = seed();
    const p = ensureUserPersona(t.store, 'ws_a', DEFAULT_ACTOR);
    expect(p).toMatchObject({
      workspaceId: 'ws_a', kind: 'user', subjectId: DEFAULT_ACTOR, slug: `user-${hash8(DEFAULT_ACTOR)}`, segment: 'The person you work for',
      profile: {}, status: 'verified', disclosure: 'open', version: 1,
    });
    expect(p.subjectKind).toBeUndefined();
    expect(ensureUserPersona(t.store, 'ws_a', DEFAULT_ACTOR).id).toBe(p.id);
    expect(ensureUserPersona(t.store, 'ws_a1', DEFAULT_ACTOR).id).toBe(p.id); // a child node lands on the root's row
    expect(t.store.personas.list({ kind: 'user' })).toHaveLength(1);
  });

  it('the actor id is never in the slug or the label', () => {
    const t = seed();
    const actor = 'someone.special+tag';
    const p = ensureUserPersona(t.store, 'ws_a', actor);
    expect(p.slug).toBe(`user-${hash8(actor)}`);
    expect(p.slug).not.toContain('someone');
    expect(p.segment).not.toContain('someone');
  });

  it('userPersonaOf finds the tree persona from any node, and nothing for another tree or before it exists', () => {
    const t = seed();
    t.otherTree();
    expect(userPersonaOf(t.store, 'ws_a', DEFAULT_ACTOR)).toBeUndefined();
    const p = ensureUserPersona(t.store, 'ws_a', DEFAULT_ACTOR);
    expect(userPersonaOf(t.store, 'ws_a', DEFAULT_ACTOR)?.id).toBe(p.id);
    expect(userPersonaOf(t.store, 'ws_a1', DEFAULT_ACTOR)?.id).toBe(p.id);
    expect(userPersonaOf(t.store, 'ws_b', DEFAULT_ACTOR)).toBeUndefined();
  });

  it('two actors in one tree get separate personas; neither finds the other', () => {
    const t = seed();
    const mine = ensureUserPersona(t.store, 'ws_a', DEFAULT_ACTOR);
    const theirs = ensureUserPersona(t.store, 'ws_a', OTHER);
    expect(theirs.id).not.toBe(mine.id);
    expect(theirs.slug).toBe(`user-${hash8(OTHER)}`);
    expect(userPersonaOf(t.store, 'ws_a1', OTHER)?.id).toBe(theirs.id);
    expect(userPersonaOf(t.store, 'ws_a1', DEFAULT_ACTOR)?.id).toBe(mine.id);
    expect(userPersonaOf(t.store, 'ws_a', 'nobody')).toBeUndefined();
  });
});

describe('the user persona is no segment or stakeholder persona', () => {
  it('segmentPersonas and stakeholderPersonas never return it', () => {
    const t = seed();
    const seg = t.persona('smb');
    ensureUserPersona(t.store, 'ws_a', DEFAULT_ACTOR);
    expect(segmentPersonas(t.store, 'ws_a').map((p) => p.id)).toEqual([seg.id]);
    expect(stakeholderPersonas(t.store, 'ws_a')).toEqual([]);
  });

  it('writeAgentMd writes no file for it, also when a line is accepted', () => {
    const t = seed();
    const p = ensureUserPersona(t.store, 'ws_a', DEFAULT_ACTOR);
    expect(writeAgentMd(t.store, p)).toBe('');
    const repos = personaLearningRepos(t.store);
    repos.proposals.insert({
      id: 'ppr_u1', rootWorkspaceId: 'ws_a', workspaceId: 'ws_a', personaId: p.id, action: 'add', field: 'priorities',
      text: 'Prefers changes that can ship within a quarter over larger bets.', rationale: 'r', evidence: [], stats: {}, source: 'retro', status: 'pending', createdAt: T0,
    });
    const out = acceptPersonaProposal(t.store, DEFAULT_ACTOR, 'ws_a1', 'ppr_u1');
    expect(out.persona.version).toBe(2);
    const md = (readdirSync(t.dir, { recursive: true }) as string[]).filter((f) => f.endsWith('.md'));
    expect(md).toEqual([]);
    expect(existsSync(join(t.dir, 'ws_a', 'personas'))).toBe(false);
    expect(userLines(t.store, 'ws_a', DEFAULT_ACTOR)).toEqual([{ field: 'priorities', lines: [out.adjustment] }]);
  });

  it('the persona panel, its stakeholder reads and the flow round ignore it', async () => {
    const t = seed();
    ensureUserPersona(t.store, 'ws_a', DEFAULT_ACTOR);
    t.store.recommendations.insert({
      id: 'rec_1', workspaceId: 'ws_a', title: 'Offer Google sign-up', summary: 's', criteria: {}, findingIds: [], priority: 3, createdAt: T0, status: 'verified', personaFeedback: [],
    });
    const report = await runPersonaPanel('ws_a', t.deps);
    expect(report).toMatchObject({ feedback: 0, missing: [], stakeholderReads: { reads: 0, missing: [] } });
    expect(t.requests).toEqual([]);
    expect(usablePersonaIds(t.store, 'ws_a').size).toBe(0);
  });

  it('persona learning does not evaluate it', async () => {
    const t = seed();
    ensureUserPersona(t.store, 'ws_a', DEFAULT_ACTOR);
    const report = await runPersonaLearning(t.deps, 'ws_a');
    expect(report.personasEvaluated).toBe(0);
  });

  it('the knowledge backfill makes no entity of it', () => {
    const t = seed();
    const p = ensureUserPersona(t.store, 'ws_a', DEFAULT_ACTOR);
    backfillKnowledge(t.store);
    expect(t.store.personas.get(p.id)!.entityId).toBeUndefined();
  });
});

describe('userLines and userBrief', () => {
  it('no persona or no active lines: no brief', () => {
    const t = seed();
    expect(userBrief(t.store, 'ws_a', DEFAULT_ACTOR)).toBeUndefined();
    expect(userLines(t.store, 'ws_a', DEFAULT_ACTOR)).toEqual([]);
    const p = ensureUserPersona(t.store, 'ws_a', DEFAULT_ACTOR);
    line(t.store, p.id, 'priorities', 'Retired line.', { status: 'retired' });
    expect(userBrief(t.store, 'ws_a', DEFAULT_ACTOR)).toBeUndefined();
  });

  it('active lines grouped by field in USER_FIELDS order, the block exactly', () => {
    const t = seed();
    const p = ensureUserPersona(t.store, 'ws_a', DEFAULT_ACTOR);
    const c = line(t.store, p.id, 'communication', 'Wants the decision first and the evidence after.', { version: 2 });
    const q = line(t.store, p.id, 'priorities', 'Prefers changes that can ship within a quarter over larger bets.');
    expect(userLines(t.store, 'ws_a1', DEFAULT_ACTOR)).toEqual([
      { field: 'priorities', lines: [q] },
      { field: 'communication', lines: [c] },
    ]);
    expect(userBrief(t.store, 'ws_a1', DEFAULT_ACTOR)).toBe(
      [
        '## The person you work for',
        '',
        'Learned from their decisions in this tool. Follow it where it does not conflict with the evidence.',
        '',
        `- [${q.marker}.v1] (priorities) Prefers changes that can ship within a quarter over larger bets.`,
        `- [${c.marker}.v2] (communication) Wants the decision first and the evidence after.`,
      ].join('\n'),
    );
  });

  it("two actors in one tree get their own lines and brief; neither sees the other's", () => {
    const t = seed();
    const mine = ensureUserPersona(t.store, 'ws_a', DEFAULT_ACTOR);
    const theirs = ensureUserPersona(t.store, 'ws_a', OTHER);
    line(t.store, mine.id, 'priorities', 'Mine.');
    line(t.store, theirs.id, 'risk_appetite', 'Theirs.');
    expect(userBrief(t.store, 'ws_a', DEFAULT_ACTOR)).toContain('(priorities) Mine.');
    expect(userBrief(t.store, 'ws_a', DEFAULT_ACTOR)).not.toContain('Theirs.');
    expect(userBrief(t.store, 'ws_a', OTHER)).toContain('(risk_appetite) Theirs.');
    expect(userBrief(t.store, 'ws_a', OTHER)).not.toContain('Mine.');
    expect(userLines(t.store, 'ws_a', OTHER).map((g) => g.field)).toEqual(['risk_appetite']);
  });
});
