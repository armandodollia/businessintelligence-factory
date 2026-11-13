/**
 * `assemblePage` (paging rework, binding): every page is the real response, measured — header (first
 * page only), items, envelope and notes — so an item is added exactly when the page holding it fits, and
 * cut only when it does not fit a page on its own, with a pointer whose `max_tokens` is measured too.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cursorKey, encodeCursor, estimateTokens } from '../../../src/core/knowledge/budget.js';
import { assemblePage, boundedText, laterPageNeed, type PageItem } from '../../../src/core/knowledge/paging.js';
import { READ_FLOOR_TOKENS } from '../../../src/core/knowledge/tools.js';
import type { Store } from '../../../src/core/store/db.js';
import { ks4 } from './ks4fixture.js';

const opened: Store[] = [];
afterEach(() => {
  for (const s of opened.splice(0)) s.close();
});

const key = cursorKey({ q: 'k' });
const item = (v: unknown): PageItem => ({ value: v, refs: [], upload: false });
const again = (cursor: string, need: number) => ({ kind: 'same_call' as const, tool: 't', input: { cursor, max_tokens: need } });

describe('exact page measures', () => {
  it('the last item is served whole whenever the page it is served on fits; the page reports its true size', () => {
    const header = { query: 'q', scope: 'node' };
    const hit = { kind: 'fact', id: 'fnd_01M7BFHF5NEXAMPLE0000000000', title: 'x'.repeat(240) };
    for (let budget = 60; budget <= 140; budget++) {
      const served = { ...header, hits: [hit], tokens: budget, truncated: false, content_trust: 'untrusted' };
      const page = assemblePage({ key, budget, itemsKey: 'hits', header, headerRefs: [], headerUpload: false, items: [item(hit)], again });
      if (estimateTokens(JSON.stringify(served)) <= budget) expect((page.data.hits as unknown[])[0], `budget ${budget}`).toEqual(hit);
      expect(page.data.tokens).toBe(estimateTokens(JSON.stringify(page.data)));
      expect((page.data.hits as unknown[]).length, `budget ${budget}: never empty`).toBe(1);
    }
  });

  it('an item too big for a later page is cut, alone, with the measured max_tokens of the later page that holds it', () => {
    const items = [item({ type: 'a', text: 'a'.repeat(100) }), item({ type: 'b', text: 'b'.repeat(2000) }), item({ type: 'c', text: 'c'.repeat(100) })];
    const req = { key, itemsKey: 'items', header: { kind: 'x', id: 'x_1' }, headerRefs: [], headerUpload: false, items, again };
    const first = assemblePage({ ...req, budget: 200 });
    expect((first.data.items as unknown[]).length).toBe(1); // b does not fit after a: the page ends, the cursor points at b
    const second = assemblePage({ ...req, budget: 200, cursor: first.data.cursor as string });
    const cut = (second.data.items as Array<Record<string, unknown>>)[0]!;
    expect(second.data).not.toHaveProperty('kind');
    expect(cut).toMatchObject({ type: 'b', cut: true, full: { kind: 'same_call', input: { cursor: encodeCursor({ key, offset: 1 }) } } });
    const m = (cut.full as { input: { max_tokens: number } }).input.max_tokens;
    expect(m).toBe(laterPageNeed('items', items[1]!.value, encodeCursor({ key, offset: 2 }), 1));
    // The pointer's page holds b whole, at exactly that budget, and not one token less.
    const at = assemblePage({ ...req, budget: m, cursor: encodeCursor({ key, offset: 1 }) });
    expect((at.data.items as unknown[])[0]).toEqual(items[1]!.value);
    expect(at.data.tokens).toBeLessThanOrEqual(m);
  });

  it('below the smallest page of a request it raises the budget and says so, never an empty page', () => {
    const page = assemblePage({ key, budget: 5, itemsKey: 'items', header: { kind: 'x', id: 'x_1' }, headerRefs: [], headerUpload: false, items: [item({ type: 'a', text: 'a'.repeat(300) })], again });
    expect((page.data.items as unknown[]).length).toBe(1);
    expect((page.data.notes as string[]).at(-1)).toMatch(/max_tokens raised to \d+/);
  });

  it('boundedText bounds the JSON length, at a token boundary, whatever the escapes', () => {
    for (const s of ['"'.repeat(300), '\\'.repeat(300), '\u0001'.repeat(300), 'word '.repeat(100), 'Acme']) {
      const b = boundedText(s, 200);
      expect(JSON.stringify(b).length).toBeLessThanOrEqual(200);
      if (JSON.stringify(s).length <= 200) expect(b).toBe(s);
      else expect(b.endsWith('…')).toBe(true);
    }
  });

  it('a synthesizer search with a role note and an "elsewhere" note cuts a hit only when it truly does not fit', async () => {
    const t = ks4(opened);
    t.fact('ws_c', `Zephyr pricing ${'\u0001'.repeat(160)} end`);
    t.fact('ws_d', 'Zephyr pricing in labs');
    const c = t.ctx('ws_c', 'synthesizer');
    const whole = await t.call<{ hits: unknown[] }>(c, 'search', { query: 'zephyr pricing', kinds: ['fact'], include_unverified: true, max_tokens: 8000 });
    let cuts = 0;
    for (let budget = READ_FLOOR_TOKENS.search; budget <= 400; budget++) {
      const p = await t.call<Record<string, unknown> & { hits: Array<Record<string, unknown>>; notes?: string[] }>(c, 'search', {
        query: 'zephyr pricing', kinds: ['fact'], include_unverified: true, max_tokens: budget,
      });
      expect(p.hits.length).toBe(1);
      expect(p.notes![0]).toMatch(/ignored for role synthesizer/);
      if (p.hits[0]?.cut === true) {
        cuts++;
        const fullPage = { ...p, hits: [whole.hits[0]] };
        expect(estimateTokens(JSON.stringify(fullPage)), `budget ${budget}: cut but fits`).toBeGreaterThan(budget);
      } else expect(p.hits[0]).toEqual(whole.hits[0]);
    }
    expect(cuts).toBeGreaterThan(0);
  });
});
