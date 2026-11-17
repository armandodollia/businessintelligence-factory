/**
 * The research browser shipped inside the packaged app (design
 * 2026-11-16-desktop-app-and-feedback-bundle-design.md §4.4): the default shared browser command runs
 * the shipped `@playwright/mcp` with the current Node runtime instead of `npx`; a configuration that
 * sets its own command is respected; a checkout ships nothing and starts the browser as before.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PLAYWRIGHT_MCP_VERSION, PLAYWRIGHT_SHARED_BROWSER, defaultConfig } from '../../src/core/config/schema.js';
import { SharedBrowser, browserOutputDir, sharedBrowserCommand, shippedBrowser } from '../../src/core/harness/browser.js';

const FAKE_SERVER = join(import.meta.dirname, '../fixtures/fake-browser-server.mjs');
const ROOT = resolve(import.meta.dirname, '..', '..');

const cleanup: Array<() => unknown> = [];
afterEach(async () => {
  for (const f of cleanup.splice(0).reverse()) await f();
});

const shipped = { cli: '/app/resources/node_modules/@playwright/mcp/cli.js', version: PLAYWRIGHT_MCP_VERSION };
const REST = PLAYWRIGHT_SHARED_BROWSER.args.slice(2);

describe('sharedBrowserCommand', () => {
  it('the default command with a shipped browser: the app\'s Node runtime runs the shipped script, with the same arguments', () => {
    const out = sharedBrowserCommand(PLAYWRIGHT_SHARED_BROWSER, shipped, '/app/node');
    expect(out).toEqual({ ...PLAYWRIGHT_SHARED_BROWSER, command: '/app/node', args: [shipped.cli, ...REST] });
    expect(REST).toEqual(['--host', '127.0.0.1', '--port', '{{port}}', '--shared-browser-context', '--user-data-dir', '{{profileDir}}', '--output-dir', '{{outputDir}}', '--file-paths', 'absolute']);
    expect(out.args.join(' ')).not.toContain('npx');
    // The configuration is not changed.
    expect(PLAYWRIGHT_SHARED_BROWSER.command).toBe('npx');
  });

  it('uses the current Node runtime by default', () => {
    expect(sharedBrowserCommand(PLAYWRIGHT_SHARED_BROWSER, shipped).command).toBe(process.execPath);
  });

  it('the same pinned package written in a configuration file, with its own options, also uses the shipped browser', () => {
    const own = { ...PLAYWRIGHT_SHARED_BROWSER, args: ['@playwright/mcp@' + PLAYWRIGHT_MCP_VERSION, '--port', '{{port}}', '--headless'], port: 9000 };
    expect(sharedBrowserCommand(own, shipped, '/app/node')).toEqual({ ...own, command: '/app/node', args: [shipped.cli, '--port', '{{port}}', '--headless'] });
  });

  it('nothing shipped (a checkout): the command is the configured one, unchanged', () => {
    expect(sharedBrowserCommand(PLAYWRIGHT_SHARED_BROWSER, undefined)).toBe(PLAYWRIGHT_SHARED_BROWSER);
  });

  it('a configuration that sets its own command is respected', () => {
    const cases = [
      { ...PLAYWRIGHT_SHARED_BROWSER, command: '/usr/local/bin/my-browser-server' },
      { ...PLAYWRIGHT_SHARED_BROWSER, command: 'node', args: ['/somewhere/cli.js', '--port', '{{port}}'] },
      // Another version than the shipped one: the person asked for that version.
      { ...PLAYWRIGHT_SHARED_BROWSER, args: ['-y', '@playwright/mcp@0.0.1', '--port', '{{port}}'] },
      { ...PLAYWRIGHT_SHARED_BROWSER, args: ['-y', '@playwright/mcp', '--port', '{{port}}'] },
      { ...PLAYWRIGHT_SHARED_BROWSER, args: ['-y', 'some-other-package@' + PLAYWRIGHT_MCP_VERSION] },
    ];
    for (const own of cases) expect(sharedBrowserCommand(own, shipped, '/app/node'), JSON.stringify(own.args)).toBe(own);
  });
});

describe('shippedBrowser', () => {
  it('is nothing in a checkout, so `npm start` starts the browser as before', () => {
    expect(shippedBrowser()).toBeUndefined();
  });

  it('is the script and its version when the package is in the resources', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bif-shipped-'));
    const pkg = join(dir, 'node_modules', '@playwright', 'mcp');
    expect(shippedBrowser(join(pkg, 'cli.js'))).toBeUndefined();
    mkdirSync(pkg, { recursive: true });
    writeFileSync(join(pkg, 'cli.js'), '');
    writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: '@playwright/mcp', version: '0.0.85' }));
    expect(shippedBrowser(join(pkg, 'cli.js'))).toEqual({ cli: join(pkg, 'cli.js'), version: '0.0.85' });
  });

  it('the version the configuration pins is the version installed for shipping', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { dependencies: Record<string, string> };
    expect(pkg.dependencies['@playwright/mcp']).toBe(PLAYWRIGHT_MCP_VERSION);
    expect(PLAYWRIGHT_SHARED_BROWSER.args).toContain(`@playwright/mcp@${PLAYWRIGHT_MCP_VERSION}`);
  });
});

describe('SharedBrowser with a shipped browser', () => {
  it('starts the shipped script with the current Node runtime for the default configuration', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bif-shipped-'));
    const log = join(dir, 'launches.jsonl');
    const cfg = structuredClone(defaultConfig);
    cfg.browser.profileDir = join(dir, 'profile');
    // The default command (`npx -y @playwright/mcp@<pinned> …`); the environment only lets the stand-in say how it was started.
    cfg.browser.shared = { ...PLAYWRIGHT_SHARED_BROWSER, env: { FAKE_BROWSER_LOG: log } };
    const browser = new SharedBrowser({ config: cfg, dataDir: join(dir, 'data'), startTimeoutMs: 10_000, shipped: { cli: FAKE_SERVER, version: PLAYWRIGHT_MCP_VERSION } });
    cleanup.push(() => browser.close());
    const url = await browser.ensure();
    expect((await fetch(url)).status).toBe(405);
    expect(existsSync(log)).toBe(true);
    const [launch] = readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as { args: string[] });
    expect(launch!.args).toEqual([
      '--host', '127.0.0.1', '--port', new URL(url).port, '--shared-browser-context',
      '--user-data-dir', resolve(cfg.browser.profileDir), '--output-dir', browserOutputDir(), '--file-paths', 'absolute',
    ]);
  });
});
