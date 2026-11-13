import { describe, expect, it } from 'vitest';
import { blocksText, chunk } from '../../../src/core/knowledge/extract/chunk.js';
import { estimateTokens } from '../../../src/core/knowledge/extract/normalize.js';
import type { Block, Chunk } from '../../../src/core/knowledge/extract/types.js';

const OPTS = { chunkTokens: 400, maxChunkTokens: 600 };

/** Deterministic pseudo-random prose: sentences of varied length, paragraphs of varied size. */
function prose(seed: number, paragraphs: number): string {
  let x = seed;
  const rnd = () => {
    x = (x * 1103515245 + 12345) % 2147483648;
    return x / 2147483648;
  };
  const words = ['market', 'price', 'plan', 'customer', 'growth', 'churn', 'trial', 'enterprise', 'team', 'seat'];
  const paras: string[] = [];
  for (let p = 0; p < paragraphs; p++) {
    const sentences: string[] = [];
    const n = 1 + Math.floor(rnd() * 12);
    for (let s = 0; s < n; s++) {
      const len = 3 + Math.floor(rnd() * 25);
      const ws = Array.from({ length: len }, () => words[Math.floor(rnd() * words.length)]);
      sentences.push(ws.join(' ') + (rnd() < 0.2 ? '?' : '.'));
    }
    paras.push(sentences.join(' '));
  }
  return paras.join('\n\n');
}

function assertInvariants(blocks: Block[], chunks: Chunk[], opts = OPTS) {
  const full = blocksText(blocks);
  let prevEnd = 0;
  chunks.forEach((c, i) => {
    expect(c.seq).toBe(i);
    expect(c.text.length).toBeGreaterThan(0);
    expect(full.slice(c.charStart, c.charEnd)).toBe(c.text);
    expect(c.charStart).toBeGreaterThanOrEqual(prevEnd);
    expect(full.slice(prevEnd, c.charStart).trim()).toBe('');
    expect(c.tokenEstimate).toBe(estimateTokens(c.text));
    expect(c.tokenEstimate).toBeLessThanOrEqual(opts.maxChunkTokens);
    expect(c.text).toBe(c.text.trim());
    prevEnd = c.charEnd;
  });
  expect(full.slice(prevEnd).trim()).toBe('');
}

describe('chunk', () => {
  it('returns nothing for no blocks or empty blocks', () => {
    expect(chunk([], OPTS)).toEqual([]);
    expect(chunk([{ headingPath: 'A', text: '' }, { headingPath: 'B', text: '  \n ' }], OPTS)).toEqual([]);
  });

  it('keeps a small block as one chunk with its heading path and locator', () => {
    const blocks = [{ headingPath: 'Pricing > Pro', locator: 'page 2', text: 'Pro costs $10 per seat.' }];
    const chunks = chunk(blocks, OPTS);
    expect(chunks).toEqual([
      {
        seq: 0,
        headingPath: 'Pricing > Pro',
        locator: 'page 2',
        text: 'Pro costs $10 per seat.',
        charStart: 0,
        charEnd: 23,
        tokenEstimate: 6,
      },
    ]);
  });

  it('never merges across blocks (structure first)', () => {
    const blocks = [
      { headingPath: 'A', text: 'alpha' },
      { headingPath: 'B', locator: 'slide 2', text: 'beta' },
    ];
    const chunks = chunk(blocks, OPTS);
    expect(chunks.map((c) => [c.headingPath, c.locator, c.text])).toEqual([
      ['A', undefined, 'alpha'],
      ['B', 'slide 2', 'beta'],
    ]);
    assertInvariants(blocks, chunks);
  });

  it('splits long sections near chunkTokens and within maxChunkTokens', () => {
    const blocks = [
      { headingPath: 'Intro', text: prose(1, 40) },
      { headingPath: 'Body', text: prose(2, 120) },
      { headingPath: 'Tiny', text: 'short' },
    ];
    const chunks = chunk(blocks, OPTS);
    assertInvariants(blocks, chunks);
    const body = chunks.filter((c) => c.headingPath === 'Body');
    expect(body.length).toBeGreaterThan(3);
    // all but the last piece of a section are reasonably full
    for (const c of body.slice(0, -1)) expect(c.tokenEstimate).toBeGreaterThanOrEqual(OPTS.chunkTokens / 2);
  });

  it('prefers paragraph boundaries', () => {
    const para = 'word '.repeat(300).trim() + '.'; // ~1500 chars, ~375 tokens
    const blocks = [{ headingPath: '', text: [para, para, para].join('\n\n') }];
    const chunks = chunk(blocks, OPTS);
    assertInvariants(blocks, chunks);
    expect(chunks.map((c) => c.text)).toEqual([para, para, para]);
  });

  it('falls back to sentence boundaries inside a long paragraph', () => {
    const sentence = 'The enterprise plan includes priority support and audit logs. ';
    const blocks = [{ headingPath: '', text: sentence.repeat(120).trim() }];
    const chunks = chunk(blocks, OPTS);
    assertInvariants(blocks, chunks);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.text.endsWith('.')).toBe(true);
  });

  it('hard-splits text without any boundary and never splits a surrogate pair', () => {
    const blocks = [{ headingPath: '', text: '\u{1F600}'.repeat(3000) }];
    const chunks = chunk(blocks, OPTS);
    assertInvariants(blocks, chunks);
    for (const c of chunks) {
      expect(c.text.length % 2).toBe(0);
      expect(/^(?:\uD83D\uDE00)+$/.test(c.text)).toBe(true);
    }
  });

  it('respects other sizes', () => {
    const opts = { chunkTokens: 50, maxChunkTokens: 80 };
    const blocks = [{ headingPath: 'x', text: prose(3, 30) }];
    const chunks = chunk(blocks, opts);
    assertInvariants(blocks, chunks, opts);
  });

  it('treats maxChunkTokens below chunkTokens as chunkTokens', () => {
    const opts = { chunkTokens: 100, maxChunkTokens: 10 };
    const blocks = [{ headingPath: 'x', text: prose(4, 20) }];
    const chunks = chunk(blocks, opts);
    assertInvariants(blocks, chunks, { chunkTokens: 100, maxChunkTokens: 100 });
  });

  it('is deterministic', () => {
    const blocks = [
      { headingPath: 'a', text: prose(5, 60) },
      { headingPath: 'b', locator: 'page 3', text: prose(6, 60) },
    ];
    expect(JSON.stringify(chunk(blocks, OPTS))).toBe(JSON.stringify(chunk(blocks, OPTS)));
  });

  it('offsets are document-wide across blocks joined by a blank line', () => {
    const blocks = [
      { headingPath: 'a', text: 'first' },
      { headingPath: 'b', text: 'second' },
    ];
    expect(blocksText(blocks)).toBe('first\n\nsecond');
    const [, second] = chunk(blocks, OPTS);
    expect(second).toMatchObject({ charStart: 7, charEnd: 13 });
  });
});

describe('chunk performance', () => {
  it('stays linear on a long text without paragraph breaks', () => {
    const blocks = [{ headingPath: '', text: 'a,'.repeat(1_000_000) }];
    const t0 = performance.now();
    const chunks = chunk(blocks, OPTS);
    expect(performance.now() - t0).toBeLessThan(3000);
    assertInvariants(blocks, chunks);
  });
});
