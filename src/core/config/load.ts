import { readFileSync } from 'node:fs';
import {
  PROVIDER_IDS,
  bifConfigSchema,
  defaultConfig,
  type BifConfig,
  type ModelRef,
} from './schema.js';

export interface ConfigIssue {
  path: string;
  message: string;
}

export class ConfigError extends Error {
  readonly issues: ConfigIssue[];
  constructor(issues: ConfigIssue[], source?: string) {
    const where = source ? ` (${source})` : '';
    super(
      `Invalid configuration${where}:\n` +
        issues.map((i) => `  - ${i.path || '<root>'}: ${i.message}`).join('\n'),
    );
    this.name = 'ConfigError';
    this.issues = issues;
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Recursively merges plain objects; arrays and scalars in `override` replace `base`. */
export function deepMerge(base: unknown, override: unknown): unknown {
  if (override === undefined) return structuredClone(base);
  if (!isPlainObject(base) || !isPlainObject(override)) return structuredClone(override);
  const out: Record<string, unknown> = structuredClone(base);
  for (const [k, v] of Object.entries(override)) {
    out[k] = deepMerge(base[k], v);
  }
  return out;
}

/** Validates an arbitrary (already merged) object as a BifConfig. */
export function parseConfig(raw: unknown, source?: string): BifConfig {
  const result = bifConfigSchema.safeParse(raw);
  if (!result.success) {
    throw new ConfigError(
      result.error.issues.map((i) => ({ path: i.path.map(String).join('.'), message: i.message })),
      source,
    );
  }
  return result.data;
}

/**
 * Loads config. With no `path`, returns the validated defaults. With a `path`, reads the
 * JSON file, deep-merges it over `defaultConfig` and validates; any problem (missing file,
 * bad JSON, schema violations) throws `ConfigError` listing the offending paths.
 */
export function loadConfig(path?: string): BifConfig {
  if (path === undefined) return parseConfig(structuredClone(defaultConfig), 'defaults');
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (e) {
    throw new ConfigError([{ path: '', message: `cannot read file: ${(e as Error).message}` }], path);
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (e) {
    throw new ConfigError([{ path: '', message: `invalid JSON: ${(e as Error).message}` }], path);
  }
  if (!isPlainObject(json)) {
    throw new ConfigError([{ path: '', message: 'config file must contain a JSON object' }], path);
  }
  return parseConfig(deepMerge(defaultConfig, json), path);
}

/**
 * Picks the reviewer model for a worker: the configured reviewer, unless it shares the
 * worker's provider and another enabled provider (with at least one model) exists — then
 * that provider's first model, to reduce shared blind spots.
 */
export function reviewerFor(worker: ModelRef, cfg: BifConfig): ModelRef {
  const reviewer = cfg.roles.reviewer;
  if (reviewer.provider !== worker.provider) return reviewer;
  for (const id of PROVIDER_IDS) {
    if (id === worker.provider) continue;
    const p = cfg.providers[id];
    const model = p.models[0];
    if (p.enabled && model !== undefined) return { provider: id, model };
  }
  return reviewer;
}
