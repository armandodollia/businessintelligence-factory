/**
 * Flow ranking arithmetic (design §10.1–§10.4, decision 5): the checklist score, the persona score
 * from head-to-head verdicts, their blend, the near-tie break and the user's pair overrides as hard
 * constraints. Pure functions: no store, no I/O. The read side that loads records and calls these is
 * elsewhere.
 */
import type { ChecklistItem, CheckAnswer, FlowCheck } from './types.js';

/** Points per answer; answers absent here (na, no_signal, recorded) are left out of the score. */
const ANSWER_POINTS: Partial<Record<CheckAnswer, number>> = { pass: 1, disputed: 0.5, fail: 0, reported_problem: 0 };

/**
 * 0–100, or undefined when no scored item applies. pass = 1, disputed = 0.5, fail and
 * reported_problem = 0; na, no_signal, recorded and unanswered are left out. Weighted by item weight;
 * unscored (audience-dependent) items and checks matching no item never count. Not rounded.
 */
export function checklistScore(items: ChecklistItem[], checks: Pick<FlowCheck, 'itemKey' | 'answer'>[]): number | undefined {
  return combinedChecklistScore([{ items, checks }]);
}

/**
 * One weighted mean over several checklists (the general and the specific one), each checklist's
 * items scored only against that checklist's answers, so an item key used by both lists never
 * matches the other list's answer. Same rules and range as `checklistScore`.
 */
export function combinedChecklistScore(lists: Array<{ items: ChecklistItem[]; checks: Pick<FlowCheck, 'itemKey' | 'answer'>[] }>): number | undefined {
  let points = 0;
  let weight = 0;
  for (const { items, checks } of lists) {
    const answers = new Map(checks.map((c) => [c.itemKey, c.answer]));
    for (const item of items) {
      if (!item.scored) continue;
      const answer = answers.get(item.key);
      const p = answer === undefined ? undefined : ANSWER_POINTS[answer];
      if (p === undefined) continue;
      points += p * item.weight;
      weight += item.weight;
    }
  }
  return weight > 0 ? (points / weight) * 100 : undefined;
}

/** One persona's verdict on a pair; `winner: 'a'` means `flowAId` won. */
export type PairVerdict = { flowAId: string; flowBId: string; personaId: string; winner: 'a' | 'b' | 'tie'; strength: 1 | 2 | 3 };

/**
 * 0–100 per flow, or absent when the flow is in no verdict. Winner gets 0.5 + strength/6, loser
 * 0.5 − strength/6, tie 0.5 each; mean per persona, then mean over the personas that judged the flow.
 * Verdicts naming a flow outside `flowIds` are ignored.
 */
export function personaScores(flowIds: string[], verdicts: PairVerdict[]): Map<string, number> {
  const known = new Set(flowIds);
  /** flow id → persona id → per-verdict points. */
  const points = new Map<string, Map<string, number[]>>();
  const add = (flowId: string, personaId: string, p: number) => {
    let byPersona = points.get(flowId);
    if (!byPersona) points.set(flowId, (byPersona = new Map()));
    let list = byPersona.get(personaId);
    if (!list) byPersona.set(personaId, (list = []));
    list.push(p);
  };
  for (const v of verdicts) {
    if (!known.has(v.flowAId) || !known.has(v.flowBId)) continue;
    const margin = v.winner === 'tie' ? 0 : v.strength / 6;
    const aSign = v.winner === 'a' ? 1 : v.winner === 'b' ? -1 : 0;
    add(v.flowAId, v.personaId, 0.5 + aSign * margin);
    add(v.flowBId, v.personaId, 0.5 - aSign * margin);
  }
  const mean = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / xs.length;
  const scores = new Map<string, number>();
  for (const [flowId, byPersona] of points) scores.set(flowId, mean([...byPersona.values()].map(mean)) * 100);
  return scores;
}

/** > 0 when a is preferred: Σ over the verdicts on the pair of ±strength (tie 0). */
export function pairPreference(aId: string, bId: string, verdicts: PairVerdict[]): number {
  let sum = 0;
  for (const v of verdicts) {
    if (v.winner === 'tie') continue;
    const winnerId = v.winner === 'a' ? v.flowAId : v.flowBId;
    const loserId = v.winner === 'a' ? v.flowBId : v.flowAId;
    if (winnerId === aId && loserId === bId) sum += v.strength;
    else if (winnerId === bId && loserId === aId) sum -= v.strength;
  }
  return sum;
}

export type RankInput = { flowId: string; checklist?: number; persona?: number };
/** The user's ruling that `winnerFlowId` is better than `loserFlowId`. */
export type RankOverride = { id: string; winnerFlowId: string; loserFlowId: string; createdAt: string };
export type RankedFlow = {
  flowId: string;
  /** 1-based; flows sharing a position have the same one and the next continues the count (1, 1, 3). */
  position: number;
  rankScore: number | undefined;
  checklist?: number;
  persona?: number;
  decidedBy: 'blend' | 'checklist_only' | 'persona_only' | 'none';
  /** The flow(s) this one swapped places with on a near-tie head-to-head. */
  tieBrokenWith?: string[];
  sharedPosition?: boolean;
  /** Ids of the overrides that moved this flow or the flow it was ruled against. */
  overriddenBy?: string[];
};

/**
 * An override `rankFlows` did not apply: `conflict` — it contradicts newer overrides (it would close a
 * cycle with them); `not_ranked` — one of its flows is not among the ranked flows.
 */
export type IgnoredOverride = { id: string; reason: 'conflict' | 'not_ranked' };

const pairKey = (x: string, y: string) => (x < y ? `${x}\u0000${y}` : `${y}\u0000${x}`);

/**
 * Orders flows by rank score (the blend, or whichever score exists), breaks near-ties by the pair's
 * head-to-head (or marks them as sharing a position), then applies the user's overrides as hard
 * constraints, newest winning a conflict. Returns the order and the ignored overrides, each with why.
 */
export function rankFlows(
  inputs: RankInput[],
  opts: { coverage: number; tieMargin: number; verdicts: PairVerdict[]; overrides: RankOverride[] },
): { ranked: RankedFlow[]; ignoredOverrides: IgnoredOverride[] } {
  // 1. Rank score.
  const flows = new Map<string, RankedFlow>();
  for (const input of inputs) {
    const { flowId, checklist, persona } = input;
    const scored: RankedFlow =
      checklist !== undefined && persona !== undefined
        ? { flowId, position: 0, rankScore: opts.coverage * checklist + (1 - opts.coverage) * persona, decidedBy: 'blend' }
        : checklist !== undefined
          ? { flowId, position: 0, rankScore: checklist, decidedBy: 'checklist_only' }
          : persona !== undefined
            ? { flowId, position: 0, rankScore: persona, decidedBy: 'persona_only' }
            : { flowId, position: 0, rankScore: undefined, decidedBy: 'none' };
    if (checklist !== undefined) scored.checklist = checklist;
    if (persona !== undefined) scored.persona = persona;
    flows.set(flowId, scored);
  }

  // 2. Score descending, ties by flow id; unscored last, by flow id.
  const order = [...flows.values()].sort((x, y) => {
    if (x.rankScore === undefined || y.rankScore === undefined) {
      if (x.rankScore !== y.rankScore) return x.rankScore === undefined ? 1 : -1;
    } else if (x.rankScore !== y.rankScore) return y.rankScore - x.rankScore;
    return x.flowId < y.flowId ? -1 : x.flowId > y.flowId ? 1 : 0;
  });

  // 3. One tie-break pass, top to bottom; a flow moves at most one place.
  const shared = new Set<string>();
  const moved = new Set<string>();
  for (let i = 0; i + 1 < order.length; i++) {
    const upper = order[i]!;
    const lower = order[i + 1]!;
    if (upper.rankScore === undefined || lower.rankScore === undefined) continue;
    if (Math.abs(upper.rankScore - lower.rankScore) >= opts.tieMargin) continue;
    const preference = pairPreference(lower.flowId, upper.flowId, opts.verdicts);
    if (preference > 0 && !moved.has(upper.flowId) && !moved.has(lower.flowId)) {
      order[i] = lower;
      order[i + 1] = upper;
      moved.add(upper.flowId).add(lower.flowId);
      (upper.tieBrokenWith ??= []).push(lower.flowId);
      (lower.tieBrokenWith ??= []).push(upper.flowId);
    } else if (preference === 0) {
      shared.add(pairKey(upper.flowId, lower.flowId));
    }
  }

  // 4. Overrides: newest first, drop one that would close a cycle with the newer ones already kept.
  const ignored = new Map<string, IgnoredOverride['reason']>();
  const sortedOverrides = [...opts.overrides].sort((x, y) =>
    x.createdAt !== y.createdAt ? (x.createdAt < y.createdAt ? -1 : 1) : x.id < y.id ? -1 : x.id > y.id ? 1 : 0,
  );
  /** winner id → loser ids, of the kept overrides. */
  const beats = new Map<string, Set<string>>();
  const reaches = (from: string, to: string): boolean => {
    const seen = new Set<string>();
    const stack = [from];
    while (stack.length > 0) {
      const id = stack.pop()!;
      if (id === to) return true;
      if (seen.has(id)) continue;
      seen.add(id);
      for (const next of beats.get(id) ?? []) stack.push(next);
    }
    return false;
  };
  for (const o of [...sortedOverrides].reverse()) {
    if (!flows.has(o.winnerFlowId) || !flows.has(o.loserFlowId)) {
      ignored.set(o.id, 'not_ranked');
      continue;
    }
    if (reaches(o.loserFlowId, o.winnerFlowId)) {
      ignored.set(o.id, 'conflict');
      continue;
    }
    let losers = beats.get(o.winnerFlowId);
    if (!losers) beats.set(o.winnerFlowId, (losers = new Set()));
    losers.add(o.loserFlowId);
  }
  const kept = sortedOverrides.filter((o) => !ignored.has(o.id));

  const markOverride = (flow: RankedFlow, overrideId: string) => {
    const by = (flow.overriddenBy ??= []);
    if (!by.includes(overrideId)) by.push(overrideId);
  };
  const maxPasses = Math.max(1, order.length * order.length);
  for (let pass = 0; pass < maxPasses; pass++) {
    let violated = false;
    for (const o of kept) {
      const w = order.findIndex((f) => f.flowId === o.winnerFlowId);
      const l = order.findIndex((f) => f.flowId === o.loserFlowId);
      if (w < l) continue;
      violated = true;
      const [winner] = order.splice(w, 1);
      order.splice(l, 0, winner!);
      markOverride(winner!, o.id);
      markOverride(order[l + 1]!, o.id);
    }
    if (!violated) break;
  }

  // 5. Positions: a flow marked as sharing with the flow directly above it takes that flow's position,
  // unless a kept override rules on the pair.
  const ruled = new Set(kept.map((o) => pairKey(o.winnerFlowId, o.loserFlowId)));
  order.forEach((flow, i) => {
    const above = order[i - 1];
    const key = above ? pairKey(above.flowId, flow.flowId) : undefined;
    if (above && key !== undefined && shared.has(key) && !ruled.has(key)) {
      flow.position = above.position;
      above.sharedPosition = true;
      flow.sharedPosition = true;
    } else {
      flow.position = i + 1;
    }
  });

  return { ranked: order, ignoredOverrides: sortedOverrides.flatMap((o) => (ignored.has(o.id) ? [{ id: o.id, reason: ignored.get(o.id)! }] : [])) };
}
