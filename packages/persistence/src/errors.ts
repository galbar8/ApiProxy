import {
  ConditionalCheckFailedException,
  TransactionCanceledException,
  type CancellationReason,
} from "@aws-sdk/client-dynamodb";
import {
  ERROR_CODES,
  NonRetryableError,
  RetryableError,
  type AppError,
} from "@workflow/contracts";

export const isConditionalCheckFailed = (error: unknown): boolean =>
  error instanceof ConditionalCheckFailedException;

export interface TransactionOutcome {
  readonly cancelled: boolean;
  /** Per-item reason codes, positionally aligned with the transaction items. */
  readonly reasons: readonly (string | undefined)[];
}

export const readTransactionOutcome = (error: unknown): TransactionOutcome => {
  if (!(error instanceof TransactionCanceledException)) {
    return { cancelled: false, reasons: [] };
  }
  const reasons = (error.CancellationReasons ?? []).map(
    (reason: CancellationReason) => reason.Code,
  );
  return { cancelled: true, reasons };
};

export const conditionFailedAt = (error: unknown, index: number): boolean =>
  readTransactionOutcome(error).reasons[index] === "ConditionalCheckFailed";

const RETRYABLE_NAMES = new Set([
  "ProvisionedThroughputExceededException",
  "ThrottlingException",
  "RequestLimitExceeded",
  "InternalServerError",
  "ServiceUnavailable",
  "TransactionInProgressException",
  "TimeoutError",
]);

const NON_RETRYABLE_NAMES = new Set([
  "ValidationException",
  "ResourceNotFoundException",
  "ItemCollectionSizeLimitExceededException",
]);

/**
 * DynamoDB failures are classified, never flattened. Throttling is transient and worth
 * redelivering; a validation error will fail identically forever and must not be looped.
 */
export const classifyDynamoError = (error: unknown): AppError => {
  const name = error instanceof Error ? error.name : "";
  const message = error instanceof Error ? error.message : String(error);

  if (RETRYABLE_NAMES.has(name)) {
    return new RetryableError(ERROR_CODES.INTERNAL_ERROR, `dynamodb: ${message}`, {
      cause: error,
    });
  }
  if (NON_RETRYABLE_NAMES.has(name)) {
    return new NonRetryableError(ERROR_CODES.INTERNAL_ERROR, `dynamodb: ${message}`, {
      cause: error,
    });
  }
  if (error instanceof TransactionCanceledException) {
    const reasons = readTransactionOutcome(error).reasons;
    // A transaction conflict is contention, not a defect: another writer won the race.
    if (reasons.includes("TransactionConflict")) {
      return new RetryableError(ERROR_CODES.STATE_CONFLICT, `dynamodb: ${message}`, {
        cause: error,
        details: { reasons },
      });
    }
    return new NonRetryableError(ERROR_CODES.STATE_CONFLICT, `dynamodb: ${message}`, {
      cause: error,
      details: { reasons },
    });
  }
  return new RetryableError(ERROR_CODES.INTERNAL_ERROR, `dynamodb: ${message}`, {
    cause: error,
  });
};
