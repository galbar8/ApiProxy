# Progress

Repository reality, not intent. Updated after every meaningful implementation, phase,
blocker, reliability, test or deployment-state change.

**Last updated:** 2026-08-23
**Current phase:** Phase 8 — review (blocked on user-invoked review skills)
**Deployment state:** never deployed. No AWS account, credentials or CLI are configured
in this environment. Nothing has been created in any AWS account.

## Phase status

| Phase | Scope                                                                  | Status                                |
| ----- | ---------------------------------------------------------------------- | ------------------------------------- |
| 0     | Workspace, tooling, docs baseline, ADRs                                | Complete                              |
| 1     | `contracts`, `config`, `observability`                                 | Complete                              |
| 2     | `persistence` (repositories, conditional writes, transactions, outbox) | Complete                              |
| 3     | `messaging`, `idempotency`, `WorkflowWaiter`                           | Complete                              |
| 4     | `apps/api` (auth, routes, waiter, health, graceful shutdown)           | Complete                              |
| 5     | Workers + simulated provider                                           | Complete                              |
| 6     | CDK v2 infrastructure                                                  | Complete (synth only; never deployed) |
| 7     | Integration / e2e / chaos / load suites                                | Complete                              |
| 8     | `reliability-review` + `aws-review`                                    | **Blocked — see B-002**               |

## What exists

**Packages**

- `@workflow/contracts` — branded ids, workflow/step schemas, error taxonomy
  (`RETRYABLE` / `NON_RETRYABLE` / `UNKNOWN_EXTERNAL_STATE`), domain model, HTTP contract,
  message envelope, outbox event, provider contract, injectable clock and jitter.
- `@workflow/config` — `configSchema` over `process.env` with startup validation of the
  timeout ladder and per-role required-variable checks.
- `@workflow/observability` — pino logger with structural credential redaction,
  AsyncLocalStorage correlation, CloudWatch EMF metrics.
- `@workflow/idempotency` — canonical payload fingerprint, deterministic event ids and
  external references.
- `@workflow/persistence` — single-table keys, item codecs with read-time validation,
  `WorkflowRepository` (atomic create, tenant-checked reads, conditional terminal writes,
  step claiming, `advanceStepWithOutbox`, sparse-index sweeps) and `DynamoWorkflowWaiter`.
- `@workflow/messaging` — SQS client, publisher, runtime message validation, partial batch
  processing.
- `@workflow/testing` — local DynamoDB/SQS harness, fake clock, stream pump, adversarial
  dispatcher, fixtures.

**Applications**

- `apps/api` — Fastify service: API-key auth, `POST /v1/process`, `GET /v1/process/:id`,
  `/health/live`, `/health/ready`, bounded polling, SIGTERM drain.
- `apps/worker-a` — enrich step; deterministic enrichment, step claim, transactional
  advance with outbox.
- `apps/finalizer` — external call with a stable idempotency identity, reconcile-before-
  retry, conditional terminal write.
- `apps/outbox-publisher` — DynamoDB Streams consumer that publishes outbox events.
- `apps/reconciler` — scheduled sweep for unpublished outbox events and stale workflows.
- `apps/fake-provider` — simulated provider with fault injection (ADR-0008).

**Infrastructure** — `infrastructure/cdk`: network (no NAT, VPC endpoints), data
(DynamoDB with streams/TTL/PITR/sparse GSIs), messaging (queues, DLQs, redrive),
workers (Lambdas, event source mappings, schedule, stream DLQ), api (ALB, WAF, Fargate,
autoscaling, ECR, Secrets Manager), monitoring (17 alarms).

**Other** — `Dockerfile` (non-root, bundled), `docker-compose.local.yml`,
`.env.example`, `.claude/rules/*`, skills relocated to `.claude/skills/`.

## Verification state

All commands run on 2026-08-23 from a clean tree.

| Check       | Command                 | Result                                                                |
| ----------- | ----------------------- | --------------------------------------------------------------------- |
| Lint        | `pnpm lint`             | Pass                                                                  |
| Typecheck   | `pnpm typecheck`        | Pass (app program + CDK program)                                      |
| Unit        | `pnpm test`             | Pass — 157 tests, 10 files                                            |
| Integration | `pnpm test:integration` | Pass — 48 tests (DynamoDB Local)                                      |
| E2E         | `pnpm test:e2e`         | Pass — 10 tests (full pipeline + real HTTP process)                   |
| Chaos       | `pnpm test:chaos`       | Pass — 13 tests                                                       |
| Load        | `pnpm test:load`        | Pass — 200 req @ 20 concurrent, p50 273ms, p95 504ms, 0 sync timeouts |
| CDK synth   | `pnpm cdk:synth`        | Pass (dev; production passes with `-c availabilityZones=...`)         |
| CDK diff    | `pnpm cdk:diff`         | **Not run — see B-001**                                               |

## Required failure scenarios

| Scenario                                  | Covered by                                                             |
| ----------------------------------------- | ---------------------------------------------------------------------- |
| Successful end-to-end workflow            | `tests/e2e/workflow.test.ts`                                           |
| Duplicate HTTP request                    | `tests/integration/api.test.ts`                                        |
| Simultaneous duplicate HTTP request       | `tests/integration/api.test.ts`, `persistence.test.ts`                 |
| Conflicting payload, same idempotency key | `tests/integration/api.test.ts` (409)                                  |
| Duplicate SQS delivery                    | `tests/chaos/delivery.test.ts` (in-batch and whole-batch)              |
| Duplicate terminal completion             | `tests/integration/persistence.test.ts`                                |
| Conditional state race                    | `tests/integration/persistence.test.ts` (COMPLETED vs FAILED race)     |
| Mixed successful/failed SQS batch         | `tests/chaos/delivery.test.ts`, `packages/messaging/src/batch.test.ts` |
| Worker retry / crash behaviour            | `tests/chaos/delivery.test.ts` (crash after handler)                   |
| Poison message / DLQ path                 | `tests/chaos/delivery.test.ts`                                         |
| State update + next-event crash window    | `tests/chaos/delivery.test.ts` (dropped stream + reconciler)           |
| Duplicate outbox / stream processing      | `tests/chaos/delivery.test.ts` (stream replay)                         |
| Synchronous HTTP timeout                  | `tests/integration/api.test.ts` (202)                                  |
| Completion after HTTP timeout             | `tests/integration/api.test.ts`                                        |
| Completion at the deadline boundary       | `packages/persistence/src/waiter.test.ts`                              |
| Client disconnect                         | `tests/e2e/http-lifecycle.test.ts` (real socket abort)                 |
| ECS SIGTERM / task termination            | `tests/e2e/http-lifecycle.test.ts` (real process signal)               |
| Out-of-order delivery (Standard SQS)      | `tests/chaos/delivery.test.ts`                                         |
| External success followed by local crash  | `tests/chaos/delivery.test.ts` (succeed-then-drop)                     |
| External timeout → unknown state          | `tests/chaos/delivery.test.ts`, `provider-client.test.ts`              |
| Transient provider outage                 | `tests/chaos/delivery.test.ts`                                         |
| Cross-tenant access                       | `tests/integration/api.test.ts`, `persistence.test.ts`                 |
| Cross-request result mismatch             | `tests/e2e/workflow.test.ts` (concurrent workflows)                    |

## Blockers

- **B-001 — `pnpm cdk:diff` cannot run here.** No AWS CLI, account or credentials are
  configured, and `cdk diff` must call CloudFormation to compare against a deployed
  stack. `cdk synth` works fully offline and passes. The diff is reported as not-run
  rather than fabricated. To run it: configure credentials, then
  `pnpm cdk:diff -c env=<env>`.

- **B-002 — the two review skills cannot be run by the assistant.**
  `.claude/skills/reliability-review` and `.claude/skills/aws-review` both declare
  `disable-model-invocation: true`, and the tooling explicitly reserves them for user
  invocation and forbids reproducing their workflow by other means. **A human must run
  `/reliability-review` and `/aws-review`**, and any CRITICAL/HIGH findings must be fixed
  and the reviews re-run before this project can be called complete. The
  `dynamodb-state` and `sqs-worker` skills were read directly as reference documents and
  their rules are reflected in the implementation, but that is not a substitute for the
  review passes.

## Known risks

- **R-001** ElasticMQ and DynamoDB Local are not AWS. Emulator behaviour is never treated
  as evidence about AWS semantics; adversarial conditions are injected by the dispatcher
  rather than hoped for (ADR-0009).
- **R-002** Real ALB draining, real Fargate `SIGTERM` timing under load, real DynamoDB
  throttling and real Streams behaviour cannot be exercised locally. They need validation
  in a real environment before production traffic.
- **R-003** Load numbers come from local emulators in one process. They measure shape and
  catch regressions; they are not capacity predictions. The timeout ladder values remain
  reasoned defaults until measured against real infrastructure.
- **R-004** `pnpm` is installed here through a corepack shim in `~/.local/bin`; CI needs
  its own pnpm provisioning step.
- **R-005** The external provider is simulated. Substituting a real provider requires
  re-running the ADR-0008 classification; a provider supporting neither idempotency keys
  nor lookup-by-reference is `UNSAFE` and, per INV-61, a blocker rather than an
  integration.
- **R-006** _(resolved 2026-08-23)_ A WAF is attached to the ALB with a per-IP rate limit
  and three AWS managed rule groups. Managed rules run in **count** mode in dev and
  **block** in staging and production; move a new environment to blocking only after
  watching its counts, since a managed rule that rejects a legitimate B2B payload is worse
  than the traffic it would have stopped.
- **R-007** The API key document must be populated out of band after deployment; the
  stack creates an empty secret. Until it is populated, every request is correctly
  rejected with `401`.
- **R-008** DynamoDB Streams shard fan-out is not load-tested. The outbox publisher is a
  single consumer per shard; sustained high write rates should be validated before
  production.

## Next steps

1. Human runs `/reliability-review` and `/aws-review`; fix CRITICAL/HIGH; re-run.
2. Configure an AWS account, run `pnpm cdk:diff`, review the plan.
3. Deploy to `dev` only, with explicit human approval, and validate R-002 items there.
4. Watch WAF managed-rule counts in dev before trusting blocking mode elsewhere.
