/**
 * One page of a knowledge read tool (design §9 "Paging"; paging rework, binding). Every paged response
 * has ONE shape, a small fixed header and then items, and every page is assembled by MEASURING:
 *
 * - The header holds identity only (id, kind, name, source node; bounded, see `boundedText`), and goes
 *   on the FIRST page only: a request without a cursor. Any cursor, including one at item 0 (a pointer),
 *   starts a later page with no header and none of the first-page notes.
 * - Everything else is an item: a record's fields, a fact's claim and quotes, card lines, captures,
 *   passages. The cursor reaches every item.
 * - The page is built by rendering the real response (header, items, `tokens`, `truncated`, `more`,
 *   `cursor`, `relaxed`, `content_trust`, `notes`) and measuring it; an item is added only while the
 *   rendered page still fits. Nothing is estimated or reserved.
 * - An item that does not fit after others ends the page (the cursor points AT it). An item that does
 *   not fit a page on its own is cut (`shortenItem`) and carries `full`: its own pointer (`recover`), else
 *   this request at it (`again`, `same_call`) with the measured `max_tokens` of a page that holds it whole;
 *   above the hard maximum it is flagged `too_large` with `size_tokens` instead.
 * - Position-paged text (passages, raw text) is served in pieces: a piece that does not end the passage
 *   is marked `cut: true` and the cursor resumes at its next character (the cursor is its pointer).
 * - Floor invariant: while content remains, a page serves at least one item (whole, a piece, or cut with
 *   its pointer). The read tools clamp a budget up to their floor (`READ_FLOOR_TOKENS`, tools.ts), which
 *   holds the header, the notes, the envelope and the barest cut item; should a request still not fit
 *   (it cannot at the floors tested), the page is assembled at the smallest budget that serves an item,
 *   with a note saying so, rather than an empty page.
 */
import type { RetrievalResultRef } from '../types.js';
import { decodeCursorAt, encodeCursor, estimateTokens } from './budget.js';
import { cutServedText, shortenItem, uniqueRefs, type Recover } from './readCommon.js';
import { CONTENT_TRUST, fenceEvidence } from './trust.js';

/** One item of a paged response. */
export type PageItem = {
  /** The item as served whole (a JSON value). For position-paged text: the whole passage from its start. */
  value: unknown;
  /** Every stored item whose text this item carries (retrieval log). */
  refs: RetrievalResultRef[];
  upload: boolean;
  /** Position-paged text: `meta(pos)` + `text: fenceEvidence(fence, body.slice(pos, …))`. */
  text?: { body: string; fence: string; meta: (pos: number) => Record<string, unknown> };
  /**
   * The call that returns this item whole when it must be cut, measured on that call's page (`need`:
   * tokens of a later page of THIS request holding it whole). `undefined` falls back to `again`.
   */
  recover?: (need: number) => Recover | undefined;
};

export type PageRequest = {
  /** Cursor key of the request (`cursorKey`). */
  key: string;
  cursor?: string | undefined;
  /** Tokens of the whole rendered response. */
  budget: number;
  /** `items`, `hits`, `lines` or `changes`. */
  itemsKey: string;
  /** Identity (bounded); first page only. */
  header: Record<string, unknown>;
  headerRefs: RetrievalResultRef[];
  headerUpload: boolean;
  /** Notes on every page (the dispatcher's role notes), first in `notes`. */
  notes?: readonly string[] | undefined;
  /** Notes about the item, first page only (after `notes`). */
  firstNotes?: readonly string[] | undefined;
  relaxed?: boolean | undefined;
  items: readonly PageItem[];
  /** `same_call`: this request at `cursor` with `max_tokens` = need (undefined above the hard maximum). */
  again?: ((cursor: string, need: number) => Recover | undefined) | undefined;
};

export type AssembledPage = {
  /** The response as served, with its measured `tokens`. */
  data: Record<string, unknown>;
  /** Header refs (first page) and the refs of every item served, whole or cut. */
  results: RetrievalResultRef[];
  uploadDerived: boolean;
  truncated: boolean;
  /** Items served on this page (whole, piece or cut). */
  served: number;
};

/** Smallest piece of a passage served after whole items on the same page (characters). */
export const MIN_PIECE_CHARS = 48;
/** `tokens` placeholder of a measurement that must hold at any budget up to the hard maximum. */
const ANY_BUDGET = 99_999;

const size = (data: unknown): number => estimateTokens(JSON.stringify(data));

/** The response as served: header (first page), items, then the envelope in its fixed order. */
function render(
  req: Pick<PageRequest, 'header' | 'itemsKey' | 'notes' | 'firstNotes' | 'relaxed'>,
  first: boolean,
  values: readonly unknown[],
  cursor: string | undefined,
  more: number,
  tokens: number,
): Record<string, unknown> {
  const notes = [...(req.notes ?? []), ...(first ? (req.firstNotes ?? []) : [])];
  return {
    ...(first ? req.header : {}),
    [req.itemsKey]: values,
    tokens,
    truncated: more > 0,
    ...(more > 0 ? { more } : {}),
    ...(cursor ? { cursor } : {}),
    ...(req.relaxed ? { relaxed: true } : {}),
    content_trust: CONTENT_TRUST,
    ...(notes.length ? { notes } : {}),
  };
}

/**
 * Tokens of a LATER page of a request (no header, no first-page notes) serving `value` whole, followed
 * by `cursor` and `more` — what a pointer's `max_tokens` must be for that page to hold it. Measured with
 * the largest `tokens` value, so it holds at any budget up to the hard maximum.
 */
export function laterPageNeed(itemsKey: string, value: unknown, cursor: string | undefined, more: number, notes: readonly string[] = []): number {
  return size(render({ header: {}, itemsKey, notes }, false, [value], cursor, more, ANY_BUDGET));
}

/** The fixed point of `tokens` (its own digits count). */
function withTokens(data: Record<string, unknown>): Record<string, unknown> {
  for (let i = 0; i < 4; i++) {
    const t = size(data);
    if (data.tokens === t) break;
    data.tokens = t;
  }
  return data;
}

/** Whitespace-friendly cut point of a passage piece (never inside a surrogate pair). */
function cutPoint(text: string, n: number): number {
  let k = n;
  if (k < text.length) {
    const ws = text.slice(Math.max(0, k - 40), k).search(/\s\S*$/);
    if (ws >= 0) {
      const at = Math.max(0, k - 40) + ws + 1;
      if (at > 0) k = at;
    }
  }
  const code = text.charCodeAt(k - 1);
  if (k > 0 && k < text.length && code >= 0xd800 && code <= 0xdbff) k--;
  return k;
}

/** Assembles one page of `req` (see module doc). */
export function assemblePage(req: PageRequest): AssembledPage {
  const page = tryAssemble(req, req.budget);
  if (page) return page;
  // Below the floor of this request (not reached at the tools' floors): the smallest budget that serves
  // an item, said in a note, never an empty page while content remains.
  for (let b = req.budget + 16; ; b += Math.max(16, Math.ceil(b / 8))) {
    if (b > 1_000_000) throw new Error('knowledge page: no budget serves an item');
    const raised = tryAssemble(req, b);
    if (!raised) continue;
    const notes = [...((raised.data.notes as string[] | undefined) ?? []), `max_tokens raised to ${b}: the smallest page of this request that serves an item`];
    raised.data.notes = notes;
    withTokens(raised.data);
    return raised;
  }
}

function tryAssemble(req: PageRequest, budget: number): AssembledPage | undefined {
  const n = req.items.length;
  const first = !req.cursor;
  const at = req.cursor ? decodeCursorAt(req.cursor, req.key) : { offset: 0, pos: 0 };
  const cursorAt = (i: number, pos = 0): string | undefined => (i < n ? encodeCursor({ key: req.key, offset: i, ...(pos > 0 ? { pos } : {}) }) : undefined);
  const fits = (values: readonly unknown[], cursor: string | undefined, more: number) => size(render(req, first, values, cursor, more, budget)) <= budget;

  let i = Math.min(at.offset, n);
  let pos = i < n && req.items[i]!.text ? Math.min(at.pos, req.items[i]!.text!.body.length) : 0;
  const values: unknown[] = [];
  const served: PageItem[] = [];
  let cursor = cursorAt(i, pos);
  while (i < n) {
    const it = req.items[i]!;
    const t = it.text;
    const whole = t && pos > 0 ? { ...t.meta(pos), text: fenceEvidence(t.fence, t.body.slice(pos)) } : it.value;
    if (fits([...values, whole], cursorAt(i + 1), n - i - 1)) {
      values.push(whole);
      served.push(it);
      i++;
      pos = 0;
      cursor = cursorAt(i);
      continue;
    }
    if (t) {
      // A piece of the passage up to the budget; the cursor resumes at its next character.
      const rest = t.body.length - pos;
      const piece = (k: number) => ({ ...t.meta(pos), text: fenceEvidence(t.fence, t.body.slice(pos, pos + k)), cut: true });
      const ok = (k: number) => fits([...values, piece(k)], cursorAt(i, pos + k), n - i);
      let lo = 0;
      let hi = Math.min(rest - 1, budget * 4); // a piece is never longer than the page in characters
      while (lo < hi) {
        const mid = Math.ceil((lo + hi) / 2);
        if (ok(mid)) lo = mid;
        else hi = mid - 1;
      }
      const k = lo > 0 ? cutPoint(t.body.slice(pos), lo) : 0;
      if (k > 0 && (!values.length || k >= MIN_PIECE_CHARS)) {
        values.push(piece(k));
        served.push(it);
        pos += k;
        cursor = cursorAt(i, pos);
      }
      if (!values.length) return undefined;
      break;
    }
    if (values.length) break;
    // Too big for a page on its own: cut, with the pointer that returns it whole.
    const next = cursorAt(i + 1);
    const more = n - i - 1;
    const need = laterPageNeed(req.itemsKey, it.value, next, more, req.notes);
    const full = it.recover?.(need) ?? req.again?.(encodeCursor({ key: req.key, offset: i }), need);
    const short = shortenItem(it.value, (x) => fits([x], next, more), full ? { full } : { size: need });
    if (short === undefined) return undefined;
    values.push(short);
    served.push(it);
    i++;
    cursor = next;
    break;
  }
  const more = n - i;
  const data = withTokens(render(req, first, values, i < n ? cursor : undefined, more, 0));
  return {
    data,
    results: uniqueRefs([...(first ? req.headerRefs : []), ...served.flatMap((s) => s.refs)]),
    uploadDerived: (first && req.headerUpload) || served.some((s) => s.upload),
    truncated: more > 0,
    served: values.length,
  };
}

/**
 * `s` bounded for a header: at most `maxJson` characters once JSON-escaped (a name full of quotes or
 * control characters is bounded too), cut at a token boundary with `…`. Callers that cut a value serve
 * it whole as an item as well, so nothing is lost.
 */
export function boundedText(s: string, maxJson: number): string {
  if (JSON.stringify(s).length <= maxJson) return s;
  let lo = 0;
  let hi = Math.min(s.length, maxJson);
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (JSON.stringify(cutServedText(s, mid)).length <= maxJson) lo = mid;
    else hi = mid - 1;
  }
  let out = cutServedText(s, lo);
  while (out && JSON.stringify(out).length > maxJson) out = out.slice(0, -2);
  return out;
}
