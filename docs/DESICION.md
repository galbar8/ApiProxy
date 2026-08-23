# Decisions

The authoritative register of accepted and superseded engineering and architecture
decisions. Detailed rationale lives in `docs/adr/`. History is never rewritten: a changed
decision is marked `Superseded` and a new entry is added below it.

| ID    | Decision                                                                                                                                         | Status   | Date       | Detail                                                   |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------ | -------- | ---------- | -------------------------------------------------------- |
| D-001 | Single-table DynamoDB model, request-scoped partition keys, tenant ownership checked in application code                                         | Accepted | 2026-08-22 | [ADR-0001](adr/0001-dynamodb-single-table-key-design.md) |
| D-002 | Per-tenant API keys in Secrets Manager as the production B2B auth mechanism                                                                      | Accepted | 2026-08-22 | [ADR-0002](adr/0002-b2b-authentication-api-keys.md)      |
| D-003 | SQS Standard queues, not FIFO; safety comes from application idempotency                                                                         | Accepted | 2026-08-22 | [ADR-0003](adr/0003-sqs-standard-not-fifo.md)            |
| D-004 | Transactional outbox committed with state, published from DynamoDB Streams, with a scheduled reconciler                                          | Accepted | 2026-08-22 | [ADR-0004](adr/0004-transactional-outbox-via-streams.md) |
| D-005 | Response semantics: `200` for both terminal outcomes, `202` at the synchronous deadline, `409` on idempotency conflict, `404` on tenant mismatch | Accepted | 2026-08-22 | [ADR-0005](adr/0005-synchronous-response-semantics.md)   |
| D-006 | No S3; hard payload and result size caps instead                                                                                                 | Accepted | 2026-08-22 | [ADR-0006](adr/0006-no-s3-bounded-payloads.md)           |
| D-007 | Explicit timeout ladder validated at startup; bounded, jittered, strongly consistent, abortable polling behind a `WorkflowWaiter` interface      | Accepted | 2026-08-22 | [ADR-0007](adr/0007-timeout-ladder-and-polling.md)       |
| D-008 | External provider classified `IDEMPOTENCY_PROTECTED` + `RECONCILABLE`; timeouts are `UNKNOWN_EXTERNAL_STATE`, never `RETRYABLE`                  | Accepted | 2026-08-22 | [ADR-0008](adr/0008-external-provider-integration.md)    |
| D-009 | Local test topology: DynamoDB Local + ElasticMQ + in-process dispatcher that injects adversarial delivery                                        | Accepted | 2026-08-22 | [ADR-0009](adr/0009-local-test-topology.md)              |
| D-010 | Two-step worker chain (`worker-a` → `finalizer`) rather than one worker                                                                          | Accepted | 2026-08-22 | Below                                                    |
| D-011 | Workspace packages consumed as TypeScript source; no build step between edit and test                                                            | Accepted | 2026-08-22 | Below                                                    |
| D-012 | Skills relocated from `.claude/<name>/` to `.claude/skills/<name>/`                                                                              | Accepted | 2026-08-22 | Below                                                    |
| D-013 | VPC with no NAT gateways; workers run outside the VPC                                                                                            | Accepted | 2026-08-23 | Below                                                    |
| D-014 | Production must name its availability zones or synthesise against a concrete region                                                              | Accepted | 2026-08-23 | Below                                                    |
| D-015 | Sparse GSI partition keys are sharded                                                                                                            | Accepted | 2026-08-23 | Below                                                    |
| D-016 | The API holds no SQS permissions at all                                                                                                          | Accepted | 2026-08-23 | Below                                                    |
| D-017 | The DynamoDB Streams consumer has its own failure destination                                                                                    | Accepted | 2026-08-23 | Below                                                    |
| D-018 | `exactOptionalPropertyTypes` is relaxed for CDK code only                                                                                        | Accepted | 2026-08-23 | Below                                                    |
| D-019 | WAF on the ALB: per-IP rate limit always blocking, managed rules counting in dev                                                                 | Accepted | 2026-08-23 | Below                                                    |

## D-010 — Two-step worker chain

A single worker that wrote the terminal state directly would be simpler, but it has no
second publication step, which means the transactional outbox would be decorative and the
"crash between state update and next-event publication" scenario would be untestable.
Since that crash window is one of the failure modes the project explicitly requires the
system to survive, the pipeline keeps two steps so the mechanism that survives it is
exercised on every request.

## D-011 — Source-consumed workspace packages

`@workflow/*` packages expose `./src/index.ts` directly rather than a built `dist`.
Vitest, tsx and esbuild all resolve TypeScript natively, so there is no compile step
between changing a package and running a test that uses it. `pnpm typecheck` runs `tsc
--noEmit` over one program covering the whole workspace, which keeps type errors visible
without TypeScript project references and their composite-build constraints. Runtime
artifacts (the API container image, Lambda bundles) are produced by esbuild at build time.

## D-012 — Skill location

The four skill documents were at `.claude/aws-review/`, `.claude/dynamo-db/`,
`.claude/reliability-review/` and `.claude/sqs-worker/`. Claude Code only registers skills
under `.claude/skills/<name>/SKILL.md`, so as checked in they were unreachable by name,
and `dynamo-db/` declared `name: dynamodb-state`, which `CLAUDE.md` referenced. They were
moved to `.claude/skills/<frontmatter-name>/` so the names in `CLAUDE.md` resolve.

## Conflicts resolved against source documents

- `GOAL.md` §17/§23 (S3 for large payloads) is superseded by D-006, because `CLAUDE.md`
  forbids introducing S3. Recorded in ADR-0006 rather than silently dropped.
- `GOAL.md` §22 lists OAuth2/mTLS/SigV4 as mechanisms that _may_ be approved. D-002
  selects API keys in Secrets Manager and documents why each listed option was rejected
  in this context, satisfying the requirement that the mechanism be explicit and not a
  placeholder.
- `CLAUDE.md` "Commands" documented nine pnpm scripts before they existed. All nine now
  exist and run.

## D-013 — No NAT gateways; workers outside the VPC

The API needs DynamoDB, Secrets Manager, CloudWatch Logs and ECR. All four are reachable
through VPC endpoints, so the VPC has no NAT gateway: that removes a recurring cost, a
throughput bottleneck and an egress path nothing legitimately needs. The S3 gateway
endpoint is present only because ECR serves image layers from S3; it is a network route,
not an application dependency on S3, so ADR-0006 still holds.

Lambda workers are deliberately not VPC-attached. They need DynamoDB, SQS and the
external provider, none of which requires VPC placement, and attaching them would force
NAT back into the design purely so the finalizer could reach the provider.

## D-014 — Production requires explicit availability zones

An environment-agnostic CDK stack cannot know how many AZs a region has, so it silently
falls back to two — which would have quietly halved production's redundancy while the
config claimed three. This was caught by a CDK assertion test, not by reading the code.

`NetworkStack` now refuses to build a production stack that is both environment-agnostic
and without explicit `availabilityZones`, and refuses any AZ list shorter than the
environment requires. Offline production synth works via
`-c availabilityZones=us-east-1a,us-east-1b,us-east-1c`.

## D-015 — Sharded sparse-index partition keys

`gsi1pk` and `gsi2pk` would naturally be single constant values (`OUTBOX_PENDING`,
`WF_PROCESSING`), which would put every index write for the whole service on one
partition — a hard throughput ceiling reached exactly when the system is busiest. Both are
sharded across ten keys derived from `requestId`, and the reconciler queries every shard.

## D-016 — The API has no SQS permissions

Because publication is always a consequence of a committed transaction (ADR-0004), the API
never calls SQS. Its task role is therefore granted no SQS actions at all, which turns the
architectural rule into something IAM enforces rather than something reviewers must
remember. A CDK test asserts the absence.

## D-017 — Failure destination for the stream consumer

`ReportBatchItemFailures` checkpoints at a failing record, which is correct for ordering
but means a permanently poisonous record would block its shard indefinitely. The outbox
publisher therefore has bisect-on-error, bounded retries and an SQS failure destination
with its own alarm, so a bad record becomes visible instead of stalling publication.

## D-018 — CDK code relaxes one strictness flag

`aws-cdk-lib` prop interfaces declare optional properties as `foo?: T` while internally
passing `undefined`, which `exactOptionalPropertyTypes` rejects. Rather than scatter casts
through the stacks, `infrastructure/cdk/tsconfig.json` disables that single flag for
infrastructure code only. Every other strictness setting still applies, and application
code is unaffected.

## D-019 — WAF posture

The public endpoint sits behind a WAF with a per-IP rate-based rule and three AWS managed
rule groups.

The rate limit always blocks. Unlike content inspection it cannot mistake a valid payload
for an attack, and it matters more here than on an ordinary endpoint: this API holds a
connection open for the whole synchronous wait, so a flood consumes task capacity for
seconds per request rather than milliseconds.

Managed rule groups **count** in dev and **block** in staging and production. A managed
rule that rejects a legitimate B2B JSON body is a worse outcome than the traffic it would
have stopped, so a new environment observes counts before it blocks. `SizeRestrictions_BODY`
is permanently overridden to count, because payload size is enforced by the service itself
against a configured limit (ADR-0006) and the two limits must not disagree.
