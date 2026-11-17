/**
 * The log of the packaged app (design 2026-11-16-desktop-app-and-feedback-bundle-design.md §4.2):
 * everything the server prints, and the shell's own lines, in `<application folder>/logs/server.log`.
 * The server writes no log file itself.
 *
 * One file, kept across starts. When it has grown past `maxBytes` at a start it becomes
 * `server.previous.log` (replacing the one before) and a new file begins, so the folder holds two
 * files at most.
 */
import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';

export const LOG_FILE = 'server.log';
export const PREVIOUS_LOG_FILE = 'server.previous.log';

const MAX_BYTES = 5 * 1024 * 1024;

/**
 * Opens the log in `logsDir` and returns the function that appends to it. Each append is written at
 * once, so nothing is lost when the app ends. A log that cannot be written never stops the app.
 */
export function openLog(logsDir: string, opts: { maxBytes?: number } = {}): (text: string) => void {
  const file = join(logsDir, LOG_FILE);
  try {
    mkdirSync(logsDir, { recursive: true });
    const size = statSync(file, { throwIfNoEntry: false })?.size ?? 0;
    if (size > (opts.maxBytes ?? MAX_BYTES)) renameSync(file, join(logsDir, PREVIOUS_LOG_FILE));
  } catch {
    // The appends below say nothing either: the app runs without a log.
  }
  return (text) => {
    try {
      appendFileSync(file, text);
    } catch {
      // as above
    }
  };
}
