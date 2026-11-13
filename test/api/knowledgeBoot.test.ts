import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createRuntime } from '../../src/api/main.js';
import { openStore } from '../../src/core/store/db.js';
import { knowledgeRepos } from '../../src/core/store/repos.js';

describe('knowledge store at startup (KS-0)', () => {
  it('runs the backfill once the store is open', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bif-kboot-'));
    const data = join(dir, 'data');
    const pre = openStore(join(data, 'bif.db'));
    pre.workspaces.insert({ id: 'ws_a', name: 'Acme', sector: 'saas', createdAt: '2026-11-13T10:00:00.000Z' });
    pre.competitors.insert({
      id: 'cmp_1', workspaceId: 'ws_a', name: 'Globex', threat: 3, directness: 3,
      comparison: { pricing: 3, onboarding: 3, ux: 3, features: 3 }, evidence: [], createdAt: '2026-11-13T10:00:00.000Z',
      updatedAt: '2026-11-13T10:00:00.000Z',
    });
    pre.close();
    const rt = createRuntime({ configPath: join(dir, 'bif.config.json'), dataDir: data, webDist: join(dir, 'no-web') });
    try {
      const entityId = rt.store.competitors.get('cmp_1')!.entityId;
      expect(entityId).toBeDefined();
      expect(knowledgeRepos(rt.store).entities.get(entityId!)).toMatchObject({ kind: 'competitor', name: 'Globex', rootWorkspaceId: 'ws_a' });
    } finally {
      rt.store.close();
    }
  });
});
