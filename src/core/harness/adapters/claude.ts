import { join } from 'node:path';
import { removeClaudeRunLeftovers, type RunTrace } from '../cliLeftovers.js';
import { noteCliChange } from '../cliNotices.js';
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
 * Built-in tools no headless BIF run can use, denied in every run that is not offline with `--disallowedTools`
 * (help: "Comma or space-separated list of tool names to deny"; checked with 2.1.325: a denied tool is absent
 * from the init event's tool list, and a name the CLI does not know is ignored). A deny list, not an allowlist:
 * if a later release renames one of these, it is simply offered again (it costs tokens and loses nothing),
 * while a renamed tool a run needs is never lost. Claude Code 2.1.325 offered 29 built-ins:
 * - scheduling and waking later: CronCreate, CronDelete, CronList, ScheduleWakeup (a run ends when it is done);
 * - telling the person or another session: PushNotification, RemoteTrigger, ListAgents, SendMessage (a run has no
 *   teammates; it asks the person through BIF's own request tools);
 * - publishing to claude.ai: Artifact, ArtifactComments, ArtifactData, DesignSync (evidence goes to `save_artifact`);
 * - code work: EnterWorktree, ExitWorktree, NotebookEdit, LSP, ReportFindings (code-review findings for the CLI's
 *   host; BIF findings go to `save_finding`);
 * - Workflow (scripted multi-agent workflows that a person opts into);
 * - Skill: it has no use in a headless run and would bring the person's own skills into a BIF run.
 */
export const CLAUDE_REMOVED_TOOLS = [
  'CronCreate', 'CronDelete', 'CronList', 'ScheduleWakeup',
  'PushNotification', 'RemoteTrigger', 'ListAgents', 'SendMessage',
  'Artifact', 'ArtifactComments', 'ArtifactData', 'DesignSync',
  'EnterWorktree', 'ExitWorktree', 'NotebookEdit', 'LSP', 'ReportFindings',
  'Workflow', 'Skill',
] as const;

/**
 * The other 10 built-ins of 2.1.325, offered on purpose: files and shell (Read, Write, Edit, Bash; a run needed
 * Read and Bash to reach a page snapshot too large to return inline), the web (WebFetch, WebSearch), ToolSearch
 * (it loads the deferred MCP tool schemas: without it they are sent in full), and the ones that may help: Task
 * (sub-agents), Monitor and TaskStop (watching and stopping a background command).
 */
export const CLAUDE_OFFERED_TOOLS = ['Bash', 'Read', 'Write', 'Edit', 'WebFetch', 'WebSearch', 'ToolSearch', 'Task', 'Monitor', 'TaskStop'] as const;

/** Built-ins BIF's runs rely on: a release that no longer offers one of them is reported. */
export const CLAUDE_EXPECTED_TOOLS = ['Read', 'Bash', 'ToolSearch', 'WebFetch', 'WebSearch'] as const;

/**
 * What changed in the built-in tools a Claude Code release offers (`tools` of its init event, MCP tools
 * included): built-ins that are neither removed nor known to be offered (`unsorted`), and expected ones that
 * are not offered (`missing`). Undefined when nothing changed.
 */
export function builtinToolChange(offered: readonly string[]): { unsorted: string[]; missing: string[] } | undefined {
  const builtins = offered.filter((t) => !t.startsWith('mcp__'));
  const known = new Set<string>([...CLAUDE_REMOVED_TOOLS, ...CLAUDE_OFFERED_TOOLS]);
  const unsorted = builtins.filter((t) => !known.has(t)).sort();
  const missing = CLAUDE_EXPECTED_TOOLS.filter((t) => !builtins.includes(t));
  return unsorted.length || missing.length ? { unsorted, missing } : undefined;
}

/**
 * Claude Code (`claude` 2.1.x) in print mode with stream-json output.
 *
 * Verified against `claude --help` (2.1.322): `-p/--print` is a boolean flag and the prompt is
 * the positional argument; `--mcp-config <configs...>` is variadic, so it is always followed by
 * another flag here. `--bare` is NOT used: it skips keychain reads and so breaks OAuth logins.
 * `MCP_TOOL_TIMEOUT` is raised so blocking harness tools (`request_approval`) do not time out.
 * Built-in tools: `--disallowedTools` with `CLAUDE_REMOVED_TOOLS` (and the withheld MCP tools, below), or
 * `--tools ""` (none) for offline runs (`spec.offline`); both variadic like `--mcp-config`, so the value is one
 * comma-joined argument followed by another flag. The init event's tool list is checked against the lists
 * above (`builtinToolChange`): a change is reported once per server start (`noteCliChange`), never failing the run.
 * `--no-session-persistence` (help: "Disable session persistence - sessions will not be saved to disk and
 * cannot be resumed (only works with --print)"): no transcript in the person's Claude folder, and results too
 * large to return inline are written there only while the run lasts (checked with 2.1.325: the agent can
 * still read the file during the run; it is gone when the CLI exits). BIF never resumes a CLI session: a
 * retry starts a new one with what the run already did (`priorAttemptSection`).
 * `--session-id <uuid>` (help: "Use a specific session ID for the conversation (must be a valid UUID)") with
 * `spec.sessionId`: what a run still leaves in the person's Claude folder and the temp root (empty folders, and
 * after a kill its oversized results and shell output) is found by it and by the cwd and removed when the
 * attempt ends, however it ended (`removeRunLeftovers`, `removeClaudeRunLeftovers`).
 * Withheld MCP tools (`spec.withheldTools`): added to `--disallowedTools` as `mcp__<server>__<tool>`. A denied
 * tool is not offered at all (checked with 2.1.325: absent from the init event's tool list).
 * Effort (`spec.effort`): `--effort <level>` (help: "Effort level for the current session (low, medium,
 * high, xhigh, max)"); the level is passed as configured and the CLI judges it.
 */
export class ClaudeAdapter implements CliAdapter {
  readonly id = 'claude' as const;
  readonly offline = true;
  private readonly toolNames = new Map<string, string>();
  /** Set by `buildCommand`: an offline run is offered no built-in on purpose. */
  private offlineRun = false;

  constructor(private readonly command = 'claude') {}

  buildCommand(spec: SpawnSpec): BuiltCommand {
    const mcpPath = join(spec.cwd, CLAUDE_MCP_FILE);
    const mcp = { mcpServers: { bif: { type: 'http', url: spec.mcpUrl }, ...spec.extraMcpServers } };
    const withheld = Object.entries(spec.withheldTools ?? {}).flatMap(([server, tools]) => tools.map((t) => `mcp__${server}__${t}`));
    const denied = spec.offline ? withheld : [...CLAUDE_REMOVED_TOOLS, ...withheld];
    this.offlineRun = spec.offline === true;
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
        '--no-session-persistence',
        ...(spec.sessionId ? ['--session-id', spec.sessionId] : []),
        ...(denied.length ? ['--disallowedTools', denied.join(',')] : []),
        ...(spec.offline ? ['--tools', CLAUDE_OFFLINE_TOOLS] : []),
        '--append-system-prompt', safePositional(spec.systemPrompt),
        '--dangerously-skip-permissions',
      ],
      files: [{ path: mcpPath, content: JSON.stringify(mcp, null, 2) }],
      env: { MCP_TOOL_TIMEOUT: String(24 * 60 * 60 * 1000) },
    };
  }

  removeRunLeftovers(run: RunTrace): void {
    removeClaudeRunLeftovers(run);
  }

  parseLine(line: string): RunEvent[] {
    const d = parseJsonObject(line);
    if (!d) return plainLineEvents(line);
    switch (d.type) {
      case 'system':
        if (d.subtype === 'init' && Array.isArray(d.tools) && !this.offlineRun) this.checkBuiltins(d);
        return [];
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

  /** Reports a change in the built-in tools this CLI offers (once per server start); the run goes on. */
  private checkBuiltins(init: Record<string, unknown>): void {
    const change = builtinToolChange((init.tools as unknown[]).map(String));
    if (!change) return;
    const version = str(init.claude_code_version) ?? 'unknown version';
    const parts = [
      change.unsorted.length ? `offers built-in tools BIF has not sorted, offered to every run until they are: ${change.unsorted.join(', ')}` : '',
      change.missing.length ? `no longer offers built-in tools BIF's runs rely on: ${change.missing.join(', ')}` : '',
    ].filter(Boolean);
    noteCliChange(`Claude Code ${version} ${parts.join('; and ')} (see CLAUDE_REMOVED_TOOLS in src/core/harness/adapters/claude.ts).`);
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
