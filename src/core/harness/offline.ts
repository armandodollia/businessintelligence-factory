/**
 * Model choice for offline runs (stakeholder personas, final review item 2): an offline run
 * (`RunOptions.offline`: a read by an own stakeholder, a learning run for an own stakeholder persona,
 * a user-persona learning run) must use a provider whose adapter enforces offline
 * (`CliAdapter.offline`); Codex refuses offline runs. Every place that picks a model for offline work
 * goes through `offlineModel`, so a configured model that cannot run offline is swapped for one that can.
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
 * model of it); else the first allowed model of an enabled provider that can; else `undefined` (no
 * enabled provider can run offline).
 */
export function offlineModel(config: Pick<BifConfig, 'providers'>, preferred: ModelRef): ModelRef | undefined {
  if (canRunOffline(config, preferred.provider) && config.providers[preferred.provider].models.includes(preferred.model)) return preferred;
  return PROVIDER_IDS.filter((id) => canRunOffline(config, id))
    .flatMap((provider) => config.providers[provider].models.map((model): ModelRef => ({ provider, model })))[0];
}

/** Why offline work cannot run: no enabled provider can run offline. */
export const NO_OFFLINE_MODEL =
  'no enabled provider can run offline (Codex refuses offline runs): enable Claude or OpenCode with at least one model';
