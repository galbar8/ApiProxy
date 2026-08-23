import { z } from "zod";

/**
 * The provider's contract (ADR-0008): it honours an idempotency key and can be queried by
 * our own reference. Those two properties are what make the finalizer's retry path safe,
 * so they are implemented here faithfully rather than approximated.
 */
export const operationRequestSchema = z.object({
  operation: z.enum(["CHARGE", "REFUND"]),
  amount: z.object({
    currencyCode: z.string().regex(/^[A-Z]{3}$/),
    minorUnits: z.number().int().positive(),
  }),
  reference: z.string().min(1).max(80),
  riskBand: z.enum(["LOW", "MEDIUM", "HIGH"]),
});
export type OperationRequest = z.infer<typeof operationRequestSchema>;

export interface StoredOperation {
  operationId: string;
  idempotencyKey: string;
  status: "SETTLED" | "DECLINED";
  declineReason?: string;
  amount: OperationRequest["amount"];
  processedAt: number;
}

/**
 * Faults are requested per idempotency key and consumed once, so a test can say
 * "fail the first attempt this way, then behave normally" and get exactly that.
 */
export type FaultKind =
  "timeout" | "server-error" | "rate-limit" | "decline" | "succeed-then-drop";

export class ProviderStore {
  readonly #operations = new Map<string, StoredOperation>();
  readonly #faults = new Map<string, FaultKind[]>();
  #sequence = 0;

  /**
   * Deduplicates on the idempotency key. A repeated call returns the original outcome
   * instead of performing the operation again — the whole reason a retry is safe.
   */
  upsert(idempotencyKey: string, request: OperationRequest): StoredOperation {
    const existing = this.#operations.get(idempotencyKey);
    if (existing !== undefined) return existing;

    this.#sequence += 1;
    const declined = request.riskBand === "HIGH";
    const operation: StoredOperation = {
      operationId: `op-${this.#sequence}-${idempotencyKey.slice(0, 8)}`,
      idempotencyKey,
      status: declined ? "DECLINED" : "SETTLED",
      ...(declined ? { declineReason: "risk band HIGH" } : {}),
      amount: request.amount,
      processedAt: Date.now(),
    };
    this.#operations.set(idempotencyKey, operation);
    return operation;
  }

  /** Lookup by our reference: the mechanism that makes reconciliation possible. */
  findByReference(reference: string): StoredOperation | undefined {
    return this.#operations.get(reference);
  }

  queueFault(idempotencyKey: string, faults: FaultKind[]): void {
    this.#faults.set(idempotencyKey, [...faults]);
  }

  takeFault(idempotencyKey: string): FaultKind | undefined {
    const queue = this.#faults.get(idempotencyKey);
    if (queue === undefined || queue.length === 0) return undefined;
    const next = queue.shift();
    if (queue.length === 0) this.#faults.delete(idempotencyKey);
    return next;
  }

  reset(): void {
    this.#operations.clear();
    this.#faults.clear();
    this.#sequence = 0;
  }

  get size(): number {
    return this.#operations.size;
  }
}
