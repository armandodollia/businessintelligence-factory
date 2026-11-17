/**
 * Which files an agent may hand over with `save_artifact` (`file_path`): those of its own working
 * directory, and those of the temp folder that are not in the data folder. The rule is tested here
 * for both kinds of path, whatever machine the test runs on: Windows paths have back-slashes and
 * drive letters (design 2026-11-16 §5). The handler's own tests (tools.test.ts) cover symlinks and
 * the answer an agent gets.
 */
import { posix, win32 } from 'node:path';
import { describe, expect, it } from 'vitest';
import { allowedRunPath } from '../../../src/core/harness/paths.js';

describe('the allowed folders of save_artifact, on Windows paths', () => {
  const dataDir = 'C:\\Users\\t\\AppData\\Roaming\\Business Intelligence Factory\\data';
  const where = { cwd: `${dataDir}\\ws_1\\runs\\run_1\\cwd`, tmp: 'C:\\Users\\t\\AppData\\Local\\Temp', dataDir };
  const allowed = (file: string) => allowedRunPath(win32.resolve(file), where, win32);

  it('allows a file of the run\'s own working directory, and of a folder in it', () => {
    expect(allowed(`${where.cwd}\\shot.png`)).toBe(true);
    expect(allowed(`${where.cwd}\\out\\page 1.png`)).toBe(true);
    expect(allowed(where.cwd)).toBe(true);
  });

  it('takes a drive letter and a name in any case, and a forward slash for a back-slash', () => {
    expect(allowed(`c:\\users\\T\\appdata\\roaming\\business intelligence factory\\DATA\\ws_1\\runs\\run_1\\cwd\\shot.png`)).toBe(true);
    expect(allowed(`${where.cwd.replace(/\\/g, '/')}/shot.png`)).toBe(true);
  });

  it('refuses the files of another run, the database, and a way out with ..', () => {
    expect(allowed(`${dataDir}\\ws_1\\runs\\run_2\\cwd\\shot.png`)).toBe(false);
    expect(allowed(`${dataDir}\\ws_1\\runs\\run_1\\events.jsonl`)).toBe(false);
    expect(allowed(`${dataDir}\\bif.db`)).toBe(false);
    expect(allowed(`${where.cwd}\\..\\..\\run_2\\cwd\\shot.png`)).toBe(false);
    expect(allowed(`${where.cwd}\\..\\..\\..\\..\\bif.db`)).toBe(false);
  });

  it('refuses a folder that only begins like the working directory', () => {
    expect(allowed(`${where.cwd}-other\\shot.png`)).toBe(false);
    expect(allowed(`${where.cwd}2\\shot.png`)).toBe(false);
  });

  it('refuses the same path on another drive, and a network share', () => {
    expect(allowed(`D:${where.cwd.slice(2)}\\shot.png`)).toBe(false);
    expect(allowed(`\\\\server\\share\\${where.cwd.slice(3)}\\shot.png`)).toBe(false);
    expect(allowed('D:\\Temp\\shot.png')).toBe(false);
  });

  it('allows a file of the temp folder, and nothing else of the person\'s disk', () => {
    expect(allowed(`${where.tmp}\\bif-browser-output\\page.png`)).toBe(true);
    expect(allowed(`${where.tmp.toUpperCase()}\\page.png`)).toBe(true);
    expect(allowed('C:\\Users\\t\\Documents\\private.docx')).toBe(false);
    expect(allowed('C:\\Users\\t\\AppData\\Local\\Temporary\\page.png')).toBe(false);
    expect(allowed('C:\\Windows\\System32\\config\\SAM')).toBe(false);
  });

  it('refuses the data folder also when it lies in the temp folder', () => {
    const inTemp = { cwd: `${where.tmp}\\data\\ws_1\\runs\\run_1\\cwd`, tmp: where.tmp, dataDir: `${where.tmp}\\data` };
    expect(allowedRunPath(`${inTemp.cwd}\\shot.png`, inTemp, win32)).toBe(true);
    expect(allowedRunPath(`${where.tmp}\\DATA\\bif.db`, inTemp, win32)).toBe(false);
    expect(allowedRunPath(`${where.tmp}\\data\\ws_1\\runs\\run_2\\cwd\\shot.png`, inTemp, win32)).toBe(false);
    expect(allowedRunPath(`${where.tmp}\\elsewhere\\page.png`, inTemp, win32)).toBe(true);
  });
});

describe('the allowed folders of save_artifact, on POSIX paths', () => {
  const where = { cwd: '/home/t/data/ws_1/runs/run_1/cwd', tmp: '/tmp', dataDir: '/home/t/data' };
  const allowed = (file: string) => allowedRunPath(posix.resolve(file), where, posix);

  it('is the same rule: the working directory and the temp folder, not another run, not a look-alike, not a way out', () => {
    expect(allowed('/home/t/data/ws_1/runs/run_1/cwd/shot.png')).toBe(true);
    expect(allowed('/tmp/bif-browser-output/page.png')).toBe(true);
    expect(allowed('/home/t/data/ws_1/runs/run_2/cwd/shot.png')).toBe(false);
    expect(allowed('/home/t/data/ws_1/runs/run_1/cwd-other/shot.png')).toBe(false);
    expect(allowed('/home/t/data/ws_1/runs/run_1/cwd/../../run_2/cwd/shot.png')).toBe(false);
    expect(allowed('/home/t/.ssh/id_ed25519')).toBe(false);
    // Here the case is part of a name, and a back-slash is a character of one.
    expect(allowed('/home/t/data/ws_1/runs/run_1/CWD/shot.png')).toBe(false);
    expect(allowed('/tmp/a\\..\\..\\home\\t\\.ssh\\id_ed25519')).toBe(true); // one odd file name inside /tmp, not a way out
    expect(allowed('/tmp\\..\\home\\t\\.ssh\\id_ed25519')).toBe(false); // one odd name beside /tmp
  });
});
