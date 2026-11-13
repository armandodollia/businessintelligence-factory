import { statSync } from 'node:fs';
import { join } from 'node:path';
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

// --- knowledge store KS-5 (design-thread ruling on §12): uploads in prompts are metadata only --------
/**
 * The uploads lines of an agent prompt: artifact id, file type, size and upload date — never the title
 * (a file name is text derived from the upload). This metadata is not derived text, so listing it is
 * not a logged read and does not make a run upload-exposed; opening a file (`expand` / `read_artifact`)
 * is. Every prompt that lists uploads uses this (orchestrator, interviewer).
 */
export function uploadPromptLines(workspaceId: string, deps: { store: Store; dataDir?: string }): string[] {
  const ids = new Set(uploadIds(deps.store, workspaceId));
  for (const a of deps.store.artifacts.list({ workspaceId, kind: 'upload' })) ids.add(a.id);
  const lines = [...ids].flatMap((id) => {
    const a = deps.store.artifacts.get(id);
    if (!a || a.workspaceId !== workspaceId) return [];
    const size = fileSize(deps.dataDir, a.path);
    return [`- ${a.id} (${fileType(a.mime)}, ${size === undefined ? 'size unknown' : formatSize(size)}, uploaded ${a.capturedAt.slice(0, 10)})`];
  });
  return lines.length ? [...lines, UPLOADS_HINT] : ['- (none)'];
}

/** The line after the uploads list. */
export const UPLOADS_HINT = 'Use `expand` or `read_artifact` with an upload id to see a file\'s contents.';

function fileSize(dataDir: string | undefined, path: string): number | undefined {
  if (!dataDir) return undefined;
  try {
    return statSync(join(dataDir, path)).size;
  } catch {
    return undefined;
  }
}

/** A coarse file type from the mime type (not from the file name). */
export function fileType(mime: string): string {
  const m = mime.toLowerCase();
  if (m === 'text/csv' || m.includes('spreadsheet') || m.includes('ms-excel')) return 'spreadsheet';
  if (m === 'application/pdf') return 'PDF';
  if (m.includes('presentation') || m.includes('powerpoint')) return 'presentation';
  if (m.includes('wordprocessing') || m === 'application/msword') return 'document';
  if (m === 'application/json') return 'JSON';
  if (m.startsWith('image/')) return 'image';
  if (m.startsWith('text/')) return 'text';
  return 'file';
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
// --- end KS-5 ---------------------------------------------------------------------------------------
