/**
 * How the desktop shell asks the server it started to stop (design
 * 2026-11-16-desktop-app-and-feedback-bundle-design.md §4.1): one line on the server's standard input.
 *
 * A signal is not enough. On Windows stopping a process ends it at once, without the server's own
 * shutdown, and the agents and the research browser it started would be left running. The standard
 * input is a pipe only the process that started the server holds, so no other program and no web
 * page can ask.
 *
 * The end of the input counts as the same request: the shell is gone (it crashed or was stopped),
 * and a server nobody can reach any more must not stay behind.
 *
 * The server listens only when the shell says so with `BIF_SHUTDOWN_ON_STDIN=1`. A checkout started
 * with `npm start` never reads its standard input.
 */
import { createInterface } from 'node:readline';

/** Set to `1` by the shell: the server reads its standard input for the shutdown line. */
export const STDIN_SHUTDOWN_ENV = 'BIF_SHUTDOWN_ON_STDIN';

/** The line that asks the server to shut down. */
export const SHUTDOWN_LINE = 'BIF_SHUTDOWN';

/** Why the server is asked to stop: the line came, or the input ended. */
export type ShutdownReason = 'asked' | 'input closed';

/** Calls `shutdown` once: when the shutdown line comes on `input`, or when `input` ends. */
export function onShutdownRequest(input: NodeJS.ReadableStream, shutdown: (why: ShutdownReason) => void): void {
  let done = false;
  const once = (why: ShutdownReason) => {
    if (done) return;
    done = true;
    shutdown(why);
  };
  const lines = createInterface({ input });
  lines.on('line', (line) => {
    if (line.trim() === SHUTDOWN_LINE) once('asked');
  });
  lines.once('close', () => once('input closed'));
  // A pipe whose other end is gone can fail instead of ending.
  input.once('error', () => once('input closed'));
}
