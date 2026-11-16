import { readFileSync } from 'node:fs';
import { canRunOffline, NO_OFFLINE_MODEL } from '../harness/offline.js';
import { councilFor, memberUnavailable } from '../council/settings.js';
import { panelSettings, seatUnavailable } from '../market/panelSettings.js';
import {
  COUNCIL_DEFAULTS,
  PROVIDER_IDS,
  TASK_TYPES,
  bifConfigSchema,
  defaultConfig,
  type BifConfig,
  type ModelRef,
  type TaskType,
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
 *
 * Callers must pass the config path explicitly (e.g. `bif.config.json` when it exists):
 * this function never looks in the working directory on its own.
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

/**
 * Problems with a valid config worth printing at startup: stakeholder personas are on but no enabled
 * provider can run offline, so reads by own stakeholders and learning runs for them never run
 * (own-stakeholder research itself is not offline and runs as usual).
 */
export function configWarnings(cfg: BifConfig): string[] {
  const out: string[] = [];
  const stakeholders = cfg.stakeholders?.enabled ?? true;
  if (stakeholders && !PROVIDER_IDS.some((id) => canRunOffline(cfg, id) && cfg.providers[id].models.length > 0)) {
    out.push(`stakeholders: ${NO_OFFLINE_MODEL}; reads by own stakeholders and learning for them are skipped (or set stakeholders.enabled: false)`);
  }
  out.push(...councilWarnings(cfg));
  out.push(...panelWarnings(cfg));
  return out;
}

/**
 * Persona panel (design §3, §4): one line per seat that cannot run here (provider disabled, or model not
 * configured), with the reason and what `onUnavailable` does about the personas on it. A warning, not an
 * error, as for the council: one configuration works on machines with different CLIs.
 */
function panelWarnings(cfg: BifConfig): string[] {
  const panel = panelSettings(cfg);
  if (!panel) return [];
  const effect = panel.onUnavailable === 'fail' ? 'the panel phase ends as failed' : 'the panel goes on without them';
  return panel.seats.flatMap((seat, i) => {
    const reason = seatUnavailable(cfg, seat);
    if (!reason) return [];
    return [
      `personaPanel: seat ${i} (${seat.provider}/${seat.model}) cannot run: ${reason}. ` +
        `Personas on it are unavailable: ${effect} (personaPanel.onUnavailable: ${panel.onUnavailable})`,
    ];
  });
}

/**
 * Review council (design §4, §7): one line per member that is seated in a stage and cannot run here
 * (provider disabled, or model not configured), with the reason, the stages and what happens to them:
 * `onUnavailable` decides for a blocking member; a non-blocking member never ends a task.
 * This is a warning, not an error, so one configuration works on machines with different CLIs.
 */
function councilWarnings(cfg: BifConfig): string[] {
  const unavailable = new Map<string, { who: string; reason: string; blocking: boolean; stages: TaskType[] }>();
  for (const type of TASK_TYPES) {
    for (const m of councilFor(cfg, type)?.members ?? []) {
      const reason = memberUnavailable(cfg, m);
      if (!reason) continue;
      const entry = unavailable.get(m.name) ?? { who: `member '${m.name}' (${m.provider}/${m.model})`, reason, blocking: m.blocking, stages: [] };
      entry.stages.push(type);
      unavailable.set(m.name, entry);
    }
  }
  const onUnavailable = cfg.council?.onUnavailable ?? COUNCIL_DEFAULTS.onUnavailable;
  const effect = (blocking: boolean): string =>
    !blocking
      ? 'run without it (a non-blocking member never ends a task)'
      : `${onUnavailable === 'fail' ? 'end unverified while it is seated' : 'run without it'} (council.onUnavailable: ${onUnavailable})`;
  return [...unavailable.values()].map((u) => `council: ${u.who} cannot run: ${u.reason}. Stages ${u.stages.join(', ')} ${effect(u.blocking)}`);
}
