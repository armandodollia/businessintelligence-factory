import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, win32 } from 'node:path';
import { describe, expect, it } from 'vitest';
import { defaultPricing } from '../../../src/core/harness/pricing.js';
import { loadPrompt, promptTemplate } from '../../../src/core/prompts/index.js';
import { openFolderCommand } from '../../../src/core/runtime/openFolder.js';
import { APP_NAME, appVersion, defaultAppDir, runtimePaths } from '../../../src/core/runtime/paths.js';
import { parsePortLine, portLine } from '../../../src/core/runtime/portLine.js';

const ROOT = resolve(import.meta.dirname, '..', '..', '..');
const SOURCE_HERE = join(ROOT, 'src', 'core', 'runtime');

describe('runtimePaths in a checkout (no environment set)', () => {
  const p = runtimePaths({ env: {}, here: SOURCE_HERE, cwd: ROOT });

  it("answers today's places: resources in the source tree, data and configuration in the working directory", () => {
    expect(p.packaged).toBe(false);
    expect(p.resources).toEqual({
      shipped: false,
      promptsDir: join(ROOT, 'src', 'core', 'prompts'),
      pricingPath: join(ROOT, 'src', 'core', 'harness', 'pricing.json'),
      webDist: join(ROOT, 'web', 'dist'),
      packageJson: join(ROOT, 'package.json'),
    });
    expect(p.configPath).toBe(join(ROOT, 'bif.config.json'));
    // The configuration's own `dataDir` applies (default `data`, relative to the working directory).
    expect(p.dataDir).toBeUndefined();
    expect(p.appDir).toBeUndefined();
    expect(p.logsDir).toBeUndefined();
  });

  it('ships no research browser: the checkout starts it as today', () => {
    expect(p.resources.shippedBrowserCli).toBeUndefined();
  });

  it('is where the price table in use is read from: the file of the source tree', () => {
    const inTree = JSON.parse(readFileSync(join(ROOT, 'src', 'core', 'harness', 'pricing.json'), 'utf8')) as { version: string };
    expect(defaultPricing().version).toBe(inTree.version);
  });

  it('reads every prompt byte for byte from the source tree, so prompt versions are unchanged', () => {
    const names = readdirSync(join(ROOT, 'src', 'core', 'prompts')).filter((f) => f.endsWith('.md')).map((f) => f.slice(0, -3));
    expect(names.length).toBeGreaterThan(20);
    for (const name of names) {
      const onDisk = readFileSync(join(ROOT, 'src', 'core', 'prompts', `${name}.md`));
      expect(Buffer.from(promptTemplate(name), 'utf8').equals(onDisk), name).toBe(true);
      expect(loadPrompt(name).version, name).toBe(createHash('sha256').update(onDisk).digest('hex').slice(0, 8));
    }
  });

  it('reads the app version from the package version', () => {
    const version = (JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { version: string }).version;
    expect(appVersion(p, {})).toBe(version);
    expect(appVersion()).toBe(version);
  });
});

describe('runtimePaths with shipped resources', () => {
  it('finds everything under the resources directory the shell names', () => {
    const res = join(tmpdir(), 'bif-res');
    const p = runtimePaths({ env: { BIF_RESOURCES_DIR: res }, here: SOURCE_HERE, cwd: ROOT });
    expect(p.resources).toEqual({
      shipped: true,
      promptsDir: join(res, 'prompts'),
      pricingPath: join(res, 'pricing.json'),
      webDist: join(res, 'web'),
      packageJson: join(res, 'package.json'),
      shippedBrowserCli: join(res, 'node_modules', '@playwright', 'mcp', 'cli.js'),
    });
    // Resources alone do not move the data: that is the application folder's job.
    expect(p.packaged).toBe(false);
    expect(p.configPath).toBe(join(ROOT, 'bif.config.json'));
  });

  it('a bundled server finds its resources next to itself, whatever the working directory', () => {
    const dist = join(tmpdir(), 'bif-dist', 'server');
    const p = runtimePaths({ env: {}, here: dist, bundled: true, cwd: tmpdir() });
    expect(p.resources.shipped).toBe(true);
    expect(p.resources.promptsDir).toBe(join(dist, 'prompts'));
    expect(p.resources.webDist).toBe(join(dist, 'web'));
    // The environment still wins, so the shell can keep resources elsewhere.
    expect(runtimePaths({ env: { BIF_RESOURCES_DIR: '/elsewhere' }, here: dist, bundled: true }).resources.promptsDir).toBe(join(resolve('/elsewhere'), 'prompts'));
  });

  it('resolves a relative resources directory against the working directory', () => {
    const p = runtimePaths({ env: { BIF_RESOURCES_DIR: 'res' }, here: SOURCE_HERE, cwd: ROOT });
    expect(p.resources.promptsDir).toBe(join(ROOT, 'res', 'prompts'));
  });
});

describe('runtimePaths with an application folder (packaged)', () => {
  it('puts data, configuration and logs in the application folder', () => {
    const app = join(tmpdir(), 'bif-app', APP_NAME);
    const p = runtimePaths({ env: { BIF_APP_DIR: app }, here: SOURCE_HERE, cwd: ROOT });
    expect(p.packaged).toBe(true);
    expect(p.appDir).toBe(app);
    expect(p.dataDir).toBe(join(app, 'data'));
    expect(p.configPath).toBe(join(app, 'bif.config.json'));
    expect(p.logsDir).toBe(join(app, 'logs'));
  });

  it('takes the app version the shell passes before the package version', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bif-paths-'));
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ version: '9.8.7' }));
    const p = runtimePaths({ env: { BIF_RESOURCES_DIR: dir }, here: SOURCE_HERE });
    expect(appVersion(p, {})).toBe('9.8.7');
    expect(appVersion(p, { BIF_APP_VERSION: '1.2.3-beta.4' })).toBe('1.2.3-beta.4');
    expect(appVersion(runtimePaths({ env: { BIF_RESOURCES_DIR: join(dir, 'missing') }, here: SOURCE_HERE }), {})).toBe('unknown');
  });
});

describe('defaultAppDir', () => {
  it('is the per-user application folder of each platform (design §4.2)', () => {
    expect(defaultAppDir('darwin', {}, '/Users/t')).toBe('/Users/t/Library/Application Support/Business Intelligence Factory');
    expect(defaultAppDir('win32', { APPDATA: 'C:\\Users\\t\\AppData\\Roaming' }, 'C:\\Users\\t')).toBe('C:\\Users\\t\\AppData\\Roaming\\Business Intelligence Factory');
    expect(defaultAppDir('win32', {}, 'C:\\Users\\t')).toBe(win32.join('C:\\Users\\t', 'AppData', 'Roaming', APP_NAME));
    expect(defaultAppDir('linux', { XDG_CONFIG_HOME: '/home/t/.cfg' }, '/home/t')).toBe('/home/t/.cfg/Business Intelligence Factory');
    expect(defaultAppDir('linux', {}, '/home/t')).toBe('/home/t/.config/Business Intelligence Factory');
  });
});

describe('the port line', () => {
  it('is one line the shell can parse back', () => {
    expect(portLine(54321)).toBe('BIF_PORT=54321');
    expect(parsePortLine(portLine(54321))).toBe(54321);
    expect(parsePortLine('BIF_PORT=4317\r')).toBe(4317);
  });

  it('is not found in any other line', () => {
    for (const line of ['[bif] listening on http://127.0.0.1:4317 (data: /x)', 'BIF_PORT=', 'BIF_PORT=abc', 'BIF_PORT=70000', 'BIF_PORT=0', ' x BIF_PORT=12', '']) {
      expect(parsePortLine(line), line).toBeUndefined();
    }
  });
});

describe('openFolderCommand', () => {
  it("is the platform's file manager with the folder as one argument, spaces and all", () => {
    const dir = '/Users/t/Library/Application Support/Business Intelligence Factory';
    expect(openFolderCommand(dir, 'darwin')).toEqual({ cmd: 'open', args: [dir] });
    expect(openFolderCommand('C:\\Users\\t\\AppData\\Roaming\\Business Intelligence Factory', 'win32')).toEqual({ cmd: 'explorer.exe', args: ['C:\\Users\\t\\AppData\\Roaming\\Business Intelligence Factory'] });
    expect(openFolderCommand('/home/t/.config/x; rm -rf ~', 'linux')).toEqual({ cmd: 'xdg-open', args: ['/home/t/.config/x; rm -rf ~'] });
  });
});
