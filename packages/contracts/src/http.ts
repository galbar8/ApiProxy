import { z } from "zod";
import { operationInputSchema, operationResultSchema } from "./domain.js";
import type { workflowStatusSchema } from "./workflow.js";

/** `POST /v1/process` body. `tenantId` is never accepted here (INV-70). */
export const processRequestSchema = operationInputSchema.strict();
export type ProcessRequest = z.infer<typeof processRequestSchema>;

const baseResponse = {
  requestId: z.string().uuid(),
};

export const completedResponseSchema = z.object({
  ...baseResponse,
  status: z.literal("COMPLETED"),
  result: operationResultSchema,
});

export const failedResponseSchema = z.object({
  ...baseResponse,
  status: z.literal("FAILED"),
  error: z.object({ code: z.string(), message: z.string() }),
});

/**
 * Returned when the synchronous deadline expires. This is not an error: the workflow is
 * untouched and still running (ADR-0005, INV-51).
 */
export const processingResponseSchema = z.object({
  ...baseResponse,
  status: z.literal("PROCESSING"),
  pollUrl: z.string(),
  retryAfterSeconds: z.number().int().positive(),
});

export const processResponseSchema = z.discriminatedUnion("status", [
  completedResponseSchema,
  failedResponseSchema,
  processingResponseSchema,
]);
export type ProcessResponse = z.infer<typeof processResponseSchema>;

export const errorResponseSchema = z.object({
  code: z.string(),
  message: z.string(),
  details: z.unknown().optional(),
});
export type ErrorResponse = z.infer<typeof errorResponseSchema>;

export const IDEMPOTENCY_KEY_HEADER = "idempotency-key";
export const AUTHORIZATION_HEADER = "authorization";
export const CORRELATION_HEADER = "x-request-id";

/** Status-code mapping lives in one place so handlers cannot drift from ADR-0005. */
export const statusToHttpCode = (
  status: z.infer<typeof workflowStatusSchema>,
): number => (status === "PROCESSING" ? 202 : 200);
