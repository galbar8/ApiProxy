# Phase 2 — DynamoDB persistence

## Scope

- Single-table key construction and item codecs with runtime validation on read.
- `WorkflowRepository` with domain-specific methods only: atomic create with idempotency mapping, exact-key tenant-checked read, `completeIfProcessing`, `failIfProcessing`, `advanceStepWithOutbox`, outbox mark-published, sparse-index queries for the reconciler.
- Conditional expressions, `TransactWriteItems`, optimistic concurrency on `stateVersion`, TTL fields.
- Read the `dynamodb-state` skill before implementing.

## Out of scope

HTTP, SQS, Lambda handlers.

## Acceptance criteria

- Tests against DynamoDB Local prove: atomic create, duplicate create returns the existing workflow, payload-hash conflict detection, terminal immutability, conditional-write race under concurrency, transaction atomicity (state + outbox commit or neither).
- No generic patch/update method is exposed.
