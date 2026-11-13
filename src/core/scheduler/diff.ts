import type { Store } from '../store/db.js';
import type { Artifact, Finding } from '../types.js';

export type ChangedArtifact = { flow: string; step: number; prev: string; next: string };

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

/**
 * Screenshots cited by a run's findings, keyed by `flow#step`. The step is `Artifact.step` when set,
 * otherwise the screenshot's position within its flow in evidence order (1-based). The first
 * occurrence of a key wins.
 */
function screenshots(store: Store, findings: Finding[]): Map<string, { flow: string; step: number; artifact: Artifact }> {
  const out = new Map<string, { flow: string; step: number; artifact: Artifact }>();
  for (const f of findings) {
    const positions = new Map<string, number>();
    for (const id of f.evidence) {
      const a = store.artifacts.get(id);
      if (!a || a.kind !== 'screenshot' || !a.flow) continue;
      const pos = (positions.get(a.flow) ?? 0) + 1;
      positions.set(a.flow, pos);
      const step = a.step ?? pos;
      const key = `${a.flow}#${step}`;
      if (!out.has(key)) out.set(key, { flow: a.flow, step, artifact: a });
    }
  }
  return out;
}

/**
 * Compares two research runs (usually the previous and the latest run of the same phase/job).
 * Findings are matched by normalized subject + claim, so a changed price ("$10/mo" → "$12/mo")
 * surfaces as a new finding. Screenshots are compared by sha256 per flow + step.
 */
export function diffRuns(prevRunId: string, nextRunId: string, deps: { store: Store }): RunDiff {
  const { store } = deps;
  const prev = store.findings.list({ runId: prevRunId });
  const next = store.findings.list({ runId: nextRunId });

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
      changedArtifacts.push({ flow: n.flow, step: n.step, prev: p.artifact.id, next: n.artifact.id });
    }
  }
  changedArtifacts.sort((a, b) => a.flow.localeCompare(b.flow) || a.step - b.step);
  return { newFindings, removedSubjects, changedArtifacts };
}
