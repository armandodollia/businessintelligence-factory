import { existsSync, mkdtempSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ArtifactNotFoundError,
  ArtifactStore,
  ArtifactTooLargeError,
  MAX_ARTIFACT_BYTES,
} from '../../src/core/evidence/artifacts.js';
import { openStore, type Store } from '../../src/core/store/db.js';

let dir: string;
let store: Store;
let artifacts: ArtifactStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bif-art-'));
  store = openStore(join(dir, 'bif.db'));
  artifacts = new ArtifactStore(store, join(dir, 'data'));
});

afterEach(() => store.close());

describe('ArtifactStore', () => {
  it('save then read returns same bytes', () => {
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
    const a = artifacts.save({
      workspaceId: 'ws_1',
      kind: 'screenshot',
      bytes,
      mime: 'image/png',
      sourceUrl: 'https://acme.test/signup',
      flow: 'signup',
      step: 1,
      note: 'landing',
    });
    expect(a.id).toMatch(/^art_/);
    expect(a.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(a.path).toBe(join('ws_1', 'artifacts', a.sha256.slice(0, 2), `${a.sha256}.png`));
    expect(existsSync(join(dir, 'data', a.path))).toBe(true);
    const got = artifacts.read(a.id);
    expect(got.artifact).toEqual(a);
    expect(Buffer.compare(got.bytes, Buffer.from(bytes))).toBe(0);

    const t = artifacts.save({ workspaceId: 'ws_1', kind: 'text', bytes: 'héllo', mime: 'text/plain' });
    expect(artifacts.read(t.id).bytes.toString('utf8')).toBe('héllo');
    expect(t.path.endsWith('.txt')).toBe(true);
  });

  it('same bytes twice returns same artifact id (dedupe per workspace)', () => {
    const input = { workspaceId: 'ws_1', kind: 'text' as const, bytes: 'same', mime: 'text/plain' };
    const a = artifacts.save(input);
    const b = artifacts.save({ ...input, title: 'again' });
    expect(b.id).toBe(a.id);
    expect(store.artifacts.list({ workspaceId: 'ws_1' })).toHaveLength(1);
    const other = artifacts.save({ ...input, workspaceId: 'ws_2' });
    expect(other.id).not.toBe(a.id);
    expect(other.workspaceId).toBe('ws_2');
  });

  it('rejects > 50MB with ArtifactTooLargeError', () => {
    expect(MAX_ARTIFACT_BYTES).toBe(50 * 1024 * 1024);
    const big = new Uint8Array(MAX_ARTIFACT_BYTES + 1);
    expect(() =>
      artifacts.save({ workspaceId: 'ws_1', kind: 'page_snapshot', bytes: big, mime: 'text/html' }),
    ).toThrow(ArtifactTooLargeError);
    expect(() =>
      artifacts.save({ workspaceId: 'ws_1', kind: 'page_snapshot', bytes: big, mime: 'text/html' }),
    ).toThrow(/50 MB/);

    const file = join(dir, 'huge.pdf');
    writeFileSync(file, '');
    truncateSync(file, MAX_ARTIFACT_BYTES + 1);
    expect(() =>
      artifacts.saveFromPath({ workspaceId: 'ws_1', kind: 'document', filePath: file, mime: 'application/pdf' }),
    ).toThrow(ArtifactTooLargeError);
    expect(store.artifacts.list()).toHaveLength(0);
  });

  it('saveFromPath stores the file contents', () => {
    const file = join(dir, 'report.pdf');
    writeFileSync(file, '%PDF-1.7 fake');
    const a = artifacts.saveFromPath({
      workspaceId: 'ws_1',
      kind: 'upload',
      filePath: file,
      mime: 'application/pdf',
      title: 'Q3 export',
    });
    expect(a.path.endsWith('.pdf')).toBe(true);
    expect(a.title).toBe('Q3 export');
    expect(artifacts.read(a.id).bytes.toString()).toBe('%PDF-1.7 fake');
  });

  it('exists reports missing ids and ids from other workspaces as missing', () => {
    const a = artifacts.save({ workspaceId: 'ws_1', kind: 'text', bytes: 'a', mime: 'text/plain' });
    const b = artifacts.save({ workspaceId: 'ws_2', kind: 'text', bytes: 'b', mime: 'text/plain' });
    expect(artifacts.exists('ws_1', [a.id])).toEqual([]);
    expect(artifacts.exists('ws_1', [a.id, b.id, 'art_nope'])).toEqual([b.id, 'art_nope']);
  });

  it('read of unknown id throws ArtifactNotFoundError; unsafe workspace ids rejected', () => {
    expect(() => artifacts.read('art_nope')).toThrow(ArtifactNotFoundError);
    expect(() =>
      artifacts.save({ workspaceId: '../evil', kind: 'text', bytes: 'x', mime: 'text/plain' }),
    ).toThrow(/workspaceId/);
  });
});
