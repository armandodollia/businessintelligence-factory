/**
 * Flow rankings, read side (design 2026-11-14-flow-records-and-ranking-design.md §10, §10.5): the
 * ranking of one node and one flow type, computed from stored records whenever it is read, the
 * explanation of one flow's position, and the snapshots stored at the end of a ranking round.
 *
 * - Flows: `rankableFlows` (the node's own subjects, primary variants unless `allVariants`); each
 *   row says whether it is its subject's primary variant (`isPrimaryVariant`'s rule).
 * - Checklist score: the flow's answers on the active general and specific checklists, each list
 *   scored against its own rows (`combinedChecklistScore`).
 * - Persona score: the live verdicts (one per persona and pair, `liveVerdicts`) of the node's usable
 *   personas, or of one persona for a per-audience ranking.
 * - Overrides apply to flow lineages: each non-revoked override is mapped to the current flows of
 *   its two lineages (`currentOfLineage`); one whose lineage has no current flow is skipped.
 *
 * Reads only, except that the catalog is seeded on first use (`ensureCatalog`) and
 * `snapshotRankings` stores snapshots.
 */
import type { BifConfig } from '../config/schema.js';
import { isOutputUsable } from '../research/outputs.js';
import type { Store } from '../store/db.js';
import { segmentPersonas } from '../stakeholders/personas.js';
import { newId } from '../store/repos.js';
import { rootOf } from '../workspace/tree.js';
import { activeChecklists, coverageOf, FlowCatalogError, listFlowTypes } from './catalog.js';
import { flowChecks } from './checks.js';
import { flowsSettings } from './config.js';
import { currentOfLineage, isPrimaryVariant, rankableFlows } from './flows.js';
import { combinedChecklistScore, personaScores, rankFlows, type IgnoredOverride, type RankedFlow, type RankInput, type RankOverride } from './ranking.js';
import { flowRepos } from './repos.js';
import { mentionsFor, reviewDigest } from './reviews.js';
import type { Checklist, Flow, FlowCheck, FlowOverride, FlowRankSnapshot, FlowType, FlowVerdict, ReviewMention } from './types.js';
import { liveVerdicts } from './verdicts.js';

export type NodeRanking = {
  flowType: FlowType;
  /**
   * The type is ranked (status `active`). A proposed type takes part in no ranking until the user
   * accepts it (spec §8.1): its flows are listed in insertion order with their checklist scores only
   * (position 0, no rank or persona score, no verdict, no override applied).
   */
  isRanked: boolean;
  coverage: number;
  ranked: Array<
    RankedFlow & {
      flow: Flow;
      /** The subject's primary variant (flagged, or standing in for an unflagged subject). */
      primary: boolean;
      partial: boolean;
      reviews: { total: number; negative: number };
      wins: number;
      comparisons: number;
    }
  >;
  /**
   * The node's live overrides the order does not follow, each with why: `conflict` (contradicts a
   * newer one) or `not_ranked` (one of its flows is not in this ranking: a non-primary variant in the
   * default view, a flow no longer usable).
   */
  ignoredOverrides: IgnoredOverride[];
  /** The node has no usable persona: the ranking rests on the checklist alone. */
  noPersonas: boolean;
  /** Proposals of the business tree waiting on the user. */
  pendingProposals: { flowTypes: number; checklists: number };
};

/** Ids of the node's usable segment personas (verified, or included by the user); stakeholders judge no flows. */
export function usablePersonaIds(store: Store, workspaceId: string): Set<string> {
  return new Set(segmentPersonas(store, workspaceId).filter(isOutputUsable).map((p) => p.id));
}

/** The active general checklist, then the active specific one of the type (when there is one). */
function checklistsOf(store: Store, workspaceId: string, flowTypeId: string): Checklist[] {
  const { general, specific } = activeChecklists(store, workspaceId, flowTypeId);
  return specific ? [general, specific] : [general];
}

/** Checklist score of a flow: every list's items against that list's answers, one weighted mean. */
function scoreOn(lists: Checklist[], rows: FlowCheck[]): number | undefined {
  return combinedChecklistScore(lists.map((c) => ({ items: c.items, checks: rows.filter((r) => r.checklistId === c.id) })));
}

/** The flow type, of the caller's tree; FlowCatalogError 404 otherwise. */
function flowTypeOf(store: Store, workspaceId: string, flowTypeId: string): FlowType {
  const t = flowRepos(store).flowTypes.get(flowTypeId);
  if (!t || t.rootWorkspaceId !== rootOf(store, workspaceId)) throw new FlowCatalogError(`flow type ${flowTypeId} not found`, 404);
  return t;
}

/** Non-revoked overrides of the node and type, mapped to the current flows of their lineages. */
function lineageOverrides(store: Store, workspaceId: string, flowTypeId: string): RankOverride[] {
  const out: RankOverride[] = [];
  for (const o of flowRepos(store).flowOverrides.list({ workspaceId, flowTypeId })) {
    if (o.revokedAt) continue;
    const winner = currentOfLineage(store, o.winnerFlowId);
    const loser = currentOfLineage(store, o.loserFlowId);
    if (!winner || !loser) continue;
    out.push({ id: o.id, winnerFlowId: winner.id, loserFlowId: loser.id, createdAt: o.createdAt });
  }
  return out;
}

/**
 * The node's ranking of one flow type (spec §10, §12.2): positions, both scores, the head-to-head
 * record (`wins` of `comparisons`, ties counted as comparisons), review counts and the partial
 * flag. `personaId` ranks on that persona's verdicts only (the per-audience ranking).
 */
export function nodeRanking(
  store: Store,
  config: Pick<BifConfig, 'flows'>,
  workspaceId: string,
  flowTypeId: string,
  opts: { personaId?: string; allVariants?: boolean } = {},
): NodeRanking {
  const settings = flowsSettings(config);
  const r = flowRepos(store);
  const flowType = flowTypeOf(store, workspaceId, flowTypeId);
  const isRanked = flowType.status === 'active';
  const root = flowType.rootWorkspaceId;
  const coverage = coverageOf(store, workspaceId, flowTypeId);
  const flows = rankableFlows(store, workspaceId, flowTypeId, { allVariants: opts.allVariants === true });
  const ids = new Set(flows.map((f) => f.id));
  const primaries = opts.allVariants ? new Set(rankableFlows(store, workspaceId, flowTypeId).map((f) => f.id)) : ids;
  const personas = usablePersonaIds(store, workspaceId);
  const verdicts = liveVerdicts(store, workspaceId, flowTypeId).filter(
    (v) =>
      isRanked &&
      personas.has(v.personaId) &&
      (opts.personaId === undefined || v.personaId === opts.personaId) &&
      ids.has(v.flowAId) &&
      ids.has(v.flowBId),
  );

  const lists = checklistsOf(store, workspaceId, flowTypeId);
  const persona = personaScores([...ids], verdicts);
  const inputs: RankInput[] = flows.map((f) => {
    const input: RankInput = { flowId: f.id };
    const checklist = scoreOn(lists, flowChecks(store, f.id));
    if (checklist !== undefined) input.checklist = checklist;
    const p = persona.get(f.id);
    if (p !== undefined) input.persona = p;
    return input;
  });
  const { ranked, ignoredOverrides } = isRanked
    ? rankFlows(inputs, { coverage, tieMargin: settings.tieMargin, verdicts, overrides: lineageOverrides(store, workspaceId, flowTypeId) })
    : { ranked: inputs.map((i): RankedFlow => ({ ...i, position: 0, rankScore: undefined, decidedBy: 'none' })), ignoredOverrides: [] };

  const byId = new Map(flows.map((f) => [f.id, f]));
  return {
    flowType,
    isRanked,
    coverage,
    ranked: ranked.map((rf) => {
      const flow = byId.get(rf.flowId)!;
      const mine = verdicts.filter((v) => v.flowAId === rf.flowId || v.flowBId === rf.flowId);
      const wins = mine.filter((v) => v.winner !== 'tie' && (v.winner === 'a' ? v.flowAId : v.flowBId) === rf.flowId).length;
      const digest = reviewDigest(store, flow, settings);
      return {
        ...rf,
        flow,
        primary: primaries.has(flow.id),
        partial: !flow.reachedGoal,
        reviews: { total: digest.total, negative: digest.negative },
        wins,
        comparisons: mine.length,
      };
    }),
    ignoredOverrides,
    noPersonas: personas.size === 0,
    pendingProposals: {
      flowTypes: r.flowTypes.list({ rootWorkspaceId: root, status: 'proposed' }).length,
      checklists: r.checklists.list({ rootWorkspaceId: root, status: 'proposed' }).length,
    },
  };
}

/**
 * Everything behind one flow's position (spec §10.5): each answer on the active checklists with its
 * question and whether it is scored; the live verdicts of the node's usable personas on the flow
 * (labelled simulated, with the opponent); the review mentions of its subject and type; every
 * non-revoked override naming the flow's lineage (moved or not); both scores and the coverage. The
 * persona score is the one of the node's ranking the flow takes part in (undefined when it is not
 * rankable). FlowCatalogError 404 for a flow outside the caller's tree.
 */
export function explainPosition(
  store: Store,
  config: Pick<BifConfig, 'flows'>,
  workspaceId: string,
  flowId: string,
): {
  checks: Array<FlowCheck & { question: string; scored: boolean }>;
  verdicts: Array<FlowVerdict & { simulated: true; opponentId: string }>;
  mentions: ReviewMention[];
  overrides: FlowOverride[];
  checklist?: number;
  persona?: number;
  coverage: number;
} {
  const r = flowRepos(store);
  const flow = r.flows.get(flowId);
  if (!flow || flow.rootWorkspaceId !== rootOf(store, workspaceId)) throw new FlowCatalogError(`flow ${flowId} not found`, 404);

  const lists = checklistsOf(store, workspaceId, flow.flowTypeId);
  const rows = flowChecks(store, flow.id);
  const checks = lists.flatMap((c) =>
    rows
      .filter((row) => row.checklistId === c.id)
      .flatMap((row) => {
        const item = c.items.find((i) => i.key === row.itemKey);
        return item ? [{ ...row, question: item.question, scored: item.scored }] : [];
      }),
  );

  const personas = usablePersonaIds(store, workspaceId);
  const verdicts = liveVerdicts(store, workspaceId, flow.flowTypeId)
    .filter((v) => personas.has(v.personaId) && (v.flowAId === flow.id || v.flowBId === flow.id))
    .map((v) => ({ ...v, simulated: true as const, opponentId: v.flowAId === flow.id ? v.flowBId : v.flowAId }));

  const lineageOf = (id: string) => r.flows.get(id)?.lineageId;
  const overrides = r.flowOverrides
    .list({ workspaceId, flowTypeId: flow.flowTypeId })
    .filter((o) => !o.revokedAt && (lineageOf(o.winnerFlowId) === flow.lineageId || lineageOf(o.loserFlowId) === flow.lineageId));

  const out: ReturnType<typeof explainPosition> = {
    checks,
    verdicts,
    mentions: mentionsFor(store, workspaceId, { subjectEntityId: flow.subjectEntityId, flowTypeId: flow.flowTypeId }),
    overrides,
    coverage: coverageOf(store, workspaceId, flow.flowTypeId),
  };
  const checklist = scoreOn(lists, rows);
  if (checklist !== undefined) out.checklist = checklist;
  const ranked = nodeRanking(store, config, workspaceId, flow.flowTypeId, { allVariants: !isPrimaryVariant(store, flow) }).ranked.find((f) => f.flowId === flow.id);
  if (ranked?.persona !== undefined) out.persona = ranked.persona;
  return out;
}

/**
 * Stores one snapshot per ranked flow type of the node (every active type with at least one
 * rankable flow): its positions and rank scores now. Returns the stored snapshots.
 */
export function snapshotRankings(store: Store, config: Pick<BifConfig, 'flows'>, workspaceId: string, researchRunId?: string): FlowRankSnapshot[] {
  const snapshots = flowRepos(store).rankSnapshots;
  const out: FlowRankSnapshot[] = [];
  for (const t of listFlowTypes(store, workspaceId, { status: 'active' })) {
    const { ranked } = nodeRanking(store, config, workspaceId, t.id);
    if (ranked.length === 0) continue;
    const snapshot: FlowRankSnapshot = {
      id: newId('frs'),
      workspaceId,
      flowTypeId: t.id,
      ranking: ranked.map((f) => (f.rankScore === undefined ? { flowId: f.flowId, position: f.position } : { flowId: f.flowId, position: f.position, rankScore: f.rankScore })),
      createdAt: new Date().toISOString(),
    };
    if (researchRunId !== undefined) snapshot.researchRunId = researchRunId;
    out.push(snapshots.insert(snapshot));
  }
  return out;
}
