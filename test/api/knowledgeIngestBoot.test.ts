import { mkdtempSync } from 'node:fs';
import { createServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { boot } from '../../src/api/main.js';
import { ArtifactStore } from '../../src/core/evidence/artifacts.js';
import { ingestorFor } from '../../src/core/knowledge/ingest.js';
import { openStore } from '../../src/core/store/db.js';
import { knowledgeRepos } from '../../src/core/store/repos.js';

/** A free port (`boot` treats `port: 0` as "use the configured default"). */
const freePort = () =>
  new Promise<number>((ok) => {
    const s = createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address() as AddressInfo;
      s.close(() => ok(port));
    });
  });

describe('knowledge store at startup (KS-1)', () => {
  it('re-queues artifacts whose text is still pending and extracts them', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bif-kiboot-'));
    const data = join(dir, 'data');
    const pre = openStore(join(data, 'bif.db'));
    pre.workspaces.insert({ id: 'ws_a', name: 'Acme', sector: 'saas', createdAt: '2026-11-13T10:00:00.000Z' });
    // Saved before the restart, never extracted (no ingestor in this process).
    const art = new ArtifactStore(pre, data).save({ workspaceId: 'ws_a', kind: 'text', mime: 'text/plain', bytes: 'Pricing starts at 10 dollars.' });
    expect(knowledgeRepos(pre).artifactTexts.get(art.id)!.status).toBe('pending');
    pre.close();
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const b = await boot({ configPath: join(dir, 'bif.config.json'), dataDir: data, port: await freePort(), webDist: join(dir, 'no-web') });
    try {
      await ingestorFor({ store: b.runtime.store, artifacts: b.runtime.artifacts }).idle();
      expect(knowledgeRepos(b.runtime.store).artifactTexts.get(art.id)!.status).toBe('ok');
      expect(knowledgeRepos(b.runtime.store).chunks.list({ artifactId: art.id })).toHaveLength(1);
      expect(log.mock.calls.map((c) => String(c[0])).join('\n')).toMatch(/1 artifacts queued for text extraction/);
    } finally {
      log.mockRestore();
      await b.close();
    }
  });
});
