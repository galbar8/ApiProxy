# Rules: apps/worker-a, apps/finalizer, apps/outbox-publisher, apps/reconciler

- Validate the message with a schema before touching any field. The producer being our
  own code is not a reason to trust the payload.
- Assume at-least-once delivery. Every handler must be safe to run twice on the same
  message with no additional business effect (INV-34, INV-40).
- Use `ReportBatchItemFailures`. Never throw for the whole batch when records are
  independent — that forces successful records to be reprocessed.
- Never swallow a record-level error. Either report the record as failed so SQS
  redelivers it, or make a deliberate, logged decision that the record is non-retryable.
- Classify every failure as `RETRYABLE`, `NON_RETRYABLE` or `UNKNOWN_EXTERNAL_STATE`.
  A timeout on an external call is `UNKNOWN_EXTERNAL_STATE`, never `RETRYABLE` (ADR-0008).
- Persist the external reference before making an external call, and reconcile before
  repeating one (INV-62, INV-63).
- Log with `requestId`, `messageId`, `step`, `workflowVersion`, `attempt`. Never log
  payload secrets.
- The handler owns no in-memory state between invocations that affects business outcomes.
