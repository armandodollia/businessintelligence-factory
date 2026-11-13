/**
 * Token budgets, fitting and cursors for knowledge responses (design §9 "Budgets").
 *
 * - `budgetFor`: the budget of one response: role override, else default; times the provider's
 *   scale; never above `hardMaxTokens`; a caller's `max_tokens` may lower it, never raise it.
 * - `fitToBudget`: the longest prefix of `items` whose rendering fits. Prefix only — it never
 *   skips an item — so `offset + items.length` is where the next page starts (no loss, no repeat).
 *   An item larger than the whole budget is not returned (`items: []`, `truncated`): cut it first
 *   with `truncateToTokens`.
 * - Cursors are opaque base64url strings bound to the request (`cursorKey` of its parameters), so a
 *   cursor replayed against another query is rejected. They carry no ids or text; scope and tree
 *   checks are redone on every call, so a forged offset can only page within what the caller sees.
 */
import { createHash } from 'node:crypto';
import type { BifConfig, KnowledgeBudgetKind, ProviderId } from '../config/schema.js';
import type { RetrievalRole } from '../types.js';
import { knowledgeSettings } from './config.js';
import { estimateTokens } from './extract/index.js';

export { estimateTokens };

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
  if (requested !== undefined && Number.isFinite(requested)) budget = Math.min(budget, Math.floor(requested));
  return Math.max(1, budget);
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
    super('invalid cursor: repeat the call without a cursor');
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

export function encodeCursor(state: { key: string; offset: number }): string {
  return Buffer.from(JSON.stringify({ v: 1, k: state.key, o: state.offset })).toString('base64url');
}

/** The offset a cursor points at; throws `InvalidCursorError` when malformed or from another request. */
export function decodeCursor(cursor: string, key: string): number {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw new InvalidCursorError();
  }
  const c = parsed as { v?: unknown; k?: unknown; o?: unknown } | null;
  if (!c || c.v !== 1 || c.k !== key || typeof c.o !== 'number' || !Number.isSafeInteger(c.o) || c.o < 0) {
    throw new InvalidCursorError();
  }
  return c.o;
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
