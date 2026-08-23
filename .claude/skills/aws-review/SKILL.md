---
name: aws-review
description: >
  Perform a rigorous read-only production review of AWS architecture and CDK
  changes for this sync-over-async workflow service. Use before merge, staging,
  or production deployment when changes touch ECS/Fargate, ALB, SQS, Lambda,
  DynamoDB, IAM, VPC/networking, WAF, CloudWatch, autoscaling, encryption,
  secrets, deployment configuration, or AWS service limits.
argument-hint: "[environment] [base-ref|path|scope]"
disable-model-invocation: true
context: fork
effort: high
allowed-tools:
  - Read
  - Grep
  - Glob
  - Bash(git status *)
  - Bash(git diff *)
  - Bash(git log *)
  - Bash(git show *)
  - Bash(rg *)
  - Bash(pnpm lint)
  - Bash(pnpm typecheck)
  - Bash(pnpm test)
  - Bash(pnpm test:integration)
  - Bash(pnpm test:e2e)
  - Bash(pnpm cdk:synth)
  - Bash(pnpm cdk:diff)
---

# AWS Review

Perform a production-grade, read-only AWS architecture and infrastructure review.

Do not modify files.
Do not deploy.
Do not run AWS commands that create, update, delete, or mutate resources.
Do not weaken reliability or security invariants for convenience.

Scope:

`$ARGUMENTS`

Typical usage:

```text
/aws-review dev
/aws-review staging main
/aws-review production infrastructure/cdk
```

If the environment cannot be determined, report `UNKNOWN`.

---

# 1. Target architecture

Assume the intended architecture is:

```text
Client
  |
  v
Route 53 / TLS / optional WAF
  |
  v
Application Load Balancer
  |
  v
ECS/Fargate API
  |
  +---- DynamoDB
  |       authoritative workflow state
  |
  +---- SQS
          |
          v
       Lambda worker
          |
         SQS
          |
         ...
          |
          v
       finalizer
          |
          v
       DynamoDB
          ^
          |
   bounded polling
          |
          v
  original HTTP request
```

Core invariants:

```text
DynamoDB = authoritative business state
SQS = transport
ECS = synchronous HTTP connection owner
HTTP timeout != business failure
SQS/Lambda delivery is at least once
side effects must be idempotent or reconcilable
```

AWS features support these invariants. They do not replace application logic.

---

# 2. Read project context first

Read when present:

1. `CLAUDE.md`
2. `docs/invariants.md`
3. `docs/architecture.md`
4. `docs/state-machine.md`
5. relevant ADRs under `docs/adr/`
6. relevant phase under `docs/phases/`
7. root `package.json`
8. affected CDK stacks/constructs
9. ECS shutdown/health code
10. affected SQS workers
11. affected DynamoDB repositories
12. relevant tests

If infrastructure conflicts with a documented invariant, infrastructure is
wrong unless an approved ADR changes the invariant.

---

# 3. Establish scope

Inspect:

```bash
git status --short
git diff --stat
git diff
```

Identify changes to:

- VPC/subnets/routes/NAT/endpoints
- security groups
- ALB/listeners/target groups
- ACM/TLS/WAF
- ECS cluster/service/task definition
- ECS task role/execution role
- autoscaling/deployment settings
- ECR
- SQS/DLQ
- Lambda/event source mappings
- DynamoDB/tables/indexes/streams
- S3
- KMS
- Secrets Manager/SSM
- CloudWatch
- EventBridge
- IAM
- Route 53
- CDK removal/deletion policies

Do not review only the changed file if imported constructs alter behavior.

---

# 4. Severity

Use exactly:

```text
CRITICAL
HIGH
MEDIUM
LOW
```

## CRITICAL

Use when there is a credible path to:

- delete authoritative production state
- expose private data or secrets
- cross-tenant access
- unsafe public exposure of a critical service
- duplicate/lost irreversible business operation due to infrastructure
- permanently strand workflow continuation
- dangerously broad mutation permissions
- make rollback impossible after a destructive production change

## HIGH

Examples:

- one production ECS task without an accepted availability exception
- ALB/ECS timeout or draining cuts off normal synchronous requests
- unsafe deployment configuration
- SQS visibility timeout below safe Lambda relationship
- no DLQ for critical processing queue
- partial batch configuration missing while worker expects it
- authoritative DynamoDB protection missing in production
- unintended public ingress
- task role/execution role confusion
- critical alarms absent
- production table replacement in CDK diff

## MEDIUM

Examples:

- missing non-critical alarms
- aggressive scale-in
- weak health checks
- no pending-request load metric for a connection-heavy service
- cost/capacity assumptions not load-tested
- unnecessary NAT cost
- weak deployment-failure visibility

## LOW

Naming, tags, maintainability, minor cost or dashboard improvements.

CRITICAL and HIGH block acceptance.

---

# 5. Environment rules

Classify:

```text
local
dev
staging
production
UNKNOWN
```

Production should normally have:

- multiple AZs
- more than one ECS task
- explicit durable-data protection
- rollback capability
- least-privilege IAM
- TLS
- secrets outside source
- alarms
- explicit timeout/drain configuration
- scaling/capacity strategy
- IaC-managed critical settings

Do not silently use development defaults in production.

---

# 6. Infrastructure as Code

Critical production behavior must be represented in CDK or approved IaC.

Do not accept manual-console configuration as sufficient proof for:

- IAM
- security groups
- ALB attributes
- queue redrive
- DynamoDB PITR/deletion protection
- autoscaling
- alarms
- encryption

Run when available:

```bash
pnpm cdk:synth
pnpm cdk:diff
```

Inspect the diff for:

- replacement/deletion
- IAM widening
- public ingress
- alarm removal
- encryption removal
- DLQ/redrive changes
- DynamoDB key changes
- ECS desired-count changes
- timeout changes
- networking changes

A successful synth is not a reliability proof.

---

# 7. Destructive production changes

Treat as severe:

```text
DynamoDB table replacement
DynamoDB key change
authoritative table deletion
business-data S3 bucket deletion
KMS replacement/deletion affecting readable data
queue replacement that can drop in-flight work
DLQ removal
DynamoDB Stream removal while outbox depends on it
ALB replacement without traffic migration
```

Require:

- migration plan
- rollback plan
- backup/recovery plan
- traffic transition plan where applicable
- explicit human approval

---

# 8. VPC and multi-AZ

Review:

- enabled AZ count
- public/private subnet placement
- route tables
- internet gateway
- NAT
- VPC endpoints
- security groups

Expected production pattern:

```text
Internet
  |
  v
ALB in public subnets across AZs
  |
  v
ECS tasks in private subnets across AZs
```

Do not expose Fargate tasks directly to the Internet unless explicitly required.

Production `desiredCount = 1` is HIGH unless documented and accepted.

Ask:

```text
If one AZ disappears, is the API still available?
```

---

# 9. NAT and VPC endpoints

Verify private workloads can reach everything they need:

- ECR
- CloudWatch Logs
- DynamoDB
- SQS
- S3
- Secrets Manager
- external providers

Possible endpoints include ECR, Logs, SQS, Secrets Manager, S3, and DynamoDB.

Do not add every endpoint automatically. Evaluate security, cost, traffic, and
complexity.

A private subnet with no valid egress path is HIGH.

---

# 10. Security groups

Expected API flow:

```text
Internet -> ALB SG :443
ALB SG   -> ECS SG :application-port
```

Flag:

```text
0.0.0.0/0 -> ECS application port
::/0      -> ECS application port
```

unless explicitly justified.

Prefer security-group references over broad CIDRs for internal service paths.

---

# 11. TLS and WAF

Production external endpoints should use HTTPS.

Review:

- ACM certificate
- listener 443
- domain/certificate match
- HTTP redirect if desired
- TLS policy
- Route 53 target

Evaluate WAF for internet-facing B2B endpoints:

- rate-based rules
- managed rules where justified
- IP allowlists where contractual
- request-size controls

WAF is not authentication.

---

# 12. ALB idle timeout

This service keeps HTTP requests open while internal asynchronous work executes.

Current AWS baseline verified 2026-08-20:

```text
ALB idle timeout default: 60 seconds
valid range: 1-4000 seconds
```

Do not depend on the default. Configure intentionally.

Review:

```text
business synchronous wait
API/server response budget
ALB idle timeout
recommended client timeout
```

Do not set all layers to expire at exactly the same time.

Also inspect the application's own HTTP server timeout behavior.

---

# 13. ALB deregistration / draining

Current AWS baseline verified 2026-08-20:

```text
target deregistration delay default: 300 seconds
range: 0-3600 seconds
```

Review compatibility between:

```text
maximum synchronous request duration
ALB deregistration delay
ECS stopTimeout
application SIGTERM/draining behavior
```

Connection draining improves availability.

Business correctness must still survive forced termination.

---

# 14. ECS shutdown

Review application handling for `SIGTERM`.

Expected:

1. mark readiness false
2. stop accepting new requests
3. stop creating new synchronous waiters
4. allow existing requests to finish within drain budget
5. close resources
6. exit

The workflow must remain recoverable even if graceful shutdown fails.

State required for business recovery must not exist only in ECS memory.

---

# 15. Fargate stopTimeout

Current AWS baseline verified 2026-08-20:

```text
default stopTimeout: 30 seconds
maximum on Fargate: 120 seconds
```

Do not assume a 300-second ALB deregistration delay keeps the container alive for
300 seconds after ECS begins stopping it.

Explain how:

```text
deregistration delay
stopTimeout
maximum normal synchronous wait
```

work together.

---

# 16. ECS health checks

Review:

- container health check
- `/health/live`
- `/health/ready`
- ALB health-check path
- success matcher
- interval/thresholds
- `healthCheckGracePeriodSeconds`

Readiness should fail while draining.

Do not make liveness depend on a temporary downstream outage in a way that
causes mass task replacement unless intentional.

Distinguish:

```text
alive
```

from:

```text
ready for new traffic
```

---

# 17. ECS capacity and deployments

For production, normally expect:

```text
desiredCount >= 2
minimum autoscaling capacity >= 2
```

unless accepted otherwise.

For rolling ECS services, current AWS defaults are:

```text
minimumHealthyPercent = 100
maximumPercent = 200
```

Review whether deployment can start replacement capacity before removing too
much healthy capacity.

Do not reduce availability just to speed deployment.

---

# 18. ECS deployment circuit breaker

For rolling deployments, strongly consider:

```text
deployment circuit breaker enabled
rollback enabled
```

AWS can fail a deployment that does not reach steady state and roll back to the
last completed deployment.

Also require deployment-failure visibility through CI/CD, EventBridge,
CloudWatch, or another operational channel.

---

# 19. ECS task scale-in protection

Current AWS baseline verified 2026-08-20:

```text
default protection when enabled: 2 hours
configurable: 1-2880 minutes
```

Task protection can reduce interruption of active requests during scale-in or
deployments.

It is optional.

It is not a correctness mechanism.

If used:

- enable only when needed
- disable when no protected work remains
- ensure deploys cannot remain blocked indefinitely
- monitor protection failures

---

# 20. ECS autoscaling

CPU alone may be misleading for this architecture.

An API task can hold many waiting HTTP requests with low CPU.

Review:

- CPU
- memory
- ALBRequestCountPerTarget
- custom metrics

Consider a metric such as:

```text
PendingSynchronousRequestsPerTask
```

if load tests show it represents pressure.

Do not invent a target value without measurements.

Scale-in should be conservative because tasks own open HTTP connections.

---

# 21. ECS IAM roles

Distinguish:

## Task execution role

Used by ECS/Fargate infrastructure, for example:

- ECR image pull
- logging
- referenced secrets depending on configuration

## Task role

Used by application code inside the container.

Application access such as:

```text
DynamoDB
SQS
S3
Secrets Manager
```

belongs in the task role.

Flag role confusion.

Use least privilege.

---

# 22. Lambda IAM roles

Each worker should have only the permissions required for its step.

Review access to:

- source queue
- destination queue
- specific DynamoDB table/index
- specific S3 bucket/prefix
- specific secret
- KMS key if required

Flag broad:

```text
Action: "*"
Resource: "*"
```

unless an action cannot be resource-scoped and this is documented.

---

# 23. Secrets

Secrets must not be stored in:

- source
- committed `.env`
- Docker image
- plaintext CDK constants
- CloudFormation outputs
- logs

Use Secrets Manager or approved SSM usage.

Review:

- IAM
- rotation requirements
- injection path
- redaction

---

# 24. ECR

Review:

- unique immutable deployment identifier
- image scanning according to security policy
- lifecycle
- rollback ability

Do not rely only on mutable:

```text
latest
```

for production.

Prefer digest or unique version tag.

---

# 25. SQS/Lambda delivery model

AWS Lambda SQS event source mappings process records at least once and duplicate
processing can occur.

Infrastructure cannot replace application idempotency.

If worker code is not idempotent, return FAIL even if SQS is FIFO.

---

# 26. SQS visibility timeout

Inspect:

```text
Lambda timeout
SQS visibility timeout
MaximumBatchingWindowInSeconds
```

Current AWS guidance:

```text
visibilityTimeout >=
6 * lambdaTimeout
+ MaximumBatchingWindowInSeconds
```

when a batching window is configured.

Also:

```text
lambdaTimeout <= visibilityTimeout
```

must hold.

Example:

```text
lambda timeout = 30s
batch window = 5s
recommended minimum visibility = 185s
```

Flag unsafe values.

---

# 27. SQS DLQ

Every critical production processing queue should have:

- DLQ
- redrive policy
- deliberate maxReceiveCount
- adequate retention
- CloudWatch alarm
- recovery/redrive runbook

Current AWS Lambda/SQS guidance recommends:

```text
maxReceiveCount >= 5
```

as a starting point.

Do not force exactly 5 if measured/business retry semantics justify another value.

---

# 28. Partial batch responses

When Lambda processes SQS batches, verify:

```text
ReportBatchItemFailures
```

is configured if handler logic returns partial failures.

By default, a failed batch can cause successful records to become visible again.

Handler and event source mapping must agree.

---

# 29. SQS batch sizes

Current AWS baseline:

```text
Standard SQS -> Lambda max batch size: 10,000
FIFO SQS -> Lambda max batch size: 10
```

For Standard batch size above 10:

```text
MaximumBatchingWindowInSeconds >= 1
```

is required.

Do not maximize batch size automatically.

Review:

- message size
- 6 MB Lambda invocation payload
- Lambda timeout
- downstream capacity
- partial failure behavior
- latency SLA

---

# 30. FIFO

If FIFO is used, inspect:

```text
MessageGroupId
MessageDeduplicationId
group cardinality
business ordering requirement
```

A single global group can serialize a high-scale workload.

FIFO does not remove application idempotency requirements.

---

# 31. Lambda concurrency / backpressure

Review:

- event source maximum concurrency
- function reserved concurrency
- provisioned pollers if used
- aggregate concurrency across event sources
- downstream quotas

Do not allow Lambda to scale beyond a provider/database's safe concurrency
without an explicit backpressure strategy.

Avoid retry storms.

---

# 32. Lambda networking

If Lambda is in a VPC, verify egress to:

- DynamoDB
- SQS
- S3
- Secrets Manager
- external providers

Review NAT/endpoints/security groups.

Do not put Lambda in a VPC by default if no private dependency requires it.

---

# 33. DynamoDB production protection

For authoritative production tables review:

- PITR
- deletion protection
- encryption
- removal policy
- TTL
- Streams
- GSIs
- capacity mode
- alarms
- IAM

Current AWS baseline verified 2026-08-20:

```text
PITR supports up to 35 days of continuous recovery history.
Deletion protection is supported and is disabled by default unless configured.
```

For production authoritative state, normally expect:

```text
PITR enabled
deletion protection enabled
RemovalPolicy.RETAIN or equivalent safe policy
```

unless an ADR explicitly says otherwise.

---

# 34. DynamoDB capacity

Current DynamoDB API guidance recommends:

```text
PAY_PER_REQUEST for most workloads
PROVISIONED for steady predictable workloads with forecastable capacity
```

Do not change mode by habit.

Account for the polling pattern:

```text
concurrent waiters
* polls/sec
= DynamoDB reads/sec
```

Include strong-read cost and item size.

---

# 35. DynamoDB scale risks

Review:

- hot partition keys
- low-cardinality GSIs
- large items
- high transaction rate
- strong polling reads
- GSI write amplification

Flag request-path `Scan`.

Flag low-cardinality high-volume partition keys such as:

```text
PK = status
```

unless deliberately sharded.

---

# 36. DynamoDB Streams/outbox

If Streams drive an outbox:

- Stream enabled
- correct view type
- consumer exists
- consumer is retry-safe
- duplicate processing is safe
- lag is observable
- Stream removal is treated as workflow-impacting

Do not assume Streams produce exactly-once business delivery.

---

# 37. DynamoDB TTL

TTL is asynchronous cleanup.

Do not use TTL as:

```text
exact timeout
exact scheduler
business failure transition
```

Retention must support:

- client retries
- reconciliation
- incident investigation
- audit requirements

---

# 38. Large data / S3

For large workflow inputs/results, review:

- S3 bucket encryption
- public access block
- lifecycle
- retention
- removal policy
- IAM
- object key design
- consistency between result reference and terminal workflow state

Do not embed arbitrarily large results into DynamoDB or SQS.

---

# 39. CloudWatch logs

Review:

- log groups
- retention
- structured logging
- correlation fields
- secret redaction

Useful fields include:

```text
requestId
messageId
step
workflowVersion
tenantId
durationMs
errorCode
```

Do not log large payloads or secrets.

---

# 40. Required metrics/alarms

Review visibility for:

```text
HTTP 5xx
HTTP timeout rate
HTTP p95/p99 latency
healthy ECS tasks/targets
ECS CPU/memory
pending synchronous requests
SQS queue depth
SQS ApproximateAgeOfOldestMessage
DLQ visible messages
Lambda errors
Lambda throttles
Lambda duration
DynamoDB throttling
workflow failure rate
deployment failures
```

A critical DLQ without an alarm is HIGH.

For SLA queues, oldest-message age is often more useful than depth alone.

---

# 41. Authentication / tenant isolation

WAF, security groups, `clientId`, and `requestId` are not authentication.

Production B2B authentication must be explicitly defined, for example:

```text
OAuth2/JWT
mTLS
IAM/SigV4
```

Review that infrastructure does not allow callers to:

- choose arbitrary internal queues
- choose arbitrary tables/resources
- access another tenant's result
- access AWS credentials
- bypass the application authorization boundary

Cross-tenant exposure is CRITICAL.

---

# 42. Route 53

If using custom domains, review:

- hosted zone
- environment separation
- alias target
- certificate match
- cutover/rollback plan

Do not allow production DNS to point accidentally to staging resources.

---

# 43. Multi-region

Do not approve active-active multi-region simply because AWS services support it.

Require an ADR defining:

- request routing
- state writer ownership
- DynamoDB Global Tables conflict semantics
- cross-region idempotency
- SQS region ownership
- external side-effect duplication prevention
- failover
- terminal-state conflict resolution

Default architecture is single-region, multi-AZ unless specified otherwise.

---

# 44. Service quotas

For big-scale production, require a quota audit for expected peak load.

Potentially relevant:

- Fargate vCPU quota
- ECS task/service quotas
- Lambda regional concurrency
- SQS FIFO throughput if used
- DynamoDB throughput behavior
- NAT capacity
- KMS request quotas
- VPC endpoint quotas
- CloudWatch volume

Do not hardcode account/Region quotas in this skill.

Use current account/Region values before production.

---

# 45. Load model

For production scale, identify or mark UNKNOWN:

```text
peak HTTP RPS
concurrent synchronous requests
average/p95/p99 request duration
workflow messages per request
DynamoDB reads/writes per request
poll reads per request
Lambda concurrency
payload/result sizes
provider QPS/concurrency quota
```

If these are unknown, large-scale readiness is UNKNOWN.

Managed services do not remove the need for capacity modeling.

---

# 46. Polling load

Estimate:

```text
concurrent HTTP waiters
* polls per second
= GetItem operations per second
```

Review:

- strong consistency
- item size
- backoff
- jitter
- burst synchronization
- billing mode

Require load tests before claiming large-scale readiness.

---

# 47. Retry multiplication

Identify retries at every layer:

```text
client
Axios/HTTP SDK
application
AWS SDK
SQS/Lambda
provider SDK
DLQ redrive
```

Avoid accidental multiplicative attempts.

Infrastructure must support stable idempotency despite retries.

---

# 48. Failure scenarios

Trace at least:

```text
one ECS task dies
one AZ is impaired
deployment starts during open requests
Lambda is throttled
SQS backlog grows
external provider is unavailable
DynamoDB throttles
NAT/egress path fails
client retries after response loss
```

For each ask:

```text
Is work lost?
Can it duplicate?
Can it recover?
Will operators detect it?
```

---

# 49. ECS crash invariant

Expected behavior:

```text
Client -> ALB -> ECS Task A
                    |
                    X
```

The original HTTP connection may fail.

But:

- workflow state survives
- SQS processing survives
- another task can read durable state
- client retry with same idempotency key is safe

Do not treat preserving a dead TCP connection as a requirement.

Treat durable business recovery as the requirement.

---

# 50. Deployment/open-request invariant

During deployment:

```text
old task has open requests
new task starts
new task becomes healthy
old task drains
```

Review:

- ALB deregistration delay
- readiness behavior
- SIGTERM
- stopTimeout
- client retry
- durable workflow state

A normal deployment should not corrupt workflow state even if an HTTP request is
interrupted.

---

# 51. Cost review

Flag obvious risks:

- unnecessary NAT data cost
- excessive cross-AZ traffic
- unbounded log retention
- overly frequent DynamoDB polling
- overprovisioned ECS baseline
- unnecessary custom KMS keys
- unnecessary WAF managed groups
- unused GSIs

Do not reduce correctness or availability solely to cut cost.

---

# 52. Current AWS baseline references

Verified from official documentation on 2026-08-20.

```text
Claude Code Skills
https://code.claude.com/docs/en/slash-commands

Lambda + SQS configuration
https://docs.aws.amazon.com/lambda/latest/dg/services-sqs-configure.html

Lambda + SQS at-least-once behavior
https://docs.aws.amazon.com/lambda/latest/dg/with-sqs.html

Lambda + SQS partial batch responses
https://docs.aws.amazon.com/lambda/latest/dg/services-sqs-errorhandling.html

Lambda SQS parameters
https://docs.aws.amazon.com/lambda/latest/dg/services-sqs-parameters.html

ALB idle timeout
https://docs.aws.amazon.com/elasticloadbalancing/latest/application/edit-load-balancer-attributes.html

ALB deregistration delay
https://docs.aws.amazon.com/elasticloadbalancing/latest/application/edit-target-group-attributes.html

ALB health checks
https://docs.aws.amazon.com/elasticloadbalancing/latest/application/target-group-health-checks.html

ECS service parameters
https://docs.aws.amazon.com/AmazonECS/latest/developerguide/service_definition_parameters.html

ECS deployment circuit breaker
https://docs.aws.amazon.com/AmazonECS/latest/developerguide/deployment-circuit-breaker.html

ECS task scale-in protection
https://docs.aws.amazon.com/AmazonECS/latest/developerguide/task-scale-in-protection.html

ECS stopTimeout
https://docs.aws.amazon.com/AmazonECS/latest/APIReference/API_ContainerDefinition.html

ECS IAM roles
https://docs.aws.amazon.com/AmazonECS/latest/developerguide/ecs-iam-role-overview.html

DynamoDB PITR
https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/Point-in-time-recovery.html

DynamoDB deletion protection
https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/WorkingWithTables.Basics.html

AWS WAF rate-based rules
https://docs.aws.amazon.com/waf/latest/developerguide/waf-rule-statement-type-rate-based.html
```

If current official AWS docs later conflict with a numeric baseline in this
skill, current AWS docs win.

---

# 53. Required commands

Inspect `package.json`.

When available and relevant:

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm test:integration
pnpm test:e2e
pnpm cdk:synth
pnpm cdk:diff
```

Report:

```text
NOT_AVAILABLE
```

when missing.

Report:

```text
NOT_APPLICABLE
```

when unrelated.

Do not invent commands.
Do not deploy.

---

# 54. Blocking conditions

Return `BLOCKED` if required production decisions are missing, including:

- environment cannot be determined
- B2B authentication is undefined
- synchronous maximum request duration is undefined
- destructive state change has no migration plan
- peak load is unknown while claiming large-scale readiness
- provider quota is unknown while concurrency depends on it
- multi-region active-active is requested without conflict semantics
- critical resource configuration is manual/unverifiable
- requested infrastructure violates project invariants

Do not guess production values.

---

# 55. Anti-patterns

Flag:

```text
assignPublicIp = true
```

for ALB-fronted ECS without justification.

Flag:

```text
0.0.0.0/0 -> ECS app port
```

instead of ALB SG -> ECS SG.

Flag production:

```text
desiredCount = 1
```

without accepted availability risk.

Flag timeout collision:

```text
business = 30s
server = 30s
ALB = 30s
client = 30s
```

Flag no `SIGTERM` handling for long requests.

Flag broad IAM.

Flag application permissions on the ECS execution role.

Flag mutable-only production image `latest`.

Flag critical SQS queue without DLQ.

Flag handler using `batchItemFailures` without event-source
`ReportBatchItemFailures`.

Flag unsafe visibility timeout.

Flag production authoritative DynamoDB table with destructive removal behavior.

Flag critical DLQ without alarm.

Flag secrets in source or outputs.

Flag critical production settings that exist only in the console.

---

# 56. Output format

Return exactly:

```text
AWS REVIEW: PASS | PASS_WITH_WARNINGS | FAIL | BLOCKED

Environment:
dev | staging | production | UNKNOWN

Scope:
<exact scope>

Architecture summary:
<short summary>

CDK:
- synth: PASS/FAIL/NOT_AVAILABLE/NOT_APPLICABLE
- diff: PASS/FAIL/NOT_AVAILABLE/NOT_APPLICABLE
- destructive replacements: NONE/<list>
- IAM widening: NONE/<list>

Networking:
- multi-AZ: PASS/FAIL/UNKNOWN
- ALB placement: PASS/FAIL/UNKNOWN
- ECS private networking: PASS/FAIL/UNKNOWN
- public ECS exposure: PASS/FAIL
- NAT/endpoint egress: PASS/FAIL/UNKNOWN
- security groups: PASS/FAIL
- TLS: PASS/FAIL/NOT_APPLICABLE
- WAF: PASS/FAIL/NOT_APPLICABLE/DECISION_REQUIRED

ALB:
- idle timeout:
- deregistration delay:
- health check path:
- health check grace:
- timeout ordering: PASS/FAIL/UNKNOWN
- drain compatibility: PASS/FAIL/UNKNOWN

ECS/Fargate:
- desired count:
- min autoscaling capacity:
- max autoscaling capacity:
- minimumHealthyPercent:
- maximumPercent:
- deployment circuit breaker:
- rollback:
- stopTimeout:
- SIGTERM handling: PASS/FAIL/UNKNOWN
- readiness drain behavior: PASS/FAIL/UNKNOWN
- task scale-in protection: ENABLED/DISABLED/NOT_APPLICABLE
- multi-AZ capacity: PASS/FAIL/UNKNOWN
- scaling metric quality: PASS/FAIL/UNKNOWN

SQS/Lambda:
- queues reviewed:
- DLQs: PASS/FAIL
- DLQ alarms: PASS/FAIL
- maxReceiveCount: PASS/FAIL/UNKNOWN
- partial batch responses: PASS/FAIL/NOT_APPLICABLE
- visibility timeout relationship: PASS/FAIL
- batch sizing: PASS/FAIL
- concurrency/backpressure: PASS/FAIL/UNKNOWN
- FIFO semantics: PASS/FAIL/NOT_APPLICABLE
- duplicate-delivery safety: PASS/FAIL/UNKNOWN

DynamoDB:
- authoritative tables:
- PITR: PASS/FAIL/UNKNOWN
- deletion protection: PASS/FAIL/UNKNOWN
- removal policy: PASS/FAIL/UNKNOWN
- encryption: PASS/FAIL/UNKNOWN
- TTL semantics: PASS/FAIL/NOT_APPLICABLE
- Streams: PASS/FAIL/NOT_APPLICABLE
- capacity mode:
- hot-partition risk: PASS/FAIL/UNKNOWN
- polling scale risk: PASS/FAIL/UNKNOWN

IAM:
- ECS task role: PASS/FAIL/UNKNOWN
- ECS execution role: PASS/FAIL/UNKNOWN
- Lambda roles: PASS/FAIL/UNKNOWN
- least privilege: PASS/FAIL/UNKNOWN
- wildcard findings: NONE/<list>

Security:
- secret storage: PASS/FAIL/UNKNOWN
- public data exposure: PASS/FAIL
- authentication architecture: PASS/FAIL/UNKNOWN
- tenant isolation risk: PASS/FAIL/UNKNOWN

Observability:
- HTTP alarms: PASS/FAIL
- ECS alarms: PASS/FAIL
- SQS age alarms: PASS/FAIL
- DLQ alarms: PASS/FAIL
- Lambda alarms: PASS/FAIL
- DynamoDB alarms: PASS/FAIL
- deployment failure visibility: PASS/FAIL
- structured correlation: PASS/FAIL/UNKNOWN

Scale:
- expected peak RPS:
- expected concurrent HTTP waits:
- expected poll reads/sec:
- expected Lambda concurrency:
- provider concurrency limit:
- quota audit: PASS/FAIL/MISSING
- load-test evidence: PRESENT/MISSING

CRITICAL:
- ...

HIGH:
- ...

MEDIUM:
- ...

LOW:
- ...

Required failure tests found:
- ...

Missing failure tests:
- ...

Unproven assumptions:
- ...

Blocking remediations:
1. ...
2. ...

Recommended improvements:
1. ...
2. ...

Final:
PASS | PASS_WITH_WARNINGS | FAIL | BLOCKED
```

If a severity has no findings:

```text
CRITICAL:
None.
```

Do not invent values.
Use `UNKNOWN` when configuration cannot be verified.

---

# 57. Acceptance criteria

Return PASS only when:

- zero CRITICAL findings
- zero HIGH findings
- relevant checks/tests pass
- CDK synth succeeds when infrastructure changed
- no unexplained destructive production diff exists
- production API is redundantly deployed
- timeout/draining configuration is deliberate
- workflow correctness survives ECS task loss
- deployment failure/rollback handling is adequate
- SQS/Lambda visibility configuration is safe
- critical queues have DLQ/redrive/alarms
- partial batch configuration matches handler behavior
- concurrency protects downstream dependencies
- production DynamoDB state is protected appropriately
- secrets are handled safely
- IAM is reasonably least privilege
- public exposure is intentional
- critical alarms exist
- scale claims have evidence or explicit assumptions
- application guarantees are not incorrectly delegated to AWS

Return PASS_WITH_WARNINGS only for MEDIUM/LOW findings.

Return FAIL for any CRITICAL/HIGH finding.

Return BLOCKED when essential production architecture/security/scale decisions
are absent and cannot safely be inferred.

---

# 58. Final question

Before PASS, answer internally:

```text
If one ECS task dies, one worker is retried, one AZ is impaired, a deployment
starts, and a client retries after losing the HTTP response, does the AWS
configuration still allow application invariants to hold without:

- losing durable workflow state,
- duplicating an unsafe side effect,
- returning the wrong result,
- deleting authoritative data,
- exposing private resources,
- or hiding a permanent failure?
```

If no or unknown:

do not return PASS.
