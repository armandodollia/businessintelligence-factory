import { join } from 'node:path';
import {
  harnessToolName,
  isRateLimitText,
  num,
  obj,
  parseJsonObject,
  plainLineEvents,
  safePositional,
  str,
  type BuiltCommand,
  type CliAdapter,
  type RunEvent,
  type SpawnSpec,
} from '../adapter.js';

export const CLAUDE_MCP_FILE = '.bif-mcp.json';

/**
 * `--tools` value of offline runs: the empty set, so no built-in tool at all (no web fetch or search, no
 * shell or other code-running tool, no remote agents or publishing). An allowlist, not a deny list, so a
 * future built-in is off too. MCP tools are not built-ins: the harness `bif` tools stay offered (checked
 * with a real haiku run, stakeholder task 2 fix round 2).
 */
export const CLAUDE_OFFLINE_TOOLS = '';

/**
 * Claude Code (`claude` 2.1.x) in print mode with stream-json output.
 *
 * Verified against `claude --help` (2.1.322): `-p/--print` is a boolean flag and the prompt is
 * the positional argument; `--mcp-config <configs...>` is variadic, so it is always followed by
 * another flag here. `--bare` is NOT used: it skips keychain reads and so breaks OAuth logins.
 * `MCP_TOOL_TIMEOUT` is raised so blocking harness tools (`request_approval`) do not time out.
 * Offline runs (`spec.offline`) add `--tools ""` (no built-in tools; variadic like `--mcp-config`,
 * so the empty value is one argument and is followed by another flag).
 * Effort (`spec.effort`): `--effort <level>` (help: "Effort level for the current session (low, medium,
 * high, xhigh, max)"); the level is passed as configured and the CLI judges it.
 */
export class ClaudeAdapter implements CliAdapter {
  readonly id = 'claude' as const;
  readonly offline = true;
  private readonly toolNames = new Map<string, string>();

  constructor(private readonly command = 'claude') {}

  buildCommand(spec: SpawnSpec): BuiltCommand {
    const mcpPath = join(spec.cwd, CLAUDE_MCP_FILE);
    const mcp = { mcpServers: { bif: { type: 'http', url: spec.mcpUrl }, ...spec.extraMcpServers } };
    return {
      cmd: this.command,
      args: [
        '-p', safePositional(spec.prompt),
        '--output-format', 'stream-json',
        '--verbose',
        '--model', spec.model,
        ...(spec.effort ? ['--effort', spec.effort] : []),
        '--mcp-config', mcpPath,
        '--strict-mcp-config',
        ...(spec.offline ? ['--tools', CLAUDE_OFFLINE_TOOLS] : []),
        '--append-system-prompt', safePositional(spec.systemPrompt),
        '--dangerously-skip-permissions',
      ],
      files: [{ path: mcpPath, content: JSON.stringify(mcp, null, 2) }],
      env: { MCP_TOOL_TIMEOUT: String(24 * 60 * 60 * 1000) },
    };
  }

  parseLine(line: string): RunEvent[] {
    const d = parseJsonObject(line);
    if (!d) return plainLineEvents(line);
    switch (d.type) {
      case 'assistant':
        return this.assistant(d);
      case 'user':
        return this.toolResults(d);
      case 'result':
        return this.result(d);
      case 'rate_limit_event': {
        // Emitted on every turn with status 'allowed'; only a rejection is an error.
        const info = obj(d.rate_limit_info);
        const status = str(info?.status);
        if (status !== 'rejected') return [];
        return [{ t: 'error', message: `rate limited (${str(info?.rateLimitType) ?? 'unknown window'})`, rateLimited: true }];
      }
      default:
        return [];
    }
  }

  private assistant(d: Record<string, unknown>): RunEvent[] {
    const out: RunEvent[] = [];
    const msg = obj(d.message);
    const content = Array.isArray(msg?.content) ? msg.content : [];
    for (const b of content) {
      const block = obj(b);
      if (!block) continue;
      if (block.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
        out.push({ t: 'message', text: block.text });
      } else if (block.type === 'tool_use' && typeof block.name === 'string') {
        const name = harnessToolName(block.name);
        if (typeof block.id === 'string') this.toolNames.set(block.id, name);
        out.push({ t: 'tool_call', name, input: block.input ?? {} });
      }
    }
    // The SDK marks failed assistant turns with `error` (e.g. 'rate_limit').
    const err = str(d.error);
    if (err) {
      const text = out.map((e) => (e.t === 'message' ? e.text : '')).join(' ');
      out.push({ t: 'error', message: `${err}${text ? `: ${text}` : ''}`, rateLimited: err === 'rate_limit' || isRateLimitText(text) });
    }
    return out;
  }

  private toolResults(d: Record<string, unknown>): RunEvent[] {
    const msg = obj(d.message);
    const content = Array.isArray(msg?.content) ? msg.content : [];
    const out: RunEvent[] = [];
    for (const b of content) {
      const block = obj(b);
      if (block?.type !== 'tool_result') continue;
      const id = str(block.tool_use_id) ?? '';
      out.push({ t: 'tool_result', name: this.toolNames.get(id) ?? id, ok: block.is_error !== true });
    }
    return out;
  }

  private result(d: Record<string, unknown>): RunEvent[] {
    const out: RunEvent[] = [];
    const u = obj(d.usage);
    if (u) {
      const input = [u.input_tokens, u.cache_creation_input_tokens, u.cache_read_input_tokens]
        .map(num)
        .reduce<number | undefined>((acc, v) => (v === undefined ? acc : (acc ?? 0) + v), undefined);
      const ev: RunEvent = { t: 'usage' };
      if (input !== undefined) ev.inputTokens = input;
      const output = num(u.output_tokens);
      if (output !== undefined) ev.outputTokens = output;
      const cost = num(d.total_cost_usd);
      if (cost !== undefined) ev.costUsd = cost;
      const cacheRead = num(u.cache_read_input_tokens);
      if (cacheRead !== undefined) ev.cacheReadTokens = cacheRead;
      const cacheWrite = num(u.cache_creation_input_tokens);
      if (cacheWrite !== undefined) ev.cacheWriteTokens = cacheWrite;
      out.push(ev);
    }
    const isError = d.is_error === true || (typeof d.subtype === 'string' && d.subtype !== 'success');
    if (isError) {
      const message = str(d.result) ?? (Array.isArray(d.errors) ? d.errors.join('; ') : str(d.subtype) ?? 'error');
      const rateLimited = d.api_error_status === 429 || isRateLimitText(message);
      out.push({ t: 'error', message, rateLimited });
    }
    out.push({ t: 'done', exitCode: isError ? 1 : 0 });
    return out;
  }
}
