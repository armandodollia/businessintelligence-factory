import type { BifConfig } from '../config/schema.js';

export type StakeholdersSettings = {
  enabled: boolean;
  maxOwn: number;
  maxCompetitors: number;
  maxPerCompetitor: number;
  maxReadsPerPanel: number;
};

/** Effective `config.stakeholders` with defaults applied (design 2026-11-15-stakeholder-personas-design.md §13). */
export function stakeholdersSettings(config: Pick<BifConfig, 'stakeholders'>): StakeholdersSettings {
  const s = config.stakeholders ?? {};
  return {
    enabled: s.enabled ?? true,
    maxOwn: s.maxOwn ?? 8,
    maxCompetitors: s.maxCompetitors ?? 3,
    maxPerCompetitor: s.maxPerCompetitor ?? 3,
    maxReadsPerPanel: s.maxReadsPerPanel ?? 40,
  };
}
