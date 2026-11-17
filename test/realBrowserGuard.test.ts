/**
 * The guard of the test suite (`test/realBrowserGuard.ts`, installed by `test/setup.ts`): the default
 * shared browser command is never spawned from a test.
 */
import { exec, execFile, execFileSync, execSync, fork, spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { PLAYWRIGHT_MCP_VERSION, PLAYWRIGHT_SHARED_BROWSER, defaultConfig } from '../src/core/config/schema.js';
import { SharedBrowser } from '../src/core/harness/browser.js';
import { isRealBrowserCommand, isRealBrowserLine, takeRealBrowserAttempts } from './realBrowserGuard.js';

describe('isRealBrowserCommand', () => {
  const pkg = `@playwright/mcp@${PLAYWRIGHT_MCP_VERSION}`;

  it('the default shared browser command, and the same package by other means', () => {
    expect(isRealBrowserCommand(PLAYWRIGHT_SHARED_BROWSER.command, PLAYWRIGHT_SHARED_BROWSER.args)).toBe(true);
    expect(isRealBrowserCommand('/usr/local/bin/npx', [pkg])).toBe(true);
    expect(isRealBrowserCommand('npm', ['exec', pkg, '--port', '1'])).toBe(true);
    expect(isRealBrowserCommand('C:\\Program Files\\nodejs\\npx.cmd', ['-y', '@playwright/mcp'])).toBe(true);
    // The package's own script run by Node: the research browser the app ships.
    expect(isRealBrowserCommand(process.execPath, ['/app/resources/node_modules/@playwright/mcp/cli.js', '--port', '1'])).toBe(true);
    expect(isRealBrowserCommand('node.exe', ['C:\\app\\node_modules\\@playwright\\mcp\\cli.js'])).toBe(true);
    expect(isRealBrowserCommand(process.execPath, ['/usr/lib/node_modules/npm/bin/npx-cli.js', '-y', pkg])).toBe(true);
    // Windows: a batch file goes through cmd.exe as one quoted line.
    expect(isRealBrowserCommand('C:\\Windows\\System32\\cmd.exe', ['/d', '/s', '/c', `"C:\\nodejs\\npx.cmd ^"-y^" ^"${pkg}^""`])).toBe(true);
    expect(isRealBrowserCommand('cmd.exe', ['/d', '/s', '/c', `"C:\\Program^ Files\\nodejs\\npx.cmd ^"-y^" ^"${pkg}^""`])).toBe(true);
  });

  it('other commands, also when an argument only mentions the package', () => {
    expect(isRealBrowserCommand('npx', ['-y', 'some-other-package'])).toBe(false);
    expect(isRealBrowserCommand(process.execPath, ['/repo/test/fixtures/fake-browser-server.mjs', '--port', '1'])).toBe(false);
    // A fake agent CLI handed a configuration that names the package starts nothing.
    expect(isRealBrowserCommand('/repo/test/fixtures/fake-cli.mjs', ['-c', `mcp_servers.pw={"command":"npx","args":["${pkg}"]}`])).toBe(false);
    expect(isRealBrowserCommand('cmd.exe', ['/d', '/s', '/c', `"C:\\tools\\fake-cli.cmd ^"npx ${pkg}^""`])).toBe(false);
    expect(isRealBrowserCommand('git', ['status'])).toBe(false);
  });
});

describe('isRealBrowserLine (a command given to a shell as one line)', () => {
  const pkg = `@playwright/mcp@${PLAYWRIGHT_MCP_VERSION}`;

  it('the default shared browser command as a line, alone or after another command', () => {
    expect(isRealBrowserLine(`npx -y ${pkg} --host 127.0.0.1 --port 1`)).toBe(true);
    expect(isRealBrowserLine(`"C:\\Program Files\\nodejs\\npx.cmd" -y "${pkg}"`)).toBe(true);
    expect(isRealBrowserLine(`cd /somewhere && npm exec ${pkg}`)).toBe(true);
    expect(isRealBrowserLine(`FOO=1 npx ${pkg}; echo done`)).toBe(true);
    expect(isRealBrowserLine('node /app/resources/node_modules/@playwright/mcp/cli.js --port 1')).toBe(true);
  });

  it('other lines, also when a quoted argument only mentions the package', () => {
    expect(isRealBrowserLine('git status')).toBe(false);
    expect(isRealBrowserLine('npx -y some-other-package')).toBe(false);
    expect(isRealBrowserLine(`/repo/test/fixtures/fake-cli.mjs -c 'mcp_servers.pw={"command":"npx","args":["${pkg}"]}'`)).toBe(false);
    expect(isRealBrowserLine(`/repo/test/fixtures/fake-cli.mjs --note "npx -y ${pkg}"`)).toBe(false);
  });
});

describe('the guard', () => {
  const pkg = `@playwright/mcp@${PLAYWRIGHT_MCP_VERSION}`;
  const REFUSED = /tried to start a real research browser server/;

  // Every way Node starts a process. Each is refused before anything is started, and recorded.
  const ways: Array<[string, () => unknown]> = [
    ['spawn with arguments', () => spawn('npx', ['-y', pkg])],
    ['spawn of one line through a shell', () => spawn(`npx -y ${pkg} --port 1`, { shell: true })],
    ['spawn of one line and an empty argument list through a named shell', () => spawn(`npx -y ${pkg}`, [], { shell: '/bin/sh' })],
    ['spawn with arguments through a shell', () => spawn('npx', ['-y', pkg], { shell: true })],
    ['spawnSync', () => spawnSync('npx', ['-y', pkg])],
    ['spawnSync of one line through a shell', () => spawnSync(`npx -y ${pkg}`, { shell: true })],
    ['execFile', () => execFile('npx', ['-y', pkg], () => {})],
    ['execFile, promisified', () => promisify(execFile)('npx', ['-y', pkg])],
    ['execFileSync', () => execFileSync('npx', ['-y', pkg])],
    ['exec', () => exec(`npx -y ${pkg} --port 1`, () => {})],
    ['exec, promisified', () => promisify(exec)(`npx -y ${pkg} --port 1`)],
    ['execSync', () => execSync(`npx -y ${pkg} --port 1`)],
    ['fork of the package\'s own script', () => fork('/app/resources/node_modules/@playwright/mcp/cli.js', ['--port', '1'])],
  ];
  for (const [name, start] of ways) {
    it(`refuses ${name}, naming the test, and starts no process`, () => {
      expect(start).toThrow(REFUSED);
      expect(start).toThrow(/realBrowserGuard\.test\.ts > the guard > refuses /);
      // Taken here: an attempt left recorded fails the test that made it (`test/setup.ts`).
      const attempts = takeRealBrowserAttempts();
      expect(attempts).toHaveLength(2);
      expect(attempts[0]).toContain('@playwright/mcp');
    });
  }

  it('leaves every other command alone, by each of those ways', async () => {
    const node = process.execPath;
    const exited = (child: { once(event: 'exit', done: (code: number | null) => void): unknown }) => new Promise((done) => child.once('exit', done));
    expect(await exited(spawn(node, ['-e', 'process.exit(7)']))).toBe(7);
    expect(await exited(spawn(`"${node}" -e "process.exit(6)"`, { shell: true }))).toBe(6);
    expect(spawnSync(node, ['-e', 'process.exit(5)']).status).toBe(5);
    expect(execFileSync(node, ['-p', '1 + 1'], { encoding: 'utf8' }).trim()).toBe('2');
    expect(execSync(`"${node}" -p "2 + 2"`, { encoding: 'utf8' }).trim()).toBe('4');
    // The promisified forms still answer with what was printed, as Node's own do.
    expect((await promisify(execFile)(node, ['-p', '3 + 3'])).stdout.trim()).toBe('6');
    expect((await promisify(exec)(`"${node}" -p "4 + 4"`)).stdout.trim()).toBe('8');
    expect(await new Promise((done) => execFile(node, ['-p', '5 + 5'], (_error, stdout) => done(String(stdout).trim())))).toBe('10');
    const script = join(mkdtempSync(join(tmpdir(), 'bif-guard-')), 'child.mjs');
    writeFileSync(script, 'process.exit(4);\n');
    expect(await exited(fork(script))).toBe(4);
    expect(takeRealBrowserAttempts()).toEqual([]);
  });

  it('refuses to spawn the default shared browser command, naming the test, and starts no process', () => {
    expect(() => spawn(PLAYWRIGHT_SHARED_BROWSER.command, PLAYWRIGHT_SHARED_BROWSER.args)).toThrow(
      /realBrowserGuard\.test\.ts > the guard > refuses to spawn the default shared browser command.* tried to start a real research browser server/,
    );
    expect(takeRealBrowserAttempts()).toEqual([[PLAYWRIGHT_SHARED_BROWSER.command, ...PLAYWRIGHT_SHARED_BROWSER.args].join(' ')]);
  });

  it('a shared browser built with the default configuration cannot start', async () => {
    const browser = new SharedBrowser({ config: structuredClone(defaultConfig), dataDir: mkdtempSync(join(tmpdir(), 'bif-guard-')), startTimeoutMs: 2000 });
    await expect(browser.ensure()).rejects.toThrow(/tried to start a real research browser server/);
    // Taken here: an attempt left recorded fails the test that made it (`test/setup.ts`).
    expect(takeRealBrowserAttempts()).toHaveLength(1);
    await browser.close();
  });
});
