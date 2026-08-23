# Phase 7 — Failure-path test suites

## Scope

- Docker topology: DynamoDB Local, ElasticMQ, fake provider.
- In-process dispatcher that injects duplicate, delayed, out-of-order and replayed delivery, and can kill a handler at a chosen point.
- Integration, e2e and chaos suites covering the full required scenario matrix.
- A load script producing p50/p95/p99 and sync-timeout rate.

## Out of scope

New product behaviour.

## Acceptance criteria

- Every scenario in the required matrix has a passing test that fails if the corresponding guard is removed.
- `pnpm test:integration`, `pnpm test:e2e`, `pnpm test:chaos` and `pnpm test:load` all exit 0.
