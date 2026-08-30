# CLAUDE.md

# Project: Reliable Sync-over-Async Workflow Service

## 1. Mission

Build a production-grade service that exposes a synchronous HTTP API while the underlying business process is executed asynchronously through AWS messaging infrastructure.

The external caller sends a normal HTTP request such as:

```ts
await axios.post("/v1/process", payload);
```

Internally, the request may pass through multiple SQS queues and workers.

If the workflow reaches a terminal state before the synchronous HTTP deadline, the API returns the final result on the same HTTP request.

If the synchronous waiting deadline expires, the HTTP request may fail or return a timeout response, but the underlying business workflow MUST remain recoverable and MUST NOT be assumed to have failed.

The system must prioritize:

1. correctness
2. idempotency
3. recoverability
4. observability
5. scalability
6. operational simplicity

Correctness is more important than minimizing latency.

---

# 2. Core Architecture

Target architecture:

```text
Client
  |
  | HTTP POST
  v
Application Load Balancer
  |
  v
ECS / Fargate API
  |
  | create/recover request
  |
  +----> DynamoDB
  |      authoritative workflow state
  |
  +----> SQS
             |
             v
          Worker A
             |
            SQS
             |
             v
          Worker B
             |
            ...
             |
             v
         Final Worker
             |
             v
         DynamoDB
         COMPLETED / FAILED
             ^
             |
      bounded polling
      from ECS API
             |
             v
        HTTP response
```

DynamoDB is the authoritative source of workflow state.

SQS is transport.

Workers perform processing.

ECS owns the synchronous HTTP connection.

Polling is a synchronization mechanism only.

---

# 3. Non-Negotiable System Invariants

These rules MUST NOT be violated without an explicit architecture decision.

## 3.1 Request Identity

Every logical business operation has exactly one immutable:

```text
requestId
```

Every externally retriable operation also has an:

```text
idempotencyKey
```

These are not interchangeable.

`requestId` identifies the internal workflow execution.

`idempotencyKey` identifies the logical caller operation across HTTP retries.

The same logical operation retried by the client MUST NOT create duplicate workflows.

---

## 3.2 Correlation

`requestId` MUST propagate through:

- HTTP processing
- DynamoDB records
- every SQS message
- worker logs
- external API correlation where possible
- metrics and traces
- final workflow result

Never correlate workflow state using:

- customer ID
- Lambda invocation ID
- ECS task ID
- timestamp
- HTTP connection
- in-memory object identity

---

## 3.3 Source of Truth

DynamoDB is the only authoritative source of workflow state.

The following MUST NOT be treated as authoritative state:

- in-memory variables
- Promise state
- SQS message existence
- Lambda invocation state
- ECS process state
- HTTP connection state

Loss of an ECS process MUST NOT cause loss of business state.

Loss or timeout of an HTTP connection MUST NOT imply failure of the business operation.

---

# 4. Workflow State Machine

Initial workflow states:

```text
PROCESSING
COMPLETED
FAILED
```

Allowed transitions:

```text
PROCESSING -> COMPLETED
PROCESSING -> FAILED
```

Terminal states:

```text
COMPLETED
FAILED
```

Terminal states MUST NOT transition to another state.

Examples of forbidden transitions:

```text
COMPLETED -> FAILED
COMPLETED -> PROCESSING
FAILED    -> COMPLETED
FAILED    -> PROCESSING
```

State transitions MUST use DynamoDB conditional writes.

Never blindly overwrite workflow status.

Example conceptual rule:

```text
Update PROCESSING -> COMPLETED
only if current status == PROCESSING
```

---

# 5. HTTP Lifecycle vs Business Lifecycle

These are separate concepts.

An HTTP timeout does NOT mean the workflow failed.

Example:

```text
0s     request accepted
20s    HTTP synchronous deadline reached
22s    workflow completes successfully
```

The business result is:

```text
COMPLETED
```

even if the original HTTP caller received a timeout.

Never automatically transition a workflow to `FAILED` because:

- Axios disconnected
- ALB disconnected
- ECS timed out waiting
- the synchronous response deadline expired

Cancellation requires a separately designed cancellation mechanism.

---

# 6. Deadlines and Timeouts

Use one absolute business deadline where possible:

```text
deadlineAt
```

Do not independently invent conflicting deadlines across components.

Timeout layers should have deliberate margins.

Conceptual ordering:

```text
workflow synchronous deadline
<
ECS request deadline
<
ALB connection timeout
<
recommended client timeout
```

Do NOT configure every layer to expire at exactly the same time.

Example:

```text
workflow synchronous wait: 20s
ECS response budget:       22s
ALB idle timeout:          30s
client timeout:            35s
```

Exact values belong in environment/configuration and may change after load testing.

Do not hardcode timeout constants inside business logic.

---

# 7. DynamoDB Polling

The synchronous API waits for workflow completion by reading workflow state from DynamoDB.

Polling MUST be:

- bounded
- cancellable
- deadline-aware
- backoff-based
- jittered

Do not use a fixed high-frequency busy loop.

Do not poll forever.

Preferred conceptual behavior:

```text
initial delay: short
then exponential or progressive backoff
maximum polling interval: bounded
random jitter: enabled
```

For the authoritative request item, use a strongly consistent read when correctness of immediate terminal-state visibility requires it.

Polling implementation must be encapsulated behind an interface.

Example:

```ts
interface WorkflowWaiter {
  waitForTerminalState(requestId: string, deadlineAt: number): Promise<WorkflowResult>;
}
```

HTTP handlers MUST NOT implement polling mechanics directly.

---

# 8. SQS Delivery Semantics

All SQS consumers MUST assume at-least-once delivery.

Duplicate delivery is normal.

Consumers MUST tolerate:

- duplicate messages
- delayed messages
- retries
- worker crashes
- visibility timeout expiry
- reprocessing
- partial batch failures
- out-of-order delivery when Standard SQS is used

Never assume a message will be processed exactly once.

---

# 9. Message Contract

Every internal message MUST contain sufficient metadata for correlation and safe processing.

Minimum conceptual fields:

```ts
interface WorkflowMessage<T> {
  messageId: string;
  requestId: string;
  workflowVersion: number;
  step: string;
  createdAt: number;
  payload: T;
}
```

Do not use implicit queue position as workflow state.

Do not infer the current workflow step only from which queue received the message if explicit step information improves safety and observability.

---

# 10. Idempotency

Idempotency is mandatory.

Every externally initiated operation MUST support safe client retries.

The API MUST recognize repeated requests using the same idempotency key.

A retry of the same logical request MUST:

- return the existing workflow if it exists
- not create an additional business operation
- return the previous terminal result if already completed

If the same idempotency key is reused with materially different input, the API SHOULD reject it.

Do not silently treat different payloads as the same request.

---

# 11. Worker Idempotency

Every worker MUST be safe under duplicate SQS delivery.

Before implementing a worker side effect, determine whether the operation is:

1. naturally idempotent
2. protected by an idempotency key
3. safely reconcilable
4. unsafe

Category 4 operations MUST NOT be considered production-ready.

For non-idempotent internal work, maintain durable deduplication or step state.

Conceptually:

```text
requestId + stepId
```

should uniquely identify a business step where appropriate.

---

# 12. External API Calls

External side effects are high-risk operations.

Before integrating any external API, document:

- whether it supports idempotency keys
- whether an operation can be queried by our reference ID
- whether retries are safe
- which errors are retryable
- what timeout means
- how reconciliation works
- how duplicate side effects are prevented

Every external side effect must be classified as:

```text
IDEMPOTENT
IDEMPOTENCY_PROTECTED
RECONCILABLE
UNSAFE
```

`UNSAFE` integrations MUST NOT be merged into the production workflow without explicit review.

---

# 13. External Success Followed by Local Crash

Always account for this failure:

```text
external API performs operation
        |
        v
external API returns success
        |
        v
our service crashes before durable local state is saved
```

A retry MUST NOT blindly repeat the side effect.

Preferred recovery order:

1. retry using the same external idempotency key
2. query the external system using our unique operation reference
3. run reconciliation
4. if none is possible, mark the integration as unsafe

Never pretend this ambiguity does not exist.

---

# 14. Database + Message Dual Writes

Avoid unsafe sequences such as:

```text
update DynamoDB
then
send SQS
```

when losing the second operation would leave the workflow stuck.

Where correctness requires both durable state change and future message publication, use a transactional outbox or equivalent durable pattern.

Conceptual flow:

```text
DynamoDB transaction
  |
  +-- update workflow/step
  |
  +-- create OUTBOX event

OUTBOX
  |
  v
publisher
  |
  v
SQS
```

Outbox publishing MUST itself tolerate duplicate processing.

---

# 15. Lambda + SQS

Lambda workers consuming SQS MUST:

- be idempotent
- use DLQs
- configure a redrive policy
- configure appropriate visibility timeout
- use partial batch failure reporting
- classify retryable vs non-retryable failures
- emit structured logs

Use:

```text
ReportBatchItemFailures
```

where applicable.

A failed record in a batch should not unnecessarily cause successful records to repeat.

---

# 16. DLQs

Every production processing queue MUST have a DLQ unless an explicit architecture decision documents otherwise.

A DLQ MUST have:

- CloudWatch alarm
- operational ownership
- runbook
- redrive/recovery strategy

A DLQ without monitoring is not an acceptable failure mechanism.

Never silently delete poison messages.

---

# 17. Large Payloads

Do not use SQS as large-object storage.

Large payloads should be stored in S3 or another durable object store.

Messages should carry references:

```ts
{
  (requestId, payloadRef);
}
```

instead of embedding very large data where practical.

---

# 18. Error Classification

Do not reduce every error to `FAILED`.

Use explicit internal classification:

```text
RETRYABLE
NON_RETRYABLE
UNKNOWN_EXTERNAL_STATE
```

Examples:

### RETRYABLE

- temporary network failure
- rate limiting
- temporary dependency outage
- transient AWS SDK error

### NON_RETRYABLE

- invalid business input
- unsupported operation
- authentication failure that cannot recover automatically

### UNKNOWN_EXTERNAL_STATE

- external request timed out after transmission
- connection dropped after request was accepted
- process crashed after remote success may have occurred

`UNKNOWN_EXTERNAL_STATE` requires reconciliation.

Do not automatically retry a potentially non-idempotent side effect.

---

# 19. ECS API Service

The HTTP API runs on ECS/Fargate behind an Application Load Balancer.

The API service MUST:

- be stateless from a business-state perspective
- tolerate process restart
- expose health endpoints
- gracefully handle SIGTERM
- stop accepting new requests while draining
- allow in-flight requests to finish where possible

Required health endpoints:

```text
GET /health/live
GET /health/ready
```

`ready` MUST return unhealthy while the process is draining.

---

# 20. HTTP API

Initial endpoints:

```text
POST /v1/process
GET  /v1/process/:requestId
GET  /health/live
GET  /health/ready
```

`POST /v1/process`:

1. authenticate caller
2. validate request
3. validate/read idempotency key
4. create or recover workflow
5. publish initial work safely
6. wait for terminal state until synchronous deadline
7. return result if terminal
8. otherwise return controlled timeout/processing response

`GET /v1/process/:requestId`:

- must require authorization
- must validate tenant ownership
- returns durable workflow state
- acts as a recovery path after connection failure or timeout

---

# 21. Multi-Tenant Security

Never trust tenant identity from arbitrary request payload fields.

Tenant/customer identity must come from authenticated context.

Workflow records must contain tenant ownership.

A caller MUST NOT gain access to a workflow solely by knowing its `requestId`.

Authorization checks should conceptually use:

```text
authenticatedTenantId + requestId
```

---

# 22. Authentication

Do not invent authentication mechanisms.

The chosen production B2B authentication strategy must be explicitly documented.

Possible approved mechanisms may include:

- OAuth2/JWT
- mTLS
- IAM/SigV4

Do not implement a placeholder authentication method and treat it as production security.

---

# 23. AWS Infrastructure

Infrastructure MUST be managed using AWS CDK v2 in TypeScript.

Do not rely on manually configured production resources.

Target AWS services:

- VPC
- Application Load Balancer
- ECS / Fargate
- ECR
- SQS
- Lambda
- DynamoDB
- S3 where needed
- CloudWatch
- IAM
- Secrets Manager / SSM where appropriate
- WAF where required
- ACM
- Route 53 where required

Use least-privilege IAM.

Never place static AWS access keys inside:

- source code
- Docker images
- environment files committed to git

---

# 24. Environment Separation

Support separate environments:

```text
local
dev
staging
production
```

Production and staging must not share mutable infrastructure.

Environment-specific configuration belongs in configuration, not duplicated business logic.

Never deploy experimental changes directly to production.

---

# 25. Infrastructure Structure

Infrastructure should be separated by responsibility.

Preferred structure:

```text
infrastructure/cdk/
  network/
  data/
  messaging/
  workers/
  api/
  monitoring/
```

Avoid giant infrastructure files with unrelated resources.

---

# 26. Observability

Structured logging is mandatory.

Logs should include when available:

```text
requestId
messageId
step
workflowVersion
tenantId
attempt
status
durationMs
errorCode
```

Do not rely on unstructured `console.log("failed")`.

Never log:

- secrets
- authentication tokens
- private credentials
- raw sensitive customer data unless explicitly approved

---

# 27. Metrics

The system must eventually expose or monitor:

```text
HTTP request count
HTTP errors
HTTP timeout count
HTTP p50 latency
HTTP p95 latency
HTTP p99 latency

workflow started
workflow completed
workflow failed
workflow sync-timeout count

SQS queue depth
SQS oldest message age
DLQ message count

Lambda errors
Lambda throttles
Lambda duration

ECS task count
ECS CPU
ECS memory

DynamoDB throttling
```

Add metrics when implementing the relevant component.

---

# 28. Alerting

Critical production conditions MUST have alarms.

At minimum:

- DLQ contains messages
- excessive HTTP 5xx
- queue age exceeds expected SLA
- Lambda throttling
- DynamoDB throttling
- insufficient healthy ECS targets
- abnormal workflow failure rate

Do not build failure mechanisms without operational visibility.

---

# 29. Testing Philosophy

Reliability features are incomplete without failure-path tests.

Tests must cover both success and failure.

Required test categories:

```text
unit
integration
end-to-end
failure-path
load
chaos
```

Do not optimize for high test coverage percentages alone.

Test invariants.

---

# 30. Required Failure Scenarios

The system must eventually prove correct behavior for:

```text
duplicate HTTP request
duplicate SQS delivery
worker crash before processing
worker crash after processing
worker crash before publishing next event
external API timeout
external API success followed by local crash
DynamoDB conditional write conflict
poison message
DLQ delivery
client disconnect
HTTP synchronous timeout
completion exactly at timeout boundary
ECS task termination
deployment while requests are active
out-of-order message delivery where applicable
```

When adding functionality, add the relevant failure-path test.

---

# 31. Code Quality

Use TypeScript strict mode.

Avoid:

```ts
any;
```

unless unavoidable and justified.

Prefer:

- explicit interfaces
- narrow types
- discriminated unions
- schema validation at boundaries
- dependency injection for infrastructure dependencies
- small testable modules

External input MUST be validated.

Do not trust:

- HTTP JSON
- SQS message JSON
- environment variables
- external API responses

without validation.

---

# 32. Package Boundaries

Preferred repository structure:

```text
apps/
  api/
  worker-a/
  worker-b/
  finalizer/

packages/
  contracts/
  persistence/
  messaging/
  idempotency/
  observability/
  testing/

infrastructure/
  cdk/

docs/
  adr/
  phases/

tests/
  integration/
  e2e/
  load/
  chaos/
```

Shared business contracts belong in packages rather than being duplicated across applications.

Avoid circular package dependencies.

---

# 33. Configuration

All configuration must be explicit and validated at startup.

Examples:

```text
AWS_REGION
WORKFLOW_TABLE_NAME
START_QUEUE_URL
SYNC_WAIT_TIMEOUT_MS
POLL_INITIAL_DELAY_MS
POLL_MAX_DELAY_MS
```

Missing required production configuration should cause startup failure.

Do not silently fall back to unsafe production defaults.

---

# 34. Graceful Shutdown

When ECS sends SIGTERM:

1. mark service as not ready
2. stop accepting new HTTP requests
3. stop creating new workflow waits
4. allow existing requests to finish within the drain budget
5. close resources
6. exit

Do not immediately terminate active connections unless forced.

Business workflow correctness must not depend on successful graceful shutdown.

---

# 35. Security Rules

Never:

- commit secrets
- log credentials
- expose internal queue URLs to external clients
- trust internal routing fields from HTTP payloads
- allow arbitrary DynamoDB keys from caller input
- allow caller-controlled workflow status
- allow caller-controlled internal S3 bucket/key without validation
- grant wildcard IAM permissions without justification

Use least privilege.

---

# 36. Performance Rules

Do not prematurely optimize correctness away.

Before changing synchronization or reliability logic for performance reasons:

1. measure
2. document bottleneck
3. preserve invariants
4. add load tests
5. compare before and after

DynamoDB polling intervals must be configurable.

Use jitter to reduce synchronized polling spikes.

Large-scale decisions must be based on load-test data rather than assumptions.

---

# 37. Architectural Changes

Do not change these without an ADR:

- DynamoDB as source of truth
- synchronous façade semantics
- HTTP timeout != business failure
- SQS at-least-once assumption
- mandatory idempotency
- conditional state transitions
- external side-effect reconciliation requirement

If a requested implementation conflicts with an invariant:

STOP.

Explain the conflict.

Propose an architecture change.

Do not silently weaken correctness to complete a task.

---

# 38. ADRs

Major decisions belong in:

```text
docs/adr/
```

Use an ADR for decisions such as:

- Standard vs FIFO SQS
- Step Functions vs SQS orchestration
- authentication method
- polling strategy changes
- persistence model changes
- timeout semantics
- multi-region architecture
- external provider integration strategy

---

# 39. Phase-Based Development

Implementation is performed in phases.

Claude MUST read the relevant phase document under:

```text
docs/phases/
```

before starting implementation.

Do not begin future phases unless explicitly requested.

If asked to implement Phase N:

1. read this file
2. read `docs/invariants.md`
3. read the Phase N document
4. inspect existing implementation
5. implement Phase N only
6. run acceptance tests
7. report unresolved issues

Do not opportunistically implement later phases.

---

# 40. Development Workflow

For every implementation task:

1. inspect relevant existing code
2. inspect relevant architecture documentation
3. identify invariants affected
4. write or update tests
5. implement the smallest correct change
6. run formatting
7. run lint
8. run typecheck
9. run unit tests
10. run relevant integration tests
11. inspect the diff
12. report unresolved risks

Never hide failing tests.

Never weaken tests just to make the suite green.

Never remove reliability behavior solely because it complicates implementation.

---

# 41. Before Marking a Task Complete

Claude must report:

```text
Files changed
Tests added
Tests executed
Test results
Architecture decisions
Reliability implications
Known limitations
Unresolved risks
Next recommended step
```

A task is not complete simply because the application compiles.

---

# 42. Production Definition of Done

A feature affecting workflow behavior is production-ready only when:

- business behavior is implemented
- idempotency is defined
- retry behavior is defined
- timeout behavior is defined
- crash behavior is defined
- duplicate delivery is handled
- relevant state transitions are conditional
- logs exist
- metrics exist where required
- alerts exist where required
- unit tests pass
- integration tests pass
- relevant failure tests pass
- infrastructure is represented in CDK
- security implications have been reviewed
- documentation is updated

---

# 43. Commands

Expected project commands should converge toward:

```bash
pnpm install

pnpm lint
pnpm typecheck
pnpm test
pnpm test:integration
pnpm test:e2e
pnpm test:chaos
pnpm test:load

pnpm cdk:synth
pnpm cdk:diff
```

If commands differ from the actual repository, update this section.

Do not document commands that do not exist.

---

# 44. Guiding Principle

When choosing between:

```text
simple but potentially incorrect
```

and:

```text
slightly more complex but recoverably correct
```

choose recoverably correct.

The system must be designed under the assumption that:

```text
networks fail
processes crash
messages duplicate
clients retry
dependencies timeout
deployments interrupt processes
```

None of those events should silently corrupt business state.

The intended guarantee is not literal zero failure.

The intended guarantee is:

```text
no silent loss
no cross-request result mismatch
safe retry behavior
controlled duplicate handling
durable business state
deterministic recovery
observable failure
```
