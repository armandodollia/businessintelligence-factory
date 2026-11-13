import { unzipSync } from 'fflate';
import { SaxesParser } from 'saxes';
import { pipeRow, SectionBuilder, type ParaKind } from './sections.js';
import { decodeBytes } from './text.js';
import { type Block, ExtractTooLargeError } from './types.js';

/**
 * Office Open XML (docx, pptx, xlsx): the text is XML inside a zip. fflate reads the zip (pure
 * JS); saxes parses the XML strictly and never resolves external entities or DTDs (an undefined
 * entity is an error), so there is no XXE or entity expansion. Macros, embedded objects and
 * external links are never read.
 */

// ---------------------------------------------------------------------------------------------
// zip

/** Names of the entries in a zip (nothing is inflated). Throws on data that is not a zip. */
export function zipEntryNames(bytes: Uint8Array): string[] {
  const names: string[] = [];
  unzipSync(bytes, {
    filter: (f) => {
      names.push(f.name);
      return false;
    },
  });
  return names;
}

/**
 * Inflates the entries `want` accepts, as text. The declared uncompressed sizes are summed and
 * checked against `maxUnzippedBytes` before inflating; fflate inflates into a buffer of exactly
 * the declared size, so a lying header cannot make it allocate more.
 */
function readZip(bytes: Uint8Array, want: (name: string) => boolean, maxUnzippedBytes: number): Map<string, string> {
  let total = 0;
  const files = unzipSync(bytes, {
    filter: (f) => {
      if (!want(f.name)) return false;
      total += f.originalSize;
      if (total > maxUnzippedBytes) {
        throw new ExtractTooLargeError(`zip parts exceed ${maxUnzippedBytes} bytes uncompressed`);
      }
      return true;
    },
  });
  const out = new Map<string, string>();
  for (const [name, data] of Object.entries(files)) out.set(name, decodeBytes(data));
  return out;
}

// ---------------------------------------------------------------------------------------------
// xml

type Attrs = Record<string, string>;
type XmlHandlers = {
  open?: (name: string, attrs: Attrs) => void;
  close?: (name: string) => void;
  text?: (text: string) => void;
};

const local = (name: string) => name.slice(name.indexOf(':') + 1);

/** Attribute by local name, preferring a prefixed one (`w:val`, `r:id`) over an unprefixed one. */
function attr(attrs: Attrs, name: string): string | undefined {
  for (const [k, v] of Object.entries(attrs)) if (k.includes(':') && local(k) === name) return v;
  return attrs[name];
}

/** Streams an XML document; element names are given without their namespace prefix. */
function parseXml(xml: string, h: XmlHandlers): void {
  const p = new SaxesParser({ xmlns: false });
  p.on('error', (e) => {
    throw e;
  });
  p.on('opentag', (t) => h.open?.(local(t.name), t.attributes as Attrs));
  p.on('closetag', (t) => h.close?.(local(t.name)));
  if (h.text) {
    p.on('text', h.text);
    p.on('cdata', h.text);
  }
  p.write(xml).close();
}

/** Resolves a relationship target against the folder of the part that owns the .rels file. */
function resolveTarget(baseDir: string, target: string): string {
  const parts = (target.startsWith('/') ? target.slice(1) : `${baseDir}/${target}`).split('/');
  const out: string[] = [];
  for (const p of parts) {
    if (p === '..') out.pop();
    else if (p && p !== '.') out.push(p);
  }
  return out.join('/');
}

function readRels(xml: string | undefined, baseDir: string): Map<string, string> {
  const rels = new Map<string, string>();
  if (!xml) return rels;
  parseXml(xml, {
    open: (name, a) => {
      const id = a.Id;
      const target = a.Target;
      if (name === 'Relationship' && id && target && a.TargetMode !== 'External') rels.set(id, resolveTarget(baseDir, target));
    },
  });
  return rels;
}

const byNumber = (a: string, b: string) => {
  const na = Number(/(\d+)\.xml$/.exec(a)?.[1] ?? 0);
  const nb = Number(/(\d+)\.xml$/.exec(b)?.[1] ?? 0);
  return na - nb || (a < b ? -1 : a > b ? 1 : 0);
};

/** Collects table rows from a stream of paragraphs; nested tables flatten into their cell. */
class Tables {
  private stack: { row: string[]; cell: string | undefined }[] = [];
  constructor(private readonly emitRow: (line: string) => void) {}

  get inCell(): boolean {
    return this.stack[this.stack.length - 1]?.cell !== undefined;
  }
  open(name: string): void {
    const top = this.stack[this.stack.length - 1];
    if (name === 'tbl') this.stack.push({ row: [], cell: undefined });
    else if (name === 'tr' && top) top.row = [];
    else if (name === 'tc' && top) top.cell = '';
  }
  close(name: string): void {
    const top = this.stack[this.stack.length - 1];
    if (!top) return;
    if (name === 'tc') {
      top.row.push(top.cell ?? '');
      top.cell = undefined;
    } else if (name === 'tr') {
      if (top.row.some((c) => c.trim())) {
        const line = pipeRow(top.row);
        if (this.stack.length > 1) this.addText(line, -2);
        else this.emitRow(line);
      }
      top.row = [];
    } else if (name === 'tbl') this.stack.pop();
  }
  /** Adds paragraph text to the innermost open cell (or the one `depth` levels out). */
  addText(text: string, depth = -1): void {
    const t = this.stack[this.stack.length + depth];
    if (t && t.cell !== undefined && text.trim()) t.cell += (t.cell ? ' ' : '') + text;
  }
}

// ---------------------------------------------------------------------------------------------
// docx

/** Heading level per paragraph style id, from `word/styles.xml` (`Title` = 0, `heading N` = N). */
function docxHeadingStyles(xml: string | undefined): Map<string, number> {
  const levels = new Map<string, number>();
  if (!xml) return levels;
  let id: string | undefined;
  parseXml(xml, {
    open: (name, a) => {
      if (name === 'style') {
        id = attr(a, 'styleId');
        return;
      }
      if (!id) return;
      const val = attr(a, 'val') ?? '';
      if (name === 'name') {
        const m = /^heading\s*([1-9])$/i.exec(val.trim());
        if (m) levels.set(id, Number(m[1]));
        else if (/^title$/i.test(val.trim())) levels.set(id, 0);
      } else if (name === 'outlineLvl' && !levels.has(id) && /^[0-8]$/.test(val)) levels.set(id, Number(val) + 1);
    },
    close: (name) => {
      if (name === 'style') id = undefined;
    },
  });
  return levels;
}

function styleLevel(styleId: string, styles: Map<string, number>): number | undefined {
  const known = styles.get(styleId);
  if (known !== undefined) return known;
  const m = /^heading\s*([1-9])$/i.exec(styleId);
  if (m) return Number(m[1]);
  return /^title$/i.test(styleId) ? 0 : undefined;
}

const isOn = (a: Attrs) => {
  const v = attr(a, 'val');
  return v === undefined || !/^(false|0|off|none)$/i.test(v);
};

function docxBlocks(documentXml: string, styles: Map<string, number>): Block[] {
  const out = new SectionBuilder();
  const tables = new Tables((line) => out.para('row', line));
  const stack: string[] = [];
  type P = { text: string; level?: number; list: boolean };
  const paras: P[] = [];
  let runHidden = false;
  /** The open element `n` levels above the one being opened (0 = its parent). */
  const parent = (n: number) => stack[stack.length - 1 - n];

  parseXml(documentXml, {
    open: (name, a) => {
      const inPPr = stack.includes('pPr');
      const p = paras[paras.length - 1];
      if (name === 'p') paras.push({ text: '', list: false });
      else if (name === 'tbl' || name === 'tr' || name === 'tc') tables.open(name);
      else if (name === 'r') runHidden = false;
      else if (p && inPPr && !stack.includes('rPr')) {
        if (name === 'pStyle') {
          const level = styleLevel(attr(a, 'val') ?? '', styles);
          if (level !== undefined) p.level = level;
        } else if (name === 'outlineLvl' && /^[0-8]$/.test(attr(a, 'val') ?? '')) p.level = Number(attr(a, 'val')) + 1;
        else if (name === 'numPr') p.list = true;
      } else if (name === 'vanish' && parent(0) === 'rPr' && parent(1) === 'r' && isOn(a)) runHidden = true;
      else if (p && !runHidden && stack[stack.length - 1] !== 'rPr') {
        if (name === 'tab' && parent(0) === 'r') p.text += '\t';
        else if (name === 'br' || name === 'cr') p.text += '\n';
        else if (name === 'noBreakHyphen') p.text += '-';
      }
      stack.push(name);
    },
    text: (t) => {
      const p = paras[paras.length - 1];
      if (p && stack[stack.length - 1] === 't' && !runHidden) p.text += t;
    },
    close: (name) => {
      stack.pop();
      if (name === 'p') {
        const p = paras.pop();
        if (!p) return;
        const text = p.text.replace(/[^\S\n]+/g, ' ').trim();
        if (tables.inCell) tables.addText(text);
        else if (p.level !== undefined && text) out.heading(p.level, text);
        else out.para(p.list ? 'li' : 'p', p.list ? `- ${text}` : text);
      } else if (name === 'tbl' || name === 'tr' || name === 'tc') tables.close(name);
      else if (name === 'r') runHidden = false;
    },
  });
  return out.finish();
}

export function extractDocx(bytes: Uint8Array, maxUnzippedBytes: number): Block[] {
  const parts = readZip(bytes, (n) => n === 'word/document.xml' || n === 'word/styles.xml', maxUnzippedBytes);
  const doc = parts.get('word/document.xml');
  if (doc === undefined) throw new Error('not a docx: word/document.xml is missing');
  return docxBlocks(doc, docxHeadingStyles(parts.get('word/styles.xml')));
}

// ---------------------------------------------------------------------------------------------
// pptx

function slideBlock(xml: string, n: number): Block {
  const titleLines: string[] = [];
  const lines: { kind: ParaKind; text: string }[] = [];
  const tables = new Tables((line) => lines.push({ kind: 'row', text: line }));
  const shapes: { title: boolean }[] = [];
  let para: string | undefined;
  let inT = false;
  parseXml(xml, {
    open: (name, a) => {
      if (name === 'sp') shapes.push({ title: false });
      else if (name === 'ph') {
        const type = a.type ?? '';
        const shape = shapes[shapes.length - 1];
        if (shape && (type === 'title' || type === 'ctrTitle')) shape.title = true;
      } else if (name === 'p') para = '';
      else if (name === 't') inT = true;
      else if (name === 'br' && para !== undefined) para += '\n';
      else if (name === 'tbl' || name === 'tr' || name === 'tc') tables.open(name);
    },
    text: (t) => {
      if (inT && para !== undefined) para += t;
    },
    close: (name) => {
      if (name === 't') inT = false;
      else if (name === 'sp') shapes.pop();
      else if (name === 'p' && para !== undefined) {
        const text = para.replace(/[^\S\n]+/g, ' ').trim();
        para = undefined;
        if (!text) return;
        if (tables.inCell) tables.addText(text);
        else if (shapes[shapes.length - 1]?.title) titleLines.push(text);
        else lines.push({ kind: 'p', text });
      } else if (name === 'tbl' || name === 'tr' || name === 'tc') tables.close(name);
    },
  });
  const title = titleLines.join(' ').replace(/\s+/g, ' ').trim();
  let text = title;
  lines.forEach((l, i) => {
    const prev = lines[i - 1];
    text += text ? (prev && prev.kind === l.kind && l.kind === 'row' ? '\n' : '\n\n') : '';
    text += l.text;
  });
  return { headingPath: title, locator: `slide ${n}`, text };
}

export function extractPptx(bytes: Uint8Array, maxUnzippedBytes: number): Block[] {
  const isSlide = (n: string) => /^ppt\/slides\/slide\d+\.xml$/.test(n);
  const parts = readZip(
    bytes,
    (n) => isSlide(n) || n === 'ppt/presentation.xml' || n === 'ppt/_rels/presentation.xml.rels',
    maxUnzippedBytes,
  );
  const pres = parts.get('ppt/presentation.xml');
  if (pres === undefined) throw new Error('not a pptx: ppt/presentation.xml is missing');
  const rels = readRels(parts.get('ppt/_rels/presentation.xml.rels'), 'ppt');
  const order: string[] = [];
  parseXml(pres, {
    open: (name, a) => {
      const target = name === 'sldId' ? rels.get(attr(a, 'id') ?? '') : undefined;
      if (target && parts.has(target) && !order.includes(target)) order.push(target);
    },
  });
  // Slides the presentation does not list (or a missing rels part): numeric order after the rest.
  for (const name of [...parts.keys()].filter(isSlide).sort(byNumber)) if (!order.includes(name)) order.push(name);
  return order.map((name, i) => slideBlock(parts.get(name)!, i + 1));
}

// ---------------------------------------------------------------------------------------------
// xlsx

/** Cells beyond this column are ignored (keeps sparse rows from exploding into separators). */
export const XLSX_MAX_COLUMNS = 1024;

function sharedStrings(xml: string | undefined): string[] {
  const out: string[] = [];
  if (!xml) return out;
  let cur: string | undefined;
  let inT = false;
  let phonetic = 0;
  parseXml(xml, {
    open: (name) => {
      if (name === 'si') cur = '';
      else if (name === 'rPh') phonetic++;
      else if (name === 't') inT = true;
    },
    text: (t) => {
      if (inT && !phonetic && cur !== undefined) cur += t;
    },
    close: (name) => {
      if (name === 'si') {
        out.push(cur ?? '');
        cur = undefined;
      } else if (name === 'rPh') phonetic--;
      else if (name === 't') inT = false;
    },
  });
  return out;
}

function columnIndex(ref: string | undefined): number | undefined {
  const m = ref ? /^([A-Z]+)/i.exec(ref) : null;
  if (!m) return undefined;
  let n = 0;
  for (const ch of m[1]!.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

function sheetText(xml: string, shared: string[], maxRows: number): string {
  const lines: string[] = [];
  let rows = 0;
  let row: string[] | undefined;
  let cell: { type: string; col: number; v: string; is: string } | undefined;
  let where: 'v' | 'is' | undefined;
  let inT = false;
  let phonetic = 0;
  parseXml(xml, {
    open: (name, a) => {
      if (name === 'row') row = [];
      else if (name === 'c' && row) cell = { type: a.t ?? 'n', col: columnIndex(a.r) ?? row.length, v: '', is: '' };
      else if (name === 'v') where = 'v';
      else if (name === 'is') where = 'is';
      else if (name === 'rPh') phonetic++;
      else if (name === 't') inT = true;
    },
    text: (t) => {
      if (!cell) return;
      if (where === 'v') cell.v += t;
      else if (where === 'is' && inT && !phonetic) cell.is += t;
    },
    close: (name) => {
      if (name === 'v' || name === 'is') where = undefined;
      else if (name === 'rPh') phonetic--;
      else if (name === 't') inT = false;
      else if (name === 'c' && cell && row) {
        let value: string;
        if (cell.type === 's') value = shared[Number(cell.v)] ?? '';
        else if (cell.type === 'inlineStr') value = cell.is;
        else if (cell.type === 'b') value = cell.v === '1' ? 'TRUE' : 'FALSE';
        else value = cell.v;
        if (value.trim() && cell.col < XLSX_MAX_COLUMNS) {
          while (row.length < cell.col) row.push('');
          row[cell.col] = value;
        }
        cell = undefined;
      } else if (name === 'row' && row) {
        if (row.some((c) => c && c.trim())) {
          rows++;
          if (rows <= maxRows) lines.push(pipeRow(Array.from(row, (c) => c ?? '')));
        }
        row = undefined;
      }
    },
  });
  if (rows > maxRows) lines.push(`[truncated: first ${maxRows} of ${rows} rows]`);
  return lines.join('\n');
}

export function extractXlsx(bytes: Uint8Array, maxRows: number, maxUnzippedBytes: number): Block[] {
  const isSheet = (n: string) => /^xl\/worksheets\/[^/]+\.xml$/.test(n);
  const parts = readZip(
    bytes,
    (n) => isSheet(n) || n === 'xl/workbook.xml' || n === 'xl/_rels/workbook.xml.rels' || n === 'xl/sharedStrings.xml',
    maxUnzippedBytes,
  );
  const wb = parts.get('xl/workbook.xml');
  if (wb === undefined) throw new Error('not an xlsx: xl/workbook.xml is missing');
  const rels = readRels(parts.get('xl/_rels/workbook.xml.rels'), 'xl');
  const shared = sharedStrings(parts.get('xl/sharedStrings.xml'));
  const sheets: { name: string; part: string }[] = [];
  parseXml(wb, {
    open: (name, a) => {
      if (name !== 'sheet') return;
      const part = rels.get(attr(a, 'id') ?? '');
      if (part && parts.has(part)) sheets.push({ name: a.name ?? '', part });
    },
  });
  const limit = Math.max(1, Math.floor(maxRows));
  return sheets.map((s, i) => ({ headingPath: s.name, locator: `sheet ${i + 1}`, text: sheetText(parts.get(s.part)!, shared, limit) }));
}
