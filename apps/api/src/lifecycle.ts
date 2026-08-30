import type { Logger } from "@workflow/observability";

export type LifecycleState = "STARTING" | "READY" | "DRAINING" | "STOPPED";

/**
 * Readiness and shutdown as one small, testable object.
 *
 * The shutdown signal is what makes graceful drain correct rather than merely polite:
 * in-flight synchronous waits are aborted, so they return a controlled `202` instead of
 * being severed mid-request. The workflows themselves are untouched — a draining task is
 * not a business event (INV-51, INV-12).
 */
export class Lifecycle {
  #state: LifecycleState = "STARTING";
  readonly #shutdown = new AbortController();

  get state(): LifecycleState {
    return this.#state;
  }

  /** Liveness stays true while draining: the process is healthy, just not accepting work. */
  get isLive(): boolean {
    return this.#state !== "STOPPED";
  }

  get isReady(): boolean {
    return this.#state === "READY";
  }

  get isAcceptingWork(): boolean {
    return this.#state === "READY";
  }

  get shutdownSignal(): AbortSignal {
    return this.#shutdown.signal;
  }

  markReady(): void {
    if (this.#state === "STARTING") this.#state = "READY";
  }

  beginDrain(logger?: Logger): void {
    if (this.#state === "DRAINING" || this.#state === "STOPPED") return;
    this.#state = "DRAINING";
    logger?.info({ state: this.#state }, "draining: readiness is now unhealthy");
  }

  /** Aborts synchronous waits so requests finish quickly instead of being cut off. */
  abortWaits(logger?: Logger): void {
    if (!this.#shutdown.signal.aborted) {
      this.#shutdown.abort();
      logger?.info("aborting in-flight synchronous waits; workflows are unaffected");
    }
  }

  markStopped(): void {
    this.#state = "STOPPED";
  }
}
