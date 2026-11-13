/**
 * `expand` pages never shorten an item that would fit a later page whole (re-gate, Opus 1; paging
 * rework). Page 0 serves the whole header (never cut); an item that does not fit after others starts the
 * next page; only an item too big for a page on its own is cut, with a measured pointer.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { estimateTokens } from '../../../src/core/knowledge/budget.js';
import { READ_FLOOR_TOKENS } from '../../../src/core/knowledge/tools.js';
import type { Store } from '../../../src/core/store/db.js';
import { knowledgeRepos } from '../../../src/core/store/repos.js';
import { ks4 } from './ks4fixture.js';

const opened: Store[] = [];
afterEach(() => {
  for (const s of opened.splice(0)) s.close();
});

type Page = Record<string, unknown> & { items?: Array<Record<string, unknown>>; cursor?: string; notes?: string[]; tokens: number };

async function world() {
  // The orchestrator's expand budget is raised so one call returns the whole reference list.
  const t = ks4(opened, (c) => {
    c.knowledge = { budgets: { roles: { orchestrator: { expand: 8000 } } }, hardMaxTokens: 8000 };
  });
  const a = await t.page('ws_a', 'Acme pricing page body. '.repeat(50));
  const b = await t.page('ws_a', 'Other page. '.repeat(30));
  const f = t.fact('ws_a', `Acme pricing: ${'the Pro plan tiers and seat prices differ by region and contract length; '.repeat(40)}`, {
    evidence: [a.id, b.id], criteria: { source_quality: 'primary pricing page and two partner sheets. '.repeat(12), recency: 'checked this week. '.repeat(10) } as never,
  });
  const fe = knowledgeRepos(t.store).findingEvidence;
  for (let i = 0; i < 9; i++) fe.insert({ findingId: f.id, seq: i, artifactId: a.id, quote: `Q${i} ${'pricing detail sentence. '.repeat(24)}` });
  fe.insert({ findingId: f.id, seq: 9, artifactId: b.id, quote: 'Other page.' });
  return { t, f, c: t.ctx('ws_a'), ref: t.ctx('ws_a', 'orchestrator') };
}

async function follow(w: Awaited<ReturnType<typeof world>>, input: Record<string, unknown>) {
  const pages: Page[] = [];
  let cursor: string | undefined;
  for (let i = 0; i < 80; i++) {
    const p = await w.t.call<Page>(w.c, 'expand', { id: w.f.id, ...input, ...(cursor ? { cursor } : {}) });
    pages.push(p);
    expect(JSON.stringify(p.notes ?? [])).not.toMatch(/nothing|raised/);
    if (!p.cursor) break;
    expect(p.cursor).not.toBe(cursor);
    cursor = p.cursor;
  }
  return pages;
}

describe('expand pages: header first, an item never cut when a later page holds it whole (Opus 1)', () => {
  it('at the default budget the long fact is not cut: its items start the next page whole', async () => {
    const w = await world();
    const whole = await w.t.call<Page>(w.ref, 'expand', { id: w.f.id, max_tokens: 8000 });
    const pages = await follow(w, {});
    expect(pages[0]!.header_cut).toBeUndefined();
    const items = pages.flatMap((p) => p.items ?? []);
    expect(items.some((i) => i.cut === true)).toBe(false);
    expect(items).toEqual(whole.items);
  });

  it('at every budget from the floor to 600 a cut item is too big for a later page on its own', async () => {
    const w = await world();
    const whole = await w.t.call<Page>(w.ref, 'expand', { id: w.f.id, max_tokens: 8000 });
    for (let budget = READ_FLOOR_TOKENS.expand; budget <= 600; budget += 10) {
      const pages = await follow(w, { max_tokens: budget });
      let seen = 0;
      for (const p of pages) {
        expect(p.tokens).toBeLessThanOrEqual(budget);
        expect(p.items!.length, `budget ${budget}: every page serves an item`).toBeGreaterThan(0);
        for (const it of p.items ?? []) {
          const ref = whole.items![seen]!;
          seen++;
          if (it.cut !== true) {
            expect(it, `budget ${budget}`).toEqual(ref);
            continue;
          }
          // Its pointer asks for the measured later page that holds it (no header there), larger than this budget.
          const later = { items: [ref], tokens: budget, truncated: true, more: whole.items!.length, cursor: p.cursor ?? '', content_trust: 'untrusted' };
          const m = (it.full as { input: { max_tokens: number } }).input.max_tokens;
          if (p !== pages[0]) expect(m, `budget ${budget}`).toBeGreaterThan(budget);
          expect(estimateTokens(JSON.stringify(later)), `budget ${budget}: item ${seen - 1} cut but fits a later page`).toBeGreaterThan(budget);
        }
      }
    }
  });
});
