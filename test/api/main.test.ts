import { mkdtempSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { boot } from '../../src/api/main.js';

describe('boot', () => {
  it('serves the API and MCP over real HTTP with every phase runner wired', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bif-boot-'));
    const b = await boot({ configPath: join(dir, 'bif.config.json'), dataDir: join(dir, 'data'), port: 0, webDist: join(dir, 'no-web') });
    try {
      const { port } = b.server.address() as AddressInfo;
      const res = await fetch(`http://127.0.0.1:${port}/api/workspaces`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual([]);
      const mcp = await fetch(`http://127.0.0.1:${port}/mcp/tok_bogus`, { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } });
      expect(mcp.status).toBe(401);
      expect(Object.keys(b.runtime.research.phaseRunners ?? {}).sort()).toEqual(['persona_panel', 'scoring']);
      expect(b.runtime.dataDir).toBe(join(dir, 'data'));
    } finally {
      await b.close();
    }
  });
});
