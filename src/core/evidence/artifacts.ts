import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, extname, join } from 'node:path';
import type { Store } from '../store/db.js';
import { newId } from '../store/repos.js';
import type { Artifact } from '../types.js';
import { sameTree } from '../workspace/tree.js';
// Knowledge store KS-1: captures, captions and url keys (design §8.1).
import { urlKey } from '../knowledge/extract/urlKey.js';
import { redactServed, stripFences } from '../knowledge/trust.js';
import { knowledgeRepos } from '../store/repos.js';

export const MAX_ARTIFACT_BYTES = 50 * 1024 * 1024;

export class ArtifactTooLargeError extends Error {
  constructor(readonly size: number) {
    super(
      `artifact is ${(size / 1024 / 1024).toFixed(1)} MB (${size} bytes); the limit is 50 MB (${MAX_ARTIFACT_BYTES} bytes)`,
    );
    this.name = 'ArtifactTooLargeError';
  }
}

export class ArtifactNotFoundError extends Error {
  constructor(readonly id: string) {
    super(`artifact '${id}' not found`);
    this.name = 'ArtifactNotFoundError';
  }
}

export interface ArtifactMeta {
  workspaceId: string;
  kind: Artifact['kind'];
  mime: string;
  sourceUrl?: string;
  title?: string;
  flow?: string;
  step?: number;
  note?: string;
  // Knowledge store KS-1 (design §8.1): recorded on the capture row of this save.
  /** Caption; set on the artifact at first save, fills an empty one later, never overwrites. */
  description?: string;
  agentRunId?: string;
  taskId?: string;
  /** Research run. */
  runId?: string;
  entityId?: string;
}

/** Result of one save (KS-1): the artifact, the capture row written, and whether the bytes were new. */
export type CaptureResult = { artifact: Artifact; captureId: string; created: boolean };

export type SaveArtifactInput = ArtifactMeta & { bytes: Uint8Array | string };
export type SaveArtifactFromPathInput = ArtifactMeta & { filePath: string };

const MIME_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/svg+xml': 'svg',
  'text/html': 'html',
  'text/plain': 'txt',
  'text/markdown': 'md',
  'text/csv': 'csv',
  'application/json': 'json',
  'application/pdf': 'pdf',
  'application/zip': 'zip',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
  'message/rfc822': 'eml',
  'multipart/related': 'mhtml',
};

const SAFE_SEGMENT = /^[A-Za-z0-9_-]+$/;

function extFor(mime: string, filePath?: string): string {
  const base = mime.split(';')[0]!.trim().toLowerCase();
  const known = MIME_EXT[base];
  if (known) return known;
  const fromPath = filePath ? extname(filePath).slice(1).toLowerCase() : '';
  return /^[a-z0-9]{1,10}$/.test(fromPath) ? fromPath : 'bin';
}

/**
 * Content-addressed evidence store. Files live at
 * `<dataDir>/<workspaceId>/artifacts/<sha256[0:2]>/<sha256>.<ext>`; `Artifact.path` is stored
 * relative to `dataDir`. Identical bytes within a workspace dedupe to the same artifact.
 */
export class ArtifactStore {
  constructor(
    private readonly store: Store,
    /** Root of the data directory (artifact paths are relative to it). */
    readonly dataDir: string,
  ) {}

  /**
   * Stores bytes and registers an `Artifact`. Dedupes per workspace on sha256: if identical bytes
   * were already saved, the FIRST save's artifact (and its metadata — flow, step, title, note,
   * sourceUrl) is returned. Every save, deduped or not, records an `artifact_captures` row with
   * its own metadata (KS-1, design §8.1), so a flow's step order is read from captures.
   */
  save(input: SaveArtifactInput): Artifact {
    return this.capture(input).artifact;
  }

  /** Like `save`, reading the bytes from `filePath`; same dedupe, also captured. */
  saveFromPath(input: SaveArtifactFromPathInput): Artifact {
    return this.captureFromPath(input).artifact;
  }

  /** `save`, returning the capture id and whether the bytes were new (KS-1). */
  capture(input: SaveArtifactInput): CaptureResult {
    const { bytes, ...meta } = input;
    const buf = typeof bytes === 'string' ? Buffer.from(bytes, 'utf8') : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (buf.byteLength > MAX_ARTIFACT_BYTES) throw new ArtifactTooLargeError(buf.byteLength);
    return this.persist(meta, buf, extFor(meta.mime));
  }

  /** `saveFromPath`, returning the capture id and whether the bytes were new (KS-1). */
  captureFromPath(input: SaveArtifactFromPathInput): CaptureResult {
    const { filePath, ...meta } = input;
    const size = statSync(filePath).size;
    if (size > MAX_ARTIFACT_BYTES) throw new ArtifactTooLargeError(size);
    const buf = readFileSync(filePath);
    if (buf.byteLength > MAX_ARTIFACT_BYTES) throw new ArtifactTooLargeError(buf.byteLength);
    return this.persist(meta, buf, extFor(meta.mime, filePath));
  }

  read(id: string): { artifact: Artifact; bytes: Buffer } {
    const artifact = this.store.artifacts.get(id);
    if (!artifact) throw new ArtifactNotFoundError(id);
    return { artifact, bytes: readFileSync(join(this.dataDir, artifact.path)) };
  }

  /**
   * Returns the ids that are not usable as evidence by `workspaceId`: unknown, or owned by a
   * workspace outside its business tree. Artifacts of any workspace in the same tree (same root:
   * ancestors, siblings, cousins, descendants) count as present.
   */
  exists(workspaceId: string, ids: string[]): string[] {
    return ids.filter((id) => {
      const owner = this.store.artifacts.get(id)?.workspaceId;
      return owner === undefined || (owner !== workspaceId && !sameTree(this.store, owner, workspaceId));
    });
  }

  /** Filesystem location of an artifact's file (joined onto `dataDir`). */
  filePath(artifact: Artifact): string {
    return join(this.dataDir, artifact.path);
  }

  private persist(raw: ArtifactMeta, buf: Buffer, ext: string): CaptureResult {
    if (!SAFE_SEGMENT.test(raw.workspaceId)) {
      throw new Error(`invalid workspaceId '${raw.workspaceId}': only [A-Za-z0-9_-] allowed`);
    }
    const meta = this.sanitize(raw);
    const sha256 = createHash('sha256').update(buf).digest('hex');
    const rel = join(meta.workspaceId, 'artifacts', sha256.slice(0, 2), `${sha256}.${ext}`);
    const abs = join(this.dataDir, rel);
    if (!this.findBySha(meta.workspaceId, sha256) && !existsSync(abs)) {
      mkdirSync(dirname(abs), { recursive: true });
      const tmp = `${abs}.${randomBytes(6).toString('hex')}.tmp`;
      writeFileSync(tmp, buf);
      try {
        renameSync(tmp, abs);
      } catch (e) {
        rmSync(tmp, { force: true });
        throw e;
      }
    }
    const key = urlKey(meta.sourceUrl);
    // One transaction (BEGIN IMMEDIATE): the sha lookup, the artifact row and its capture row.
    return this.store.transaction(() => {
      let artifact = this.findBySha(meta.workspaceId, sha256);
      const created = !artifact;
      if (!artifact) {
        if (!existsSync(abs)) throw new Error(`artifact file missing after write: ${rel}`);
        const fresh: Artifact = {
          id: newId('art'),
          workspaceId: meta.workspaceId,
          kind: meta.kind,
          path: rel,
          sha256,
          mime: meta.mime,
          capturedAt: new Date().toISOString(),
        };
        if (meta.sourceUrl !== undefined) fresh.sourceUrl = meta.sourceUrl;
        if (meta.title !== undefined) fresh.title = meta.title;
        if (meta.flow !== undefined) fresh.flow = meta.flow;
        if (meta.step !== undefined) fresh.step = meta.step;
        if (meta.note !== undefined) fresh.note = meta.note;
        if (meta.description !== undefined) fresh.description = meta.description;
        if (key !== undefined) fresh.urlKey = key;
        artifact = this.store.artifacts.insert(fresh);
      } else if (!artifact.description && meta.description) {
        // A later save fills an empty description but never overwrites one (design §8.1).
        artifact = this.store.artifacts.update(artifact.id, { description: meta.description });
      }
      const captureId = newId('cap');
      knowledgeRepos(this.store).artifactCaptures.insert({
        id: captureId,
        artifactId: artifact.id,
        workspaceId: meta.workspaceId,
        agentRunId: meta.agentRunId,
        taskId: meta.taskId,
        runId: meta.runId,
        sourceUrl: meta.sourceUrl,
        urlKey: key,
        title: meta.title,
        flow: meta.flow,
        step: meta.step,
        note: meta.note,
        description: meta.description,
        entityId: meta.entityId,
        capturedAt: new Date().toISOString(),
      });
      return { artifact, captureId, created };
    });
  }

  /**
   * KS-1 (`describe_artifact`): sets the artifact's description (redacted and fence-stripped like a
   * saved one). The caller enforces who may describe what. Throws `ArtifactNotFoundError`.
   */
  setDescription(id: string, description: string): Artifact {
    const artifact = this.store.artifacts.get(id);
    if (!artifact) throw new ArtifactNotFoundError(id);
    const clean = this.sanitize({ workspaceId: artifact.workspaceId, kind: artifact.kind, mime: artifact.mime, description }).description;
    if (!clean) return artifact;
    return this.store.artifacts.update(id, { description: clean });
  }

  /**
   * KS-1 (design §8.5): identity secrets of the tree are redacted from the free-text labels before
   * they are stored (and so indexed by `artifacts_fts`); fence sequences are removed from the text
   * labels. `sourceUrl` is only redacted (it must stay a URL).
   */
  private sanitize(meta: ArtifactMeta): ArtifactMeta {
    const out: ArtifactMeta = { ...meta };
    const clean = (v: string | undefined) => (v === undefined ? undefined : stripFences(redactServed(this.store, meta.workspaceId, v)));
    for (const f of ['title', 'note', 'flow', 'description'] as const) {
      const v = clean(out[f]);
      if (v === undefined || (f === 'description' && !v.trim())) delete out[f];
      else out[f] = v;
    }
    if (out.sourceUrl !== undefined) out.sourceUrl = redactServed(this.store, meta.workspaceId, out.sourceUrl);
    return out;
  }

  private findBySha(workspaceId: string, sha256: string): Artifact | undefined {
    return this.store.artifacts.list({ workspaceId, sha256 })[0];
  }
}
