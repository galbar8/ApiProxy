import { describe, expect, it } from "vitest";
import { systemClock, type RequestId, type WorkflowRecord } from "@workflow/contracts";
import { deriveExternalRef } from "@workflow/idempotency";
import type { WorkflowRepository } from "@workflow/persistence";
import {
  anSqsEvent,
  anSqsRecord,
  aRequestId,
  aTenantId,
  anOperation,
  silentObservability,
} from "@workflow/testing";
import { createFinalizerHandler } from "./handler.js";
import type { ProviderClient } from "./provider-client.js";

const enrichment = {
  normalizedReference: "REF-1",
  riskBand: "LOW" as const,
  enrichedAt: 1_700_000_000_000,
};

const finalizeRecord = (requestId: RequestId) =>
  anSqsRecord(
    JSON.stringify({
      messageId: deriveExternalRef(requestId, "FINALIZE"),
      requestId,
      tenantId: aTenantId(),
      workflowVersion: 1,
      createdAt: Date.now(),
      step: "FINALIZE",
      payload: { enrichment },
    }),
    { messageId: "m-1", receiptHandle: "r-1" },
  );

const aWorkflow = (
  requestId: RequestId,
  overrides: Partial<WorkflowRecord> = {},
): WorkflowRecord =>
  ({
    requestId,
    tenantId: aTenantId(),
    status: "PROCESSING",
    stateVersion: 0,
    input: anOperation(),
    createdAt: Date.now(),
    updatedAt: Date.now(),
    syncDeadlineAt: Date.now() + 20_000,
    businessDeadlineAt: Date.now() + 300_000,
    ...overrides,
  }) as WorkflowRecord;

/**
 * The race below cannot be produced by delivering messages: the finalizer returns early
 * when it sees a terminal workflow, so the only way to reach the divergence branch is for
 * the workflow to become terminal *after* that check and before the terminal write. The
 * repository stub injects exactly that window (ADR-0009: adversarial conditions are
 * injected deliberately, never awaited).
 */
const handlerWith = (
  terminalOutcome: {
    outcome: "APPLIED" | "ALREADY_TERMINAL";
    workflow: WorkflowRecord;
  },
  requestId: RequestId,
) => {
  const observability = silentObservability();

  const repository = {
    getWorkflow: async () => await Promise.resolve(aWorkflow(requestId)),
    beginStep: async () =>
      await Promise.resolve({
        outcome: "STARTED" as const,
        step: {
          requestId,
          stepId: "FINALIZE" as const,
          status: "IN_PROGRESS" as const,
          attempt: 1,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      }),
    completeIfProcessing: async () => await Promise.resolve(terminalOutcome),
    failIfProcessing: async () => await Promise.resolve(terminalOutcome),
    markStepUnknownExternalState: async (): Promise<void> => {
      await Promise.resolve();
    },
  } as unknown as WorkflowRepository;

  const provider = {
    execute: async () =>
      await Promise.resolve({
        operationId: "op-1",
        status: "SETTLED" as const,
        amount: anOperation().amount,
        idempotencyKey: deriveExternalRef(requestId, "FINALIZE"),
      }),
    lookup: async () => await Promise.resolve(undefined as unknown),
  } as unknown as ProviderClient;

  const handler = createFinalizerHandler({
    repository,
    provider,
    logger: observability.logger,
    metrics: observability.metrics,
    clock: systemClock,
    maxResultBytes: 120 * 1024,
  });

  return { handler, observability };
};

const metricNames = (events: { name: string }[]): string[] =>
  events.map((event) => event.name);

describe("terminal conflict classification", () => {
  it("counts a benign conflict when the stored outcome matches this worker's", async () => {
    const requestId = aRequestId();
    const { handler, observability } = handlerWith(
      {
        outcome: "ALREADY_TERMINAL",
        workflow: aWorkflow(requestId, { status: "COMPLETED" }),
      },
      requestId,
    );

    await handler(anSqsEvent([finalizeRecord(requestId)]));

    // A duplicate delivery reaching the same conclusion is routine.
    const names = metricNames(observability.metricEvents);
    expect(names).toContain("TerminalConflict");
    expect(names).not.toContain("TerminalDivergence");
  });

  it("distinguishes a genuine divergence from a duplicate delivery", async () => {
    const requestId = aRequestId();
    const { handler, observability } = handlerWith(
      {
        outcome: "ALREADY_TERMINAL",
        workflow: aWorkflow(requestId, {
          status: "FAILED",
          error: {
            code: "PROVIDER_REJECTED",
            message: "declined",
            failureClass: "NON_RETRYABLE",
          },
        }),
      },
      requestId,
    );

    await handler(anSqsEvent([finalizeRecord(requestId)]));

    // Two workers reached opposite conclusions. Merging this into TerminalConflict would
    // make a correctness incident indistinguishable from ordinary duplicate delivery.
    const names = metricNames(observability.metricEvents);
    expect(names).toContain("TerminalDivergence");
    expect(names).not.toContain("TerminalConflict");
  });
});
