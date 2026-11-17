/**
 * The desktop build (design 2026-11-16 §4.5): the shell's own package, and how the installer builder
 * is called. Unsigned unless the signing variables are present. No installer is built here.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { appArchiveProblem, builderRun, devAppDir, notPacked, packedServerDirs, prepareShell, shellPackage } from '../../desktop/build.js';
import { APP_NAME } from '../../src/core/runtime/paths.js';

const ROOT = resolve(import.meta.dirname, '..', '..');
const work = realpathSync(mkdtempSync(join(tmpdir(), 'bif-desktop-build-')));
afterAll(() => rmSync(work, { recursive: true, force: true }));

const rootPackage = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { name: string; version: string; description: string; scripts: Record<string, string> };

describe("the shell's own package", () => {
  it('is written next to the bundled shell, which leaves Electron to the app and holds no other package: nothing to install', async () => {
    const out = join(work, 'shell');
    const built = await prepareShell({ outDir: out });
    expect(built).toEqual({ outDir: out, entry: join(out, 'main.js'), version: rootPackage.version });
    const written = JSON.parse(readFileSync(join(out, 'package.json'), 'utf8')) as Record<string, unknown>;
    expect(written).toEqual(shellPackage(rootPackage));
    expect(written).toMatchObject({ version: rootPackage.version, productName: APP_NAME, main: 'main.js' });
    expect(written).not.toHaveProperty('dependencies');
    const code = readFileSync(built.entry, 'utf8');
    expect(code).toMatch(/from\s*"electron"/);
    // The shell is small: the rules beside it and three core modules, not the server or the configuration.
    expect(code.length).toBeLessThan(100_000);
    expect(code).not.toContain('node_modules');
    expect(existsSync(join(out, 'node_modules'))).toBe(false);
  });
});

describe('how the installer builder is called', () => {
  const clean = { HOME: '/home/builder', PATH: '/usr/bin' };

  it('builds the macOS installers unsigned when no signing variable is present: an ad-hoc signature, and no certificate of the builder is looked for', () => {
    const run = builderRun('mac', clean);
    expect(run.args).toEqual(['--mac', '--config', 'desktop/electron-builder.yml', '--publish', 'never', '-c.mac.identity=-', '-c.mac.hardenedRuntime=false', '--arm64', '--x64']);
    expect(run.env.CSC_IDENTITY_AUTO_DISCOVERY).toBe('false');
    expect(run.signed).toBe(false);
  });

  it('leaves signing to the builder when a certificate is given', () => {
    for (const env of [{ ...clean, CSC_LINK: 'base64-of-a-certificate', CSC_KEY_PASSWORD: 'secret' }, { ...clean, CSC_NAME: 'Developer ID Application: Example' }]) {
      const run = builderRun('mac', env);
      expect(run.args).toEqual(['--mac', '--config', 'desktop/electron-builder.yml', '--publish', 'never', '--arm64', '--x64']);
      expect(run.env.CSC_IDENTITY_AUTO_DISCOVERY).toBeUndefined();
      expect(run.signed).toBe(true);
      expect(run.env).toMatchObject(env);
    }
  });

  it('takes a signing variable that is empty as absent: a hosted build without secrets is an unsigned build', () => {
    const run = builderRun('mac', { ...clean, CSC_LINK: '', CSC_KEY_PASSWORD: '', APPLE_ID: '', APPLE_APP_SPECIFIC_PASSWORD: '', APPLE_TEAM_ID: '', WIN_CSC_LINK: '', WIN_CSC_KEY_PASSWORD: '' });
    expect(run.signed).toBe(false);
    expect(run.args).toContain('-c.mac.identity=-');
    for (const name of ['CSC_LINK', 'CSC_KEY_PASSWORD', 'APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_TEAM_ID', 'WIN_CSC_LINK', 'WIN_CSC_KEY_PASSWORD']) expect(run.env, name).not.toHaveProperty(name);
    expect(run.env.HOME).toBe('/home/builder');
  });

  it('builds the Windows installer unsigned without a certificate, signed with one', () => {
    const unsigned = builderRun('win', clean);
    expect(unsigned.args).toEqual(['--win', '--config', 'desktop/electron-builder.yml', '--publish', 'never', '--x64']);
    expect(unsigned.signed).toBe(false);
    expect(unsigned.env.CSC_IDENTITY_AUTO_DISCOVERY).toBe('false');
    expect(builderRun('win', { ...clean, WIN_CSC_LINK: 'base64' }).signed).toBe(true);
    expect(builderRun('win', { ...clean, CSC_LINK: 'base64' }).signed).toBe(true);
  });

  const architectures = (args: string[]) => args.filter((a) => ['--arm64', '--x64', '--ia32', '--armv7l', '--universal'].includes(a));

  it('builds every architecture of the platform by default: Apple silicon and Intel on macOS, x64 on Windows', () => {
    expect(architectures(builderRun('mac', clean).args)).toEqual(['--arm64', '--x64']);
    expect(architectures(builderRun('win', clean).args)).toEqual(['--x64']);
  });

  it('builds only the architecture that is asked for (`npm run dist:mac -- --arm64`: a quick build)', () => {
    expect(architectures(builderRun('mac', clean, ['--arm64']).args)).toEqual(['--arm64']);
    expect(architectures(builderRun('mac', clean, ['--x64']).args)).toEqual(['--x64']);
    expect(architectures(builderRun('mac', clean, ['--dir', '--x64', '--arm64']).args)).toEqual(['--x64', '--arm64']);
  });

  it('the configuration names no architecture: the arguments decide (a list there would win over them)', () => {
    const config = readFileSync(join(ROOT, 'desktop', 'electron-builder.yml'), 'utf8');
    expect(config.split('\n').filter((l) => !l.trim().startsWith('#')).join('\n')).not.toMatch(/^\s*arch:/m);
  });

  it('passes further arguments on, after its own', () => {
    expect(builderRun('mac', clean, ['--arm64']).args.slice(-1)).toEqual(['--arm64']);
    expect(builderRun('win', clean, ['--dir']).args).toEqual(['--win', '--config', 'desktop/electron-builder.yml', '--publish', 'never', '--x64', '--dir']);
  });

  it('never publishes: the files stay where they were built', () => {
    for (const target of ['mac', 'win'] as const) {
      const { args } = builderRun(target, { ...clean, GH_TOKEN: 'x' });
      expect(args.slice(args.indexOf('--publish'), args.indexOf('--publish') + 2)).toEqual(['--publish', 'never']);
    }
  });
});

describe('the check that the whole server is in the built app', () => {
  const file = (dir: string, rel: string, text = 'x') => {
    mkdirSync(join(dir, rel, '..'), { recursive: true });
    writeFileSync(join(dir, rel), text);
  };
  const built = join(work, 'server-built');
  for (const rel of ['main.js', 'pricing.json', 'prompts/worker.md', 'web/index.html', 'node_modules/@playwright/mcp/cli.js', 'node_modules/playwright-core/package.json']) file(built, rel, rel);

  it('finds nothing missing in a complete copy', () => {
    const packed = join(work, 'packed-complete');
    for (const rel of ['main.js', 'pricing.json', 'prompts/worker.md', 'web/index.html', 'node_modules/@playwright/mcp/cli.js', 'node_modules/playwright-core/package.json']) file(packed, rel, rel);
    expect(notPacked(built, packed)).toEqual([]);
  });

  it('names every file that was left out: the research browser, which the installer builder skips unless told', () => {
    const packed = join(work, 'packed-without-browser');
    for (const rel of ['main.js', 'pricing.json', 'prompts/worker.md', 'web/index.html']) file(packed, rel, rel);
    expect(notPacked(built, packed)).toEqual(['node_modules/@playwright/mcp/cli.js', 'node_modules/playwright-core/package.json']);
  });

  it('names a file that was cut short, and a folder that is not there at all', () => {
    const packed = join(work, 'packed-short');
    for (const rel of ['pricing.json', 'prompts/worker.md', 'web/index.html', 'node_modules/@playwright/mcp/cli.js', 'node_modules/playwright-core/package.json']) file(packed, rel, rel);
    file(packed, 'main.js', 'm');
    expect(notPacked(built, packed)).toEqual(['main.js']);
    expect(notPacked(built, join(work, 'no-such-folder'))).toHaveLength(6);
  });

  it('looks where the installer builder leaves each unpacked app', () => {
    const out = join(work, 'installers');
    mkdirSync(join(out, 'mac-arm64', 'Business Intelligence Factory.app', 'Contents', 'Resources', 'server'), { recursive: true });
    mkdirSync(join(out, 'mac', 'Business Intelligence Factory.app', 'Contents', 'Resources', 'server'), { recursive: true });
    mkdirSync(join(out, 'win-unpacked', 'resources', 'server'), { recursive: true });
    mkdirSync(join(out, 'something-else'), { recursive: true });
    expect(packedServerDirs(out).sort()).toEqual(
      [
        join(out, 'mac', 'Business Intelligence Factory.app', 'Contents', 'Resources', 'server'),
        join(out, 'mac-arm64', 'Business Intelligence Factory.app', 'Contents', 'Resources', 'server'),
        join(out, 'win-unpacked', 'resources', 'server'),
      ].sort(),
    );
    expect(packedServerDirs(join(work, 'no-such-folder'))).toEqual([]);
  });
});

describe("the check that the app archive holds the shell alone", () => {
  const resources = (name: string, archiveBytes?: number) => {
    const server = join(work, name, 'resources', 'server');
    mkdirSync(server, { recursive: true });
    if (archiveBytes !== undefined) writeFileSync(join(server, '..', 'app.asar'), Buffer.alloc(archiveBytes));
    return server;
  };

  it('accepts an archive of the size of the shell', () => {
    expect(appArchiveProblem(resources('archive-small', 30_000))).toBeUndefined();
  });

  it("refuses one that holds more: the project's packages were packed into it", () => {
    expect(appArchiveProblem(resources('archive-large', 5_000_000))).toMatch(/app\.asar is 5000000 bytes.*packages of the project/);
  });

  it('refuses an app without the archive', () => {
    expect(appArchiveProblem(resources('archive-missing'))).toMatch(/app\.asar is missing/);
  });
});

describe('the app icon', () => {
  it('is one PNG of 1024 by 1024 pixels in the checkout, made from assets/icon.svg', () => {
    const png = readFileSync(join(ROOT, 'assets', 'icon.png'));
    // A PNG file: its signature, then the IHDR chunk with the width and the height.
    expect(png.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
    expect(png.subarray(12, 16).toString('latin1')).toBe('IHDR');
    expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([1024, 1024]);
    expect(png.length).toBeLessThan(200_000);
  });
});

describe('the package scripts', () => {
  it('build the server before the shell, for a run from the checkout and for each installer', () => {
    for (const name of ['desktop:dev', 'dist:mac', 'dist:win']) expect(rootPackage.scripts[name], name).toMatch(/^npm run build:server && tsx desktop\/build\.ts --(run|mac|win)$/);
  });

  it('a run from the checkout keeps its files in the checkout, not in the application folder of the person', () => {
    expect(devAppDir()).toBe(join(ROOT, 'data', 'desktop-dev'));
  });
});
