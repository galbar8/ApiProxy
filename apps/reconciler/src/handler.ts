import type { MessagePublisher } from "@workflow/messaging";
import type { WorkflowRepository } from "@workflow/persistence";
import {
  METRICS,
  serializeError,
  withCorrelation,
  type Logger,
  type Metrics,
} from "@workflow/observability";

export interface ReconcilerDependencies {
  readonly repository: WorkflowRepository;
  readonly publisher: MessagePublisher;
  readonly logger: Logger;
  readonly metrics: Metrics;
  readonly outboxStaleAfterMs: number;
  readonly pageSize: number;
  /**
   * Off by default. Automatically failing a workflow because a deadline passed would
   * assert a business outcome nobody observed, which is precisely what INV-51 forbids.
   */
  readonly failStaleWorkflows: boolean;
}

export interface ReconcileSummary {
  readonly republished: number;
  readonly publishFailures: number;
  readonly staleWorkflows: number;
}

/**
 * The safety net under the stream-driven publisher.
 *
 * DynamoDB Streams are reliable, not infallible: retries can be exhausted, a record can
 * age out, a bad deployment can drop events on the floor. This sweep finds outbox events
 * that were committed but never published and publishes them, so no workflow can be
 * stranded by a transport failure.
 *
 * It also reports workflows still in flight past their business deadline. Reporting, not
 * judging: a slow workflow is an operational signal, not a failed operation.
 */
export const createReconcilerHandler = (deps: ReconcilerDependencies) => {
  return async (): Promise<ReconcileSummary> => {
    let republished = 0;
    let publishFailures = 0;

    const pending = await deps.repository.listPendingOutbox(
      deps.outboxStaleAfterMs,
      deps.pageSize,
    );

    if (pending.length > 0) {
      deps.metrics.gauge(METRICS.outboxStale, pending.length, "Count");
      deps.logger.warn(
        { count: pending.length },
        "outbox events were committed but never published; republishing",
      );
    }

    for (const event of pending) {
      await withCorrelation(
        { requestId: event.requestId, messageId: event.eventId },
        async () => {
          try {
            // Republishing is safe: the event id is stable and every consumer
            // deduplicates on requestId + stepId (INV-44).
            await deps.publisher.publish(event.destination, event.message);
            await deps.repository.markOutboxPublished(event.requestId, event.eventId);
            republished += 1;
            deps.metrics.count(METRICS.outboxRepublished, 1, {
              destination: event.destination,
            });
          } catch (error) {
            publishFailures += 1;
            deps.logger.error(
              { err: serializeError(error) },
              "failed to republish an outbox event; it stays pending for the next sweep",
            );
          }
        },
      );
    }

    const stale = await deps.repository.listStaleProcessing(deps.pageSize);
    if (stale.length > 0) {
      deps.metrics.gauge(METRICS.staleWorkflow, stale.length, "Count");
      deps.logger.warn(
        {
          count: stale.length,
          requestIds: stale.slice(0, 20).map((ref) => ref.requestId),
        },
        "workflows are still in flight past their business deadline",
      );
    }

    if (deps.failStaleWorkflows) {
      for (const ref of stale) {
        await deps.repository.failIfProcessing({
          requestId: ref.requestId,
          stepId: "FINALIZE",
          error: {
            code: "BUSINESS_DEADLINE_EXCEEDED",
            message: "workflow exceeded its business deadline",
            failureClass: "NON_RETRYABLE",
          },
        });
      }
    }

    return {
      republished,
      publishFailures,
      staleWorkflows: stale.length,
    };
  };
};
