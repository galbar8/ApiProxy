import { describe, expect, it } from "vitest";
import { idempotencyKeySchema, requestIdSchema, tenantIdSchema } from "./ids.js";
import { isTerminal, workflowRecordSchema, workflowStatusSchema } from "./workflow.js";
import { processRequestSchema } from "./http.js";
import { workflowMessageSchema } from "./messages.js";
import { outboxEventSchema } from "./outbox.js";
import { providerOperationResponseSchema } from "./provider.js";
import { AbortError, jitter, systemClock } from "./time.js";
import {
  ERROR_CODES,
  NonRetryableError,
  RetryableError,
  UnknownExternalStateError,
  classifyUnknown,
} from "./errors.js";

const uuid = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";

describe("identity validation", () => {
  it("accepts a uuid requestId and rejects anything else", () => {
    expect(requestIdSchema.safeParse(uuid).success).toBe(true);
    expect(requestIdSchema.safeParse("not-a-uuid").success).toBe(false);
  });

  it("rejects a tenantId that is not url-safe, since it never becomes a key fragment unchecked", () => {
    expect(tenantIdSchema.safeParse("acme-corp").success).toBe(true);
    expect(tenantIdSchema.safeParse("acme/../other").success).toBe(false);
    expect(tenantIdSchema.safeParse("acme#REQ").success).toBe(false);
  });

  it("constrains the idempotency key charset and length", () => {
    expect(idempotencyKeySchema.safeParse("order-2026-08-22-0001").success).toBe(true);
    expect(idempotencyKeySchema.safeParse("short").success).toBe(false);
    expect(idempotencyKeySchema.safeParse(`key-${"x".repeat(200)}`).success).toBe(
      false,
    );
    expect(idempotencyKeySchema.safeParse("key with spaces").success).toBe(false);
  });
});

describe("workflow state", () => {
  it("treats only COMPLETED and FAILED as terminal", () => {
    expect(isTerminal("COMPLETED")).toBe(true);
    expect(isTerminal("FAILED")).toBe(true);
    expect(isTerminal("PROCESSING")).toBe(false);
  });

  it("has exactly three states", () => {
    expect(workflowStatusSchema.options).toHaveLength(3);
  });

  it("validates a workflow record and rejects a bad payload hash", () => {
    const record = {
      requestId: uuid,
      tenantId: "acme",
      idempotencyKey: "order-0001-abcd",
      status: "PROCESSING",
      workflowVersion: 1,
      stateVersion: 0,
      payloadHash: "a".repeat(64),
      input: { operation: "CHARGE" },
      createdAt: 1,
      updatedAt: 1,
    };
    expect(workflowRecordSchema.safeParse(record).success).toBe(true);
    expect(
      workflowRecordSchema.safeParse({ ...record, payloadHash: "nope" }).success,
    ).toBe(false);
  });
});

describe("http request contract", () => {
  const valid = {
    operation: "CHARGE",
    amount: { currencyCode: "USD", minorUnits: 1250 },
    reference: "inv-1001",
  };

  it("accepts a well-formed request", () => {
    expect(processRequestSchema.safeParse(valid).success).toBe(true);
  });

  it("rejects a tenantId smuggled into the body (INV-70)", () => {
    expect(
      processRequestSchema.safeParse({ ...valid, tenantId: "other-tenant" }).success,
    ).toBe(false);
  });

  it("rejects a status supplied by the caller (INV-74)", () => {
    expect(
      processRequestSchema.safeParse({ ...valid, status: "COMPLETED" }).success,
    ).toBe(false);
  });

  it("rejects fractional or negative money", () => {
    expect(
      processRequestSchema.safeParse({
        ...valid,
        amount: { currencyCode: "USD", minorUnits: 12.5 },
      }).success,
    ).toBe(false);
    expect(
      processRequestSchema.safeParse({
        ...valid,
        amount: { currencyCode: "USD", minorUnits: -100 },
      }).success,
    ).toBe(false);
  });

  it("rejects a malformed currency code", () => {
    expect(
      processRequestSchema.safeParse({
        ...valid,
        amount: { currencyCode: "usd", minorUnits: 100 },
      }).success,
    ).toBe(false);
  });

  it("caps metadata entries", () => {
    const metadata = Object.fromEntries(
      Array.from({ length: 11 }, (_, index) => [`k${index}`, "v"]),
    );
    expect(processRequestSchema.safeParse({ ...valid, metadata }).success).toBe(false);
  });
});

describe("message envelope", () => {
  const envelope = {
    messageId: "b".repeat(64),
    requestId: uuid,
    tenantId: "acme",
    workflowVersion: 1,
    createdAt: 1,
  };

  it("requires the correlation fields every worker logs", () => {
    const message = { ...envelope, step: "ENRICH", payload: {} };
    expect(workflowMessageSchema.safeParse(message).success).toBe(true);
    for (const field of [
      "messageId",
      "requestId",
      "workflowVersion",
      "step",
      "createdAt",
    ]) {
      const broken = Object.fromEntries(
        Object.entries(message).filter(([key]) => key !== field),
      );
      expect(workflowMessageSchema.safeParse(broken).success).toBe(false);
    }
  });

  it("rejects a FINALIZE message without its enrichment payload", () => {
    expect(
      workflowMessageSchema.safeParse({ ...envelope, step: "FINALIZE", payload: {} })
        .success,
    ).toBe(false);
  });

  it("rejects an unknown step rather than defaulting", () => {
    expect(
      workflowMessageSchema.safeParse({
        ...envelope,
        step: "SOMETHING_ELSE",
        payload: {},
      }).success,
    ).toBe(false);
  });

  it("carries no business payload, only step metadata (ADR-0006)", () => {
    const parsed = workflowMessageSchema.parse({
      ...envelope,
      step: "ENRICH",
      payload: {},
    });
    expect(Object.keys(parsed.payload)).toHaveLength(0);
  });
});

describe("outbox event", () => {
  it("requires a deterministic 64-hex event id", () => {
    const event = {
      eventId: "c".repeat(64),
      requestId: uuid,
      destination: "START_QUEUE",
      message: {
        messageId: "c".repeat(64),
        requestId: uuid,
        tenantId: "acme",
        workflowVersion: 1,
        createdAt: 1,
        step: "ENRICH",
        payload: {},
      },
      createdAt: 1,
    };
    expect(outboxEventSchema.safeParse(event).success).toBe(true);
    expect(
      outboxEventSchema.safeParse({ ...event, eventId: "random-id" }).success,
    ).toBe(false);
  });

  it("rejects a destination outside the known queues (INV-74)", () => {
    expect(
      outboxEventSchema.shape.destination.safeParse("ATTACKER_QUEUE").success,
    ).toBe(false);
  });
});

describe("provider response validation", () => {
  it("rejects a response missing the echoed idempotency key", () => {
    expect(
      providerOperationResponseSchema.safeParse({
        operationId: "op-1",
        status: "SETTLED",
        amount: { currencyCode: "USD", minorUnits: 100 },
        processedAt: 1,
      }).success,
    ).toBe(false);
  });

  it("rejects an unknown status rather than persisting it as a business result", () => {
    expect(
      providerOperationResponseSchema.safeParse({
        operationId: "op-1",
        idempotencyKey: "ref",
        status: "MAYBE",
        amount: { currencyCode: "USD", minorUnits: 100 },
        processedAt: 1,
      }).success,
    ).toBe(false);
  });
});

describe("error classification", () => {
  it("carries the failure class on each error type", () => {
    expect(new RetryableError(ERROR_CODES.PROVIDER_UNAVAILABLE, "x").failureClass).toBe(
      "RETRYABLE",
    );
    expect(new NonRetryableError(ERROR_CODES.PROVIDER_REJECTED, "x").failureClass).toBe(
      "NON_RETRYABLE",
    );
    expect(
      new UnknownExternalStateError(ERROR_CODES.PROVIDER_STATE_UNKNOWN, "x")
        .failureClass,
    ).toBe("UNKNOWN_EXTERNAL_STATE");
  });

  it("passes an already-classified error through unchanged", () => {
    const original = new NonRetryableError(ERROR_CODES.VALIDATION_FAILED, "bad input");
    expect(classifyUnknown(original)).toBe(original);
  });
});

describe("time helpers", () => {
  it("keeps jitter within the configured ratio", () => {
    for (let i = 0; i < 200; i += 1) {
      const value = jitter(1000, 0.2);
      expect(value).toBeGreaterThanOrEqual(800);
      expect(value).toBeLessThanOrEqual(1200);
    }
  });

  it("returns the base delay when jitter is disabled", () => {
    expect(jitter(500, 0)).toBe(500);
  });

  it("never returns a negative delay", () => {
    expect(jitter(10, 1, () => 0)).toBeGreaterThanOrEqual(0);
  });

  it("rejects a sleep that is aborted mid-flight", async () => {
    const controller = new AbortController();
    const pending = systemClock.sleep(5_000, controller.signal);
    controller.abort();
    await expect(pending).rejects.toBeInstanceOf(AbortError);
  });

  it("rejects immediately when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(systemClock.sleep(5_000, controller.signal)).rejects.toBeInstanceOf(
      AbortError,
    );
  });
});
