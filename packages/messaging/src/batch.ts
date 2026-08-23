import type { SQSBatchResponse, SQSEvent, SQSRecord } from "aws-lambda";
import { classifyUnknown, type FailureClass } from "@workflow/contracts";
import type { Logger, Metrics } from "@workflow/observability";
import { METRICS, serializeError, withCorrelation } from "@workflow/observability";

/**
 * What a handler decided about one record.
 *
 * `RETRY` is the only outcome that leaves the message on the queue. `DONE` covers both
 * success and a deliberate, logged non-retryable failure — in the latter case the
 * business outcome has already been recorded durably, so redelivering the message would
 * accomplish nothing but burn the receive count.
 */
export type RecordOutcome = "DONE" | "RETRY";

export type RecordHandler = (record: SQSRecord) => Promise<RecordOutcome>;

export interface BatchOptions {
  readonly logger: Logger;
  readonly metrics: Metrics;
  /** Records within a Standard-queue batch are independent and processed concurrently. */
  readonly concurrency?: number;
}

const runWithConcurrency = async <T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> => {
  const results = new Array<R>(items.length);
  let cursor = 0;

  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      const item = items[index];
      if (item === undefined) return;
      results[index] = await worker(item);
    }
  });

  await Promise.all(runners);
  return results;
};

/**
 * Runs a batch and reports only the records that must be redelivered.
 *
 * Two failure modes this exists to prevent:
 *  - throwing out of the handler, which fails the whole batch and forces successful
 *    records to be reprocessed;
 *  - swallowing a record error and returning an empty failure list, which deletes a
 *    business-critical message.
 *
 * Neither is reachable here: every record is isolated, and an unclassified throw becomes
 * a reported failure rather than silent success.
 */
export const processBatch = async (
  event: SQSEvent,
  handler: RecordHandler,
  options: BatchOptions,
): Promise<SQSBatchResponse> => {
  const failures: string[] = [];

  const outcomes = await runWithConcurrency(
    event.Records,
    options.concurrency ?? 5,
    async (record): Promise<{ messageId: string; outcome: RecordOutcome }> => {
      const startedAt = Date.now();
      try {
        const outcome = await withCorrelation(
          {
            messageId: record.messageId,
            attempt: Number(record.attributes.ApproximateReceiveCount),
          },
          async () => await handler(record),
        );
        options.metrics.count(METRICS.messageProcessed, 1, { outcome });
        return { messageId: record.messageId, outcome };
      } catch (error) {
        const classified = classifyUnknown(error);
        const failureClass: FailureClass = classified.failureClass;

        // A NON_RETRYABLE escape means the handler failed to record a terminal outcome
        // itself. Redelivering will not help, but silently deleting would lose the
        // message, so it goes to the DLQ by way of the receive count.
        options.logger.error(
          {
            messageId: record.messageId,
            failureClass,
            receiveCount: record.attributes.ApproximateReceiveCount,
            durationMs: Date.now() - startedAt,
            err: serializeError(classified),
          },
          "record processing failed",
        );
        options.metrics.count(METRICS.messageFailed, 1, { failureClass });
        return { messageId: record.messageId, outcome: "RETRY" };
      }
    },
  );

  for (const result of outcomes) {
    if (result.outcome === "RETRY") {
      failures.push(result.messageId);
    }
  }

  return { batchItemFailures: failures.map((id) => ({ itemIdentifier: id })) };
};
