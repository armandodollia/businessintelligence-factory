import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { RunEvent, SpawnSpec } from '../../../src/core/harness/adapter.js';
import {
  builtinToolChange, CLAUDE_EXPECTED_TOOLS, CLAUDE_OFFERED_TOOLS, CLAUDE_OFFLINE_TOOLS, CLAUDE_REMOVED_TOOLS, ClaudeAdapter,
} from '../../../src/core/harness/adapters/claude.js';
import { cliNotices } from '../../../src/core/harness/cliNotices.js';

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

  it('built-in tools: the unusable ones are named and denied (a renamed one comes back), offline runs still get none', () => {
    const { args } = new ClaudeAdapter().buildCommand(spec);
    // No allowlist: a tool a later release renames or adds stays offered.
    expect(args).not.toContain('--tools');
    expect(args.filter((a) => a === '--disallowedTools')).toHaveLength(1);
    const at = args.indexOf('--disallowedTools');
    expect(args[at + 1]).toBe(CLAUDE_REMOVED_TOOLS.join(','));
    expect(args[at + 2]!.startsWith('--')).toBe(true); // variadic: another flag follows
    expect([...CLAUDE_REMOVED_TOOLS].sort()).toEqual([
      'Artifact', 'ArtifactComments', 'ArtifactData', 'CronCreate', 'CronDelete', 'CronList', 'DesignSync', 'EnterWorktree',
      'ExitWorktree', 'LSP', 'ListAgents', 'NotebookEdit', 'PushNotification', 'RemoteTrigger', 'ReportFindings',
      'ScheduleWakeup', 'SendMessage', 'Skill', 'Workflow',
    ]);
    expect([...CLAUDE_OFFERED_TOOLS].sort()).toEqual(['Bash', 'Edit', 'Monitor', 'Read', 'Task', 'TaskStop', 'ToolSearch', 'WebFetch', 'WebSearch', 'Write']);
    // 29 built-ins of 2.1.325, each sorted once.
    expect(new Set([...CLAUDE_REMOVED_TOOLS, ...CLAUDE_OFFERED_TOOLS]).size).toBe(29);
    for (const t of CLAUDE_EXPECTED_TOOLS) expect(CLAUDE_OFFERED_TOOLS).toContain(t);
    const offline = new ClaudeAdapter().buildCommand({ ...spec, offline: true }).args;
    expect(offline.filter((a) => a === '--tools')).toHaveLength(1);
    expect(offline[offline.indexOf('--tools') + 1]).toBe(CLAUDE_OFFLINE_TOOLS);
    expect(offline).not.toContain('--disallowedTools');
  });

  it('a built-in BIF has not sorted, or a missing one a run relies on, is reported once per server start; the run goes on', () => {
    const init = (tools: string[]) => JSON.stringify({ type: 'system', subtype: 'init', claude_code_version: '9.9.9', tools });
    const today = [...CLAUDE_OFFERED_TOOLS, 'mcp__bif__save_finding', 'mcp__browser__browser_tabs'];
    expect(builtinToolChange(today)).toBeUndefined();
    const changed = builtinToolChange(['Agent', 'Bash', 'Read', 'Teleport', 'ToolSearch', 'WebFetch', 'mcp__bif__save_finding']);
    expect(changed).toEqual({ unsorted: ['Agent', 'Teleport'], missing: ['WebSearch'] });

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const a = new ClaudeAdapter();
      a.buildCommand(spec);
      expect(a.parseLine(init(['Agent', 'Bash', 'Read', 'ToolSearch', 'WebFetch']))).toEqual([]);
      // A second run of the same server: no second warning for the same change.
      const b = new ClaudeAdapter();
      b.buildCommand(spec);
      b.parseLine(init(['Agent', 'Bash', 'Read', 'ToolSearch', 'WebFetch']));
      const notes = cliNotices().filter((n) => n.includes('9.9.9'));
      expect(notes).toHaveLength(1);
      expect(notes[0]).toContain('Agent');
      expect(notes[0]).toContain('WebSearch');
      expect(warn.mock.calls.filter((c) => String(c[0]).includes('9.9.9'))).toHaveLength(1);
      // An offline run is offered no built-in on purpose: nothing to report.
      const off = new ClaudeAdapter();
      off.buildCommand({ ...spec, offline: true });
      off.parseLine(init(['mcp__bif__save_persona']).replace('9.9.9', '9.9.8'));
      expect(cliNotices().some((n) => n.includes('9.9.8'))).toBe(false);
    } finally {
      warn.mockRestore();
    }
  });

  it('no session persistence: no transcript and no oversized-result copies kept in the person\'s Claude folder', () => {
    for (const s of [spec, { ...spec, offline: true }]) {
      expect(new ClaudeAdapter().buildCommand(s).args).toContain('--no-session-persistence');
    }
  });

  it('session id: --session-id <uuid> when the run has one (its leftovers are found by it); none otherwise', () => {
    expect(new ClaudeAdapter().buildCommand(spec).args).not.toContain('--session-id');
    const args = new ClaudeAdapter().buildCommand({ ...spec, sessionId: '8d79edb1-3eab-447b-97f5-1a3924ecf8ca' }).args;
    expect(args[args.indexOf('--session-id') + 1]).toBe('8d79edb1-3eab-447b-97f5-1a3924ecf8ca');
  });

  it('withheld MCP tools: --disallowedTools mcp__<server>__<tool>, followed by another flag (the option is variadic)', () => {
    const args = new ClaudeAdapter().buildCommand({ ...spec, withheldTools: { browser: ['browser_close'] } }).args;
    expect(args.filter((a) => a === '--disallowedTools')).toHaveLength(1);
    const at = args.indexOf('--disallowedTools');
    expect(args[at + 1]).toBe([...CLAUDE_REMOVED_TOOLS, 'mcp__browser__browser_close'].join(','));
    expect(args[at + 2]!.startsWith('--')).toBe(true);
  });

  it('effort: --effort <level> when the run has one; the same command as before when it has none', () => {
    const plain = new ClaudeAdapter().buildCommand(spec).args;
    expect(plain).not.toContain('--effort');
    const args = new ClaudeAdapter().buildCommand({ ...spec, effort: 'high' }).args;
    const at = args.indexOf('--effort');
    expect(args.slice(at, at + 2)).toEqual(['--effort', 'high']);
    expect(args.filter((_, i) => i !== at && i !== at + 1)).toEqual(plain);
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
    // WP-B: cache tokens split out (inputTokens stays the total input, cache included)
    expect(usage).toEqual({
      t: 'usage', inputTokens: 6 + 38856 + 76960, outputTokens: 253, cacheReadTokens: 76960, cacheWriteTokens: 38856,
      costUsd: 0.008798899999999998,
    });
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
