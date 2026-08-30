# Phase 3 — Messaging, idempotency and the waiter

## Scope

- `@workflow/messaging`: SQS publisher, message envelope construction and runtime validation, partial-batch-failure helpers.
- `@workflow/idempotency`: canonical payload fingerprinting and idempotency-key validation.
- `WorkflowWaiter`: bounded, deadline-aware, exponential-backoff, jittered, abortable, strongly consistent polling behind an interface with an injected clock.

## Out of scope

HTTP routes, worker handlers.

## Acceptance criteria

- Waiter tests with a fake clock prove: terminal detection, hard deadline respected, delays back off and are capped, jitter applied, abort is immediate, no state mutation on timeout.
- Fingerprint is stable across key ordering and whitespace, and changes on material payload change.
