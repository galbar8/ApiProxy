import {
  ERROR_CODES,
  NonRetryableError,
  workflowMessageSchema,
  type WorkflowMessage,
} from "@workflow/contracts";

/**
 * Validates a message body before any field is used.
 *
 * The producer is our own code, which is not a reason to skip this: a message may have
 * been produced by an older deployment, replayed from a DLQ weeks later, or redriven by
 * an operator. A malformed body is NON_RETRYABLE — retrying it forever would be a hot
 * loop ending in nothing but noise.
 */
export const parseWorkflowMessage = (body: string): WorkflowMessage => {
  let raw: unknown;
  try {
    raw = JSON.parse(body);
  } catch (error) {
    throw new NonRetryableError(
      ERROR_CODES.MESSAGE_SCHEMA_INVALID,
      "message body is not valid JSON",
      { cause: error },
    );
  }

  const parsed = workflowMessageSchema.safeParse(raw);
  if (!parsed.success) {
    throw new NonRetryableError(
      ERROR_CODES.MESSAGE_SCHEMA_INVALID,
      `message failed schema validation: ${parsed.error.issues
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
        .join("; ")}`,
    );
  }
  return parsed.data;
};
