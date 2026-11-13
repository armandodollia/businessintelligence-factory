import { parse, type DefaultTreeAdapterMap } from 'parse5';
import { pipeRow, SectionBuilder, type ParaKind } from './sections.js';
import { decodeBytes } from './text.js';
import type { Block } from './types.js';

type Node = DefaultTreeAdapterMap['node'];
type Element = DefaultTreeAdapterMap['element'];
type ParentNode = DefaultTreeAdapterMap['parentNode'];

/**
 * HTML → blocks (design §8.2). parse5 is a WHATWG tokenizer/tree builder: it never runs scripts,
 * fetches resources or applies CSS. Dropped: script, style, noscript, template, svg, math,
 * iframe and other embedded content, form fields, hidden elements (`hidden`, `aria-hidden`,
 * inline `display:none` / `visibility:hidden` / `opacity:0` / `font-size:0`, closed `<dialog>`),
 * and nav / aside / footer / page-level header boilerplate (also by ARIA role). Kept: headings
 * (as the heading path), paragraphs, lists, tables (pipe rows) and image alt text.
 * Limitation: hiding through stylesheet classes is not detected (no CSS engine).
 */

const DROP = new Set([
  'head', 'script', 'style', 'noscript', 'template', 'svg', 'math', 'iframe', 'frame', 'frameset',
  'object', 'embed', 'applet', 'canvas', 'audio', 'video', 'map', 'input', 'select', 'datalist',
  'textarea', 'option', 'optgroup', 'nav', 'aside', 'footer', 'link', 'meta', 'base', 'title',
]);
const DROP_ROLES = new Set(['navigation', 'banner', 'contentinfo', 'complementary']);
const SECTIONING = new Set(['article', 'main', 'section']);
const BLOCK = new Set([
  'address', 'article', 'blockquote', 'body', 'caption', 'center', 'dd', 'details', 'dialog', 'dir',
  'div', 'dl', 'dt', 'fieldset', 'figcaption', 'figure', 'form', 'header', 'hgroup', 'hr', 'html',
  'legend', 'li', 'main', 'menu', 'ol', 'p', 'pre', 'section', 'summary', 'table', 'tbody', 'td',
  'tfoot', 'th', 'thead', 'tr', 'ul',
]);
const HEADING = /^h([1-6])$/;

const isElement = (n: Node): n is Element => 'tagName' in n;
const attr = (el: Element, name: string) => el.attrs.find((a) => a.name === name)?.value;

/** `0`, `0.0`, `.0`, `0px`, `0%`, ... */
const ZERO = /^(?:0+(?:\.0*)?|\.0+)(?:[a-z]+|%)?$/;

function hiddenByStyle(style: string): boolean {
  const decls = style.replace(/\/\*[\s\S]*?\*\//g, '').toLowerCase().split(';');
  for (const d of decls) {
    const i = d.indexOf(':');
    if (i < 0) continue;
    const prop = d.slice(0, i).trim();
    const value = d.slice(i + 1).replace(/!\s*important/, '').trim();
    if (prop === 'display' && value === 'none') return true;
    if (prop === 'visibility' && (value === 'hidden' || value === 'collapse')) return true;
    if (prop === 'content-visibility' && value === 'hidden') return true;
    if ((prop === 'opacity' || prop === 'font-size') && ZERO.test(value)) return true;
  }
  return false;
}

function dropped(el: Element, inSection: boolean): boolean {
  const tag = el.tagName;
  if (DROP.has(tag)) return true;
  if (tag === 'header' && !inSection) return true;
  if (tag === 'dialog' && attr(el, 'open') === undefined) return true;
  if (attr(el, 'hidden') !== undefined) return true;
  if (attr(el, 'aria-hidden')?.trim().toLowerCase() === 'true') return true;
  const role = attr(el, 'role')?.trim().toLowerCase();
  if (role && DROP_ROLES.has(role)) return true;
  const style = attr(el, 'style');
  return style !== undefined && hiddenByStyle(style);
}

/** Visible text of a subtree flattened to one line (table cells, headings). */
function flatText(node: ParentNode, inSection: boolean): string {
  let out = '';
  for (const child of node.childNodes) {
    if (child.nodeName === '#text') out += (child as DefaultTreeAdapterMap['textNode']).value;
    else if (isElement(child)) {
      if (dropped(child, inSection)) continue;
      if (child.tagName === 'img') out += ` ${attr(child, 'alt') ?? ''} `;
      else if (child.tagName === 'br' || BLOCK.has(child.tagName)) out += ` ${flatText(child, inSection)} `;
      else out += flatText(child, inSection || SECTIONING.has(child.tagName));
    }
  }
  return out.replace(/\s+/g, ' ').trim();
}

class Walker {
  readonly out = new SectionBuilder();
  private buf = '';
  private kind: ParaKind = 'p';
  private prefix = '';
  private pre = 0;

  private flushPara() {
    const text = this.buf
      .split('\n')
      .map((l) => (this.pre ? l.replace(/\s+$/, '') : l.trim()))
      .join('\n')
      .replace(/^\n+|\n+$/g, '');
    this.buf = '';
    if (!text.trim()) return;
    this.out.para(this.kind, this.prefix + text);
    // A list item's marker goes on its first non-empty paragraph only.
    this.prefix = '';
    this.kind = 'p';
  }

  finish(): Block[] {
    this.flushPara();
    return this.out.finish();
  }

  walk(node: ParentNode, inSection: boolean) {
    for (const child of node.childNodes) {
      if (child.nodeName === '#text') {
        const v = (child as DefaultTreeAdapterMap['textNode']).value;
        this.buf += this.pre ? v : v.replace(/[ \t\n\r\f]+/g, ' ');
        continue;
      }
      if (!isElement(child) || dropped(child, inSection)) continue;
      this.element(child, inSection || SECTIONING.has(child.tagName));
    }
  }

  private element(el: Element, inSection: boolean) {
    const tag = el.tagName;
    const h = HEADING.exec(tag);
    if (h) {
      const title = flatText(el, inSection);
      if (!title) return;
      this.flushPara();
      const id = attr(el, 'id')?.trim();
      this.out.heading(Number(h[1]), title, id ? `#${id}` : undefined);
      return;
    }
    if (tag === 'br') {
      this.buf += '\n';
      return;
    }
    if (tag === 'img') {
      const alt = attr(el, 'alt')?.trim();
      if (alt) this.buf += ` ${alt} `;
      return;
    }
    if (tag === 'table') {
      this.flushPara();
      this.table(el, inSection);
      return;
    }
    if (tag === 'li') {
      this.flushPara();
      const parent = el.parentNode as Element | null;
      const ordered = parent && isElement(parent) && parent.tagName === 'ol';
      const index = parent ? parent.childNodes.filter((c) => isElement(c) && c.tagName === 'li').indexOf(el) + 1 : 1;
      this.kind = 'li';
      this.prefix = ordered ? `${index}. ` : '- ';
      this.walk(el, inSection);
      this.flushPara();
      this.prefix = '';
      this.kind = 'p';
      return;
    }
    if (tag === 'pre') {
      this.flushPara();
      this.pre++;
      this.walk(el, inSection);
      this.flushPara();
      this.pre--;
      return;
    }
    if (BLOCK.has(tag)) {
      this.flushPara();
      this.walk(el, inSection);
      this.flushPara();
      return;
    }
    this.walk(el, inSection);
  }

  private table(table: Element, inSection: boolean) {
    const rows: Element[] = [];
    const collect = (n: ParentNode) => {
      for (const c of n.childNodes) {
        if (!isElement(c) || dropped(c, inSection)) continue;
        if (c.tagName === 'caption') {
          const caption = flatText(c, inSection);
          if (caption) this.out.para('p', caption);
        } else if (c.tagName === 'tr') rows.push(c);
        else if (c.tagName === 'thead' || c.tagName === 'tbody' || c.tagName === 'tfoot') collect(c);
      }
    };
    collect(table);
    for (const tr of rows) {
      const cells = tr.childNodes
        .filter((c): c is Element => isElement(c) && (c.tagName === 'td' || c.tagName === 'th') && !dropped(c, inSection))
        .map((c) => flatText(c, inSection));
      if (cells.some((c) => c)) this.out.para('row', pipeRow(cells));
    }
  }
}

/** Parses already-decoded HTML into blocks (not yet normalized). */
export function htmlToBlocks(html: string): Block[] {
  const doc = parse(html);
  const w = new Walker();
  w.walk(doc, false);
  return w.finish();
}

/** Finds `<meta charset>` / `http-equiv` charset in the first 1024 bytes (WHATWG prescan, simplified). */
export function sniffHtmlCharset(bytes: Uint8Array): string | undefined {
  const head = new TextDecoder('latin1').decode(bytes.subarray(0, 1024));
  const m = /<meta[^>]+charset\s*=\s*["']?\s*([A-Za-z0-9._:-]+)/i.exec(head);
  if (!m) return undefined;
  const label = m[1]!.toLowerCase();
  // Per WHATWG, a utf-16 meta declaration in an ASCII-compatible prescan means utf-8.
  return label.startsWith('utf-16') ? 'utf-8' : label;
}

export function extractHtml(bytes: Uint8Array, charset: string | undefined): Block[] {
  return htmlToBlocks(decodeBytes(bytes, charset ?? sniffHtmlCharset(bytes)));
}
