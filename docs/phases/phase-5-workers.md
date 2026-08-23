# Phase 5 — Lambda workers and the simulated provider

## Scope

- `worker-a`: validates the message, durable step idempotency, commits step state and the next outbox event in one transaction.
- `finalizer`: persists `externalRef` before calling the provider, classifies failures, reconciles `UNKNOWN_EXTERNAL_STATE`, writes the terminal state conditionally.
- `outbox-publisher`: DynamoDB Streams consumer, publishes to SQS, marks published.
- `reconciler`: EventBridge-scheduled sweep of unpublished outbox events and stale `PROCESSING` workflows.
- `fake-provider`: idempotency-key-honouring provider with fault injection.
- Read the `sqs-worker` skill before implementing.

## Out of scope

Infrastructure, cross-suite test harness.

## Acceptance criteria

- Tests prove: duplicate delivery is a no-op, partial batch failure reports only the failed records, non-retryable failures do not loop, poison messages reach the DLQ, a crash between the transaction and publication still advances the workflow, an external success followed by a local crash reconciles instead of duplicating.
