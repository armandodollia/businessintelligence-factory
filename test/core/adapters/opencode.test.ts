import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { RunEvent, SpawnSpec } from '../../../src/core/harness/adapter.js';
import { OpenCodeAdapter } from '../../../src/core/harness/adapters/opencode.js';

const spec: SpawnSpec = {
  prompt: 'Walk the signup flow',
  systemPrompt: 'You are a research worker.',
  model: 'github-copilot/gpt-6.1-sol',
  mcpUrl: 'http://127.0.0.1:4317/mcp/tok_abc',
  extraMcpServers: {
    playwright: { command: 'npx', args: ['@playwright/mcp@0.0.41'], env: { A: '1' } },
    remote: { type: 'http', url: 'http://x.test/mcp', headers: { h: 'v' } },
  },
  cwd: '/tmp/bif-run',
};

const fixture = (name: string) =>
  readFileSync(join(import.meta.dirname, '../../fixtures', name), 'utf8').split('\n').filter(Boolean);

const parseAll = (lines: string[]): RunEvent[] => {
  const a = new OpenCodeAdapter();
  return lines.flatMap((l) => a.parseLine(l));
};

describe('OpenCodeAdapter', () => {
  it('effort: --variant <level> when the run has one; the same command as before when it has none', () => {
    const plain = new OpenCodeAdapter().buildCommand(spec).args;
    expect(plain).not.toContain('--variant');
    const args = new OpenCodeAdapter().buildCommand({ ...spec, effort: 'high' }).args;
    const at = args.indexOf('--variant');
    expect(args.slice(at, at + 2)).toEqual(['--variant', 'high']);
    expect(args.at(-1)).toBe(plain.at(-1)); // the prompt stays the last argument
    expect(args.filter((_, i) => i !== at && i !== at + 1)).toEqual(plain);
  });

  it('command shape and generated config file', () => {
    const { cmd, args, files, env } = new OpenCodeAdapter().buildCommand(spec);
    expect(cmd).toBe('opencode');
    expect(args.slice(0, 5)).toEqual(['run', '--format', 'json', '-m', 'github-copilot/gpt-6.1-sol']);
    const prompt = args.at(-1)!;
    expect(prompt.startsWith('<system>\nYou are a research worker.\n</system>')).toBe(true);
    expect(files).toHaveLength(1);
    expect(files[0]!.path).toBe(join('/tmp/bif-run', '.bif-opencode.json'));
    // Only the generated file is loaded: no project config, no redirect of the global dir without stateDir.
    expect(env).toEqual({ OPENCODE_CONFIG: files[0]!.path, OPENCODE_DISABLE_PROJECT_CONFIG: '1' });
    expect(args.join(' ')).not.toContain('tok_');
    const cfg = JSON.parse(files[0]!.content);
    expect(cfg.mcp.bif).toEqual({ type: 'remote', url: spec.mcpUrl, enabled: true, oauth: false, timeout: 86_400_000 });
    expect(cfg.mcp.playwright).toEqual({
      type: 'local', command: ['npx', '@playwright/mcp@0.0.41'], environment: { A: '1' }, enabled: true,
    });
    expect(cfg.mcp.remote).toEqual({ type: 'remote', url: 'http://x.test/mcp', headers: { h: 'v' }, enabled: true });
  });

  it('stateDir isolates the global config dir (user MCP servers are not loaded)', () => {
    const { env } = new OpenCodeAdapter().buildCommand({ ...spec, stateDir: '/data/cli-state' });
    expect(env).toMatchObject({ XDG_CONFIG_HOME: join('/data/cli-state', 'opencode-config'), OPENCODE_DISABLE_PROJECT_CONFIG: '1' });
  });

  it('fixture parse → message/tool_call/done', () => {
    const events = parseAll(fixture('opencode-stream.jsonl'));
    expect(events).toContainEqual({ t: 'message', text: 'done' });
    expect(events).toContainEqual({
      t: 'tool_call',
      name: 'save_finding',
      input: { claim: 'Acme hides pricing', subject: 'Acme', evidence: ['art_1'] },
    });
    expect(events).toContainEqual({ t: 'tool_result', name: 'save_finding', ok: true });
    expect(events).toContainEqual({ t: 'tool_result', name: 'save_artifact', ok: false });
    expect(events).toContainEqual({
      t: 'usage', inputTokens: 2300, outputTokens: 5, costUsd: 0.0012, cacheReadTokens: 1000, cacheWriteTokens: 0,
    });
    expect(events.filter((e) => e.t === 'done')).toEqual([{ t: 'done', exitCode: 0 }]);
    expect(events.at(-1)).toEqual({ t: 'done', exitCode: 0 });
  });

  it('error line (real capture) → error + done(1)', () => {
    const events = parseAll(fixture('opencode-error.jsonl'));
    expect(events[0]).toMatchObject({ t: 'error', rateLimited: false });
    expect((events[0] as { message: string }).message).toContain('not available');
    expect(events.at(-1)).toEqual({ t: 'done', exitCode: 1 });
  });

  it('rate-limit detection', () => {
    const a = new OpenCodeAdapter();
    const line = JSON.stringify({
      type: 'error', timestamp: 1, sessionID: 's',
      error: { name: 'APIError', data: { message: 'Free usage limit reached.', statusCode: 429, isRetryable: true } },
    });
    expect(a.parseLine(line)[0]).toMatchObject({ t: 'error', rateLimited: true });
    expect(a.parseLine('garbage')).toEqual([]);
  });
});
