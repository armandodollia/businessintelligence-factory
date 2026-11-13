import { afterEach, describe, expect, it, vi } from 'vitest';
import { blocksText, chunk, contentHash, extract, extractKind } from '../../../src/core/knowledge/extract/index.js';
import { DEFAULT_EXTRACT_OPTIONS, type ExtractOptions } from '../../../src/core/knowledge/extract/types.js';
import { makeDocx, makePdf, makePptx, makeXlsx, makeZip, PNG_BYTES } from '../../fixtures/knowledge/build.js';

const enc = new TextEncoder();
const O = DEFAULT_EXTRACT_OPTIONS;
const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const PPTX = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

describe('extract: pdf', () => {
  it('extracts text per page with page locators', async () => {
    const pdf = makePdf([['Annual report 2026', 'Revenue grew (12%) to $4m.'], null, ['Outlook: steady.']]);
    const r = await extract(pdf, 'application/pdf', O);
    expect(r.status).toBe('ok');
    expect(r.extractor).toBe('pdf@1');
    expect(r.blocks).toEqual([
      { headingPath: '', locator: 'page 1', text: 'Annual report 2026\nRevenue grew (12%) to $4m.' },
      { headingPath: '', locator: 'page 3', text: 'Outlook: steady.' },
    ]);
  });

  it('reports empty for a pdf without a text layer', async () => {
    const r = await extract(makePdf([null, null]), 'application/pdf', O);
    expect(r).toEqual({ status: 'empty', extractor: 'pdf@1', blocks: [] });
  });

  it('fails cleanly on a corrupt pdf', async () => {
    const r = await extract(enc.encode('%PDF-1.4\ngarbage that is not a pdf'), 'application/pdf', O);
    expect(r.status).toBe('failed');
    expect(r.extractor).toBe('pdf@1');
    expect(r.blocks).toEqual([]);
    expect(r.error).toBeTruthy();
  });

  it('does not detach the caller\'s buffer', async () => {
    const pdf = makePdf([['x']]);
    await extract(pdf, 'application/pdf', O);
    expect(pdf.byteLength).toBeGreaterThan(0);
    expect(pdf[0]).toBe(0x25);
  });
});

describe('extract: docx', () => {
  it('turns heading styles into the heading path and keeps paragraphs, lists and tables', async () => {
    const docx = makeDocx([
      { text: 'Preamble text.' },
      { style: 'Title', text: 'Market study' },
      { style: 'Heading1', text: 'Customers' },
      { text: 'Mostly small teams.', hiddenRun: 'HIDDEN-RUN' },
      { text: 'First reason', list: true },
      { text: 'Second reason', list: true },
      { style: 'Heading2', text: 'Segments' },
      { table: [['Segment', 'Share'], ['SMB', '60%']] },
      { text: 'Tab\tseparated' },
      { style: 'Heading1', text: 'Pricing' },
      { text: 'Per seat.' },
    ]);
    const r = await extract(docx, DOCX, O);
    expect(r.status).toBe('ok');
    expect(r.extractor).toBe('docx@1');
    expect(r.blocks).toEqual([
      { headingPath: '', text: 'Preamble text.' },
      { headingPath: 'Market study > Customers', text: 'Mostly small teams.\n\n- First reason\n- Second reason' },
      { headingPath: 'Market study > Customers > Segments', text: '| Segment | Share |\n| SMB | 60% |\n\nTab separated' },
      { headingPath: 'Market study > Pricing', text: 'Per seat.' },
    ]);
    const all = r.blocks.map((b) => b.text).join(' ');
    expect(all).not.toMatch(/HIDDEN-RUN|DELETED-TEXT|PAGE/);
  });

  it('resolves localized heading style ids through styles.xml', async () => {
    const docx = makeDocx(
      [
        { style: 'Titel', text: 'Bericht' },
        { style: 'berschrift1', text: 'Kunden' },
        { text: 'Text eins.' },
        { style: 'Gliederung', text: 'Detail' },
        { text: 'Text zwei.' },
        { style: 'berschrift2', text: 'Zwei' },
        { text: 'Text drei.' },
      ],
      { localizedStyles: true },
    );
    const r = await extract(docx, DOCX, O);
    expect(r.blocks.map((b) => [b.headingPath, b.text])).toEqual([
      ['Bericht > Kunden', 'Text eins.'],
      ['Bericht > Kunden > Detail', 'Text zwei.'],
      ['Bericht > Kunden > Zwei', 'Text drei.'],
    ]);
  });

  it('fails cleanly when the zip has no document part', async () => {
    const r = await extract(makeZip({ 'other.txt': 'x' }), DOCX, O);
    expect(r).toMatchObject({ status: 'failed', extractor: 'docx@1', blocks: [] });
    expect(r.error).toMatch(/word\/document\.xml/);
  });

  it('fails cleanly on malformed xml and never resolves external entities', async () => {
    const xxe =
      '<?xml version="1.0"?><!DOCTYPE d [<!ENTITY x SYSTEM "file:///etc/passwd">]>' +
      '<w:document xmlns:w="w"><w:body><w:p><w:r><w:t>&x;</w:t></w:r></w:p></w:body></w:document>';
    const r1 = await extract(makeZip({ 'word/document.xml': xxe }), DOCX, O);
    expect(r1.status).toBe('failed');
    expect(r1.blocks).toEqual([]);
    const r2 = await extract(makeZip({ 'word/document.xml': '<w:document><w:body><w:p>' }), DOCX, O);
    expect(r2.status).toBe('failed');
  });
});

describe('extract: pptx', () => {
  it('extracts text per slide in presentation order with slide locators', async () => {
    const pptx = makePptx([
      { title: 'Acme overview', body: ['Founded 2019', 'Remote team'] },
      { body: ['No title here'] },
      { title: 'Pricing', body: ['Team $15'] },
    ]);
    const r = await extract(pptx, PPTX, O);
    expect(r.status).toBe('ok');
    expect(r.extractor).toBe('pptx@1');
    expect(r.blocks).toEqual([
      { headingPath: 'Acme overview', locator: 'slide 1', text: 'Acme overview\n\nFounded 2019\n\nRemote team' },
      { headingPath: '', locator: 'slide 2', text: 'No title here' },
      { headingPath: 'Pricing', locator: 'slide 3', text: 'Pricing\n\nTeam $15' },
    ]);
  });
});

describe('extract: xlsx', () => {
  it('extracts each sheet as delimited rows with sheet locators', async () => {
    const xlsx = makeXlsx([
      { name: 'Revenue', rows: [['Year', 'Amount'], [2025, 1200.5], [2026, null, 'note'], ['inline:Total', true]] },
      { name: 'People', rows: [['Name'], [], ['Ann']] },
    ]);
    const r = await extract(xlsx, XLSX, O);
    expect(r.status).toBe('ok');
    expect(r.extractor).toBe('xlsx@1');
    expect(r.blocks).toEqual([
      {
        headingPath: 'Revenue',
        locator: 'sheet 1',
        text: '| Year | Amount |\n| 2025 | 1200.5 |\n| 2026 | | note |\n| Total | TRUE |',
      },
      { headingPath: 'People', locator: 'sheet 2', text: '| Name |\n| Ann |' },
    ]);
  });

  it('keeps the first xlsxMaxRows rows per sheet with a note when cut', async () => {
    const rows = Array.from({ length: 30 }, (_, i) => [`row ${i + 1}`]);
    const r = await extract(makeXlsx([{ name: 'Big', rows }]), XLSX, { ...O, xlsxMaxRows: 10 });
    const lines = r.blocks[0]!.text.split('\n');
    expect(lines).toHaveLength(11);
    expect(lines[9]).toBe('| row 10 |');
    expect(lines[10]).toBe('[truncated: first 10 of 30 rows]');
  });
});

describe('extract: text formats', () => {
  it('csv: as is, row cap with a note (quoted line breaks stay in one row)', async () => {
    const csv = 'name,notes\n"Acme","line one\nline two"\nBeta,x\nGamma,y\n';
    const ok = await extract(enc.encode(csv), 'text/csv', O);
    expect(ok).toEqual({ status: 'ok', extractor: 'csv@1', blocks: [{ headingPath: '', text: csv.trim() }] });
    const cut = await extract(enc.encode(csv), 'text/csv', { ...O, csvMaxRows: 2 });
    expect(cut.blocks[0]!.text).toBe('name,notes\n"Acme","line one\nline two"\n[truncated: first 2 of 4 rows]');
    const viaXlsxCap = await extract(enc.encode(csv), 'text/csv', { ...O, xlsxMaxRows: 3 });
    expect(viaXlsxCap.blocks[0]!.text).toMatch(/\[truncated: first 3 of 4 rows\]$/);
  });

  it('markdown: headings become the heading path; code fences are not headings', async () => {
    const md = [
      'Intro line.',
      '# Guide',
      'Welcome.',
      '## Install',
      '```sh',
      '# not a heading',
      'npm i',
      '```',
      'Setext Title',
      '============',
      'Under setext.',
      '### Deep ###',
      'Deep text.',
    ].join('\n');
    const r = await extract(enc.encode(md), 'text/markdown; charset=utf-8', O);
    expect(r.extractor).toBe('markdown@1');
    expect(r.blocks).toEqual([
      { headingPath: '', text: 'Intro line.' },
      { headingPath: 'Guide', text: 'Welcome.' },
      { headingPath: 'Guide > Install', text: '```sh\n# not a heading\nnpm i\n```' },
      { headingPath: 'Setext Title', text: 'Under setext.' },
      { headingPath: 'Setext Title > Deep', text: 'Deep text.' },
    ]);
  });

  it('markdown: front matter is body text', async () => {
    const r = await extract(enc.encode('---\ntitle: x\n---\n# H\nbody'), 'text/markdown', O);
    expect(r.blocks).toEqual([
      { headingPath: '', text: '---\ntitle: x\n---' },
      { headingPath: 'H', text: 'body' },
    ]);
  });

  it('json: as is', async () => {
    const json = '{"plan":"Team","price":15}';
    expect(await extract(enc.encode(json), 'application/json', O)).toEqual({
      status: 'ok',
      extractor: 'json@1',
      blocks: [{ headingPath: '', text: json }],
    });
    expect((await extract(enc.encode(json), 'application/ld+json', O)).extractor).toBe('json@1');
  });

  it('plain text: as is, normalized', async () => {
    const r = await extract(enc.encode('\uFEFFhello\u200B  world\r\n'), 'text/plain', O);
    expect(r).toEqual({ status: 'ok', extractor: 'text@1', blocks: [{ headingPath: '', text: 'hello world' }] });
  });

  it('empty input is empty', async () => {
    expect((await extract(new Uint8Array(), 'text/plain', O)).status).toBe('empty');
    expect((await extract(enc.encode(' \n\u200B'), 'text/markdown', O)).status).toBe('empty');
  });
});

describe('extract: unsupported types', () => {
  it('png has no text: unsupported', async () => {
    expect(await extract(PNG_BYTES, 'image/png', O)).toEqual({ status: 'unsupported', extractor: 'image@1', blocks: [] });
  });

  it('unknown types are unsupported', async () => {
    expect(await extract(enc.encode('x'), 'application/x-unknown', O)).toEqual({ status: 'unsupported', extractor: 'none@1', blocks: [] });
    expect((await extract(enc.encode('MIME-Version: 1.0'), 'message/rfc822', O)).status).toBe('unsupported');
  });
});

describe('extract: type detection for generic mimes', () => {
  it('sniffs pdf, office zips and images from the bytes', () => {
    expect(extractKind(makePdf([['x']]), 'application/octet-stream')).toBe('pdf');
    expect(extractKind(makeDocx([{ text: 'x' }]), 'application/octet-stream')).toBe('docx');
    expect(extractKind(makePptx([{ body: ['x'] }]), '')).toBe('pptx');
    expect(extractKind(makeXlsx([{ name: 's', rows: [['x']] }]), 'application/zip')).toBe('xlsx');
    expect(extractKind(PNG_BYTES, 'application/octet-stream')).toBe('image');
  });

  it('falls back to the file name extension, then unsupported', async () => {
    expect(extractKind(enc.encode('# x'), 'application/octet-stream', 'notes.MD')).toBe('markdown');
    expect(extractKind(enc.encode('a,b'), 'application/octet-stream', 'data.csv')).toBe('csv');
    expect(extractKind(enc.encode('x'), 'application/octet-stream', 'blob.bin')).toBe('none');
    expect(extractKind(enc.encode('x'), 'application/octet-stream')).toBe('none');
    const r = await extract(makeDocx([{ text: 'from upload' }]), 'application/octet-stream', { ...O, filename: 'a.docx' });
    expect(r.blocks).toEqual([{ headingPath: '', text: 'from upload' }]);
  });

  it('trusts a specific mime over the bytes', () => {
    expect(extractKind(makePdf([['x']]), 'text/plain')).toBe('text');
  });
});

describe('extract: size caps', () => {
  it('input over maxInputBytes is too_large without parsing', async () => {
    const r = await extract(enc.encode('<p>hello world</p>'), 'text/html', { ...O, maxInputBytes: 5 });
    expect(r).toMatchObject({ status: 'too_large', extractor: 'html@1', blocks: [] });
    expect(r.error).toMatch(/limit is 5/);
  });

  it('text over maxTextChars is too_large with the blocks cut at the cap', async () => {
    const md = `# A\n${'alpha '.repeat(20)}\n# B\n${'beta '.repeat(20)}\n# C\ngamma`;
    const opts: ExtractOptions = { ...O, maxTextChars: 150 };
    const r = await extract(enc.encode(md), 'text/markdown', opts);
    expect(r.status).toBe('too_large');
    expect(r.error).toMatch(/maxTextChars \(150\)/);
    expect(blocksText(r.blocks).length).toBeLessThanOrEqual(150);
    expect(r.blocks.map((b) => b.headingPath)).toEqual(['A', 'B']);
    expect(r.blocks[0]!.text).toBe('alpha '.repeat(20).trim());
    expect(r.blocks[1]!.text.startsWith('beta beta')).toBe(true);
  });

  it('text exactly at maxTextChars is ok', async () => {
    const r = await extract(enc.encode('x'.repeat(100)), 'text/plain', { ...O, maxTextChars: 100 });
    expect(r.status).toBe('ok');
  });

  it('office zips whose parts declare more than maxUnzippedBytes are too_large', async () => {
    const docx = makeDocx([{ text: 'x'.repeat(5000) }]);
    const r = await extract(docx, DOCX, { ...O, maxUnzippedBytes: 1000 });
    expect(r).toMatchObject({ status: 'too_large', extractor: 'docx@1', blocks: [] });
  });

  it('a zip bomb is refused before inflating', async () => {
    const bomb = makeZip({ 'word/document.xml': `<w:document>${' '.repeat(50 * 1024 * 1024)}</w:document>` });
    expect(bomb.byteLength).toBeLessThan(200_000);
    const r = await extract(bomb, DOCX, { ...O, maxUnzippedBytes: 10 * 1024 * 1024 });
    expect(r.status).toBe('too_large');
  });
});

describe('extract: failure isolation', () => {
  it('never throws on garbage for any type', async () => {
    const garbage = new Uint8Array(Array.from({ length: 512 }, (_, i) => (i * 7919) % 256));
    for (const mime of ['application/pdf', DOCX, PPTX, XLSX, 'text/html', 'text/csv', 'text/markdown', 'application/json', 'application/octet-stream']) {
      const r = await extract(garbage, mime, O);
      expect(['failed', 'ok', 'empty', 'unsupported']).toContain(r.status);
      if (r.status === 'failed') expect(r.error && r.error.length).toBeLessThanOrEqual(301);
    }
  });

  it('error messages are one bounded line', async () => {
    const r = await extract(enc.encode('PK\u0003\u0004 not really a zip'), DOCX, O);
    expect(r.status).toBe('failed');
    expect(r.error).not.toMatch(/\n/);
  });
});

describe('extract: no network', () => {
  afterEach(() => vi.restoreAllMocks());

  it('never calls fetch for any type', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network used'));
    const inputs: [Uint8Array, string][] = [
      [makePdf([['text'], null]), 'application/pdf'],
      [makeDocx([{ text: 'x' }]), DOCX],
      [makePptx([{ body: ['x'] }]), PPTX],
      [makeXlsx([{ name: 's', rows: [['x']] }]), XLSX],
      [enc.encode('<link rel="stylesheet" href="https://example.com/a.css"><img src="https://example.com/i.png" alt="a"><iframe src="https://example.com"></iframe>'), 'text/html'],
    ];
    for (const [bytes, mime] of inputs) expect((await extract(bytes, mime, O)).status).toBe('ok');
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('extract → chunk → hash', () => {
  it('is deterministic end to end', async () => {
    const docx = makeDocx([
      { style: 'Heading1', text: 'One' },
      ...Array.from({ length: 80 }, (_, i) => ({ text: `Paragraph ${i} about pricing, churn and growth in the SMB segment.` })),
    ]);
    const a = await extract(docx, DOCX, O);
    const b = await extract(docx, DOCX, O);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(contentHash(a.blocks)).toBe(contentHash(b.blocks));
    const chunks = chunk(a.blocks, { chunkTokens: 400, maxChunkTokens: 600 });
    expect(chunks.length).toBeGreaterThan(1);
    const full = blocksText(a.blocks);
    for (const c of chunks) expect(full.slice(c.charStart, c.charEnd)).toBe(c.text);
  });

  it('same text in different bytes hashes the same', async () => {
    const a = await extract(enc.encode('<p>Pro plan: $10</p><script>ad1()</script>'), 'text/html', O);
    const b = await extract(enc.encode('<p>Pro   plan: $10</p><script>ad2()</script><!-- ts 123 -->'), 'text/html', O);
    expect(contentHash(a.blocks)).toBe(contentHash(b.blocks));
  });
});
