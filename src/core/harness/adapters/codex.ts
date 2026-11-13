import {
  isRateLimitText,
  num,
  obj,
  parseJsonObject,
  plainLineEvents,
  str,
  withSystemBlock,
  type BuiltCommand,
  type CliAdapter,
  type RunEvent,
  type SpawnSpec,
} from '../adapter.js';

/** Seconds Codex waits on one MCP tool call; blocking harness tools may wait for the user. */
const BIF_TOOL_TIMEOUT_SEC = 86_400;

const BARE_KEY = /^[A-Za-z0-9_-]+$/;
const tomlKey = (k: string) => (BARE_KEY.test(k) ? k : JSON.stringify(k));

/** Renders a JSON value as an inline TOML value (strings use JSON escaping, valid TOML basic strings). */
export function toToml(v: unknown): string {
  if (typeof v === 'string') return JSON.stringify(v);
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (Array.isArray(v)) return `[${v.map(toToml).join(', ')}]`;
  if (v && typeof v === 'object') {
    const entries = Object.entries(v as Record<string, unknown>).filter(([, x]) => x !== undefined && x !== null);
    return `{ ${entries.map(([k, x]) => `${tomlKey(k)} = ${toToml(x)}`).join(', ')} }`;
  }
  throw new Error(`cannot render ${String(v)} as TOML`);
}

/** Claude-format keys Codex does not understand (Codex infers transport from command/url). */
const DROP_KEYS = new Set(['type']);

/**
 * Codex CLI (`codex exec`, 0.167.x) with JSONL output.
 *
 * Verified against `codex exec --help` (0.167.2): `--json`, `-m`, `-s danger-full-access`,
 * `--skip-git-repo-check`, `-C <dir>`, `-c key=<toml>` all exist. There is no system-prompt flag,
 * so the system prompt is prepended in a `<system>` block. Additions to the brief:
 * `mcp_servers.bif.tool_timeout_sec` (default is 60 s, too short for `request_approval`) and `-C`.
 * Codex reads stdin when it is a pipe — the supervisor spawns with stdin ignored.
 */
export class CodexAdapter implements CliAdapter {
  readonly id = 'codex' as const;
  private readonly started = new Set<string>();

  constructor(private readonly command = 'codex') {}

  buildCommand(spec: SpawnSpec): BuiltCommand {
    const config: string[] = [
      `mcp_servers.bif.url=${toToml(spec.mcpUrl)}`,
      `mcp_servers.bif.tool_timeout_sec=${BIF_TOOL_TIMEOUT_SEC}`,
    ];
    for (const [name, server] of Object.entries(spec.extraMcpServers)) {
      const s = obj(server);
      if (!s) continue;
      for (const [key, value] of Object.entries(s)) {
        if (DROP_KEYS.has(key) || value === undefined || value === null) continue;
        config.push(`mcp_servers.${tomlKey(name)}.${tomlKey(key)}=${toToml(value)}`);
      }
    }
    return {
      cmd: this.command,
      args: [
        'exec', '--json',
        '-m', spec.model,
        '-s', 'danger-full-access',
        '--skip-git-repo-check',
        '-C', spec.cwd,
        ...config.flatMap((c) => ['-c', c]),
        withSystemBlock(spec.systemPrompt, spec.prompt),
      ],
      files: [],
    };
  }

  parseLine(line: string): RunEvent[] {
    const d = parseJsonObject(line);
    if (!d) return plainLineEvents(line);
    switch (d.type) {
      case 'item.started':
      case 'item.completed':
        return this.item(d.type, obj(d.item));
      case 'turn.completed': {
        const u = obj(d.usage);
        const ev: RunEvent = { t: 'usage' };
        const input = num(u?.input_tokens);
        const output = num(u?.output_tokens);
        if (input !== undefined) ev.inputTokens = input;
        if (output !== undefined) ev.outputTokens = output;
        return [ev, { t: 'done', exitCode: 0 }];
      }
      case 'turn.failed': {
        const message = str(obj(d.error)?.message) ?? 'turn failed';
        return [{ t: 'error', message, rateLimited: isRateLimitText(message) }, { t: 'done', exitCode: 1 }];
      }
      case 'error': {
        const message = str(d.message) ?? 'error';
        return [{ t: 'error', message, rateLimited: isRateLimitText(message) }];
      }
      default:
        return [];
    }
  }

  private item(phase: string, item: Record<string, unknown> | undefined): RunEvent[] {
    if (!item) return [];
    const id = str(item.id) ?? '';
    const completed = phase === 'item.completed';
    switch (item.type) {
      case 'agent_message': {
        const text = str(item.text)?.trim();
        return completed && text ? [{ t: 'message', text }] : [];
      }
      case 'mcp_tool_call': {
        const server = str(item.server) ?? '';
        const tool = str(item.tool) ?? '';
        const name = server === 'bif' ? tool : `mcp__${server}__${tool}`;
        const out: RunEvent[] = [];
        if (!this.started.has(id)) {
          this.started.add(id);
          out.push({ t: 'tool_call', name, input: item.arguments ?? {} });
        }
        if (completed) out.push({ t: 'tool_result', name, ok: item.status === 'completed' && !item.error });
        return out;
      }
      case 'command_execution': {
        const out: RunEvent[] = [];
        if (!this.started.has(id)) {
          this.started.add(id);
          out.push({ t: 'tool_call', name: 'shell', input: { command: item.command } });
        }
        if (completed) out.push({ t: 'tool_result', name: 'shell', ok: item.exit_code === 0 });
        return out;
      }
      case 'error': {
        if (!completed) return [];
        const message = str(item.message) ?? 'error';
        return [{ t: 'error', message, rateLimited: isRateLimitText(message) }];
      }
      default:
        return [];
    }
  }
}
