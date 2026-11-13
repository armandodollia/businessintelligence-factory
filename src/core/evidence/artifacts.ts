import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, extname, join } from 'node:path';
import type { Store } from '../store/db.js';
import { newId } from '../store/repos.js';
import type { Artifact } from '../types.js';

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
}

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
    private readonly dataDir: string,
  ) {}

  save(input: SaveArtifactInput): Artifact {
    const { bytes, ...meta } = input;
    const buf = typeof bytes === 'string' ? Buffer.from(bytes, 'utf8') : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (buf.byteLength > MAX_ARTIFACT_BYTES) throw new ArtifactTooLargeError(buf.byteLength);
    return this.persist(meta, buf, extFor(meta.mime));
  }

  saveFromPath(input: SaveArtifactFromPathInput): Artifact {
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

  /** Returns the ids that do not exist in `workspaceId` (unknown or owned by another workspace). */
  exists(workspaceId: string, ids: string[]): string[] {
    return ids.filter((id) => this.store.artifacts.get(id)?.workspaceId !== workspaceId);
  }

  /** Filesystem location of an artifact's file (joined onto `dataDir`). */
  filePath(artifact: Artifact): string {
    return join(this.dataDir, artifact.path);
  }

  private persist(meta: ArtifactMeta, buf: Buffer, ext: string): Artifact {
    if (!SAFE_SEGMENT.test(meta.workspaceId)) {
      throw new Error(`invalid workspaceId '${meta.workspaceId}': only [A-Za-z0-9_-] allowed`);
    }
    const sha256 = createHash('sha256').update(buf).digest('hex');
    const existing = this.findBySha(meta.workspaceId, sha256);
    if (existing) return existing;

    const rel = join(meta.workspaceId, 'artifacts', sha256.slice(0, 2), `${sha256}.${ext}`);
    const abs = join(this.dataDir, rel);
    if (!existsSync(abs)) {
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

    const artifact: Artifact = {
      id: newId('art'),
      workspaceId: meta.workspaceId,
      kind: meta.kind,
      path: rel,
      sha256,
      mime: meta.mime,
      capturedAt: new Date().toISOString(),
    };
    if (meta.sourceUrl !== undefined) artifact.sourceUrl = meta.sourceUrl;
    if (meta.title !== undefined) artifact.title = meta.title;
    if (meta.flow !== undefined) artifact.flow = meta.flow;
    if (meta.step !== undefined) artifact.step = meta.step;
    if (meta.note !== undefined) artifact.note = meta.note;

    try {
      return this.store.artifacts.insert(artifact);
    } catch (e) {
      // Lost a race on the (workspace_id, sha256) unique index: return the winner.
      const winner = this.findBySha(meta.workspaceId, sha256);
      if (winner) return winner;
      throw e;
    }
  }

  private findBySha(workspaceId: string, sha256: string): Artifact | undefined {
    return this.store.artifacts.list({ workspaceId, sha256 })[0];
  }
}
