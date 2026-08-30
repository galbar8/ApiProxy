# ADR-0001: Single-table DynamoDB model with request-scoped partition keys

- **Status:** Accepted
- **Date:** 2026-08-22
- **Invariants:** INV-10, INV-22, INV-33, INV-71, INV-72

## Context

Workflow records, idempotency mappings, per-step dedup records and outbox events must be
written atomically in several combinations:

- workflow + idempotency mapping (creation)
- step state + outbox event (worker progression)
- terminal workflow state + step state (finalisation)

`TransactWriteItems` works across tables, but a single table keeps the transaction, the
stream, the TTL policy and the backup policy in one place, and lets the workflow item and
its step/outbox children share a partition so they are read together cheaply.

The partition key choice matters more than usual here, because the synchronous API polls
the workflow item with strongly consistent reads, potentially several times per second per
in-flight request.

## Decision

One table with generic `pk`/`sk`:

| Item        | pk                                 | sk                 |
| ----------- | ---------------------------------- | ------------------ |
| Workflow    | `REQ#<requestId>`                  | `WORKFLOW`         |
| Idempotency | `IDEM#<tenantId>#<idempotencyKey>` | `IDEM`             |
| Step        | `REQ#<requestId>`                  | `STEP#<stepId>`    |
| Outbox      | `REQ#<requestId>`                  | `OUTBOX#<eventId>` |

The partition key is **request-scoped, not tenant-scoped**. Tenant ownership is an
attribute on the item, verified in the application after an exact-key read.

A tenant mismatch returns `404`, not `403`, so possessing a `requestId` cannot be used to
probe whether a workflow exists (INV-72).

## Consequences

- `requestId` is a UUIDv4, so partitions spread uniformly and no single tenant can create
  a hot partition, even under sustained polling.
- Cross-tenant isolation is enforced in code rather than by key structure, which means it
  must be covered by explicit tests. `WorkflowRepository.getForTenant` is the only read
  path exposed to HTTP handlers, and it performs the check internally, so a caller cannot
  forget it.
- Listing a tenant's workflows is not supported by the base table. It is not a
  requirement; if it becomes one, it needs a new sparse GSI and its own ADR.

## Alternatives considered

**`pk = TENANT#<tenantId>`, `sk = REQ#<requestId>`.** Makes cross-tenant reads
structurally impossible, which is genuinely attractive. Rejected because every request
from one tenant, including all polling reads, lands in one partition. A single busy
tenant would hit the per-partition throughput ceiling and start throttling the polling
loop, which is the most latency-sensitive read in the system. Trading a hard availability
ceiling for a check that a test can enforce is the wrong trade.

**Separate tables per item type.** Rejected: it breaks single-table transactions for
workflow + idempotency creation without buying anything.
