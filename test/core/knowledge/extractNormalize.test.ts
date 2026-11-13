import { describe, expect, it } from 'vitest';
import { contentHash, estimateTokens, normalizeText } from '../../../src/core/knowledge/extract/normalize.js';
import { urlKey } from '../../../src/core/knowledge/extract/urlKey.js';

describe('normalizeText', () => {
  it('strips zero-width characters', () => {
    expect(normalizeText('pa\u200Bss\u200Cw\u200Dor\u2060d\uFEFF')).toBe('password');
  });

  it('strips bidi control characters', () => {
    const s = 'a\u202Eb\u202Ac\u2066d\u2069e\u200Ef\u200Fg\u061Ch\u202Bi\u202Cj\u202Dk\u2067l\u2068m';
    expect(normalizeText(s)).toBe('abcdefghijklm');
  });

  it('strips invisible tag characters and soft hyphens', () => {
    const tagged = 'ok' + String.fromCodePoint(0xe0049, 0xe0067, 0xe006e) + '!';
    expect(normalizeText(tagged)).toBe('ok!');
    expect(normalizeText('co\u00ADoperate')).toBe('cooperate');
  });

  it('removes control characters but keeps line structure', () => {
    expect(normalizeText('a\u0000b\u0007c\td')).toBe('abc d');
    expect(normalizeText('line one\r\nline two\rline three')).toBe('line one\nline two\nline three');
  });

  it('collapses whitespace runs, trims lines and caps blank lines at one', () => {
    expect(normalizeText('  a \u00A0\u2003 b  \n\n\n\n   c  \n')).toBe('a b\n\nc');
    expect(normalizeText('x\u2028y\u2029z')).toBe('x\ny\nz');
  });

  it('applies Unicode NFC', () => {
    expect(normalizeText('e\u0301')).toBe('\u00E9');
    expect(normalizeText('e\u200B\u0301')).toBe('\u00E9');
  });

  it('is idempotent', () => {
    const s = ' \u200B a\u202E  b \n\n\n c\u00A0d ';
    expect(normalizeText(normalizeText(s))).toBe(normalizeText(s));
  });

  it('returns empty for whitespace-only input', () => {
    expect(normalizeText(' \n\t\u200B ')).toBe('');
  });
});

describe('estimateTokens', () => {
  it('is ceil(chars / 4)', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('a')).toBe(1);
    expect(estimateTokens('abcd')).toBe(1);
    expect(estimateTokens('abcde')).toBe(2);
    expect(estimateTokens('x'.repeat(1600))).toBe(400);
  });
});

describe('contentHash', () => {
  it('is a sha256 hex digest', () => {
    expect(contentHash([{ headingPath: '', text: 'hello' }])).toMatch(/^[0-9a-f]{64}$/);
  });

  it('ignores differences removed by normalization', () => {
    const a = contentHash([{ headingPath: 'Pricing', text: 'Pro  plan\u200B costs $10' }]);
    const b = contentHash([{ headingPath: ' Pricing ', text: 'Pro plan costs $10\n\n\n' }]);
    expect(a).toBe(b);
  });

  it('ignores locators and empty blocks', () => {
    const a = contentHash([{ headingPath: '', locator: 'page 1', text: 'x' }, { headingPath: '', text: '  ' }]);
    const b = contentHash([{ headingPath: '', locator: 'page 9', text: 'x' }]);
    expect(a).toBe(b);
  });

  it('changes when text or headings change', () => {
    const base = contentHash([{ headingPath: 'A', text: 'one' }]);
    expect(contentHash([{ headingPath: 'A', text: 'two' }])).not.toBe(base);
    expect(contentHash([{ headingPath: 'B', text: 'one' }])).not.toBe(base);
  });

  it('does not let block boundaries collide', () => {
    const a = contentHash([{ headingPath: '', text: 'ab' }, { headingPath: '', text: 'c' }]);
    const b = contentHash([{ headingPath: '', text: 'a' }, { headingPath: '', text: 'bc' }]);
    expect(a).not.toBe(b);
  });
});

describe('urlKey', () => {
  it('passes undefined and unparseable input through as undefined', () => {
    expect(urlKey(undefined)).toBeUndefined();
    expect(urlKey('')).toBeUndefined();
    expect(urlKey('not a url')).toBeUndefined();
  });

  it('lowercases the host and drops www.', () => {
    expect(urlKey('https://WWW.Example.COM/Path')).toBe('https://example.com/Path');
  });

  it('drops the fragment and the trailing slash', () => {
    expect(urlKey('https://example.com/pricing/#plans')).toBe('https://example.com/pricing');
    expect(urlKey('https://example.com/')).toBe('https://example.com');
    expect(urlKey('https://example.com')).toBe('https://example.com');
  });

  it('drops tracking parameters and keeps the rest in order', () => {
    expect(
      urlKey('https://example.com/a?utm_source=x&b=2&gclid=1&fbclid=2&mc_cid=3&mc_eid=4&ref=hn&UTM_Medium=y&a=1'),
    ).toBe('https://example.com/a?b=2&a=1');
    expect(urlKey('https://example.com/a/?utm_campaign=z')).toBe('https://example.com/a');
    expect(urlKey('https://example.com/a?referrer=keep')).toBe('https://example.com/a?referrer=keep');
  });

  it('drops credentials and default ports', () => {
    expect(urlKey('https://user:secret@example.com:443/x')).toBe('https://example.com/x');
    expect(urlKey('http://example.com:8080/x')).toBe('http://example.com:8080/x');
  });

  it('keeps the scheme and path case', () => {
    expect(urlKey('http://example.com/Docs')).toBe('http://example.com/Docs');
  });

  it('returns undefined for non-web schemes', () => {
    expect(urlKey('mailto:a@example.com')).toBeUndefined();
    expect(urlKey('data:text/html,<p>x</p>')).toBeUndefined();
    expect(urlKey('file:///etc/passwd')).toBeUndefined();
    expect(urlKey('javascript:alert(1)')).toBeUndefined();
  });

  it('trims surrounding whitespace', () => {
    expect(urlKey('  https://example.com/a  ')).toBe('https://example.com/a');
  });

  it('gives the same key for variants of one page', () => {
    const keys = new Set(
      [
        'https://www.example.com/pricing',
        'https://example.com/pricing/',
        'https://EXAMPLE.com/pricing#top',
        'https://example.com/pricing?utm_source=newsletter',
      ].map(urlKey),
    );
    expect(keys.size).toBe(1);
  });
});
