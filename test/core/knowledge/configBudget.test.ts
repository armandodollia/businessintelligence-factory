import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../../../src/core/config/load.js';
import { defaultConfig, KNOWLEDGE_DEFAULTS, type BifConfig } from '../../../src/core/config/schema.js';
import {
  budgetFor,
  cursorKey,
  decodeCursor,
  encodeCursor,
  estimateTokens,
  fitPage,
  fitToBudget,
  InvalidCursorError,
  truncateToTokens,
} from '../../../src/core/knowledge/budget.js';
import { knowledgeSettings } from '../../../src/core/knowledge/config.js';

function writeConfig(content: unknown): string {
  const file = join(mkdtempSync(join(tmpdir(), 'bif-kcfg-')), 'bif.config.json');
  writeFileSync(file, JSON.stringify(content));
  return file;
}

const withKnowledge = (knowledge: BifConfig['knowledge']): BifConfig => ({ ...structuredClone(defaultConfig), knowledge });

describe('config.knowledge (KS-0)', () => {
  it('is optional: existing configs (defaults, the example file) load unchanged and get every default', () => {
    expect(loadConfig().knowledge).toBeUndefined();
    const example = JSON.parse(readFileSync(join(process.cwd(), 'bif.config.example.json'), 'utf8')) as Record<string, unknown>;
    expect(() => loadConfig(writeConfig(example))).not.toThrow();
    expect(knowledgeSettings(defaultConfig)).toEqual({
      budgets: {
        default: { search: 1200, card: 800, expand: 2000, briefing: 1500 },
        roles: { reviewer: { expand: 3000 }, synthesizer: { briefing: 4000 } },
        providers: {},
      },
      hardMaxTokens: 8000,
      freshness: { defaultDays: 90, byEntityKind: {} },
      extraction: { maxTextChars: 2_000_000, chunkTokens: 400, maxChunkTokens: 600, xlsxMaxRows: 2000, inlineMaxBytes: 1_048_576, concurrency: 1 },
      captions: { required: true, minChars: 20 },
      dedupe: { candidateLimit: 3, similarityFloor: 0.5 },
      retention: { pruneMinAgeDays: 90 },
    });
  });

  it('merges a partial block over the defaults, per field and per role', () => {
    const cfg = loadConfig(writeConfig({
      knowledge: {
        budgets: { default: { search: 900 }, roles: { reviewer: { card: 500 }, worker: { expand: 2500 } }, providers: { codex: 0.5 } },
        freshness: { byEntityKind: { competitor: 30 } },
        captions: { minChars: 40 },
      },
    }));
    const k = knowledgeSettings(cfg);
    expect(k.budgets.default).toEqual({ search: 900, card: 800, expand: 2000, briefing: 1500 });
    expect(k.budgets.roles.reviewer).toEqual({ expand: 3000, card: 500 });
    expect(k.budgets.roles.worker).toEqual({ expand: 2500 });
    expect(k.budgets.roles.synthesizer).toEqual({ briefing: 4000 });
    expect(k.budgets.providers).toEqual({ codex: 0.5 });
    expect(k.freshness).toEqual({ defaultDays: 90, byEntityKind: { competitor: 30 } });
    expect(k.captions).toEqual({ required: true, minChars: 40 });
    // Settings never alias the shared defaults.
    k.budgets.default.search = 1;
    expect(KNOWLEDGE_DEFAULTS.budgets.default.search).toBe(1200);
  });

  it('rejects invalid values with the offending path', () => {
    const bad: Array<[unknown, string]> = [
      [{ budgets: { default: { search: 0 } } }, 'knowledge.budgets.default.search'],
      [{ budgets: { roles: { nobody: { search: 10 } } } }, 'knowledge.budgets.roles'],
      [{ freshness: { byEntityKind: { planet: 3 } } }, 'knowledge.freshness.byEntityKind'],
      [{ extraction: { chunkTokens: 700 } }, 'knowledge.extraction.chunkTokens'],
      [{ dedupe: { similarityFloor: 2 } }, 'knowledge.dedupe.similarityFloor'],
      [{ unknownKey: true }, 'knowledge'],
    ];
    for (const [knowledge, path] of bad) {
      let err: unknown;
      try {
        loadConfig(writeConfig({ knowledge }));
      } catch (e) {
        err = e;
      }
      expect(err, JSON.stringify(knowledge)).toBeInstanceOf(ConfigError);
      expect((err as ConfigError).message).toContain(path);
    }
  });
});

describe('budgets (KS-0)', () => {
  it('budgetFor: role override, else default; provider scale; hard cap; caller may lower it or raise it up to the hard maximum (re-gate)', () => {
    expect(budgetFor(defaultConfig, 'worker', 'claude', 'search')).toBe(1200);
    expect(budgetFor(defaultConfig, 'reviewer', 'codex', 'expand')).toBe(3000);
    expect(budgetFor(defaultConfig, 'reviewer', 'codex', 'search')).toBe(1200);
    expect(budgetFor(defaultConfig, 'synthesizer', 'claude', 'briefing')).toBe(4000);
    expect(budgetFor(defaultConfig, 'user', undefined, 'card')).toBe(800);
    const cfg = withKnowledge({
      budgets: { roles: { worker: { expand: 50_000 } }, providers: { codex: 0.5 } },
      hardMaxTokens: 6000,
    });
    expect(budgetFor(cfg, 'worker', 'claude', 'expand')).toBe(6000); // hard cap
    expect(budgetFor(cfg, 'worker', 'codex', 'search')).toBe(600); // scaled
    expect(budgetFor(cfg, 'worker', 'claude', 'search', 300)).toBe(300); // caller lowers
    expect(budgetFor(cfg, 'worker', 'claude', 'search', 2000)).toBe(2000); // caller raises (recovery pointers)
    expect(budgetFor(cfg, 'worker', 'claude', 'search', 99_999)).toBe(6000); // up to the hard maximum
    expect(budgetFor(cfg, 'worker', 'codex', 'search', 99_999)).toBe(3000); // scaled for the provider
    expect(budgetFor(cfg, 'worker', 'claude', 'search', 0)).toBe(1); // never below 1
  });

  it('fitToBudget keeps a prefix within the budget and reports what it dropped', () => {
    const items = ['a'.repeat(39), 'b'.repeat(39), 'c'.repeat(39), 'd'.repeat(39)]; // 10 tokens each with separator
    const fit = fitToBudget(items, (s) => s, 25);
    expect(fit).toEqual({ items: items.slice(0, 2), tokens: 20, truncated: true, more: 2 });
    expect(fitToBudget(items, (s) => s, 40)).toEqual({ items, tokens: 40, truncated: false, more: 0 });
    expect(fitToBudget(items, (s) => s, 40, 5)).toMatchObject({ items: items.slice(0, 3), tokens: 35, more: 1 }); // tokens include the overhead
    expect(fitToBudget([], (s: string) => s, 10)).toEqual({ items: [], tokens: 0, truncated: false, more: 0 });
    // Stops at the first item that does not fit (prefix only, so cursors never skip anything).
    expect(fitToBudget(['x'.repeat(400), 'y'], (s) => s, 50)).toEqual({ items: [], tokens: 0, truncated: true, more: 2 });
  });

  it('truncateToTokens cuts long text within the budget without splitting a surrogate pair', () => {
    expect(truncateToTokens('short', 10)).toEqual({ text: 'short', truncated: false });
    const cut = truncateToTokens('word '.repeat(100), 10);
    expect(cut.truncated).toBe(true);
    expect(estimateTokens(cut.text)).toBeLessThanOrEqual(10);
    const emoji = truncateToTokens('😀'.repeat(50), 3); // 12 UTF-16 units allowed
    expect(emoji.text).toBe('😀'.repeat(6));
    expect(truncateToTokens('a😀😀', 1).text).toBe('a😀'); // the cut would split the second pair
  });

  it('cursors are opaque, bound to their request, and reject tampering', () => {
    const key = cursorKey({ tool: 'search', query: 'pricing', kinds: ['fact'] });
    expect(cursorKey({ kinds: ['fact'], query: 'pricing', tool: 'search' })).toBe(key); // key order irrelevant
    expect(cursorKey({ tool: 'search', query: 'pricing!', kinds: ['fact'] })).not.toBe(key);
    const c = encodeCursor({ key, offset: 7 });
    expect(c).toMatch(/^c1\.[0-9a-f]{16}\.7\.[0-9a-f]{8}$/);
    expect(decodeCursor(c, key)).toBe(7);
    expect(() => decodeCursor(c, cursorKey({ other: true }))).toThrow(InvalidCursorError);
    for (const bad of ['', 'garbage', encodeCursor({ key, offset: -1 }), Buffer.from('{"v":1}').toString('base64url'), `c1.${key}.07.x`, `c1.${key}.1.0.x`]) {
      expect(() => decodeCursor(bad, key), bad).toThrow(InvalidCursorError);
    }
  });

  it('fitPage pages through everything with no loss or repeat, every page within budget', () => {
    const all = Array.from({ length: 23 }, (_, i) => `item ${i} `.padEnd(10 + (i % 7) * 9, '.'));
    const key = cursorKey({ q: 'all' });
    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = fitPage(all, (s) => s, 30, { key, cursor, overhead: 2 });
      expect(page.tokens).toBeLessThanOrEqual(30); // includes the overhead
      expect(page.items.length).toBeGreaterThan(0);
      seen.push(...page.items);
      expect(page.more).toBe(all.length - seen.length);
      expect(page.truncated).toBe(page.more > 0);
      cursor = page.cursor;
      pages++;
    } while (cursor);
    expect(seen).toEqual(all);
    expect(pages).toBeGreaterThan(2);
    expect(() => fitPage(all, (s) => s, 30, { key: cursorKey({ q: 'other' }), cursor: encodeCursor({ key, offset: 3 }) })).toThrow(InvalidCursorError);
  });
});
