import { AbortError, type Clock } from "@workflow/contracts";

const drainMicrotasks = (): Promise<void> =>
  new Promise((resolve) => {
    setImmediate(resolve);
  });

interface PendingSleep {
  readonly dueAt: number;
  readonly resolve: () => void;
  readonly reject: (error: unknown) => void;
  readonly cleanup: () => void;
}

/**
 * Deterministic time. Deadline and backoff behaviour is asserted by advancing this clock,
 * so timeout tests take microseconds and never flake on a slow machine.
 */
export class FakeClock implements Clock {
  #now: number;
  #pending: PendingSleep[] = [];
  readonly sleeps: number[] = [];

  constructor(startAt = 1_700_000_000_000) {
    this.#now = startAt;
  }

  now(): number {
    return this.#now;
  }

  sleep(ms: number, signal?: AbortSignal): Promise<void> {
    this.sleeps.push(ms);
    return new Promise<void>((resolve, reject) => {
      if (signal?.aborted === true) {
        reject(new AbortError());
        return;
      }
      const entry: PendingSleep = {
        dueAt: this.#now + ms,
        resolve,
        reject,
        cleanup: () => {
          signal?.removeEventListener("abort", onAbort);
        },
      };
      const onAbort = (): void => {
        this.#pending = this.#pending.filter((item) => item !== entry);
        reject(new AbortError());
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.#pending.push(entry);
    });
  }

  /** Advance time and release every sleep that has come due. */
  async advance(ms: number): Promise<void> {
    this.#now += ms;
    const due = this.#pending.filter((entry) => entry.dueAt <= this.#now);
    this.#pending = this.#pending.filter((entry) => entry.dueAt > this.#now);
    for (const entry of due) {
      entry.cleanup();
      entry.resolve();
    }
    // Let the woken code run to its next suspension point before the caller asserts.
    await drainMicrotasks();
  }

  /**
   * Release the next pending sleep regardless of its duration, waiting first for the
   * code under test to reach that sleep. Without the wait, a test that advances faster
   * than the awaited repository call would silently do nothing and then hang.
   */
  async runNextSleep(): Promise<void> {
    await this.#waitForPending();
    const next = this.#pending[0];
    if (next === undefined) return;
    await this.advance(Math.max(0, next.dueAt - this.#now));
  }

  async #waitForPending(maxTicks = 50): Promise<void> {
    for (let tick = 0; tick < maxTicks && this.#pending.length === 0; tick += 1) {
      await drainMicrotasks();
    }
  }

  get pendingCount(): number {
    return this.#pending.length;
  }
}
