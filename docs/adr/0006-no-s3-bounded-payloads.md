# ADR-0006: No S3; bounded payload and result sizes

- **Status:** Accepted
- **Date:** 2026-08-22
- **Invariants:** INV-74
- **Supersedes:** the S3-based large-payload guidance in `GOAL.md` sections 17 and 23

## Context

`GOAL.md` section 17 says large payloads belong in S3 with messages carrying a
`payloadRef`. `CLAUDE.md` states plainly: _"Do not introduce S3 unless a future accepted
architecture decision explicitly requires it."_ `CLAUDE.md` is the checked-in project
instruction and takes precedence, so this conflict is resolved here rather than silently.

## Decision

No S3. Instead, enforce hard size bounds at every boundary:

- Request payload: `MAX_REQUEST_PAYLOAD_BYTES` (default 120 KB). Exceeding it returns
  `413` before any state is created.
- Persisted result: `MAX_RESULT_BYTES` (default 120 KB). A worker producing a larger
  result fails the workflow with a `NON_RETRYABLE` `RESULT_TOO_LARGE` error rather than
  attempting a write that DynamoDB would reject.
- SQS messages carry the `requestId` and step metadata, not the business payload. Workers
  read the payload from DynamoDB using the exact key. This keeps messages far below the
  256 KB SQS limit regardless of payload size.

The `payloadRef` / `resultRef` fields exist in the schema but are unused, so a future
object-store decision does not require a data migration.

## Consequences

- The service is unsuitable for large-document workloads as built. This is a documented
  limitation, not an oversight.
- DynamoDB's 400 KB item limit is respected with clear headroom: payload + result +
  metadata stay under it by construction.
- Raising the caps requires re-checking the item-size budget; the limits are asserted in
  a test so a careless bump fails CI.

## Revisiting

If a real workload needs larger payloads, supersede this ADR, introduce S3 with
least-privilege bucket policies, and populate `payloadRef`/`resultRef`. Validate any
caller-supplied reference against a server-derived key prefix — never accept a caller
bucket or key.
