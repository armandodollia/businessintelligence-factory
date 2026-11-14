import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { boot } from '../../src/api/main.js';
import { ArtifactStore } from '../../src/core/evidence/artifacts.js';
import { ingestorFor } from '../../src/core/knowledge/ingest.js';
import type { OcrReader, OcrRequest } from '../../src/core/knowledge/ocr/haiku.js';
import { ocrSinkFor } from '../../src/core/knowledge/ocr/registry.js';
import { openStore } from '../../src/core/store/db.js';
import { knowledgeRepos } from '../../src/core/store/repos.js';
import { makePdf } from '../fixtures/knowledge/build.js';

const seed = () => {
  const dir = mkdtempSync(join(tmpdir(), 'bif-ocrboot-'));
  const data = join(dir, 'data');
  const pre = openStore(join(data, 'bif.db'));
  pre.workspaces.insert({ id: 'ws_a', name: 'Acme', sector: 'saas', createdAt: '2026-11-14T10:00:00.000Z' });
  const art = new ArtifactStore(pre, data).save({ workspaceId: 'ws_a', kind: 'upload', mime: 'application/pdf', bytes: makePdf([null]) });
  pre.close();
  return { dir, data, art };
};
const opts = (s: { dir: string; data: string }) => ({ configPath: join(s.dir, 'bif.config.json'), dataDir: s.data, port: 0, webDist: join(s.dir, 'no-web') });

describe('two-pass OCR at startup', () => {
  it('with a reader, a scanned PDF saved before the restart is extracted, planned and read', async () => {
    const s = seed();
    const calls: OcrRequest[] = [];
    const reader: OcrReader = {
      model: 'haiku',
      async read(req) {
        calls.push(req);
        return { ok: true, pages: [{ page: 1, text: 'Renewal price is 48 dollars per seat.' }] };
      },
    };
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const b = await boot({ ...opts(s), ocrReader: reader });
    try {
      await ingestorFor({ store: b.runtime.store, artifacts: b.runtime.artifacts }).idle();
      await b.ocr!.idle();
      expect(calls).toHaveLength(1);
      const row = knowledgeRepos(b.runtime.store).artifactTexts.get(s.art.id)!;
      expect(row).toMatchObject({ status: 'ok', ocrStatus: 'done' });
      const chunks = knowledgeRepos(b.runtime.store).chunks.list({ artifactId: s.art.id });
      expect(chunks).toHaveLength(1);
      expect(chunks[0]).toMatchObject({ locator: 'page 1 (ocr)', uploadDerived: true });
    } finally {
      log.mockRestore();
      await b.close();
    }
    // Shutdown unregisters the queue.
    expect(ocrSinkFor(b.runtime.artifacts)).toBeUndefined();
  });

  it('without a reader (the default), no model is ever called and nothing is planned', async () => {
    const s = seed();
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const b = await boot(opts(s));
    try {
      await ingestorFor({ store: b.runtime.store, artifacts: b.runtime.artifacts }).idle();
      expect(b.ocr).toBeUndefined();
      const row = knowledgeRepos(b.runtime.store).artifactTexts.get(s.art.id)!;
      expect(row.status).toBe('empty');
      expect(row.ocrStatus).toBeUndefined();
    } finally {
      log.mockRestore();
      await b.close();
    }
  });
});
