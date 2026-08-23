import { ERROR_CODES, type ErrorCode } from "@workflow/contracts";

export interface HttpProblem {
  readonly status: number;
  readonly code: ErrorCode;
  readonly message: string;
  readonly details?: unknown;
}

/**
 * The response contract from ADR-0005, in one place so a handler cannot invent a status
 * code and drift from what callers are told to expect.
 */
export const PROBLEMS = {
  unauthenticated: (): HttpProblem => ({
    status: 401,
    code: ERROR_CODES.UNAUTHENTICATED,
    // Deliberately uniform: never reveal whether a key exists, is disabled or is expired.
    message: "missing or invalid credentials",
  }),
  validation: (message: string, details?: unknown): HttpProblem => ({
    status: 400,
    code: ERROR_CODES.VALIDATION_FAILED,
    message,
    ...(details === undefined ? {} : { details }),
  }),
  payloadTooLarge: (limitBytes: number): HttpProblem => ({
    status: 413,
    code: ERROR_CODES.PAYLOAD_TOO_LARGE,
    message: `request payload exceeds ${limitBytes} bytes`,
  }),
  idempotencyConflict: (): HttpProblem => ({
    status: 409,
    code: ERROR_CODES.IDEMPOTENCY_KEY_CONFLICT,
    message:
      "this idempotency key was already used with a different payload; use a new key or resend the original payload",
  }),
  notFound: (): HttpProblem => ({
    status: 404,
    code: ERROR_CODES.NOT_FOUND,
    // A tenant mismatch and a missing workflow are the same response, so a requestId
    // cannot be used to probe for existence (INV-72).
    message: "workflow not found",
  }),
  draining: (): HttpProblem => ({
    status: 503,
    code: ERROR_CODES.SERVICE_DRAINING,
    message: "service is draining; retry against another task",
  }),
  internal: (): HttpProblem => ({
    status: 500,
    code: ERROR_CODES.INTERNAL_ERROR,
    message: "internal error",
  }),
} as const;
