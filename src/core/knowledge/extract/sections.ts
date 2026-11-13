import type { Block } from './types.js';

/** `p` paragraphs are separated by a blank line; consecutive list items or table rows by a newline. */
export type ParaKind = 'p' | 'li' | 'row';

/**
 * Builds blocks from a stream of headings and paragraphs: each heading starts a new section
 * whose heading path is the chain of open headings (`A > B > C`). Headings are not repeated in
 * the text. Sections without text produce no block.
 */
export class SectionBuilder {
  private readonly blocks: Block[] = [];
  private stack: { level: number; text: string; locator?: string }[] = [];
  private paras: { kind: ParaKind; text: string }[] = [];

  heading(level: number, text: string, locator?: string): void {
    const title = text.replace(/\s+/g, ' ').trim();
    if (!title) return;
    this.flush();
    while (this.stack.length && this.stack[this.stack.length - 1]!.level >= level) this.stack.pop();
    this.stack.push(locator ? { level, text: title, locator } : { level, text: title });
  }

  para(kind: ParaKind, text: string): void {
    if (text.trim()) this.paras.push({ kind, text });
  }

  private flush(): void {
    if (this.paras.length) {
      let text = '';
      this.paras.forEach((p, i) => {
        const prev = this.paras[i - 1];
        if (prev) text += prev.kind === p.kind && p.kind !== 'p' ? '\n' : '\n\n';
        text += p.text;
      });
      const block: Block = { headingPath: this.stack.map((h) => h.text).join(' > '), text };
      const locator = this.stack[this.stack.length - 1]?.locator;
      if (locator) block.locator = locator;
      this.blocks.push(block);
    }
    this.paras = [];
  }

  finish(): Block[] {
    this.flush();
    return this.blocks;
  }
}

/** Formats table cells as a pipe row; cell line breaks become spaces. */
export function pipeRow(cells: string[]): string {
  return `| ${cells.map((c) => c.replace(/\s+/g, ' ').trim()).join(' | ')} |`;
}
