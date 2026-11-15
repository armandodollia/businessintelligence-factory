import type { ProviderId } from '../types.js';

/**
 * Normalized event emitted by every CLI adapter. `usage.costUsd` is an addition to the spec'd
 * shape, filled when the CLI reports cost (Claude Code does). `usage.inputTokens` is the total
 * input including cache reads/writes; `cacheReadTokens` / `cacheWriteTokens` (WP-B) break out the
 * cached part when the CLI reports it (uncached input = inputTokens − both).
 */
export type RunEvent =
  | { t: 'message'; text: string }
  | { t: 'tool_call'; name: string; input: unknown }
  | { t: 'tool_result'; name: string; ok: boolean }
  | { t: 'usage'; inputTokens?: number; outputTokens?: number; costUsd?: number; cacheReadTokens?: number; cacheWriteTokens?: number }
  | { t: 'error'; message: string; rateLimited: boolean }
  | { t: 'done'; exitCode: number };

export type SpawnSpec = {
  prompt: string;
  systemPrompt: string;
  model: string;
  /** Harness MCP endpoint for this run (`<base>/mcp/<token>`). */
  mcpUrl: string;
  /**
   * The same endpoint without the token in the URL (`<base>/mcp`, token sent as
   * `Authorization: Bearer`), for CLIs that would otherwise get the URL on their command line.
   */
  mcpBearer?: { url: string; token: string };
  /**
   * Absolute directory for isolated CLI state (e.g. a dedicated CODEX_HOME), so runs never load
   * the user's own MCP servers, plugins or hooks. Omitted: the CLI's normal home is used.
   */
  stateDir?: string;
  /** Extra MCP servers (e.g. browser), in Claude Code `mcpServers` entry format. */
  extraMcpServers: Record<string, unknown>;
  cwd: string;
  env?: Record<string, string>;
  /**
   * Offline run (stakeholder design §6, §16: own stakeholder research): the agent must not reach the
   * web. The adapter denies the CLI's own web fetch, web search and shell in the command it builds; only
   * the harness MCP server (and none other) stays reachable. An adapter with `offline: false` cannot
   * enforce this and refuses (the supervisor fails such a run before start).
   */
  offline?: boolean;
};

export type BuiltCommand = {
  cmd: string;
  args: string[];
  /** Files the supervisor must write (absolute paths) before spawning. */
  files: Array<{ path: string; content: string }>;
  /** Extra environment variables for the subprocess (merged under `SpawnSpec.env`). */
  env?: Record<string, string>;
  /** Symlinks the supervisor creates before spawning (`path` → `target`; copied where links fail). */
  links?: Array<{ path: string; target: string }>;
};

/**
 * One adapter per CLI. Instances may keep per-run parse state (e.g. tool-use id → name), so
 * create a fresh instance per run via `getAdapter`.
 */
export interface CliAdapter {
  id: ProviderId;
  /** Whether `buildCommand` enforces `SpawnSpec.offline`; when false, offline runs are refused. */
  readonly offline: boolean;
  buildCommand(spec: SpawnSpec): BuiltCommand;
  /** Parses one stdout line. Unknown or malformed lines yield `[]`. */
  parseLine(line: string): RunEvent[];
}

/** Bound tool-calling client handed to in-process fake agents. */
export type ToolClient = { call(name: string, input: unknown): Promise<unknown> };

/** In-process agent used by tests / the supervisor's fake mode instead of a CLI subprocess. */
export type FakeScript = (tools: ToolClient) => Promise<void>;

/** Reason an offline run is refused on a provider whose adapter cannot enforce offline. */
export const offlineRefusal = (provider: ProviderId) => `provider '${provider}' cannot run offline tasks`;

// ---------------------------------------------------------------------------
// helpers shared by adapters

const RATE_LIMIT_RE = /rate[ _-]?limit|\b429\b|usage limit|too many requests|quota exceeded/i;

/** True when `text` looks like a provider rate-limit / usage-limit error. */
export function isRateLimitText(text: string): boolean {
  return RATE_LIMIT_RE.test(text);
}

/** Parses a JSON object line; returns null for blank, non-JSON or non-object lines. */
export function parseJsonObject(line: string): Record<string, unknown> | null {
  const s = line.trim();
  if (!s.startsWith('{')) return null;
  try {
    const v: unknown = JSON.parse(s);
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * For non-JSON output lines (stderr, plain text): rate-limit text → error event, else nothing.
 */
export function plainLineEvents(line: string): RunEvent[] {
  const s = line.trim();
  if (!s || !isRateLimitText(s)) return [];
  return [{ t: 'error', message: s.slice(0, 2000), rateLimited: true }];
}

/** Commander/yargs/clap treat a dash-leading positional as an option; keep prompts positional. */
export function safePositional(text: string): string {
  return text.startsWith('-') ? `\n${text}` : text;
}

/** Wraps the system prompt for CLIs without a system-prompt flag. */
export function withSystemBlock(systemPrompt: string, prompt: string): string {
  return systemPrompt.trim() ? `<system>\n${systemPrompt}\n</system>\n\n${prompt}` : prompt;
}

/** Strips the harness server prefix from MCP tool names (`mcp__bif__save_finding` → `save_finding`). */
export function harnessToolName(name: string): string {
  return name.startsWith('mcp__bif__') ? name.slice('mcp__bif__'.length) : name;
}

export const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
export const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
export const obj = (v: unknown): Record<string, unknown> | undefined =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
