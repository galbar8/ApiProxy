import type { SQSEvent, SQSBatchResponse, SQSRecord } from "aws-lambda";
import {
  isAppError,
  isTerminal,
  type Clock,
  type WorkflowError,
} from "@workflow/contracts";
import {
  parseWorkflowMessage,
  processBatch,
  type RecordOutcome,
} from "@workflow/messaging";
import type { WorkflowRepository } from "@workflow/persistence";
import {
  METRICS,
  serializeError,
  withCorrelation,
  type Logger,
  type Metrics,
} from "@workflow/observability";
import { assertSupportedCurrency, enrich, parseWorkflowInput } from "./enrich.js";

export interface WorkerDependencies {
  readonly repository: WorkflowRepository;
  readonly logger: Logger;
  readonly metrics: Metrics;
  readonly clock: Clock;
}

/**
 * First workflow step.
 *
 * Everything this handler does is either idempotent or guarded by a condition:
 *  - the step claim rejects a duplicate that has already succeeded;
 *  - the advance is a transaction that also refuses to run once the workflow is terminal;
 *  - the outbox event carries a deterministic id, so a replay writes the same event.
 *
 * The handler never sends an SQS message itself. Publication is a consequence of the
 * committed transaction (INV-43).
 */
export const createWorkerAHandler = (deps: WorkerDependencies) => {
  const handleRecord = async (record: SQSRecord): Promise<RecordOutcome> => {
    const message = parseWorkflowMessage(record.body);

    if (message.step !== "ENRICH") {
      // Wrong queue for this step: retrying cannot fix a routing mistake.
      deps.logger.error({ step: message.step }, "message routed to the wrong worker");
      return "DONE";
    }

    return await withCorrelation(
      {
        requestId: message.requestId,
        tenantId: message.tenantId,
        step: message.step,
        workflowVersion: message.workflowVersion,
      },
      async (): Promise<RecordOutcome> => {
        const workflow = await deps.repository.getWorkflow(message.requestId);
        if (workflow === undefined) {
          // The workflow is gone (TTL, or a message that outlived its data). There is
          // nothing to advance and nothing a retry would recover.
          deps.logger.warn("workflow not found for enrich message");
          return "DONE";
        }
        if (isTerminal(workflow.status)) {
          deps.metrics.count(METRICS.duplicateMessage, 1, { reason: "terminal" });
          return "DONE";
        }

        const claim = await deps.repository.beginStep(message.requestId, "ENRICH");
        if (claim.outcome === "ALREADY_SUCCEEDED") {
          // A duplicate delivery of work that is already done. Acknowledge it; the outbox
          // event for the next step already exists (INV-34).
          deps.metrics.count(METRICS.duplicateMessage, 1, { step: "ENRICH" });
          deps.logger.info("duplicate enrich delivery ignored");
          return "DONE";
        }

        try {
          const input = parseWorkflowInput(workflow.input);
          assertSupportedCurrency(input);
          const enrichment = enrich(input, deps.clock.now());

          const advanced = await deps.repository.advanceStepWithOutbox({
            requestId: message.requestId,
            tenantId: message.tenantId,
            stepId: "ENRICH",
            stepResult: enrichment,
            nextStep: "FINALIZE",
            destination: "STEP_QUEUE",
            nextPayload: { enrichment },
          });

          switch (advanced.outcome) {
            case "ADVANCED":
              deps.logger.info(
                { riskBand: enrichment.riskBand },
                "enrich step committed",
              );
              return "DONE";
            case "ALREADY_ADVANCED":
              deps.metrics.count(METRICS.duplicateMessage, 1, { step: "ENRICH" });
              return "DONE";
            case "WORKFLOW_TERMINAL":
            case "WORKFLOW_MISSING":
              // A late duplicate arriving after the workflow finished must not restart
              // the pipeline (INV-21).
              deps.logger.info(
                { reason: advanced.outcome },
                "enrich skipped; workflow is no longer in flight",
              );
              return "DONE";
          }
        } catch (error) {
          if (isAppError(error) && error.failureClass === "NON_RETRYABLE") {
            // Deterministic business failure: record it durably as the workflow outcome
            // rather than looping the message until it reaches the DLQ.
            const workflowError: WorkflowError = {
              code: error.code,
              message: error.message,
              failureClass: "NON_RETRYABLE",
            };
            const failed = await deps.repository.failIfProcessing({
              requestId: message.requestId,
              stepId: "ENRICH",
              error: workflowError,
            });
            deps.logger.warn(
              { outcome: failed.outcome, err: serializeError(error) },
              "enrich failed permanently; workflow marked FAILED",
            );
            deps.metrics.count(METRICS.workflowFailed, 1, { step: "ENRICH" });
            return "DONE";
          }
          throw error;
        }
      },
    );
  };

  return async (event: SQSEvent): Promise<SQSBatchResponse> =>
    await processBatch(event, handleRecord, {
      logger: deps.logger,
      metrics: deps.metrics,
    });
};
