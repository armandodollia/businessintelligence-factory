import type { BifConfig, ModelRef } from '../config/schema.js';
import { personaLearningSettings } from '../personas/settings.js';

export type UserPersonaSettings = {
  enabled: boolean;
  minInteractions: number;
  minDistinctTargets: number;
  minEvidence: number;
  maxProposals: number;
  maxAdjustments: number;
  maxPerField: number;
  windowDays: number;
  useInPrompts: boolean;
  model: ModelRef;
};

/** Whether the user persona is on and its brief goes into prompts (`enabled`, `useInPrompts`; both default true). */
export function userBriefSettings(config: Pick<BifConfig, 'userPersona'>): Pick<UserPersonaSettings, 'enabled' | 'useInPrompts'> {
  return { enabled: config.userPersona?.enabled ?? true, useInPrompts: config.userPersona?.useInPrompts ?? true };
}

/** Effective `config.userPersona` with defaults applied (user persona design §10); the model is persona learning's. */
export function userPersonaSettings(config: Pick<BifConfig, 'userPersona' | 'personaLearning' | 'lessons' | 'roles'>): UserPersonaSettings {
  const u = config.userPersona ?? {};
  return {
    ...userBriefSettings(config),
    minInteractions: u.minInteractions ?? 12,
    minDistinctTargets: u.minDistinctTargets ?? 6,
    minEvidence: u.minEvidence ?? 3,
    maxProposals: u.maxProposals ?? 3,
    maxAdjustments: u.maxAdjustments ?? 12,
    maxPerField: u.maxPerField ?? 3,
    windowDays: u.windowDays ?? 180,
    model: personaLearningSettings(config).model,
  };
}
