/**
 * Final-gate ruling on list paging (search hits, card lines, list_changes; binding):
 * 1. An item that does not fit the rest of the page ends the page; the cursor points AT it. An item is
 *    never shortened because the page is nearly full.
 * 2. An item is shortened only when it is too big for a whole page on its own.
 * 3. A shortened item: text fields are cut first; dropped array entries are counted per field
 *    (`omitted_entries`); it is marked `cut: true` and says "expand <id> for the full item" (`full`).
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

const opened: Store[] = [];
afterEach(() => {
  for (const s of opened.splice(0)) s.close();
});

type Page = Record<string, unknown> & { cursor?: string; notes?: string[]; tokens: number; truncated: boolean };
type Tool = 'search' | 'get_card' | 'list_changes';
const LIST_KEY: Record<Tool, string> = { search: 'hits', get_card: 'lines', list_changes: 'changes' };
const FULL = /^expand (\S+) for the full item$/;

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
          const bare = typeof next === 'string'
            ? { text: '…', cut: true, full: `expand ${id} for the full item` }
            : {
                ...Object.fromEntries(['kind', 'type', 'change'].filter((f) => typeof (next as Record<string, unknown>)[f] === 'string').map((f) => [f, (next as Record<string, unknown>)[f]])),
                id, cut: true, full: `expand ${id} for the full item`,
              };
          const page = { ...fixed, [LIST_KEY[k.tool]]: [bare], tokens: budget, truncated: true, more: ref.length, cursor: last.cursor, ...(recurringNotes.length ? { notes: recurringNotes } : {}) };
          expect(estimateTokens(JSON.stringify(page)), `budget ${budget}: false "nothing fits"`).toBeGreaterThan(budget);
          continue;
        }
        const joined = pages.flatMap((p) => itemsOf(p, k.tool));
        expect(joined.length, `budget ${budget}`).toBe(ref.length);
        joined.forEach((item, i) => {
          if (!isCut(item)) {
            expect(item, `budget ${budget} item ${i}`).toEqual(ref[i]);
            return;
          }
          sawCut = true;
          const page = pages.find((p) => itemsOf(p, k.tool).includes(item))!;
          expect(itemsOf(page, k.tool), 'a cut item is alone on its page').toHaveLength(1);
          // Justified: the full item does not fit an empty page of this request.
          const fullPage = { ...page, [LIST_KEY[k.tool]]: [ref[i]] };
          expect(estimateTokens(JSON.stringify(fullPage)), `budget ${budget}: item ${i} was cut but fits a page`).toBeGreaterThan(budget);
          const o = item as Record<string, unknown>;
          expect(typeof o.full === 'string' ? o.full : JSON.stringify(o)).toMatch(FULL);
          // A card line that names no single item (e.g. the "left out" line) points at the card's entity.
          expect(FULL.exec(o.full as string)![1]).toBe(idOf(ref[i]) ?? (k.tool === 'get_card' ? w.e.id : undefined));
          if (typeof ref[i] === 'object') arraysAccounted(ref[i], o);
        });
        if (!joined.some(isCut)) sawUncutRun = true;
      }
      if (!k.role) expect(sawCut, 'some budget is small enough to cut the longest item').toBe(true);
      expect(sawUncutRun, 'some budget fits every item').toBe(true);
    });
  }

  it('an item larger than a page is cut, flagged and recoverable through expand (search hit, card line, change)', async () => {
    const w = world();
    const longest = w.facts[8]!;
    for (const [tool, input] of [
      ['search', { query: 'globex widget claim 8', kinds: ['fact'] }],
      ['get_card', { entity_id: w.e.id }],
      ['list_changes', {}],
    ] as const) {
      const pages = await follow(w.t, w.c, tool, { ...input, max_tokens: 100 });
      const cut = pages
        .flatMap((p) => itemsOf(p, tool))
        .find((x) => isCut(x) && (x as { full?: string }).full === `expand ${longest.id} for the full item`) as Record<string, unknown> | undefined;
      expect(cut, tool).toBeDefined();
      expect(cut!.full).toBe(`expand ${longest.id} for the full item`);
      const full = await w.t.call<{ claim: string }>(w.c, 'expand', { id: longest.id });
      expect(full.claim).toBe(longest.claim);
    }
  });
});

describe('shortenItem (ruling 3)', () => {
  const fits = (n: number) => (x: unknown) => estimateTokens(JSON.stringify(x)) <= n;

  it('cuts text fields first: lists stay whole while shorter text is enough', () => {
    const item = { id: 'fnd_1', title: 't'.repeat(600), tags: ['a', 'b', 'c'] };
    const s = shortenItem(item, fits(60), { id: 'fnd_1' }) as Record<string, unknown>;
    expect(s.tags).toEqual(['a', 'b', 'c']);
    expect(s.omitted_entries).toBeUndefined();
    expect(String(s.title).length).toBeLessThan(600);
    expect(s).toMatchObject({ id: 'fnd_1', cut: true, full: 'expand fnd_1 for the full item' });
  });

  it('counts every dropped array entry per field, nested too', () => {
    const item = {
      type: 'evidence', artifact_id: 'art_1',
      quotes: Array.from({ length: 30 }, (_, i) => `<<<EVIDENCE art_1\nq${i} ${'q'.repeat(200)}\n>>>`),
      nested: { notes: Array.from({ length: 12 }, (_, i) => `note ${i} ${'n'.repeat(100)}`) },
    };
    const s = shortenItem(item, fits(200), { id: 'art_1' }) as Record<string, unknown>;
    expect(s.cut).toBe(true);
    arraysAccounted(item, s);
    expect(Object.keys(s.omitted_entries as object).sort()).toEqual(['nested.notes', 'quotes']);
  });

  it('a string becomes { text, cut, full }', () => {
    const s = shortenItem(`[fnd_ABC] ${'claim '.repeat(100)}`, fits(40), { id: 'fnd_ABC' }) as Record<string, unknown>;
    expect(s).toMatchObject({ cut: true, full: 'expand fnd_ABC for the full item' });
    expect(String(s.text).startsWith('[fnd_ABC] claim')).toBe(true);
  });
});

describe('list tool descriptions (ruling 5)', () => {
  it('say: follow cursor until it is absent; an item marked cut is shortened, and expand on its id returns it in full', () => {
    for (const tool of ['search', 'get_card', 'list_changes'] as const) {
      expect(TOOL_DESCRIPTIONS[tool], tool).toContain(
        'follow `cursor` until it is absent; an item marked `cut` is shortened, and `expand` on its id returns it in full',
      );
    }
  });
});

describe('shortened text never splits an id (Opus finding 6)', () => {
  it('cuts at a token boundary: every id left in a cut line is whole', () => {
    const ids = Array.from({ length: 6 }, (_, i) => `ent_01M7BD${'ABCDEFGHJK'.slice(i, i + 4)}QZ7537H4RHT1HW3G`);
    const line = `competes_with ${ids.map((id, i) => `Rival company number ${i} [${id}]`).join(', ')}`;
    for (let n = 20; n <= 120; n += 1) {
      const s = shortenItem(line, (x) => estimateTokens(JSON.stringify(x)) <= n, { id: 'ent_card' }) as { text: string } | undefined;
      if (!s) continue;
      const text = s.text.replace(/…$/, '');
      for (const m of text.matchAll(/[a-z]+_[A-Za-z0-9]*/g)) expect(ids.concat(['competes_with']), `n=${n}: ${text}`).toContain(m[0]);
      expect(text.endsWith('[')).toBe(false);
    }
  });
});
