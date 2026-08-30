import { z } from "zod";
import {
  externalRefSchema,
  idempotencyKeySchema,
  requestIdSchema,
  tenantIdSchema,
} from "./ids.js";

/** See docs/state-machine.md. COMPLETED and FAILED are terminal (INV-20, INV-21). */
export const workflowStatusSchema = z.enum(["PROCESSING", "COMPLETED", "FAILED"]);
export type WorkflowStatus = z.infer<typeof workflowStatusSchema>;

export const TERMINAL_STATUSES = ["COMPLETED", "FAILED"] as const;
export type TerminalStatus = (typeof TERMINAL_STATUSES)[number];

export const isTerminal = (status: WorkflowStatus): status is TerminalStatus =>
  status === "COMPLETED" || status === "FAILED";

/**
 * Steps are explicit in state and in the message envelope. The current step is never
 * inferred from which queue delivered a message.
 */
export const stepIdSchema = z.enum(["ENRICH", "FINALIZE"]);
export type StepId = z.infer<typeof stepIdSchema>;

/**
 * UNKNOWN_EXTERNAL_STATE is deliberately a *step* fact, not a workflow state: it forces
 * the next attempt to reconcile before acting (INV-62).
 */
export const stepStatusSchema = z.enum([
  "IN_PROGRESS",
  "SUCCEEDED",
  "FAILED",
  "UNKNOWN_EXTERNAL_STATE",
]);
export type StepStatus = z.infer<typeof stepStatusSchema>;

/** The schema version of the workflow document, bumped when the shape changes. */
export const CURRENT_WORKFLOW_VERSION = 1;

export const workflowErrorSchema = z.object({
  code: z.string().min(1).max(64),
  message: z.string().min(1).max(1024),
  failureClass: z.enum(["RETRYABLE", "NON_RETRYABLE", "UNKNOWN_EXTERNAL_STATE"]),
});
export type WorkflowError = z.infer<typeof workflowErrorSchema>;

export const workflowRecordSchema = z.object({
  requestId: requestIdSchema,
  tenantId: tenantIdSchema,
  idempotencyKey: idempotencyKeySchema,

  status: workflowStatusSchema,

  /** Document schema version. Not a concurrency token. */
  workflowVersion: z.number().int().positive(),
  /** Optimistic concurrency token; incremented on every state mutation. */
  stateVersion: z.number().int().nonnegative(),

  /** Canonical hash of the material business input; drives idempotency conflicts. */
  payloadHash: z.string().regex(/^[0-9a-f]{64}$/),
  input: z.unknown(),

  createdAt: z.number().int().positive(),
  updatedAt: z.number().int().positive(),

  /**
   * The synchronous HTTP budget of the request that created the workflow. Recorded for
   * observability only: nothing in the business path may treat its expiry as failure
   * (INV-51).
   */
  syncDeadlineAt: z.number().int().positive().optional(),
  /** How long the business operation itself is allowed to take. */
  businessDeadlineAt: z.number().int().positive().optional(),

  result: z.unknown().optional(),
  error: workflowErrorSchema.optional(),

  /** DynamoDB TTL, epoch seconds. */
  expiresAt: z.number().int().positive().optional(),
});
export type WorkflowRecord = z.infer<typeof workflowRecordSchema>;

export const stepRecordSchema = z.object({
  requestId: requestIdSchema,
  stepId: stepIdSchema,
  status: stepStatusSchema,
  attempt: z.number().int().nonnegative(),
  externalRef: externalRefSchema.optional(),
  externalResult: z.unknown().optional(),
  createdAt: z.number().int().positive(),
  updatedAt: z.number().int().positive(),
  expiresAt: z.number().int().positive().optional(),
});
export type StepRecord = z.infer<typeof stepRecordSchema>;
