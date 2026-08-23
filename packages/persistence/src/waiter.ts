import {
  isTerminal,
  jitter,
  AbortError,
  type Clock,
  type RequestId,
  type WorkflowRecord,
} from "@workflow/contracts";
import type { WorkflowRepository } from "./workflow-repository.js";

export interface PollingSettings {
  readonly initialDelayMs: number;
  readonly maxDelayMs: number;
  readonly backoffFactor: number;
  readonly jitterRatio: number;
}

export type WaitResult =
  | {
      readonly outcome: "TERMINAL";
      readonly workflow: WorkflowRecord;
      readonly attempts: number;
      readonly waitedMs: number;
    }
  | {
      readonly outcome: "TIMED_OUT";
      readonly attempts: number;
      readonly waitedMs: number;
    }
  | {
      readonly outcome: "ABORTED";
      readonly attempts: number;
      readonly waitedMs: number;
    }
  | {
      readonly outcome: "MISSING";
      readonly attempts: number;
      readonly waitedMs: number;
    };

/**
 * Turns asynchronous completion into a synchronous response.
 *
 * HTTP handlers depend on this interface and never on polling mechanics, so the waiting
 * strategy can change without touching request handling (INV-53).
 */
export interface WorkflowWaiter {
  waitForTerminalState(
    requestId: RequestId,
    deadlineAt: number,
    signal?: AbortSignal,
  ): Promise<WaitResult>;
}

/**
 * Bounded, deadline-aware, backoff-based, jittered polling of the authoritative item.
 *
 * Three properties matter and are each tested:
 *  - it never outlives `deadlineAt`, because every sleep is clamped to the remaining
 *    budget rather than checked afterwards;
 *  - it reads by exact key with strong consistency, so a terminal write that has already
 *    landed is never missed and turned into a needless 202;
 *  - giving up changes nothing. A timeout is an HTTP outcome, and the workflow is left
 *    exactly as it was (INV-51).
 */
export class DynamoWorkflowWaiter implements WorkflowWaiter {
  readonly #repository: WorkflowRepository;
  readonly #clock: Clock;
  readonly #polling: PollingSettings;
  readonly #random: () => number;

  constructor(options: {
    repository: WorkflowRepository;
    clock: Clock;
    polling: PollingSettings;
    random?: () => number;
  }) {
    this.#repository = options.repository;
    this.#clock = options.clock;
    this.#polling = options.polling;
    this.#random = options.random ?? Math.random;
  }

  async waitForTerminalState(
    requestId: RequestId,
    deadlineAt: number,
    signal?: AbortSignal,
  ): Promise<WaitResult> {
    const startedAt = this.#clock.now();
    let delay = this.#polling.initialDelayMs;
    let attempts = 0;

    const elapsed = (): number => this.#clock.now() - startedAt;

    for (;;) {
      if (signal?.aborted === true) {
        return { outcome: "ABORTED", attempts, waitedMs: elapsed() };
      }

      attempts += 1;
      const workflow = await this.#repository.getWorkflow(requestId);

      if (workflow === undefined) {
        return { outcome: "MISSING", attempts, waitedMs: elapsed() };
      }
      if (isTerminal(workflow.status)) {
        return { outcome: "TERMINAL", workflow, attempts, waitedMs: elapsed() };
      }

      const remaining = deadlineAt - this.#clock.now();
      if (remaining <= 0) {
        return { outcome: "TIMED_OUT", attempts, waitedMs: elapsed() };
      }

      // Clamped to the remaining budget: a sleep can never overshoot the deadline, which
      // is what keeps the response inside the ECS request budget.
      const sleepFor = Math.min(
        jitter(delay, this.#polling.jitterRatio, this.#random),
        remaining,
      );

      try {
        await this.#clock.sleep(sleepFor, signal);
      } catch (error) {
        if (error instanceof AbortError) {
          return { outcome: "ABORTED", attempts, waitedMs: elapsed() };
        }
        throw error;
      }

      delay = Math.min(delay * this.#polling.backoffFactor, this.#polling.maxDelayMs);
    }
  }
}
