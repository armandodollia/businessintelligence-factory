/**
 * The setup check (design 2026-11-16-desktop-app-and-feedback-bundle-design.md §4.3). No real agent
 * CLI is started: the commands are either answered by the test, or are small scripts in a temporary
 * folder that is the whole PATH.
 */
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, posix, win32 } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseConfig } from '../../../src/core/config/load.js';
import { defaultConfig, type BifConfig } from '../../../src/core/config/schema.js';
import {
  BETA_BUDGETS,
  cachedSetupCheck,
  serverSetupCheck,
  doctor,
  formatReport,
  suggestConfig,
  systemDoctor,
  type DoctorSystem,
  type RunResult,
  type SetupReport,
} from '../../../src/core/setup/doctor.js';

const HOME = '/Users/tester';
const ok = (stdout: string, stderr = ''): RunResult => ({ code: 0, stdout, stderr });
const exit = (code: number, stdout = '', stderr = ''): RunResult => ({ code, stdout, stderr });

const CLAUDE_IN = JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', email: 'person@example.test', orgName: 'Secret Org', orgId: 'org-123' });
const CLAUDE_OUT = JSON.stringify({ loggedIn: false, authMethod: 'none' });
const OPENCODE_ONE = '\n\u001b[90m┌\u001b[0m  Credentials ~/.local/share/opencode/auth.json\n│\n●  GitHub Copilot oauth\n│\n└  1 credentials\n';
const OPENCODE_NONE = '\n┌  Credentials ~/.local/share/opencode/auth.json\n│\n└  0 credentials\n';

type Answers = Record<string, RunResult | undefined>;

/** A machine made of a list of files and of what each command line answers. */
function machine(opts: { platform?: NodeJS.Platform; files: string[]; path?: string; env?: Record<string, string>; home?: string; answers?: Answers; dirs?: Record<string, string[]> }) {
  const platform = opts.platform ?? 'darwin';
  const calls: string[] = [];
  const sys: DoctorSystem = {
    platform,
    home: opts.home ?? HOME,
    env: { PATH: opts.path ?? '/usr/bin:/bin', ...opts.env },
    isFile: (p) => opts.files.includes(p) && !p.endsWith('.json'),
    exists: (p) => opts.files.includes(p),
    listDir: (p) => opts.dirs?.[p] ?? [],
    run: async (file, args) => {
      const line = [file, ...args].join(' ');
      calls.push(line);
      return opts.answers?.[line] ?? { code: null, stdout: '', stderr: '', error: `no answer for: ${line}` };
    },
  };
  return { sys, calls };
}

const cli = (report: SetupReport, id: string) => report.clis.find((c) => c.id === id)!;

describe('doctor: finding the agent CLIs', () => {
  it('finds a command on PATH, reads its version and sees that it is signed in', async () => {
    const { sys, calls } = machine({
      files: ['/opt/tools/claude', '/opt/tools/codex', '/opt/tools/opencode', `${HOME}/.codex/auth.json`, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'],
      path: '/usr/bin:/opt/tools',
      answers: {
        '/opt/tools/claude --version': ok('2.1.325 (Claude Code)\n'),
        '/opt/tools/claude auth status --json': ok(CLAUDE_IN),
        '/opt/tools/codex --version': ok('codex-cli 0.169.0\n'),
        '/opt/tools/codex login status': ok('', 'Logged in using ChatGPT\n'),
        '/opt/tools/opencode --version': ok('1.2.27\n'),
        '/opt/tools/opencode auth list': ok(OPENCODE_ONE),
      },
    });
    const report = await doctor(defaultConfig, sys);
    expect(report.clis.map((c) => c.id)).toEqual(['claude', 'codex', 'opencode']);
    expect(cli(report, 'claude')).toMatchObject({ name: 'Claude Code', command: 'claude', found: true, path: '/opt/tools/claude', onPath: true, runs: true, version: '2.1.325', signedIn: 'yes', ready: true });
    expect(cli(report, 'codex')).toMatchObject({ name: 'Codex', found: true, path: '/opt/tools/codex', version: '0.169.0', signedIn: 'yes', ready: true });
    expect(cli(report, 'opencode')).toMatchObject({ name: 'OpenCode', found: true, version: '1.2.27', signedIn: 'yes', ready: true });
    expect(report.chrome).toMatchObject({ found: true, path: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
    expect(report.canResearch).toBe(true);
    // The programs the roles of the configuration use. OpenCode is there too, and no role uses it.
    expect(report.summary).toBe('Research can start with Claude Code and Codex.');
    expect(report.platform).toBe('darwin');
    // Only these command lines were run: a version, and each CLI's own status command. Never a prompt.
    expect(calls.sort()).toEqual([
      '/opt/tools/claude --version', '/opt/tools/claude auth status --json',
      '/opt/tools/codex --version', '/opt/tools/codex login status',
      '/opt/tools/opencode --version', '/opt/tools/opencode auth list',
    ].sort());
  });

  it('carries nothing of the account a CLI reports: no email, no organisation', async () => {
    const { sys } = machine({
      files: ['/opt/tools/claude'],
      path: '/opt/tools',
      answers: { '/opt/tools/claude --version': ok('2.1.325 (Claude Code)'), '/opt/tools/claude auth status --json': ok(CLAUDE_IN) },
    });
    const text = JSON.stringify(await doctor(defaultConfig, sys));
    for (const secret of ['person@example.test', 'Secret Org', 'org-123']) expect(text).not.toContain(secret);
  });

  it('finds a command in a usual install folder that is not on PATH, and says where', async () => {
    const { sys } = machine({
      files: [`${HOME}/.local/bin/claude`, '/opt/homebrew/bin/codex', `${HOME}/.opencode/bin/opencode`, `${HOME}/.codex/auth.json`],
      path: '/usr/bin:/bin',
      answers: {
        [`${HOME}/.local/bin/claude --version`]: ok('2.1.325 (Claude Code)'),
        [`${HOME}/.local/bin/claude auth status --json`]: ok(CLAUDE_IN),
        '/opt/homebrew/bin/codex --version': ok('codex-cli 0.169.0'),
        '/opt/homebrew/bin/codex login status': ok('Logged in using ChatGPT'),
        [`${HOME}/.opencode/bin/opencode --version`]: ok('1.2.27'),
        [`${HOME}/.opencode/bin/opencode auth list`]: ok(OPENCODE_ONE),
      },
    });
    const report = await doctor(defaultConfig, sys);
    expect(cli(report, 'claude')).toMatchObject({ found: true, path: `${HOME}/.local/bin/claude`, onPath: false, ready: true });
    expect(cli(report, 'codex')).toMatchObject({ found: true, path: '/opt/homebrew/bin/codex', onPath: false });
    expect(cli(report, 'opencode')).toMatchObject({ found: true, path: `${HOME}/.opencode/bin/opencode`, onPath: false });
  });

  it('looks in the folders of Node versions installed with nvm, newest first', async () => {
    const nvm = `${HOME}/.nvm/versions/node`;
    const { sys } = machine({
      files: [`${nvm}/v22.1.0/bin/opencode`, `${nvm}/v25.8.1/bin/opencode`],
      dirs: { [nvm]: ['v22.1.0', 'v25.8.1', 'v9.0.0'] },
      answers: { [`${nvm}/v25.8.1/bin/opencode --version`]: ok('1.2.27'), [`${nvm}/v25.8.1/bin/opencode auth list`]: ok(OPENCODE_ONE) },
    });
    expect(cli(await doctor(defaultConfig, sys), 'opencode')).toMatchObject({ found: true, path: `${nvm}/v25.8.1/bin/opencode`, onPath: false });
  });

  it('uses the configured command: a name is looked up, a path is taken as it is', async () => {
    const config = structuredClone(defaultConfig);
    config.providers.claude.command = '/custom/place/claude-beta';
    config.providers.codex.command = 'codex-nightly';
    const { sys } = machine({
      files: ['/custom/place/claude-beta', '/opt/tools/codex-nightly', '/opt/tools/claude', '/opt/tools/codex'],
      path: '/opt/tools',
      answers: {
        '/custom/place/claude-beta --version': ok('3.0.0 (Claude Code)'),
        '/custom/place/claude-beta auth status --json': ok(CLAUDE_IN),
        '/opt/tools/codex-nightly --version': ok('codex-cli 1.0.0-nightly.3'),
        '/opt/tools/codex-nightly login status': ok('Logged in using an API key'),
      },
    });
    const report = await doctor(config, sys);
    expect(cli(report, 'claude')).toMatchObject({ command: '/custom/place/claude-beta', found: true, path: '/custom/place/claude-beta', version: '3.0.0' });
    expect(cli(report, 'codex')).toMatchObject({ command: 'codex-nightly', found: true, path: '/opt/tools/codex-nightly', version: '1.0.0-nightly.3' });
  });

  it('says what is missing and how to get it, and that research cannot start with no agent CLI', async () => {
    const { sys, calls } = machine({ files: [] });
    const report = await doctor(defaultConfig, sys);
    for (const c of report.clis) {
      expect(c).toMatchObject({ found: false, runs: false, signedIn: 'unknown', ready: false });
      expect(c.path).toBeUndefined();
      expect(c.howTo).toMatch(/^Install /);
    }
    expect(report.chrome.found).toBe(false);
    expect(report.chrome.howTo).toMatch(/Install Google Chrome/);
    expect(report.canResearch).toBe(false);
    expect(report.summary).toMatch(/No agent CLI was found.*research cannot start/i);
    expect(calls).toEqual([]);
  });

  it('a command that is found but does not run is reported with the reason, not as missing', async () => {
    const { sys } = machine({
      files: ['/opt/tools/opencode'],
      path: '/opt/tools',
      answers: { '/opt/tools/opencode --version': { code: 127, stdout: '', stderr: 'env: node: No such file or directory\n' } },
    });
    const c = cli(await doctor(defaultConfig, sys), 'opencode');
    expect(c).toMatchObject({ found: true, runs: false, ready: false, signedIn: 'unknown' });
    expect(c.version).toBeUndefined();
    expect(c.problem).toContain('env: node: No such file or directory');
  });
});

describe('doctor: signed in or not, without a model call', () => {
  const claude = (answers: Answers) => machine({ files: ['/t/claude'], path: '/t', answers: { '/t/claude --version': ok('2.1.325 (Claude Code)'), ...answers } });
  const codex = (answers: Answers, files: string[] = [`${HOME}/.codex/auth.json`], env: Record<string, string> = {}) =>
    machine({ files: ['/t/codex', ...files], path: '/t', env, answers: { '/t/codex --version': ok('codex-cli 0.169.0'), ...answers } });
  const opencode = (answers: Answers) => machine({ files: ['/t/opencode'], path: '/t', answers: { '/t/opencode --version': ok('1.2.27'), ...answers } });

  it('Claude Code: `claude auth status --json` says loggedIn', async () => {
    const out = cli(await doctor(defaultConfig, claude({ '/t/claude auth status --json': exit(1, CLAUDE_OUT) }).sys), 'claude');
    expect(out).toMatchObject({ signedIn: 'no', ready: false });
    expect(out.howTo).toContain('claude auth login');
    const yes = cli(await doctor(defaultConfig, claude({ '/t/claude auth status --json': ok(CLAUDE_IN) }).sys), 'claude');
    expect(yes).toMatchObject({ signedIn: 'yes', ready: true, howTo: '' });
    expect(yes.signedInDetail).toMatch(/cannot tell/i);
  });

  it('Claude Code: a version without that command is "unknown", and still counts as usable', async () => {
    const c = cli(await doctor(defaultConfig, claude({ '/t/claude auth status --json': exit(1, '', "error: unknown command 'auth'") }).sys), 'claude');
    expect(c).toMatchObject({ signedIn: 'unknown', ready: true });
    expect(c.signedInDetail).toMatch(/did not answer/);
  });

  it('Codex: `codex login status` says logged in or not', async () => {
    expect(cli(await doctor(defaultConfig, codex({ '/t/codex login status': exit(1, '', 'Not logged in\n') }).sys), 'codex')).toMatchObject({ signedIn: 'no', ready: false });
    expect(cli(await doctor(defaultConfig, codex({ '/t/codex login status': ok('', 'Logged in using ChatGPT\n') }).sys), 'codex')).toMatchObject({ signedIn: 'yes', ready: true });
    expect(cli(await doctor(defaultConfig, codex({ '/t/codex login status': exit(2, '', 'error: unrecognized subcommand') }).sys), 'codex')).toMatchObject({ signedIn: 'unknown' });
  });

  it('Codex: signed in but with no login file, which the runs of this app need, is a problem', async () => {
    const c = cli(await doctor(defaultConfig, codex({ '/t/codex login status': ok('Logged in using ChatGPT') }, []).sys), 'codex');
    expect(c).toMatchObject({ signedIn: 'yes', ready: false });
    expect(c.problem).toMatch(/auth\.json/);
    // The Codex home the tester set is where the file is looked for.
    const moved = codex({ '/t/codex login status': ok('Logged in using ChatGPT') }, ['/elsewhere/codex/auth.json'], { CODEX_HOME: '/elsewhere/codex' });
    expect(cli(await doctor(defaultConfig, moved.sys), 'codex')).toMatchObject({ signedIn: 'yes', ready: true });
  });

  it('OpenCode: `opencode auth list` counts the stored credentials and the environment keys', async () => {
    expect(cli(await doctor(defaultConfig, opencode({ '/t/opencode auth list': ok(OPENCODE_NONE) }).sys), 'opencode')).toMatchObject({ signedIn: 'no', ready: false });
    expect(cli(await doctor(defaultConfig, opencode({ '/t/opencode auth list': ok(OPENCODE_ONE) }).sys), 'opencode')).toMatchObject({ signedIn: 'yes', ready: true });
    const env = `${OPENCODE_NONE}\n┌  Environment\n│\n●  OpenAI OPENAI_API_KEY\n│\n└  1 environment variable\n`;
    expect(cli(await doctor(defaultConfig, opencode({ '/t/opencode auth list': ok(env) }).sys), 'opencode')).toMatchObject({ signedIn: 'yes' });
    expect(cli(await doctor(defaultConfig, opencode({ '/t/opencode auth list': ok('something else') }).sys), 'opencode')).toMatchObject({ signedIn: 'unknown', ready: true });
  });

  const BROWSER = ' Google Chrome was not found: tasks that need the research browser will fail.';
  const READY = {
    claude: { '/t/claude --version': ok('2.1.325 (Claude Code)'), '/t/claude auth status --json': ok(CLAUDE_IN) },
    codex: { '/t/codex --version': ok('codex-cli 0.169.0'), '/t/codex login status': ok('Logged in using ChatGPT') },
    opencode: { '/t/opencode --version': ok('1.2.27'), '/t/opencode auth list': ok(OPENCODE_ONE) },
  };
  /** A machine with these agent CLIs, each signed in. */
  const having = (ids: Array<keyof typeof READY>) =>
    machine({ files: [...ids.map((id) => `/t/${id}`), `${HOME}/.codex/auth.json`], path: '/t', answers: Object.assign({}, ...ids.map((id) => READY[id])) as Answers }).sys;
  /** The defaults with every role on one model. */
  const allOn = (provider: 'claude' | 'codex' | 'opencode', model: string): BifConfig => {
    const c = structuredClone(defaultConfig);
    const ref = { provider, model };
    c.roles = { orchestrator: ref, interviewer: ref, reviewer: ref, synthesizer: ref, persona: ref, workers: { default: ref } };
    return c;
  };

  it('research can start only when the program of every role is ready: one ready program is not enough', async () => {
    // The defaults give the reviewer to Codex, which this machine does not have.
    const report = await doctor(defaultConfig, having(['claude']));
    expect(cli(report, 'claude').ready).toBe(true);
    expect(report.canResearch).toBe(false);
    expect(report.summary).toBe(
      `Research cannot start: the configuration gives roles to Codex, which was not found. Writing the configuration for what was found gives those roles to Claude Code.${BROWSER}`,
    );
    // With every role on the program that is there, it can.
    const moved = await doctor(allOn('claude', 'opus'), having(['claude']));
    expect(moved.canResearch).toBe(true);
    expect(moved.summary).toBe(`Research can start with Claude Code.${BROWSER}`);
  });

  it('with only OpenCode signed in research cannot start: no model is chosen for it, and the roles name other programs', async () => {
    const report = await doctor(defaultConfig, having(['opencode']));
    expect(cli(report, 'opencode')).toMatchObject({ found: true, signedIn: 'yes', ready: true });
    expect(report.canResearch).toBe(false);
    expect(report.summary).toBe(
      'Research cannot start: the configuration gives roles to Claude Code and Codex, which were not found. ' +
        `OpenCode was found, but no model is chosen for it: choose one in Settings, then give it the roles.${BROWSER}`,
    );
    // The configuration the check suggests switches OpenCode on and still names no model: nothing changes.
    const suggested = suggestConfig(report, defaultConfig);
    expect(suggested.providers.opencode.enabled).toBe(true);
    expect((await doctor(suggested, having(['opencode']))).canResearch).toBe(false);
    // Once the person has chosen a model and given it the roles, research can start with OpenCode.
    const chosen = allOn('opencode', 'some/model');
    chosen.providers.opencode = { ...chosen.providers.opencode, enabled: true, models: ['some/model'] };
    expect(await doctor(chosen, having(['opencode']))).toMatchObject({ canResearch: true, summary: `Research can start with OpenCode.${BROWSER}` });
  });

  it('says what keeps the program of a role from being used: not signed in, switched off, a model it does not list', async () => {
    const signedOut = machine({
      files: ['/t/claude', '/t/codex', `${HOME}/.codex/auth.json`],
      path: '/t',
      answers: { '/t/claude --version': ok('2.1.325 (Claude Code)'), '/t/claude auth status --json': exit(1, CLAUDE_OUT), ...READY.codex },
    });
    // Codex is ready, and that is not enough: most roles are Claude Code's.
    const blocked = await doctor(defaultConfig, signedOut.sys);
    expect(blocked.canResearch).toBe(false);
    expect(blocked.summary).toBe(`Research cannot start: the configuration gives roles to Claude Code, which is not signed in. Sign in and check again.${BROWSER}`);

    const both = await doctor(defaultConfig, machine({ files: ['/t/claude'], path: '/t', answers: { '/t/claude --version': ok('2.1.325'), '/t/claude auth status --json': exit(1, CLAUDE_OUT) } }).sys);
    expect(both.canResearch).toBe(false);
    expect(both.summary).toBe(
      'Research cannot start: the configuration gives roles to Claude Code, which is not signed in, and to Codex, which was not found. Sign in and check again. ' +
        `Writing the configuration for what was found gives those roles to Claude Code.${BROWSER}`,
    );

    const off = structuredClone(defaultConfig);
    off.providers.codex.enabled = false;
    expect((await doctor(off, having(['claude', 'codex']))).summary).toBe(
      `Research cannot start: the configuration gives roles to Codex, which is switched off in the configuration.${BROWSER}`,
    );

    const unlisted = allOn('claude', 'opus');
    unlisted.roles.reviewer = { provider: 'claude', model: 'opus-next' };
    expect(await doctor(unlisted, having(['claude']))).toMatchObject({
      canResearch: false,
      summary: `Research cannot start: the configuration gives roles to Claude Code, which has no model \`opus-next\` in its list of models.${BROWSER}`,
    });
  });

  it('judges a kept check again with the configuration of the moment, without running a command', async () => {
    const config = structuredClone(defaultConfig);
    const { sys, calls } = machine({ files: ['/t/claude'], path: '/t', answers: READY.claude });
    const check = serverSetupCheck(config, sys);
    expect((await check.report()).canResearch).toBe(false);
    const ran = calls.length;
    // The person writes the configuration for what was found: the roles move, the kept check answers anew.
    Object.assign(config, suggestConfig(await check.report(), config));
    expect(await check.report()).toMatchObject({ canResearch: true, summary: `Research can start with Claude Code.${BROWSER}` });
    expect(check.cached()).toMatchObject({ canResearch: true });
    expect(calls).toHaveLength(ran);
  });
});

describe('doctor: Windows and Linux, by the platform it is told', () => {
  const WHOME = 'C:\\Users\\tester';
  const env = { APPDATA: `${WHOME}\\AppData\\Roaming`, LOCALAPPDATA: `${WHOME}\\AppData\\Local`, PROGRAMFILES: 'C:\\Program Files', 'PROGRAMFILES(X86)': 'C:\\Program Files (x86)', PATHEXT: '.COM;.EXE;.BAT;.CMD' };

  it('Windows: PATH is split at ";", commands have an extension, npm and user folders are looked in', async () => {
    const claudeExe = win32.join(WHOME, '.local', 'bin', 'claude.exe');
    const codexCmd = win32.join(env.APPDATA, 'npm', 'codex.cmd');
    const opencodeCmd = 'D:\\tools\\opencode.cmd';
    const chrome = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
    const { sys, calls } = machine({
      platform: 'win32',
      home: WHOME,
      files: [claudeExe, codexCmd, opencodeCmd, chrome, win32.join(WHOME, '.codex', 'auth.json'), 'D:\\tools\\opencode'],
      path: 'C:\\Windows\\system32;D:\\tools',
      env,
      answers: {
        [`${claudeExe} --version`]: ok('2.1.325 (Claude Code)\r\n'),
        [`${claudeExe} auth status --json`]: ok(CLAUDE_IN),
        [`${codexCmd} --version`]: ok('codex-cli 0.169.0\r\n'),
        [`${codexCmd} login status`]: ok('Logged in using ChatGPT\r\n'),
        [`${opencodeCmd} --version`]: ok('1.2.27\r\n'),
        [`${opencodeCmd} auth list`]: ok(OPENCODE_ONE),
      },
    });
    const report = await doctor(defaultConfig, sys);
    expect(cli(report, 'claude')).toMatchObject({ found: true, path: claudeExe, onPath: false, version: '2.1.325', signedIn: 'yes' });
    expect(cli(report, 'codex')).toMatchObject({ found: true, path: codexCmd, onPath: false, version: '0.169.0', signedIn: 'yes', ready: true });
    // On PATH, by its extension: the file without one is a script for another shell.
    expect(cli(report, 'opencode')).toMatchObject({ found: true, path: opencodeCmd, onPath: true });
    expect(report.chrome).toMatchObject({ found: true, path: chrome });
    expect(report.platform).toBe('win32');
    expect(calls).toHaveLength(6);
  });

  it('Windows: Chrome installed for one user is found; no Chrome is reported', async () => {
    const perUser = win32.join(env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe');
    expect((await doctor(defaultConfig, machine({ platform: 'win32', home: WHOME, files: [perUser], path: '', env }).sys)).chrome).toMatchObject({ found: true, path: perUser });
    expect((await doctor(defaultConfig, machine({ platform: 'win32', home: WHOME, files: [], path: '', env }).sys)).chrome.found).toBe(false);
  });

  it('Linux: Chrome where the research browser looks for it', async () => {
    const { sys } = machine({ platform: 'linux', home: '/home/t', files: ['/opt/google/chrome/chrome', '/home/t/.local/bin/claude'], answers: { '/home/t/.local/bin/claude --version': ok('2.1.325'), '/home/t/.local/bin/claude auth status --json': ok(CLAUDE_IN) } });
    const report = await doctor(defaultConfig, sys);
    expect(report.chrome).toMatchObject({ found: true, path: '/opt/google/chrome/chrome' });
    expect(cli(report, 'claude')).toMatchObject({ found: true, path: posix.join('/home/t', '.local', 'bin', 'claude') });
  });
});

describe.skipIf(process.platform === 'win32')('doctor with fake commands on PATH (the fake commands are POSIX shell scripts)', () => {
  /** Writes an executable script `name` into `dir`. Shell built-ins only: the folder is the whole PATH. */
  const script = (dir: string, name: string, body: string) => {
    writeFileSync(join(dir, name), `#!/bin/sh\n${body}\n`);
    chmodSync(join(dir, name), 0o755);
  };

  it('finds them, runs only their version and status commands, and reads the answers', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bif-doctor-'));
    const bin = join(dir, 'bin');
    const home = join(dir, 'home');
    mkdirSync(bin);
    mkdirSync(join(home, '.codex'), { recursive: true });
    writeFileSync(join(home, '.codex', 'auth.json'), '{}');
    const calledWith = join(dir, 'calls.log');
    const record = `echo "$0 $*" >> "${calledWith}"`;
    script(bin, 'claude', `${record}\ncase "$*" in\n  "--version") echo "2.1.325 (Claude Code)";;\n  "auth status --json") echo '{"loggedIn":true,"email":"person@example.test"}';;\n  *) echo "unexpected: $*" >&2; exit 64;;\nesac`);
    script(bin, 'codex', `${record}\ncase "$*" in\n  "--version") echo "codex-cli 0.169.0";;\n  "login status") echo "Logged in using ChatGPT" >&2;;\n  *) exit 64;;\nesac`);
    script(bin, 'opencode', `${record}\ncase "$*" in\n  "--version") echo "1.2.27";;\n  "auth list") printf '\\n+  Credentials\\n|\\n+  2 credentials\\n';;\n  *) exit 64;;\nesac`);
    // A file that is not executable is not a command.
    writeFileSync(join(bin, 'not-a-command'), '');

    const report = await doctor(defaultConfig, systemDoctor({ env: { PATH: bin }, home }));
    expect(cli(report, 'claude')).toMatchObject({ found: true, path: join(bin, 'claude'), onPath: true, runs: true, version: '2.1.325', signedIn: 'yes', ready: true });
    // Its login file is there (an ordinary file, not a command), so runs of this app can use the login.
    expect(cli(report, 'codex')).toMatchObject({ found: true, path: join(bin, 'codex'), version: '0.169.0', signedIn: 'yes', ready: true });
    expect(cli(report, 'codex').problem).toBeUndefined();
    expect(cli(report, 'opencode')).toMatchObject({ found: true, version: '1.2.27', signedIn: 'yes', ready: true });
    expect(JSON.stringify(report)).not.toContain('person@example.test');
    expect(report.canResearch).toBe(true);
    // What the commands were really started with: a version and a status command each, nothing else.
    const started = readFileSync(calledWith, 'utf8').trim().split('\n').sort();
    expect(started).toEqual([
      `${join(bin, 'claude')} --version`, `${join(bin, 'claude')} auth status --json`,
      `${join(bin, 'codex')} --version`, `${join(bin, 'codex')} login status`,
      `${join(bin, 'opencode')} --version`, `${join(bin, 'opencode')} auth list`,
    ].sort());

    const other = structuredClone(defaultConfig);
    other.providers.opencode.command = 'not-a-command';
    expect(cli(await doctor(other, systemDoctor({ env: { PATH: bin }, home })), 'opencode')).toMatchObject({ found: false, ready: false });
  });

  it('a command that hangs is given up on', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bif-doctor-'));
    script(dir, 'claude', 'while :; do :; done');
    const report = await doctor(defaultConfig, systemDoctor({ env: { PATH: dir }, home: dir, timeoutMs: 300 }));
    expect(cli(report, 'claude')).toMatchObject({ found: true, runs: false, ready: false });
    expect(cli(report, 'claude').problem).toMatch(/did not answer within/);
  });
});

describe('suggestConfig', () => {
  const found = (ids: Array<'claude' | 'codex' | 'opencode'>, paths: Partial<Record<string, { path: string; onPath: boolean }>> = {}): SetupReport => ({
    checkedAt: '2026-11-16T00:00:00.000Z',
    platform: 'darwin',
    clis: (['claude', 'codex', 'opencode'] as const).map((id) => ({
      id, name: id, command: id, found: ids.includes(id), runs: ids.includes(id), signedIn: 'yes', signedInDetail: '', howTo: '', ready: ids.includes(id),
      ...(ids.includes(id) ? { path: paths[id]?.path ?? `/bin/${id}`, onPath: paths[id]?.onPath ?? true, version: '1.0.0' } : {}),
    })),
    chrome: { found: true, howTo: '' },
    canResearch: ids.length > 0,
    summary: '',
  });
  const valid = (c: BifConfig) => parseConfig(structuredClone(c), 'suggested');

  it('with Claude Code and Codex: both enabled, the default roles, and the beta cost caps', () => {
    const c = suggestConfig(found(['claude', 'codex']));
    expect(c.providers.claude.enabled).toBe(true);
    expect(c.providers.codex.enabled).toBe(true);
    expect(c.providers.opencode.enabled).toBe(false);
    expect(c.roles).toEqual(defaultConfig.roles);
    expect(c.budgets).toEqual({ pipeline: { maxCostUsd: 25 }, workspace: { maxCostUsd: 100 } });
    expect(BETA_BUDGETS).toEqual({ pipeline: { maxCostUsd: 25 }, workspace: { maxCostUsd: 100 } });
    expect(c.providers.claude.command).toBe('claude');
    valid(c);
  });

  it('with only Claude Code: Codex is off and its role moves to Claude Code', () => {
    const c = suggestConfig(found(['claude']));
    expect(c.providers).toMatchObject({ claude: { enabled: true }, codex: { enabled: false }, opencode: { enabled: false } });
    expect(c.roles.reviewer).toEqual({ provider: 'claude', model: 'opus' });
    expect({ ...c.roles, reviewer: defaultConfig.roles.reviewer }).toEqual(defaultConfig.roles);
    valid(c);
  });

  it('with only Codex: every role runs on Codex', () => {
    const c = suggestConfig(found(['codex']));
    expect(c.providers).toMatchObject({ claude: { enabled: false }, codex: { enabled: true } });
    const codex = { provider: 'codex', model: 'gpt-6.1-sol' };
    expect(c.roles).toEqual({ orchestrator: codex, interviewer: codex, reviewer: codex, synthesizer: codex, persona: codex, workers: { default: codex } });
    valid(c);
  });

  it('writes where a command was found when it is not on PATH', () => {
    const c = suggestConfig(found(['claude', 'codex'], { claude: { path: '/Users/tester/.local/bin/claude', onPath: false } }));
    expect(c.providers.claude.command).toBe('/Users/tester/.local/bin/claude');
    expect(c.providers.codex.command).toBe('codex');
    valid(c);
  });

  it('with no agent CLI: a configuration that still loads, with the cost caps', () => {
    const c = suggestConfig(found([]));
    expect(c.providers).toEqual(defaultConfig.providers);
    expect(c.roles).toEqual(defaultConfig.roles);
    expect(c.budgets).toEqual(BETA_BUDGETS);
    valid(c);
  });

  it('with only OpenCode, which has no model configured: it is enabled, and no model is invented for the roles', () => {
    const c = suggestConfig(found(['opencode']));
    expect(c.providers.opencode.enabled).toBe(true);
    expect(c.providers.opencode.models).toEqual([]);
    expect(c.roles).toEqual(defaultConfig.roles);
    // The providers the roles still name stay enabled, or the configuration would not load.
    expect(c.providers.claude.enabled).toBe(true);
    expect(c.providers.codex.enabled).toBe(true);
    valid(c);
  });

  it('with only OpenCode and its models configured: every role runs on its first model', () => {
    const base = structuredClone(defaultConfig);
    base.providers.opencode.models = ['github-copilot/gpt-5', 'github-copilot/other'];
    const c = suggestConfig(found(['opencode']), base);
    const ref = { provider: 'opencode', model: 'github-copilot/gpt-5' };
    expect(c.roles.orchestrator).toEqual(ref);
    expect(c.roles.workers.default).toEqual(ref);
    expect(c.providers).toMatchObject({ claude: { enabled: false }, codex: { enabled: false }, opencode: { enabled: true } });
    valid(c);
  });

  it('keeps what the configuration already says: its own cost caps, its other settings, optional models moved with the roles', () => {
    const base = structuredClone(defaultConfig);
    base.budgets = { pipeline: { maxCostUsd: 5 } };
    base.user = { id: 'someone' };
    base.limits.maxParallelWorkers = 1;
    base.escalation = { model: { provider: 'codex', model: 'gpt-6.1-sol' } };
    const c = suggestConfig(found(['claude']), base);
    expect(c.budgets).toEqual({ pipeline: { maxCostUsd: 5 }, workspace: { maxCostUsd: 100 } });
    expect(c.user).toEqual({ id: 'someone' });
    expect(c.limits.maxParallelWorkers).toBe(1);
    expect(c.escalation?.model).toEqual({ provider: 'claude', model: 'opus' });
    valid(c);
    // The configuration given is not changed.
    expect(base.providers.codex.enabled).toBe(true);
    expect(base.budgets).toEqual({ pipeline: { maxCostUsd: 5 } });
  });
});

describe('cachedSetupCheck and formatReport', () => {
  it('runs the check once until it is asked again, and one run serves callers that ask together', async () => {
    let runs = 0;
    const check = cachedSetupCheck(async () => {
      runs++;
      return { checkedAt: String(runs), platform: 'darwin', clis: [], chrome: { found: false, howTo: '' }, canResearch: false, summary: '' };
    });
    expect(check.cached()).toBeUndefined();
    const [a, b] = await Promise.all([check.report(), check.report()]);
    expect(a).toBe(b);
    expect(runs).toBe(1);
    expect((await check.report()).checkedAt).toBe('1');
    expect(check.cached()?.checkedAt).toBe('1');
    expect((await check.report({ refresh: true })).checkedAt).toBe('2');
    expect(runs).toBe(2);
  });

  it('a failed check is not kept', async () => {
    let runs = 0;
    const check = cachedSetupCheck(async () => {
      if (++runs === 1) throw new Error('boom');
      return { checkedAt: 'ok', platform: 'darwin', clis: [], chrome: { found: false, howTo: '' }, canResearch: false, summary: '' };
    });
    await expect(check.report()).rejects.toThrow('boom');
    expect((await check.report()).checkedAt).toBe('ok');
  });

  it('prints the report as lines a person reads', async () => {
    const { sys } = machine({
      files: ['/t/claude'],
      path: '/t',
      answers: { '/t/claude --version': ok('2.1.325 (Claude Code)'), '/t/claude auth status --json': ok(CLAUDE_IN) },
    });
    const text = formatReport(await doctor(defaultConfig, sys));
    expect(text).toMatch(/Claude Code\s+found at \/t\/claude, version 2\.1\.325, signed in/);
    expect(text).toMatch(/Codex\s+not found/);
    expect(text).toMatch(/Google Chrome\s+not found/);
    // The defaults give a role to Codex, which is not there.
    expect(text).toMatch(/Research cannot start: the configuration gives roles to Codex, which was not found/);
  });
});
