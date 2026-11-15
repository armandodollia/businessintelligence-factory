/**
 * Head-to-head verdicts (design 2026-11-14-flow-records-and-ranking-design.md §10.2): storage of the
 * personas' verdicts, which of them are live, the stage 1 sittings that ask every missing pair once,
 * and the pairs that deserve a stage 2 (focused) head-to-head. Storage and selection only: the
 * persona runs are in the ranking round.
 *
 * - A verdict is stored with `flowAId < flowBId` (the winner flipped when the persona wrote the pair
 *   the other way round). Its reason is third-party-influenced text: stored redacted, fence-stripped
 *   and capped at `REASON_MAX_CHARS`.
 * - One live verdict per persona and pair. A broad verdict for a pair that already has one from the
 *   same persona and persona version is not stored (first wins, so replays cannot double-count). A
 *   focused verdict supersedes the persona's earlier verdicts on that pair at the same persona
 *   version; the superseded rows are kept (`supersededById` points at the focused one).
 * - Live: not superseded, both flows `current` in the caller's tree, persona version equal to the
 *   persona's current version (a verdict of a persona that no longer exists is not live). A new flow
 *   version is a new flow id, so verdicts on the old one go stale by themselves.
 */
import { redactServed, stripFences } from '../knowledge/trust.js';
import type { Store } from '../store/db.js';
import { newId } from '../store/repos.js';
import type { Persona } from '../types.js';
import { rootOf } from '../workspace/tree.js';
import type { FlowsSettings } from './config.js';
import type { RankedFlow } from './ranking.js';
import { flowRepos } from './repos.js';
import type { FlowVerdict } from './types.js';

export type VerdictInput = { a: string; b: string; winner: 'a' | 'b' | 'tie'; strength: 1 | 2 | 3; confidence: number; reason: string };

export const REASON_MAX_CHARS = 400;

const WINNERS: readonly VerdictInput['winner'][] = ['a', 'b', 'tie'];

const pairKey = (x: string, y: string) => (x < y ? `${x}\u0000${y}` : `${y}\u0000${x}`);
const ordered = (x: string, y: string): [string, string] => (x < y ? [x, y] : [y, x]);

/**
 * Normalizes each pair to flowAId < flowBId (flipping the winner), keeps the first verdict per pair, drops unknown ids. A focused verdict supersedes the persona's broad one for that pair.
 *
 * Dropped (counted in `dropped`): an id outside `allowed` or not a flow of `flowTypeId` in the
 * caller's tree, `a === b`, a winner other than a/b/tie, a strength other than 1/2/3, a confidence
 * outside 0–1, a non-text reason, a pair already kept earlier in the same call, and a broad verdict
 * on a pair that already has a non-superseded verdict from this persona at this version.
 */
export function recordVerdicts(
  store: Store,
  ctx: { workspaceId: string; flowTypeId: string; persona: Pick<Persona, 'id' | 'version'>; stage: 'broad' | 'focused'; agentRunId?: string; allowed: string[] },
  verdicts: VerdictInput[],
): { saved: number; dropped: number } {
  const r = flowRepos(store);
  const rootId = rootOf(store, ctx.workspaceId);
  const allowed = new Set(ctx.allowed.filter((id) => {
    const f = r.flows.get(id);
    return f !== undefined && f.rootWorkspaceId === rootId && f.flowTypeId === ctx.flowTypeId;
  }));
  const result = { saved: 0, dropped: 0 };
  const seen = new Set<string>();

  return store.transaction(() => {
    /** This persona's non-superseded verdicts at this version, by pair. */
    const existing = new Map<string, FlowVerdict[]>();
    for (const v of r.flowVerdicts.list({ workspaceId: ctx.workspaceId, flowTypeId: ctx.flowTypeId, personaId: ctx.persona.id, personaVersion: ctx.persona.version })) {
      if (v.supersededById !== undefined) continue;
      const k = pairKey(v.flowAId, v.flowBId);
      existing.set(k, [...(existing.get(k) ?? []), v]);
    }

    for (const v of Array.isArray(verdicts) ? verdicts : []) {
      if (!isValid(v) || !allowed.has(v.a) || !allowed.has(v.b) || v.a === v.b) {
        result.dropped++;
        continue;
      }
      const k = pairKey(v.a, v.b);
      const earlier = existing.get(k) ?? [];
      if (seen.has(k) || (ctx.stage === 'broad' && earlier.length > 0)) {
        result.dropped++;
        continue;
      }
      seen.add(k);
      const flipped = v.a > v.b;
      const [flowAId, flowBId] = ordered(v.a, v.b);
      const row: FlowVerdict = {
        id: newId('fvd'),
        workspaceId: ctx.workspaceId,
        flowTypeId: ctx.flowTypeId,
        flowAId,
        flowBId,
        personaId: ctx.persona.id,
        personaVersion: ctx.persona.version,
        stage: ctx.stage,
        winner: flipped && v.winner !== 'tie' ? (v.winner === 'a' ? 'b' : 'a') : v.winner,
        strength: v.strength,
        confidence: v.confidence,
        reason: stripFences(redactServed(store, ctx.workspaceId, v.reason)).trim().slice(0, REASON_MAX_CHARS).trim(),
        createdAt: new Date().toISOString(),
      };
      if (ctx.agentRunId !== undefined) row.agentRunId = ctx.agentRunId;
      r.flowVerdicts.insert(row);
      for (const old of earlier) r.flowVerdicts.update(old.id, { supersededById: row.id });
      existing.set(k, [row]);
      result.saved++;
    }
    return result;
  });
}

function isValid(v: VerdictInput): boolean {
  return (
    v !== null && typeof v === 'object' &&
    typeof v.a === 'string' && typeof v.b === 'string' &&
    WINNERS.includes(v.winner) &&
    (v.strength === 1 || v.strength === 2 || v.strength === 3) &&
    typeof v.confidence === 'number' && v.confidence >= 0 && v.confidence <= 1 &&
    typeof v.reason === 'string'
  );
}

/** Live verdicts: not superseded, both flows current, persona version equals the persona's current version. */
export function liveVerdicts(store: Store, workspaceId: string, flowTypeId: string): FlowVerdict[] {
  const r = flowRepos(store);
  const rootId = rootOf(store, workspaceId);
  const current = new Map<string, boolean>();
  const isCurrent = (id: string) => {
    let c = current.get(id);
    if (c === undefined) {
      const f = r.flows.get(id);
      c = f !== undefined && f.lifecycle === 'current' && f.rootWorkspaceId === rootId && f.flowTypeId === flowTypeId;
      current.set(id, c);
    }
    return c;
  };
  const personaVersions = new Map<string, number | undefined>();
  const versionOf = (id: string) => {
    if (!personaVersions.has(id)) personaVersions.set(id, store.personas.get(id)?.version);
    return personaVersions.get(id);
  };

  /** One per persona and pair: the focused verdict when there is one, else the first. */
  const live = new Map<string, FlowVerdict>();
  for (const v of r.flowVerdicts.list({ workspaceId, flowTypeId })) {
    if (v.supersededById !== undefined || v.personaVersion !== versionOf(v.personaId)) continue;
    if (!isCurrent(v.flowAId) || !isCurrent(v.flowBId)) continue;
    const k = `${v.personaId}\u0000${v.flowAId}\u0000${v.flowBId}`;
    const held = live.get(k);
    if (!held || (held.stage === 'broad' && v.stage === 'focused')) live.set(k, v);
  }
  return [...live.values()];
}

/** Pairs of `flowIds` this persona has no live verdict for. */
export function missingPairs(store: Store, workspaceId: string, flowTypeId: string, persona: Pick<Persona, 'id' | 'version'>, flowIds: string[]): Array<[string, string]> {
  const judged = new Set(
    liveVerdicts(store, workspaceId, flowTypeId)
      .filter((v) => v.personaId === persona.id && v.personaVersion === persona.version)
      .map((v) => pairKey(v.flowAId, v.flowBId)),
  );
  const ids = [...new Set(flowIds)];
  const out: Array<[string, string]> = [];
  ids.forEach((x, i) => {
    for (const y of ids.slice(i + 1)) if (!judged.has(pairKey(x, y))) out.push(ordered(x, y));
  });
  return out;
}

/**
 * Groups for stage 1 so that every missing pair is asked exactly once.
 *
 * Up to `maxFlowsPerSitting` flows: one sitting of all of them. More: the ids (in the given order)
 * are split into blocks of floor(max / 2); each pair of blocks i < j makes one sitting of both
 * blocks, asking the missing pairs across them plus each block's own missing pairs in the first
 * sitting that contains the block. Sittings with nothing to ask are dropped. Pairs come out as
 * [lower id, higher id], in the order of `missing`; pairs naming an id outside `flowIds` are ignored.
 */
export function sittings(flowIds: string[], missing: Array<[string, string]>, maxFlowsPerSitting: number): Array<{ flowIds: string[]; pairs: Array<[string, string]> }> {
  const ids = [...new Set(flowIds)];
  const known = new Set(ids);
  const pairs: Array<[string, string]> = [];
  const seen = new Set<string>();
  for (const [x, y] of missing) {
    const k = pairKey(x, y);
    if (x === y || !known.has(x) || !known.has(y) || seen.has(k)) continue;
    seen.add(k);
    pairs.push(ordered(x, y));
  }
  if (pairs.length === 0) return [];
  if (ids.length <= maxFlowsPerSitting) return [{ flowIds: ids, pairs }];

  const size = Math.max(1, Math.floor(maxFlowsPerSitting / 2));
  const blocks: string[][] = [];
  for (let i = 0; i < ids.length; i += size) blocks.push(ids.slice(i, i + size));
  const blockOf = new Map(blocks.flatMap((block, i) => block.map((id): [string, number] => [id, i])));

  /** Sittings in block-pair order (0,1), (0,2), …, (1,2), …; a block first appears in (0,1) or (0,k). */
  const out: Array<{ flowIds: string[]; pairs: Array<[string, string]> }> = [];
  const index = new Map<string, number>();
  for (let i = 0; i < blocks.length; i++) {
    for (let j = i + 1; j < blocks.length; j++) {
      index.set(`${i},${j}`, out.length);
      out.push({ flowIds: [...blocks[i]!, ...blocks[j]!], pairs: [] });
    }
  }
  for (const pair of pairs) {
    const bx = blockOf.get(pair[0])!;
    const by = blockOf.get(pair[1])!;
    const [i, j] = bx === by ? (bx === 0 ? [0, 1] : [0, bx]) : bx < by ? [bx, by] : [by, bx];
    out[index.get(`${i},${j}`)!]!.pairs.push(pair);
  }
  return out.filter((s) => s.pairs.length > 0);
}

export type FocusReason = 'low_confidence' | 'personas_split' | 'loop' | 'close_in_ranking' | 'top_three' | 'contradicts_checklist' | 'user_disagreed';

/** Most rank-relevant first. */
const REASON_ORDER: readonly FocusReason[] = ['user_disagreed', 'top_three', 'close_in_ranking', 'contradicts_checklist', 'personas_split', 'loop', 'low_confidence'];

/**
 * The (persona, pair) combinations that get a stage 2 head-to-head, most rank-relevant first, at most
 * `maxFocusedComparisons`. `verdicts` are the live verdicts; `checklist` maps flow id → checklist
 * score. Pairs come out as a < b. Every reason except `user_disagreed` needs a live broad verdict of
 * that persona on the pair and never applies when that persona has a live focused verdict on it.
 * A `disagreed` entry is always returned (reason `user_disagreed` only, when a live focused verdict
 * exists): spec §10.2 re-judges a pair the user disagreed on in the next round.
 * Ordered by the most relevant reason (`REASON_ORDER`), then by the best position of the two flows.
 *
 * Caller contract: `disagreed` holds only disagreements with a verdict that is still the live one for
 * that persona and pair. Once a newer focused verdict replaces it, the disagreement is no longer
 * passed in, so a pair is not re-judged endlessly.
 */
export function focusedPairs(input: {
  verdicts: FlowVerdict[];
  ranked: RankedFlow[];
  checklist: Map<string, number | undefined>;
  disagreed: Array<{ personaId: string; a: string; b: string }>;
  settings: FlowsSettings;
}): Array<{ personaId: string; a: string; b: string; reasons: FocusReason[] }> {
  const { verdicts, ranked, checklist, settings } = input;
  const broad = verdicts.filter((v) => v.stage === 'broad');
  const focused = new Set(verdicts.filter((v) => v.stage === 'focused').map((v) => `${v.personaId}\u0000${pairKey(v.flowAId, v.flowBId)}`));

  const picked = new Map<string, { personaId: string; a: string; b: string; reasons: Set<FocusReason> }>();
  const add = (personaId: string, x: string, y: string, reason: FocusReason) => {
    if (x === y) return;
    const [a, b] = ordered(x, y);
    const k = `${personaId}\u0000${pairKey(a, b)}`;
    let item = picked.get(k);
    if (!item) picked.set(k, (item = { personaId, a, b, reasons: new Set() }));
    item.reasons.add(reason);
  };
  /** Live broad verdicts by pair. */
  const broadByPair = new Map<string, FlowVerdict[]>();
  for (const v of broad) {
    const k = pairKey(v.flowAId, v.flowBId);
    broadByPair.set(k, [...(broadByPair.get(k) ?? []), v]);
  }
  const winnerOf = (v: FlowVerdict) => (v.winner === 'a' ? v.flowAId : v.flowBId);
  const loserOf = (v: FlowVerdict) => (v.winner === 'a' ? v.flowBId : v.flowAId);

  // low_confidence, contradicts_checklist
  for (const v of broad) {
    if (v.confidence < settings.lowConfidence) add(v.personaId, v.flowAId, v.flowBId, 'low_confidence');
    if (v.strength === 3 && v.winner !== 'tie') {
      const w = checklist.get(winnerOf(v));
      const l = checklist.get(loserOf(v));
      if (w !== undefined && l !== undefined && l - w > 20) add(v.personaId, v.flowAId, v.flowBId, 'contradicts_checklist');
    }
  }

  // personas_split: decided winners differ across personas (any live verdict); every persona on the pair.
  const byPair = new Map<string, FlowVerdict[]>();
  for (const v of verdicts) {
    const k = pairKey(v.flowAId, v.flowBId);
    byPair.set(k, [...(byPair.get(k) ?? []), v]);
  }
  for (const onPair of byPair.values()) {
    if (new Set(onPair.filter((v) => v.winner !== 'tie').map(winnerOf)).size > 1) {
      for (const v of onPair) add(v.personaId, v.flowAId, v.flowBId, 'personas_split');
    }
  }

  // loop: 3-cycles in each persona's broad verdicts.
  const beatsByPersona = new Map<string, Map<string, Set<string>>>();
  for (const v of broad) {
    if (v.winner === 'tie') continue;
    let beats = beatsByPersona.get(v.personaId);
    if (!beats) beatsByPersona.set(v.personaId, (beats = new Map()));
    let losers = beats.get(winnerOf(v));
    if (!losers) beats.set(winnerOf(v), (losers = new Set()));
    losers.add(loserOf(v));
  }
  for (const [personaId, beats] of beatsByPersona) {
    for (const [x, xs] of beats) {
      for (const y of xs) {
        for (const z of beats.get(y) ?? []) {
          if (z !== x && beats.get(z)?.has(x)) {
            add(personaId, x, y, 'loop');
            add(personaId, y, z, 'loop');
            add(personaId, z, x, 'loop');
          }
        }
      }
    }
  }

  // close_in_ranking, top_three: adjacent flows, for each persona with a live broad verdict on the pair.
  for (let i = 0; i + 1 < ranked.length; i++) {
    const upper = ranked[i]!;
    const lower = ranked[i + 1]!;
    const onPair = broadByPair.get(pairKey(upper.flowId, lower.flowId)) ?? [];
    const close = upper.rankScore !== undefined && lower.rankScore !== undefined && Math.abs(upper.rankScore - lower.rankScore) < settings.tieMargin;
    const topThree = Math.min(upper.position, lower.position) <= 3;
    for (const v of onPair) {
      if (topThree) add(v.personaId, v.flowAId, v.flowBId, 'top_three');
      if (close) add(v.personaId, v.flowAId, v.flowBId, 'close_in_ranking');
    }
  }

  for (const d of input.disagreed) add(d.personaId, d.a, d.b, 'user_disagreed');

  const positionOf = new Map(ranked.map((f) => [f.flowId, f.position]));
  const pos = (id: string) => positionOf.get(id) ?? Number.POSITIVE_INFINITY;
  const rank = (reasons: FocusReason[]) => REASON_ORDER.indexOf(reasons[0]!);
  const cmp = (x: string, y: string) => (x < y ? -1 : x > y ? 1 : 0);
  return [...picked.entries()]
    // With a live focused verdict, only the user's disagreement selects the pair again.
    .map(([k, item]) => ({ item, reasons: focused.has(k) ? REASON_ORDER.filter((r) => r === 'user_disagreed' && item.reasons.has(r)) : REASON_ORDER.filter((r) => item.reasons.has(r)) }))
    .filter(({ reasons }) => reasons.length > 0)
    .map(({ item, reasons }) => ({ personaId: item.personaId, a: item.a, b: item.b, reasons }))
    .map((item) => ({ item, best: Math.min(pos(item.a), pos(item.b)), other: Math.max(pos(item.a), pos(item.b)) }))
    .sort((x, y) =>
      rank(x.item.reasons) - rank(y.item.reasons) || x.best - y.best || x.other - y.other ||
      cmp(x.item.personaId, y.item.personaId) || cmp(x.item.a, y.item.a) || cmp(x.item.b, y.item.b))
    .slice(0, Math.max(0, settings.maxFocusedComparisons))
    .map(({ item }) => item);
}
