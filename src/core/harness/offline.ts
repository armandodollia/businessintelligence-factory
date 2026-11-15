/**
 * Model choice for offline runs (stakeholder personas, final review item 2): an offline run
 * (`RunOptions.offline`) must use a provider whose adapter enforces offline (`CliAdapter.offline`);
 * Codex refuses offline runs. Every place that picks a model for offline work goes through
 * `offlineModel`, so a configured model that cannot run offline is swapped for one that can.
 */
import { PROVIDER_IDS, type BifConfig } from '../config/schema.js';
import type { ModelRef, ProviderId } from '../types.js';
import { getAdapter } from './adapters/index.js';

/** Whether `provider` is enabled and its adapter enforces offline runs. */
export function canRunOffline(config: Pick<BifConfig, 'providers'>, provider: ProviderId): boolean {
  return config.providers[provider].enabled && getAdapter(provider).offline;
}

/**
 * The model for an offline run: `preferred` when its provider can run offline (and it is an allowed
 * model of it); else the first allowed model of an enabled provider that can, preferring a provider
 * other than `avoidProvider` and falling back to `avoidProvider` when it is the only capable one; else
 * `undefined` (no enabled provider can run offline). `exclude` is never returned (e.g. the reviewer a
 * reviewer audit checks).
 */
export function offlineModel(
  config: Pick<BifConfig, 'providers'>,
  preferred: ModelRef | undefined,
  opts: { avoidProvider?: ProviderId; exclude?: ModelRef } = {},
): ModelRef | undefined {
  const excluded = (m: ModelRef) => !!opts.exclude && m.provider === opts.exclude.provider && m.model === opts.exclude.model;
  if (
    preferred && !excluded(preferred) && canRunOffline(config, preferred.provider) &&
    config.providers[preferred.provider].models.includes(preferred.model)
  ) {
    return preferred;
  }
  const capable = PROVIDER_IDS.filter((id) => canRunOffline(config, id));
  const ordered = [...capable.filter((id) => id !== opts.avoidProvider), ...capable.filter((id) => id === opts.avoidProvider)];
  return ordered.flatMap((provider) => config.providers[provider].models.map((model): ModelRef => ({ provider, model }))).find((m) => !excluded(m));
}

/** Why offline work cannot run: no enabled provider can run offline. */
export const NO_OFFLINE_MODEL =
  'no enabled provider can run offline (Codex refuses offline runs): enable Claude or OpenCode with at least one model';
