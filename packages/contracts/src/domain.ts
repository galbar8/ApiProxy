import { z } from "zod";

/**
 * The business operation. A charge-like operation is deliberately chosen: it is *not*
 * naturally idempotent, so the external-integration invariants (ADR-0008) are exercised
 * by the real workflow rather than by a contrived example.
 */
export const operationKindSchema = z.enum(["CHARGE", "REFUND"]);
export type OperationKind = z.infer<typeof operationKindSchema>;

export const moneySchema = z.object({
  /** ISO 4217 alphabetic code. */
  currencyCode: z.string().regex(/^[A-Z]{3}$/),
  /** Amount in the currency's minor units, to avoid floating point entirely. */
  minorUnits: z.number().int().positive().max(1_000_000_000),
});
export type Money = z.infer<typeof moneySchema>;

export const metadataSchema = z
  .record(z.string().min(1).max(64), z.string().max(256))
  .refine((value) => Object.keys(value).length <= 10, {
    message: "metadata supports at most 10 entries",
  });

export const operationInputSchema = z.object({
  operation: operationKindSchema,
  amount: moneySchema,
  /** The caller's own reference. Correlation only; never used as a key or for auth. */
  reference: z.string().min(1).max(64),
  metadata: metadataSchema.optional(),
});
export type OperationInput = z.infer<typeof operationInputSchema>;

/** Produced by the ENRICH step and carried into FINALIZE. */
export const enrichmentSchema = z.object({
  normalizedReference: z.string().min(1).max(80),
  riskBand: z.enum(["LOW", "MEDIUM", "HIGH"]),
  enrichedAt: z.number().int().positive(),
});
export type Enrichment = z.infer<typeof enrichmentSchema>;

export const operationResultSchema = z.object({
  providerOperationId: z.string().min(1).max(128),
  outcome: z.enum(["SETTLED", "DECLINED"]),
  amount: moneySchema,
  riskBand: enrichmentSchema.shape.riskBand,
  completedAt: z.number().int().positive(),
});
export type OperationResult = z.infer<typeof operationResultSchema>;

export const SUPPORTED_CURRENCIES = ["USD", "EUR", "GBP", "ILS"] as const;
