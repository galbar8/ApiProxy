import { z } from "zod";
import { moneySchema } from "./domain.js";

/**
 * Contract of the external provider. Classified IDEMPOTENCY_PROTECTED + RECONCILABLE
 * (ADR-0008): it honours an idempotency key and can be queried by our own reference.
 */
export const providerOperationRequestSchema = z.object({
  operation: z.enum(["CHARGE", "REFUND"]),
  amount: moneySchema,
  reference: z.string().min(1).max(80),
  riskBand: z.enum(["LOW", "MEDIUM", "HIGH"]),
});
export type ProviderOperationRequest = z.infer<typeof providerOperationRequestSchema>;

/** Validated before being persisted as a business result: never trust a remote body. */
export const providerOperationResponseSchema = z.object({
  operationId: z.string().min(1).max(128),
  /** Echo of our idempotency key, so a mismatched response can be detected. */
  idempotencyKey: z.string().min(1).max(128),
  status: z.enum(["SETTLED", "DECLINED"]),
  declineReason: z.string().max(256).optional(),
  amount: moneySchema,
  processedAt: z.number().int().positive(),
});
export type ProviderOperationResponse = z.infer<typeof providerOperationResponseSchema>;

export const PROVIDER_IDEMPOTENCY_HEADER = "idempotency-key";
