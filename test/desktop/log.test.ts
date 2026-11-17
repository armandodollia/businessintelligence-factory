/** The log file of the packaged app (design 2026-11-16 §4.2): `<application folder>/logs/server.log`. */
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { LOG_FILE, openLog, PREVIOUS_LOG_FILE } from '../../desktop/log.js';

const work = realpathSync(mkdtempSync(join(tmpdir(), 'bif-log-')));
afterAll(() => rmSync(work, { recursive: true, force: true }));

describe('the log of the packaged app', () => {
  it('creates the logs folder and appends what it is given, at once', () => {
    const dir = join(work, 'new', 'logs');
    const log = openLog(dir);
    log('[bif] one\n');
    log('[bif] two\n');
    expect(readFileSync(join(dir, LOG_FILE), 'utf8')).toBe('[bif] one\n[bif] two\n');
  });

  it('starts a new file only when the old one has grown past the limit, and keeps one previous file', () => {
    const dir = join(work, 'grown');
    openLog(dir, { maxBytes: 10 })('start\n');
    // Under the limit the next start goes on in the same file.
    openLog(dir, { maxBytes: 10 })('a first start that wrote more than ten bytes\n');
    expect(readdirSync(dir)).toEqual([LOG_FILE]);
    openLog(dir, { maxBytes: 10 })('second\n');
    expect(readFileSync(join(dir, PREVIOUS_LOG_FILE), 'utf8')).toBe('start\na first start that wrote more than ten bytes\n');
    expect(readFileSync(join(dir, LOG_FILE), 'utf8')).toBe('second\n');
    openLog(dir, { maxBytes: 3 })('third\n');
    expect(readFileSync(join(dir, PREVIOUS_LOG_FILE), 'utf8')).toBe('second\n');
    expect(readdirSync(dir).sort()).toEqual([LOG_FILE, PREVIOUS_LOG_FILE].sort());
  });

  it('never stops the app when the log cannot be written', () => {
    const blocked = join(work, 'a-file');
    writeFileSync(blocked, 'not a folder');
    const log = openLog(join(blocked, 'logs'));
    expect(() => log('lost\n')).not.toThrow();
    expect(existsSync(join(blocked, 'logs'))).toBe(false);
  });
});
