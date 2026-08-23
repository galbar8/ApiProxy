import type { SQSBatchResponse, SQSEvent, SQSRecord } from "aws-lambda";
import {
  ERROR_CODES,
  isAppError,
  isTerminal,
  operationInputSchema,
  providerOperationResponseSchema,
  type Clock,
  type Enrichment,
  type OperationResult,
  type ProviderOperationResponse,
  type RequestId,
  type WorkflowError,
} from "@workflow/contracts";
import { deriveExternalRef } from "@workflow/idempotency";
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
import type { ProviderClient } from "./provider-client.js";

export interface FinalizerDependencies {
  readonly repository: WorkflowRepository;
  readonly provider: ProviderClient;
  readonly logger: Logger;
  readonly metrics: Metrics;
  readonly clock: Clock;
  readonly maxResultBytes: number;
}

const toResult = (
  response: ProviderOperationResponse,
  enrichment: Enrichment,
  at: number,
): OperationResult => ({
  providerOperationId: response.operationId,
  outcome: response.status,
  amount: response.amount,
  riskBand: enrichment.riskBand,
  completedAt: at,
});

/**
 * Final workflow step: the external side effect, then the terminal state write.
 *
 * The ordering here is the whole point:
 *
 *   1. derive a stable external reference from requestId + stepId;
 *   2. persist it on the step record BEFORE any call, so a crash cannot lose it;
 *   3. on any resumed attempt, ask the provider what happened to that reference before
 *      considering a second call;
 *   4. only then execute, always sending the same reference as the idempotency key;
 *   5. write the terminal state conditionally.
 *
 * Step 3 is what separates "retry safely" from "charge the customer twice" (INV-62).
 */
export const createFinalizerHandler = (deps: FinalizerDependencies) => {
  const writeTerminal = async (
    requestId: RequestId,
    response: ProviderOperationResponse,
    enrichment: Enrichment,
  ): Promise<RecordOutcome> => {
    if (response.status === "DECLINED") {
      const workflowError: WorkflowError = {
        code: ERROR_CODES.PROVIDER_REJECTED,
        message: response.declineReason ?? "provider declined the operation",
        failureClass: "NON_RETRYABLE",
      };
      const failed = await deps.repository.failIfProcessing({
        requestId,
        stepId: "FINALIZE",
        error: workflowError,
      });
      deps.metrics.count(METRICS.workflowFailed, 1, { reason: "declined" });
      deps.logger.info(
        { outcome: failed.outcome },
        "workflow failed: provider declined",
      );
      return "DONE";
    }

    const result = toResult(response, enrichment, deps.clock.now());
    const size = Buffer.byteLength(JSON.stringify(result), "utf8");
    if (size > deps.maxResultBytes) {
      // Refuse before attempting a write DynamoDB would reject anyway (ADR-0006).
      await deps.repository.failIfProcessing({
        requestId,
        stepId: "FINALIZE",
        error: {
          code: ERROR_CODES.RESULT_TOO_LARGE,
          message: `result of ${size} bytes exceeds the ${deps.maxResultBytes} byte limit`,
          failureClass: "NON_RETRYABLE",
        },
      });
      return "DONE";
    }

    const completed = await deps.repository.completeIfProcessing({
      requestId,
      stepId: "FINALIZE",
      result,
    });

    if (completed.outcome === "ALREADY_TERMINAL") {
      // Another attempt got there first. The stored outcome wins (INV-21).
      deps.metrics.count(METRICS.terminalConflict);
      deps.logger.info(
        { storedStatus: completed.workflow.status },
        "terminal write lost the race; existing outcome preserved",
      );
    } else {
      deps.metrics.count(METRICS.workflowCompleted);
    }
    return "DONE";
  };

  const handleRecord = async (record: SQSRecord): Promise<RecordOutcome> => {
    const message = parseWorkflowMessage(record.body);
    if (message.step !== "FINALIZE") {
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
        const { enrichment } = message.payload;
        const workflow = await deps.repository.getWorkflow(message.requestId);

        if (workflow === undefined) {
          deps.logger.warn("workflow not found for finalize message");
          return "DONE";
        }
        if (isTerminal(workflow.status)) {
          deps.metrics.count(METRICS.duplicateMessage, 1, { reason: "terminal" });
          return "DONE";
        }

        const input = operationInputSchema.safeParse(workflow.input);
        if (!input.success) {
          await deps.repository.failIfProcessing({
            requestId: message.requestId,
            stepId: "FINALIZE",
            error: {
              code: ERROR_CODES.WORKFLOW_INPUT_INVALID,
              message: "stored workflow input failed validation",
              failureClass: "NON_RETRYABLE",
            },
          });
          return "DONE";
        }

        // Derived, not random: the same request always produces the same provider
        // identity, however many times this runs (INV-63).
        const externalRef = deriveExternalRef(message.requestId, "FINALIZE");
        const claim = await deps.repository.beginStep(
          message.requestId,
          "FINALIZE",
          externalRef,
        );

        if (claim.outcome === "ALREADY_SUCCEEDED") {
          // The provider work is done. The workflow may still be PROCESSING if the
          // process died between the step write and the terminal write, so finish it —
          // but only from a stored response that still validates. Persisted data is a
          // trust boundary like any other.
          deps.metrics.count(METRICS.duplicateMessage, 1, { step: "FINALIZE" });
          const stored = providerOperationResponseSchema.safeParse(
            claim.step.externalResult,
          );
          if (stored.success) {
            return await writeTerminal(message.requestId, stored.data, enrichment);
          }
          return "DONE";
        }

        try {
          let response: ProviderOperationResponse | undefined;

          if (claim.outcome === "RESUMED") {
            // ANY resumed attempt reconciles first. A previous attempt may have reached
            // the provider and died before recording anything, which looks identical to
            // never having called at all.
            deps.logger.info(
              { previous: claim.previous, attempt: claim.step.attempt },
              "resumed attempt; reconciling before acting",
            );
            response = await deps.provider.lookup(externalRef);
            if (response !== undefined) {
              deps.metrics.count(METRICS.providerReconciled);
              deps.logger.info(
                { operationId: response.operationId },
                "reconciled an operation the provider had already performed",
              );
            }
          }

          response ??= await deps.provider.execute(externalRef, {
            operation: input.data.operation,
            amount: input.data.amount,
            reference: enrichment.normalizedReference,
            riskBand: enrichment.riskBand,
          });

          deps.metrics.count(METRICS.providerCall, 1, { status: response.status });
          return await writeTerminal(message.requestId, response, enrichment);
        } catch (error) {
          if (!isAppError(error)) throw error;

          if (error.failureClass === "UNKNOWN_EXTERNAL_STATE") {
            // Record the ambiguity durably so the next attempt reconciles instead of
            // repeating a possibly-executed operation.
            await deps.repository.markStepUnknownExternalState(
              message.requestId,
              "FINALIZE",
            );
            deps.metrics.count(METRICS.providerUnknownState);
            deps.logger.warn(
              { err: serializeError(error) },
              "provider outcome unknown; will reconcile on the next attempt",
            );
            return "RETRY";
          }

          if (error.failureClass === "NON_RETRYABLE") {
            await deps.repository.failIfProcessing({
              requestId: message.requestId,
              stepId: "FINALIZE",
              error: {
                code: error.code,
                message: error.message,
                failureClass: "NON_RETRYABLE",
              },
            });
            deps.metrics.count(METRICS.workflowFailed, 1, { step: "FINALIZE" });
            deps.logger.warn(
              { err: serializeError(error) },
              "provider rejected permanently; workflow marked FAILED",
            );
            return "DONE";
          }

          deps.logger.warn(
            { err: serializeError(error) },
            "retryable provider failure; message returns to the queue",
          );
          return "RETRY";
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
