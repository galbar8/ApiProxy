import { z } from "zod";
import { enrichmentSchema } from "./domain.js";
import { eventIdSchema, requestIdSchema, tenantIdSchema } from "./ids.js";
import { stepIdSchema } from "./workflow.js";

/**
 * Message envelope (GOAL section 9). Messages carry correlation and step identity, never
 * the business payload: workers read the payload from DynamoDB by exact key, which keeps
 * messages small and keeps DynamoDB authoritative (ADR-0006, INV-10).
 */
const envelopeBase = {
  /** Equals the outbox eventId, so a replay reuses the same identity (INV-44). */
  messageId: eventIdSchema,
  requestId: requestIdSchema,
  tenantId: tenantIdSchema,
  /** Document schema version of the workflow this message belongs to. */
  workflowVersion: z.number().int().positive(),
  createdAt: z.number().int().positive(),
};

export const enrichMessageSchema = z.object({
  ...envelopeBase,
  step: z.literal(stepIdSchema.enum.ENRICH),
  payload: z.object({}).strict(),
});

export const finalizeMessageSchema = z.object({
  ...envelopeBase,
  step: z.literal(stepIdSchema.enum.FINALIZE),
  payload: z.object({ enrichment: enrichmentSchema }).strict(),
});

export const workflowMessageSchema = z.discriminatedUnion("step", [
  enrichMessageSchema,
  finalizeMessageSchema,
]);

export type EnrichMessage = z.infer<typeof enrichMessageSchema>;
export type FinalizeMessage = z.infer<typeof finalizeMessageSchema>;
export type WorkflowMessage = z.infer<typeof workflowMessageSchema>;
