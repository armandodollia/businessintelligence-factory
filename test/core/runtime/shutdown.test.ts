/**
 * One shutdown of the server process, however often it is asked for (`shutdownOnce`): a second
 * signal, or the shell's line after a signal, waits for the shutdown that is running and never ends
 * the process before the agents are stopped.
 */
import { describe, expect, it } from 'vitest';
import { shutdownOnce } from '../../../src/core/runtime/shutdown.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function world(opts: { closeMs?: number; closeFails?: boolean; limitMs?: number } = {}) {
  const log: string[] = [];
  let release: (() => void) | undefined;
  const shutdown = shutdownOnce({
    close: () =>
      new Promise<void>((done, fail) => {
        log.push('close started');
        release = () => {
          log.push('close ended');
          if (opts.closeFails) fail(new Error('close failed'));
          else done();
        };
        if (opts.closeMs !== undefined) setTimeout(release, opts.closeMs);
      }),
    killNow: () => log.push('killed by force'),
    exit: (code) => log.push(`exit ${code}`),
    limitMs: opts.limitMs ?? 5000,
    say: (line) => log.push(line),
  });
  return { log, shutdown, release: () => release!() };
}

describe('shutdownOnce', () => {
  it('closes, then exits', async () => {
    const w = world({ closeMs: 20 });
    await w.shutdown();
    expect(w.log).toEqual(['[bif] shutting down', 'close started', 'close ended', 'exit 0']);
  });

  it('asked again while it runs, it starts nothing and exits nothing early: every caller waits for the one shutdown', async () => {
    const w = world();
    const first = w.shutdown();
    const second = w.shutdown();
    const third = w.shutdown();
    expect(second).toBe(first);
    expect(third).toBe(first);
    await sleep(30);
    // The close is still running: nothing has ended the process.
    expect(w.log).toEqual(['[bif] shutting down', 'close started']);
    w.release();
    await Promise.all([first, second, third]);
    expect(w.log).toEqual(['[bif] shutting down', 'close started', 'close ended', 'exit 0']);
    // Asked after the end: still the same shutdown.
    await w.shutdown();
    expect(w.log.filter((l) => l === 'close started' || l.startsWith('exit'))).toEqual(['close started', 'exit 0']);
  });

  it('a close that takes longer than the limit: what is left is stopped by force, then the process exits, once', async () => {
    const w = world({ limitMs: 30 });
    await w.shutdown();
    expect(w.log).toEqual(['[bif] shutting down', 'close started', 'killed by force', 'exit 0']);
    // The close ending later changes nothing.
    w.release();
    await sleep(10);
    expect(w.log.filter((l) => l.startsWith('exit'))).toEqual(['exit 0']);
  });

  it('a close that fails still stops what is left by force before the process exits', async () => {
    const w = world({ closeMs: 10, closeFails: true });
    await w.shutdown();
    expect(w.log).toEqual(['[bif] shutting down', 'close started', 'close ended', 'killed by force', 'exit 0']);
  });

  it('a line that cannot be printed (nobody reads the output any more) does not stop the shutdown', async () => {
    const log: string[] = [];
    const shutdown = shutdownOnce({
      close: async () => void log.push('closed'),
      killNow: () => log.push('killed by force'),
      exit: (code) => log.push(`exit ${code}`),
      limitMs: 1000,
      say: () => {
        throw new Error('write EPIPE');
      },
    });
    await shutdown();
    expect(log).toEqual(['closed', 'exit 0']);
  });
});
