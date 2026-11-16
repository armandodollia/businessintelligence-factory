import { COUNCIL_DEFAULTS, TASK_TYPES, type BifConfig, type Lens, type ProviderId, type TaskType } from '../config/schema.js';

/**
 * Review council settings (design 2026-11-16-review-council-design.md §4): which task types are reviewed
 * by a council, with which members and rules. Everything that needs the council of a task type reads it
 * through `councilFor`, which applies the defaults.
 */

export { LENSES, type Lens } from '../config/schema.js';

export type CouncilMember = { name: string; provider: ProviderId; model: string; effort?: string; lens: Lens; blocking: boolean };

export type CouncilStage = {
  /** Most review rounds (replaces `loop.maxRounds` for the task type). */
  rounds: number;
  /** Every blocking member must score this or more (replaces `loop.passThreshold` for the task type). */
  passScore: number;
  blockOn: 'any' | 'majority' | 'all';
  onUnavailable: 'fail' | 'report';
  /** The seated members, in the order they are named (the stage's `members`, else the whole council). */
  members: CouncilMember[];
};

/** The council that reviews `taskType`; `undefined` when it is not a council stage (single reviewer, as before). */
export function councilFor(config: Pick<BifConfig, 'council'>, taskType: TaskType): CouncilStage | undefined {
  const council = config.council;
  const stage = council?.stages?.[taskType];
  if (!council || !stage) return undefined;
  const seated = stage.members
    ? stage.members.flatMap((name) => council.members.find((m) => m.name === name) ?? [])
    : council.members;
  return {
    rounds: stage.rounds ?? council.rounds ?? COUNCIL_DEFAULTS.rounds,
    passScore: stage.passScore ?? council.passScore ?? COUNCIL_DEFAULTS.passScore,
    blockOn: council.blockOn ?? COUNCIL_DEFAULTS.blockOn,
    onUnavailable: council.onUnavailable ?? COUNCIL_DEFAULTS.onUnavailable,
    members: seated.map((m) => ({ ...m, blocking: m.blocking ?? true })),
  };
}

/**
 * Why `m` cannot be started with this configuration (its provider is disabled, or its model is not one
 * of the provider's `models`); `undefined` when it can. Such a member is never replaced by another model
 * (design §7): the caller reports it.
 */
export function memberUnavailable(config: Pick<BifConfig, 'providers'>, m: CouncilMember): string | undefined {
  const provider = config.providers[m.provider];
  if (!provider.enabled) return `provider '${m.provider}' is not enabled`;
  if (!provider.models.includes(m.model)) return `model '${m.model}' is not in providers.${m.provider}.models`;
  return undefined;
}

/** The configured council as the settings page shows it (design §9): defaults applied, read-only. */
export type CouncilOverview = Pick<CouncilStage, 'rounds' | 'passScore' | 'blockOn' | 'onUnavailable'> & {
  /** Every configured member, seated or not. `available`: this configuration can start it; `reason`: why not. */
  members: Array<CouncilMember & { available: boolean; reason?: string; stages: TaskType[] }>;
  /** The council stages with the rules and the seated members (by name) of each. */
  stages: Array<{ taskType: TaskType; rounds: number; passScore: number; members: string[] }>;
};

/**
 * The configured council with each member marked available or not (`memberUnavailable`: the same check
 * the round makes), and the stages it is seated in; `undefined` with no `council` block. A member that is
 * available here can still be unavailable in a round (its CLI does not start, its run gives no review).
 */
export function councilOverview(config: Pick<BifConfig, 'council' | 'providers'>): CouncilOverview | undefined {
  const council = config.council;
  if (!council) return undefined;
  const stages = TASK_TYPES.flatMap((taskType) => {
    const stage = councilFor(config, taskType);
    return stage ? [{ taskType, rounds: stage.rounds, passScore: stage.passScore, members: stage.members.map((m) => m.name) }] : [];
  });
  return {
    rounds: council.rounds ?? COUNCIL_DEFAULTS.rounds,
    passScore: council.passScore ?? COUNCIL_DEFAULTS.passScore,
    blockOn: council.blockOn ?? COUNCIL_DEFAULTS.blockOn,
    onUnavailable: council.onUnavailable ?? COUNCIL_DEFAULTS.onUnavailable,
    members: council.members.map((raw) => {
      const m: CouncilMember = { ...raw, blocking: raw.blocking ?? true };
      const reason = memberUnavailable(config, m);
      return {
        ...m, available: reason === undefined, ...(reason !== undefined ? { reason } : {}),
        stages: stages.filter((s) => s.members.includes(m.name)).map((s) => s.taskType),
      };
    }),
    stages,
  };
}
