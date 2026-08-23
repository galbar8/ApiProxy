import { describe, expect, it, vi } from "vitest";
import { AbortError, type RequestId, type WorkflowRecord } from "@workflow/contracts";
import { FakeClock } from "@workflow/testing";
import { DynamoWorkflowWaiter, type PollingSettings } from "./waiter.js";
import type { WorkflowRepository } from "./workflow-repository.js";

const requestId = "3f2504e0-4f89-41d3-9a0c-0305e82c3301" as RequestId;

const polling: PollingSettings = {
  initialDelayMs: 50,
  maxDelayMs: 1_000,
  backoffFactor: 2,
  jitterRatio: 0,
};

const workflow = (status: WorkflowRecord["status"]): WorkflowRecord =>
  ({
    requestId,
    tenantId: "acme",
    idempotencyKey: "idem-000000001",
    status,
    workflowVersion: 1,
    stateVersion: status === "PROCESSING" ? 0 : 1,
    payloadHash: "a".repeat(64),
    input: {},
    createdAt: 1,
    updatedAt: 1,
  }) as unknown as WorkflowRecord;

const repositoryReturning = (
  responses: (WorkflowRecord | undefined)[],
): { repository: WorkflowRepository; getWorkflow: ReturnType<typeof vi.fn> } => {
  const getWorkflow = vi.fn();
  for (const response of responses) {
    getWorkflow.mockResolvedValueOnce(response);
  }
  getWorkflow.mockResolvedValue(responses.at(-1));
  return {
    repository: { getWorkflow } as unknown as WorkflowRepository,
    getWorkflow,
  };
};

const makeWaiter = (
  responses: (WorkflowRecord | undefined)[],
  overrides: Partial<PollingSettings> = {},
  random: () => number = () => 0.5,
) => {
  const clock = new FakeClock();
  const { repository, getWorkflow } = repositoryReturning(responses);
  const waiter = new DynamoWorkflowWaiter({
    repository,
    clock,
    polling: { ...polling, ...overrides },
    random,
  });
  return { waiter, clock, getWorkflow };
};

describe("DynamoWorkflowWaiter", () => {
  it("returns immediately when the workflow is already terminal", async () => {
    const { waiter, clock, getWorkflow } = makeWaiter([workflow("COMPLETED")]);
    const result = await waiter.waitForTerminalState(requestId, clock.now() + 20_000);

    expect(result.outcome).toBe("TERMINAL");
    expect(result.attempts).toBe(1);
    expect(getWorkflow).toHaveBeenCalledTimes(1);
    expect(clock.sleeps).toHaveLength(0);
  });

  it("detects a terminal state that appears mid-wait", async () => {
    const { waiter, clock } = makeWaiter([
      workflow("PROCESSING"),
      workflow("PROCESSING"),
      workflow("FAILED"),
    ]);

    const pending = waiter.waitForTerminalState(requestId, clock.now() + 20_000);
    await clock.runNextSleep();
    await clock.runNextSleep();
    const result = await pending;

    expect(result.outcome).toBe("TERMINAL");
    expect(result.attempts).toBe(3);
  });

  it("stops at the deadline instead of polling forever", async () => {
    const { waiter, clock } = makeWaiter([workflow("PROCESSING")]);
    const deadline = clock.now() + 500;

    const pending = waiter.waitForTerminalState(requestId, deadline);
    // 50 + 100 + 200 + a clamped 150 exhausts the 500ms budget; further calls are no-ops.
    for (let i = 0; i < 6; i += 1) {
      await clock.runNextSleep();
    }
    const result = await pending;

    expect(result.outcome).toBe("TIMED_OUT");
    expect(clock.now()).toBeLessThanOrEqual(deadline);
  });

  it("never sleeps past the deadline", async () => {
    const { waiter, clock } = makeWaiter([workflow("PROCESSING")], {
      initialDelayMs: 1_000,
      maxDelayMs: 1_000,
    });
    const deadline = clock.now() + 120;

    const pending = waiter.waitForTerminalState(requestId, deadline);
    await clock.runNextSleep();
    await clock.runNextSleep();
    await pending;

    // The 1000ms base delay was clamped to the 120ms that remained.
    expect(Math.max(...clock.sleeps)).toBeLessThanOrEqual(120);
  });

  it("backs off progressively and caps the delay", async () => {
    const { waiter, clock } = makeWaiter([workflow("PROCESSING")], {
      initialDelayMs: 100,
      maxDelayMs: 400,
      backoffFactor: 2,
    });
    const controller = new AbortController();

    const pending = waiter.waitForTerminalState(
      requestId,
      clock.now() + 100_000,
      controller.signal,
    );
    for (let i = 0; i < 5; i += 1) {
      await clock.runNextSleep();
    }
    controller.abort();
    await pending;

    expect(clock.sleeps.slice(0, 5)).toEqual([100, 200, 400, 400, 400]);
  });

  it("applies jitter so concurrent waiters desynchronise", async () => {
    const { waiter, clock } = makeWaiter(
      [workflow("PROCESSING")],
      { initialDelayMs: 1_000, maxDelayMs: 1_000, jitterRatio: 0.2 },
      () => 0,
    );
    const controller = new AbortController();

    const pending = waiter.waitForTerminalState(
      requestId,
      clock.now() + 100_000,
      controller.signal,
    );
    await clock.runNextSleep();
    controller.abort();
    await pending;

    // random() === 0 maps to the bottom of the jitter window: 1000 - 20%.
    expect(clock.sleeps[0]).toBe(800);
  });

  it("aborts immediately when the caller disconnects", async () => {
    const { waiter, clock } = makeWaiter([workflow("PROCESSING")]);
    const controller = new AbortController();

    const pending = waiter.waitForTerminalState(
      requestId,
      clock.now() + 20_000,
      controller.signal,
    );
    await Promise.resolve();
    controller.abort();
    const result = await pending;

    expect(result.outcome).toBe("ABORTED");
  });

  it("does not even read when the signal is already aborted", async () => {
    const { waiter, clock, getWorkflow } = makeWaiter([workflow("PROCESSING")]);
    const controller = new AbortController();
    controller.abort();

    const result = await waiter.waitForTerminalState(
      requestId,
      clock.now() + 20_000,
      controller.signal,
    );

    expect(result.outcome).toBe("ABORTED");
    expect(getWorkflow).not.toHaveBeenCalled();
  });

  it("reports a missing workflow rather than waiting for one that will never exist", async () => {
    const { waiter, clock } = makeWaiter([undefined]);
    const result = await waiter.waitForTerminalState(requestId, clock.now() + 20_000);
    expect(result.outcome).toBe("MISSING");
  });

  it("reads once even when the deadline has already passed, so a boundary completion is not lost", async () => {
    const { waiter, clock, getWorkflow } = makeWaiter([workflow("COMPLETED")]);
    const result = await waiter.waitForTerminalState(requestId, clock.now() - 1);

    expect(result.outcome).toBe("TERMINAL");
    expect(getWorkflow).toHaveBeenCalledTimes(1);
  });

  it("propagates an unexpected repository error instead of reporting a timeout", async () => {
    const clock = new FakeClock();
    const getWorkflow = vi.fn().mockRejectedValue(new Error("throttled"));
    const waiter = new DynamoWorkflowWaiter({
      repository: { getWorkflow } as unknown as WorkflowRepository,
      clock,
      polling,
    });

    await expect(
      waiter.waitForTerminalState(requestId, clock.now() + 1_000),
    ).rejects.toThrow("throttled");
  });

  it("rethrows a non-abort sleep failure", async () => {
    const clock = new FakeClock();
    vi.spyOn(clock, "sleep").mockRejectedValue(new Error("clock exploded"));
    const waiter = new DynamoWorkflowWaiter({
      repository: {
        getWorkflow: vi.fn().mockResolvedValue(workflow("PROCESSING")),
      } as unknown as WorkflowRepository,
      clock,
      polling,
    });

    await expect(
      waiter.waitForTerminalState(requestId, clock.now() + 10_000),
    ).rejects.toThrow("clock exploded");
  });

  it("treats an AbortError from the clock as an abort, not a crash", async () => {
    const clock = new FakeClock();
    vi.spyOn(clock, "sleep").mockRejectedValue(new AbortError());
    const waiter = new DynamoWorkflowWaiter({
      repository: {
        getWorkflow: vi.fn().mockResolvedValue(workflow("PROCESSING")),
      } as unknown as WorkflowRepository,
      clock,
      polling,
    });

    const result = await waiter.waitForTerminalState(requestId, clock.now() + 10_000);
    expect(result.outcome).toBe("ABORTED");
  });
});
