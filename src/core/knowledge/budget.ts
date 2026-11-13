/**
 * Token budgets, fitting and cursors for knowledge responses (design §9 "Budgets").
 *
 * - `budgetFor`: the budget of one response: role override, else default; times the provider's
 *   scale; never above `hardMaxTokens`. A caller's `max_tokens` replaces it: lower, or higher up to the
 *   hard maximum (scaled for the provider), so a pointer's "this call with max_tokens N" works. The read
 *   tools then raise it to their floor (`READ_FLOOR_TOKENS`).
 * - `fitToBudget`: the longest prefix of `items` whose rendering fits. Prefix only — it never
 *   skips an item — so `offset + items.length` is where the next page starts (no loss, no repeat).
 *   Used by briefings and the reviewer context; the read tools assemble pages by measuring the whole
 *   response instead (`paging.ts`).
 * - Cursors are opaque compact strings (`c1.<key>.<offset>[.<pos>].<check>`) bound to the request (`cursorKey` of its parameters), so a
 *   cursor replayed against another query is rejected, and checked (`cursorCheck`), so a hand-edited
 *   one is rejected too. They carry no ids or text; scope and tree
 *   checks are redone on every call, so a forged offset can only page within what the caller sees.
 */
import { createHash } from 'node:crypto';
import type { BifConfig, KnowledgeBudgetKind, ProviderId } from '../config/schema.js';
import type { RetrievalRole } from '../types.js';
import { knowledgeSettings } from './config.js';
import { estimateTokens } from './extract/index.js';

export { estimateTokens };

/**
 * Floor of each read tool's response budget (tokens; paging rework, binding floor invariant): a smaller
 * configured budget or `max_tokens` is clamped up to it. At its floor a page holds the tool's header
 * (bounded), its notes, the envelope and at least one item: whole, a passage piece, or cut with its
 * pointer — so while content remains, no page is empty. Measured by the sweep tests
 * (`test/core/knowledge/pagingSweep*.test.ts`); documented in design §9 and the tool descriptions.
 */
export const READ_FLOOR_TOKENS = {
  search: 200,
  get_card: 200,
  expand: 300,
  read_artifact: 300,
  list_changes: 200,
  read_workspace: 200,
} as const satisfies Record<string, number>;

/** Tokens allowed for one response of `kind` to `role` on `provider` (see module doc). */
export function budgetFor(
  config: Pick<BifConfig, 'knowledge'>,
  role: RetrievalRole,
  provider: ProviderId | undefined,
  kind: KnowledgeBudgetKind,
  requested?: number,
): number {
  const k = knowledgeSettings(config);
  const base = (role !== 'user' ? k.budgets.roles[role]?.[kind] : undefined) ?? k.budgets.default[kind];
  const scale = provider ? (k.budgets.providers[provider] ?? 1) : 1;
  let budget = Math.min(Math.floor(base * scale), k.hardMaxTokens);
  // Re-gate (binding recovery shapes): `max_tokens` may lower the role's budget or raise it up to the
  // hard maximum (scaled for the provider), so a recovery pointer "same call, larger max_tokens" works.
  if (requested !== undefined && Number.isFinite(requested)) budget = Math.min(Math.floor(requested), maxRequestTokens(config, provider));
  return Math.max(1, budget);
}

/** The largest budget a request may ask for: the hard maximum, scaled for the provider. */
export function maxRequestTokens(config: Pick<BifConfig, 'knowledge'>, provider: ProviderId | undefined): number {
  const k = knowledgeSettings(config);
  const scale = provider ? (k.budgets.providers[provider] ?? 1) : 1;
  return Math.max(1, Math.floor(k.hardMaxTokens * Math.min(1, scale)));
}

export type Fitted<T> = {
  items: T[];
  /** Estimated tokens of the returned items plus `overhead`. */
  tokens: number;
  truncated: boolean;
  /** Items left out after the returned prefix. */
  more: number;
};

/**
 * Longest prefix of `items` within `budget` tokens. Each item counts `estimateTokens` of its
 * rendering plus one separator character; `overhead` (the response envelope) counts once.
 */
export function fitToBudget<T>(items: readonly T[], render: (item: T) => string, budget: number, overhead = 0): Fitted<T> {
  let tokens = overhead;
  let n = 0;
  for (const item of items) {
    const t = estimateTokens(`${render(item)}\n`);
    if (tokens + t > budget) break;
    tokens += t;
    n++;
  }
  return { items: items.slice(0, n), tokens, truncated: n < items.length, more: items.length - n };
}

/** Cuts `text` to at most `maxTokens` (whole UTF-16 surrogate pairs only). */
export function truncateToTokens(text: string, maxTokens: number): { text: string; truncated: boolean } {
  const maxChars = Math.max(0, Math.floor(maxTokens * 4));
  if (text.length <= maxChars) return { text, truncated: false };
  let end = maxChars;
  const last = text.charCodeAt(end - 1);
  if (end > 0 && last >= 0xd800 && last <= 0xdbff) end--; // would split a surrogate pair
  return { text: text.slice(0, end), truncated: true };
}

export class InvalidCursorError extends Error {
  constructor() {
    super('invalid cursor: pass the `cursor` of the previous response exactly as returned, or repeat the call without one');
    this.name = 'InvalidCursorError';
  }
}

/** JSON with object keys sorted (stable across key order). */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v)
      .sort()
      .filter((k) => (v as Record<string, unknown>)[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(v) ?? 'null';
}

/** Fingerprint of a request's parameters (everything except the cursor itself). */
export function cursorKey(parts: unknown): string {
  return createHash('sha256').update(canonical(parts)).digest('hex').slice(0, 16);
}

/**
 * `offset`: the item (or, for raw text, the character) the next page starts at; `pos` (text reads,
 * KS-8 ruling): the character inside that passage where the previous page stopped.
 */
export function encodeCursor(state: { key: string; offset: number; pos?: number }): string {
  // Re-gate: compact (`c1.<key>.<offset>[.<pos>].<check>`, ~32 characters) — a cursor is in every
  // truncated page and in every recovery pointer, so its size is paid on the smallest pages.
  return ['c1', state.key, state.offset, ...(state.pos ? [state.pos] : []), cursorCheck(state.key, state.offset, state.pos ?? 0)].join('.');
}

/**
 * Check value of a cursor (KS-8 smoke: a model "continued the pattern" of the previous cursor and
 * sent one it made up, which skipped text). Not a secret — cursors carry no ids or text and every
 * call re-checks scope — just a guard against hand-edited cursors.
 */
function cursorCheck(key: string, offset: number, pos: number): string {
  return createHash('sha256').update(`${key}:${offset}:${pos}`).digest('hex').slice(0, 8);
}

/** Where a cursor points (item offset and position inside it); throws `InvalidCursorError` when malformed or from another request. */
export function decodeCursorAt(cursor: string, key: string): { offset: number; pos: number } {
  const parts = typeof cursor === 'string' ? cursor.split('.') : [];
  const index = (v: string | undefined) => (v !== undefined && /^(0|[1-9][0-9]{0,15})$/.test(v) && Number.isSafeInteger(Number(v)) ? Number(v) : undefined);
  if ((parts.length !== 4 && parts.length !== 5) || parts[0] !== 'c1' || parts[1] !== key) throw new InvalidCursorError();
  const offset = index(parts[2]);
  const pos = parts.length === 5 ? index(parts[3]) : 0;
  if (offset === undefined || pos === undefined || (parts.length === 5 && pos === 0)) throw new InvalidCursorError();
  const at = { offset, pos };
  if (parts.at(-1) !== cursorCheck(key, at.offset, at.pos)) throw new InvalidCursorError();
  return at;
}

/** The item offset a cursor points at (see `decodeCursorAt`). */
export function decodeCursor(cursor: string, key: string): number {
  return decodeCursorAt(cursor, key).offset;
}

export type Page<T> = Fitted<T> & {
  /** Index of the first returned item in the full list. */
  offset: number;
  /** Present when items remain and this page made progress. */
  cursor?: string;
};

/** One page of `all` from `opts.cursor` (or the start), fitted to `budget`. */
export function fitPage<T>(
  all: readonly T[],
  render: (item: T) => string,
  budget: number,
  opts: { key: string; cursor?: string; overhead?: number },
): Page<T> {
  const offset = opts.cursor ? Math.min(decodeCursor(opts.cursor, opts.key), all.length) : 0;
  const fit = fitToBudget(all.slice(offset), render, budget, opts.overhead ?? 0);
  const page: Page<T> = { ...fit, offset };
  if (fit.more > 0 && fit.items.length > 0) page.cursor = encodeCursor({ key: opts.key, offset: offset + fit.items.length });
  return page;
}
