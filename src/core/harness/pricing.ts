import { readFileSync } from 'node:fs';
import { runtimePaths } from '../runtime/paths.js';
import type { ProviderId } from '../types.js';

/** USD per 1M tokens. `cacheRead` / `cacheWrite` default to `input` when absent. */
export type ModelPrice = { input: number; output: number; cacheRead?: number; cacheWrite?: number; estimate?: boolean; source?: string };

/**
 * Dated per-model price table (`src/core/harness/pricing.json`, editable). `version` is stored on
 * every usage row priced with it (`agent_usage.price_version`).
 */
export type PriceTable = {
  version: string;
  effectiveDate: string;
  currency: 'USD';
  models: Record<string, ModelPrice>;
  aliases?: Record<string, string>;
};

/** Token counts of one usage record (disjoint). */
export type TokenCounts = { input: number; output: number; cacheRead: number; cacheWrite: number };

/** The price table file: next to this module in a checkout, in the shipped resources when packaged. */
export const DEFAULT_PRICING_PATH = runtimePaths().resources.pricingPath;

/** Reads and validates a price table file. */
export function loadPricing(path: string = DEFAULT_PRICING_PATH): PriceTable {
  const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<PriceTable>;
  if (typeof raw.version !== 'string' || typeof raw.effectiveDate !== 'string' || !raw.models || typeof raw.models !== 'object') {
    throw new Error(`invalid price table ${path}: needs version, effectiveDate and models`);
  }
  for (const [key, p] of Object.entries(raw.models)) {
    if (!(typeof p.input === 'number' && typeof p.output === 'number')) throw new Error(`invalid price for '${key}' in ${path}`);
  }
  return { currency: 'USD', aliases: {}, ...raw } as PriceTable;
}

let cached: PriceTable | undefined;

/** The bundled price table (read once per process). */
export function defaultPricing(): PriceTable {
  cached ??= loadPricing();
  return cached;
}

/**
 * Price of `provider/model`: tries `<provider>/<model>`, the bare model, and the model without an
 * OpenCode-style `vendor/` prefix, each directly and through `aliases` (case-insensitive).
 */
export function priceFor(table: PriceTable, provider: ProviderId, model: string): ModelPrice | undefined {
  const models = new Map(Object.entries(table.models).map(([k, v]) => [k.toLowerCase(), v]));
  const aliases = new Map(Object.entries(table.aliases ?? {}).map(([k, v]) => [k.toLowerCase(), v.toLowerCase()]));
  const m = model.toLowerCase();
  const candidates = [`${provider}/${m}`, m];
  const slash = m.lastIndexOf('/');
  if (slash >= 0) candidates.push(m.slice(slash + 1));
  for (const c of candidates) {
    const hit = models.get(c) ?? (aliases.has(c) ? models.get(aliases.get(c)!) : undefined);
    if (hit) return hit;
  }
  return undefined;
}

/** Cost in USD of `tokens` at `price` (per 1M tokens). */
export function computeCost(price: ModelPrice, tokens: TokenCounts): number {
  const perToken = (usd: number) => usd / 1_000_000;
  return (
    tokens.input * perToken(price.input) +
    tokens.output * perToken(price.output) +
    tokens.cacheRead * perToken(price.cacheRead ?? price.input) +
    tokens.cacheWrite * perToken(price.cacheWrite ?? price.input)
  );
}
