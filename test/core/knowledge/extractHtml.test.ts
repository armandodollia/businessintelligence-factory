import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { extract } from '../../../src/core/knowledge/extract/index.js';
import { DEFAULT_EXTRACT_OPTIONS, type Extracted } from '../../../src/core/knowledge/extract/types.js';

const FIXTURES = join(import.meta.dirname, '../../fixtures/knowledge');
const enc = new TextEncoder();
const html = (s: string, mime = 'text/html') => extract(enc.encode(s), mime, DEFAULT_EXTRACT_OPTIONS);
const allText = (r: Extracted) => r.blocks.map((b) => `${b.headingPath}\n${b.text}`).join('\n\n');

describe('extract: html article', () => {
  it('keeps headings as the heading path, paragraphs, lists, tables and alt text', async () => {
    const r = await extract(readFileSync(join(FIXTURES, 'article.html')), 'text/html; charset=utf-8', DEFAULT_EXTRACT_OPTIONS);
    expect(r.status).toBe('ok');
    expect(r.extractor).toBe('html@1');
    expect(r.blocks).toEqual([
      {
        headingPath: 'Acme raises prices for teams',
        locator: '#top',
        text:
          'By Jane Writer, 12 November 2026\n\n' +
          'Acme announced on Tuesday that its Team plan will cost $15 per seat, up from $12.\n\n' +
          'The change applies to new customers first.',
      },
      {
        headingPath: 'Acme raises prices for teams > Why now',
        locator: '#why',
        text: 'Acme cited rising infrastructure costs.\n\n- Hosting costs grew 30%.\n- Support headcount doubled.',
      },
      {
        headingPath: 'Acme raises prices for teams > Why now > Analyst view',
        text: '"Expect competitors to follow," said one analyst.',
      },
      {
        headingPath: 'Acme raises prices for teams > Plans compared',
        text:
          '| Plan | Old | New |\n| Starter | $0 | $0 |\n| Team | $12 | $15 |\n\n' +
          'Bar chart of Acme prices 2024 to 2026\n\nPrices over time',
      },
    ]);
    expect(allText(r)).not.toMatch(/LEAK|Filed under/);
  });
});

describe('extract: html app page', () => {
  it('drops nav, header, footer, aside, forms fields and embedded content', async () => {
    const r = await extract(readFileSync(join(FIXTURES, 'app-page.html')), 'text/html', DEFAULT_EXTRACT_OPTIONS);
    expect(r.status).toBe('ok');
    const text = allText(r);
    expect(text).not.toMatch(/LEAK/);
    expect(text).not.toMatch(/Home|Settings|Sidebar/);
    expect(r.blocks.find((b) => b.headingPath === 'Billing > Current plan')?.text).toBe(
      'You are on the Team plan.\nRenews on 1 December 2026.\n\nUpgrade to Enterprise\n\nCoupon',
    );
  });
});

describe('extract: html structure', () => {
  it('marks list items whose content is wrapped in blocks, and numbers ordered lists', async () => {
    const r = await html('<ul><li><p>wrapped</p></li><li></li><li>plain<ul><li>nested</li></ul></li></ul><ol><li>one</li><li>two</li></ol><p>after</p>');
    expect(r.blocks[0]?.text).toBe('- wrapped\n- plain\n- nested\n1. one\n2. two\n\nafter');
  });

  it('survives absurdly deep nesting without throwing', async () => {
    const r = await html(`${'<div>'.repeat(100_000)}deep${'</div>'.repeat(100_000)}`);
    expect(['ok', 'failed']).toContain(r.status);
  });
});

describe('extract: hostile html', () => {
  it('never includes script, style, noscript or template content', async () => {
    const r = await html(
      '<p>visible</p><script>var s = "SCRIPT1";</script><style>p{} /* STYLE1 */</style>' +
        '<noscript>NOSCRIPT1</noscript><template>TEMPLATE1</template>' +
        '<p>unclosed <b>bold <script>x="</p>SCRIPT2"</script> after</p><!-- COMMENT1 -->',
    );
    const text = allText(r);
    expect(text).toContain('visible');
    expect(text).toContain('unclosed bold after');
    expect(text).not.toMatch(/SCRIPT|STYLE|NOSCRIPT|TEMPLATE|COMMENT/);
  });

  it('drops hidden elements', async () => {
    const r = await html(
      '<p>shown</p>' +
        '<p style="display:none">HIDDEN1</p>' +
        '<p style="color:red; DISPLAY : none !important">HIDDEN2</p>' +
        '<div hidden><p>HIDDEN3</p></div>' +
        '<span aria-hidden="true">HIDDEN4</span>' +
        '<p style="visibility: hidden">HIDDEN5</p>' +
        '<p style="opacity:0">HIDDEN6</p>' +
        '<p style="font-size:0px">HIDDEN7</p>' +
        '<input type="hidden" value="HIDDEN8">' +
        '<dialog>HIDDEN9</dialog>' +
        '<div style="display:none"><div style="display:block">HIDDEN10</div></div>' +
        '<p style="opacity:0.5">half</p><dialog open>open dialog</dialog>',
    );
    const text = allText(r);
    expect(text).toContain('shown');
    expect(text).toContain('half');
    expect(text).toContain('open dialog');
    expect(text).not.toMatch(/HIDDEN/);
  });

  it('strips zero-width and bidi characters, whether literal or entity-encoded', async () => {
    const r = await html('<h1>Ti\u200Btle</h1><p>pass&#8203;word &#x202E;gnp.exe\u2066 ok\uFEFF</p>');
    expect(r.blocks).toEqual([{ headingPath: 'Title', text: 'password gnp.exe ok' }]);
  });

  it('keeps entity-encoded tags as text', async () => {
    const r = await html('<p>&lt;script&gt;alert(1)&lt;/script&gt; and &lt;b&gt;bold&lt;/b&gt;</p>');
    expect(r.blocks[0]?.text).toBe('<script>alert(1)</script> and <b>bold</b>');
  });

  it('does not execute anything', async () => {
    const g = globalThis as { __pwned?: number };
    await html('<img src="x" onerror="globalThis.__pwned=1"><body onload="globalThis.__pwned=2"><a href="javascript:globalThis.__pwned=3">link</a>');
    expect(g.__pwned).toBeUndefined();
  });

  it('reports empty when nothing visible remains', async () => {
    const r = await html('<html><head><title>t</title><script>x()</script></head><body><nav>menu</nav></body></html>');
    expect(r).toEqual({ status: 'empty', extractor: 'html@1', blocks: [] });
  });
});

describe('extract: html decoding', () => {
  it('uses the charset from the mime type', async () => {
    const bytes = new Uint8Array([...enc.encode('<p>'), 0x93, 0x71, 0x94, ...enc.encode('</p>')]);
    const r = await extract(bytes, 'text/html; charset=windows-1252', DEFAULT_EXTRACT_OPTIONS);
    expect(r.blocks[0]?.text).toBe('\u201Cq\u201D');
  });

  it('uses a meta charset when the mime type has none', async () => {
    const bytes = new Uint8Array([...enc.encode('<meta charset="windows-1252"><p>caf'), 0xe9, ...enc.encode('</p>')]);
    const r = await extract(bytes, 'text/html', DEFAULT_EXTRACT_OPTIONS);
    expect(r.blocks[0]?.text).toBe('caf\u00E9');
  });

  it('falls back to utf-8 for an unknown charset label', async () => {
    const r = await extract(enc.encode('<p>caf\u00E9</p>'), 'text/html; charset=x-bogus', DEFAULT_EXTRACT_OPTIONS);
    expect(r.blocks[0]?.text).toBe('caf\u00E9');
  });

  it('accepts xhtml', async () => {
    const r = await html('<html xmlns="http://www.w3.org/1999/xhtml"><body><p>x</p></body></html>', 'application/xhtml+xml');
    expect(r.blocks).toEqual([{ headingPath: '', text: 'x' }]);
  });
});
