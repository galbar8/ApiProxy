/* eslint-disable no-restricted-globals -- this module is the sleep abstraction itself */
/**
 * Time is injected everywhere it matters. Deadline behaviour is then tested by advancing
 * a fake clock rather than by sleeping, which keeps timeout tests deterministic and fast.
 */
export interface Clock {
  now(): number;
  /** Resolves after `ms`, or rejects with an AbortError if the signal fires first. */
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

export class AbortError extends Error {
  constructor(message = "aborted") {
    super(message);
    this.name = "AbortError";
  }
}

export const systemClock: Clock = {
  now: () => Date.now(),
  sleep: (ms, signal) =>
    new Promise<void>((resolve, reject) => {
      if (signal?.aborted === true) {
        reject(new AbortError());
        return;
      }
      const timer = setTimeout(() => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      const onAbort = (): void => {
        clearTimeout(timer);
        reject(new AbortError());
      };
      signal?.addEventListener("abort", onAbort, { once: true });
    }),
};

/**
 * Full jitter around a base delay, clamped so a sleep can never overrun a deadline.
 * Concurrent waiters desynchronise instead of stampeding DynamoDB together.
 */
export const jitter = (
  baseDelayMs: number,
  ratio: number,
  random: () => number = Math.random,
): number => {
  if (ratio <= 0) return baseDelayMs;
  const spread = baseDelayMs * ratio;
  const offset = (random() * 2 - 1) * spread;
  return Math.max(0, Math.round(baseDelayMs + offset));
};
