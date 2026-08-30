import {
  outboxEventSchema,
  stepRecordSchema,
  workflowRecordSchema,
  type OutboxEvent,
  type StepRecord,
  type WorkflowRecord,
} from "@workflow/contracts";
import { z } from "zod";
import { NonRetryableError, ERROR_CODES } from "@workflow/contracts";

export const ITEM_TYPES = {
  workflow: "WORKFLOW",
  idempotency: "IDEMPOTENCY",
  step: "STEP",
  outbox: "OUTBOX",
} as const;

export const idempotencyRecordSchema = z.object({
  tenantId: z.string(),
  idempotencyKey: z.string(),
  requestId: z.string().uuid(),
  payloadHash: z.string().regex(/^[0-9a-f]{64}$/),
  createdAt: z.number().int().positive(),
});
export type IdempotencyRecord = z.infer<typeof idempotencyRecordSchema>;

/**
 * Items are validated on the way out of DynamoDB, not cast. A record written by an older
 * or newer deployment must fail loudly here rather than flow into business logic as a
 * half-populated object.
 */
const decodeWith = <S extends z.ZodTypeAny>(
  schema: S,
  raw: unknown,
  kind: string,
): z.output<S> => {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new NonRetryableError(
      ERROR_CODES.INTERNAL_ERROR,
      `persisted ${kind} item failed validation: ${parsed.error.issues
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
        .join("; ")}`,
      { details: { kind } },
    );
  }
  return parsed.data as z.output<S>;
};

export const decodeWorkflow = (raw: unknown): WorkflowRecord =>
  decodeWith(workflowRecordSchema, raw, "workflow");

export const decodeStep = (raw: unknown): StepRecord =>
  decodeWith(stepRecordSchema, raw, "step");

export const decodeOutbox = (raw: unknown): OutboxEvent =>
  decodeWith(outboxEventSchema, raw, "outbox");

export const decodeIdempotency = (raw: unknown): IdempotencyRecord =>
  decodeWith(idempotencyRecordSchema, raw, "idempotency");

/** DynamoDB TTL is in epoch *seconds*; using milliseconds silently disables expiry. */
export const ttlSecondsFromNow = (nowMillis: number, days: number): number =>
  Math.floor(nowMillis / 1000) + days * 24 * 60 * 60;
