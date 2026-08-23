/**
 * Failure classification. Reducing every error to FAILED loses the distinction that
 * decides whether a retry is safe (GOAL section 18).
 */
export type FailureClass = "RETRYABLE" | "NON_RETRYABLE" | "UNKNOWN_EXTERNAL_STATE";

export const ERROR_CODES = {
  // Caller-facing
  UNAUTHENTICATED: "UNAUTHENTICATED",
  VALIDATION_FAILED: "VALIDATION_FAILED",
  PAYLOAD_TOO_LARGE: "PAYLOAD_TOO_LARGE",
  IDEMPOTENCY_KEY_CONFLICT: "IDEMPOTENCY_KEY_CONFLICT",
  NOT_FOUND: "NOT_FOUND",
  SERVICE_DRAINING: "SERVICE_DRAINING",
  INTERNAL_ERROR: "INTERNAL_ERROR",

  // Workflow-facing
  RESULT_TOO_LARGE: "RESULT_TOO_LARGE",
  UNSUPPORTED_CURRENCY: "UNSUPPORTED_CURRENCY",
  WORKFLOW_INPUT_INVALID: "WORKFLOW_INPUT_INVALID",
  PROVIDER_REJECTED: "PROVIDER_REJECTED",
  PROVIDER_UNAVAILABLE: "PROVIDER_UNAVAILABLE",
  PROVIDER_STATE_UNKNOWN: "PROVIDER_STATE_UNKNOWN",
  MESSAGE_SCHEMA_INVALID: "MESSAGE_SCHEMA_INVALID",
  WORKFLOW_MISSING: "WORKFLOW_MISSING",
  STATE_CONFLICT: "STATE_CONFLICT",
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

export interface AppErrorOptions {
  readonly failureClass: FailureClass;
  readonly httpStatus?: number;
  readonly details?: unknown;
  readonly cause?: unknown;
}

/** Base error carrying the classification the retry logic depends on. */
export class AppError extends Error {
  readonly code: ErrorCode;
  readonly failureClass: FailureClass;
  readonly httpStatus: number | undefined;
  readonly details: unknown;

  constructor(code: ErrorCode, message: string, options: AppErrorOptions) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "AppError";
    this.code = code;
    this.failureClass = options.failureClass;
    this.httpStatus = options.httpStatus;
    this.details = options.details;
  }
}

/** Safe to retry: the operation demonstrably did not take effect. */
export class RetryableError extends AppError {
  constructor(
    code: ErrorCode,
    message: string,
    options: Omit<AppErrorOptions, "failureClass"> = {},
  ) {
    super(code, message, { ...options, failureClass: "RETRYABLE" });
    this.name = "RetryableError";
  }
}

/** Deterministic failure: retrying produces the same outcome. */
export class NonRetryableError extends AppError {
  constructor(
    code: ErrorCode,
    message: string,
    options: Omit<AppErrorOptions, "failureClass"> = {},
  ) {
    super(code, message, { ...options, failureClass: "NON_RETRYABLE" });
    this.name = "NonRetryableError";
  }
}

/**
 * The remote side may or may not have acted. Retrying blindly can duplicate a business
 * operation, so the next attempt must reconcile first (INV-62).
 */
export class UnknownExternalStateError extends AppError {
  constructor(
    code: ErrorCode,
    message: string,
    options: Omit<AppErrorOptions, "failureClass"> = {},
  ) {
    super(code, message, { ...options, failureClass: "UNKNOWN_EXTERNAL_STATE" });
    this.name = "UnknownExternalStateError";
  }
}

export const isAppError = (value: unknown): value is AppError =>
  value instanceof AppError;

/**
 * Classification for anything that is not already an AppError. Unclassified failures are
 * treated as RETRYABLE only when they cannot have produced an external side effect;
 * callers that may have touched an external system must classify explicitly.
 */
export const classifyUnknown = (error: unknown): AppError =>
  isAppError(error)
    ? error
    : new RetryableError(
        ERROR_CODES.INTERNAL_ERROR,
        error instanceof Error ? error.message : "unknown error",
        { cause: error },
      );
