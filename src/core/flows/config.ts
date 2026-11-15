/**
 * Flow ranking settings (design §15): `config.flows` with every default applied. The block and its
 * defaults live in `config/schema.ts` (`flowsConfigSchema`, `FLOWS_DEFAULTS`); read them only through
 * `flowsSettings`.
 */
import { FLOWS_DEFAULTS, type BifConfig, type ModelRef } from '../config/schema.js';

export type FlowsSettings = {
  tieMargin: number;
  minMentionsForCheck: number;
  mentionWindowDays: number;
  minAttributionConfidence: number;
  maxFocusedComparisons: number;
  lowConfidence: number;
  maxFlowsPerSitting: number;
  /** Verdict model; absent = `roles.persona`. */
  model?: ModelRef;
  generalCoverage: number;
};

/** `config.flows` merged over `FLOWS_DEFAULTS` (a fresh object on every call). */
export function flowsSettings(config: Pick<BifConfig, 'flows'>): FlowsSettings {
  const f = config.flows ?? {};
  const d = FLOWS_DEFAULTS;
  return {
    tieMargin: f.tieMargin ?? d.tieMargin,
    minMentionsForCheck: f.minMentionsForCheck ?? d.minMentionsForCheck,
    mentionWindowDays: f.mentionWindowDays ?? d.mentionWindowDays,
    minAttributionConfidence: f.minAttributionConfidence ?? d.minAttributionConfidence,
    maxFocusedComparisons: f.maxFocusedComparisons ?? d.maxFocusedComparisons,
    lowConfidence: f.lowConfidence ?? d.lowConfidence,
    maxFlowsPerSitting: f.maxFlowsPerSitting ?? d.maxFlowsPerSitting,
    ...(f.model ? { model: { ...f.model } } : {}),
    generalCoverage: f.generalCoverage ?? d.generalCoverage,
  };
}
