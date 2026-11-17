/**
 * The setup check (design 2026-11-16-desktop-app-and-feedback-bundle-design.md §4.3): which agent
 * CLIs are installed and signed in, whether Chrome is there for the research browser, and the
 * configuration that fits what was found. `npm run doctor` prints it; the app shows it on first run
 * and on the Settings page.
 *
 * What each check does, and what it cannot tell. No check starts a model conversation, and none reads
 * the content of a credential file.
 *
 * - **Found.** The configured command (`providers.<id>.command`) is looked up in the folders of
 *   `PATH`, then in the usual install folders of the platform (`usualDirs`). A command given as a
 *   path is taken as it is. On Windows a command is a file with an extension of `PATHEXT`.
 * - **Version.** `<command> --version`, the first `x.y.z` in what it prints. A command that is found
 *   but does not answer is reported with the reason (for example a script whose interpreter is not
 *   on `PATH`), never as missing.
 * - **Signed in: Claude Code.** `claude auth status --json`; only its `loggedIn` field is read (the
 *   account fields it prints are dropped). It cannot tell whether the service still accepts the
 *   login or whether the plan has usage left. A CLI without that command is `unknown`.
 * - **Signed in: Codex.** `codex login status` ("Logged in using …" / "Not logged in"). The runs of
 *   this app read the login from `auth.json` in the Codex home (`CODEX_HOME` or `~/.codex`), so the
 *   check also looks whether that file exists (its content is not read). It cannot tell whether the
 *   login is still accepted.
 * - **Signed in: OpenCode.** `opencode auth list`, the count of stored credentials and of
 *   environment keys it lists. It cannot tell whether a credential is for the provider of the
 *   models configured, or still valid.
 * - **Chrome.** Whether the file exists where the research browser (Playwright's `chrome` channel)
 *   looks for it. It is not started.
 *
 * `unknown` is not a failure: such a CLI counts as usable, and the first run shows whether it is.
 *
 * **Whether research can start** (`withVerdict`) is judged against the configuration: every role
 * names a provider and a model, and research can start only when the CLI of each of those providers
 * is ready (found, runs, not known to be signed out), the provider is enabled and lists that model.
 * One ready CLI is not enough when a role uses another. The summary says what is missing.
 */
import { execFile } from 'node:child_process';
import { accessSync, constants, existsSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { posix, win32 } from 'node:path';
import { childEnv } from '../harness/platform.js';
import { PROVIDER_IDS, defaultConfig, type BifConfig, type ModelRef } from '../config/schema.js';
import type { ProviderId } from '../types.js';
import { usualDirs } from './usualDirs.js';

// The list of usual install folders has its own module; it is still part of the check's interface.
export { usualDirs };

export type RunResult = {
  /** Exit code; null when the command did not start or was stopped. */
  code: number | null;
  stdout: string;
  stderr: string;
  /** Why it did not start or was stopped. */
  error?: string;
};

/** What the check needs from the machine (tests give their own). */
export type DoctorSystem = {
  platform: NodeJS.Platform;
  env: Record<string, string | undefined>;
  home: string;
  /** True when `path` is a file that can be run. */
  isFile(path: string): boolean;
  /** True when `path` exists (a login file: only that it is there, never what is in it). */
  exists(path: string): boolean;
  /** The names in a folder; empty when it cannot be read. */
  listDir(path: string): string[];
  /** Runs a command with fixed arguments and returns what it printed. Never throws. */
  run(file: string, args: string[]): Promise<RunResult>;
};

export type SignedIn = 'yes' | 'no' | 'unknown';

export type CliCheck = {
  id: ProviderId;
  /** The name people know it by. */
  name: string;
  /** The configured command. */
  command: string;
  found: boolean;
  /** Where it was found. */
  path?: string;
  /** False when it was found in a usual install folder that is not on `PATH`. */
  onPath?: boolean;
  /** True when `--version` answered. */
  runs: boolean;
  version?: string;
  signedIn: SignedIn;
  /** How that was judged, and what the check cannot tell. */
  signedInDetail: string;
  /** Something that keeps this CLI from being used although it was found. */
  problem?: string;
  /** One line on what to do; empty when nothing is needed. */
  howTo: string;
  /** Found, runs, not known to be signed out, and no problem. */
  ready: boolean;
};

export type ChromeCheck = { found: boolean; path?: string; howTo: string };

export type SetupReport = {
  checkedAt: string;
  platform: string;
  clis: CliCheck[];
  chrome: ChromeCheck;
  /** True when the provider of every role of the configuration can be used (`withVerdict`). */
  canResearch: boolean;
  /** One or two sentences for the person. */
  summary: string;
};

type CliInfo = {
  name: string;
  install: string;
  signIn: string;
  /** Arguments of the status command. */
  statusArgs: string[];
  /** Reads the status command's answer. */
  signedIn(r: RunResult): { state: SignedIn; detail: string };
};

const text = (r: RunResult): string => `${r.stdout}\n${r.stderr}`.replace(/\u001b\[[0-9;]*m/g, '');
const firstLine = (s: string): string => s.split(/\r?\n/).map((l) => l.trim()).find(Boolean) ?? '';
const NO_ANSWER = (cmd: string) => `\`${cmd}\` did not answer as expected, so this could not be checked. The first run will show it.`;

const CLIS: Record<ProviderId, CliInfo> = {
  claude: {
    name: 'Claude Code',
    install: 'Install Claude Code (https://claude.com/claude-code), then sign in with `claude auth login`.',
    signIn: 'Sign in: run `claude auth login` in a terminal.',
    statusArgs: ['auth', 'status', '--json'],
    signedIn(r) {
      let loggedIn: unknown;
      try {
        loggedIn = (JSON.parse(r.stdout) as { loggedIn?: unknown }).loggedIn;
      } catch {
        // not JSON: an older CLI, or an error message
      }
      if (typeof loggedIn !== 'boolean') return { state: 'unknown', detail: NO_ANSWER('claude auth status --json') };
      return {
        state: loggedIn ? 'yes' : 'no',
        detail: '`claude auth status` says so. It cannot tell whether the service still accepts the login or whether the plan has usage left.',
      };
    },
  },
  codex: {
    name: 'Codex',
    install: 'Install the Codex CLI (https://github.com/openai/codex), then sign in with `codex login`.',
    signIn: 'Sign in: run `codex login` in a terminal.',
    statusArgs: ['login', 'status'],
    signedIn(r) {
      const t = text(r);
      const state: SignedIn = /not logged in/i.test(t) ? 'no' : /logged in/i.test(t) ? 'yes' : 'unknown';
      if (state === 'unknown') return { state, detail: NO_ANSWER('codex login status') };
      return { state, detail: '`codex login status` says so. It cannot tell whether the service still accepts the login.' };
    },
  },
  opencode: {
    name: 'OpenCode',
    install: 'Install OpenCode (https://opencode.ai), then sign in with `opencode auth login`.',
    signIn: 'Sign in: run `opencode auth login` in a terminal.',
    statusArgs: ['auth', 'list'],
    signedIn(r) {
      const t = text(r);
      const counts = [...t.matchAll(/(\d+)\s+(?:credentials?|environment variables?)\b/gi)].map((m) => Number(m[1]));
      if (!counts.length) return { state: 'unknown', detail: NO_ANSWER('opencode auth list') };
      return {
        state: counts.some((n) => n > 0) ? 'yes' : 'no',
        detail: '`opencode auth list` lists a credential or not. It cannot tell whether one is for the provider of the models you configure, or still valid.',
      };
    },
  },
};

/** Version numbers as CLIs print them: `2.1.325`, `1.0.0-nightly.3`. */
const VERSION = /\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?/;

/** The `node:path` of the platform checked, so a Windows check can be tested anywhere. */
const pathOf = (sys: DoctorSystem) => (sys.platform === 'win32' ? win32 : posix);

/** `PATH` as folders. */
function pathDirs(sys: DoctorSystem): string[] {
  const raw = sys.env.PATH ?? sys.env.Path ?? '';
  return raw.split(pathOf(sys).delimiter).map((d) => d.trim()).filter(Boolean);
}

/** The file names a command can have: itself, or on Windows itself with each extension that runs. */
function fileNames(sys: DoctorSystem, command: string): string[] {
  if (sys.platform !== 'win32') return [command];
  const exts = (sys.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').map((e) => e.trim().toLowerCase()).filter((e) => ['.com', '.exe', '.bat', '.cmd'].includes(e));
  return /\.(com|exe|bat|cmd)$/i.test(command) ? [command] : exts.map((e) => `${command}${e}`);
}

/** Where `command` is: on `PATH`, else in a usual install folder. A command given as a path is taken as it is. */
export function findCommand(sys: DoctorSystem, command: string): { path: string; onPath: boolean } | undefined {
  const p = pathOf(sys);
  const names = fileNames(sys, command);
  if (/[\\/]/.test(command)) {
    const hit = names.map((n) => p.resolve(n)).find((f) => sys.isFile(f));
    return hit ? { path: hit, onPath: true } : undefined;
  }
  const lookIn = (dirs: string[]) => dirs.flatMap((d) => names.map((n) => p.join(d, n))).find((f) => sys.isFile(f));
  const onPath = lookIn(pathDirs(sys));
  if (onPath) return { path: onPath, onPath: true };
  const usual = lookIn(usualDirs(sys));
  return usual ? { path: usual, onPath: false } : undefined;
}

/** The user's Codex home (as `userCodexHome` of the Codex adapter, for the machine checked). */
const codexHome = (sys: DoctorSystem): string => sys.env.CODEX_HOME || pathOf(sys).join(sys.home, '.codex');

async function checkCli(id: ProviderId, command: string, sys: DoctorSystem): Promise<CliCheck> {
  const info = CLIS[id];
  const base = { id, name: info.name, command };
  const where = findCommand(sys, command);
  if (!where) {
    return { ...base, found: false, runs: false, signedIn: 'unknown', signedInDetail: 'Not checked: the command was not found.', howTo: info.install, ready: false };
  }
  const found = { ...base, found: true, path: where.path, onPath: where.onPath };
  const v = await sys.run(where.path, ['--version']);
  const version = v.code === 0 ? VERSION.exec(text(v))?.[0] : undefined;
  if (v.code !== 0) {
    const why = v.error ?? (firstLine(text(v)) || `exit code ${v.code}`);
    return {
      ...found, runs: false, signedIn: 'unknown', signedInDetail: 'Not checked: the command did not run.',
      problem: `It was found but did not run: ${why}`,
      howTo: `Check that \`${where.path} --version\` works in a terminal, or install it again.`,
      ready: false,
    };
  }
  const status = info.signedIn(await sys.run(where.path, info.statusArgs));
  // Runs of this app read the Codex login from its file (the private Codex home links to it).
  const noLoginFile = id === 'codex' && status.state === 'yes' && !sys.exists(pathOf(sys).join(codexHome(sys), 'auth.json'));
  const problem = noLoginFile
    ? `Codex is signed in, but its login is not in ${pathOf(sys).join(codexHome(sys), 'auth.json')} (it may be kept in the system keychain). Runs started by this app read the login from that file.`
    : undefined;
  return {
    ...found,
    runs: true,
    ...(version ? { version } : {}),
    signedIn: status.state,
    signedInDetail: status.detail,
    ...(problem ? { problem } : {}),
    howTo: status.state === 'no' ? info.signIn : noLoginFile ? 'Set Codex to keep its login in a file, then run `codex login` again.' : '',
    ready: status.state !== 'no' && !noLoginFile,
  };
}

/** Where the research browser (Playwright's `chrome` channel) looks for Chrome. */
function chromePlaces(sys: DoctorSystem): string[] {
  if (sys.platform === 'darwin') return ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'];
  if (sys.platform === 'win32') {
    return [sys.env.LOCALAPPDATA, sys.env.PROGRAMFILES, sys.env['PROGRAMFILES(X86)']]
      .filter((d): d is string => !!d)
      .map((d) => win32.join(d, 'Google', 'Chrome', 'Application', 'chrome.exe'));
  }
  return ['/opt/google/chrome/chrome'];
}

function checkChrome(sys: DoctorSystem): ChromeCheck {
  const path = chromePlaces(sys).find((f) => sys.isFile(f));
  return path
    ? { found: true, path, howTo: '' }
    : { found: false, howTo: 'Install Google Chrome (https://www.google.com/chrome/): the research browser uses it. Without it, tasks that need a browser fail.' };
}

/** `A`, `A and B`, `A, B and C`. */
const listed = (names: string[]): string => (names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`);

/** What the verdict reads of the configuration: who has which role, and what each provider is set to. */
export type VerdictConfig = Pick<BifConfig, 'providers' | 'roles'>;

/** Every model a role names: the five roles and each kind of worker. */
function roleModels(roles: BifConfig['roles']): ModelRef[] {
  return [roles.orchestrator, roles.interviewer, roles.reviewer, roles.synthesizer, roles.persona, ...Object.values(roles.workers).filter((m): m is ModelRef => !!m)];
}

/** Why the provider of a role cannot be used, as the end of "<name>, which …" for one and for several; undefined when it can. */
function blocker(c: CliCheck, provider: BifConfig['providers'][ProviderId], models: string[]): { kind: string; one: string; many: string } | undefined {
  if (!c.found) return { kind: 'missing', one: 'was not found', many: 'were not found' };
  if (!c.runs) return { kind: 'broken', one: 'was found but does not run (see the reason next to it)', many: 'were found but do not run (see the reason next to each)' };
  if (c.signedIn === 'no') return { kind: 'signed out', one: 'is not signed in', many: 'are not signed in' };
  if (!c.ready) return { kind: 'problem', one: 'cannot be used (see the reason next to it)', many: 'cannot be used (see the reason next to each)' };
  if (!provider.enabled) return { kind: 'off', one: 'is switched off in the configuration', many: 'are switched off in the configuration' };
  const unlisted = models.find((m) => !provider.models.includes(m));
  if (unlisted !== undefined) {
    const text = `has no model \`${unlisted}\` in its list of models`;
    return { kind: `model ${c.id}`, one: text, many: text };
  }
  return undefined;
}

/**
 * Whether research can start with `config` on the machine `found` describes, and the sentence that
 * says so (see the module doc). Pure: no command is run.
 */
function verdict(clis: CliCheck[], chrome: ChromeCheck, config: VerdictConfig): { canResearch: boolean; summary: string } {
  const names = (list: CliCheck[]) => listed(list.map((c) => c.name));
  const browser = chrome.found ? '' : ' Google Chrome was not found: tasks that need the research browser will fail.';
  if (!clis.some((c) => c.found)) {
    return { canResearch: false, summary: `No agent CLI was found, so research cannot start. Install Claude Code, Codex or OpenCode and sign in.${browser}` };
  }
  const models = roleModels(config.roles);
  const used = clis.filter((c) => models.some((m) => m.provider === c.id));
  const blocked = used.flatMap((c) => {
    const why = blocker(c, config.providers[c.id], models.filter((m) => m.provider === c.id).map((m) => m.model));
    return why ? [{ cli: c, why }] : [];
  });
  if (!blocked.length) return { canResearch: true, summary: `Research can start with ${names(used)}.${browser}` };

  // One clause for the providers that share a reason: "Claude Code and Codex, which were not found".
  const groups = new Map<string, typeof blocked>();
  for (const b of blocked) groups.set(b.why.kind, [...(groups.get(b.why.kind) ?? []), b]);
  const clauses = [...groups.values()].map((g) => `${names(g.map((b) => b.cli))}, which ${g.length === 1 ? g[0]!.why.one : g[0]!.why.many}`);
  let summary = `Research cannot start: the configuration gives roles to ${clauses.join(', and to ')}.`;
  if (groups.has('signed out')) summary += ' Sign in and check again.';
  // What `suggestConfig` would do about a provider that is not there: the first one that is, with a model.
  const usable = clis.find((c) => c.found && c.runs && config.providers[c.id].models.length > 0);
  if (usable && (groups.has('missing') || groups.has('broken'))) summary += ` Writing the configuration for what was found gives those roles to ${usable.name}.`;
  // A CLI that is ready and has no model (OpenCode until the person lists one) cannot take a role yet.
  const noModel = clis.filter((c) => c.ready && config.providers[c.id].models.length === 0);
  if (noModel.length) {
    summary += ` ${names(noModel)} ${noModel.length === 1 ? 'was' : 'were'} found, but no model is chosen for ${noModel.length === 1 ? 'it' : 'them'}: choose one in Settings, then give ${noModel.length === 1 ? 'it' : 'them'} the roles.`;
  }
  return { canResearch: false, summary: `${summary}${browser}` };
}

/** `report` judged against `config`: the same machine, with `canResearch` and `summary` for the roles and providers of `config` as they are now. */
export function withVerdict(report: SetupReport, config: VerdictConfig): SetupReport {
  return { ...report, ...verdict(report.clis, report.chrome, config) };
}

/** Runs the setup check for the providers of `config` on `sys` (this machine by default), judged against the roles of `config`. */
export async function doctor(config: VerdictConfig, sys: DoctorSystem = systemDoctor()): Promise<SetupReport> {
  const clis = await Promise.all(PROVIDER_IDS.map((id) => checkCli(id, config.providers[id].command, sys)));
  const chrome = checkChrome(sys);
  return { checkedAt: new Date().toISOString(), platform: sys.platform, clis, chrome, ...verdict(clis, chrome, config) };
}

/** How long one command may take before it is given up on. */
const RUN_TIMEOUT_MS = 15_000;

/** This machine. `timeoutMs`: how long one command may take. */
export function systemDoctor(overrides: Partial<DoctorSystem> & { timeoutMs?: number } = {}): DoctorSystem {
  const { timeoutMs = RUN_TIMEOUT_MS, ...rest } = overrides;
  const platform = rest.platform ?? process.platform;
  const env = rest.env ?? process.env;
  return {
    platform,
    env,
    home: homedir(),
    isFile(path) {
      try {
        if (!statSync(path).isFile()) return false;
        if (platform !== 'win32') accessSync(path, constants.X_OK);
        return true;
      } catch {
        return false;
      }
    },
    exists: (path) => existsSync(path),
    listDir(path) {
      try {
        return readdirSync(path);
      } catch {
        return [];
      }
    },
    run(file, args) {
      // A `.cmd` / `.bat` shim cannot be started directly on Windows: it goes through the shell, with
      // the path quoted. The arguments are the fixed ones of this module, never text from outside.
      const viaShell = platform === 'win32' && /\.(cmd|bat)$/i.test(file);
      return new Promise<RunResult>((done) => {
        execFile(
          viaShell ? `"${file}"` : file,
          args,
          // The commands are agent CLIs: they get the environment an agent run gets (`childEnv`).
          { env: childEnv(file, env as NodeJS.ProcessEnv, { platform }), timeout: timeoutMs, maxBuffer: 1024 * 1024, windowsHide: true, shell: viaShell },
          (err, stdout, stderr) => {
            if (!err) return done({ code: 0, stdout, stderr });
            const e = err as NodeJS.ErrnoException & { killed?: boolean; code?: number | string };
            if (e.killed) return done({ code: null, stdout, stderr, error: `it did not answer within ${timeoutMs} ms` });
            if (typeof e.code === 'number') return done({ code: e.code, stdout, stderr });
            done({ code: null, stdout, stderr, error: e.message });
          },
        );
      });
    },
    ...rest,
  };
}

// --- the configuration that fits what was found ---------------------------------------------------

/** Beta defaults (design §4.3): a cost cap per pipeline and per workspace. The tester can change them. */
export const BETA_BUDGETS = { pipeline: { maxCostUsd: 25 }, workspace: { maxCostUsd: 100 } } as const;

/** The optional model settings that must name an enabled provider for the configuration to load. */
const OPTIONAL_MODELS: Array<(c: BifConfig) => { model?: ModelRef } | undefined> = [
  (c) => c.escalation,
  (c) => c.lessons?.retro,
  (c) => c.audit,
  (c) => c.flows,
  (c) => c.personaLearning,
];

/**
 * The configuration of design §4.3 from what the check found, starting from `base` (the defaults, or
 * the configuration in use): a provider is enabled only when its CLI was found and runs; a command
 * found outside `PATH` is written with its path; a role whose provider is not usable moves to the
 * first provider found, on that provider's first model; and the beta cost caps are set where `base`
 * has none. Everything else of `base` is kept, and `base` is not changed.
 *
 * A provider is usable when it was found and has a model configured. With none usable (nothing
 * found, or only OpenCode, which has no models until the person lists them) no model is invented:
 * the roles stay as they are and the providers they name stay enabled, so the configuration still
 * loads; the report says that research cannot start.
 */
export function suggestConfig(found: SetupReport, base: BifConfig = defaultConfig): BifConfig {
  const out = structuredClone(base);
  const runs = new Map(found.clis.map((c) => [c.id, c.found && c.runs ? c : undefined]));
  for (const id of PROVIDER_IDS) {
    const c = runs.get(id);
    if (c?.path && c.onPath === false) out.providers[id].command = c.path;
  }
  const usable = PROVIDER_IDS.filter((id) => runs.get(id) && out.providers[id].models.length > 0);
  const first = usable[0];
  if (first) {
    const fallback: ModelRef = { provider: first, model: out.providers[first].models[0]! };
    const placed = (ref: ModelRef): ModelRef => (usable.includes(ref.provider) ? ref : { ...fallback });
    for (const role of ['orchestrator', 'interviewer', 'reviewer', 'synthesizer', 'persona'] as const) out.roles[role] = placed(out.roles[role]);
    for (const [key, ref] of Object.entries(out.roles.workers)) if (ref) (out.roles.workers as Record<string, ModelRef>)[key] = placed(ref);
    for (const get of OPTIONAL_MODELS) {
      const holder = get(out);
      if (holder?.model) holder.model = placed(holder.model);
    }
    for (const id of PROVIDER_IDS) out.providers[id].enabled = runs.get(id) !== undefined;
  } else {
    // Nothing usable: only switch on what was found; what the roles name stays as it is.
    for (const id of PROVIDER_IDS) if (runs.get(id)) out.providers[id].enabled = true;
  }
  out.budgets = {
    ...out.budgets,
    pipeline: out.budgets?.pipeline ?? { ...BETA_BUDGETS.pipeline },
    workspace: out.budgets?.workspace ?? { ...BETA_BUDGETS.workspace },
  };
  return out;
}

// --- one check for the whole server -------------------------------------------------------------

export type SetupCheck = {
  /** The report: the one kept, or a new run (`refresh`, or none kept yet). Callers that ask together share one run. */
  report(opts?: { refresh?: boolean }): Promise<SetupReport>;
  /** The report kept, when a check has run. Never starts one. */
  cached(): SetupReport | undefined;
};

/**
 * Keeps the last report of `check`, so pages and the feedback bundle do not start commands each time.
 * `judge`: applied to the kept report each time it is handed out (`withVerdict` with the configuration
 * in use), so a change of the configuration shows without a new check. Default: the report as kept.
 */
export function cachedSetupCheck(check: () => Promise<SetupReport>, judge: (report: SetupReport) => SetupReport = (r) => r): SetupCheck {
  let kept: SetupReport | undefined;
  let running: Promise<SetupReport> | undefined;
  return {
    cached: () => (kept ? judge(kept) : undefined),
    report(opts = {}) {
      if (kept && !opts.refresh) return Promise.resolve(judge(kept));
      running ??= check()
        .then((r) => (kept = r))
        .finally(() => (running = undefined));
      return running.then(judge);
    },
  };
}

/**
 * The setup check as a server keeps it: the check of `config` on `sys` (this machine by default), kept
 * between requests. `config` is the configuration object in use: the check reads its commands when it
 * runs, and whether research can start is judged against it anew each time the report is read, because
 * its roles may have changed since the check ran (`POST /api/setup/apply`, `PUT /api/config`).
 */
export function serverSetupCheck(config: VerdictConfig, sys?: DoctorSystem): SetupCheck {
  return cachedSetupCheck(() => doctor(config, sys), (report) => withVerdict(report, config));
}

// --- as text (npm run doctor) -------------------------------------------------------------------

/** The report as lines for a terminal. */
export function formatReport(report: SetupReport): string {
  const width = Math.max(...report.clis.map((c) => c.name.length), 'Google Chrome'.length) + 2;
  const lines: string[] = [];
  const row = (name: string, state: string, more: string[]) => {
    lines.push(`${name.padEnd(width)}${state}`);
    for (const m of more.filter(Boolean)) lines.push(`${' '.repeat(width)}${m}`);
  };
  for (const c of report.clis) {
    if (!c.found) {
      row(c.name, `not found (command \`${c.command}\`)`, [c.howTo]);
      continue;
    }
    const signed = c.signedIn === 'yes' ? 'signed in' : c.signedIn === 'no' ? 'NOT signed in' : 'sign-in unknown';
    const state = c.runs ? `found at ${c.path}${c.version ? `, version ${c.version}` : ''}, ${signed}` : `found at ${c.path}, but it does not run`;
    row(c.name, state, [c.onPath === false ? 'Not on PATH: found in a usual install folder.' : '', c.problem ?? '', c.runs ? c.signedInDetail : '', c.howTo]);
  }
  row('Google Chrome', report.chrome.found ? `found at ${report.chrome.path}` : 'not found', [report.chrome.howTo]);
  lines.push('', report.summary);
  return `${lines.join('\n')}\n`;
}
