/** FIFO counting semaphore. `acquire()` resolves with a release function (idempotent). */
export class Semaphore {
  private active = 0;
  private readonly queue: Array<() => void> = [];

  constructor(private readonly limit: number) {
    if (!Number.isInteger(limit) || limit < 1) throw new Error(`semaphore limit must be >= 1 (got ${limit})`);
  }

  get inUse(): number {
    return this.active;
  }

  get waiting(): number {
    return this.queue.length;
  }

  async acquire(): Promise<() => void> {
    if (this.active < this.limit) {
      this.active++;
    } else {
      // The releaser hands its slot over directly, so `active` stays unchanged.
      await new Promise<void>((resolve) => this.queue.push(resolve));
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.queue.shift();
      if (next) next();
      else this.active--;
    };
  }
}
