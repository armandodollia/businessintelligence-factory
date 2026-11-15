import type { BifConfig, ModelRef } from '../config/schema.js';
import { lessonsSettings } from '../learning/lessons/settings.js';

export type PersonaLearningSettings = {
  enabled: boolean;
  minSignals: number;
  minDistinctItems: number;
  disagreeFloor: number;
  windowDays: number;
  maxPersonasPerRetro: number;
  maxProposalsPerPersona: number;
  minEvidence: number;
  maxAdjustments: number;
  minEffectSignals: number;
  model: ModelRef;
};

/** Effective `config.personaLearning` with defaults applied (design §12); the model defaults to the retro model. */
export function personaLearningSettings(config: Pick<BifConfig, 'personaLearning' | 'lessons' | 'roles'>): PersonaLearningSettings {
  const p = config.personaLearning ?? {};
  return {
    enabled: p.enabled ?? true,
    minSignals: p.minSignals ?? 6,
    minDistinctItems: p.minDistinctItems ?? 4,
    disagreeFloor: p.disagreeFloor ?? 0.3,
    windowDays: p.windowDays ?? 180,
    maxPersonasPerRetro: p.maxPersonasPerRetro ?? 5,
    maxProposalsPerPersona: p.maxProposalsPerPersona ?? 3,
    minEvidence: p.minEvidence ?? 3,
    maxAdjustments: p.maxAdjustments ?? 8,
    minEffectSignals: p.minEffectSignals ?? 6,
    model: p.model ?? lessonsSettings(config).retro.model,
  };
}
