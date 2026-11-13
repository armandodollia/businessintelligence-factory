/**
 * Re-gate (Opus 1): `expand` pages never shorten an item that would fit a later page whole. Page 0
 * serves the header (shortened, `header_cut`, only when the header alone cannot fit); an item that does
 * not fit after it starts the next page; only an item too big for a whole page is shortened.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { estimateTokens } from '../../../src/core/knowledge/budget.js';
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
    if (!p.cursor || /nothing of this page fits/.test(JSON.stringify(p.notes ?? []))) break;
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

  it('at every budget 100-600 a cut item is too big for a later page on its own', async () => {
    const w = await world();
    const whole = await w.t.call<Page>(w.ref, 'expand', { id: w.f.id, max_tokens: 8000 });
    for (let budget = 100; budget <= 600; budget += 10) {
      const pages = await follow(w, { max_tokens: budget });
      let seen = 0;
      for (const p of pages) {
        expect(p.tokens).toBeLessThanOrEqual(budget);
        for (const it of p.items ?? []) {
          const ref = whole.items![seen]!;
          seen++;
          if (it.cut !== true) {
            expect(it, `budget ${budget}`).toEqual(ref);
            continue;
          }
          const later = { id: w.f.id, items: [ref], tokens: budget, truncated: true, more: whole.items!.length, cursor: p.cursor ?? '', content_trust: 'untrusted' };
          expect(estimateTokens(JSON.stringify(later)), `budget ${budget}: item ${seen - 1} cut but fits a later page`).toBeGreaterThan(budget);
        }
      }
    }
  });
});
