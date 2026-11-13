import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig, reviewerFor } from '../../src/core/config/load.js';
import { defaultConfig } from '../../src/core/config/schema.js';

function writeConfig(content: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'bif-config-'));
  const file = join(dir, 'bif.config.json');
  writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content));
  return file;
}

describe('config', () => {
  it('defaults load with no file', () => {
    const cfg = loadConfig();
    expect(cfg.loop.maxRounds).toBe(3);
    expect(cfg.loop.passThreshold).toBe(8);
    expect(cfg.scoring.personaWeight).toBe(0);
    expect(cfg.limits).toEqual({
      maxParallelWorkers: 3,
      maxBrowserRuns: 2,
      maxTasksPerRun: 30,
      idleTimeoutMs: 600000,
    });
    expect(cfg.server.port).toBe(4317);
    expect(cfg.dataDir).toBe('data');
  });

  it('invalid passThreshold 11 throws ConfigError mentioning loop.passThreshold', () => {
    const file = writeConfig({ loop: { passThreshold: 11 } });
    let err: unknown;
    try {
      loadConfig(file);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ConfigError);
    expect((err as ConfigError).message).toContain('loop.passThreshold');
    expect((err as ConfigError).issues.map((i) => i.path)).toContain('loop.passThreshold');
  });

  it('deep-merges a partial file over defaults', () => {
    const file = writeConfig({ loop: { maxRounds: 5 }, server: { port: 9000 } });
    const cfg = loadConfig(file);
    expect(cfg.loop.maxRounds).toBe(5);
    expect(cfg.loop.passThreshold).toBe(8);
    expect(cfg.server.port).toBe(9000);
    expect(cfg.providers.claude.command).toBe(defaultConfig.providers.claude.command);
  });

  it('bif.config.example.json is valid', () => {
    const cfg = loadConfig(join(import.meta.dirname, '../../bif.config.example.json'));
    expect(cfg.roles.workers.flow_walkthrough).toEqual({ provider: 'claude', model: 'opus' });
  });

  it('missing explicit file and invalid JSON throw ConfigError', () => {
    expect(() => loadConfig('/nonexistent/bif.config.json')).toThrow(ConfigError);
    expect(() => loadConfig(writeConfig('{ not json'))).toThrow(ConfigError);
  });

  it('rejects a role model not allowed by its provider', () => {
    const file = writeConfig({ roles: { orchestrator: { provider: 'claude', model: 'nope' } } });
    expect(() => loadConfig(file)).toThrow(/roles\.orchestrator/);
  });

  it('reviewerFor picks other provider when worker is claude and codex enabled', () => {
    const file = writeConfig({
      providers: {
        claude: { enabled: true, command: 'claude', models: ['opus', 'sonnet'] },
        codex: { enabled: true, command: 'codex', models: ['gpt-x', 'gpt-y'] },
        opencode: { enabled: false, command: 'opencode', models: [] },
      },
      roles: { reviewer: { provider: 'claude', model: 'opus' } },
    });
    const cfg = loadConfig(file);
    expect(reviewerFor({ provider: 'claude', model: 'sonnet' }, cfg)).toEqual({
      provider: 'codex',
      model: 'gpt-x',
    });
    // Different provider than worker: configured reviewer is kept.
    expect(reviewerFor({ provider: 'codex', model: 'gpt-x' }, cfg)).toEqual({
      provider: 'claude',
      model: 'opus',
    });
  });

  it('reviewerFor keeps configured reviewer when no other provider is enabled', () => {
    const file = writeConfig({
      providers: {
        claude: { enabled: true, command: 'claude', models: ['opus', 'sonnet'] },
        codex: { enabled: false, command: 'codex', models: ['gpt-x'] },
        opencode: { enabled: false, command: 'opencode', models: [] },
      },
      roles: {
        orchestrator: { provider: 'claude', model: 'opus' },
        interviewer: { provider: 'claude', model: 'opus' },
        reviewer: { provider: 'claude', model: 'opus' },
        synthesizer: { provider: 'claude', model: 'opus' },
        persona: { provider: 'claude', model: 'sonnet' },
        workers: { default: { provider: 'claude', model: 'sonnet' } },
      },
    });
    const cfg = loadConfig(file);
    expect(reviewerFor({ provider: 'claude', model: 'sonnet' }, cfg)).toEqual({
      provider: 'claude',
      model: 'opus',
    });
  });
});
