# Progress

Repository reality, not intent. Updated after every meaningful implementation, phase,
blocker, reliability, test or deployment-state change.

**Last updated:** 2026-08-24
**Current phase:** Phase 8 — review. Both reviews have now been run. `/aws-review`
CRITICAL (none) / HIGH (4) / MEDIUM (11) are fixed. `/reliability-review` CRITICAL (none) /
HIGH (2) and its five open MEDIUM findings are fixed. Both must be re-run by a human to
confirm — see B-002.
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
| 8     | `reliability-review` + `aws-review`                                    | Findings fixed; re-run to confirm     |

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
`.env.example`, `.claude/rules/*`, skills relocated to `.claude/skills/`,
`DEPLOYMENT.md` (the AWS deployment guide, linked from `README.md`).

## Verification state

All commands run on 2026-08-23 from a clean tree. Production synth now requires
`-c env=production -c availabilityZones=... -c certificateArn=... -c providerBaseUrl=...`
`-c alarmEmails=... -c imageTag=<digest|sha|version>`; each missing value throws by design
(D-021, D-022).

| Check       | Command                 | Result                                                                 |
| ----------- | ----------------------- | ---------------------------------------------------------------------- |
| Lint        | `pnpm lint`             | Pass                                                                   |
| Typecheck   | `pnpm typecheck`        | Pass (app program + CDK program)                                       |
| Unit        | `pnpm test`             | Pass — 194 tests, 13 files (59 of them CDK)                            |
| Integration | `pnpm test:integration` | Pass — 55 tests (DynamoDB Local)                                       |
| E2E         | `pnpm test:e2e`         | Pass — 10 tests; 30 consecutive green runs (was ~50% flaky)            |
| Chaos       | `pnpm test:chaos`       | Pass — 13 tests                                                        |
| Load        | `pnpm test:load`        | Pass — 200 req @ 20 concurrent, p50 918ms, p95 1564ms, 0 sync timeouts |
| CDK synth   | `pnpm cdk:synth`        | Pass (dev; production needs the five context values below)             |
| CDK diff    | `pnpm cdk:diff`         | **Not run — see B-001**                                                |

## Required failure scenarios

| Scenario                                   | Covered by                                                             |
| ------------------------------------------ | ---------------------------------------------------------------------- |
| Successful end-to-end workflow             | `tests/e2e/workflow.test.ts`                                           |
| Duplicate HTTP request                     | `tests/integration/api.test.ts`                                        |
| Simultaneous duplicate HTTP request        | `tests/integration/api.test.ts`, `persistence.test.ts`                 |
| Conflicting payload, same idempotency key  | `tests/integration/api.test.ts` (409)                                  |
| Duplicate SQS delivery                     | `tests/chaos/delivery.test.ts` (in-batch and whole-batch)              |
| Duplicate terminal completion              | `tests/integration/persistence.test.ts`                                |
| Conditional state race                     | `tests/integration/persistence.test.ts` (COMPLETED vs FAILED race)     |
| Mixed successful/failed SQS batch          | `tests/chaos/delivery.test.ts`, `packages/messaging/src/batch.test.ts` |
| Worker retry / crash behaviour             | `tests/chaos/delivery.test.ts` (crash after handler)                   |
| Poison message / DLQ path                  | `tests/chaos/delivery.test.ts`                                         |
| State update + next-event crash window     | `tests/chaos/delivery.test.ts` (dropped stream + reconciler)           |
| Duplicate outbox / stream processing       | `tests/chaos/delivery.test.ts` (stream replay)                         |
| Synchronous HTTP timeout                   | `tests/integration/api.test.ts` (202)                                  |
| Completion after HTTP timeout              | `tests/integration/api.test.ts`                                        |
| Completion at the deadline boundary        | `packages/persistence/src/waiter.test.ts`                              |
| Client disconnect                          | `tests/e2e/http-lifecycle.test.ts` (real socket abort)                 |
| ECS SIGTERM / task termination             | `tests/e2e/http-lifecycle.test.ts` (real process signal)               |
| Out-of-order delivery (Standard SQS)       | `tests/chaos/delivery.test.ts`                                         |
| External success followed by local crash   | `tests/chaos/delivery.test.ts` (succeed-then-drop)                     |
| External timeout → unknown state           | `tests/chaos/delivery.test.ts`, `provider-client.test.ts`              |
| Transient provider outage                  | `tests/chaos/delivery.test.ts`                                         |
| Cross-tenant access                        | `tests/integration/api.test.ts`, `persistence.test.ts`                 |
| Cross-request result mismatch              | `tests/e2e/workflow.test.ts` (concurrent workflows)                    |
| Terminal failure of a never-claimed step   | `tests/integration/persistence.test.ts` (D-030)                        |
| Claim identity surviving a terminal write  | `tests/integration/persistence.test.ts` (INV-63)                       |
| No configuration can fail a stale workflow | `packages/config/src/config.test.ts` (INV-51, D-029)                   |
| Resume reports the replaced step status    | `tests/integration/persistence.test.ts` (INV-62, D-034)                |
| Resume reconciles with no marker present   | `tests/integration/persistence.test.ts` (D-034)                        |
| External reference fixed at first claim    | `tests/integration/persistence.test.ts` (INV-63)                       |
| Credential refresh failure                 | `apps/api/src/auth/api-key-store.test.ts` (D-032)                      |
| Divergent terminal outcomes                | `apps/finalizer/src/handler.test.ts` (D-033)                           |

## Blockers

- **B-001 — `pnpm cdk:diff` cannot run here.** No AWS CLI, account or credentials are
  configured, and `cdk diff` must call CloudFormation to compare against a deployed
  stack. `cdk synth` works fully offline and passes. The diff is reported as not-run
  rather than fabricated. To run it: configure credentials, then
  `pnpm cdk:diff -c env=<env>`.

- **B-002 — the review skills cannot be run by the assistant; both have now been run by
  the user.** `.claude/skills/reliability-review` and `.claude/skills/aws-review` both
  declare `disable-model-invocation: true`. Both were run by the user, both returned FAIL,
  and every CRITICAL/HIGH finding from each is now fixed. **A human must re-run both** to
  confirm the fixes before this project can be called complete; the assistant cannot close
  its own findings. The `dynamodb-state` and `sqs-worker` skills were read directly as
  reference documents and their rules are reflected in the implementation, but that is not
  a substitute for the review passes.

## Reliability review — 2026-08-24

`/reliability-review` returned **FAIL**: no CRITICAL, 2 HIGH, 8 MEDIUM, 7 LOW. Both HIGH
findings are fixed, along with one LOW that was named inside a blocking remediation. The
MEDIUM and remaining LOW findings are open and non-blocking. The review must be re-run to
confirm.

Note on scope: the review executed against the tree as it stood before the `/aws-review`
fixes landed (it recorded 161 unit tests; the tree had 189). Several of its MEDIUM findings
— the unsubscribed alarm topic, `certificateArn` in staging, the defaulted
`providerBaseUrl`, the readiness-drain window — were already fixed by D-021, D-022, D-024
and D-028 before it ran. They are listed below as already-resolved rather than re-fixed.

Fixed (HIGH):

| Finding                                                                   | Fix                             |
| ------------------------------------------------------------------------- | ------------------------------- |
| `pnpm test:e2e` flaky (~50%): `ReceiptHandleIsInvalid` in the dispatcher  | `packages/testing/src/queue.ts` |
| `RECONCILE_FAIL_STALE_WORKFLOWS` could write terminal FAILED from a clock | D-029, flag deleted outright    |

Fixed (LOW, named in blocking remediation 2):

| Finding                                                        | Fix                                         |
| -------------------------------------------------------------- | ------------------------------------------- |
| Terminal step write could upsert a schema-invalid `STEP#` item | D-030, `packages/persistence` + 2 new tests |

Fixed (MEDIUM, all five):

| Finding                                                                     | Fix                                         |
| --------------------------------------------------------------------------- | ------------------------------------------- |
| `HTTP_REQUEST_TIMEOUT_MS` configured but never enforced on handler duration | D-031, `app.ts` budget hook + `sendOnce`    |
| `beginStep` reported `previous` as always `IN_PROGRESS` (`ALL_NEW`)         | D-034, `ALL_OLD` + validated reconstruction |
| `StaleWorkflow` and `TerminalConflict` emitted but not alarmed              | D-033, three new alarms                     |
| Credential refresh failure 500'd every request and retried on each one      | D-032, stale-serve with cooldown            |
| `terminalConflict` merged benign duplicates with genuine divergence         | D-033, `TerminalDivergence` signal          |

Already resolved before the review ran: the unsubscribed alarm topic (D-022),
`certificateArn` required outside dev (D-021), `providerBaseUrl` guarded at synth (D-021),
readiness-drain window derived from the health check (D-024).

Still open (LOW, none blocking):

- `PROVIDER_CONNECT_TIMEOUT_MS` is declared, defaulted and transformed but never applied to
  the axios client; a hang during connection establishment — provably safe to retry — trips
  the overall timeout and is classified `UNKNOWN_EXTERNAL_STATE`. Safe direction, wasteful.
- The outbox publisher returns an empty `batchItemFailures` when
  `record.dynamodb?.SequenceNumber` is undefined, acknowledging a batch it failed to
  publish. The reconciler recovers it, but the shape is a silent ack.
- `TerminalWriteResult.MISSING` is unhandled in the finalizer and falls into the branch
  that counts `workflowCompleted`.
- `docs/state-machine.md` documents a `stateVersion` clause in the terminal
  `ConditionExpression` that the implementation does not use (status alone is sufficient),
  and step 4 describes an unreachable branch.
- A transient DynamoDB error inside the poll loop propagates as a 500 instead of degrading
  to the controlled 202.
- API keys are indexed by unsalted SHA-256; fine for high-entropy machine tokens, but the
  minimum-entropy requirement belongs in the key-issuance runbook.

Unproven assumption raised by the review and not yet addressed: the real provider must
collapse **concurrent** in-flight requests carrying the same `Idempotency-Key`, not merely
sequential retries. Two simultaneous duplicate deliveries both reach `execute`; only
provider-side collapsing prevents a double effect. The simulated provider does this. This
extends R-005 and must be contract-tested against any real provider.

## AWS review — 2026-08-23

`/aws-review` returned **FAIL**: no CRITICAL, 4 HIGH, 11 MEDIUM, 7 LOW. All HIGH and
MEDIUM findings are fixed; the LOW findings are open. The review must be re-run to confirm.

Fixed (HIGH):

| Finding                                                               | Fix                                 |
| --------------------------------------------------------------------- | ----------------------------------- |
| Task SG could not reach the DynamoDB/S3 gateway endpoints or VPC DNS  | D-020, `network-stack.ts`           |
| Production defaulted to the mutable `latest` image tag                | D-021, `api-stack.ts`, `bin/app.ts` |
| All alarms notified an SNS topic with zero subscriptions              | D-022, `monitoring-stack.ts`        |
| `SyncTimeouts` alarm was dimensionless while emission was dimensioned | D-023, `packages/observability`     |

Fixed (MEDIUM): healthy-host / target-5xx / latency / ECS CPU+memory / Lambda-duration
alarms (`monitoring-stack.ts`); deployment rollback gate and an EventBridge rule on ECS
deployment state change (D-026); `ALBRequestCountPerTarget` autoscaling (D-025); readiness
drain window derived from the health-check configuration (D-024); container-level liveness
check in the task definition; `providerBaseUrl` guarded in production (D-021); ALB deletion
protection in production; optional Route 53 alias record (D-028); ALB access logs accepted
as absent (D-027); `linux/arm64` pinned in the Dockerfile runtime stage; the e2e lifecycle
suite moved off its hardcoded port 8181 onto an ephemeral one.

Still open (LOW, none blocking):

- `ecr:GetAuthorizationToken` and `dynamodb:ListStreams` on `Resource: "*"` are
  un-scopable by AWS design but carry no in-file justification, which
  `.claude/rules/infrastructure.md` requires.
- `enableExecuteCommand: true` in non-production cannot work without `ssmmessages`/`ssm`
  interface endpoints, which the isolated VPC does not provide.
- The CloudWatch Monitoring interface endpoint is unused: metrics are EMF-over-logs.
- Reserved concurrency (40) is 4x the ESM ceiling (10) on both queue consumers.
- `apps/api/src/routes/` is an empty directory; the routes live in `app.ts`.
- The reconciler's EventBridge target has no async-invoke failure destination.
- `deleteForTest()` is a test-only affordance on the production repository class.
- CDK's `InterfaceVpcEndpoint` defaults to `open: true`, adding a VPC-wide ingress rule
  alongside the intended security-group reference.

## Deployment gaps

Found on 2026-08-24 while writing `DEPLOYMENT.md`. None affects local behaviour or any
test; all four are only reachable by actually deploying, which is why the suites are green.
Each is documented in `DEPLOYMENT.md` section 3 with the fix.

- **G-001 — the API container is never given `AWS_REGION`.** ECS does not inject it (Lambda
  does), and `packages/config` defaults it to `us-east-1`, which is what
  `apps/api/src/composition.ts` hands to the DynamoDB and Secrets Manager clients. Any
  deployment outside `us-east-1` would point the API at a table that does not exist.
  Fix: set `AWS_REGION` in the container environment in `api-stack.ts`.

- **G-002 — the API container is never given `PUBLIC_BASE_URL`.** It defaults to
  `http://localhost:8080`, which is the `pollUrl` handed to every caller that receives a
  `202`. The recovery path advertised to B2B clients would point at their own machine.
  Fix: set `PUBLIC_BASE_URL` in the container environment in `api-stack.ts`.

- **G-003 — the ALB security group allows 443 only.** `network-stack.ts` adds one ingress
  rule; `api-stack.ts` creates a listener on port 80 in dev (no certificate) and an
  HTTP→HTTPS redirect listener on port 80 otherwise. Both are unreachable: a dev
  environment deploys successfully and cannot be called at all.
  Fix: add port 80 ingress to `albSecurityGroup`.

- **G-004 — the ECR repository is created by the stack that also starts the ECS service.**
  On a first deploy there is nowhere to push the image before the service tries to pull it,
  and the generated repository name changes on every retry, so an image pushed to a
  rolled-back repository is lost. Workable procedure in `DEPLOYMENT.md` section 5;
  the fix is to move the repository into its own stack.

## Known risks

- **R-001** ElasticMQ and DynamoDB Local are not AWS. Emulator behaviour is never treated
  as evidence about AWS semantics; adversarial conditions are injected by the dispatcher
  rather than hoped for (ADR-0009).
- **R-002** Real ALB draining, real Fargate `SIGTERM` timing under load, real DynamoDB
  throttling and real Streams behaviour cannot be exercised locally. They need validation
  in a real environment before production traffic.
- **R-003** Load numbers come from local emulators in one process. They measure shape and
  catch regressions; they are not capacity predictions. The timeout ladder values remain
  reasoned defaults until measured against real infrastructure — and so does
  `requestsPerTargetPerMinute`, which now drives autoscaling (D-025). It is derived from
  an assumed concurrent-wait capacity per task, not measured, and a real load test must
  replace it before the scaling policy can be trusted.
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

1. Human re-runs **both** `/aws-review` and `/reliability-review` to confirm the fixes;
   fix anything CRITICAL/HIGH that either surfaces. Note that `/reliability-review` ran
   against the pre-`/aws-review` tree, so a re-run is the first pass over the current one.
2. Configure an AWS account, run `pnpm cdk:diff`, review the plan.
3. Deploy to `dev` only, with explicit human approval, and validate R-002 items there.
   First deploy must confirm what only a real environment can: that image pull, log
   delivery, secret fetch and DynamoDB access all succeed with no NAT (D-020).
4. Load-test against real infrastructure and replace the derived
   `requestsPerTargetPerMinute` with a measured value (R-003, D-025).
5. Watch WAF managed-rule counts in dev before trusting blocking mode elsewhere.
6. Add a build/push pipeline that tags images by commit SHA — production now refuses a
   mutable tag, so there is no manual path that is also a correct one (D-021).
