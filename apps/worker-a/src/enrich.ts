import {
  ERROR_CODES,
  NonRetryableError,
  SUPPORTED_CURRENCIES,
  operationInputSchema,
  type Enrichment,
  type OperationInput,
} from "@workflow/contracts";

/**
 * Enrichment must be a pure function of the stored input.
 *
 * Duplicate delivery is normal, so two invocations for the same request have to produce
 * the same enrichment. Anything non-deterministic here — a random sample, a wall-clock
 * bucket, a lookup that can change — would make a replay disagree with the original and
 * quietly corrupt the workflow.
 */
export const riskBandFor = (input: OperationInput): Enrichment["riskBand"] => {
  if (input.amount.minorUnits >= 500_000) return "HIGH";
  if (input.amount.minorUnits >= 100_000) return "MEDIUM";
  return "LOW";
};

export const normalizeReference = (input: OperationInput): string =>
  `${input.operation}:${input.reference}`.toUpperCase().slice(0, 80);

/** Validates the persisted input before use: storage is a trust boundary too. */
export const parseWorkflowInput = (input: unknown): OperationInput => {
  const parsed = operationInputSchema.safeParse(input);
  if (!parsed.success) {
    throw new NonRetryableError(
      ERROR_CODES.WORKFLOW_INPUT_INVALID,
      "stored workflow input failed validation",
    );
  }
  return parsed.data;
};

export const assertSupportedCurrency = (input: OperationInput): void => {
  const supported: readonly string[] = SUPPORTED_CURRENCIES;
  if (!supported.includes(input.amount.currencyCode)) {
    throw new NonRetryableError(
      ERROR_CODES.UNSUPPORTED_CURRENCY,
      `currency ${input.amount.currencyCode} is not supported`,
    );
  }
};

export const enrich = (input: OperationInput, at: number): Enrichment => ({
  normalizedReference: normalizeReference(input),
  riskBand: riskBandFor(input),
  enrichedAt: at,
});
