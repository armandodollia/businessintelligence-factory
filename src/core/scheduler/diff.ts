import type { Store } from '../store/db.js';
import type { Artifact, Finding } from '../types.js';
import { knowledgeRepos } from '../store/repos.js'; // KS-5

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
  return { newFindings, removedSubjects, changedArtifacts, replaced: nextLineage.replaced, retracted: nextLineage.retracted, confirmed: nextLineage.confirmed };
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

/** Lineage ids a research run confirmed, replaced or retracted (applied). */
export function observedLineages(store: Store, runId: string): Set<string> {
  return runLineage(store, runId).lineages;
}
// --- end KS-5 -------------------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// learning loop WP-C: findings a later run contradicts

/**
 * Ids of the previous run's findings whose subject the next run re-researched (it has findings with
 * the same normalized subject) but whose claim it no longer found — e.g. "Acme Pro costs $10/mo"
 * when the next run only says "$12/mo". Subjects the next run did not cover are not contradicted.
 */
export function contradictedFindings(prevRunId: string, nextRunId: string, deps: { store: Store }): string[] {
  const live = (f: Finding) => f.status !== 'superseded';
  const prev = deps.store.findings.list({ runId: prevRunId }).filter(live);
  const next = deps.store.findings.list({ runId: nextRunId }).filter(live);
  // KS-5: a fact whose lineage the next run confirmed, replaced or retracted is not "contradicted" by
  // text (a confirmation saves no row; KS-2 records the lineage outcomes), nor is a version that is no
  // longer current. Only facts the next run did not address fall back to text matching.
  const lineage = runLineage(deps.store, nextRunId);
  const nextKeys = new Set([...next, ...lineage.confirmedFacts].map(findingKey));
  const nextSubjects = new Set([...next, ...lineage.observedFacts].map((f) => norm(f.subject)));
  return prev
    .filter((f) => (f.lifecycle ?? 'current') === 'current' && !lineage.lineages.has(f.lineageId ?? f.id))
    .filter((f) => nextSubjects.has(norm(f.subject)) && !nextKeys.has(findingKey(f)))
    .map((f) => f.id);
}
