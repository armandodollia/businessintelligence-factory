import { describe, expect, it } from 'vitest';
import { DEFAULT_EXTRACT_OPTIONS, extract } from '../../../src/core/knowledge/extract/index.js';
import { makePdf } from '../../fixtures/knowledge/build.js';

// OCR pass 1 needs the text of every PDF page, including the pages that have none.

describe('extract: pdf pages', () => {
  it('reports the text of every page in order, empty for a page without a text layer', async () => {
    const r = await extract(makePdf([['Pro plan costs 49 dollars'], null, ['Churn was 4 percent']]), 'application/pdf', DEFAULT_EXTRACT_OPTIONS);
    expect(r.status).toBe('ok');
    expect(r.pages).toHaveLength(3);
    expect(r.pages![0]).toContain('49 dollars');
    expect(r.pages![1]).toBe('');
    expect(r.pages![2]).toContain('4 percent');
    expect(r.blocks).toHaveLength(2);
  });

  it('a PDF with no text at all is empty and still lists its pages', async () => {
    const r = await extract(makePdf([null, null]), 'application/pdf', DEFAULT_EXTRACT_OPTIONS);
    expect(r).toMatchObject({ status: 'empty', pages: ['', ''] });
  });

  it('other formats have no page list', async () => {
    const r = await extract(new TextEncoder().encode('plain text'), 'text/plain', DEFAULT_EXTRACT_OPTIONS);
    expect(r.pages).toBeUndefined();
  });
});
