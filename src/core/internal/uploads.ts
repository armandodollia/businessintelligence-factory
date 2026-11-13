import type { BifConfig } from '../config/schema.js';
import type { ArtifactStore } from '../evidence/artifacts.js';
import type { Store } from '../store/db.js';
import type { Artifact } from '../types.js';
// Knowledge store KS-1: uploads are extracted and indexed through the same pipeline as agent saves.
import { ingestorFor } from '../knowledge/ingest.js';

export type UploadFile = { name: string; bytes: Uint8Array; mime: string };

/** Artifact ids of internal uploads linked in the profile (`profile.data.uploads`). */
function uploadIds(store: Store, workspaceId: string): string[] {
  const u = store.profiles.get(workspaceId)?.data.uploads;
  return Array.isArray(u) ? u.filter((x): x is string => typeof x === 'string') : [];
}

/**
 * Stores an internal upload (KPI export, deck, PDF...) as an Artifact of kind `upload` and links
 * it into the workspace profile's `uploads[]` (artifact ids, deduped). Throws
 * `ArtifactTooLargeError` above 50 MB. Identical bytes return the existing artifact. Every upload
 * records a capture row (KS-1) and is submitted to the extraction pipeline (`ingestorFor`): small
 * files are extracted right away, larger ones queued; `ingestorFor(deps).idle()` awaits both.
 */
export function uploadInternal(
  workspaceId: string,
  file: UploadFile,
  deps: { store: Store; artifacts: ArtifactStore; config?: Pick<BifConfig, 'knowledge'> },
): Artifact {
  const { store, artifacts } = deps;
  if (!store.workspaces.get(workspaceId)) throw new Error(`workspace '${workspaceId}' not found`);
  const artifact = artifacts.save({ workspaceId, kind: 'upload', mime: file.mime || 'application/octet-stream', title: file.name, bytes: file.bytes });
  store.transaction(() => {
    const profile = store.profiles.get(workspaceId);
    const ids = uploadIds(store, workspaceId);
    if (ids.includes(artifact.id)) return;
    const data = { ...(profile?.data ?? {}), uploads: [...ids, artifact.id] };
    if (profile) store.profiles.update(workspaceId, { data });
    else store.profiles.insert({ workspaceId, data });
  });
  // KS-1: never throws (failures are recorded on the artifact's text row).
  void ingestorFor(deps).submit(artifact.id);
  return artifact;
}

/**
 * Uploads as `{id, title}` only — what agent contexts (orchestrator, interviewer) receive. Agents
 * read contents on demand with `read_artifact` when relevant to a task.
 */
export function listUploads(workspaceId: string, deps: { store: Store }): Array<{ id: string; title: string }> {
  // Profile-linked ids first (covers sha-deduped uploads), then any other `upload` artifact.
  const ids = new Set(uploadIds(deps.store, workspaceId));
  for (const a of deps.store.artifacts.list({ workspaceId, kind: 'upload' })) ids.add(a.id);
  return [...ids].flatMap((id) => {
    const a = deps.store.artifacts.get(id);
    return a && a.workspaceId === workspaceId ? [{ id, title: a.title ?? id }] : [];
  });
}
