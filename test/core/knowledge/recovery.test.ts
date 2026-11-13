/**
 * Recovery (paging rework, binding): every cut item names the call that returns it whole (`full`), with
 * the measured `max_tokens` of a page that holds it, and that call does. One scenario per pointer kind
 * (`RECOVERY_KINDS`), the stated limit (`too_large`), a quote's `passage`, the node card's profile as one
 * item per key, and `expand` of a node id. The last test fails when the code can emit a kind no scenario
 * here exercises. Items are made larger than the tools' floors with control characters (JSON-escaped
 * six-fold); the sweep (`pagingSweep*.test.ts`) covers every shape at every budget.
 */
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import type { RunContext } from '../../../src/core/harness/tokens.js';
import { resolveEntity } from '../../../src/core/knowledge/entities.js';
import { RECOVERY_KINDS } from '../../../src/core/knowledge/readCommon.js';
import { READ_FLOOR_TOKENS } from '../../../src/core/knowledge/tools.js';
import { scopeFor } from '../../../src/core/knowledge/scope.js';
import type { Store } from '../../../src/core/store/db.js';
import { knowledgeRepos, newId } from '../../../src/core/store/repos.js';
import { ks4, T0, type Ks4 } from './ks4fixture.js';
import { expectRecovered } from './recoveryHelpers.js';

const opened: Store[] = [];
afterEach(() => {
  for (const s of opened.splice(0)) s.close();
});

type Page = Record<string, unknown> & { cursor?: string; notes?: string[] };
const seenKinds = new Set<string>();

/** Wide budgets for the uncut reference (one call per list). */
const wide = (c: { knowledge?: unknown }) => {
  (c as { knowledge: unknown }).knowledge = { budgets: { roles: { orchestrator: { search: 8000, card: 8000, expand: 8000 } } }, hardMaxTokens: 8000 };
};

async function pages(t: Ks4, c: RunContext, tool: string, input: Record<string, unknown>): Promise<Page[]> {
  const out: Page[] = [];
  let cursor: string | undefined;
  for (let i = 0; i < 400; i++) {
    const p = await t.call<Page>(c, tool as 'expand', { ...input, ...(cursor ? { cursor } : {}) });
    out.push(p);
    expect(JSON.stringify(p.notes ?? [])).not.toMatch(/nothing|raised/);
    if (!p.cursor) return out;
    cursor = p.cursor;
  }
  throw new Error('paging did not end');
}

/**
 * Sweeps budgets; at each, every cut item of the list is recovered through its pointer and checked
 * against the uncut item. Returns the kinds seen.
 */
async function sweep(t: Ks4, c: RunContext, ref: RunContext, tool: string, input: Record<string, unknown>, key: string, budgets: number[]) {
  const whole = (await pages(t, ref, tool, { ...input, max_tokens: 8000 })).flatMap((p) => (p[key] as unknown[]) ?? []);
  const kinds = new Set<string>();
  for (const budget of budgets) {
    const ps = await pages(t, c, tool, { ...input, max_tokens: budget });
    const items = ps.flatMap((p) => (p[key] as unknown[]) ?? []);
    expect(items.length, `${tool} ${budget}`).toBe(whole.length);
    for (const [i, it] of items.entries()) {
      const o = it as Record<string, unknown>;
      if (typeof it === 'string' || o.cut !== true) continue;
      kinds.add(await expectRecovered(t, c, o, whole[i], `${tool} budget ${budget} item ${i}`));
    }
  }
  for (const k of kinds) seenKinds.add(k);
  return kinds;
}

const range = (a: number, b: number, step = 5) => Array.from({ length: Math.floor((b - a) / step) + 1 }, (_, i) => a + i * step);
/** Text JSON-escaped six-fold (`\u0001` …): a short claim or key larger than a page at the floor. */
const wideText = (n: number) => '\u0001'.repeat(n);

describe('every pointer returns what was left out (re-gate, binding)', () => {
  it('expand_id: a search hit too big for a page → expand of its id', async () => {
    const t = ks4(opened, wide);
    for (let i = 0; i < 4; i++) t.fact('ws_a', `Zephyr pricing claim ${i} ${wideText(150)} end ${i}`);
    const kinds = await sweep(t, t.ctx('ws_a'), t.ctx('ws_a', 'orchestrator'), 'search', { query: 'zephyr pricing', kinds: ['fact'] }, 'hits', range(READ_FLOOR_TOKENS.search, 320));
    expect([...kinds]).toEqual(['expand_id']);
  });

  it('same_call: a change, an entity card line → the same request at it with a larger budget', async () => {
    const t = ks4(opened, wide);
    const e = resolveEntity(t.store, scopeFor(t.store, 'ws_a'), { kind: 'competitor', name: 'Globex' });
    for (let i = 0; i < 4; i++) {
      const f = t.fact('ws_a', `Globex claim ${i} ${wideText(230)} end ${i}`, { entityId: e.id });
      knowledgeRepos(t.store).factObservations.insert({
        id: newId('obs'), workspaceId: 'ws_a', lineageId: f.id, findingId: f.id, kind: 'create', evidence: [], status: 'applied',
        createdAt: new Date().toISOString(), appliedAt: new Date().toISOString(),
      });
    }
    const c = t.ctx('ws_a');
    const ref = t.ctx('ws_a', 'orchestrator');
    expect([...(await sweep(t, c, ref, 'list_changes', { since: '2026-10-01' }, 'changes', range(READ_FLOOR_TOKENS.list_changes, 420)))]).toEqual(['same_call']);
    expect([...(await sweep(t, c, ref, 'get_card', { entity_id: e.id }, 'lines', range(READ_FLOOR_TOKENS.get_card, 420)))]).toEqual(['same_call']);
  });

  it('get_card_line: a line of expand <entity> too big for a page → that line of get_card <entity>', async () => {
    const t = ks4(opened, wide);
    const e = resolveEntity(t.store, scopeFor(t.store, 'ws_a'), { kind: 'competitor', name: 'Globex' });
    for (let i = 0; i < 4; i++) t.fact('ws_a', `Globex claim ${i} ${wideText(280)} end ${i}`, { entityId: e.id });
    const kinds = await sweep(t, t.ctx('ws_a'), t.ctx('ws_a', 'orchestrator'), 'expand', { id: e.id }, 'items', range(READ_FLOOR_TOKENS.expand, 480));
    expect(kinds.has('get_card_line')).toBe(true);
  });

  it('read_workspace_line: a node card line too big for a page → that line of read_workspace <node> (get_card, read_workspace and expand of the node)', async () => {
    const t = ks4(opened, wide);
    t.store.profiles.insert({ workspaceId: 'ws_a', data: { [`a_rather_long_profile_key_${wideText(180)}`]: 1, short: 2 } });
    for (let i = 0; i < 3; i++) {
      t.store.symptoms.insert({ id: newId('sym'), workspaceId: 'ws_a', kind: 'symptom', title: `Renewals fell in segment ${i} ${'and more detail '.repeat(9)}`, detail: 'd', criteria: {}, evidence: [] });
    }
    const c = t.ctx('ws_a');
    const ref = t.ctx('ws_a', 'orchestrator');
    for (const [tool, input, key] of [
      ['get_card', { workspace_id: 'ws_a' }, 'lines'],
      ['read_workspace', { workspace_id: 'ws_a' }, 'lines'],
      ['expand', { id: 'ws_a' }, 'items'],
    ] as const) {
      const kinds = await sweep(t, c, ref, tool, input, key, range(READ_FLOOR_TOKENS[tool], 360, 2));
      expect([...kinds], tool).toEqual(['read_workspace_line']);
    }
  });

  it('same_call: a quote too big for a page → the fact at it; its passage only when that passage holds the whole quote', async () => {
    const t = ks4(opened, wide);
    const a = await t.page('ws_a', `${'Pricing detail sentence number one. '.repeat(30)}`);
    const chunk = knowledgeRepos(t.store).chunks.list({ artifactId: a.id })[0]!;
    const f = t.fact('ws_a', 'Acme pricing', { evidence: [a.id] });
    const fe = knowledgeRepos(t.store).findingEvidence;
    fe.insert({ findingId: f.id, seq: 0, artifactId: a.id, chunkId: chunk.id, quote: chunk.text.slice(0, 1100) });
    fe.insert({ findingId: f.id, seq: 1, artifactId: a.id, quote: chunk.text.slice(0, 1000) });
    fe.insert({ findingId: f.id, seq: 2, artifactId: a.id, chunkId: chunk.id, quote: 'not in this passage' });
    const kinds = await sweep(t, t.ctx('ws_a'), t.ctx('ws_a', 'orchestrator'), 'expand', { id: f.id }, 'items', range(READ_FLOOR_TOKENS.expand, 420));
    expect([...kinds]).toEqual(['same_call']);
    const quotes = (await pages(t, t.ctx('ws_a'), 'expand', { id: f.id })).flatMap((p) => (p.items as Array<Record<string, unknown>>) ?? []).filter((x) => x.type === 'quote');
    expect(quotes.map((q) => q.passage)).toEqual([{ kind: 'expand_chunk', tool: 'expand', input: { id: chunk.id } }, undefined, undefined]);
  });
});

describe('stated limit, node profile, expand of a node (re-gate, binding)', () => {
  it('a value larger than the hard maximum is served cut, flagged too_large with its size, and no pointer', async () => {
    const t = ks4(opened, (c) => {
      c.knowledge = { hardMaxTokens: 300 };
    });
    const a = await t.page('ws_a', 'Quote source text.');
    const f = t.fact('ws_a', 'Big quote', { evidence: [a.id] });
    knowledgeRepos(t.store).findingEvidence.insert({ findingId: f.id, seq: 0, artifactId: a.id, quote: `long ${'q'.repeat(3000)}` });
    const items = (await pages(t, t.ctx('ws_a'), 'expand', { id: f.id })).flatMap((p) => (p.items as Array<Record<string, unknown>>) ?? []);
    const q = items.find((x) => x.type === 'quote')!;
    expect(q).toMatchObject({ cut: true, too_large: true });
    expect(q.size_tokens as number).toBeGreaterThan(300);
    expect(q.full).toBeUndefined();
  });

  it('the node card lists the profile one key per line, and the cursor reaches every key', async () => {
    const t = ks4(opened);
    const data: Record<string, string> = {};
    for (let i = 0; i < 200; i++) data[`profile_field_number_${i}_with_some_name`] = 'v';
    t.store.profiles.insert({ workspaceId: 'ws_a', data });
    const lines = (await pages(t, t.ctx('ws_a'), 'get_card', { workspace_id: 'ws_a' })).flatMap((p) => (p.lines as unknown[]) ?? []);
    for (let i = 0; i < 200; i++) expect(lines).toContain(`profile key: profile_field_number_${i}_with_some_name`);
    expect(lines.some((l) => typeof l !== 'string')).toBe(false);
  });

  it('expand of a node id returns its node card (no longer "not found"); another tree\'s node stays not found', async () => {
    const t = ks4(opened);
    const r = await t.call<{ kind: string; node: { id: string }; items: Array<{ type: string; text: string }> }>(t.ctx('ws_a'), 'expand', { id: 'ws_c' });
    expect(r.kind).toBe('node');
    expect(r.node.id).toBe('ws_c');
    expect(r.items.some((x) => x.type === 'line' && x.text.startsWith('counts:'))).toBe(true);
    expect((await t.handle(t.ctx('ws_a'), 'expand', { id: 'ws_b' })).ok).toBe(false);
  });
});

afterAll(() => {
  // Every pointer kind the code can emit is exercised above (a new kind needs a scenario here).
  expect([...seenKinds].sort()).toEqual([...RECOVERY_KINDS].sort());
});

void T0;
