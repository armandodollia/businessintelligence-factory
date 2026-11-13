/**
 * Final-gate ruling on list paging (search hits, card lines, list_changes; binding):
 * 1. An item that does not fit the rest of the page ends the page; the cursor points AT it. An item is
 *    never shortened because the page is nearly full.
 * 2. An item is shortened only when it is too big for a whole page on its own.
 * 3. A shortened item: text fields are cut first; dropped array entries are counted per field
 *    (`omitted_entries`); it is marked `cut: true` and carries `full`, the call that returns it whole.
 * 4. Pages joined equal the full list at every budget at which every item fits a page; no array entry
 *    disappears without a count; an item larger than a page is cut, flagged and recoverable by `expand`.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { TOOL_DESCRIPTIONS } from '../../../src/core/harness/tools/registry.js';
import type { RunContext } from '../../../src/core/harness/tokens.js';
import { estimateTokens } from '../../../src/core/knowledge/budget.js';
import { resolveEntity } from '../../../src/core/knowledge/entities.js';
import { shortenItem } from '../../../src/core/knowledge/readCommon.js';
import { scopeFor } from '../../../src/core/knowledge/scope.js';
import type { Store } from '../../../src/core/store/db.js';
import { knowledgeRepos, newId } from '../../../src/core/store/repos.js';
import type { Role } from '../../../src/core/types.js';
import { ks4, T0, type Ks4 } from './ks4fixture.js';
import { expectRecovered } from './recoveryHelpers.js';

const opened: Store[] = [];
afterEach(() => {
  for (const s of opened.splice(0)) s.close();
});

type Page = Record<string, unknown> & { cursor?: string; notes?: string[]; tokens: number; truncated: boolean };
type Tool = 'search' | 'get_card' | 'list_changes';
const LIST_KEY: Record<Tool, string> = { search: 'hits', get_card: 'lines', list_changes: 'changes' };

function world(role: Role = 'worker') {
  const t = ks4(opened, (c) => {
    c.knowledge = { budgets: { default: { search: 8000, card: 8000, expand: 8000, briefing: 1500 } }, hardMaxTokens: 8000 };
  });
  const e = resolveEntity(t.store, scopeFor(t.store, 'ws_a'), { kind: 'competitor', name: 'Globex' });
  // Facts of very different lengths (claims up to the 240 / 300-char serving caps and beyond).
  const lengths = [1, 30, 3, 60, 0, 12, 45, 2, 80];
  const facts = lengths.map((n, i) =>
    t.fact('ws_a', `Globex widget claim ${i} ${'with more detail '.repeat(n)}end ${i}`, { entityId: e.id, createdAt: T0 }),
  );
  // One sibling-node fact so the node-scoped search has an "elsewhere" note on its first page.
  t.fact('ws_d', 'Globex widget claim elsewhere', { entityId: e.id });
  // Applied "create" observations so list_changes lists them.
  for (const f of facts) {
    knowledgeRepos(t.store).factObservations.insert({
      id: newId('obs'), workspaceId: 'ws_a', lineageId: f.id, findingId: f.id, kind: 'create', evidence: [], status: 'applied',
      createdAt: new Date().toISOString(), appliedAt: new Date().toISOString(),
    });
  }
  const c = t.ctx('ws_a', role);
  return { t, e, facts, c };
}

async function follow(t: Ks4, c: RunContext, tool: Tool, input: Record<string, unknown>): Promise<Page[]> {
  const pages: Page[] = [];
  let cursor: string | undefined;
  for (let i = 0; i < 80; i++) {
    const p = await t.call<Page>(c, tool, { ...input, ...(cursor ? { cursor } : {}) });
    pages.push(p);
    if (!p.cursor || NOTHING_FITS.test(JSON.stringify(p.notes ?? []))) return pages;
    expect(p.cursor, `a cursor never points back at the same page (${JSON.stringify(input)})`).not.toBe(cursor);
    cursor = p.cursor;
  }
  throw new Error('paging did not end');
}

const NOTHING_FITS = /nothing of this page fits/;
const itemsOf = (p: Page, tool: Tool) => (p[LIST_KEY[tool]] as unknown[] | undefined) ?? [];
const isCut = (x: unknown) => typeof x === 'object' && x !== null && (x as { cut?: unknown }).cut === true;
/** The id an item is recovered by. */
function idOf(x: unknown): string | undefined {
  if (typeof x === 'string') return /\[([a-z]+_[A-Za-z0-9]+)\]/.exec(x)?.[1];
  const o = x as Record<string, unknown>;
  return (o.id as string | undefined) ?? (o.to as { id?: string } | undefined)?.id ?? (o.artifact_id as string | undefined);
}

/** Every array of `ref` (by field path) is either whole in `cut` or its dropped entries are counted. */
function arraysAccounted(ref: unknown, cut: Record<string, unknown>) {
  const omitted = (cut.omitted_entries ?? {}) as Record<string, number>;
  const walk = (r: unknown, c: unknown, path: string) => {
    if (Array.isArray(r)) {
      const kept = Array.isArray(c) ? c.length : 0;
      expect(kept + (omitted[path] ?? 0), `array ${path}`).toBe(r.length);
      r.slice(0, kept).forEach((x, i) => walk(x, (c as unknown[])[i], path));
    } else if (r && typeof r === 'object') {
      for (const [k, v] of Object.entries(r)) walk(v, (c as Record<string, unknown> | undefined)?.[k], path ? `${path}.${k}` : k);
    }
  };
  walk(ref, cut, '');
}

const CASES: Array<{ tool: Tool; input: (w: ReturnType<typeof world>) => Record<string, unknown>; role?: Role }> = [
  { tool: 'search', input: () => ({ query: 'globex widget claim', kinds: ['fact'] }) },
  { tool: 'search', input: () => ({ query: 'globex widget claim', kinds: ['fact'], include_unverified: true }), role: 'synthesizer' },
  { tool: 'get_card', input: (w) => ({ entity_id: w.e.id }) },
  { tool: 'list_changes', input: () => ({}) },
  { tool: 'list_changes', input: () => ({ include_unverified: true }), role: 'synthesizer' },
];

describe('list paging ruling: end the page before an item that does not fit; shorten only what no page can hold', () => {
  for (const k of CASES) {
    it(`${k.tool}${k.role ? ` (${k.role}, with a role note)` : ''}: pages joined = the full list; a cut item is alone, too big for any page, counted and recoverable`, async () => {
      const w = world(k.role);
      const input = k.input(w);
      const [whole] = await follow(w.t, w.c, k.tool, { ...input, max_tokens: 8000 });
      const ref = itemsOf(whole!, k.tool);
      expect(ref.length).toBeGreaterThan(5);
      expect(ref.some(isCut)).toBe(false);
      let sawCut = false;
      let sawUncutRun = false;
      const fixed = Object.fromEntries(Object.entries(whole!).filter(([key]) => !['tokens', 'truncated', 'more', 'cursor', 'notes', LIST_KEY[k.tool]].includes(key)));
      const recurringNotes = (whole!.notes ?? []).filter((n) => !n.startsWith('more matches elsewhere'));
      for (let budget = 100; budget <= 1400; budget += 10) {
        const pages = await follow(w.t, w.c, k.tool, { ...input, max_tokens: budget });
        for (const p of pages) expect(p.tokens).toBeLessThanOrEqual(budget);
        const last = pages.at(-1)!;
        if (NOTHING_FITS.test(JSON.stringify(last.notes ?? []))) {
          // Never a false "nothing fits": even the barest form of the next item (kind, id, cut, the
          // pointer to the full item) on a page of this request would exceed the budget.
          const next = ref[pages.slice(0, -1).flatMap((p) => itemsOf(p, k.tool)).length];
          const id = idOf(next) ?? w.e.id;
          // The pointer the code gives such an item: its own `expand` (hits) or this request at it.
          const full = k.tool === 'search'
            ? { kind: 'expand_id', tool: 'expand', input: { id } }
            : { kind: 'same_call', tool: k.tool, input: { ...input, cursor: last.cursor, max_tokens: 100 } };
          const bare = typeof next === 'string'
            ? { text: '…', cut: true, full }
            : {
                ...Object.fromEntries(['kind', 'type', 'change'].filter((f) => typeof (next as Record<string, unknown>)[f] === 'string').map((f) => [f, (next as Record<string, unknown>)[f]])),
                id, cut: true, full,
              };
          const page = { ...fixed, [LIST_KEY[k.tool]]: [bare], tokens: budget, truncated: true, more: ref.length, cursor: last.cursor, ...(recurringNotes.length ? { notes: recurringNotes } : {}) };
          // Within the estimate's rounding (a cursor at item 0 is a few characters longer).
          expect(estimateTokens(JSON.stringify(page)), `budget ${budget}: false "nothing fits"`).toBeGreaterThan(budget - 4);
          continue;
        }
        const joined = pages.flatMap((p) => itemsOf(p, k.tool));
        expect(joined.length, `budget ${budget}`).toBe(ref.length);
        for (const [i, item] of joined.entries()) {
          if (!isCut(item)) {
            expect(item, `budget ${budget} item ${i}`).toEqual(ref[i]);
            continue;
          }
          sawCut = true;
          const page = pages.find((p) => itemsOf(p, k.tool).includes(item))!;
          expect(itemsOf(page, k.tool), 'a cut item is alone on its page').toHaveLength(1);
          // Justified: the full item does not fit an empty page of this request.
          const fullPage = { ...page, [LIST_KEY[k.tool]]: [ref[i]] };
          expect(estimateTokens(JSON.stringify(fullPage)), `budget ${budget}: item ${i} was cut but fits a page`).toBeGreaterThan(budget);
          const o = item as Record<string, unknown>;
          await expectRecovered(w.t, w.c, o, ref[i], `${k.tool} budget ${budget} item ${i}`);
          if (typeof ref[i] === 'object') arraysAccounted(ref[i], o);
        }
        if (!joined.some(isCut)) sawUncutRun = true;
      }
      if (!k.role) expect(sawCut, 'some budget is small enough to cut the longest item').toBe(true);
      expect(sawUncutRun, 'some budget fits every item').toBe(true);
    });
  }

  it('an item larger than a page is cut, flagged and recoverable through its pointer (search hit, card line, change)', async () => {
    const w = world();
    const longest = w.facts[8]!;
    for (const [tool, input] of [
      ['search', { query: 'globex widget claim 8', kinds: ['fact'] }],
      ['get_card', { entity_id: w.e.id }],
      ['list_changes', {}],
    ] as const) {
      const ref = (await follow(w.t, w.c, tool, { ...input, max_tokens: 8000 })).flatMap((p) => itemsOf(p, tool));
      let longestRecovered = false;
      // Every budget at which the longest item is cut (and a page still holds its bare form with the pointer).
      for (let budget = 100; budget <= 300; budget += 10) {
        const pages = await follow(w.t, w.c, tool, { ...input, max_tokens: budget });
        if (NOTHING_FITS.test(JSON.stringify(pages.at(-1)!.notes ?? []))) continue;
        const joined = pages.flatMap((p) => itemsOf(p, tool));
        expect(joined.length, tool).toBe(ref.length);
        for (const [i, item] of joined.entries()) {
          if (!isCut(item)) continue;
          await expectRecovered(w.t, w.c, item as Record<string, unknown>, ref[i], `${tool} budget ${budget} item ${i}`);
          if (JSON.stringify(ref[i]).includes(longest.claim.slice(0, 120))) longestRecovered = true;
        }
      }
      expect(longestRecovered, tool).toBe(true);
    }
  });
});

describe('shortenItem (ruling 3)', () => {
  const fits = (n: number) => (x: unknown) => estimateTokens(JSON.stringify(x)) <= n;

  it('cuts text fields first: lists stay whole while shorter text is enough', () => {
    const item = { id: 'fnd_1', title: 't'.repeat(600), tags: ['a', 'b', 'c'] };
    const s = shortenItem(item, fits(80), { full: { kind: 'expand_id', tool: 'expand', input: { id: 'fnd_1' } } }) as Record<string, unknown>;
    expect(s.tags).toEqual(['a', 'b', 'c']);
    expect(s.omitted_entries).toBeUndefined();
    expect(String(s.title).length).toBeLessThan(600);
    expect(s).toMatchObject({ id: 'fnd_1', cut: true, full: { kind: 'expand_id', tool: 'expand', input: { id: 'fnd_1' } } });
  });

  it('counts every dropped array entry per field, nested too', () => {
    const item = {
      type: 'evidence', artifact_id: 'art_1',
      quotes: Array.from({ length: 30 }, (_, i) => `<<<EVIDENCE art_1\nq${i} ${'q'.repeat(200)}\n>>>`),
      nested: { notes: Array.from({ length: 12 }, (_, i) => `note ${i} ${'n'.repeat(100)}`) },
    };
    const s = shortenItem(item, fits(220), { full: { kind: 'same_call', tool: 'expand', input: { id: 'fnd_1' } } }) as Record<string, unknown>;
    expect(s.cut).toBe(true);
    arraysAccounted(item, s);
    expect(Object.keys(s.omitted_entries as object).sort()).toEqual(['nested.notes', 'quotes']);
  });

  it('a string becomes { text, cut, full }', () => {
    const s = shortenItem(`[fnd_ABC] ${'claim '.repeat(100)}`, fits(60), { full: { kind: 'expand_id', tool: 'expand', input: { id: 'fnd_ABC' } } }) as Record<string, unknown>;
    expect(s).toMatchObject({ cut: true, full: { kind: 'expand_id', input: { id: 'fnd_ABC' } } });
    expect(String(s.text).startsWith('[fnd_ABC] claim')).toBe(true);
  });
});

describe('list tool descriptions (ruling 5)', () => {
  it('say: follow cursor until it is absent; an item marked cut carries the call that returns it whole', () => {
    for (const tool of ['search', 'get_card', 'list_changes'] as const) {
      expect(TOOL_DESCRIPTIONS[tool], tool).toContain(
        'follow `cursor` until it is absent; an item marked `cut` is shortened: make the call in its `full` ({tool, input}) to get it whole; `too_large` = larger than the hard maximum, served cut with its `size_tokens`.',
      );
    }
  });
});

describe('shortened text never splits an id (Opus finding 6)', () => {
  it('cuts at a token boundary: every id left in a cut line is whole', () => {
    const ids = Array.from({ length: 6 }, (_, i) => `ent_01M7BD${'ABCDEFGHJK'.slice(i, i + 4)}QZ7537H4RHT1HW3G`);
    const line = `competes_with ${ids.map((id, i) => `Rival company number ${i} [${id}]`).join(', ')}`;
    for (let n = 20; n <= 120; n += 1) {
      const s = shortenItem(line, (x) => estimateTokens(JSON.stringify(x)) <= n + 15, { full: { kind: 'same_call', tool: 'get_card', input: {} } }) as { text: string } | undefined;
      if (!s) continue;
      const text = s.text.replace(/…$/, '');
      for (const m of text.matchAll(/[a-z]+_[A-Za-z0-9]*/g)) expect(ids.concat(['competes_with']), `n=${n}: ${text}`).toContain(m[0]);
      expect(text.endsWith('[')).toBe(false);
    }
  });
});

describe('expand of a non-text item shortens its header like text reads (Opus finding 4, §9)', () => {
  it('a fact with a long claim at 100-300 tokens: header_cut on the first page, never "nothing fits", every item visited', async () => {
    const t = ks4(opened);
    const a = await t.page('ws_a', 'Acme pricing page: the Pro plan costs 49 dollars per seat.');
    const f = t.fact('ws_a', `Acme pricing claim ${'with a fairly long explanation of the plan tiers and seat prices '.repeat(8)}`, {
      evidence: [a.id], criteria: { a: 'b'.repeat(200) } as never,
    });
    const c = t.ctx('ws_a');
    const [whole] = await t.call<Page>(c, 'expand', { id: f.id, max_tokens: 8000 }).then((p) => [p]);
    const ref = (whole!.items as unknown[]) ?? [];
    for (let budget = 100; budget <= 300; budget += 10) {
      const pages: Page[] = [];
      let cursor: string | undefined;
      for (let i = 0; i < 40; i++) {
        const p = await t.call<Page>(c, 'expand', { id: f.id, max_tokens: budget, ...(cursor ? { cursor } : {}) });
        pages.push(p);
        expect(p.tokens).toBeLessThanOrEqual(budget);
        expect(JSON.stringify(p.notes ?? []), `budget ${budget}`).not.toMatch(NOTHING_FITS);
        if (!p.cursor) break;
        cursor = p.cursor;
      }
      // Re-gate (Opus 1): the header is shortened only when it cannot fit a page alone; else it is whole.
      if (pages[0]!.header_cut === true) expect(pages[0]).toMatchObject({ id: f.id });
      else expect(pages[0]).toMatchObject({ id: f.id, claim: f.claim });
      expect(pages.flatMap((p) => (p.items as unknown[]) ?? []).length, `budget ${budget}`).toBe(ref.length);
    }
  });
});

describe('the "elsewhere" count is capped (final-gate follow-up)', () => {
  it(`counts matches outside node scope up to ELSEWHERE_COUNT_CAP and then says "<cap>+"`, async () => {
    const { ELSEWHERE_COUNT_CAP } = await import('../../../src/core/knowledge/search.js');
    expect(ELSEWHERE_COUNT_CAP).toBe(50);
    const t = ks4(opened);
    // Caller: Payments (ws_c); Labs (ws_d) is its sibling, outside node scope.
    t.fact('ws_c', 'Zephyr pricing here');
    for (let i = 0; i < 3; i++) t.fact('ws_d', `Zephyr pricing in labs ${i}`);
    const c = t.ctx('ws_c');
    const few = await t.call<Page>(c, 'search', { query: 'zephyr pricing', kinds: ['fact'] });
    expect(few.notes!.join(' ')).toMatch(/elsewhere in the business \(outside node scope\): fact 3;/);
    for (let i = 3; i < 80; i++) t.fact('ws_d', `Zephyr pricing in labs ${i}`);
    const many = await t.call<Page>(c, 'search', { query: 'zephyr pricing', kinds: ['fact'] });
    expect(many.notes!.join(' ')).toMatch(/fact 50\+;/);
  });
});
