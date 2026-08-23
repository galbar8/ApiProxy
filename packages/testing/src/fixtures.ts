import { randomUUID } from "node:crypto";
import type {
  IdempotencyKey,
  OperationInput,
  RequestId,
  TenantId,
} from "@workflow/contracts";

export const aRequestId = (): RequestId => randomUUID() as RequestId;
export const aTenantId = (name = "acme"): TenantId => name as TenantId;
export const anIdempotencyKey = (suffix = randomUUID()): IdempotencyKey =>
  `idem-${suffix}` as IdempotencyKey;

export const anOperation = (
  overrides: Partial<OperationInput> = {},
): OperationInput => ({
  operation: "CHARGE",
  amount: { currencyCode: "USD", minorUnits: 1250 },
  reference: "inv-1001",
  ...overrides,
});
