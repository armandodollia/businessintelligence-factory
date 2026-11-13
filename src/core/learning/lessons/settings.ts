import type { BifConfig, ModelRef } from '../../config/schema.js';

export type LessonsSettings = {
  enabled: boolean;
  minTasks: number;
  retireAfterCleanTasks: number;
  minEffectTasks: number;
  maxRulesPerRole: number;
  retro: { enabled: boolean; cron: string; model: ModelRef; windowDays: number; maxProposals: number };
};

/** Hard cap of the spec: at most 15 rules per role (config may only lower it). */
export const MAX_RULES_PER_ROLE = 15;
/** Strongest wording of a rule. */
export const MAX_STRENGTH = 3;
/** Weekly retro default: Mondays 06:00 server time. */
export const DEFAULT_RETRO_CRON = '0 6 * * 1';

/** Effective `config.lessons` with defaults applied. */
export function lessonsSettings(config: Pick<BifConfig, 'lessons' | 'roles'>): LessonsSettings {
  const l = config.lessons ?? {};
  const r = l.retro ?? {};
  return {
    enabled: l.enabled ?? true,
    minTasks: l.minTasks ?? 3,
    retireAfterCleanTasks: l.retireAfterCleanTasks ?? 10,
    minEffectTasks: l.minEffectTasks ?? 5,
    maxRulesPerRole: Math.min(l.maxRulesPerRole ?? MAX_RULES_PER_ROLE, MAX_RULES_PER_ROLE),
    retro: {
      enabled: r.enabled ?? true,
      cron: r.cron ?? DEFAULT_RETRO_CRON,
      model: r.model ?? config.roles.orchestrator,
      windowDays: r.windowDays ?? 7,
      maxProposals: r.maxProposals ?? 5,
    },
  };
}
