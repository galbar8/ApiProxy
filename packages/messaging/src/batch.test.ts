import { describe, expect, it, vi } from "vitest";
import { NonRetryableError, RetryableError, ERROR_CODES } from "@workflow/contracts";
import { anSqsEvent, anSqsRecord, silentObservability } from "@workflow/testing";
import { processBatch } from "./batch.js";

const options = () => {
  const { logger, metrics, metricEvents } = silentObservability();
  return { opts: { logger, metrics }, metricEvents };
};

describe("processBatch", () => {
  it("acknowledges every record when all succeed", async () => {
    const { opts } = options();
    const event = anSqsEvent([anSqsRecord({ a: 1 }), anSqsRecord({ a: 2 })]);

    const response = await processBatch(
      event,
      async () => await Promise.resolve("DONE"),
      opts,
    );

    expect(response.batchItemFailures).toEqual([]);
  });

  it("reports only the failed record, leaving successful ones acknowledged", async () => {
    const { opts } = options();
    const good1 = anSqsRecord({ id: "a" });
    const bad = anSqsRecord({ id: "b" });
    const good2 = anSqsRecord({ id: "c" });

    const response = await processBatch(
      anSqsEvent([good1, bad, good2]),
      async (record) => {
        if (record.messageId === bad.messageId) {
          throw new RetryableError(ERROR_CODES.INTERNAL_ERROR, "transient");
        }
        return await Promise.resolve("DONE");
      },
      opts,
    );

    expect(response.batchItemFailures).toEqual([{ itemIdentifier: bad.messageId }]);
  });

  it("does not report a record the handler asked to retry as successful", async () => {
    const { opts } = options();
    const record = anSqsRecord({ id: "a" });

    const response = await processBatch(
      anSqsEvent([record]),
      async () => await Promise.resolve("RETRY"),
      opts,
    );

    expect(response.batchItemFailures).toEqual([{ itemIdentifier: record.messageId }]);
  });

  it("never lets one record's failure fail the whole invocation", async () => {
    const { opts } = options();
    const records = [anSqsRecord({ id: "a" }), anSqsRecord({ id: "b" })];

    await expect(
      processBatch(
        anSqsEvent(records),
        async (record) => {
          if (record.messageId === records[0]?.messageId) {
            throw new Error("kaboom");
          }
          return await Promise.resolve("DONE");
        },
        opts,
      ),
    ).resolves.toBeDefined();
  });

  it("reports an unclassified throw rather than silently deleting the message", async () => {
    const { opts } = options();
    const record = anSqsRecord({ id: "a" });

    const response = await processBatch(
      anSqsEvent([record]),
      () => {
        throw new Error("unexpected");
      },
      opts,
    );

    expect(response.batchItemFailures).toEqual([{ itemIdentifier: record.messageId }]);
  });

  it("keeps a non-retryable escape out of silent-success territory", async () => {
    const { opts, metricEvents } = options();
    const record = anSqsRecord({ id: "a" });

    const response = await processBatch(
      anSqsEvent([record]),
      async () => {
        await Promise.resolve();
        throw new NonRetryableError(ERROR_CODES.MESSAGE_SCHEMA_INVALID, "bad message");
      },
      opts,
    );

    expect(response.batchItemFailures).toHaveLength(1);
    expect(
      metricEvents.some(
        (metric) =>
          metric.name === "MessageFailed" &&
          (metric.dimensions as { failureClass?: string }).failureClass ===
            "NON_RETRYABLE",
      ),
    ).toBe(true);
  });

  it("processes an empty batch without error", async () => {
    const { opts } = options();
    const response = await processBatch(
      anSqsEvent([]),
      async () => await Promise.resolve("DONE"),
      opts,
    );
    expect(response.batchItemFailures).toEqual([]);
  });

  it("handles every record exactly once", async () => {
    const { opts } = options();
    const handler = vi.fn().mockResolvedValue("DONE");
    const records = Array.from({ length: 10 }, (_, index) => anSqsRecord({ index }));

    await processBatch(anSqsEvent(records), handler, opts);

    expect(handler).toHaveBeenCalledTimes(10);
    const seen = new Set(
      handler.mock.calls.map((call) => (call[0] as { messageId: string }).messageId),
    );
    expect(seen.size).toBe(10);
  });

  it("preserves failure identity when many records fail at once", async () => {
    const { opts } = options();
    const records = Array.from({ length: 6 }, (_, index) => anSqsRecord({ index }));
    const failing = new Set([records[1]?.messageId, records[4]?.messageId]);

    const response = await processBatch(
      anSqsEvent(records),
      async (record) => {
        if (failing.has(record.messageId)) throw new Error("nope");
        return await Promise.resolve("DONE");
      },
      opts,
    );

    expect(new Set(response.batchItemFailures.map((f) => f.itemIdentifier))).toEqual(
      failing as Set<string>,
    );
  });
});
