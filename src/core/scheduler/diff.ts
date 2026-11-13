import type { Store } from '../store/db.js';
import type { Artifact, Finding } from '../types.js';

/** `subject`: the competitor / company the flow belongs to (finding subject, or the screenshot's source host). */
export type ChangedArtifact = { subject: string; flow: string; step: number; prev: string; next: string };

export type RunDiff = {
  /** Finding ids of the next run whose (subject, claim) did not appear in the previous run. */
  newFindings: string[];
  /** Subjects that had findings in the previous run and none in the next. */
  removedSubjects: string[];
  /** Screenshots whose bytes (sha256) differ for the same flow + step. */
  changedArtifacts: ChangedArtifact[];
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
  // Superseded findings (replaced in a later review round of their task) are not results of the run.
  const live = (f: Finding) => f.status !== 'superseded';
  const prev = store.findings.list({ runId: prevRunId }).filter(live);
  const next = store.findings.list({ runId: nextRunId }).filter(live);

  const prevKeys = new Set(prev.map(findingKey));
  const newFindings = next.filter((f) => !prevKeys.has(findingKey(f))).map((f) => f.id);

  const nextSubjects = new Set(next.map((f) => norm(f.subject)));
  const removedSubjects = [...new Set(prev.filter((f) => !nextSubjects.has(norm(f.subject))).map((f) => f.subject))];

  const before = screenshots(store, prev);
  const after = screenshots(store, next);
  const changedArtifacts: ChangedArtifact[] = [];
  for (const [key, n] of after) {
    const p = before.get(key);
    if (p && p.artifact.sha256 !== n.artifact.sha256) {
      changedArtifacts.push({ subject: n.subject, flow: n.flow, step: n.step, prev: p.artifact.id, next: n.artifact.id });
    }
  }
  changedArtifacts.sort((a, b) => a.subject.localeCompare(b.subject) || a.flow.localeCompare(b.flow) || a.step - b.step);
  return { newFindings, removedSubjects, changedArtifacts };
}

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
  const nextKeys = new Set(next.map(findingKey));
  const nextSubjects = new Set(next.map((f) => norm(f.subject)));
  return prev.filter((f) => nextSubjects.has(norm(f.subject)) && !nextKeys.has(findingKey(f))).map((f) => f.id);
}
