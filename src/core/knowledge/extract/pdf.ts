import type { Block } from './types.js';

/**
 * PDF → one block per page (`locator: "page N"`), using pdf.js as bundled by unpdf (pure JS, no
 * worker, no canvas). This pdf.js build contains no `eval` / `new Function`; system fonts, font
 * faces, XFA, wasm decoders and worker fetches are off, and no URLs are given for fonts, CMaps or
 * ICC profiles, so nothing is loaded from disk or network. PDF JavaScript is never run: pdf.js only runs it in its
 * viewer's scripting sandbox, which is not used here. A page without a text layer yields no text;
 * a document with no text at all becomes `empty`.
 */
export async function extractPdf(bytes: Uint8Array): Promise<Block[]> {
  // Loaded lazily so importing the extraction library stays cheap.
  const { getDocumentProxy } = await import('unpdf');
  // pdf.js may transfer (detach) the buffer it is given; hand it a copy.
  const pdf = await getDocumentProxy(bytes.slice(), {
    useSystemFonts: false,
    disableFontFace: true,
    enableXfa: false,
    stopAtErrors: false,
    verbosity: 0,
    standardFontDataUrl: undefined,
    cMapUrl: undefined,
    wasmUrl: undefined,
    iccUrl: undefined,
    useWasm: false,
    useWorkerFetch: false,
    isOffscreenCanvasSupported: false,
    isImageDecoderSupported: false,
  });
  try {
    const blocks: Block[] = [];
    for (let n = 1; n <= pdf.numPages; n++) {
      const page = await pdf.getPage(n);
      const content = await page.getTextContent();
      let text = '';
      for (const item of content.items) {
        if (!('str' in item)) continue;
        text += item.str;
        if (item.hasEOL) text += '\n';
      }
      blocks.push({ headingPath: '', locator: `page ${n}`, text });
      page.cleanup();
    }
    return blocks;
  } finally {
    await pdf.loadingTask.destroy();
  }
}
