import type {
  DynamoDBBatchResponse,
  DynamoDBRecord,
  DynamoDBStreamEvent,
} from "aws-lambda";
import { unmarshall } from "@aws-sdk/util-dynamodb";
import type { AttributeValue } from "@aws-sdk/client-dynamodb";
import { outboxEventSchema } from "@workflow/contracts";
import type { MessagePublisher } from "@workflow/messaging";
import type { WorkflowRepository } from "@workflow/persistence";
import {
  METRICS,
  serializeError,
  withCorrelation,
  type Logger,
  type Metrics,
} from "@workflow/observability";

export interface PublisherDependencies {
  readonly repository: WorkflowRepository;
  readonly publisher: MessagePublisher;
  readonly logger: Logger;
  readonly metrics: Metrics;
}

/**
 * Publishes committed outbox events to SQS.
 *
 * Driven by the table's own stream, so publication happens even if the process that
 * committed the transaction is already gone — which is the entire reason the outbox
 * exists (ADR-0004).
 *
 * Publication is at-least-once and makes no pretence otherwise: event ids are
 * deterministic and every consumer deduplicates on `requestId + stepId`.
 */
export const createOutboxPublisherHandler = (deps: PublisherDependencies) => {
  const publishRecord = async (record: DynamoDBRecord): Promise<void> => {
    if (record.eventName !== "INSERT" && record.eventName !== "MODIFY") return;

    const image = record.dynamodb?.NewImage;
    if (image === undefined) return;

    const item: Record<string, unknown> = unmarshall(
      image as Record<string, AttributeValue>,
    );
    const sk = item["sk"];
    if (typeof sk !== "string" || !sk.startsWith("OUTBOX#")) return;

    // Our own "mark published" update comes back through the stream; ignore it rather
    // than republishing in a loop.
    if (item["publishedAt"] !== undefined) return;

    const parsed = outboxEventSchema.safeParse(item);
    if (!parsed.success) {
      // A malformed outbox item cannot be fixed by retrying. Surface it loudly instead
      // of spinning until the stream record ages out.
      deps.logger.error(
        { sk, issues: parsed.error.issues.length },
        "outbox item failed validation; not publishable",
      );
      deps.metrics.count(METRICS.messageFailed, 1, { reason: "invalid_outbox_item" });
      return;
    }

    const event = parsed.data;
    await withCorrelation(
      {
        requestId: event.requestId,
        messageId: event.eventId,
        step: event.message.step,
      },
      async () => {
        await deps.publisher.publish(event.destination, event.message);
        await deps.repository.markOutboxPublished(event.requestId, event.eventId);
        deps.metrics.count(METRICS.outboxPublished, 1, {
          destination: event.destination,
        });
        deps.logger.info({ destination: event.destination }, "outbox event published");
      },
    );
  };

  return async (event: DynamoDBStreamEvent): Promise<DynamoDBBatchResponse> => {
    // Stream records are processed in order and a failure checkpoints at that record:
    // reporting the first failure means it and everything after it are retried, which is
    // what preserves per-shard progress semantics.
    for (const record of event.Records) {
      try {
        await publishRecord(record);
      } catch (error) {
        deps.logger.error(
          {
            sequenceNumber: record.dynamodb?.SequenceNumber,
            err: serializeError(error),
          },
          "failed to publish outbox event; checkpointing here",
        );
        const identifier = record.dynamodb?.SequenceNumber;
        return {
          batchItemFailures:
            identifier === undefined ? [] : [{ itemIdentifier: identifier }],
        };
      }
    }
    return { batchItemFailures: [] };
  };
};
