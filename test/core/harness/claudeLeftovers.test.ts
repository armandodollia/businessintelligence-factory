/**
 * What a Claude Code run leaves outside BIF's data folder is removed by `removeClaudeRunLeftovers`: only paths
 * derived from the run itself (its working directory, its session ids), each checked to lie inside the folder it
 * belongs in. Nothing else of the person's Claude folder or of the temp folder is touched. No CLI is started.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  claudeFolders, claudeProjectDirName, cliSessionId, removeClaudeRunLeftovers,
} from '../../../src/core/harness/cliLeftovers.js';

const SID = '8d79edb1-3eab-447b-97f5-1a3924ecf8ca';
const OTHER_SID = '11111111-2222-4333-8444-555555555555';

/** A Claude folder and a temp root with one run's leftovers and the person's own files beside them. */
function world() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'bif-claude-leftovers-')));
  const configDir = join(base, 'claude');
  const tmpRoot = join(base, 'tmp', 'claude-501');
  const cwd = join(base, 'data', 'ws_a', 'runs', 'arun_x', 'cwd');
  mkdirSync(cwd, { recursive: true });
  const name = claudeProjectDirName(cwd)!;
  const put = (p: string, text = 'x') => {
    mkdirSync(join(p, '..'), { recursive: true });
    writeFileSync(p, text);
  };
  // The run's own.
  mkdirSync(join(configDir, 'projects', name, 'memory'), { recursive: true });
  put(join(configDir, 'projects', name, '01a64a2a-2834-490e-a682-b580c9a72117', 'tool-results', 'b8wdwz08t.txt'), 'page text');
  mkdirSync(join(configDir, 'session-env', SID), { recursive: true });
  put(join(tmpRoot, name, SID, 'tasks', 'b7p43otmf.output'), 'command output');
  // The person's own.
  const own = [
    join(configDir, 'projects', '-Users-someone-code-app', 'a.jsonl'),
    join(configDir, 'projects', `${name}-older`, 'b.jsonl'),
    join(configDir, 'session-env', OTHER_SID, 'env'),
    join(configDir, 'shell-snapshots', 'snapshot-zsh-1-abc.sh'),
    join(configDir, 'history.jsonl'),
    join(tmpRoot, '-Users-someone-code-app', OTHER_SID, 'tasks', 'c.output'),
  ];
  for (const p of own) put(p);
  return { base, configDir, tmpRoot, cwd, name, own };
}

describe('removeClaudeRunLeftovers', () => {
  it("removes the run's project folder (tool results included), its session-env folder and its temp folder; nothing else", () => {
    const w = world();
    const removed = removeClaudeRunLeftovers({ cwd: w.cwd, sessionIds: [SID] }, { configDir: w.configDir, tmpRoot: w.tmpRoot });
    expect(existsSync(join(w.configDir, 'projects', w.name))).toBe(false);
    expect(existsSync(join(w.configDir, 'session-env', SID))).toBe(false);
    expect(existsSync(join(w.tmpRoot, w.name))).toBe(false);
    expect(removed.sort()).toEqual([join(w.configDir, 'projects', w.name), join(w.configDir, 'session-env', SID), join(w.tmpRoot, w.name)].sort());
    for (const p of w.own) expect(existsSync(p)).toBe(true);
    // The run's own folder in the data folder is BIF's: untouched.
    expect(existsSync(w.cwd)).toBe(true);
  });

  it('is safe to call again, and when nothing was left (or the folders do not exist)', () => {
    const w = world();
    removeClaudeRunLeftovers({ cwd: w.cwd, sessionIds: [SID] }, { configDir: w.configDir, tmpRoot: w.tmpRoot });
    expect(removeClaudeRunLeftovers({ cwd: w.cwd, sessionIds: [SID] }, { configDir: w.configDir, tmpRoot: w.tmpRoot })).toEqual([]);
    expect(removeClaudeRunLeftovers({ cwd: w.cwd, sessionIds: [SID] }, { configDir: join(w.base, 'none'), tmpRoot: join(w.base, 'none2') })).toEqual([]);
    for (const p of w.own) expect(existsSync(p)).toBe(true);
  });

  it('a session id that is not a UUID is ignored (no path is built from it)', () => {
    const w = world();
    for (const bad of ['..', '../session-env', '', 'abc', `${SID}/..`]) {
      removeClaudeRunLeftovers({ cwd: join(w.base, 'elsewhere'), sessionIds: [bad] }, { configDir: w.configDir, tmpRoot: w.tmpRoot });
    }
    expect(readdirSync(join(w.configDir, 'session-env')).sort()).toEqual([OTHER_SID, SID].sort());
    for (const p of w.own) expect(existsSync(p)).toBe(true);
  });

  it('a leftover that is a link is removed as a link: what it points to stays', () => {
    const w = world();
    const outside = join(w.base, 'outside');
    mkdirSync(outside);
    writeFileSync(join(outside, 'keep.txt'), 'keep');
    mkdirSync(join(w.configDir, 'session-env'), { recursive: true });
    const sid = '22222222-3333-4444-8555-666666666666';
    symlinkSync(outside, join(w.configDir, 'session-env', sid), 'dir');
    removeClaudeRunLeftovers({ cwd: w.cwd, sessionIds: [sid] }, { configDir: w.configDir, tmpRoot: w.tmpRoot });
    expect(existsSync(join(w.configDir, 'session-env', sid))).toBe(false);
    expect(existsSync(join(outside, 'keep.txt'))).toBe(true);
  });

  it('a working directory whose folder name Claude Code shortens with a hash: nothing is guessed, nothing removed', () => {
    const w = world();
    const long = join(w.base, 'd'.repeat(220), 'cwd');
    expect(claudeProjectDirName(long)).toBeUndefined();
    const before = readdirSync(join(w.configDir, 'projects')).sort();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      removeClaudeRunLeftovers({ cwd: long, sessionIds: [] }, { configDir: w.configDir, tmpRoot: w.tmpRoot });
      // Said in the server log: that folder stays.
      expect(warn.mock.calls.map((c) => String(c[0])).join('\n')).toContain('longer than 200 characters');
    } finally {
      warn.mockRestore();
    }
    expect(readdirSync(join(w.configDir, 'projects')).sort()).toEqual(before);
  });

  it("the project folder name is Claude Code's: every character but letters and digits becomes '-'", () => {
    expect(claudeProjectDirName('/private/var/folders/T/bif-probe-sinYZH/runs/arun_probe/cwd')).toBe('-private-var-folders-T-bif-probe-sinYZH-runs-arun-probe-cwd');
    expect(claudeProjectDirName('C:\\Users\\me\\data\\ws_a\\runs\\arun_1\\cwd')).toBe('C--Users-me-data-ws-a-runs-arun-1-cwd');
  });
});

describe('claudeFolders', () => {
  it('CLAUDE_CONFIG_DIR, else ~/.claude; the temp root is <CLAUDE_CODE_TMPDIR or /tmp>/claude-<uid>, none without a uid (Windows)', () => {
    expect(claudeFolders({}, '/home/u', 501)).toEqual({ configDir: join('/home/u', '.claude'), tmpRoot: join('/tmp', 'claude-501') });
    expect(claudeFolders({ CLAUDE_CONFIG_DIR: '/x/cfg', CLAUDE_CODE_TMPDIR: '/x/tmp' }, '/home/u', 7)).toEqual({ configDir: '/x/cfg', tmpRoot: join('/x/tmp', 'claude-7') });
    expect(claudeFolders({}, 'C:\\Users\\me', null)).toEqual({ configDir: join('C:\\Users\\me', '.claude') });
  });
});

describe('cliSessionId', () => {
  it('a valid UUID derived from the run and the attempt: the same each time, different per attempt and per run', () => {
    const a = cliSessionId('arun_1', 1);
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(cliSessionId('arun_1', 1)).toBe(a);
    expect(cliSessionId('arun_1', 2)).not.toBe(a);
    expect(cliSessionId('arun_2', 1)).not.toBe(a);
  });
});
