import { join } from 'node:path';
import {
  isRateLimitText,
  num,
  obj,
  parseJsonObject,
  plainLineEvents,
  safePositional,
  str,
  withSystemBlock,
  type BuiltCommand,
  type CliAdapter,
  type RunEvent,
  type SpawnSpec,
} from '../adapter.js';

export const OPENCODE_CONFIG_FILE = '.bif-opencode.json';

/**
 * Permission of offline runs: every tool denied except the harness MCP tools (`bif_*`). OpenCode
 * merges the config's `permission` last into every agent's rules (subagents included) and drops a tool
 * whose last matching rule is `deny` for pattern `*`, so web fetch, web search, code search, shell and
 * subagents are not offered at all.
 */
export const OPENCODE_OFFLINE_PERMISSION = { '*': 'deny', 'bif_*': 'allow' } as const;

/** OpenCode's MCP request timeout defaults to 5 s and also bounds tool calls. */
const BIF_TIMEOUT_MS = 86_400_000;

/**
 * Converts a Claude-format MCP server entry to OpenCode's strict `McpLocal`/`McpRemote` shape.
 * Unknown shapes are passed through unchanged.
 */
function toOpenCodeMcp(server: unknown): unknown {
  const s = obj(server);
  if (!s) return server;
  if (s.type === 'local' || s.type === 'remote') return s;
  if (typeof s.command === 'string') {
    const out: Record<string, unknown> = {
      type: 'local',
      command: [s.command, ...(Array.isArray(s.args) ? s.args.map(String) : [])],
    };
    if (obj(s.env)) out.environment = s.env;
    out.enabled = true;
    return out;
  }
  if (typeof s.url === 'string') {
    const out: Record<string, unknown> = { type: 'remote', url: s.url };
    if (obj(s.headers)) out.headers = s.headers;
    out.enabled = true;
    return out;
  }
  return s;
}

/**
 * OpenCode CLI (`opencode run`, 1.2.x) with `--format json` events.
 *
 * Verified against `opencode run --help` (1.2.27) and the event emitter in its bundled source:
 * - Flags: `--format json`, `-m provider/model`, prompt as positional `message..`. There is no
 *   system-prompt flag, so the system prompt is prepended in a `<system>` block.
 * - MCP comes from a generated `.bif-opencode.json` in the run's cwd, passed as `OPENCODE_CONFIG`;
 *   `OPENCODE_DISABLE_PROJECT_CONFIG=1` skips project files found walking up from the cwd, and with
 *   `spec.stateDir` the global config dir is redirected (`XDG_CONFIG_HOME=<stateDir>/opencode-config`),
 *   so the user's own MCP servers are not loaded (auth lives in the data dir, which is unchanged).
 *   MCP tools are exposed as `<server>_<tool>`. The token stays in that file, not in argv.
 *   `timeout` (default 5000 ms) bounds tool calls, so bif gets 24 h; `oauth: false` skips
 *   OAuth discovery.
 * - Events: `{type, timestamp, sessionID, part|error}` with type `text` | `tool_use` |
 *   `step_start` | `step_finish` | `reasoning` | `error`. There is no terminal event: the CLI
 *   exits when the session goes idle, and it exits 0 even after an `error` — so `error` maps to
 *   error + done(1). Permission prompts are auto-rejected in `run` mode.
 * - Effort (`spec.effort`): `--variant <level>` (help: "model variant (provider-specific reasoning
 *   effort, e.g., high, max, minimal)"). The level is passed as configured; which levels exist depends
 *   on the model's provider.
 * - Withheld MCP tools (`spec.withheldTools`): `permission: { "<server>_<tool>": "deny" }` by the same
 *   rule (not checked with a live OpenCode run).
 * - Offline runs (`spec.offline`): `permission: OPENCODE_OFFLINE_PERMISSION` in the generated config
 *   (rule order and merge checked in the 1.2.27 bundle: `PermissionNext.fromConfig`, `disabled`,
 *   agent rules = defaults, agent rules, then the config's rules).
 */
export class OpenCodeAdapter implements CliAdapter {
  readonly id = 'opencode' as const;
  readonly offline = true;
  private failed = false;

  constructor(private readonly command = 'opencode') {}

  buildCommand(spec: SpawnSpec): BuiltCommand {
    const mcp: Record<string, unknown> = {
      bif: { type: 'remote', url: spec.mcpUrl, enabled: true, oauth: false, timeout: BIF_TIMEOUT_MS },
    };
    for (const [name, server] of Object.entries(spec.extraMcpServers)) mcp[name] = toOpenCodeMcp(server);
    // Withheld MCP tools: a `deny` rule on `<server>_<tool>`, after the offline rules (last match wins).
    const withheld = Object.entries(spec.withheldTools ?? {}).flatMap(([server, tools]) => tools.map((t): [string, string] => [`${server}_${t}`, 'deny']));
    const permission = { ...(spec.offline ? OPENCODE_OFFLINE_PERMISSION : {}), ...Object.fromEntries(withheld) };
    const config = {
      $schema: 'https://opencode.ai/config.json',
      mcp,
      ...(Object.keys(permission).length ? { permission } : {}),
    };
    const path = join(spec.cwd, OPENCODE_CONFIG_FILE);
    const env: Record<string, string> = { OPENCODE_CONFIG: path, OPENCODE_DISABLE_PROJECT_CONFIG: '1' };
    if (spec.stateDir) env.XDG_CONFIG_HOME = join(spec.stateDir, 'opencode-config');
    return {
      cmd: this.command,
      args: [
        'run', '--format', 'json',
        '-m', spec.model,
        ...(spec.effort ? ['--variant', spec.effort] : []),
        safePositional(withSystemBlock(spec.systemPrompt, spec.prompt)),
      ],
      files: [{ path, content: JSON.stringify(config, null, 2) }],
      env,
    };
  }

  parseLine(line: string): RunEvent[] {
    const d = parseJsonObject(line);
    if (!d) return plainLineEvents(line);
    const part = obj(d.part);
    switch (d.type) {
      case 'text': {
        const text = str(part?.text)?.trim();
        return text ? [{ t: 'message', text }] : [];
      }
      case 'tool_use': {
        const raw = str(part?.tool) ?? '';
        const name = raw.startsWith('bif_') ? raw.slice(4) : raw;
        const state = obj(part?.state);
        return [
          { t: 'tool_call', name, input: state?.input ?? {} },
          { t: 'tool_result', name, ok: state?.status === 'completed' },
        ];
      }
      case 'step_finish': {
        const tokens = obj(part?.tokens);
        const cache = obj(tokens?.cache);
        const ev: RunEvent = { t: 'usage' };
        const input = num(tokens?.input);
        if (input !== undefined) ev.inputTokens = input + (num(cache?.read) ?? 0) + (num(cache?.write) ?? 0);
        const output = num(tokens?.output);
        if (output !== undefined) ev.outputTokens = output;
        const cost = num(part?.cost);
        if (cost !== undefined) ev.costUsd = cost;
        const cacheRead = num(cache?.read);
        if (cacheRead !== undefined) ev.cacheReadTokens = cacheRead;
        const cacheWrite = num(cache?.write);
        if (cacheWrite !== undefined) ev.cacheWriteTokens = cacheWrite;
        const out: RunEvent[] = [ev];
        if (part?.reason !== 'tool-calls' && !this.failed) out.push({ t: 'done', exitCode: 0 });
        return out;
      }
      case 'error': {
        const err = obj(d.error);
        const data = obj(err?.data);
        const message = str(data?.message) ?? str(err?.name) ?? 'error';
        this.failed = true;
        return [
          { t: 'error', message, rateLimited: data?.statusCode === 429 || isRateLimitText(message) },
          { t: 'done', exitCode: 1 },
        ];
      }
      default:
        return [];
    }
  }
}
