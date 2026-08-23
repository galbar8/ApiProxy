# ADR-0004: Transactional outbox published by DynamoDB Streams, with a scheduled reconciler

- **Status:** Accepted
- **Date:** 2026-08-22
- **Invariants:** INV-43, INV-44, INV-45

## Context

Two points in the workflow require "durable state change AND a future message" to be one
indivisible fact:

1. API: workflow created → the start message must eventually be published.
2. `worker-a`: step committed → the next-step message must eventually be published.

A direct dual write (`write DynamoDB`, then `sqs.sendMessage`) has a crash window between
the two calls. A crash there leaves a `PROCESSING` workflow that nothing will ever
advance. That is exactly the stranded-workflow failure the project forbids.

## Decision

Write an **outbox event item in the same `TransactWriteItems`** as the state change, and
publish it asynchronously from the table's **DynamoDB Stream**.

- `eventId = sha256(requestId | step | workflowVersion)` — deterministic, so a replay
  produces the same identity rather than a new event.
- Stream view type is `NEW_AND_OLD_IMAGES`; the publisher needs the new image to build the
  message and the old image to ignore its own `publishedAt` update.
- After a successful `SendMessage`, the publisher marks the event published by setting
  `publishedAt` and **removing** `gsi1pk`, which drops it out of the sparse GSI1.
- `publishedAt` is a progress marker and an operational signal, **not** the duplicate
  protection. Duplicate protection is the consumer's `requestId + stepId` step record.

A **scheduled reconciler** (EventBridge, every 5 minutes) queries sparse `GSI1` for outbox
events still unpublished after a threshold and republishes them. This covers the residual
failure modes the stream alone does not: exhausted stream retries, a stream record aged
out, a publisher bug deployed and rolled back.

## Consequences

- No workflow-critical dual write exists in the codebase. Reviews should flag any
  `sqs.send` that is not inside the publisher or the reconciler.
- Publication is at-least-once. The system does not claim otherwise.
- The publisher has its own DLQ and an alarm; a poison outbox event is visible, not lost.
- Cost: one extra item per hop, one stream-driven Lambda invocation per hop, and a small
  sparse index. Accepted as the price of removing the stranded-workflow class entirely.
- Latency: the stream adds a sub-second hop between commit and publish. The synchronous
  budget accounts for it.

## Alternatives considered

**Publish from the API/worker after commit, with the outbox only as a repair mechanism.**
Lower latency, but reintroduces the exact code path we are trying to eliminate and makes
the crash window depend on how quickly the repair job runs. Rejected: the whole point is
that no correctness-critical path performs the dual write.

**Poll the outbox table instead of using Streams.** Simpler to reason about, but adds
steady-state query load and latency proportional to the poll interval. Streams give
push-based publication with the reconciler as the safety net; that combination is
strictly better than polling alone.
