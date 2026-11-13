/**
 * Builds small knowledge-extraction fixtures in memory (no binary files in the repo):
 * minimal PDFs with and without a text layer, and docx / pptx / xlsx zips.
 */
import { strToU8, zipSync, type Zippable } from 'fflate';

const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function zip(files: Record<string, string>): Uint8Array {
  const z: Zippable = {};
  for (const [name, text] of Object.entries(files)) z[name] = strToU8(text);
  return zipSync(z, { level: 6, mtime: new Date('2026-01-01T00:00:00Z') });
}

// ---------------------------------------------------------------------------------------------
// PDF

const pdfString = (s: string) => `(${s.replace(/[\\()]/g, (c) => `\\${c}`)})`;

/**
 * A PDF with one page per entry. A page is either lines of text (Helvetica, a real text layer)
 * or `null` for a page that only draws a filled rectangle (no text layer, like a scan).
 */
export function makePdf(pages: (string[] | null)[]): Uint8Array {
  const objects: string[] = [];
  const add = (body: string) => objects.push(body) - 1 + 1; // object number (1-based)
  const catalog = add('');
  const pagesObj = add('');
  const font = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  const kids: number[] = [];
  for (const lines of pages) {
    const ops = lines
      ? `BT /F1 12 Tf 72 720 Td 14 TL ${lines.map((l) => `${pdfString(l)} '`).join(' ')} ET`
      : '0.5 g 72 72 300 400 re f';
    const content = add(`<< /Length ${ops.length} >>\nstream\n${ops}\nendstream`);
    kids.push(
      add(
        `<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 612 792] ` +
          `/Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${content} 0 R >>`,
      ),
    );
  }
  objects[catalog - 1] = `<< /Type /Catalog /Pages ${pagesObj} 0 R >>`;
  objects[pagesObj - 1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`;
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) out += `${String(o).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return strToU8(out, true);
}

// ---------------------------------------------------------------------------------------------
// docx

export type DocxPara =
  | { style?: string; text: string; list?: boolean; hiddenRun?: string }
  | { table: string[][] };

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';

function docxParagraph(p: Exclude<DocxPara, { table: string[][] }>): string {
  const ppr =
    p.style || p.list
      ? `<w:pPr>${p.style ? `<w:pStyle w:val="${p.style}"/>` : ''}${p.list ? '<w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr>' : ''}<w:rPr><w:b/></w:rPr></w:pPr>`
      : '';
  const [first, ...rest] = p.text.split('\t');
  const runs =
    `<w:r><w:rPr><w:lang w:val="en-US"/></w:rPr><w:t xml:space="preserve">${esc(first ?? '')}</w:t></w:r>` +
    rest.map((t) => `<w:r><w:tab/><w:t xml:space="preserve">${esc(t)}</w:t></w:r>`).join('') +
    (p.hiddenRun ? `<w:r><w:rPr><w:vanish/></w:rPr><w:t>${esc(p.hiddenRun)}</w:t></w:r>` : '') +
    '<w:r><w:delText>DELETED-TEXT</w:delText></w:r><w:r><w:instrText> PAGE </w:instrText></w:r>';
  return `<w:p>${ppr}${runs}</w:p>`;
}

export function makeDocx(paras: DocxPara[], opts: { localizedStyles?: boolean } = {}): Uint8Array {
  const body = paras
    .map((p) =>
      'table' in p
        ? `<w:tbl><w:tblPr/>${p.table
            .map((row) => `<w:tr>${row.map((c) => `<w:tc>${docxParagraph({ text: c })}</w:tc>`).join('')}</w:tr>`)
            .join('')}</w:tbl>`
        : docxParagraph(p),
    )
    .join('');
  // Localized style ids (as Word writes them in, e.g., German) resolved through styles.xml names.
  const styles = opts.localizedStyles
    ? `${XML}<w:styles ${W}>` +
      '<w:style w:type="paragraph" w:styleId="Titel"><w:name w:val="Title"/></w:style>' +
      '<w:style w:type="paragraph" w:styleId="berschrift1"><w:name w:val="heading 1"/><w:pPr><w:outlineLvl w:val="0"/></w:pPr></w:style>' +
      '<w:style w:type="paragraph" w:styleId="berschrift2"><w:name w:val="heading 2"/></w:style>' +
      '<w:style w:type="paragraph" w:styleId="Gliederung"><w:name w:val="Custom outline"/><w:pPr><w:outlineLvl w:val="2"/></w:pPr></w:style>' +
      '</w:styles>'
    : `${XML}<w:styles ${W}><w:style w:type="paragraph" w:styleId="Normal"><w:name w:val="Normal"/></w:style></w:styles>`;
  return zip({
    '[Content_Types].xml': `${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>`,
    '_rels/.rels': `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`,
    'word/document.xml': `${XML}<w:document ${W}><w:body>${body}<w:sectPr/></w:body></w:document>`,
    'word/styles.xml': styles,
  });
}

// ---------------------------------------------------------------------------------------------
// pptx

const P_NS =
  'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';

function shape(paragraphs: string[], title: boolean): string {
  const ph = title ? '<p:nvPr><p:ph type="title"/></p:nvPr>' : '<p:nvPr/>';
  return (
    `<p:sp><p:nvSpPr><p:cNvPr id="2" name="s"/><p:cNvSpPr/>${ph}</p:nvSpPr><p:spPr/>` +
    `<p:txBody><a:bodyPr/>${paragraphs.map((t) => `<a:p><a:r><a:rPr lang="en-US"/><a:t>${esc(t)}</a:t></a:r></a:p>`).join('')}</p:txBody></p:sp>`
  );
}

/** Slides in presentation order; the zip stores them under reversed file numbers to test ordering. */
export function makePptx(slides: { title?: string; body: string[] }[]): Uint8Array {
  const files: Record<string, string> = {};
  const n = slides.length;
  const ids: string[] = [];
  const rels: string[] = [];
  slides.forEach((s, i) => {
    const file = `slide${n - i}.xml`;
    files[`ppt/slides/${file}`] =
      `${XML}<p:sld ${P_NS}><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>` +
      (s.title ? shape([s.title], true) : '') +
      shape(s.body, false) +
      '</p:spTree></p:cSld></p:sld>';
    ids.push(`<p:sldId id="${256 + i}" r:id="rId${i + 2}"/>`);
    rels.push(`<Relationship Id="rId${i + 2}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/${file}"/>`);
  });
  files['ppt/presentation.xml'] = `${XML}<p:presentation ${P_NS}><p:sldIdLst>${ids.join('')}</p:sldIdLst></p:presentation>`;
  files['ppt/_rels/presentation.xml.rels'] =
    `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels.join('')}</Relationships>`;
  files['[Content_Types].xml'] = `${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>`;
  return zip(files);
}

// ---------------------------------------------------------------------------------------------
// xlsx

export type Cell = string | number | boolean | null;

function colName(i: number): string {
  let s = '';
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

/** Strings go to sharedStrings (except those starting with `inline:`); numbers and booleans inline. */
export function makeXlsx(sheets: { name: string; rows: Cell[][] }[]): Uint8Array {
  const shared: string[] = [];
  const files: Record<string, string> = {};
  const sheetEls: string[] = [];
  const rels: string[] = [];
  sheets.forEach((sheet, si) => {
    const rows = sheet.rows
      .map((row, ri) => {
        const cells = row
          .map((v, ci) => {
            const r = `${colName(ci)}${ri + 1}`;
            if (v === null) return '';
            if (typeof v === 'number') return `<c r="${r}"><v>${v}</v></c>`;
            if (typeof v === 'boolean') return `<c r="${r}" t="b"><v>${v ? 1 : 0}</v></c>`;
            if (v.startsWith('inline:')) return `<c r="${r}" t="inlineStr"><is><t>${esc(v.slice(7))}</t></is></c>`;
            let idx = shared.indexOf(v);
            if (idx < 0) idx = shared.push(v) - 1;
            return `<c r="${r}" t="s"><v>${idx}</v></c>`;
          })
          .join('');
        return `<row r="${ri + 1}">${cells}</row>`;
      })
      .join('');
    files[`xl/worksheets/sheet${si + 1}.xml`] =
      `${XML}<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows}</sheetData></worksheet>`;
    sheetEls.push(`<sheet name="${esc(sheet.name)}" sheetId="${si + 1}" r:id="rId${si + 1}"/>`);
    rels.push(`<Relationship Id="rId${si + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${si + 1}.xml"/>`);
  });
  files['xl/workbook.xml'] =
    `${XML}<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheetEls.join('')}</sheets></workbook>`;
  files['xl/_rels/workbook.xml.rels'] =
    `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels.join('')}</Relationships>`;
  files['xl/sharedStrings.xml'] =
    `${XML}<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${shared.length}" uniqueCount="${shared.length}">` +
    shared.map((s) => `<si><t xml:space="preserve">${esc(s)}</t></si>`).join('') +
    '</sst>';
  files['[Content_Types].xml'] = `${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>`;
  return zip(files);
}

/** Smallest valid-looking PNG header (signature + IHDR); enough for type detection. */
export const PNG_BYTES = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01,
  0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89,
]);

export { zip as makeZip };
