/**
 * The hosted build (design 2026-11-16 §4.5), read as text: it cannot be run from a checkout, so this
 * checks what a mistake here would cost: the package scripts it runs exist, an unsigned build needs no
 * secret, only the release job may write, and the release notes say what was tried on Windows. The
 * shape and order of its steps are not repeated here.
 */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(import.meta.dirname, '..', '..');
// Line endings as in the repository, whatever the checkout made of them.
const workflow = readFileSync(join(ROOT, '.github', 'workflows', 'desktop.yml'), 'utf8').replaceAll('\r\n', '\n');
const scripts = (JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { scripts: Record<string, string> }).scripts;

/** The text of one job: from its name to the next job (jobs are indented by two spaces). */
function job(name: string): string {
  const start = workflow.indexOf(`\n  ${name}:\n`);
  expect(start, `job ${name}`).toBeGreaterThan(-1);
  const next = workflow.slice(start + 1).search(/\n {2}[a-z]+:\n/);
  return next === -1 ? workflow.slice(start) : workflow.slice(start, start + 1 + next);
}

describe('the hosted desktop build', () => {
  it('runs only package scripts that exist', () => {
    const used = [...workflow.matchAll(/npm run ([a-z:-]+)/g)].map((m) => m[1]!);
    expect(used.length).toBeGreaterThan(0);
    for (const name of used) expect(scripts[name], name).toBeTypeOf('string');
    expect(scripts.test).toBeTypeOf('string'); // `npm test`
  });

  it('needs no secret for an unsigned build: every secret it names is a signing variable handed to the build, which takes an empty one as absent', () => {
    const named = [...workflow.matchAll(/^\s*([A-Z_]+): \$\{\{ secrets\.([A-Z_]+) \}\}$/gm)].map((m) => m[1]!);
    expect(named.sort()).toEqual(['APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_ID', 'APPLE_TEAM_ID', 'CSC_KEY_PASSWORD', 'CSC_LINK', 'WIN_CSC_KEY_PASSWORD', 'WIN_CSC_LINK']);
    // No other use of a secret anywhere (a step condition, a login, an upload).
    expect(workflow.match(/secrets\./g)).toHaveLength(named.length);
    // The release job uses the token of the run itself.
    expect(job('release')).toContain('GH_TOKEN: ${{ github.token }}');
  });

  it('attaches the installers of both platforms to a draft release, and only the release job may write', () => {
    const release = job('release');
    expect(release).toContain('needs: [mac, windows]');
    expect(release).toMatch(/gh release create "\$TAG" installers\/\* --draft /);
    expect(release).toContain('contents: write');
    expect(workflow).toMatch(/\npermissions:\n {2}contents: read\n/);
    expect(job('mac')).not.toContain('contents: write');
    expect(job('windows')).not.toContain('contents: write');
  });

  it('says in the release notes what has and has not been tried on Windows', () => {
    const release = job('release');
    expect(release).toContain('the test suite and two real research runs had passed on one Windows machine');
    expect(release).toContain('the Windows installer itself had not been tried on a real machine');
  });
});
