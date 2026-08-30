# Correctness Invariants

These are the rules the system is built to preserve. Every invariant has an ID so
code comments, ADRs and tests can cite it. Changing one requires an ADR.

## Identity

- **INV-01** Every logical business operation has exactly one immutable `requestId`.
  It is generated server-side and is never taken from caller input.
- **INV-02** `idempotencyKey` identifies the _caller's_ logical operation across HTTP
  retries. It is scoped to the authenticated tenant: the deduplication identity is
  `tenantId + idempotencyKey`, never the key alone.
- **INV-03** `requestId` and `idempotencyKey` are not interchangeable.
- **INV-04** `requestId` propagates through DynamoDB items, SQS messages, worker logs,
  metrics and the final result.
- **INV-05** Workflow state is never correlated by customer ID, Lambda request ID, ECS
  task ID, timestamp, HTTP connection or in-memory object identity.

## Source of truth

- **INV-10** DynamoDB is the only authoritative store of workflow state.
- **INV-11** In-memory variables, Promise state, SQS message existence, Lambda
  invocation state, ECS process state and HTTP connection state are never
  authoritative.
- **INV-12** Loss of an ECS task never loses business state.
- **INV-13** Loss or timeout of an HTTP connection never implies business failure.

## State machine

- **INV-20** Legal transitions are `PROCESSING -> COMPLETED` and `PROCESSING -> FAILED`
  only. See `state-machine.md`.
- **INV-21** `COMPLETED` and `FAILED` are terminal and are never overwritten, including
  by a late or duplicated worker.
- **INV-22** Every critical transition uses a DynamoDB conditional write or a
  transaction. Read-check-write in application memory is never used for concurrency
  control.
- **INV-23** A terminal write carries the result or the error classification in the same
  atomic operation as the status change. A workflow is never `COMPLETED` with a
  missing result.

## Idempotency

- **INV-30** Repeating a request with the same `tenantId + idempotencyKey` never starts a
  second business workflow.
- **INV-31** A repeat of an already-terminal request returns the durable stored result.
- **INV-32** The same idempotency key presented with materially different input is
  rejected as a conflict. It is never silently treated as the same request.
- **INV-33** Workflow creation and idempotency mapping are created atomically. Neither
  can exist without the other.
- **INV-34** Every worker step is durably deduplicated on `requestId + stepId`.

## Delivery and messaging

- **INV-40** All SQS consumers assume at-least-once delivery; duplicates are normal.
- **INV-41** Workers tolerate delayed, duplicated, retried and out-of-order messages.
- **INV-42** No component claims exactly-once business execution on the basis of FIFO,
  content deduplication, transactions or retries.
- **INV-43** A durable state change that requires a subsequent message publication is
  written in one DynamoDB transaction with an outbox event. No workflow-critical
  path performs a direct `update DynamoDB; then sqs.send()` dual write.
- **INV-44** Outbox publication is idempotent, and outbox event identity is deterministic.
- **INV-45** No poison message is silently dropped. Every processing queue has a DLQ,
  a redrive policy and an alarm.

## HTTP lifecycle

- **INV-50** The HTTP lifecycle and the workflow lifecycle are separate.
- **INV-51** A synchronous deadline expiry, client disconnect, ALB timeout or ECS
  shutdown never transitions a workflow to `FAILED`.
- **INV-52** After a synchronous timeout the workflow remains recoverable through
  `GET /v1/process/:requestId`.
- **INV-53** Polling is bounded, deadline-aware, backoff-based, jittered, exact-key and
  strongly consistent for the authoritative item. It never scans and never runs
  unbounded.
- **INV-54** The synchronous wait budget is strictly smaller than the ECS request
  budget, which is strictly smaller than the ALB idle timeout.

## External side effects

- **INV-60** Every external side effect is classified `NATURALLY_IDEMPOTENT`,
  `IDEMPOTENCY_PROTECTED`, `RECONCILABLE` or `UNSAFE` before integration.
- **INV-61** `UNSAFE` side effects are blockers and are not merged into the workflow.
- **INV-62** A retry after `UNKNOWN_EXTERNAL_STATE` reuses the same external idempotency
  identity or reconciles the remote operation before repeating it. It never blindly
  repeats the call.
- **INV-63** The external operation reference is derived from `requestId + stepId` and is
  persisted before the call is attempted.

## Security and tenancy

- **INV-70** Tenant identity comes only from authenticated context, never from the
  request payload.
- **INV-71** Knowing a `requestId` grants no access. Every read verifies authenticated
  tenant ownership.
- **INV-72** A tenant-ownership mismatch is indistinguishable from a missing workflow in
  the API response (`404`), so `requestId` existence cannot be probed.
- **INV-73** Secrets, tokens, credentials and raw API keys are never logged.
- **INV-74** Callers cannot control DynamoDB keys, queue routing, workflow status or
  internal resource identifiers.

## Observability

- **INV-80** Logs are structured and carry correlation fields where available.
- **INV-81** Every critical production failure condition has an alarm.
