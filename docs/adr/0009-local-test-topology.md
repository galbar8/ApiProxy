# ADR-0009: Local test topology — DynamoDB Local, ElasticMQ, and an in-process dispatcher

- **Status:** Accepted
- **Date:** 2026-08-22
- **Invariants:** INV-40, INV-41

## Context

The mandated failure scenarios — duplicate delivery, partial batch failure, poison
messages, crash windows, stream replay — cannot be proven with mocked SDK clients alone.
A mock asserts what we _believe_ the SDK does. But we also have no AWS credentials in this
environment, and deploying to AWS to run tests is out of scope.

## Decision

Integration, e2e and chaos suites run against containers:

| Component                     | Local stand-in                               |
| ----------------------------- | -------------------------------------------- |
| DynamoDB (incl. Streams)      | `amazon/dynamodb-local`                      |
| SQS                           | `softwaremill/elasticmq-native`              |
| External provider             | `apps/fake-provider`                         |
| Lambda + event source mapping | in-process dispatcher in `@workflow/testing` |

The dispatcher is deliberately **not** a faithful Lambda emulator. It polls the queue or
the stream, builds a real `SQSEvent` / `DynamoDBStreamEvent`, invokes the real handler,
honours `ReportBatchItemFailures` semantics, and applies visibility-timeout and
`maxReceiveCount` rules. Crucially, it can be told to inject the conditions we need to
prove: deliver a message twice, deliver out of order, kill the handler mid-transaction,
replay a stream record.

## Rationale

The value is in _injecting_ adversarial conditions, not in hoping the emulator produces
them naturally. An emulator that happens never to duplicate a message proves nothing about
duplicate handling; a dispatcher that duplicates on demand proves it every run, in CI,
deterministically.

## Consequences

- Emulator behaviour is never taken as evidence of AWS behaviour. Where the two could
  differ (visibility timeout precision, stream ordering, throttling), the test asserts the
  application's tolerance rather than the emulator's behaviour.
- Anything the local topology cannot prove — real ALB draining, real Fargate `SIGTERM`
  timing, real DynamoDB throttling — is listed as a residual risk in `docs/PROGRESS.md`
  and must be validated in a real environment before production traffic.
- Docker is a hard prerequisite for `test:integration`, `test:e2e` and `test:chaos`. Unit
  tests never require it.
