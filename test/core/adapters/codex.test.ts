import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { RunEvent, SpawnSpec } from '../../../src/core/harness/adapter.js';
import { BIF_TOKEN_ENV, CODEX_HOME_CONFIG, CodexAdapter, toToml } from '../../../src/core/harness/adapters/codex.js';
import { getAdapter } from '../../../src/core/harness/adapters/index.js';

const spec: SpawnSpec = {
  prompt: 'Walk the signup flow',
  systemPrompt: 'You are a research worker.',
  model: 'gpt-6.1-sol',
  mcpUrl: 'http://127.0.0.1:4317/mcp/tok_abc',
  extraMcpServers: {
    playwright: { command: 'npx', args: ['@playwright/mcp@0.0.41', '--user-data-dir', 'data/browser-profile'], env: { A: '1' } },
    remote: { type: 'http', url: 'http://x.test/mcp' },
  },
  cwd: '/tmp/bif-run',
};

const fixture = (name: string) =>
  readFileSync(join(import.meta.dirname, '../../fixtures', name), 'utf8').split('\n').filter(Boolean);

const parseAll = (lines: string[]): RunEvent[] => {
  const a = new CodexAdapter();
  return lines.flatMap((l) => a.parseLine(l));
};

describe('CodexAdapter', () => {
  it('command shape', () => {
    const { cmd, args, files } = new CodexAdapter().buildCommand(spec);
    expect(cmd).toBe('codex');
    expect(args.slice(0, 2)).toEqual(['exec', '--json']);
    const at = (flag: string) => args[args.indexOf(flag) + 1];
    expect(at('-m')).toBe('gpt-6.1-sol');
    expect(at('-s')).toBe('danger-full-access');
    expect(args).toContain('--skip-git-repo-check');
    expect(args).toContain('-C');
    expect(at('-C')).toBe('/tmp/bif-run');
    const configs = args.flatMap((a, i) => (args[i - 1] === '-c' ? [a] : []));
    expect(configs).toContain('mcp_servers.bif.url="http://127.0.0.1:4317/mcp/tok_abc"');
    expect(configs).toContain('mcp_servers.bif.tool_timeout_sec=86400');
    expect(configs).toContain('mcp_servers.playwright.command="npx"');
    expect(configs).toContain(
      'mcp_servers.playwright.args=["@playwright/mcp@0.0.41", "--user-data-dir", "data/browser-profile"]',
    );
    expect(configs).toContain('mcp_servers.playwright.env={ A = "1" }');
    expect(configs).toContain('mcp_servers.remote.url="http://x.test/mcp"');
    expect(configs.some((c) => c.startsWith('mcp_servers.remote.type'))).toBe(false);
    const prompt = args.at(-1)!;
    expect(prompt.startsWith('<system>\nYou are a research worker.\n</system>')).toBe(true);
    expect(prompt.endsWith('Walk the signup flow')).toBe(true);
    expect(files).toEqual([]);
  });

  it('effort: -c model_reasoning_effort="<level>" when the run has one; the same command as before when it has none', () => {
    const plain = new CodexAdapter().buildCommand(spec).args;
    expect(plain.some((a) => a.startsWith('model_reasoning_effort'))).toBe(false);
    const args = new CodexAdapter().buildCommand({ ...spec, effort: 'high' }).args;
    const at = args.indexOf('model_reasoning_effort="high"');
    expect(args[at - 1]).toBe('-c');
    expect(args.at(-1)).toBe(plain.at(-1)); // the prompt stays the last argument
    expect(args.filter((_, i) => i !== at && i !== at - 1)).toEqual(plain);
  });

  it('bearer endpoint keeps the run token out of argv (env var instead)', () => {
    const { args, env } = new CodexAdapter().buildCommand({
      ...spec, mcpBearer: { url: 'http://127.0.0.1:4317/mcp', token: 'tok_abc' },
    });
    expect(args.join('\n')).not.toContain('tok_abc');
    const configs = args.flatMap((a, i) => (args[i - 1] === '-c' ? [a] : []));
    expect(configs).toContain('mcp_servers.bif.url="http://127.0.0.1:4317/mcp"');
    expect(configs).toContain(`mcp_servers.bif.bearer_token_env_var="${BIF_TOKEN_ENV}"`);
    expect(env).toMatchObject({ [BIF_TOKEN_ENV]: 'tok_abc' });
  });

  it('stateDir: dedicated CODEX_HOME with generated config.toml and auth.json linked to the user home', () => {
    const prev = process.env.CODEX_HOME;
    process.env.CODEX_HOME = '/users/me/.codex';
    try {
      const { env, files, links } = new CodexAdapter().buildCommand({ ...spec, stateDir: '/data/cli-state' });
      const home = join('/data/cli-state', 'codex-home');
      expect(env).toMatchObject({ CODEX_HOME: home });
      expect(files).toEqual([{ path: join(home, 'config.toml'), content: CODEX_HOME_CONFIG }]);
      expect(CODEX_HOME_CONFIG.split('\n').filter((l) => l.trim() && !l.startsWith('#'))).toEqual([]);
      expect(links).toEqual([{ path: join(home, 'auth.json'), target: join('/users/me/.codex', 'auth.json') }]);
      // Without stateDir nothing changes (the CLI's own home is used).
      expect(new CodexAdapter().buildCommand(spec).env).toBeUndefined();
    } finally {
      if (prev === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = prev;
    }
  });

  it('skills: no skills instructions in the run (the person\'s own skills under ~/.agents/skills are not listed)', () => {
    for (const s of [spec, { ...spec, stateDir: '/data/cli-state' }]) {
      const { args } = new CodexAdapter().buildCommand(s);
      const at = args.indexOf('skills.include_instructions=false');
      expect(at).toBeGreaterThan(0);
      expect(args[at - 1]).toBe('-c');
    }
  });

  it('ephemeral: no session files kept (--ephemeral), with or without a private CODEX_HOME', () => {
    for (const s of [spec, { ...spec, stateDir: '/data/cli-state' }]) {
      const { args } = new CodexAdapter().buildCommand(s);
      expect(args).toContain('--ephemeral');
      expect(args.indexOf('--ephemeral')).toBeLessThan(args.length - 1); // the prompt stays last
    }
  });

  it('withheld MCP tools: -c mcp_servers.<server>.disabled_tools=[...]', () => {
    const plain = new CodexAdapter().buildCommand(spec).args;
    expect(plain.some((a) => a.includes('disabled_tools'))).toBe(false);
    const args = new CodexAdapter().buildCommand({ ...spec, withheldTools: { browser: ['browser_close'] } }).args;
    const at = args.indexOf('mcp_servers.browser.disabled_tools=["browser_close"]');
    expect(args[at - 1]).toBe('-c');
  });

  it('toToml renders inline values', () => {
    expect(toToml('a"b')).toBe('"a\\"b"');
    expect(toToml(3)).toBe('3');
    expect(toToml(true)).toBe('true');
    expect(toToml({ 'a-b': 1, 'c d': [1, 'x'] })).toBe('{ a-b = 1, "c d" = [1, "x"] }');
  });

  it('fixture parse → message/tool_call/done', () => {
    const events = parseAll(fixture('codex-stream.jsonl'));
    expect(events).toContainEqual({ t: 'message', text: 'done' });
    expect(events).toContainEqual({
      t: 'tool_call',
      name: 'save_finding',
      input: { claim: 'Acme hides pricing', subject: 'Acme', evidence: ['art_1'] },
    });
    expect(events.filter((e) => e.t === 'tool_call')).toHaveLength(1);
    expect(events).toContainEqual({ t: 'tool_result', name: 'save_finding', ok: true });
    expect(events).toContainEqual({ t: 'usage', inputTokens: 58852, outputTokens: 93, cacheReadTokens: 51968, cacheWriteTokens: 0 });
    expect(events.at(-1)).toEqual({ t: 'done', exitCode: 0 });
  });

  it('error fixture → error + done(1)', () => {
    const events = parseAll(fixture('codex-error.jsonl'));
    expect(events).toContainEqual(expect.objectContaining({ t: 'error', rateLimited: false }));
    expect(events.at(-1)).toEqual({ t: 'done', exitCode: 1 });
  });

  it('rate-limit detection', () => {
    const a = new CodexAdapter();
    expect(a.parseLine(JSON.stringify({ type: 'error', message: "You've hit your usage limit. Try again later." }))).toEqual([
      expect.objectContaining({ t: 'error', rateLimited: true }),
    ]);
    expect(
      a.parseLine(JSON.stringify({ type: 'turn.failed', error: { message: 'exceeded retry limit, last status: 429 Too Many Requests' } })),
    ).toContainEqual(expect.objectContaining({ t: 'error', rateLimited: true }));
    expect(a.parseLine('garbage')).toEqual([]);
  });

  it('getAdapter returns fresh adapters per provider', () => {
    expect(getAdapter('codex').id).toBe('codex');
    expect(getAdapter('claude').id).toBe('claude');
    expect(getAdapter('opencode').id).toBe('opencode');
    expect(getAdapter('codex')).not.toBe(getAdapter('codex'));
    expect(getAdapter('codex', '/opt/codex').buildCommand(spec).cmd).toBe('/opt/codex');
  });

  it('guards a dash-leading prompt when there is no system prompt', () => {
    const { args } = new CodexAdapter().buildCommand({ ...spec, systemPrompt: '', prompt: '--oops' });
    expect(args.at(-1)!.startsWith('-')).toBe(false);
  });
});

