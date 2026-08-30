# ADR-0003: SQS Standard queues with application-level idempotency

- **Status:** Accepted
- **Date:** 2026-08-22
- **Invariants:** INV-40, INV-41, INV-42, INV-34

## Context

The pipeline has two hops. FIFO queues offer ordering within a message group and
content-based deduplication within a 5-minute window. Both sound like they reduce the
amount of idempotency work needed.

## Decision

Use **Standard** queues for `start-queue` and `step-queue`.

## Rationale

- FIFO deduplication is a 5-minute transport-level window. A retry 6 minutes later, or a
  redrive from a DLQ hours later, is not deduplicated. Business idempotency is therefore
  required regardless, so FIFO would not remove a single line of the deduplication code.
- Ordering is not a requirement. Each workflow's steps are chained: `step-queue` receives
  a message only after `worker-a` has committed. Within a workflow there is never more
  than one in-flight step message, so there is no ordering to preserve.
- FIFO throughput is bounded per message group. Using `requestId` as the group ID would
  be correct but caps per-workflow throughput and complicates partial-batch behaviour
  (a failed record blocks its whole group).
- Standard queues have no such constraints and higher throughput headroom.

The safety that FIFO appears to offer is instead provided by: deterministic outbox event
identity, durable `requestId + stepId` step records, and conditional terminal writes.

## Consequences

- Duplicate and out-of-order delivery must be assumed everywhere, and are covered by
  explicit tests rather than assumed away.
- `ReportBatchItemFailures` is used on both event source mappings; with Standard queues a
  failed record does not force successful records in the same batch to be reprocessed.
- No component may claim exactly-once execution (INV-42).
