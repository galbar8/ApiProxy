import { z } from "zod";

/**
 * Identity types are branded so a `tenantId` can never be passed where a `requestId` is
 * expected. They are not interchangeable (INV-03) and the compiler enforces it.
 */
export const requestIdSchema = z.string().uuid().brand<"RequestId">();
export type RequestId = z.infer<typeof requestIdSchema>;

export const tenantIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9._-]+$/, "tenantId must be url-safe")
  .brand<"TenantId">();
export type TenantId = z.infer<typeof tenantIdSchema>;

/**
 * The caller's idempotency key. Charset and length are constrained because this value
 * becomes part of a DynamoDB partition key; unvalidated caller input never reaches a key
 * (INV-74).
 */
export const idempotencyKeySchema = z
  .string()
  .min(8)
  .max(128)
  .regex(/^[A-Za-z0-9._:-]+$/, "idempotencyKey must contain only A-Z a-z 0-9 . _ : -")
  .brand<"IdempotencyKey">();
export type IdempotencyKey = z.infer<typeof idempotencyKeySchema>;

/** Deterministic outbox event identity: sha256(requestId|step|workflowVersion). */
export const eventIdSchema = z
  .string()
  .regex(/^[0-9a-f]{64}$/)
  .brand<"EventId">();
export type EventId = z.infer<typeof eventIdSchema>;

/** Stable external-operation reference derived from requestId + stepId (INV-63). */
export const externalRefSchema = z
  .string()
  .regex(/^[0-9a-f]{64}$/)
  .brand<"ExternalRef">();
export type ExternalRef = z.infer<typeof externalRefSchema>;

export const asRequestId = (value: string): RequestId => requestIdSchema.parse(value);
export const asTenantId = (value: string): TenantId => tenantIdSchema.parse(value);
export const asIdempotencyKey = (value: string): IdempotencyKey =>
  idempotencyKeySchema.parse(value);
