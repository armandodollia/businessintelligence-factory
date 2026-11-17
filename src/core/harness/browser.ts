import { spawn, type ChildProcess } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type { BifConfig } from '../config/schema.js';
import { runtimePaths } from '../runtime/paths.js';
import { childEnv, commandFor, groupAlive, isOurProcess, killTreeNow, signalTree, startTimeOf } from './platform.js';

/** MCP server name browser-using runs see the shared browser under (`mcp__browser__*` tools). */
export const SHARED_BROWSER_NAME = 'browser';

/** Directory for files the browser server writes (screenshots, PDFs): under the OS temp dir, so `save_artifact` accepts them. */
export const browserOutputDir = (): string => join(tmpdir(), 'bif-browser-output');

type BrowserCfg = Pick<BifConfig, 'browser'>;

function substitute(v: unknown, vars: Record<string, string>): unknown {
  if (typeof v === 'string') return Object.entries(vars).reduce((s, [k, x]) => s.split(`{{${k}}}`).join(x), v);
  if (Array.isArray(v)) return v.map((x) => substitute(x, vars));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, substitute(x, vars)]));
  return v;
}

/**
 * `per_run` mode: the MCP servers each browser-using run spawns itself, with every
 * `{{profileDir}}` replaced by the absolute dedicated research profile directory (never the
 * user's everyday browser profile). Backend `t3`: `{}`; agents use the T3 Code browser tools.
 */
export function browserMcpServers(cfg: BrowserCfg): Record<string, unknown> {
  if (cfg.browser.backend === 't3') return {};
  return substitute(cfg.browser.mcpServers, {
    profileDir: resolve(cfg.browser.profileDir),
    outputDir: browserOutputDir(),
  }) as Record<string, unknown>;
}

/** True when the config can give a run a browser (t3 backend, a shared server, or per-run servers). */
export function browserConfigured(cfg: BrowserCfg): boolean {
  const b = cfg.browser;
  if (b.backend === 't3') return true;
  if (b.mode === 'shared') return b.shared !== undefined;
  return Object.keys(b.mcpServers).length > 0;
}

/**
 * Concurrent browser-using runs actually allowed. `per_run` mode caps it at 1: every run would
 * launch its own browser on the same profile directory, and a profile can only be open once.
 */
export function effectiveMaxBrowserRuns(cfg: Pick<BifConfig, 'browser' | 'limits'>): number {
  const n = cfg.limits.maxBrowserRuns;
  return cfg.browser.backend === 'mcp' && cfg.browser.mode === 'per_run' ? Math.min(n, 1) : n;
}

/** Problems with the browser setup worth printing at startup. */
export function browserStartupWarnings(cfg: Pick<BifConfig, 'browser' | 'limits'>): string[] {
  const out: string[] = [];
  if (cfg.limits.maxBrowserRuns === 0) return out;
  if (!browserConfigured(cfg)) {
    out.push(
      cfg.browser.mode === 'shared'
        ? "browser.backend is 'mcp' in shared mode but browser.shared is not set: tasks that need a browser are rejected"
        : "browser.backend is 'mcp' but browser.mcpServers is empty: tasks that need a browser are rejected",
    );
  } else if (cfg.browser.backend === 'mcp' && cfg.browser.mode === 'per_run' && cfg.limits.maxBrowserRuns > 1) {
    out.push(
      `browser.mode is 'per_run': each run launches its own browser on the one research profile, so ` +
        `limits.maxBrowserRuns ${cfg.limits.maxBrowserRuns} is reduced to 1 (use mode 'shared' for parallel browsing)`,
    );
  }
  // Old configs list their browser server under mcpServers; in shared mode that is never used.
  if (cfg.browser.backend === 'mcp' && cfg.browser.mode === 'shared' && Object.keys(cfg.browser.mcpServers).length > 0) {
    out.push(
      "browser.mode is 'shared' but browser.mcpServers is set (old config?): mcpServers is ignored in shared mode; " +
        "configure the server under browser.shared, or set browser.mode to 'per_run' to keep using mcpServers",
    );
  }
  return out;
}

/** Browser instructions appended to the system prompt of browser-using runs. */
export function browserPromptNote(cfg: BrowserCfg): string {
  const common =
    'The browser uses a dedicated, persistent research profile that stays logged into accounts created ' +
    'for research. Other agents use the same browser at the same time: open a NEW tab for your work ' +
    'before navigating, work only in your own tab(s), never close or reuse tabs you did not open, and ' +
    'close your tabs when you are done.';
  if (cfg.browser.backend === 't3') {
    return `## Browser\nUse the T3 Code browser tools (not a browser MCP server) for all browsing. ${common}`;
  }
  const files =
    'To keep a screenshot as evidence, save it with `save_artifact` (file_path = the absolute path the browser ' +
    'tool reports, or content_base64) and a `description` of what is on screen that matters.';
  return `## Browser\nUse the browser MCP tools for all browsing. ${common}\n${files}`;
}

function freePort(): Promise<number> {
  return new Promise((ok, fail) => {
    const s = createServer();
    s.once('error', fail);
    s.listen(0, '127.0.0.1', () => {
      const addr = s.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      s.close(() => ok(port));
    });
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// --- the research browser shipped inside the packaged app (design 2026-11-16 §4.4) ----------------

type SharedCfg = NonNullable<BifConfig['browser']['shared']>;

/** The research browser shipped with the app: the command line script of `@playwright/mcp` and its version. */
export type ShippedBrowser = { cli: string; version: string };

/** Where the shipped script would be (absent in a checkout); fixed when the server starts. */
const SHIPPED_CLI = runtimePaths().resources.shippedBrowserCli;

/**
 * The research browser the app ships, when it does: `cli` exists and the `package.json` next to it
 * says its version. A checkout ships none (`runtimePaths`), so it starts the browser as it always did.
 */
export function shippedBrowser(cli: string | undefined = SHIPPED_CLI): ShippedBrowser | undefined {
  if (!cli || !existsSync(cli)) return undefined;
  try {
    const version = (JSON.parse(readFileSync(join(dirname(cli), 'package.json'), 'utf8')) as { version?: unknown }).version;
    return typeof version === 'string' ? { cli, version } : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The shared browser command to start. When the configured command is `npx [-y] @playwright/mcp@<v>`
 * and the app ships exactly that version, the shipped script is run with the current Node runtime
 * (`node`) and the same remaining arguments, so no npm is needed on the machine. Any other command,
 * package or version is the person's own choice and is returned unchanged.
 */
export function sharedBrowserCommand(shared: SharedCfg, shipped: ShippedBrowser | undefined = shippedBrowser(), node: string = process.execPath): SharedCfg {
  if (!shipped || shared.command !== 'npx') return shared;
  const rest = shared.args[0] === '-y' || shared.args[0] === '--yes' ? shared.args.slice(1) : shared.args;
  if (rest[0] !== `@playwright/mcp@${shipped.version}`) return shared;
  return { ...shared, command: node, args: [shipped.cli, ...rest.slice(1)] };
}
// --- end shipped research browser ------------------------------------------------------------------

export type SharedBrowserOptions = {
  config: BrowserCfg;
  /** Holds the server log and pid file (`<dataDir>/browser/`). */
  dataDir: string;
  /** How long to wait for the server to answer HTTP (npx may download first). Default 120 s. */
  startTimeoutMs?: number;
  /** The research browser shipped with the app; default `shippedBrowser()` (none in a checkout). */
  shipped?: ShippedBrowser;
};

/**
 * One browser MCP server shared by every browser-using run (`browser.mode: 'shared'`). Started
 * lazily by the first `ensure()`, in its own process group (so run reaping never kills it), and
 * restarted by the next `ensure()` if it died. A leftover server from a crashed harness (pid file)
 * is killed before starting, since it would hold the research profile.
 */
export class SharedBrowser {
  private starting: Promise<string> | null = null;
  private child: ChildProcess | null = null;
  /** Start time of `child` (finds what it started on Windows). */
  private childStartedAt: string | undefined;
  private readonly dir: string;
  private readonly onExit = () => this.killNow();

  constructor(private readonly opts: SharedBrowserOptions) {
    this.dir = join(resolve(opts.dataDir), 'browser');
  }

  /** Log file of the shared server (stdout and stderr). */
  get logPath(): string {
    return join(this.dir, 'shared-server.log');
  }

  private get pidPath(): string {
    return join(this.dir, 'shared-server.pid');
  }

  /** URL of the running server, starting it if needed. Rejects when it cannot be started. */
  ensure(): Promise<string> {
    if (!this.starting) {
      this.starting = this.start();
      this.starting.catch(() => (this.starting = null));
    }
    return this.starting;
  }

  /** MCP servers entry handed to a browser-using run. */
  async servers(): Promise<Record<string, unknown>> {
    return { [SHARED_BROWSER_NAME]: { type: 'http', url: await this.ensure() } };
  }

  private async start(): Promise<string> {
    const configured = this.opts.config.browser.shared;
    if (!configured) throw new Error('browser.shared is not configured');
    const shared = sharedBrowserCommand(configured, this.opts.shipped ?? shippedBrowser());
    mkdirSync(this.dir, { recursive: true });
    this.killStale();
    const port = shared.port || (await freePort());
    const profileDir = resolve(this.opts.config.browser.profileDir);
    const outputDir = browserOutputDir();
    mkdirSync(profileDir, { recursive: true });
    mkdirSync(outputDir, { recursive: true });
    const vars = { port: String(port), profileDir, outputDir };
    const args = substitute(shared.args, vars) as string[];
    const log = openSync(this.logPath, 'a');
    let child: ChildProcess;
    const spawnedAt = Date.now();
    try {
      const launch = commandFor(shared.command, args);
      // The shipped research browser runs on the server's own program, which in the desktop app needs
      // its run-as-Node variables: `childEnv` keeps them for that program and for no other command.
      const env = { ...childEnv(launch.cmd), ...(substitute(shared.env ?? {}, vars) as Record<string, string>) };
      // cwd = the output dir: files a client names without roots land there (OS temp dir, accepted by save_artifact).
      child = spawn(launch.cmd, launch.args, {
        cwd: outputDir, env, stdio: ['ignore', log, log], detached: process.platform !== 'win32', windowsHide: true,
        ...(launch.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
      });
    } finally {
      closeSync(log);
    }
    this.child = child;
    let exited: string | null = null;
    child.once('error', (e) => (exited = `spawn failed: ${e.message}`));
    child.once('exit', (code, signal) => {
      exited ??= `exited (${signal ?? code})`;
      if (this.child === child) {
        this.child = null;
        this.starting = null;
        process.off('exit', this.onExit);
        rmSync(this.pidPath, { force: true });
      }
    });
    if (child.pid !== undefined) {
      this.childStartedAt = startTimeOf(child.pid, spawnedAt);
      writeFileSync(this.pidPath, JSON.stringify({ pid: child.pid, startedAt: this.childStartedAt }));
      // A harness exit must not leave the browser (and its profile lock) behind.
      process.on('exit', this.onExit);
    }

    const url = `http://127.0.0.1:${port}${shared.path}`;
    const deadline = Date.now() + (this.opts.startTimeoutMs ?? 120_000);
    for (;;) {
      if (exited) throw new Error(`shared browser server ${exited}; see ${this.logPath}`);
      try {
        await fetch(url, { method: 'GET', signal: AbortSignal.timeout(2000) });
        return url; // any HTTP answer means it is listening
      } catch {
        // not up yet
      }
      if (Date.now() >= deadline) {
        this.killNow();
        throw new Error(`shared browser server did not answer on ${url} within ${this.opts.startTimeoutMs ?? 120_000} ms; see ${this.logPath}`);
      }
      await sleep(250);
    }
  }

  /** Kills a server left behind by a previous harness process (verified by pid start time). */
  private killStale(): void {
    if (!existsSync(this.pidPath)) return;
    try {
      const { pid, startedAt } = JSON.parse(readFileSync(this.pidPath, 'utf8')) as { pid: number; startedAt?: string };
      if (isOurProcess(pid, startedAt).ours) killTreeNow(pid, startedAt);
    } catch {
      // unreadable pid file or already gone
    }
    rmSync(this.pidPath, { force: true });
  }

  private killNow(): void {
    const pid = this.child?.pid;
    if (pid === undefined) return;
    try {
      killTreeNow(pid, this.childStartedAt);
    } catch {
      // already gone
    }
  }

  /** Stops the server (SIGTERM to its group, SIGKILL after `graceMs`). */
  async close(graceMs = 3000): Promise<void> {
    const child = this.child;
    this.starting = null;
    if (!child || child.pid === undefined) return;
    const pid = child.pid;
    const gone = () => (process.platform === 'win32' ? child.exitCode !== null || child.signalCode !== null : !groupAlive(pid));
    signalTree(pid, 'SIGTERM', child);
    const deadline = Date.now() + graceMs;
    while (!gone() && Date.now() < deadline) await sleep(25);
    if (!gone()) this.killNow();
    this.child = null;
    process.off('exit', this.onExit);
    rmSync(this.pidPath, { force: true });
  }
}

/**
 * MCP servers for a browser-using run: the shared server (started on demand), the per-run servers,
 * or none for the t3 backend.
 */
export async function browserServersFor(cfg: BrowserCfg, shared: SharedBrowser): Promise<Record<string, unknown>> {
  if (cfg.browser.backend === 't3') return {};
  if (cfg.browser.mode === 'shared') return shared.servers();
  return browserMcpServers(cfg);
}
