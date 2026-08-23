# ADR-0002: Per-tenant API keys in Secrets Manager as the production B2B auth mechanism

- **Status:** Accepted
- **Date:** 2026-08-22
- **Invariants:** INV-70, INV-71, INV-73

## Context

`GOAL.md` section 22 forbids inventing an authentication mechanism or shipping a
placeholder treated as production security, and requires that the chosen mechanism be
explicitly documented. It lists OAuth2/JWT, mTLS and IAM/SigV4 as mechanisms that _may_
be approved; the list is illustrative, not exhaustive.

Each listed option carries a concrete cost here:

- **OAuth2/JWT** requires an identity provider to exist and be operated. There is none,
  and standing one up is a larger commitment than this service justifies.
- **mTLS at the ALB** requires a trust store, and ALB trust stores are backed by an S3
  bucket — which `CLAUDE.md` forbids introducing (see ADR-0006).
- **IAM/SigV4** has no native verification at an ALB; it would require API Gateway in
  front, adding a service the documented architecture does not include.

## Decision

Authenticate callers with **per-tenant API keys stored in AWS Secrets Manager**.

- Header: `Authorization: ApiKey <key>`.
- The secret holds a JSON document: a list of tenants, each with a `tenantId`, a status,
  and one or more keys identified by a `kid` and stored as a **SHA-256 hash**. Raw key
  material is never stored in the secret, never written to DynamoDB and never logged.
- The API resolves a presented key by hashing it and looking the hash up in an in-memory
  map, refreshed from Secrets Manager on a TTL and on cache miss (bounded by a
  negative-lookup cooldown so an invalid-key flood cannot become a Secrets Manager flood).
- Comparison is constant-time.
- Multiple active keys per tenant are supported so keys can be rotated without downtime:
  add the new key, migrate the caller, remove the old key.
- `tenantId` is taken exclusively from the resolved key. Any `tenantId` in a request body
  is ignored.

This is the accepted production mechanism, not a stand-in.

## Consequences

- Bearer credentials are replayable if intercepted, so TLS is mandatory end to end and
  the key must never appear in logs, URLs or error messages. The logger redacts the
  `authorization` header.
- Revocation latency equals the cache TTL. `AUTH_CACHE_TTL_MS` is configurable and a
  forced refresh happens on cache miss, so a removed key stops working within one TTL.
- The API's task role needs `secretsmanager:GetSecretValue` on exactly one secret ARN.
- If a future requirement demands cryptographic proof of caller identity or per-request
  non-repudiation, this decision should be superseded by mTLS or signed requests, and the
  S3 constraint in ADR-0006 revisited.

## Alternatives considered

Storing key hashes in DynamoDB instead of Secrets Manager: rejected because it puts a
credential store in the same table as business state and adds a read to the hot path
without improving rotation.
