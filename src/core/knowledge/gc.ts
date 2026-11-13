/**
 * Knowledge gc (design §3 decision 12, §14; build plan KS-7). Nothing is ever removed automatically:
 *
 * - `gcReport` is read-only: per node and age, how many stored files no record references and how many
 *   bytes pruning them would reclaim; also what is referenced, too recent, already pruned or missing,
 *   and how many extracted texts come from an older extractor version (KS-1 has no re-extraction yet).
 * - `pruneArtifacts` removes FILES only, for artifacts the caller names, inside the caller's tree, that
 *   no record references and that are at least `retention.pruneMinAgeDays` old (a request may ask for
 *   an older cut, never a younger one). The artifact row, hash, description, extracted text and chunks
 *   stay. It is all or nothing: one refused id refuses the request. The caller logs it (the user
 *   action `pruneArtifactsAsUser` in feedback/actions.ts writes a system decision and one
 *   `artifact_prune` feedback event per artifact, in the same transaction).
 *
 * "Referenced" (refused, with the references listed) — conservative on purpose:
 * - any fact version, whatever its lifecycle or status (`findings.evidence`, `finding_evidence`),
 *   and any fact observation (`fact_observations.evidence`, rejected ones included);
 * - any typed record: competitors, symptoms, symptom hypotheses, unit proposals, review issues
 *   (`evidence`), persona profile fields (`profile.*.evidence`), and relations it asserts;
 * - a capture in a current flow: the artifact is the latest capture of its (node, flow, step);
 * - an upload: kind `upload`, or listed in a profile's `uploads`;
 * - a text extraction still `pending` (its text has not been kept yet).
 * Logs (decisions, feedback, retrieval events, outcomes) are not references.
 *
 * The file of a pruned artifact comes back when the same bytes are captured again
 * (`ArtifactStore.persist` rewrites a missing file).
 */
import { existsSync, renameSync, rmSync, statSync } from 'node:fs';
import type { BifConfig } from '../config/schema.js';
import type { Store } from '../store/db.js';
import type { Artifact } from '../types.js';
import { listFeedback } from '../feedback/events.js';
import { knowledgeSettings } from './config.js';
import { EXTRACTORS } from './extract/index.js';

/** Where artifact files live (an `ArtifactStore`). */
export type ArtifactFiles = { filePath(artifact: Artifact): string };

export type ArtifactReference = { kind: string; id: string };

export type GcItem = {
  artifactId: string;
  workspaceId: string;
  kind: string;
  mime: string;
  title?: string;
  bytes: number;
  /** Latest capture (or the artifact's own capture time). */
  lastCapturedAt: string;
  ageDays: number;
  uploadDerived: boolean;
};

export type GcBucket = { count: number; bytes: number };

export type GcReport = {
  minAgeDays: number;
  /** The nodes the report covers (the request's scope). */
  workspaceIds: string[];
  totals: {
    artifacts: number;
    /** Stored files present. */
    files: GcBucket;
    referenced: GcBucket;
    tooRecent: GcBucket;
    reclaimable: GcBucket;
    /** Files removed by a logged user prune. */
    pruned: number;
    /** Files missing without a prune event (data loss outside BIF). */
    missing: number;
  };
  /** Reclaimable files per node (most bytes first). */
  byNode: Array<{ workspaceId: string } & GcBucket>;
  /** Reclaimable files per age bucket (`90–179 days`, …). */
  byAge: Array<{ bucket: string } & GcBucket>;
  /** Reclaimable artifacts, oldest first (at most `limit`). */
  candidates: GcItem[];
  /** Candidates left out of `candidates` by `limit`. */
  moreCandidates: number;
  /**
   * Extracted texts made by an older extractor version than the current one (KS-1 has no
   * re-extraction yet: these keep their old text until one exists).
   */
  olderExtractorTexts: number;
};

export type PruneRefusal = {
  artifactId: string;
  reason: 'not_found' | 'referenced' | 'upload' | 'too_recent' | 'already_pruned' | 'text_pending';
  references?: ArtifactReference[];
  ageDays?: number;
};

/** A prune request that cannot run as asked (the API answers 400 / 409 with `refused`). */
export class PruneError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 409,
    readonly refused: PruneRefusal[] = [],
  ) {
    super(message);
    this.name = 'PruneError';
  }
}

const DAY = 86_400_000;
const json = (col: string) => `CASE WHEN json_valid(${col}) THEN ${col} ELSE '[]' END`;

/** Every (artifact, referencing record) pair in the store, one SQL pass (see module doc). */
const REFERENCES_SQL = `
  SELECT j.value AS a, 'finding' AS k, f.id AS id FROM findings f, json_each(${json('f.evidence')}) j
  UNION ALL SELECT fe.artifact_id, 'finding', fe.finding_id FROM finding_evidence fe
  UNION ALL SELECT j.value, 'observation', o.id FROM fact_observations o, json_each(${json('o.evidence')}) j
  UNION ALL SELECT j.value, 'competitor', c.id FROM competitors c, json_each(${json('c.evidence')}) j
  UNION ALL SELECT j.value, 'symptom', s.id FROM symptoms s, json_each(${json('s.evidence')}) j
  UNION ALL SELECT j.value, 'hypothesis', h.id FROM symptom_hypotheses h, json_each(${json('h.evidence')}) j
  UNION ALL SELECT j.value, 'unit_proposal', u.id FROM unit_proposals u, json_each(${json('u.evidence')}) j
  UNION ALL SELECT j.value, 'review_issue', r.id FROM review_issues r, json_each(${json('r.evidence')}) j
  UNION ALL SELECT e.value, 'persona', p.id FROM personas p, json_each(CASE WHEN json_valid(p.profile) THEN p.profile ELSE '{}' END) fld,
    json_each(CASE WHEN json_type(fld.value, '$.evidence') = 'array' THEN json_extract(fld.value, '$.evidence') ELSE '[]' END) e
  UNION ALL SELECT r.source_id, 'relation', r.id FROM relations r WHERE r.source_kind = 'artifact'
  UNION ALL SELECT j.value, 'profile_upload', pr.workspace_id FROM profiles pr,
    json_each(CASE WHEN json_type(pr.data, '$.uploads') = 'array' THEN json_extract(pr.data, '$.uploads') ELSE '[]' END) j
  UNION ALL SELECT cap.artifact_id, 'current_flow_capture', cap.id FROM artifact_captures cap
    WHERE cap.flow IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM artifact_captures later WHERE later.workspace_id = cap.workspace_id AND later.flow = cap.flow
        AND later.step IS cap.step AND (later.captured_at > cap.captured_at OR (later.captured_at = cap.captured_at AND later.rowid > cap.rowid)))
  UNION ALL SELECT t.artifact_id, 'text_pending', t.artifact_id FROM artifact_texts t WHERE t.status = 'pending'`;

/** References of every artifact (map: artifact id → references). */
function allReferences(store: Store): Map<string, ArtifactReference[]> {
  const rows = store.db.prepare(REFERENCES_SQL).all() as Array<{ a: unknown; k: string; id: string }>;
  const out = new Map<string, ArtifactReference[]>();
  for (const r of rows) {
    if (typeof r.a !== 'string') continue;
    const list = out.get(r.a) ?? [];
    if (!list.some((x) => x.kind === r.k && x.id === r.id)) list.push({ kind: r.k, id: r.id });
    out.set(r.a, list);
  }
  return out;
}

/** What references one artifact (empty: nothing does). */
export function artifactReferences(store: Store, artifactId: string): ArtifactReference[] {
  return allReferences(store).get(artifactId) ?? [];
}

function lastCaptured(store: Store, a: Artifact): string {
  const row = store.db.prepare('SELECT MAX(captured_at) AS at FROM artifact_captures WHERE artifact_id = ?').get(a.id) as { at: string | null } | undefined;
  return row?.at && row.at > a.capturedAt ? row.at : a.capturedAt;
}

function fileSize(files: ArtifactFiles, a: Artifact): number | undefined {
  try {
    return statSync(files.filePath(a)).size;
  } catch {
    return undefined;
  }
}

function pruneLogged(store: Store, artifactId: string): boolean {
  return listFeedback(store, { kind: 'artifact_prune', targetType: 'artifact', targetId: artifactId }).length > 0;
}

/** The effective minimum age: the configured `pruneMinAgeDays`, or an older cut asked for. */
export function pruneMinAge(config: Pick<BifConfig, 'knowledge'>, requested?: number): number {
  const floor = knowledgeSettings(config).retention.pruneMinAgeDays;
  if (requested === undefined) return floor;
  if (!Number.isFinite(requested) || requested < floor) throw new PruneError(`minAgeDays must be at least ${floor} (knowledge.retention.pruneMinAgeDays)`, 400);
  return Math.floor(requested);
}

const AGE_BUCKETS: Array<{ from: number; to: number }> = [
  { from: 0, to: 180 },
  { from: 180, to: 365 },
  { from: 365, to: 730 },
  { from: 730, to: Number.POSITIVE_INFINITY },
];

function ageBucket(age: number, minAge: number): string {
  const b = AGE_BUCKETS.find((x) => age < x.to)!;
  const from = Math.max(b.from, minAge);
  return b.to === Number.POSITIVE_INFINITY ? `${from}+ days` : `${from}–${b.to - 1} days`;
}

/** Count of extracted texts of `workspaceIds` whose extractor version is older than the current one. */
export function olderExtractorTexts(store: Store, workspaceIds: readonly string[]): number {
  const current = new Map<string, number>();
  for (const v of Object.values(EXTRACTORS)) {
    const [name, n] = v.split('@');
    current.set(name!, Math.max(current.get(name!) ?? 0, Number(n)));
  }
  const rows = store.db
    .prepare(`SELECT extractor AS x, COUNT(*) AS n FROM artifact_texts WHERE extractor IS NOT NULL AND workspace_id IN (SELECT value FROM json_each(?)) GROUP BY extractor`)
    .all(JSON.stringify(workspaceIds)) as Array<{ x: string; n: number }>;
  let older = 0;
  for (const r of rows) {
    const [name, n] = r.x.split('@');
    const cur = current.get(name ?? '');
    if (cur !== undefined && Number(n) < cur) older += Number(r.n);
  }
  return older;
}

export type GcOptions = { workspaceIds: readonly string[]; minAgeDays?: number; now?: Date; limit?: number };

/** The gc report over the artifacts homed in `workspaceIds` (see module doc). Read-only. */
export function gcReport(store: Store, files: ArtifactFiles, config: Pick<BifConfig, 'knowledge'>, opts: GcOptions): GcReport {
  const minAge = pruneMinAge(config, opts.minAgeDays);
  const now = (opts.now ?? new Date()).getTime();
  const refs = allReferences(store);
  const zero = (): GcBucket => ({ count: 0, bytes: 0 });
  const totals: GcReport['totals'] = {
    artifacts: 0, files: zero(), referenced: zero(), tooRecent: zero(), reclaimable: zero(), pruned: 0, missing: 0,
  };
  const byNode = new Map<string, GcBucket>();
  const byAge = new Map<string, GcBucket>();
  const candidates: GcItem[] = [];
  const add = (b: GcBucket, bytes: number) => {
    b.count++;
    b.bytes += bytes;
  };
  const rows = store.db
    .prepare(`SELECT id FROM artifacts WHERE workspace_id IN (SELECT value FROM json_each(?)) ORDER BY rowid`)
    .all(JSON.stringify(opts.workspaceIds)) as Array<{ id: string }>;
  for (const { id } of rows) {
    const a = store.artifacts.get(id)!;
    totals.artifacts++;
    const bytes = fileSize(files, a);
    if (bytes === undefined) {
      if (pruneLogged(store, a.id)) totals.pruned++;
      else totals.missing++;
      continue;
    }
    add(totals.files, bytes);
    if (a.kind === 'upload' || refs.has(a.id)) {
      add(totals.referenced, bytes);
      continue;
    }
    const last = lastCaptured(store, a);
    const age = Math.max(0, Math.floor((now - Date.parse(last)) / DAY));
    if (age < minAge) {
      add(totals.tooRecent, bytes);
      continue;
    }
    add(totals.reclaimable, bytes);
    const node = byNode.get(a.workspaceId) ?? zero();
    add(node, bytes);
    byNode.set(a.workspaceId, node);
    const key = ageBucket(age, minAge);
    const bucket = byAge.get(key) ?? zero();
    add(bucket, bytes);
    byAge.set(key, bucket);
    candidates.push({
      artifactId: a.id, workspaceId: a.workspaceId, kind: a.kind, mime: a.mime, bytes, lastCapturedAt: last, ageDays: age,
      uploadDerived: a.uploadDerived === true, ...(a.title ? { title: a.title } : {}),
    });
  }
  candidates.sort((x, y) => x.lastCapturedAt.localeCompare(y.lastCapturedAt) || x.artifactId.localeCompare(y.artifactId));
  const limit = Math.max(1, opts.limit ?? 200);
  return {
    minAgeDays: minAge,
    workspaceIds: [...opts.workspaceIds],
    totals,
    byNode: [...byNode].map(([workspaceId, b]) => ({ workspaceId, ...b })).sort((x, y) => y.bytes - x.bytes || x.workspaceId.localeCompare(y.workspaceId)),
    byAge: [...byAge].map(([bucket, b]) => ({ bucket, ...b })),
    candidates: candidates.slice(0, limit),
    moreCandidates: Math.max(0, candidates.length - limit),
    olderExtractorTexts: olderExtractorTexts(store, opts.workspaceIds),
  };
}

/** Why each named artifact may or may not be pruned now (no side effects). */
export function pruneCheck(
  store: Store,
  files: ArtifactFiles,
  config: Pick<BifConfig, 'knowledge'>,
  artifactIds: readonly string[],
  opts: { treeIds: readonly string[]; minAgeDays?: number; now?: Date },
): { eligible: GcItem[]; refused: PruneRefusal[] } {
  const minAge = pruneMinAge(config, opts.minAgeDays);
  const now = (opts.now ?? new Date()).getTime();
  const refs = allReferences(store);
  const eligible: GcItem[] = [];
  const refused: PruneRefusal[] = [];
  for (const id of [...new Set(artifactIds)]) {
    const a = store.artifacts.get(id);
    // Unknown and other-tree ids: the same answer (design §12).
    if (!a || !opts.treeIds.includes(a.workspaceId)) {
      refused.push({ artifactId: id, reason: 'not_found' });
      continue;
    }
    const bytes = fileSize(files, a);
    if (bytes === undefined) {
      refused.push({ artifactId: id, reason: 'already_pruned' });
      continue;
    }
    if (a.kind === 'upload') {
      refused.push({ artifactId: id, reason: 'upload' });
      continue;
    }
    const r = refs.get(a.id);
    if (r?.length) {
      const pending = r.some((x) => x.kind === 'text_pending');
      const others = r.filter((x) => x.kind !== 'text_pending');
      if (others.some((x) => x.kind === 'profile_upload')) refused.push({ artifactId: id, reason: 'upload', references: others });
      else if (others.length) refused.push({ artifactId: id, reason: 'referenced', references: others });
      else if (pending) refused.push({ artifactId: id, reason: 'text_pending' });
      continue;
    }
    const last = lastCaptured(store, a);
    const age = Math.max(0, Math.floor((now - Date.parse(last)) / DAY));
    if (age < minAge) {
      refused.push({ artifactId: id, reason: 'too_recent', ageDays: age });
      continue;
    }
    eligible.push({
      artifactId: a.id, workspaceId: a.workspaceId, kind: a.kind, mime: a.mime, bytes, lastCapturedAt: last, ageDays: age,
      uploadDerived: a.uploadDerived === true, ...(a.title ? { title: a.title } : {}),
    });
  }
  return { eligible, refused };
}

export type PruneResult = { pruned: GcItem[]; bytes: number; minAgeDays: number };

/**
 * Removes the files of `artifactIds` (see module doc), all or nothing. Inside one transaction it
 * re-checks every id, calls `log(eligible)` (the caller's decision / feedback rows) and moves the files
 * aside; if anything throws, the transaction rolls back and the files are moved back. After the commit
 * the moved files are deleted. Throws `PruneError` (400 bad age / empty request, 409 refused).
 */
export function pruneArtifacts(
  store: Store,
  files: ArtifactFiles,
  config: Pick<BifConfig, 'knowledge'>,
  artifactIds: readonly string[],
  opts: { treeIds: readonly string[]; minAgeDays?: number; now?: Date },
  log: (eligible: GcItem[], minAgeDays: number) => void,
): PruneResult {
  if (!artifactIds.length) throw new PruneError('name at least one artifact to prune', 400);
  const minAge = pruneMinAge(config, opts.minAgeDays);
  const moved: Array<{ from: string; to: string }> = [];
  let pruned: GcItem[];
  try {
    pruned = store.transaction(() => {
      const { eligible, refused } = pruneCheck(store, files, config, artifactIds, { ...opts, minAgeDays: minAge });
      if (refused.length) {
        // An id outside the tree reads exactly like an unknown one; nothing is pruned.
        throw new PruneError(`${refused.length} artifact(s) cannot be pruned; nothing was pruned`, 409, refused);
      }
      log(eligible, minAge);
      for (const item of eligible) {
        const from = files.filePath(store.artifacts.get(item.artifactId)!);
        const to = `${from}.${process.pid}.${Date.now()}.pruning`;
        renameSync(from, to);
        moved.push({ from, to });
      }
      return eligible;
    });
  } catch (e) {
    for (const m of moved.reverse()) if (existsSync(m.to) && !existsSync(m.from)) renameSync(m.to, m.from);
    throw e;
  }
  for (const m of moved) rmSync(m.to, { force: true });
  return { pruned, bytes: pruned.reduce((n, x) => n + x.bytes, 0), minAgeDays: minAge };
}
