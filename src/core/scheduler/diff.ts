import type { Store } from '../store/db.js';
import type { Artifact, Finding } from '../types.js';
import { knowledgeRepos } from '../store/repos.js'; // KS-5
import { flowRepos } from '../flows/repos.js'; // flow records
import type { FlowRankSnapshot } from '../flows/types.js';

/** `subject`: the competitor / company the flow belongs to (finding subject, or the screenshot's source host). */
export type ChangedArtifact = { subject: string; flow: string; step: number; prev: string; next: string };

export type RunDiff = {
  /**
   * Finding ids of the next run whose (subject, claim) did not appear in the previous run. KS-5: only
   * facts saved as new (replacement versions are under `replaced`); text matching is the fallback that
   * catches a fact saved as `new` although the previous run had it.
   */
  newFindings: string[];
  /** Subjects that had findings in the previous run and none in the next (confirmed / replaced / retracted facts count as covered). */
  removedSubjects: string[];
  /** Screenshots whose bytes (sha256) differ for the same flow + step. */
  changedArtifacts: ChangedArtifact[];
  /** KS-5: facts the next run replaced (applied observations): old version → new version. */
  replaced: Array<{ from: string; to: string }>;
  /** KS-5: facts the next run retracted (applied). */
  retracted: string[];
  /** KS-5: applied confirmations of the next run. */
  confirmed: number;
  /** Flow records (flow design §8.3): new flows, new versions, confirmations and ranking moves of the next run. */
  flows: FlowChanges;
};

/**
 * What the next run changed in the flow records (flow design §8.3):
 * - `newFlows`: first versions it saved (current, not superseded);
 * - `newVersions`: versions it saved that replaced a version and became current (a candidate that was
 *   never promoted is not one): old → new;
 * - `confirmed`: flows of earlier runs it confirmed unchanged (distinct flows, from its `save_flow` records);
 * - `rankMoves`: per flow type, the flows whose position differs between the latest rank snapshot taken
 *   for the previous run and the latest taken for the next run, matched by lineage (a new version keeps
 *   its lineage's place); positions only, a score is optional. No snapshot for either run: none.
 */
export type FlowChanges = {
  newFlows: string[];
  newVersions: Array<{ from: string; to: string }>;
  confirmed: number;
  rankMoves: Array<{ flowTypeId: string; flowId: string; from: number; to: number }>;
};

/** Lowercase, punctuation removed, whitespace collapsed. */
const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}$€£%.\s]/gu, ' ')
    .replace(/\.(?!\d)/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const findingKey = (f: Finding) => `${norm(f.subject)}|${norm(f.claim)}`;

/** Lowercased host of a URL without `www.`, or '' when unparsable. */
function hostOf(url: string | undefined): string {
  if (!url) return '';
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
}

type Shot = { subject: string; flow: string; step: number; artifact: Artifact };

/**
 * Screenshots cited by a run's findings, keyed by subject + `flow#step` — the subject is the
 * finding's normalized subject (or, when empty, the screenshot's source host), so two
 * competitors' `signup#1` never collide. The step is `Artifact.step` when set, otherwise the
 * screenshot's position within its flow in evidence order (1-based). The first occurrence of a
 * key wins.
 */
function screenshots(store: Store, findings: Finding[]): Map<string, Shot> {
  const out = new Map<string, Shot>();
  for (const f of findings) {
    const positions = new Map<string, number>();
    for (const id of f.evidence) {
      const a = store.artifacts.get(id);
      if (!a || a.kind !== 'screenshot' || !a.flow) continue;
      const pos = (positions.get(a.flow) ?? 0) + 1;
      positions.set(a.flow, pos);
      const step = a.step ?? pos;
      const subjectKey = norm(f.subject) || hostOf(a.sourceUrl);
      const key = `${subjectKey}|${a.flow}#${step}`;
      if (!out.has(key)) out.set(key, { subject: f.subject.trim() || subjectKey, flow: a.flow, step, artifact: a });
    }
  }
  return out;
}

/**
 * Compares two research runs (usually the previous and the latest run of the same phase/job).
 * Findings are matched by normalized subject + claim, so a changed price ("$10/mo" → "$12/mo")
 * surfaces as a new finding. Screenshots are compared by sha256 per subject + flow + step.
 */
export function diffRuns(prevRunId: string, nextRunId: string, deps: { store: Store }): RunDiff {
  const { store } = deps;
  // Superseded findings (replaced in a later review round of their task) are not results of the run,
  // nor are rejected replacement candidates (KS-2: an unverified update never becomes current).
  const live = (f: Finding) => f.status !== 'superseded' && (f.lifecycle ?? 'current') !== 'candidate';
  const prev = store.findings.list({ runId: prevRunId }).filter(live);
  const next = store.findings.list({ runId: nextRunId }).filter(live);
  // --- KS-5: fact lineage (applied observations of each run) ---
  const prevLineage = runLineage(store, prevRunId);
  const nextLineage = runLineage(store, nextRunId);

  const prevKeys = new Set([...prev, ...prevLineage.confirmedFacts].map(findingKey));
  // Replacement versions are reported under `replaced`; text matching only for facts saved as new.
  const newFindings = next.filter((f) => !f.replacesId && !prevKeys.has(findingKey(f))).map((f) => f.id);

  const nextSubjects = new Set([...next, ...nextLineage.observedFacts].map((f) => norm(f.subject)));
  const removedSubjects = [...new Set([...prev, ...prevLineage.confirmedFacts].filter((f) => !nextSubjects.has(norm(f.subject))).map((f) => f.subject))];

  // Confirmations save no finding row: the screenshots they cite count under the confirmed fact's subject.
  const before = screenshots(store, [...prev, ...prevLineage.confirmEvidence]);
  const after = screenshots(store, [...next, ...nextLineage.confirmEvidence]);
  const changedArtifacts: ChangedArtifact[] = [];
  for (const [key, n] of after) {
    const p = before.get(key);
    if (p && p.artifact.sha256 !== n.artifact.sha256) {
      changedArtifacts.push({ subject: n.subject, flow: n.flow, step: n.step, prev: p.artifact.id, next: n.artifact.id });
    }
  }
  changedArtifacts.sort((a, b) => a.subject.localeCompare(b.subject) || a.flow.localeCompare(b.flow) || a.step - b.step);
  return {
    newFindings, removedSubjects, changedArtifacts, replaced: nextLineage.replaced, retracted: nextLineage.retracted, confirmed: nextLineage.confirmed,
    flows: flowChanges(store, prevRunId, nextRunId),
  };
}

// --- flow records: "what changed" (flow design §8.3) ----------------------------------------------

/** `FlowChanges` of the next run against the previous one (see the type). */
export function flowChanges(store: Store, prevRunId: string, nextRunId: string): FlowChanges {
  const r = flowRepos(store);
  const saved = r.flows.list({ runId: nextRunId }).filter((f) => f.status !== 'superseded' && f.lifecycle !== 'candidate');
  const newFlows = saved.filter((f) => !f.replacesId).map((f) => f.id);
  const newVersions = saved.filter((f) => f.replacesId).map((f) => ({ from: f.replacesId!, to: f.id }));

  // Confirmations: the next run's `save_flow` records that confirmed a flow saved before it.
  const confirmedIds = new Set<string>();
  for (const task of store.tasks.list({ runId: nextRunId })) {
    for (const run of store.agentRuns.list({ taskId: task.id })) {
      for (const d of store.decisions.list({ agentRunId: run.id, kind: 'decision' })) {
        const p = d.payload as { tool?: unknown; flowId?: unknown; result?: { relation?: unknown } } | null;
        if (p?.tool !== 'save_flow' || p.result?.relation !== 'confirmed' || typeof p.flowId !== 'string') continue;
        const f = r.flows.get(p.flowId);
        if (f && f.status !== 'superseded' && f.runId !== nextRunId) confirmedIds.add(f.id);
      }
    }
  }

  // Ranking moves: latest snapshot per flow type of each run, flows matched by lineage.
  const latest = (runId: string): Map<string, FlowRankSnapshot> => {
    const out = new Map<string, FlowRankSnapshot>();
    for (const s of r.rankSnapshots.list({ researchRunId: runId })) {
      const have = out.get(s.flowTypeId);
      if (!have || s.createdAt >= have.createdAt) out.set(s.flowTypeId, s);
    }
    return out;
  };
  const lineageOf = (flowId: string) => r.flows.get(flowId)?.lineageId ?? flowId;
  const before = latest(prevRunId);
  const rankMoves: FlowChanges['rankMoves'] = [];
  for (const [flowTypeId, next] of latest(nextRunId)) {
    const prev = before.get(flowTypeId);
    if (!prev) continue;
    const was = new Map(prev.ranking.map((x) => [lineageOf(x.flowId), x.position]));
    for (const x of next.ranking) {
      const from = was.get(lineageOf(x.flowId));
      if (from !== undefined && from !== x.position) rankMoves.push({ flowTypeId, flowId: x.flowId, from, to: x.position });
    }
  }
  return { newFlows, newVersions, confirmed: confirmedIds.size, rankMoves };
}

// --- knowledge store KS-5: "what changed" from fact lineage (design §11) ---------------------------

type RunLineage = {
  replaced: Array<{ from: string; to: string }>;
  retracted: string[];
  confirmed: number;
  /** Facts the run confirmed (current version at the time of the run). */
  confirmedFacts: Finding[];
  /** Every fact the run confirmed, replaced or retracted (the prior version for a replace). */
  observedFacts: Finding[];
  /** Lineage ids the run observed. */
  lineages: Set<string>;
  /** Confirmations as pseudo findings (subject of the fact, evidence of the observation) for the screenshot diff. */
  confirmEvidence: Finding[];
};

/** Applied observations of a research run (reviewed changes only), oldest first. */
function runLineage(store: Store, runId: string): RunLineage {
  const out: RunLineage = { replaced: [], retracted: [], confirmed: 0, confirmedFacts: [], observedFacts: [], lineages: new Set(), confirmEvidence: [] };
  const rows = store.db
    .prepare(`SELECT id FROM fact_observations WHERE run_id = ? AND status = 'applied' AND kind IN ('confirm', 'replace', 'retract') ORDER BY applied_at, rowid`)
    .all(runId) as Array<{ id: string }>;
  const repo = knowledgeRepos(store).factObservations;
  for (const { id } of rows) {
    const o = repo.get(id)!;
    out.lineages.add(o.lineageId);
    const fact = store.findings.get(o.kind === 'replace' && o.priorFindingId ? o.priorFindingId : o.findingId);
    if (fact) out.observedFacts.push(fact);
    if (o.kind === 'confirm') {
      out.confirmed++;
      if (fact) {
        out.confirmedFacts.push(fact);
        out.confirmEvidence.push({ ...fact, evidence: o.evidence });
      }
    } else if (o.kind === 'replace') {
      out.replaced.push({ from: o.priorFindingId ?? '?', to: o.findingId });
    } else {
      out.retracted.push(o.findingId);
    }
  }
  return out;
}

// --- end KS-5 -------------------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// learning loop WP-C: findings a later run contradicts — THE text fallback (design §11), shared by the
// scheduled "what changed" outcomes (`learning/whatChangedOutcomes.ts`); KS-5 × KS-6 integration.

/** Facts of a run: findings it saved (not superseded) and the facts it observed (applied), in its workspace. */
export function factsOfRun(store: Store, run: { id: string; workspaceId: string }): Finding[] {
  const out = new Map<string, Finding>();
  for (const f of store.findings.list({ runId: run.id })) {
    if (f.workspaceId === run.workspaceId && f.status !== 'superseded') out.set(f.id, f);
  }
  const observed = store.db
    .prepare(`SELECT DISTINCT finding_id AS id FROM fact_observations WHERE run_id = ? AND status = 'applied' AND workspace_id = ?`)
    .all(run.id, run.workspaceId) as Array<{ id: string }>;
  for (const { id } of observed) {
    const f = store.findings.get(id);
    if (f && !out.has(f.id)) out.set(f.id, f);
  }
  return [...out.values()];
}

/** A fact saved as a new lineage (not a replacement of an earlier version). */
const savedAsNew = (f: Finding) => !f.replacesId && (f.version ?? 1) === 1;

/**
 * Ids of the previous run's current facts (saved or observed by it) that the next run contradicts by
 * text — e.g. "Acme Pro costs $10/mo" when the next run saved a NEW fact "$12/mo" instead of a
 * replacement. Text matching is only the fallback for facts saved as `new` (design §11):
 * - a fact whose lineage the next run confirmed, replaced or retracted is never contradicted by text
 *   (its lineage outcomes say what happened), nor is a version that is no longer current;
 * - the next run must have saved a NEW fact (not a replacement version, not a candidate) on the same
 *   normalized subject, and no fact it saved or confirmed may carry the same subject and claim.
 */
export function contradictedFindings(prevRunId: string, nextRunId: string, deps: { store: Store }): string[] {
  const { store } = deps;
  const prevRun = store.researchRuns.get(prevRunId);
  const nextRun = store.researchRuns.get(nextRunId);
  if (!prevRun || !nextRun) return [];
  const live = (f: Finding) => f.status !== 'superseded' && (f.lifecycle ?? 'current') !== 'candidate';
  const next = store.findings.list({ runId: nextRunId }).filter(live);
  const lineage = runLineage(store, nextRunId);
  const nextKeys = new Set([...next, ...lineage.confirmedFacts].map(findingKey));
  const newSubjects = new Set(next.filter(savedAsNew).map((f) => norm(f.subject)));
  return factsOfRun(store, prevRun)
    .filter((f) => (f.lifecycle ?? 'current') === 'current' && !lineage.lineages.has(f.lineageId ?? f.id))
    .filter((f) => newSubjects.has(norm(f.subject)) && !nextKeys.has(findingKey(f)))
    .map((f) => f.id);
}
