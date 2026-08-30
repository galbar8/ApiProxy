# Decisions

The authoritative register of accepted and superseded engineering and architecture
decisions. Detailed rationale lives in `docs/adr/`. History is never rewritten: a changed
decision is marked `Superseded` and a new entry is added below it.

| ID    | Decision                                                                                                                                         | Status                      | Date       | Detail                                                   |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------- | ---------- | -------------------------------------------------------- |
| D-001 | Single-table DynamoDB model, request-scoped partition keys, tenant ownership checked in application code                                         | Accepted                    | 2026-08-22 | [ADR-0001](adr/0001-dynamodb-single-table-key-design.md) |
| D-002 | Per-tenant API keys in Secrets Manager as the production B2B auth mechanism                                                                      | Accepted                    | 2026-08-22 | [ADR-0002](adr/0002-b2b-authentication-api-keys.md)      |
| D-003 | SQS Standard queues, not FIFO; safety comes from application idempotency                                                                         | Accepted                    | 2026-08-22 | [ADR-0003](adr/0003-sqs-standard-not-fifo.md)            |
| D-004 | Transactional outbox committed with state, published from DynamoDB Streams, with a scheduled reconciler                                          | Accepted                    | 2026-08-22 | [ADR-0004](adr/0004-transactional-outbox-via-streams.md) |
| D-005 | Response semantics: `200` for both terminal outcomes, `202` at the synchronous deadline, `409` on idempotency conflict, `404` on tenant mismatch | Accepted                    | 2026-08-22 | [ADR-0005](adr/0005-synchronous-response-semantics.md)   |
| D-006 | No S3; hard payload and result size caps instead                                                                                                 | Accepted                    | 2026-08-22 | [ADR-0006](adr/0006-no-s3-bounded-payloads.md)           |
| D-007 | Explicit timeout ladder validated at startup; bounded, jittered, strongly consistent, abortable polling behind a `WorkflowWaiter` interface      | Accepted                    | 2026-08-22 | [ADR-0007](adr/0007-timeout-ladder-and-polling.md)       |
| D-008 | External provider classified `IDEMPOTENCY_PROTECTED` + `RECONCILABLE`; timeouts are `UNKNOWN_EXTERNAL_STATE`, never `RETRYABLE`                  | Accepted                    | 2026-08-22 | [ADR-0008](adr/0008-external-provider-integration.md)    |
| D-009 | Local test topology: DynamoDB Local + ElasticMQ + in-process dispatcher that injects adversarial delivery                                        | Accepted                    | 2026-08-22 | [ADR-0009](adr/0009-local-test-topology.md)              |
| D-010 | Two-step worker chain (`worker-a` → `finalizer`) rather than one worker                                                                          | Accepted                    | 2026-08-22 | Below                                                    |
| D-011 | Workspace packages consumed as TypeScript source; no build step between edit and test                                                            | Accepted                    | 2026-08-22 | Below                                                    |
| D-012 | Skills relocated from `.claude/<name>/` to `.claude/skills/<name>/`                                                                              | Accepted                    | 2026-08-22 | Below                                                    |
| D-013 | VPC with no NAT gateways; workers run outside the VPC                                                                                            | Accepted (amended by D-036) | 2026-08-23 | Below                                                    |
| D-014 | Production must name its availability zones or synthesise against a concrete region                                                              | Accepted                    | 2026-08-23 | Below                                                    |
| D-015 | Sparse GSI partition keys are sharded                                                                                                            | Accepted                    | 2026-08-23 | Below                                                    |
| D-016 | The API holds no SQS permissions at all                                                                                                          | Accepted                    | 2026-08-23 | Below                                                    |
| D-017 | The DynamoDB Streams consumer has its own failure destination                                                                                    | Accepted                    | 2026-08-23 | Below                                                    |
| D-018 | `exactOptionalPropertyTypes` is relaxed for CDK code only                                                                                        | Accepted                    | 2026-08-23 | Below                                                    |
| D-019 | WAF on the ALB: per-IP rate limit always blocking, managed rules counting in dev                                                                 | Accepted (amended by D-035) | 2026-08-23 | Below                                                    |
| D-020 | Task egress is opened to `0.0.0.0/0` on 443, deliberately                                                                                        | Accepted (amended by D-036) | 2026-08-23 | Below                                                    |
| D-021 | Production refuses defaulted deployment inputs                                                                                                   | Accepted                    | 2026-08-23 | Below                                                    |
| D-022 | Alarms must have a subscriber, enforced at synth time                                                                                            | Accepted                    | 2026-08-23 | Below                                                    |
| D-023 | Metrics publish an aggregate series alongside every dimensioned one                                                                              | Accepted                    | 2026-08-23 | Below                                                    |
| D-024 | The readiness drain window is derived from the health-check configuration                                                                        | Accepted                    | 2026-08-23 | Below                                                    |
| D-025 | Autoscaling tracks held connections, not CPU or memory                                                                                           | Accepted                    | 2026-08-23 | Below                                                    |
| D-026 | Deployment failure is made visible, not just automatic                                                                                           | Accepted                    | 2026-08-23 | Below                                                    |
| D-027 | No ALB access logs; S3 remains excluded                                                                                                          | Accepted                    | 2026-08-23 | Below                                                    |
| D-028 | Public DNS is optional and lookup-free                                                                                                           | Accepted                    | 2026-08-23 | Below                                                    |
| D-029 | A passed deadline is never a business failure, and nothing can configure it to be                                                                | Accepted                    | 2026-08-24 | Below                                                    |
| D-030 | The terminal step write backfills a schema-valid item                                                                                            | Accepted                    | 2026-08-24 | Below                                                    |
| D-031 | The request budget is enforced, not merely configured                                                                                            | Accepted                    | 2026-08-24 | Below                                                    |
| D-032 | A failed credential refresh serves the cached document                                                                                           | Accepted                    | 2026-08-24 | Below                                                    |
| D-033 | Terminal divergence is a distinct, alarmed signal                                                                                                | Accepted                    | 2026-08-24 | Below                                                    |
| D-034 | `beginStep` reports the status it replaced                                                                                                       | Accepted                    | 2026-08-24 | Below                                                    |
| D-035 | Deployment profiles: `minimal` drops optional infrastructure and is refused outside `dev`                                                        | Accepted                    | 2026-08-30 | Below                                                    |
| D-036 | Under `minimal`, tasks run in public subnets with no interface endpoints                                                                         | Accepted                    | 2026-08-30 | Below                                                    |
| D-037 | The image repository owns its own stack                                                                                                          | Accepted                    | 2026-08-30 | Below                                                    |
| D-038 | The stack tells the API its region and its public origin; the app defaults neither                                                               | Accepted                    | 2026-08-30 | Below                                                    |

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

## D-020 — Task egress is opened to `0.0.0.0/0` on 443, deliberately

The API tasks sit in `PRIVATE_ISOLATED` subnets with `natGateways: 0`. Their security
group previously permitted egress only to the VPC CIDR, which is correct for interface
endpoints and silently fatal for gateway endpoints: DynamoDB and S3 traffic is _not_
readdressed into the VPC, it keeps the service's public address and is matched by an
AWS-managed prefix list. Every DynamoDB call and every ECR image layer (layers are served
from S3) was therefore dropped, so tasks could never have reached a running state.

The correct destination is the endpoints' prefix lists, but their IDs are region-specific
and only discoverable through a context lookup, which `.claude/rules/infrastructure.md`
forbids — `cdk synth` must work without credentials. The rule is therefore written against
`0.0.0.0/0:443`, and the confinement comes from routing rather than filtering: these
subnets have no internet gateway and no NAT, so the only destinations reachable through
that rule are the endpoints themselves.

UDP and TCP 53 to the VPC CIDR are opened alongside it. Without them the private DNS names
of the interface endpoints cannot be resolved, which makes the rest moot.

## D-021 — Production refuses defaulted deployment inputs

`certificateArn` already threw when missing. Three further inputs now behave the same way
in production, because each has a default that is safe in dev and wrong in production:

- **`imageTag`** must name an immutable build (a `sha256:` digest, a git SHA or a version),
  and the production ECR repository is created with `IMMUTABLE` tag mutability. A mutable
  tag breaks deployment in both directions: pushing a new image produces no CloudFormation
  change so no rollout starts, and the circuit breaker's rollback restores a task
  definition pointing at the same moving tag, which is not a rollback.
- **`providerBaseUrl`** must be a real HTTPS host, not the `https://provider.invalid`
  placeholder. A placeholder fails loudly rather than corrupting state, but it fails after
  deployment instead of during synth.
- **`alarmEmails`** must contain at least one subscriber. See D-022.

## D-022 — Alarms must have a subscriber, enforced at synth time

The monitoring stack created an SNS topic and attached it to every alarm, and nothing ever
subscribed to that topic. Thirty correctly-configured alarms — DLQ-not-empty, queue
backlog, DynamoDB throttling, unhealthy targets — resolved to a topic no operator received,
which is exactly the failure mode INV-45 exists to prevent.

Subscription is now a synth-time requirement in production rather than an undocumented
console step, and a CDK test asserts both that a subscription exists and that every alarm
in the stack has an alarm action.

## D-023 — Metrics publish an aggregate series alongside every dimensioned one

CloudWatch treats each EMF dimension set as a separate metric. `SyncTimeouts{reason=…}`
and `SyncTimeouts` are different series, so an alarm on the undimensioned name never
receives a datapoint when only the dimensioned set is emitted — it sits in
`INSUFFICIENT_DATA` permanently, and `treatMissingData: NOT_BREACHING` keeps it silent.
The sync-deadline alarm, the most important business alarm in a sync-over-async service,
was dead for this reason, and `WorkflowFailureRate` under-counted for the same one: it only
ever saw the failures observed inside the synchronous window.

`createMetrics` now emits `Dimensions: [[], [...names]]`, so the aggregate exists for
alarms and the breakdown remains for diagnosis. No call site has to know which of the two
an alarm depends on.

## D-024 — The readiness drain window is derived from the health-check configuration

The application flips readiness, waits, then closes its listener. That wait must outlast
the time the ALB needs to notice — `interval x (unhealthyThreshold + 1) + timeout` — or
requests arriving in the gap hit a closed listener and become ALB 5xx. The previous values
were inverted: a 5s wait against a ~20s detection window, with a code comment asserting the
opposite.

The health check is now 5s/3s with a threshold of 2 (an 18s window) and the readiness delay
is 20s. `healthCheckDetectionWindow()` computes the relationship, `ApiStack` throws if it is
violated, and a CDK test asserts it for every environment together with
`stopTimeout > readinessDelay + drain`. The application default in `packages/config` stays
at 5s: a local process has no load balancer to wait for.

## D-025 — Autoscaling tracks held connections, not CPU or memory

This service holds a connection open for the whole synchronous wait, so the resource that
runs out first is concurrent connections per task. CPU and memory both under-report it — a
task saturated with 20-second waits is nearly idle on each — and the previous memory policy
was no better a proxy than the CPU one it sat beside.

`ALBRequestCountPerTarget` is now the primary policy, with CPU retained as a secondary
floor for load shapes the request count cannot see. `requestsPerTargetPerMinute` is derived
(concurrent waits x 60 / wait seconds), **not measured**; R-003 must replace it with a
load-tested value. Scale-in cooldown is 300s so a task removed from the group can always
finish its longest request and serve out its deregistration delay.

## D-026 — Deployment failure is made visible, not just automatic

The circuit breaker only observes tasks that fail to _start_. Two alarms in the API stack —
target 5xx and unhealthy targets — now gate the rollout through `deploymentAlarms`, covering
the worse case of tasks that start happily and then serve errors. Their names are static
string literals rather than `alarm.alarmName`, because the latter resolves to a
CloudFormation `Ref` and creates a deployment-time circular dependency.

An automatic rollback is an incident that already happened, not one that was avoided, so an
EventBridge rule on `ECS Deployment State Change` (scoped to this service's ARN) publishes
`SERVICE_DEPLOYMENT_FAILED` to the alarm topic.

## D-027 — No ALB access logs; S3 remains excluded

ALB access logging requires an S3 bucket, which ADR-0006 forbids. The trade-off is accepted
rather than implicit: per-request edge forensics are lost, and the compensating evidence is
the structured application log, which carries `requestId` for every request that reached a
task. The gap is real for requests the ALB rejected before reaching a target — WAF blocks,
TLS failures, 5xx generated by the load balancer itself — which are visible only as metrics.
Revisit if an incident ever needs per-request edge attribution; that would be sufficient
grounds to supersede ADR-0006 for this one purpose.

## D-028 — Public DNS is optional and lookup-free

`hostedZoneId`, `zoneName` and `recordName` may be supplied together to create an alias
record in front of the ALB, so B2B callers reach a stable name and the load balancer can be
replaced without every client reconfiguring. The zone is built from
`HostedZone.fromHostedZoneAttributes`, never `fromLookup`, so synth still needs no
credentials. Supplying some but not all three is a synth-time error.

## D-029 — A passed deadline is never a business failure, and nothing can configure it to be

_Accepted 2026-08-24. Supersedes nothing; removes a capability that should not have existed._

The reconciler carried a `RECONCILE_FAIL_STALE_WORKFLOWS` flag which, when true, wrote a
terminal `FAILED` with code `BUSINESS_DEADLINE_EXCEEDED` to every workflow still
`PROCESSING` past `businessDeadlineAt`. The flag defaulted to off and CDK hardwired it to
`"false"`, but it was a first-class supported mode, reachable by editing one Lambda
environment variable in the console.

It is now deleted outright — the env var, the config field, the dependency, the branch and
the CDK entry — rather than left off by default, because:

- It contradicts INV-51 directly. A deadline that passed says the work is slow, not that it
  failed. Nobody observed a business outcome.
- It is at its most destructive exactly when it is least correct. A `FINALIZE` step in
  `UNKNOWN_EXTERNAL_STATE` means the provider may already have executed the operation. The
  flag would report a definitive failure to the caller for work that may have succeeded.
- Its write erased the evidence. The step update in `#writeTerminal` overwrote the
  `UNKNOWN_EXTERNAL_STATE` marker that ADR-0008 and INV-62 name as the mechanism forcing
  reconciliation, and a terminal write is unrewritable (INV-21), so no later sweep could
  correct it.
- It had no test. It was plumbed into the harness and never exercised, so the one path in
  the system that could manufacture a terminal state from a clock had zero failure-path
  coverage.

The rejected alternative was to keep it behind an ADR superseding INV-51, gated on the
absence of any `UNKNOWN_EXTERNAL_STATE` step. That buys a capability nobody asked for at the
cost of a permanent exception to a core invariant. Stale workflows remain fully visible: the
`StaleWorkflow` metric, a warning log carrying the affected `requestId`s, and the alarms in
the monitoring stack. Only a worker that actually knows an outcome may write a terminal
state.

A regression test in `packages/config/src/config.test.ts` asserts that setting the old
variable reaches no reconciler setting at all, so the flag cannot return by accident.

## D-030 — The terminal step write backfills a schema-valid item

_Accepted 2026-08-24._

`#writeTerminal` updates the step item alongside the workflow item in one
`TransactWriteItems`. That update set only `status` and `updatedAt`. Because `UpdateItem`
upserts, failing a step that was never claimed — which the finalizer does when stored input
fails validation, before `beginStep` runs — created a `STEP#` item carrying neither
`requestId`, `stepId`, `attempt` nor `createdAt`, and therefore failing `stepRecordSchema`
on every later read.

A `ConditionExpression` was considered and rejected: the step shares a transaction with the
workflow's terminal write, so a failed condition would abort both and strand the workflow in
`PROCESSING` — a strictly worse outcome than the latent decode error it would prevent. The
update instead backfills the identifying fields, using `if_not_exists` for everything a real
claim owns, so `createdAt`, `attempt`, the TTL and `externalRef` survive untouched. Two
integration tests cover both directions: the unclaimed step now reads back cleanly, and a
claimed step keeps the provider identity a retry would reuse (INV-63).

## D-031 — The request budget is enforced, not merely configured

_Accepted 2026-08-24._

`HTTP_REQUEST_TIMEOUT_MS` (22s) is the middle rung of the ADR-0007 ladder: business wait
(20s) < request budget (22s) < ALB idle (30s) < client (35s). It was passed to Fastify as
`requestTimeout`, which bounds _receiving_ a request from the client, not handling one. The
rung was therefore validated at startup by `config.superRefine` and never enforced at
runtime: a handler stuck on a slow DynamoDB call ran until the ALB gave up, and the caller
got an ALB-generated 504 instead of our controlled answer.

An `onRequest` hook now starts a `clock.sleep` for the budget, cancelled when the response
closes. If it wins, the caller gets `503 REQUEST_BUDGET_EXCEEDED` with `retry-after`. The
alternative — correcting ADR-0007 to describe what `requestTimeout` actually bounds — was
rejected because the rung exists precisely so the ALB is never the component that answers a
B2B caller.

Two properties make this safe rather than a new race:

- **One sender.** Every response in `app.ts` goes through `sendOnce`, which no-ops when
  `reply.sent` is already true. The budget timer and a late handler cannot both write; the
  loser is dropped, and it is only ever the slower duplicate of an answer already sent.
- **No state is touched.** Firing says nothing about the workflow (INV-51). The in-flight
  work continues, and the caller retries with the same idempotency key to collect the
  result rather than starting a second operation.

In the normal path it never fires: the waiter returns a 202 at the 20s synchronous
deadline, two seconds inside the budget. It exists for throttling with SDK retries beneath
`createWorkflow`, or a slow credential refresh.

## D-032 — A failed credential refresh serves the cached document

_Accepted 2026-08-24._

`SecretsApiKeyStore.resolve` awaited a refresh whenever the cache TTL had expired and let
the exception propagate, so a transient Secrets Manager failure returned 500 for every
request — even though a perfectly valid credential index was still in memory. Worse,
`#loadedAt` only advanced on success, so every request during the outage re-attempted the
refresh: a dependency wobble amplified into a retry storm against the dependency.

Once a document has loaded successfully, a failed refresh now keeps serving the cached
index and defers the next attempt by `negativeCacheMs`. A store that has never loaded a
document still throws, because an API that cannot authenticate anybody must fail loudly
rather than reject every caller as unauthenticated.

The cost is stated rather than hidden: while refreshes are failing, revocation stops
propagating and a revoked key keeps working. That is why the failure is not silent — it
emits `CredentialRefreshFailed`, which is alarmed (D-033), and logs through `onStaleServed`.
Serving stale credentials for minutes is the better of two bad options against rejecting
every legitimate B2B caller for the same period; if that trade is ever wrong for a
deployment, this decision is what should be revisited.

## D-033 — Terminal divergence is a distinct, alarmed signal

_Accepted 2026-08-24._

`docs/state-machine.md` step 3 says that on a lost terminal race the worker should compare
the stored outcome against its own and log a conflict if they differ. The implementation
counted `TerminalConflict` on _every_ `ALREADY_TERMINAL` without comparing anything, so the
routine case (a duplicate delivery reaching the same conclusion) and a genuine correctness
incident (two workers concluding COMPLETED and FAILED) were indistinguishable in both the
log and the metric.

The finalizer now compares. Same conclusion keeps `TerminalConflict` at info level. A
different conclusion emits `TerminalDivergence` at error level with both the stored and the
intended status. The same comparison guards the DECLINED path, which previously counted a
routine `WorkflowFailed` even when it had lost the race to a COMPLETED.

Three metrics gained alarms in the monitoring stack: `TerminalDivergence` (threshold zero —
the terminal state is immutable, so one occurrence is unrecoverable and worth waking up
for), `StaleWorkflow` (the only direct signal that a workflow is stuck past its business
deadline, which matters more now that D-029 removed the option of failing them), and
`CredentialRefreshFailed`.

## D-034 — `beginStep` reports the status it replaced

_Accepted 2026-08-24._

`beginStep` claimed a step with `ReturnValues: "ALL_NEW"` and derived `previous` from the
returned item. Since the same update sets `status` to `IN_PROGRESS`, `previous` was
`IN_PROGRESS` on every claim, and the `UNKNOWN_EXTERNAL_STATE` marker written by a prior
ambiguous attempt could never be observed — the marker ADR-0008 and INV-62 both name as the
mechanism that forces reconciliation.

Nothing was broken by this: the finalizer reconciles on _any_ `RESUMED` claim, which is
strictly stronger than reconciling on the marker. But a marker that cannot be read is not
evidence of anything, and the shape of the code actively invited an "optimisation" that
gated the provider lookup on `claim.previous === "UNKNOWN_EXTERNAL_STATE"` — which would
have silently disabled reconciliation and permitted a blind repeat of a possibly-executed
operation.

The claim now uses `ALL_OLD` and reconstructs the post-update record from the prior item
plus the writes just applied, all of which are known locally. The reconstruction is passed
through `decodeStep` rather than cast, so a mistake in it fails loudly instead of flowing on
as a plausible but wrong `StepRecord`. Round trips are unchanged. Four integration tests
cover it, including the complement case: a resume whose previous status is _not_
`UNKNOWN_EXTERNAL_STATE` is still reported as a resume, pinning the behaviour that must not
be narrowed.

## D-035 — Deployment profiles

`-c profile=standard|minimal`, orthogonal to `-c env`. `standard` is every environment's
default and is byte-identical to what existed before this decision. `minimal` turns off
three things — the web ACL, the interface VPC endpoints (with the placement change in
D-036) and container insights — and is the only supported way to run this service cheaply
enough to keep a dev environment alive between sessions. An idle `standard` dev
environment costs roughly four times an idle `minimal` one, almost entirely because of the
endpoints.

`applyProfile` throws for any environment but `dev`. This follows D-021: a posture that a
real environment must keep cannot be dropped by a flag on a command line, and the refusal
belongs at synth time, where every other production input is already checked. Alarms,
DLQs, redrive policies, conditional writes and the outbox are deliberately _not_
profile-controlled — INV-45 has no cheap mode, and the entire monitoring stack is a
rounding error next to the endpoints.

## D-036 — Public-subnet tasks under `minimal`

Removing the interface endpoints without moving the tasks would be incoherent: a
`PRIVATE_ISOLATED` subnet has no route to ECR, Secrets Manager or CloudWatch Logs once the
endpoints are gone, so the task would never pull its image. `minimal` therefore also places
tasks in public subnets with `assignPublicIp: true`, reaching the same services over the
internet gateway. There is still no NAT gateway in either profile, and the gateway
endpoints for DynamoDB and S3 are free and stay in both.

This is a real reduction in the security posture, recorded as such rather than softened.
Two things bound it:

- Ingress is unchanged. The task security group admits the load balancer's security group
  on 8080 and nothing else; a public IP is not an open port. A test that runs specifically
  against the minimal profile asserts this.
- The `0.0.0.0/0:443` egress rule accepted in D-020 was justified by the route table —
  "isolated subnets have no route to anything else". Under `minimal` that justification is
  false: the rule genuinely egresses to the internet, which is how the task pulls its image
  and reads its secret. `network-stack.ts` now states both cases explicitly rather than
  carrying a comment true in only one of them, and the rule's own description follows the
  profile.

The refusal outside `dev` (D-035) is what makes this acceptable. Nothing carrying real
traffic can select it.

## D-037 — The image repository owns its own stack

`ecr.Repository` moved out of `ApiStack` into `EcrStack`. It was previously created by the
same deployment that starts the service that pulls from it, which made a first deploy
unresolvable in principle: there was nowhere to push an image before ECS tried to run one,
and each rolled-back attempt generated a fresh repository name, so an image pushed to the
previous one was lost. `DEPLOYMENT.md` documented a two-terminal race as the workaround.
Splitting the stack replaces that with an order anyone can follow — create the repository,
push, deploy everything else (G-004).

Repositories in an environment whose removal policy is `DESTROY` also get
`emptyOnDelete: true`. A repository still holding images blocks its own deletion, which
turns "throw the dev environment away" into a manual hunt through the console. Never where
the policy is `RETAIN`: production images outlive their stack on purpose.

## D-038 — The stack supplies the region and the public origin

Two values the application had defaults for, which were wrong in every deployed
environment:

- `AWS_REGION`. ECS does not inject it the way Lambda does, and `packages/config` falls
  back to `us-east-1`. Any deployment elsewhere pointed its DynamoDB and Secrets Manager
  clients at a region holding neither the table nor the secret (G-001).
- `PUBLIC_BASE_URL`, which builds the `pollUrl` returned with every `202`. It defaulted to
  `http://localhost:8080`, so the recovery path advertised to a timed-out B2B caller
  pointed at the caller's own machine (G-002).

Both are now rendered by `ApiStack` from values it already holds: the stack's region, and
either an explicit `-c publicBaseUrl`, the Route 53 record, or the load balancer's own DNS
name with the scheme its listener actually serves. The application-side defaults remain,
because they are correct for a local process, but nothing deployed relies on them.
