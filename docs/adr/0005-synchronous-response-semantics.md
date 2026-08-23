# ADR-0005: HTTP response semantics for the synchronous façade

- **Status:** Accepted
- **Date:** 2026-08-22
- **Invariants:** INV-31, INV-32, INV-50, INV-51, INV-52, INV-72

## Context

The API is synchronous in appearance but asynchronous underneath. The status code must
tell a B2B caller three different things without ambiguity: what happened to the business
operation, whether the answer is final, and whether retrying is useful.

## Decision

| Situation                                          | Status        | Body                                                           |
| -------------------------------------------------- | ------------- | -------------------------------------------------------------- |
| Terminal `COMPLETED` before the deadline           | `200`         | `{ status: "COMPLETED", requestId, result }`                   |
| Terminal `FAILED` before the deadline              | `200`         | `{ status: "FAILED", requestId, error: { code, message } }`    |
| Still `PROCESSING` at the synchronous deadline     | `202`         | `{ status: "PROCESSING", requestId, pollUrl }` + `Retry-After` |
| Same idempotency key, materially different payload | `409`         | `{ code: "IDEMPOTENCY_KEY_CONFLICT" }`                         |
| Schema/size validation failure                     | `400` / `413` | `{ code, details }`                                            |
| Missing or invalid credentials                     | `401`         | `{ code: "UNAUTHENTICATED" }`                                  |
| Unknown `requestId`, or owned by another tenant    | `404`         | `{ code: "NOT_FOUND" }`                                        |
| Shutting down / not ready                          | `503`         | `{ code: "SERVICE_DRAINING" }` + `Retry-After`                 |

A business `FAILED` returns `200`, not `4xx`/`5xx`.

## Rationale

`FAILED` means the pipeline ran correctly and the business answer is "no". Encoding that
as `5xx` invites the caller's HTTP client to retry a deterministic failure, multiplying
load for an outcome that will never change. Encoding it as `4xx` implies the request was
malformed, which it was not. `200` with an explicit terminal `status` field says exactly
what happened: the call succeeded, the operation did not.

`202` for deadline expiry is the crux of the design: it is explicitly **not** an error.
The workflow is untouched, still running, and the caller is handed the URL that resolves
it. Returning `504` here would tell the caller something failed, which is precisely the
inference the project forbids (INV-51).

`404` rather than `403` for a tenant mismatch keeps `requestId` non-probeable (INV-72).

## Consequences

- Callers must inspect the `status` field, not only the status code. This is documented
  in the API contract and is the one place the façade is not a plain REST resource.
- Every response carries `requestId`, so a caller that receives `202` can always recover.
- The `202` path must leave no trace on workflow state; a test asserts the item is
  byte-identical before and after a synchronous timeout apart from unrelated worker
  progress.
