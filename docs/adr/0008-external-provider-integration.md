# ADR-0008: External provider integration is IDEMPOTENCY_PROTECTED and RECONCILABLE

- **Status:** Accepted
- **Date:** 2026-08-22
- **Invariants:** INV-60, INV-61, INV-62, INV-63

## Context

The `finalizer` performs the workflow's only external side effect. Every external call
has a failure mode that cannot be resolved locally: the request is transmitted, the remote
system acts on it, and the response is lost — timeout, connection reset, or a crash before
the outcome is persisted. On retry the worker cannot tell "never happened" from "already
happened".

## Decision

The integration is classified **IDEMPOTENCY_PROTECTED + RECONCILABLE**, and both
properties are used:

1. **Stable external identity.** Before the first attempt, the worker persists an
   `externalRef` derived deterministically from `requestId + stepId` on the step record.
   Every attempt sends it as the provider's `Idempotency-Key` header, so a repeated call
   is collapsed by the provider rather than duplicated.
2. **Reconciliation before repeating.** If the previous attempt ended in
   `UNKNOWN_EXTERNAL_STATE`, the next attempt does **not** re-issue the operation. It
   first issues `GET /operations/{externalRef}`. If the provider knows the operation, its
   result is adopted. Only a definitive "not found" allows a fresh attempt.

Error classification drives behaviour:

| Class                    | Examples                                                                        | Behaviour                                                                                               |
| ------------------------ | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `RETRYABLE`              | connection refused, 429, 5xx, throttling                                        | Return the record as a batch item failure; SQS redelivers.                                              |
| `NON_RETRYABLE`          | 400, 422, schema violation in the response                                      | Terminal `FAILED` with an error code. No retry.                                                         |
| `UNKNOWN_EXTERNAL_STATE` | request timeout after transmission, socket hang-up mid-flight, crash after send | Persist the step as `UNKNOWN_EXTERNAL_STATE`, then reconcile on the next attempt. Never blindly repeat. |

A timeout is deliberately **not** treated as `RETRYABLE`: the request may well have been
executed. Conflating the two is the exact mistake that produces duplicate business
operations.

## The simulated provider

Production has no third-party contract yet, so `apps/fake-provider` implements a provider
with these documented semantics: it honours `Idempotency-Key`, exposes
`GET /operations/{ref}`, and offers test-only controls to inject latency, 5xx, and the
"succeed then drop the response" behaviour. It exists so the crash-window and
reconciliation paths are proven by tests rather than asserted in prose.

## Consequences

- Swapping in a real provider requires re-running this classification. If a candidate
  provider supports neither idempotency keys nor lookup by our reference, it is `UNSAFE`
  and, per INV-61, is a blocker rather than an integration.
- The `externalRef` must be persisted **before** the call. A test asserts the write
  ordering, because the whole scheme collapses if the reference is only generated
  in memory.
- Provider responses are schema-validated before being persisted as a business result.
