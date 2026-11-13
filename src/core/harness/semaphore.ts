import { AbortError } from '../events.js';

/** FIFO counting semaphore. `acquire()` resolves with a release function (idempotent). */
export class Semaphore {
  private active = 0;
  private readonly queue: Array<{ grant: () => void }> = [];

  constructor(private readonly limit: number) {
    if (!Number.isInteger(limit) || limit < 1) throw new Error(`semaphore limit must be >= 1 (got ${limit})`);
  }

  get inUse(): number {
    return this.active;
  }

  get waiting(): number {
    return this.queue.length;
  }

  /** Waits for a slot. Rejects with `AbortError` (and leaves the queue) if `signal` aborts first. */
  async acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) throw new AbortError();
    if (this.active < this.limit) {
      this.active++;
    } else {
      // The releaser hands its slot over directly, so `active` stays unchanged.
      await new Promise<void>((resolve, reject) => {
        const entry = {
          grant: () => {
            signal?.removeEventListener('abort', onAbort);
            resolve();
          },
        };
        const onAbort = () => {
          const i = this.queue.indexOf(entry);
          if (i >= 0) this.queue.splice(i, 1);
          reject(new AbortError());
        };
        signal?.addEventListener('abort', onAbort, { once: true });
        this.queue.push(entry);
      });
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.queue.shift();
      if (next) next.grant();
      else this.active--;
    };
  }
}
