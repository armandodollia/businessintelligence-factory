import { describe, expect, it } from 'vitest';
import { imageMediaType, pageNeedsOcr, planOcr, type OcrRuleSettings } from '../../../src/core/knowledge/ocr/rules.js';

// OCR pass 1: deterministic rules decide what a model has to read (no model call here).

const S: OcrRuleSettings = { images: 'all', minPageChars: 40, maxPages: 30, maxFileBytes: 20_000_000 };
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, ...new Array(2000).fill(1)]);
const PROSE = 'The Pro plan costs 49 dollars per seat per month and includes single sign-on.';
const pdfBytes = new Uint8Array(5000);

describe('pageNeedsOcr', () => {
  it('a page with a real text layer is settled without a model', () => {
    expect(pageNeedsOcr(PROSE, 40)).toBeUndefined();
  });

  it('a page with no text, or only a page number, has no text layer', () => {
    expect(pageNeedsOcr('', 40)).toBe('no_text');
    expect(pageNeedsOcr('  12 \n', 40)).toBe('no_text');
  });

  it('a text layer of symbols or replacement characters is garbled', () => {
    expect(pageNeedsOcr('□▯◊◊□ ▯▯ ◊□▯□ ◊◊▯ □□◊▯ ▯◊□◊ ◊▯□▯ ▯□◊◊ □▯◊□ ◊□▯◊ ▯◊◊□', 40)).toBe('garbled');
    expect(pageNeedsOcr(`${'�'.repeat(12)} plan costs dollars per seat per month and more words`, 40)).toBe('garbled');
  });

  it('prose in a non-Latin script is not garbled', () => {
    expect(pageNeedsOcr('プロプランは1席あたり月額49ドルで、シングルサインオンが含まれます。年間契約では割引があります。', 40)).toBeUndefined();
  });
});

describe('imageMediaType', () => {
  it('reads the format from the bytes, not the declared mime', () => {
    expect(imageMediaType(PNG)).toBe('image/png');
    expect(imageMediaType(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg');
    expect(imageMediaType(new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39]))).toBe('image/gif');
    expect(imageMediaType(new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]))).toBe('image/webp');
    expect(imageMediaType(new Uint8Array([0x42, 0x4d, 0, 0]))).toBeUndefined();
  });
});

describe('planOcr', () => {
  it('a PDF whose pages all have text needs no model', () => {
    const plan = planOcr({ kind: 'pdf', pages: [PROSE, PROSE], bytes: pdfBytes, artifactKind: 'document' }, S);
    expect(plan).toEqual({ action: 'none' });
  });

  it('only the pages the rules cannot settle go to the model', () => {
    const plan = planOcr({ kind: 'pdf', pages: [PROSE, '', PROSE, '7'], bytes: pdfBytes, artifactKind: 'document' }, S);
    expect(plan).toEqual({ action: 'read', target: 'pdf', pages: [2, 4], leftOut: 0 });
  });

  it('caps the pages of one document and says how many were left out', () => {
    const plan = planOcr({ kind: 'pdf', pages: new Array(8).fill(''), bytes: pdfBytes, artifactKind: 'upload' }, { ...S, maxPages: 3 });
    expect(plan).toEqual({ action: 'read', target: 'pdf', pages: [1, 2, 3], leftOut: 5 });
  });

  it('skips a PDF that cannot be sent whole, with the reason', () => {
    const big = planOcr({ kind: 'pdf', pages: [''], bytes: new Uint8Array(101), artifactKind: 'document' }, { ...S, maxFileBytes: 100 });
    expect(big).toMatchObject({ action: 'skip' });
    expect((big as { reason: string }).reason).toMatch(/101 bytes/);
    const long = planOcr({ kind: 'pdf', pages: new Array(101).fill(''), bytes: pdfBytes, artifactKind: 'document' }, S);
    expect(long).toMatchObject({ action: 'skip' });
    expect((long as { reason: string }).reason).toMatch(/101 pages/);
  });

  it('a PDF that was not parsed (no page list) is left alone', () => {
    expect(planOcr({ kind: 'pdf', bytes: pdfBytes, artifactKind: 'document' }, S)).toEqual({ action: 'none' });
  });

  it('images: uploads only, all, or none', () => {
    const shot = { kind: 'image', bytes: PNG, artifactKind: 'screenshot' } as const;
    const upload = { kind: 'image', bytes: PNG, artifactKind: 'upload' } as const;
    expect(planOcr(shot, S)).toEqual({ action: 'read', target: 'image', mediaType: 'image/png' });
    expect(planOcr(shot, { ...S, images: 'uploads' })).toEqual({ action: 'none' });
    expect(planOcr(upload, { ...S, images: 'uploads' })).toEqual({ action: 'read', target: 'image', mediaType: 'image/png' });
    expect(planOcr(upload, { ...S, images: 'none' })).toEqual({ action: 'none' });
  });

  it('skips images a model cannot read: unknown format, too small, too large', () => {
    const bmp = planOcr({ kind: 'image', bytes: new Uint8Array([0x42, 0x4d, ...new Array(2000).fill(0)]), artifactKind: 'upload' }, S);
    expect(bmp).toMatchObject({ action: 'skip' });
    const tiny = planOcr({ kind: 'image', bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 9]), artifactKind: 'upload' }, S);
    expect(tiny).toEqual({ action: 'none' });
    const huge = planOcr({ kind: 'image', bytes: PNG, artifactKind: 'upload' }, { ...S, maxFileBytes: 1000 });
    expect(huge).toMatchObject({ action: 'skip' });
  });

  it('other kinds never need OCR', () => {
    expect(planOcr({ kind: 'html', bytes: pdfBytes, artifactKind: 'page_snapshot' }, S)).toEqual({ action: 'none' });
    expect(planOcr({ kind: 'docx', bytes: pdfBytes, artifactKind: 'upload' }, S)).toEqual({ action: 'none' });
  });
});
