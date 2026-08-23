import { z } from "zod";
import { eventIdSchema, requestIdSchema } from "./ids.js";
import { workflowMessageSchema } from "./messages.js";

/**
 * Logical publication targets. The concrete queue URL is resolved from configuration, so
 * a queue URL never travels in data and a caller can never influence routing (INV-74).
 */
export const outboxDestinationSchema = z.enum(["START_QUEUE", "STEP_QUEUE"]);
export type OutboxDestination = z.infer<typeof outboxDestinationSchema>;

export const outboxEventSchema = z.object({
  eventId: eventIdSchema,
  requestId: requestIdSchema,
  destination: outboxDestinationSchema,
  message: workflowMessageSchema,
  createdAt: z.number().int().positive(),
  /**
   * Progress marker and operational signal only. It is never the duplicate protection:
   * consumers deduplicate on requestId + stepId (ADR-0004).
   */
  publishedAt: z.number().int().positive().optional(),
  expiresAt: z.number().int().positive().optional(),
});
export type OutboxEvent = z.infer<typeof outboxEventSchema>;
