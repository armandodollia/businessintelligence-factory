/**
 * The one shutdown of the server process (design
 * 2026-11-16-desktop-app-and-feedback-bundle-design.md §4.1).
 *
 * A shutdown can be asked for more than once: Ctrl-C pressed twice, SIGTERM after SIGINT, the desktop
 * shell's line after a signal. Every request after the first waits for the shutdown that is running.
 * None starts a second one and none ends the process early: the first shutdown is what stops the
 * running agents, and an agent that ignores the polite stop is only stopped by force when the kill
 * grace is over.
 *
 * The process ends when the close has ended, or when it took longer than the limit; then, and when
 * the close failed, whatever is still running is stopped by force first.
 */
export type ShutdownSteps = {
  /** Stops everything in order and resolves when it is done (`Booted.close`). */
  close(): Promise<void>;
  /** Stops what is still running at once and by force, synchronously (`Supervisor.killRunsNow`). */
  killNow(): void;
  /** Ends the process. */
  exit(code: number): void;
  /** How long the close may take before the process ends anyway. */
  limitMs: number;
  /** Prints a line. A line that cannot be printed is dropped. */
  say?(line: string): void;
};

/**
 * Returns the function every shutdown trigger calls. The first call starts the shutdown; every call
 * returns the same promise, which resolves when the process was told to exit.
 */
export function shutdownOnce(steps: ShutdownSteps): () => Promise<void> {
  let running: Promise<void> | undefined;
  const start = () =>
    new Promise<void>((done) => {
      try {
        steps.say?.('[bif] shutting down');
      } catch {
        // nobody reads the output any more: the shutdown goes on
      }
      let ended = false;
      const end = (force: boolean) => {
        if (ended) return;
        ended = true;
        clearTimeout(timer);
        if (force) {
          try {
            steps.killNow();
          } catch {
            // already gone
          }
        }
        steps.exit(0);
        done();
      };
      // A shutdown that does not end: whatever agent is still running is stopped by force, then the process exits.
      const timer = setTimeout(() => end(true), steps.limitMs);
      steps.close().then(
        () => end(false),
        () => end(true),
      );
    });
  return () => (running ??= start());
}
