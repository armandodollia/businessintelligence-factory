/**
 * Re-gate (Opus 3, nits): `pageOf` measures the last item on the page it is served on (no `truncated` /
 * `more` / `cursor` overhead), and a search's role notes are counted as the notes they are (no fixed
 * reserve), so an item is shortened only when it truly does not fit.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { estimateTokens } from '../../../src/core/knowledge/budget.js';
import { pageOf } from '../../../src/core/knowledge/readCommon.js';
import type { Store } from '../../../src/core/store/db.js';
import { ks4 } from './ks4fixture.js';

const opened: Store[] = [];
afterEach(() => {
  for (const s of opened.splice(0)) s.close();
});

describe('exact page measures (Opus 3)', () => {
  it('the last item is served whole whenever the page it is served on fits', () => {
    const header = { query: 'q', scope: 'node' };
    const item = { kind: 'fact', id: 'fnd_01M7BFHF5NEXAMPLE0000000000', title: 'x'.repeat(240) };
    for (let budget = 60; budget <= 140; budget++) {
      const served = { ...header, hits: [item], tokens: budget, truncated: false, content_trust: 'untrusted' };
      const page = pageOf([item], header, budget, { key: 'k', itemsKey: 'hits' });
      if (estimateTokens(JSON.stringify(served)) <= budget) expect(page.items[0], `budget ${budget}`).toEqual(item);
    }
  });

  it('a synthesizer search with a role note and an "elsewhere" note cuts a hit only when it truly does not fit', async () => {
    const t = ks4(opened);
    t.fact('ws_c', `Zephyr pricing ${'with a long tail of detail about tiers and seats '.repeat(4)}end`);
    t.fact('ws_d', 'Zephyr pricing in labs');
    const c = t.ctx('ws_c', 'synthesizer');
    let cuts = 0;
    for (let budget = 100; budget <= 200; budget++) {
      const p = await t.call<Record<string, unknown> & { hits: Array<Record<string, unknown>>; notes?: string[] }>(c, 'search', {
        query: 'zephyr pricing', kinds: ['fact'], include_unverified: true, max_tokens: budget,
      });
      if (/nothing of this page fits/.test(JSON.stringify(p.notes ?? []))) continue;
      const whole = await t.call<{ hits: unknown[] }>(t.ctx('ws_c', 'synthesizer'), 'search', { query: 'zephyr pricing', kinds: ['fact'], include_unverified: true });
      if (p.hits[0]?.cut === true) {
        cuts++;
        const fullPage = { ...p, hits: [whole.hits[0]] };
        expect(estimateTokens(JSON.stringify(fullPage)), `budget ${budget}: cut but fits`).toBeGreaterThan(budget);
      }
    }
    expect(cuts).toBeGreaterThan(0);
  });
});
