---
name: sqs-worker
description: >
  Implement or review a production-grade AWS Lambda worker that consumes Amazon
  SQS. Use for workers, finalizers, queue consumers, SQS event source mappings,
  retry behavior, idempotency, DLQs, partial batch responses, FIFO ordering,
  visibility timeouts, concurrency/backpressure, external side effects, or
  worker observability.
argument-hint: "[implement|review] [worker-name-or-path]"
disable-model-invocation: true
context: fork
allowed-tools:
  - Read
  - Grep
  - Glob
---

# SQS Worker

Implement or review an SQS/Lambda worker for production use.

Invocation:

```text
/sqs-worker implement apps/payment-worker
```

or:

```text
/sqs-worker review apps/payment-worker
```

Arguments:

```text
$ARGUMENTS
```

The first argument should normally be:

```text
implement
```

or:

```text
review
```

The remaining argument identifies the worker, path, queue, or scope.

If mode is `review`, do not modify source code, tests, or infrastructure.

If mode is `implement`, make the smallest correct change required by the
requested scope. Do not redesign unrelated architecture.

If the mode or target cannot be determined safely, stop and report what is
missing instead of guessing.

---

# 1. Mission

Every SQS worker must remain correct under:

- duplicate delivery
- retries
- process crashes
- Lambda timeouts
- partial batch failure
- delayed delivery
- throttling
- poison messages
- out-of-order messages where ordering is not guaranteed
- external API ambiguity
- downstream outages
- deployment changes
- concurrent processing

Never assume:

```text
one SQS message = one worker execution
```

The application guarantee is:

```text
retries and duplicate processing do not corrupt business state
```

not:

```text
the infrastructure will execute the message exactly once
```

---

# 2. Required project context

Before changing or reviewing a worker, read when present:

1. `CLAUDE.md`
2. `docs/invariants.md`
3. `docs/architecture.md`
4. `docs/state-machine.md`
5. relevant ADRs under `docs/adr/`
6. relevant phase document under `docs/phases/`
7. worker source
8. shared message contracts
9. persistence/idempotency code
10. CDK definition for the queue, DLQ, Lambda, and event source mapping
11. relevant unit/integration/failure-path tests

Project invariants override implementation convenience.

If implementation conflicts with an invariant, stop or fix the implementation.
Do not weaken the invariant silently.

---

# 3. Identify the complete worker boundary

Before implementation or review, identify:

```text
source queue
queue type: STANDARD | FIFO
DLQ
Lambda function
event source mapping
message schema
business step
durable state touched
next queue/event produced
external APIs called
S3/DynamoDB dependencies
timeout
batch size
batch window
visibility timeout
maximum concurrency
reserved concurrency
```

Report unknown values.

Do not review only the handler file while ignoring its event source mapping.

---

# 4. AWS guarantee vs application guarantee

Always distinguish the two.

## SQS / Lambda

AWS may retry message processing.

Application requirement:

```text
worker processing must be idempotent
```

## Partial batch responses

AWS can return only failed records to the queue when
`ReportBatchItemFailures` is configured.

Application requirement:

```text
handler must identify failed records correctly
```

## FIFO

AWS preserves ordering inside a message group.

Application requirement:

```text
business logic must preserve ordering semantics and remain safe under retry
```

## DLQ

AWS can move repeatedly failing messages to a DLQ.

Application requirement:

```text
the DLQ must be monitored, owned, and recoverable
```

Never claim application-level exactly-once behavior solely because an AWS
service provides deduplication, ordering, retries, or transactions.

---

# 5. Message validation

Treat the SQS message body as untrusted input.

Every worker must validate:

- JSON parsing
- schema
- required fields
- supported message version
- supported workflow step
- request identity
- message identity
- payload reference shape where applicable

Preferred conceptual contract:

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

Use the repository's approved schema-validation library.

Do not rely on TypeScript types to validate runtime JSON.

Malformed messages must not be silently acknowledged.

---

# 6. Required correlation fields

Every message should have durable business correlation.

At minimum verify availability of:

```text
requestId
messageId
workflowVersion
step
```

Where a worker performs a unique business step, also identify a durable step
identity such as:

```text
requestId + stepId
```

Do not deduplicate using only:

- Lambda request ID
- receipt handle
- timestamp
- process memory
- current batch index

---

# 7. Idempotency classification

Before implementing the worker's business action, classify the action:

```text
NATURALLY_IDEMPOTENT
IDEMPOTENCY_PROTECTED
RECONCILABLE
UNSAFE
```

## NATURALLY_IDEMPOTENT

Repeating the operation produces the same durable result without an additional
business effect.

## IDEMPOTENCY_PROTECTED

A durable idempotency record or provider idempotency key prevents repeated
business effects.

## RECONCILABLE

After ambiguity, the external or internal system can be queried by an immutable
operation reference to determine whether the effect occurred.

## UNSAFE

Retry can create a duplicate effect and there is no deterministic way to know
whether the first attempt succeeded.

An `UNSAFE` side effect is a production blocker.

Do not implement blind automatic retry around an unsafe side effect.

---

# 8. Durable idempotency

Do not use only an in-memory set or map.

Bad:

```ts
const processed = new Set<string>();
```

That state disappears on Lambda restart.

Use the repository's approved durable idempotency mechanism.

A common logical key is:

```text
requestId + stepId
```

or another immutable business-operation identifier.

Idempotency must survive:

```text
Lambda restart
duplicate SQS delivery
batch retry
deployment
process crash
```

If AWS Lambda Powertools idempotency is already an approved dependency in the
project, prefer using it correctly rather than writing a second ad-hoc
implementation.

Do not introduce Powertools automatically if the repository has deliberately
standardized on another mechanism.

---

# 9. External side effects

For every external API call, determine:

- provider
- operation
- stable operation reference
- provider idempotency support
- retry rules
- timeout semantics
- reconciliation API
- maximum safe attempt count
- whether success can occur without receiving the response

Model:

```text
worker sends request
      |
      v
provider executes operation
      |
      v
provider sends 200
      |
      X
connection drops or Lambda crashes
```

The next attempt must not blindly repeat an irreversible effect.

Preferred strategies in order:

1. reuse the same provider idempotency key
2. query provider by immutable operation reference
3. execute a documented reconciliation flow
4. stop and classify the integration as unsafe

A transport timeout is not proof that the remote operation failed.

---

# 10. Failure classification

Classify worker failures as:

```text
RETRYABLE
NON_RETRYABLE
UNKNOWN_EXTERNAL_STATE
```

## RETRYABLE

Examples:

- temporary dependency outage
- throttling
- transient network failure when retry is safe
- retry-safe provider 5xx

## NON_RETRYABLE

Examples:

- unsupported message version
- invalid business input
- malformed payload
- permanent contract violation

A non-retryable poison message still requires an explicit failure path. Do not
silently acknowledge it unless the application deliberately writes it to an
approved quarantine/failure store first.

## UNKNOWN_EXTERNAL_STATE

Examples:

- provider may have processed the request but response was lost
- process crashed after a remote side effect may have completed

UNKNOWN_EXTERNAL_STATE requires reconciliation or stable provider idempotency.

Never treat it as ordinary retry for a non-idempotent side effect.

---

# 11. Partial batch response is mandatory by default

For Lambda event source mappings that consume SQS batches, configure:

```text
ReportBatchItemFailures
```

unless a documented ADR proves that whole-batch retry is intentionally
required.

The handler must return:

```ts
{
  batchItemFailures: [{ itemIdentifier: record.messageId }];
}
```

for failed records.

Do not throw the entire invocation after independently processing multiple
Standard SQS records unless whole-batch retry is deliberately required.

If the handler throws at the invocation level, Lambda treats the whole batch as
failed.

---

# 12. Standard queue partial-batch behavior

For independent messages from a Standard queue:

```text
A succeeds
B fails
C succeeds
```

expected result:

```text
A acknowledged
B returned in batchItemFailures
C acknowledged
```

Unit/integration tests must prove this behavior.

Do not return successful records as failed.

Do not swallow failed records and return an empty failure list.

---

# 13. FIFO partial-batch behavior

FIFO ordering requires different failure handling.

If processing a FIFO message group and one record fails:

```text
A succeeds
B fails
C not yet processed
D not yet processed
```

stop processing later dependent records for that ordered sequence and return
the failed and unprocessed records according to the project's FIFO processing
strategy.

Do not continue processing later dependent FIFO messages after an earlier
message failed if doing so can violate business order.

Review AWS FIFO semantics and the project's message-group strategy before
parallelizing FIFO processing.

---

# 14. Standard vs FIFO

Do not choose FIFO automatically because "reliability is important."

Use Standard SQS when:

- strict ordering is not a business invariant
- high throughput is preferred
- workers are idempotent
- workflow state controls correctness

Use FIFO only when ordering/deduplication semantics are genuinely required.

If FIFO is used, identify:

```text
MessageGroupId
MessageDeduplicationId strategy
group cardinality
ordering boundary
```

Low message-group cardinality can serialize the workload and limit concurrency.

Do not use one global `MessageGroupId` for a high-scale workload unless global
serialization is explicitly required.

---

# 15. FIFO does not replace business idempotency

Even with FIFO, worker execution may be retried when processing fails.

The application must remain idempotent.

Never approve:

```text
FIFO => no idempotency needed
```

That statement is incorrect for worker correctness.

---

# 16. Visibility timeout

Inspect the Lambda timeout and queue visibility timeout from infrastructure.

For Lambda + SQS, use the AWS-recommended minimum:

```text
visibilityTimeout >=
  (6 * lambdaTimeout) + maximumBatchingWindow
```

when a batching window is configured.

Example:

```text
Lambda timeout = 30s
batch window   = 5s

visibility timeout >= 185s
```

Do not merely check:

```text
visibilityTimeout > lambdaTimeout
```

The project should follow the larger retry margin unless an ADR documents a
different, validated design.

If the queue's visibility timeout is too short, report/block it.

---

# 17. Lambda timeout

The Lambda timeout must allow the function to process the entire selected batch
with sufficient safety margin.

If:

```text
perRecordWorstCase * batchSize
```

can exceed the function timeout, reduce batch size, change concurrency strategy,
or redesign processing.

Do not increase timeout indefinitely without considering:

- duplicate-execution window
- external API timeout
- queue SLA
- cost
- visibility timeout
- synchronous workflow deadline

---

# 18. Batch size

Read actual event-source configuration.

Current AWS constraints include:

```text
Standard SQS Lambda batch size: up to 10,000 records
FIFO SQS Lambda batch size: up to 10 records
```

For Standard SQS, a configured batch size greater than 10 requires a batching
window of at least 1 second.

The effective batch can also be limited by Lambda invocation payload size.

Do not maximize batch size by default.

Choose based on:

- average message size
- processing cost per item
- downstream capacity
- failure behavior
- latency SLA
- Lambda timeout
- memory
- partial-batch handling

Require load-test evidence for aggressive production batching.

---

# 19. Large messages

Do not assume configured batch size can always fit.

SQS/Lambda event metadata contributes to the Lambda invocation payload.

For large business data, prefer:

```text
SQS message
  |
  +-- requestId
  +-- metadata
  +-- S3 payload reference
```

over embedding a large object.

Validate message and result sizes before reaching hard AWS service limits.

---

# 20. DLQ

Every production business-processing queue should have a compatible DLQ unless
an explicit ADR documents another failure strategy.

Verify:

- source queue has a DLQ
- redrive policy is configured
- `maxReceiveCount` is deliberate
- DLQ retention is sufficient
- queue type is compatible
- DLQ has an alarm
- ownership/runbook exists

For Lambda + SQS, use:

```text
maxReceiveCount >= 5
```

as the default starting point unless measured behavior or an ADR justifies a
different value.

Do not set:

```text
maxReceiveCount = 1
```

for transiently recoverable workloads without a strong reason.

---

# 21. Poison messages

A poison message must eventually leave the hot retry loop.

Examples:

- invalid schema
- unsupported version
- permanently invalid business data
- deterministic processor bug for one payload

Required behavior:

```text
retry policy
   |
   v
DLQ / approved quarantine
   |
   v
alarm
   |
   v
operator or automated recovery
```

Never:

```ts
catch (error) {
  logger.error(error);
  return;
}
```

if returning successfully causes SQS to delete a business-critical message.

---

# 22. State transition safety

If the worker updates workflow state in DynamoDB, every critical transition
must enforce legal previous state.

Example:

```text
PROCESSING -> STEP_A_SUCCEEDED
```

must not be an unconditional overwrite.

Use the project repository/state abstraction and conditional writes.

Late or duplicate messages must not overwrite terminal state.

Do not let:

```text
COMPLETED
```

become:

```text
FAILED
```

because an old duplicated message failed later.

---

# 23. State + next-message dual write

Flag this pattern:

```ts
await markStepSucceeded();
await sendNextMessage();
```

when a crash after the state update can permanently strand the workflow.

Model:

```text
DynamoDB success
      |
      X process crash
      |
next SQS message never sent
```

When state advancement and future message publication form one logical
invariant, use the project's approved transactional outbox or equivalent
durable pattern.

Conceptual approach:

```text
TransactWriteItems
  |
  +-- update workflow/step
  |
  +-- create outbox event
```

then:

```text
DynamoDB Stream / outbox publisher
  |
  v
SQS
```

The outbox publisher and downstream worker must both tolerate duplicate
delivery.

---

# 24. Queue producer safety

When a worker publishes another SQS message, verify:

- destination is server-controlled
- message schema is validated before send
- requestId is preserved
- workflowVersion is preserved
- next step is explicit
- messageId/eventId is generated deterministically where required
- FIFO fields are set correctly when FIFO is used
- large data is externalized where needed
- publish failure has a durable recovery path

Do not take QueueUrl, MessageGroupId, or internal routing from untrusted external
input without strict validation.

---

# 25. Concurrency and backpressure

Inspect:

```text
event-source maximum concurrency
Lambda reserved concurrency
account concurrency assumptions
downstream capacity
DynamoDB capacity mode
provider rate limits
database connection limits
```

The fastest Lambda scaling is not necessarily the safest system behavior.

If the downstream API safely handles only:

```text
100 concurrent operations
```

do not allow the SQS event source to create uncontrolled concurrency far above
that number.

Use event-source maximum concurrency and/or the project's approved throttling
strategy to protect downstream systems.

---

# 26. Reserved concurrency alignment

If event-source maximum concurrency is configured, compare it with Lambda
reserved concurrency.

Do not configure:

```text
event source max concurrency > function reserved concurrency
```

without understanding the resulting throttling behavior.

If multiple SQS event-source mappings share one Lambda, consider the aggregate
maximum concurrency.

The total configured event-source demand should not unintentionally exceed the
function's reserved concurrency.

Report the actual values.

---

# 27. Provisioned poller mode

If SQS provisioned polling mode is enabled, verify that the team intentionally
chose it for throughput/latency requirements.

Do not configure event-source `MaximumConcurrency` at the same time as
provisioned poller mode. These mechanisms are mutually exclusive.

If provisioned mode is not required by measured workload, do not add it merely
for "production readiness."

Capacity choices must be justified by load tests or explicit SLA.

---

# 28. FIFO concurrency

For FIFO queues, useful concurrency is bounded by available message groups as
well as configured concurrency limits.

If:

```text
MessageGroupId = requestId
```

then different workflows can process concurrently while each workflow group
remains ordered.

If all messages use:

```text
MessageGroupId = "workflow"
```

the queue can become effectively serialized.

Always review group cardinality for big-scale systems.

---

# 29. Downstream rate limiting

When calling a provider with quotas, define:

- maximum safe concurrency
- request timeout
- retryable statuses
- rate-limit response behavior
- Retry-After handling where applicable
- exponential backoff
- jitter
- circuit-breaker strategy if the project uses one

Do not create synchronized fixed-delay retries across many Lambda invocations.

Prefer exponential backoff with jitter for application-controlled retries.

Remember that Lambda/SQS itself already retries failed messages; avoid stacking
unbounded nested retry loops inside one invocation.

---

# 30. Avoid retry multiplication

Bad architecture:

```text
Axios client retries 5 times
worker internally retries 5 times
SQS redrives 5 times
provider SDK retries 5 times
```

This can cause very large effective attempt counts.

For each layer, identify:

```text
retry owner
maximum attempts
maximum elapsed time
idempotency mechanism
```

The total retry budget must be deliberate.

Do not add another retry library without calculating interaction with SDK and
SQS retries.

---

# 31. AWS SDK retries

Inspect AWS SDK v3 client configuration if explicitly customized.

Do not disable safe AWS SDK retries casually.

Do not increase them aggressively without considering:

- Lambda timeout
- end-to-end workflow deadline
- queue retry behavior
- throttling feedback

Keep retry policy centrally configurable when possible.

---

# 32. Logging

Every worker should emit structured logs.

Useful fields include:

```text
requestId
messageId
step
workflowVersion
sqsMessageId
receiveCount
attempt/correlation data where available
durationMs
status
errorCode
errorClass
```

Do not log:

- secrets
- authorization tokens
- provider credentials
- raw sensitive payloads
- large payload bodies unnecessarily

Do not use SQS `ApproximateReceiveCount` as the sole business idempotency key.

It is diagnostic metadata, not a business identity.

---

# 33. Metrics

Require or plan metrics for:

```text
worker success
worker failure
worker duration
retryable errors
non-retryable errors
unknown external state
idempotency hit
duplicate detected
external API latency
external API errors
DLQ messages
queue oldest-message age
Lambda errors
Lambda throttles
```

At infrastructure level, queue age and DLQ visibility are particularly
important for detecting stuck workflows.

---

# 34. Tracing

Preserve correlation through every hop.

Where tracing is enabled:

- propagate approved trace/correlation information
- include requestId in logs
- include requestId in downstream messages
- do not depend on distributed-trace continuity as the only recovery mechanism

Business recovery must work even if tracing is unavailable.

---

# 35. Error logging and partial-batch behavior

For each failed record:

1. log the error with correlation
2. classify the error
3. perform any required durable failure/reconciliation action
4. return the record in `batchItemFailures` when it should be retried
5. do not fail successful sibling records unnecessarily

Do not both:

```text
mark a message permanently failed
```

and:

```text
keep retrying its irreversible side effect
```

without an explicit state model.

---

# 36. Lambda handler structure

Prefer separation such as:

```text
handler
  |
  +-- batch adapter
  |
  +-- parse/validate message
  |
  +-- process one record
        |
        +-- idempotency
        +-- business step
        +-- persistence
        +-- next-event/outbox
```

Business logic should be testable without constructing a full Lambda event.

Avoid one giant handler that mixes:

- event parsing
- AWS SDK setup
- business logic
- retries
- state transitions
- provider calls
- metrics
- publishing

into one function.

---

# 37. Dependency initialization

Create reusable AWS SDK clients outside the Lambda handler where appropriate so
warm invocations can reuse them.

Example conceptual structure:

```ts
const dynamodb = new DynamoDBClient(...);
const sqs = new SQSClient(...);

export const handler = async (...) => {
  ...
};
```

Do not store mutable per-message business state globally across invocations.

Warm-container reuse is an optimization, not a correctness mechanism.

---

# 38. Parallel processing

For Standard SQS batches, parallel record processing may improve throughput
only when:

- records are independent
- side effects tolerate concurrency
- downstream dependencies tolerate concurrency
- per-record failure is still reported correctly
- memory usage remains safe

Do not automatically use:

```ts
Promise.all(event.Records.map(...))
```

for a worker with shared ordering, rate-limit, or state dependencies.

For FIFO, preserve message-group ordering.

---

# 39. Time budget inside a Lambda invocation

A worker should not begin a long external operation when the Lambda has
insufficient remaining execution time to finish or safely persist/reconcile
the result.

Where long processing is possible, consider checking remaining execution time
before starting a risky side effect.

Do not create a new ambiguous external state because the Lambda was already
about to time out.

---

# 40. Business deadline

If the workflow carries an absolute:

```text
deadlineAt
```

the worker must understand the project's deadline semantics.

Do not assume an expired synchronous HTTP deadline means the business workflow
should stop.

Differentiate:

```text
synchronous response deadline
```

from:

```text
business processing deadline
```

If business processing is allowed to continue after the caller times out, the
worker must continue according to durable workflow state.

---

# 41. Cancellation

Do not infer cancellation from:

- missing HTTP connection
- expired polling waiter
- client timeout
- ECS restart

Only stop business work when an explicit durable cancellation state/protocol
exists and the worker verifies it.

If cancellation is not designed, do not invent it inside a worker.

---

# 42. Security

Verify least privilege for the worker role.

The worker should have only required permissions such as relevant subsets of:

```text
sqs receive/delete/get attributes
dynamodb read/write specific table/index
s3 object access specific bucket/prefix
kms decrypt/encrypt where needed
secretsmanager get specific secret
```

Do not grant:

```text
Action: "*"
Resource: "*"
```

without an explicit reviewed requirement.

If a queue uses KMS encryption, ensure the execution path has the necessary KMS
permissions.

---

# 43. Network configuration

Do not place Lambda in a VPC unless required by dependencies/security
architecture.

If it is in a VPC, verify the function can still reach all required AWS and
external services through the intended network path.

Review:

- NAT dependency/cost
- VPC endpoints
- security groups
- DNS
- provider connectivity

Do not create a hidden networking single point of failure.

---

# 44. Infrastructure must match code

Inspect CDK and verify the handler's assumptions are actually configured.

Examples:

Code assumes partial batch:

```text
ReportBatchItemFailures must exist in event source mapping
```

Code assumes FIFO:

```text
queue must actually be FIFO
```

Code assumes DLQ:

```text
redrive policy must actually exist
```

Code assumes 180-second visibility:

```text
CDK must actually configure it
```

Comments are not infrastructure.

---

# 45. Required tests

For every worker, require tests that apply to its behavior.

Minimum:

## Happy path

```text
valid message
-> business step succeeds
-> expected durable state/result
```

## Duplicate delivery

```text
same logical message processed twice
-> business side effect occurs once
-> durable state remains correct
```

## Validation failure

```text
invalid message
-> not silently acknowledged
-> expected retry/DLQ/quarantine path
```

## Partial batch

```text
A success
B failure
C success
-> correct batchItemFailures
```

## State conflict

```text
duplicate/late worker tries illegal transition
-> conditional failure handled safely
```

Add when relevant:

- provider timeout
- provider success followed by local crash
- next-message publish failure
- outbox duplicate
- FIFO first-failure behavior
- throttling
- Lambda near-timeout
- poison message
- stale workflow version
- business deadline expiration

---

# 46. Duplicate-delivery test quality

Do not accept a test that only calls:

```text
handler once
```

and asserts an idempotency record was created.

The test should execute the logical operation twice and verify the externally
relevant effect occurred once.

For example:

```text
process message M1
process message M1 again

assert provider.createOrder called once
assert workflow state is correct
```

Where provider idempotency is the mechanism, test reuse of the exact same
provider idempotency key.

---

# 47. Crash-window tests

For side-effecting workers, test meaningful crash boundaries.

Important scenario:

```text
remote side effect succeeds
      |
      X
local process crashes before normal completion path
```

Then retry.

Expected:

```text
no duplicate business effect
```

For state + outbox:

```text
transaction succeeds
publisher runs twice
```

Expected:

```text
downstream business processing remains correct
```

---

# 48. CDK checks

When infrastructure is in scope, inspect/synthesize:

- source queue
- DLQ
- redrive policy
- Lambda timeout
- memory
- architecture/runtime
- event source mapping
- batch size
- batch window
- partial batch response
- visibility timeout
- reserved concurrency
- maximum concurrency
- FIFO configuration
- encryption
- alarms
- IAM

Run repository commands when available:

```bash
pnpm cdk:synth
pnpm cdk:diff
```

Do not invent commands that do not exist.

---

# 49. Static and test commands

Inspect the root `package.json` first.

When available and relevant run:

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm test:integration
```

If targeted worker test scripts exist, prefer them during development and run
the required broader gates before completion.

Do not hide failures.

Do not weaken tests to make the implementation pass.

---

# 50. Implementation mode workflow

When mode is `implement`:

1. read required project context
2. identify queue/Lambda/infrastructure configuration
3. classify queue as Standard or FIFO
4. classify all business side effects
5. identify idempotency mechanism
6. identify legal durable state transitions
7. identify state + event dual writes
8. identify failure/retry behavior
9. inspect or create required tests
10. implement the smallest correct change
11. configure partial batch handling
12. validate visibility timeout
13. validate DLQ/redrive
14. validate concurrency/backpressure
15. run typecheck/lint/tests
16. synthesize CDK when infrastructure changed
17. inspect final diff
18. report unresolved risks

Do not begin another worker or architecture phase unless explicitly requested.

---

# 51. Review mode workflow

When mode is `review`:

1. do not modify files
2. inspect handler and dependencies
3. inspect CDK/event-source configuration
4. trace one success path
5. trace duplicate-delivery path
6. trace retryable failure path
7. trace poison-message path
8. trace process-crash windows
9. trace external-ambiguity path if applicable
10. verify tests
11. run relevant checks
12. return PASS, PASS_WITH_WARNINGS, or FAIL

When correctness cannot be demonstrated, return FAIL with missing evidence.

---

# 52. Blocking conditions

In implementation mode, stop and report `BLOCKED` if any of these are true and
cannot be resolved within the requested scope:

- side effect is `UNSAFE`
- required idempotency key cannot be defined
- external provider has ambiguous non-idempotent semantics with no reconciliation
- message schema/identity is insufficient for safe retries
- legal state transition is undefined
- queue ordering requirement is unknown and materially affects correctness
- current architecture requires an unsafe database + message dual write
- critical AWS configuration is outside managed IaC and cannot be verified
- requested change violates `CLAUDE.md` or documented invariants

Do not "make it work" by removing reliability safeguards.

---

# 53. Severity for review mode

Use:

```text
CRITICAL
HIGH
MEDIUM
LOW
```

## CRITICAL

- duplicate irreversible side effect
- lost business operation
- cross-request/tenant corruption
- unrecoverable external ambiguity
- permanent workflow inconsistency

## HIGH

- non-idempotent consumer
- no partial batch handling where required
- incorrect FIFO failure handling
- visibility timeout below required design
- no DLQ for critical queue
- unsafe state transition
- swallowed poison message
- dual-write can permanently strand workflow
- critical failure behavior has no test

## MEDIUM

- DLQ without alarm/runbook
- weak queue-age monitoring
- uncontrolled downstream concurrency
- inefficient fixed retries
- load/capacity assumptions untested
- poor observability

## LOW

- maintainability
- naming
- minor test clarity
- minor efficiency issue

CRITICAL and HIGH block acceptance.

---

# 54. Anti-patterns

Flag or refuse these unless explicitly proven safe.

## Blind external retry

```ts
try {
  await provider.create();
} catch {
  await provider.create();
}
```

without stable idempotency/reconciliation.

## Swallowed record error

```ts
try {
  await processRecord(record);
} catch (error) {
  logger.error(error);
}

return { batchItemFailures: [] };
```

## Whole batch throw for independent Standard records

```ts
for (const record of event.Records) {
  await processRecord(record);
}
```

where one failure throws the invocation and unnecessarily retries successes.

## In-memory deduplication

```ts
const seen = new Set<string>();
```

as the business guarantee.

## Unconditional terminal update

```ts
SET status = COMPLETED
```

without expected prior state.

## Unsafe direct dual write

```ts
await saveSuccess();
await sendNextMessage();
```

when crash between the calls can strand the workflow.

## FIFO global serialization

```text
MessageGroupId = "all"
```

for a high-scale system without a true global ordering requirement.

## Unlimited concurrency into a limited provider

No event-source or application backpressure despite a known downstream quota.

## Retry multiplication

Multiple nested retry layers with no total attempt/time budget.

## DLQ without alarm

Messages fail permanently and nobody is notified.

## Timeout means remote failure

Provider timeout immediately treated as proof that the side effect did not
occur.

---

# 55. Required review output

Return:

```text
SQS WORKER: PASS | PASS_WITH_WARNINGS | FAIL | BLOCKED

Mode:
implement | review

Scope:
<worker/path>

Queue:
- name:
- type: STANDARD/FIFO/UNKNOWN
- DLQ:
- maxReceiveCount:
- visibility timeout:
- batch size:
- batch window:
- partial batch response:
- maximum concurrency:
- provisioned polling mode:

Lambda:
- timeout:
- reserved concurrency:
- runtime:
- memory:

Business step:
<description>

Side-effect classification:
NATURALLY_IDEMPOTENT |
IDEMPOTENCY_PROTECTED |
RECONCILABLE |
UNSAFE |
NOT_APPLICABLE

Idempotency mechanism:
<description>

State transition:
<from -> to or NOT_APPLICABLE>

Next-event safety:
OUTBOX |
SAFE_DIRECT_SEND |
NOT_APPLICABLE |
UNSAFE |
UNKNOWN

Checks:
- runtime message validation: PASS/FAIL
- request correlation: PASS/FAIL
- duplicate delivery safety: PASS/FAIL
- partial batch handling: PASS/FAIL
- FIFO ordering behavior: PASS/FAIL/NOT_APPLICABLE
- visibility timeout: PASS/FAIL
- DLQ/redrive: PASS/FAIL
- DLQ monitoring: PASS/FAIL
- poison-message behavior: PASS/FAIL
- retry classification: PASS/FAIL
- external ambiguity handling: PASS/FAIL/NOT_APPLICABLE
- conditional state transitions: PASS/FAIL/NOT_APPLICABLE
- dual-write safety: PASS/FAIL/NOT_APPLICABLE
- downstream backpressure: PASS/FAIL/UNKNOWN
- IAM least privilege: PASS/FAIL/UNKNOWN
- observability: PASS/FAIL
- failure-path tests: PASS/FAIL

CRITICAL:
- ...

HIGH:
- ...

MEDIUM:
- ...

LOW:
- ...

Tests added or found:
- ...

Commands executed:
- ...

Files changed:
- ...

Unproven assumptions:
- ...

Blocking remediation:
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

Do not omit sections.

Do not invent configuration values.

Use `UNKNOWN` when infrastructure cannot be verified.

---

# 56. Acceptance criteria

Return PASS only when:

- message body is validated
- request/message identity is deterministic
- duplicate processing is safe
- side effects are idempotent or deterministically reconcilable
- partial batch responses are correctly configured and implemented
- Standard/FIFO semantics are handled correctly
- Lambda/SQS visibility timeout relationship is safe
- DLQ/redrive exists for critical production queues
- poison messages cannot be silently lost
- state transitions are guarded
- state + next-event progression is crash-safe
- retry policy does not create duplicate irreversible effects
- concurrency respects downstream limits
- required tests pass
- critical failure paths are covered
- infrastructure matches application assumptions
- there are zero CRITICAL findings
- there are zero HIGH findings

Return PASS_WITH_WARNINGS only for MEDIUM/LOW findings.

Return FAIL for any CRITICAL or HIGH finding.

Return BLOCKED when correctness depends on information or architecture that is
not available and cannot safely be inferred.

---

# 57. Final reliability question

Before completion, answer internally:

```text
If AWS gives this same logical message to the worker again after any individual
network, provider, DynamoDB, or SQS operation, will repeating the worker either:

1. safely produce the same business outcome, or
2. deterministically discover the existing outcome,

without duplicating an irreversible side effect or corrupting workflow state?
```

If the answer is no or unknown:

do not return PASS.
