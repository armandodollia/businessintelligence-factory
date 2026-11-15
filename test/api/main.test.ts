import { mkdtempSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { boot } from '../../src/api/main.js';
import { feedbackOutcomesRegistered } from '../../src/core/learning/feedbackOutcomes.js';

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
      expect(Object.keys(b.runtime.research.phaseRunners ?? {}).sort()).toEqual(['flow_ranking', 'persona_panel', 'scoring']);
      expect(b.runtime.dataDir).toBe(join(dir, 'data'));
      // Learning loop: the feedback → outcome listener is registered at boot.
      expect(feedbackOutcomesRegistered()).toBe(true);
      // WP-D: bus events are persisted and the escalation tool is wired.
      b.runtime.events.emit({ type: 'task_status', workspaceId: 'ws_boot', taskId: 'tsk_none', status: 'verified' });
      const persisted = await fetch(`http://127.0.0.1:${port}/api/workspaces/ws_boot/bus-events`);
      expect(persisted.status).toBe(404); // unknown workspace; the row itself is checked below
      const rows = b.runtime.store.db.prepare("SELECT type FROM bus_events WHERE workspace_id = 'ws_boot'").all();
      expect(rows).toEqual([{ type: 'task_status' }]);
      const r = await b.runtime.handle(
        { agentRunId: 'arun_x', workspaceId: 'ws_boot', role: 'escalation', model: { provider: 'claude', model: 'opus' }, promptVersion: 'v' },
        'submit_escalation',
        { questions: [] },
      );
      expect(r).toMatchObject({ ok: false, error: expect.stringMatching(/needs a task/) });
      // Flow ranking: the persona verdict tool is wired (it answers for itself, not "not available").
      const fv = await b.runtime.handle(
        { agentRunId: 'arun_y', workspaceId: 'ws_boot', role: 'persona', model: { provider: 'claude', model: 'opus' }, promptVersion: 'v' },
        'submit_flow_verdicts',
        { flow_type: 'teleport', verdicts: [] },
      );
      expect(fv.ok).toBe(false);
      expect(fv.ok ? '' : fv.error).not.toMatch(/not available/);
    } finally {
      await b.close();
    }
  });

  it('port 0 listens on an ephemeral port (parallel boots never collide on the configured one)', async () => {
    const dirs = [0, 1].map(() => mkdtempSync(join(tmpdir(), 'bif-boot-')));
    const boots = await Promise.all(
      dirs.map((dir) => boot({ configPath: join(dir, 'bif.config.json'), dataDir: join(dir, 'data'), port: 0, webDist: join(dir, 'no-web') })),
    );
    try {
      const ports = boots.map((b) => (b.server.address() as AddressInfo).port);
      expect(new Set(ports).size).toBe(2);
      for (const [i, b] of boots.entries()) {
        expect(ports[i]).not.toBe(b.runtime.config.server.port);
        expect(b.runtime.port).toBe(ports[i]);
        // Agents are pointed at the port actually listened on.
        expect((b.runtime.supervisor as unknown as { deps: { mcpBaseUrl: string } }).deps.mcpBaseUrl).toBe(`http://127.0.0.1:${ports[i]}`);
      }
    } finally {
      await Promise.all(boots.map((b) => b.close()));
    }
  });

  it('warns at startup when browser tasks cannot get a browser', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bif-boot-'));
    const configPath = join(dir, 'bif.config.json');
    writeFileSync(configPath, JSON.stringify({ browser: { mode: 'per_run', mcpServers: {} } }));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const b = await boot({ configPath, dataDir: join(dir, 'data'), port: 0, webDist: join(dir, 'no-web') });
    try {
      expect(warn.mock.calls.map((c) => String(c[0])).join('\n')).toMatch(/\[bif\] warning: .*mcpServers is empty/);
    } finally {
      warn.mockRestore();
      await b.close();
    }
  });
});
