import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { RunEvent, SpawnSpec } from '../../../src/core/harness/adapter.js';
import { ClaudeAdapter } from '../../../src/core/harness/adapters/claude.js';

const spec: SpawnSpec = {
  prompt: 'Walk the signup flow',
  systemPrompt: 'You are a research worker.',
  model: 'sonnet',
  mcpUrl: 'http://127.0.0.1:4317/mcp/tok_abc',
  extraMcpServers: { playwright: { command: 'npx', args: ['@playwright/mcp@0.0.41'] } },
  cwd: '/tmp/bif-run',
};

const parseAll = (lines: string[]): RunEvent[] => {
  const a = new ClaudeAdapter();
  return lines.flatMap((l) => a.parseLine(l));
};

describe('ClaudeAdapter', () => {
  it('buildCommand includes --strict-mcp-config and writes mcp file with bif url', () => {
    const { cmd, args, files } = new ClaudeAdapter().buildCommand(spec);
    expect(cmd).toBe('claude');
    expect(args).toContain('--strict-mcp-config');
    expect(args).toContain('--dangerously-skip-permissions');
    expect(args.slice(0, 2)).toEqual(['-p', 'Walk the signup flow']);
    const at = (flag: string) => args[args.indexOf(flag) + 1];
    expect(at('--output-format')).toBe('stream-json');
    expect(args).toContain('--verbose');
    expect(at('--model')).toBe('sonnet');
    expect(at('--append-system-prompt')).toBe('You are a research worker.');
    const mcpPath = at('--mcp-config');
    expect(mcpPath).toBe(join('/tmp/bif-run', '.bif-mcp.json'));
    expect(files).toHaveLength(1);
    expect(files[0]!.path).toBe(mcpPath);
    const mcp = JSON.parse(files[0]!.content);
    expect(mcp.mcpServers.bif).toEqual({ type: 'http', url: spec.mcpUrl });
    expect(mcp.mcpServers.playwright).toEqual(spec.extraMcpServers.playwright);
  });

  it('honors a custom command and guards a dash-leading prompt', () => {
    const { cmd, args } = new ClaudeAdapter('/opt/claude').buildCommand({ ...spec, prompt: '-x' });
    expect(cmd).toBe('/opt/claude');
    expect(args[1]!.startsWith('-')).toBe(false);
    const sys = new ClaudeAdapter().buildCommand({ ...spec, systemPrompt: '--evil' }).args;
    expect(sys[sys.indexOf('--append-system-prompt') + 1]!.startsWith('-')).toBe(false);
  });

  it('parseLine fixture yields message, tool_call(save_finding), done(0)', () => {
    const lines = readFileSync(join(import.meta.dirname, '../../fixtures/claude-stream.jsonl'), 'utf8')
      .split('\n')
      .filter(Boolean);
    const events = parseAll(lines);
    expect(events).toContainEqual({ t: 'message', text: 'done' });
    expect(events).toContainEqual({
      t: 'tool_call',
      name: 'save_finding',
      input: { claim: 'Acme hides pricing', subject: 'Acme', evidence: ['art_1'] },
    });
    expect(events).toContainEqual({ t: 'tool_result', name: 'save_finding', ok: true });
    const usage = events.find((e) => e.t === 'usage');
    expect(usage).toMatchObject({ t: 'usage', outputTokens: 253 });
    expect(events.at(-1)).toEqual({ t: 'done', exitCode: 0 });
    // the allowed rate_limit_event in the fixture must not be reported as an error
    expect(events.some((e) => e.t === 'error')).toBe(false);
  });

  it('rate limit line → error rateLimited true', () => {
    const a = new ClaudeAdapter();
    const rejected = JSON.stringify({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt: 1 } });
    expect(a.parseLine(rejected)).toEqual([expect.objectContaining({ t: 'error', rateLimited: true })]);
    const result = JSON.stringify({
      type: 'result', subtype: 'error_during_execution', is_error: true, api_error_status: 429,
      result: 'API Error: 429 rate_limit_error',
    });
    const ev = a.parseLine(result);
    expect(ev).toContainEqual(expect.objectContaining({ t: 'error', rateLimited: true }));
    expect(ev.at(-1)).toEqual({ t: 'done', exitCode: 1 });
    expect(a.parseLine('Claude AI usage limit reached|1794783600')).toEqual([
      expect.objectContaining({ t: 'error', rateLimited: true }),
    ]);
  });

  it('garbage line → []', () => {
    const a = new ClaudeAdapter();
    expect(a.parseLine('not json at all')).toEqual([]);
    expect(a.parseLine('')).toEqual([]);
    expect(a.parseLine('{"type":"system","subtype":"hook_started"}')).toEqual([]);
    expect(a.parseLine('[1,2]')).toEqual([]);
  });
});
