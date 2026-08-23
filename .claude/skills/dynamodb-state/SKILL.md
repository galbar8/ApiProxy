---
name: dynamodb-state
description: >
  Implement or review production-grade DynamoDB workflow state management for
  the sync-over-async AWS service. Use when code touches workflow records,
  idempotency records, conditional writes, state transitions, strongly
  consistent polling reads, optimistic concurrency, DynamoDB transactions,
  transactional outbox, TTL, DynamoDB Streams, large results, hot partitions,
  retries, or multi-region state semantics.
argument-hint: "[implement|review] [repository|table|path|scope]"
disable-model-invocation: true
context: fork
allowed-tools:
  - Read
  - Grep
  - Glob
---

# DynamoDB State

Implement or review DynamoDB state management for a production distributed
workflow.

Invocation:

```text
/dynamodb-state implement packages/persistence
```

or:

```text
/dynamodb-state review apps/finalizer
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

The remaining argument identifies the repository, table, path, or scope.

If mode is `review`, do not modify implementation, tests, or infrastructure.

If mode is `implement`, make the smallest correct change within the requested
scope.

If mode or scope cannot be determined safely, stop and report what is missing.

---

# 1. Mission

DynamoDB is the authoritative source of workflow state.

The design must remain correct under:

- concurrent workers
- duplicate SQS delivery
- HTTP retries
- process crashes
- ECS replacement
- Lambda retries
- delayed messages
- stale readers
- conditional write conflicts
- transaction conflicts
- external API ambiguity
- partial failures
- deployment changes
- DynamoDB throttling
- transient AWS SDK failures

The state layer must prevent:

- duplicate logical workflow creation
- illegal state transitions
- terminal-state overwrite
- cross-request result mismatch
- cross-tenant access
- lost workflow continuation
- duplicate irreversible side effects caused by state ambiguity
- unsafe retry after partial success
- hidden data loss

Correctness is more important than reducing one DynamoDB request.

---

# 2. Required project context

Before implementation or review, read when present:

1. `CLAUDE.md`
2. `docs/invariants.md`
3. `docs/architecture.md`
4. `docs/state-machine.md`
5. relevant ADRs under `docs/adr/`
6. relevant phase file under `docs/phases/`
7. workflow contracts/types
8. persistence repository implementation
9. SQS worker implementation using the state layer
10. HTTP API implementation using the state layer
11. CDK definition for DynamoDB tables/indexes/streams
12. relevant tests

If implementation conflicts with a documented invariant, the implementation is
wrong unless an approved ADR changes the invariant.

Do not weaken a documented invariant for convenience.

---

# 3. Authoritative state rule

DynamoDB is the only authoritative source of workflow business state.

The following are not authoritative:

- ECS process memory
- Promise state
- HTTP connection state
- SQS message existence
- Lambda invocation state
- CloudWatch logs
- trace state
- cache state

In-memory state may improve latency but must not determine durable business
truth.

A process restart must not erase the ability to determine:

```text
what operation exists
what step it reached
whether it completed
what final result it produced
whether it failed
```

---

# 4. Separate identities

Do not collapse all identifiers into one field without an explicit reason.

Understand at least:

```text
requestId
idempotencyKey
messageId
stepId
eventId
tenantId
workflowVersion
```

## requestId

Identifies one internal workflow execution.

Must be immutable.

## idempotencyKey

Identifies one externally retriable logical client operation.

A repeated request using the same idempotency key must not create an additional
logical business operation.

## messageId

Identifies one internal message/event where deduplication or observability
requires it.

## stepId

Identifies one business step within a workflow.

## eventId

Identifies an outbox/domain event.

## tenantId

Defines ownership/security boundary.

Never use `requestId` alone as authorization.

---

# 5. Workflow record

A workflow record should contain only fields required by the domain and
operational invariants.

Conceptual example:

```ts
interface WorkflowRecord {
  requestId: string;
  tenantId: string;
  idempotencyKey: string;

  status: "PROCESSING" | "COMPLETED" | "FAILED";

  workflowVersion: number;
  stateVersion: number;

  createdAt: number;
  updatedAt: number;

  syncDeadlineAt?: number;
  businessDeadlineAt?: number;

  result?: unknown;
  resultRef?: string;

  errorCode?: string;
  errorDetails?: unknown;

  expiresAt?: number;
}
```

Do not copy this shape mechanically.

Use the repository's actual domain model.

Every persisted field must have defined semantics.

---

# 6. State machine is explicit

Before changing state logic, identify the legal state machine.

At minimum, the current design assumes:

```text
PROCESSING -> COMPLETED
PROCESSING -> FAILED
```

Terminal states:

```text
COMPLETED
FAILED
```

Unless a documented ADR defines additional states.

Forbidden by default:

```text
COMPLETED -> PROCESSING
FAILED    -> PROCESSING
COMPLETED -> FAILED
FAILED    -> COMPLETED
```

Do not infer legal transitions from current code alone.

Read the domain/state-machine documentation.

---

# 7. Conditional writes are mandatory for critical transitions

Critical state transitions must be enforced by DynamoDB, not only checked in
application memory.

Bad:

```ts
const item = await getWorkflow(requestId);

if (item.status === "PROCESSING") {
  await updateWorkflow(requestId, "COMPLETED");
}
```

This contains a race between read and write.

Preferred conceptual operation:

```text
UPDATE workflow
SET status = COMPLETED
WHERE status = PROCESSING
```

implemented with a `ConditionExpression`.

Example concept:

```ts
ConditionExpression: "#status = :processing";
```

A concurrent caller must receive a conditional failure instead of silently
overwriting state.

---

# 8. Read-then-write races

Always search for:

```text
read
if (...)
write
```

when correctness depends on the value remaining unchanged.

Potential race:

```text
Worker A reads PROCESSING
Worker B reads PROCESSING
Worker A writes COMPLETED
Worker B writes FAILED
```

Without a write condition, the last writer can corrupt the terminal result.

Do not approve a pre-read as the only concurrency guard.

Use:

- conditional update
- optimistic version condition
- transaction condition

depending on the invariant.

---

# 9. Terminal state immutability

Terminal state must be protected at the database layer.

A late or duplicate worker must not change the result.

Example:

```text
PROCESSING -> COMPLETED
```

followed by a duplicated old worker trying:

```text
PROCESSING -> FAILED
```

must fail because the actual current state is already `COMPLETED`.

The application should treat that condition failure as:

```text
another actor already finalized this workflow
```

not automatically as a system error.

---

# 10. Optimistic concurrency

Use an explicit version field when multiple valid updates can occur while the
record is in the same broad workflow status.

Conceptual example:

```text
stateVersion = 17
```

Update:

```text
SET ...
stateVersion = 18

Condition:
stateVersion = 17
```

This prevents lost updates.

Use optimistic versioning when:

- multiple workers can update one record
- step progression can race
- metadata updates can overwrite one another
- status alone is not a sufficiently precise condition

Do not add a version field without using it in conditions.

---

# 11. Do not mix version semantics

If the record contains:

```text
workflowVersion
stateVersion
```

their meanings must be distinct.

Recommended conceptual semantics:

```text
workflowVersion
= schema/orchestration definition version

stateVersion
= optimistic concurrency revision
```

Do not use one field for both.

---

# 12. Idempotent creation

Creating a new workflow must be guarded against duplicate creation.

Use a conditional create where required:

```text
attribute_not_exists(primaryKey)
```

or an atomic transaction involving the idempotency record.

A client retry must not create:

```text
request R1
request R2
```

for one logical idempotency key.

---

# 13. HTTP idempotency record

The state design must define how:

```text
tenantId + idempotencyKey
```

maps to one logical workflow.

Conceptual options include:

```text
separate idempotency item
```

or:

```text
single-table item type
```

The mechanism must support:

```text
first request
-> create workflow

duplicate request with same payload
-> return/reuse same workflow

duplicate request with different material payload
-> reject conflict
```

Do not silently accept a reused idempotency key with different business input.

---

# 14. Payload fingerprint

When idempotency semantics require proving that a repeated request is the same
logical request, persist a deterministic payload fingerprint.

Example concept:

```text
payloadHash
```

The hash must be computed from a canonical representation of material business
input.

Do not hash volatile fields such as:

- request timestamp
- trace ID
- connection metadata

unless they are truly part of the business identity.

If same idempotency key arrives with a different material payload, return a
defined conflict result instead of starting another workflow.

---

# 15. Atomic workflow + idempotency creation

If the invariant is:

```text
one idempotency key
must point to
one workflow
```

and this relationship spans multiple items, use one DynamoDB transaction when
necessary.

Conceptual transaction:

```text
ConditionCheck / Put idempotency mapping
+
Put workflow record
```

The operation must not leave:

```text
idempotency mapping exists
but workflow missing
```

or:

```text
workflow exists
but idempotency mapping missing
```

if either state breaks retry safety.

---

# 16. TransactWriteItems

Use `TransactWriteItems` when multiple DynamoDB mutations must succeed or fail
as one invariant.

Typical uses:

```text
workflow state update
+
step record update
+
outbox event creation
```

or:

```text
idempotency mapping
+
workflow creation
```

Do not use transactions merely because they "sound safer."

Use them when atomicity across multiple items is required.

---

# 17. Transaction constraints

When using a DynamoDB transaction, verify:

- all items are identified deterministically
- conditions represent the real invariant
- transaction conflict behavior is handled
- retry behavior is defined
- request does not try to mutate the same item twice inside one transaction
- total transaction size/count remains within current AWS service limits
- the transaction is not hiding a poor partitioning design

Do not replace a required atomic transaction with `BatchWriteItem`.

Batch write is not a conditional multi-item transaction.

---

# 18. Idempotent transaction retry

If application-level retries may resubmit the exact same transaction, use a
stable transaction client token where appropriate.

Do not generate a different token for each retry of the same transaction if the
token is intended to provide retry idempotency.

Do not reuse one transaction token for materially different transaction
contents.

---

# 19. Transactional outbox

A dangerous pattern:

```ts
await updateWorkflowState();
await sqs.send(nextMessage);
```

If the process crashes after the DynamoDB update:

```text
state advanced
next message does not exist
workflow may be stuck forever
```

When state advancement and future publication form one invariant, use the
project's approved transactional outbox.

Conceptual transaction:

```text
TransactWriteItems
  |
  +-- update workflow/step
  |
  +-- put OUTBOX event
```

Then publish the outbox asynchronously.

---

# 20. Outbox item

An outbox item should have deterministic identity.

Conceptual fields:

```text
eventId
requestId
eventType
workflowVersion
destination
payload/payloadRef
createdAt
status/metadata if needed
expiresAt if safe
```

Do not depend on a mutable "published=true" flag as the only duplicate
protection.

The publisher and downstream consumer must both tolerate duplicate execution.

---

# 21. DynamoDB Streams

If DynamoDB Streams drives outbox publishing or other workflow actions, assume
stream processing can be retried.

Application requirements:

- publisher is idempotent
- event identity is stable
- downstream processing is idempotent
- duplicate stream handling is safe
- iterator lag is monitored where operationally relevant
- poison events have a failure path

Do not describe DynamoDB Streams as exactly-once business delivery.

---

# 22. Stream view type

If stream consumers require old/new state, inspect the configured stream view
type.

Do not write a consumer that assumes `NEW_IMAGE`, `OLD_IMAGE`, or both unless
CDK actually configures the required stream view.

Infrastructure must match application assumptions.

---

# 23. Strongly consistent polling reads

The synchronous HTTP API waits for terminal state using DynamoDB.

For the authoritative base-table item, strongly consistent `GetItem` is
appropriate where immediate visibility of the latest successful write is
required.

Conceptual example:

```ts
ConsistentRead: true;
```

Do not use an eventually consistent GSI lookup as if it were the latest
authoritative workflow state.

Global secondary indexes do not support strongly consistent reads.

---

# 24. Poll by primary key

The synchronous waiter should normally read the workflow by exact primary key.

Prefer:

```text
GetItem
```

over:

```text
Scan
```

Never implement workflow waiting using table scans.

Do not use a GSI merely to avoid knowing the request primary key.

The HTTP layer should already know the immutable `requestId`.

---

# 25. Polling is bounded

DynamoDB is the synchronization source, but polling must be bounded.

Required properties:

- absolute deadline
- configurable delays
- backoff/progressive delay
- jitter
- cancellation awareness where practical
- no tight busy loop
- no indefinite wait

Do not implement:

```ts
while (true) {
  await getWorkflow();
}
```

Do not make polling every few milliseconds a correctness requirement.

---

# 26. Polling timeout is not business failure

If the HTTP waiter reaches its synchronous deadline:

```text
HTTP wait expired
```

does not automatically imply:

```text
workflow FAILED
```

The durable workflow may remain:

```text
PROCESSING
```

and later become:

```text
COMPLETED
```

The state layer must not conflate transport/session timeout with business
failure.

---

# 27. Business deadline vs synchronous deadline

If the system has both:

```text
syncDeadlineAt
businessDeadlineAt
```

their semantics must be documented and distinct.

Example:

```text
syncDeadlineAt
= how long the HTTP API waits

businessDeadlineAt
= latest time the business operation is allowed to continue
```

A worker must not cancel business processing solely because `syncDeadlineAt`
expired.

---

# 28. Result storage

Before storing workflow results in DynamoDB, estimate maximum result size.

DynamoDB has a hard item-size limit.

Do not store arbitrarily large response objects in one workflow item.

For large results, prefer:

```text
DynamoDB:
resultRef = s3://...

S3:
actual result
```

The terminal state should still be durable and independently queryable.

---

# 29. Result reference integrity

If `resultRef` points to S3 or another durable store, the state layer must avoid
claiming a complete result when the referenced object is not durably available.

Model:

```text
write DynamoDB COMPLETED
        |
        X
S3 result was never persisted
```

or the reverse.

Define the safe order or transactional/compensating mechanism.

Do not create a terminal record that references a missing result.

---

# 30. Large input storage

The same rule applies to large input.

DynamoDB workflow state should not become an unbounded data bucket.

Use:

```text
inputRef
resultRef
```

where appropriate.

Keep workflow metadata small and predictable.

---

# 31. Item-size review

For every item type, understand worst-case size.

Check:

- workflow result
- error payload
- external API response
- audit metadata
- outbox payload
- idempotency request snapshot

Do not persist full raw external responses unless required.

Prefer compact normalized data and object references.

A path that can exceed DynamoDB's hard item-size limit is a production blocker.

---

# 32. Hot partition review

Big-scale design must evaluate partition-key distribution.

Dangerous keys include low-cardinality values such as:

```text
status = PROCESSING
tenantType = "customer"
date = 2026-08-20
```

as a direct high-volume partition key.

A good primary key should distribute write/read load according to actual access
patterns.

For request-centric workflow state, a high-cardinality `requestId` is generally
a strong distribution key.

Do not create a single hot partition for:

- all active workflows
- all outbox events
- all one tenant's high-volume events

without an intentional sharding strategy.

---

# 33. Tenant partitioning

Do not automatically choose:

```text
PK = tenantId
```

for all workflow state in a high-scale multi-tenant system.

A very large tenant can create a hot partition.

Evaluate actual access patterns.

Possible patterns may include:

```text
PK = REQUEST#requestId
```

with ownership stored as an attribute, plus a separate index for tenant
queries.

Or sharded tenant-oriented keys when tenant scans are required.

Do not redesign the table casually; document major key-design changes in an
ADR.

---

# 34. Single-table design

Do not adopt single-table design automatically.

Use it only when:

- access patterns are clearly known
- item types are well defined
- team understands the model
- it improves real transactional/query requirements

Do not create opaque PK/SK schemes merely to follow a pattern.

Correctness and operability are more important than minimizing table count.

---

# 35. Secondary indexes

Every GSI must correspond to a real access pattern.

For each GSI identify:

```text
query
partition key cardinality
sort key
projected attributes
consistency implications
write amplification
hot-key risk
```

Do not use a GSI for authoritative terminal-state synchronization when a
strongly consistent base-table `GetItem` is required.

Remember that GSIs add write cost and storage.

---

# 36. Sparse indexes

Sparse indexes can be useful for operational/state subsets such as:

```text
items requiring reconciliation
unpublished outbox items
```

when the access pattern is appropriate.

Do not maintain broad low-cardinality indexes over all workflow state if they
create unnecessary hot partitions and cost.

---

# 37. Scans

Production workflow paths must not depend on unbounded DynamoDB `Scan`.

Flag:

```text
scan table to find active requests
scan table to find expired requests
scan table to find unfinished outbox events
```

unless the dataset is deliberately tiny and documented.

Design an index or event-driven mechanism for operational queries.

---

# 38. TTL

DynamoDB TTL is an asynchronous cleanup mechanism.

Do not use TTL as an exact timer.

Do not assume the item disappears exactly at `expiresAt`.

Do not use TTL deletion as the business transition:

```text
PROCESSING -> TIMED_OUT
```

or as an exact scheduling mechanism.

TTL should normally clean up data that is already safe to delete.

---

# 39. TTL safety

Before adding TTL, answer:

```text
Can this item disappear while:
- client retry still needs it?
- reconciliation still needs it?
- audit/compliance requires it?
- outbox publishing may still need it?
- another workflow item references it?
```

If yes, TTL is unsafe or retention is too short.

Use separate retention windows for different item types when required.

---

# 40. PITR

Production DynamoDB tables containing authoritative workflow state should
normally enable Point-in-Time Recovery unless a documented ADR says otherwise.

Verify CDK configuration.

Do not claim PITR replaces application-level idempotency or transactional
correctness.

PITR is a recovery feature, not a concurrency-control mechanism.

---

# 41. Deletion protection and removal policy

For production authoritative tables, review:

```text
deletion protection
CDK RemovalPolicy
replacement behavior
```

A deployment must not accidentally delete workflow state.

Production data tables should not use destructive removal policies without
explicit approval.

Treat table replacement in `cdk diff` as a serious deployment risk.

---

# 42. Encryption

Verify production tables use the project's required encryption policy.

If a customer-managed KMS key is required:

- IAM must allow required usage
- key policy must be correct
- deletion/rotation behavior must be understood

Do not add custom KMS complexity without an actual security requirement.

---

# 43. Capacity mode

Do not choose capacity mode by habit.

For uncertain or variable traffic, on-demand is often a reasonable starting
point.

For predictable high-volume traffic, provisioned capacity with autoscaling may
be more cost-effective.

Review:

- traffic shape
- peak RPS
- item size
- strong vs eventual reads
- transactional multiplier
- GSI write amplification
- burst behavior

Do not change capacity mode as a "performance optimization" without evidence.

---

# 44. Strong-read cost awareness

Strongly consistent reads have different capacity/cost characteristics from
eventually consistent reads.

Use strong reads where they serve correctness or latency requirements.

Do not turn every query into a strong read automatically.

Typical intended use in this architecture:

```text
base-table workflow GetItem for synchronous terminal-state polling
```

Other reporting/query paths may use eventual consistency.

---

# 45. Transaction cost awareness

Transactions cost more than simple reads/writes.

Use them for actual multi-item invariants.

Do not remove a required transaction merely to reduce cost.

Do not add transactions to unrelated independent writes where atomicity is not
required.

Measure before optimizing.

---

# 46. Error handling

Classify DynamoDB failures.

Examples:

## ConditionalCheckFailed

Usually means:

```text
expected state/version no longer matches
```

This may be a normal concurrency outcome.

Do not automatically retry the same invalid transition forever.

## Transaction conflict / transient AWS failure

May be retryable with bounded backoff/jitter.

## Validation/schema failure

Usually non-retryable until code/data changes.

## Throttling

Retryable according to SDK/project policy, but persistent throttling requires
capacity/load investigation.

Do not convert every DynamoDB exception into:

```text
workflow FAILED
```

---

# 47. Conditional failure semantics

For each conditional write, define what failure means.

Example:

```text
finalize request if status == PROCESSING
```

If the condition fails because status is already `COMPLETED`:

```text
duplicate finalization
```

may be safely ignored/reconciled.

If status is `FAILED`:

```text
conflicting finalization
```

may require warning/error.

Do not catch all conditional failures and silently ignore them.

Inspect the actual current state when needed to classify the conflict safely.

---

# 48. Retry with backoff and jitter

Application-controlled retry loops around DynamoDB must be:

- bounded
- exponential/progressive
- jittered
- deadline-aware

Avoid synchronized fixed delays across many workers.

Do not stack unbounded custom retries on top of AWS SDK retries.

Know which layer owns retries.

---

# 49. Retry multiplication

Review combined retries:

```text
AWS SDK retry
application retry
Lambda retry
SQS redelivery
client retry
```

A state method that is "retried 3 times" may effectively run far more often
through the full system.

Durable idempotency/conditions must make repeated execution safe.

---

# 50. Step state

If each workflow contains multiple important steps, model step state when
required for recovery.

Conceptual item:

```text
requestId
stepId
status
externalOperationId
attemptMetadata
result/resultRef
updatedAt
```

Do not restart the whole workflow blindly after a crash when durable step state
can identify the first incomplete step.

Step modeling is required particularly when external irreversible side effects
exist.

---

# 51. External operation identity

When a step calls an external API, persist a stable external idempotency or
operation reference before ambiguity can arise, where the provider/API permits
it.

Example:

```text
externalIdempotencyKey =
requestId + ":" + stepId
```

After timeout/crash, the state layer must be able to answer:

```text
What external operation should we reconcile?
```

Do not generate a new provider idempotency key on retry.

---

# 52. UNKNOWN_EXTERNAL_STATE

The state model should have a deterministic representation or recovery path for
cases where:

```text
provider may have succeeded
but local system does not know
```

This may be modeled as:

- dedicated step state
- reconciliation metadata
- retry classification
- failure/recovery record

Do not automatically mark such operations permanently `FAILED` if doing so
allows a duplicate retry elsewhere.

Do not automatically retry without provider idempotency/reconciliation.

---

# 53. Error persistence

Persist only useful error information.

Good fields may include:

```text
errorCode
errorClass
safeMessage
providerReference
reconciliationRequired
failedStep
```

Do not store:

- full stack traces as primary business data
- secrets
- tokens
- oversized provider bodies
- raw sensitive customer payloads

Logs may contain technical diagnostics subject to the project's data policy.

---

# 54. Multi-region warning

Do not introduce DynamoDB Global Tables or active-active workflow writes
without explicit architecture review.

Multi-region active-active writes introduce conflict semantics that can violate
a simple single-region state-machine assumption.

Before multi-region writes, define:

- writer ownership
- conflict resolution
- idempotency across regions
- terminal-state conflict behavior
- request routing
- recovery semantics

A single-region invariant such as:

```text
one conditional transition determines the winner
```

must not be assumed unchanged under independent concurrent regional writers.

Require an ADR for multi-region workflow state.

---

# 55. Single-writer preference

For critical workflow state, prefer one logical write authority per request or
a clearly defined conditional concurrency model.

Multiple workers may race safely only when DynamoDB conditions define the
winner.

Do not rely on wall-clock timestamps to choose the "latest" business truth
without an explicit conflict model.

---

# 56. Time fields

Use consistent time representation.

Prefer epoch milliseconds or another project-wide explicit convention.

Separate:

```text
createdAt
updatedAt
syncDeadlineAt
businessDeadlineAt
expiresAt
```

Do not overload one timestamp with multiple meanings.

Do not rely on exact timestamp equality for concurrency control when an explicit
version field is safer.

---

# 57. Clock skew

Distributed components may have clock skew.

Do not use local wall-clock ordering alone to determine which concurrent
business state wins.

Use conditional state/version rules.

Absolute deadlines can still be used, but include reasonable tolerance where
protocol semantics require it.

---

# 58. Tenant isolation

Every read/write path must preserve tenant ownership.

If external callers can query:

```text
GET /v1/process/:requestId
```

the persistence API should support authorization using authenticated tenant
context.

Do not return an item simply because `requestId` exists.

At minimum verify:

```text
workflow.tenantId == authenticatedTenantId
```

or use a key design that enforces equivalent isolation.

Cross-tenant leakage is CRITICAL.

---

# 59. Do not trust caller-controlled keys

External input must not directly control:

- table name
- index name
- internal PK/SK prefixes
- outbox destination
- internal resource ARN
- workflow status
- state version
- tenant ownership

Derive internal keys server-side from validated business identifiers.

---

# 60. Repository abstraction

HTTP handlers and workers should not construct arbitrary DynamoDB expressions
everywhere.

Prefer a persistence/domain repository that centralizes invariants.

Example conceptual API:

```ts
interface WorkflowRepository {
  createOrGetByIdempotencyKey(...): Promise<...>;
  getByRequestId(...): Promise<...>;
  completeIfProcessing(...): Promise<...>;
  failIfProcessing(...): Promise<...>;
  advanceStep(...): Promise<...>;
}
```

The repository should encode:

- conditions
- transaction structure
- consistent-read choices
- key construction

Do not expose a generic:

```ts
updateAnything(requestId, patch);
```

for critical workflow state.

---

# 61. Avoid generic patch updates

Generic patch helpers make state-machine bypass easy.

Bad:

```ts
await repo.patch(requestId, {
  status: "COMPLETED",
});
```

Preferred:

```ts
await repo.completeWorkflow({
  requestId,
  expectedState: "PROCESSING",
  result,
});
```

Domain-specific persistence methods should make illegal transitions difficult.

---

# 62. Runtime validation

Validate data crossing persistence boundaries when necessary.

Examples:

- DynamoDB record decoded from legacy/current schema
- outbox payload
- stored external result metadata

Do not assume TypeScript types prove existing persisted data has the expected
shape.

Schema/version migration strategy must exist when record structure evolves.

---

# 63. Schema evolution

Every workflow record should have a clear schema/workflow versioning strategy
where long-lived workflows may span deployments.

Do not deploy code that cannot safely read in-flight records created by the
previous version.

For breaking changes, define:

- backward-compatible read
- migration
- workflowVersion routing
- drain-before-deploy

Do not mutate stored semantics silently.

---

# 64. Workflow version

A message and state record should preserve the workflow version when routing
logic differs between versions.

A worker must not accidentally process:

```text
workflowVersion = 2
```

using incompatible version-3 semantics.

If unsupported, fail through a controlled path rather than guessing.

---

# 65. Observability

Every state mutation should produce structured logs with useful correlation.

Recommended fields:

```text
requestId
tenantId
stepId
workflowVersion
oldStatus
newStatus
stateVersion
operation
durationMs
conditionalConflict
errorCode
```

Do not log secrets or large sensitive results.

For conditional conflicts, distinguish expected duplicate behavior from actual
workflow conflict.

---

# 66. Metrics

Consider metrics for:

```text
workflow create success
idempotency hit
idempotency conflict
conditional conflict
workflow completed
workflow failed
poll read count
poll duration
DynamoDB throttling
transaction conflict
outbox created
outbox publish lag
reconciliation required
```

Do not add high-cardinality dimensions such as raw `requestId` to CloudWatch
metrics.

Use requestId in logs/traces, not metric dimensions.

---

# 67. Alarms

Infrastructure should monitor relevant production conditions:

```text
DynamoDB throttling
system errors
outbox lag
stream iterator age where applicable
workflow failure-rate anomalies
```

A correctness mechanism that can silently stop progressing requires an alarm or
other operational visibility.

---

# 68. Required tests

For state-management code, require tests appropriate to the scope.

Minimum important scenarios:

## Creation

```text
first idempotency key
-> one workflow created
```

## Duplicate request

```text
same tenant + same idempotency key + same payload
-> same logical workflow
```

## Idempotency conflict

```text
same tenant + same idempotency key + different material payload
-> conflict
```

## Terminal transition

```text
PROCESSING -> COMPLETED
-> succeeds
```

## Duplicate terminal transition

```text
COMPLETED -> COMPLETED attempt
-> does not corrupt state
```

## Conflicting terminal transition

```text
COMPLETED -> FAILED attempt
-> rejected
```

## Optimistic concurrency

```text
two writers use same stateVersion
-> one succeeds
-> one gets conflict
```

## Strong read

```text
terminal state polling repository path
-> requests ConsistentRead where required
```

Add when relevant:

- transaction atomicity
- transaction retry
- outbox creation
- duplicate stream event
- TTL retention behavior
- large result externalization
- cross-tenant read denial
- workflow version mismatch
- conditional failure classification
- throttling/retry behavior

---

# 69. Concurrency tests

Do not prove concurrency safety only through sequential tests.

Where practical, run competing operations.

Example:

```text
Promise.all([
  completeWorkflow(R1),
  failWorkflow(R1)
])
```

Expected:

```text
exactly one legal terminal mutation wins
```

Then verify durable final state.

The test should prove the database condition, not only an in-memory lock.

---

# 70. Idempotency race test

Test two simultaneous first requests using the same idempotency key.

Expected:

```text
one logical workflow
```

not:

```text
two requestIds
```

If using a transaction/conditional record, prove the loser recovers the
existing workflow deterministically.

---

# 71. Outbox atomicity test

Where outbox is required, test:

```text
business state update
+
outbox event
```

as one transaction.

Simulate a transaction failure.

Expected:

```text
neither mutation commits
```

Then simulate duplicate outbox handling.

Expected:

```text
downstream business processing remains correct
```

---

# 72. Polling read test

The waiter/repository test should verify:

- exact request key
- strongly consistent base-table read when required
- terminal states recognized
- non-terminal state returned correctly
- missing item behavior defined

Do not test polling only with mocked delays while ignoring DynamoDB read
configuration.

---

# 73. Local integration testing

When the project uses a local DynamoDB-compatible test environment, use it for
conditional/transaction integration tests.

Mocks are useful for unit tests but do not fully prove DynamoDB expression and
transaction behavior.

Do not rely only on mocked `send()` return values for concurrency invariants.

---

# 74. AWS integration testing

Before production readiness, run key invariants against real AWS in a
non-production environment.

At minimum consider:

- conditional race
- TransactWrite behavior
- strongly consistent read path
- stream/outbox path
- TTL assumptions where applicable
- throughput/load behavior

Do not use production data for destructive concurrency tests.

---

# 75. Load testing

For big-scale state access, measure:

```text
concurrent workflows
poll reads per second
average item size
strong read rate
write rate
transaction rate
GSI write amplification
hot-key distribution
p50/p95/p99 DynamoDB latency
throttling
cost
```

Do not approve scale claims based only on theoretical DynamoDB capacity.

Polling configuration must be tuned using measured concurrency.

---

# 76. Polling herd analysis

Thousands of HTTP requests can poll at the same intervals.

Require jitter.

Bad:

```text
every request polls exactly every 500 ms
```

This can create synchronized bursts.

Preferred:

```text
base delay
+
random jitter
```

with a bounded max interval.

Measure the actual request pattern.

---

# 77. Access-pattern documentation

For every table/index changed, document its access patterns.

Example:

```text
Get workflow by requestId
Get logical operation by tenant + idempotencyKey
Conditionally complete workflow
Create outbox event atomically with step transition
Query reconciliation items
```

Do not create a key/index before defining how it is queried.

---

# 78. CDK review

Inspect infrastructure for:

```text
table name
partition key
sort key
billing mode
GSIs
LSIs if any
stream configuration
PITR
TTL
encryption
deletion protection
RemovalPolicy
alarms
IAM grants
```

Application assumptions must match CDK.

Do not accept:

```text
we will configure it manually later
```

for production correctness settings.

---

# 79. IAM

State consumers should have only required permissions.

Examples:

API may require:

```text
GetItem
PutItem
UpdateItem
TransactWriteItems
```

for specific tables depending on implementation.

Workers may require narrower actions.

Do not grant table-wide write permissions to components that only read unless
justified.

When indexes are queried, IAM/resources must include the required index path.

---

# 80. Deployment review

For any DynamoDB CDK change, inspect `cdk diff`.

Treat as dangerous:

```text
table replacement
partition-key change
sort-key change
index replacement with availability impact
RemovalPolicy DESTROY
PITR removal
deletion protection removal
TTL change that shortens retention unexpectedly
stream removal while outbox depends on it
```

Do not deploy a destructive production state change without explicit migration
and rollback plan.

---

# 81. Migration

DynamoDB schema evolution must be compatible with in-flight workflows.

For a migration define:

```text
old reader behavior
new reader behavior
old writer behavior
new writer behavior
backfill if needed
deployment order
rollback behavior
```

Prefer expand/contract migration.

Example:

```text
1. deploy readers supporting old + new field
2. deploy writers producing new field
3. backfill if required
4. verify
5. remove old-field dependency later
```

Do not deploy writer-first breaking schema changes.

---

# 82. Backup is not migration

PITR/backup is not a substitute for a safe schema migration.

Recovery from an accidental deployment may still require downtime and data
restoration.

Prevent destructive changes before deployment.

---

# 83. Review mode severity

Use:

```text
CRITICAL
HIGH
MEDIUM
LOW
```

## CRITICAL

- two logical workflows can be created for one idempotency key causing an
  irreversible duplicate operation
- terminal result can be overwritten
- cross-tenant workflow/result access
- state + external side effect ambiguity can cause duplicate irreversible action
- DB/event dual write can permanently lose required continuation
- production deployment can destroy authoritative workflow state without safe
  migration

## HIGH

- critical transition is unconditional
- read-then-write race controls correctness
- no durable HTTP idempotency
- transaction required by invariant but missing
- GSI/eventual read treated as authoritative latest state
- polling has no deadline
- result can exceed hard DynamoDB item limit
- unsafe TTL semantics
- critical concurrency behavior lacks tests
- outbox exists but is not atomic with state transition

## MEDIUM

- PITR missing
- no deletion protection where required
- polling lacks jitter
- hot-partition risk not load-tested
- weak observability
- unnecessary strong reads
- unnecessary transaction cost
- GSI write amplification not considered
- capacity assumptions untested

## LOW

- naming
- maintainability
- minor test clarity
- documentation gaps without correctness impact

CRITICAL and HIGH block acceptance.

---

# 84. Anti-patterns

Flag or refuse these unless explicitly proven safe.

## Unconditional status overwrite

```ts
UpdateExpression: "SET #status = :completed";
```

with no expected-state condition.

## Read-check-write concurrency

```ts
const item = await get(id);

if (item.status === "PROCESSING") {
  await complete(id);
}
```

without a write condition.

## Generic patch API

```ts
repo.patch(requestId, patch);
```

used to alter critical workflow state.

## Scan-based waiting

```ts
ScanCommand(...)
```

to find a specific request completion.

## GSI as strongly consistent truth

Using an eventually consistent GSI to decide that the latest authoritative
terminal state does not exist.

## TTL as exact scheduler

Assuming an item is deleted exactly at `expiresAt`.

## TTL as business timeout

Using TTL deletion to represent workflow failure.

## DB then SQS direct dual write

```ts
await dynamo.update(...);
await sqs.send(...);
```

when losing the second operation strands progress.

## Oversized result

Persisting arbitrary external result JSON into one item with no size guard.

## Low-cardinality partition

Using `status` as a high-volume table partition key.

## Cross-tenant lookup by requestId only

Returning workflow data without ownership verification.

## New provider idempotency key on retry

Generating a fresh external operation identity after an ambiguous failure.

## Blind conditional-error swallow

```ts
catch (ConditionalCheckFailedException) {
  return;
}
```

without knowing whether the conflict is benign or dangerous.

---

# 85. Implementation mode workflow

When mode is `implement`:

1. read project invariants and state-machine docs
2. identify affected access patterns
3. identify identities and tenant ownership
4. identify legal state transitions
5. identify concurrency actors
6. identify idempotency requirements
7. identify whether transaction is required
8. identify state + event dual-write risk
9. inspect table/index/stream CDK
10. inspect existing tests
11. write/update failure-path tests
12. implement domain-specific persistence methods
13. enforce conditions/versions in DynamoDB
14. use transactions where required
15. configure strong reads intentionally
16. validate TTL/retention behavior
17. validate result/item size strategy
18. check partition/index scaling
19. run static/tests
20. synthesize CDK when infrastructure changed
21. inspect final diff
22. report unresolved risks

Do not redesign unrelated tables unless explicitly requested.

---

# 86. Review mode workflow

When mode is `review`:

1. do not modify files
2. read architecture/invariants
3. inspect repository methods
4. inspect every changed write expression
5. inspect every condition
6. inspect transactions
7. inspect polling reads
8. inspect idempotency flow
9. inspect outbox/Streams
10. inspect table/index/TTL/PITR CDK
11. trace concurrent writers
12. trace duplicate HTTP request
13. trace duplicate SQS worker
14. trace terminal-state race
15. trace process crash around dual writes
16. trace cross-tenant read/write path
17. inspect tests
18. run relevant checks when permitted
19. return PASS / PASS_WITH_WARNINGS / FAIL / BLOCKED

Do not return PASS when correctness relies on an untested assumption.

---

# 87. Blocking conditions

Return `BLOCKED` when correctness depends on missing information that cannot be
safely inferred, including:

- state machine is undefined
- idempotency semantics are undefined
- tenant ownership rules are undefined
- external side-effect recovery strategy is undefined
- access pattern required for key design is unknown
- result size bounds are unknown and may exceed DynamoDB limits
- required transaction boundary is owned by another unresolved component
- multi-region writers are requested without conflict semantics
- requested implementation violates project invariants
- destructive production table change has no migration plan

Do not invent semantics.

---

# 88. Required commands

Inspect `package.json` before running commands.

When available and relevant:

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm test:integration
```

When infrastructure changed:

```bash
pnpm cdk:synth
pnpm cdk:diff
```

If a command does not exist, report:

```text
NOT_AVAILABLE
```

If unrelated to scope:

```text
NOT_APPLICABLE
```

Do not invent commands.

Do not hide failures.

---

# 89. Required output

Return exactly this structure:

```text
DYNAMODB STATE: PASS | PASS_WITH_WARNINGS | FAIL | BLOCKED

Mode:
implement | review

Scope:
<repository/table/path>

Authoritative state:
- table:
- primary key:
- sort key:
- workflow record item type:
- idempotency item type:
- step item type:
- outbox item type:

Access patterns reviewed:
- ...

State machine:
- ...
- terminal states:

Identity:
- requestId:
- idempotencyKey:
- tenantId:
- stateVersion:
- workflowVersion:

Consistency:
- synchronous polling read:
- strong read required: YES/NO
- GSI used for authoritative read: YES/NO

Concurrency:
- conditional writes: PASS/FAIL
- optimistic versioning: PASS/FAIL/NOT_APPLICABLE
- terminal-state protection: PASS/FAIL
- concurrent finalize race: PASS/FAIL

Idempotency:
- workflow creation: PASS/FAIL
- duplicate HTTP retry: PASS/FAIL
- payload conflict detection: PASS/FAIL/NOT_APPLICABLE
- step idempotency: PASS/FAIL/NOT_APPLICABLE

Transactions:
- required: YES/NO
- implementation: PASS/FAIL/NOT_APPLICABLE
- stable retry token: PASS/FAIL/NOT_APPLICABLE

Outbox:
- required: YES/NO
- atomic state + outbox: PASS/FAIL/NOT_APPLICABLE
- duplicate stream handling: PASS/FAIL/NOT_APPLICABLE

Polling:
- exact-key GetItem: PASS/FAIL
- bounded deadline: PASS/FAIL
- backoff: PASS/FAIL
- jitter: PASS/FAIL
- HTTP timeout separated from business failure: PASS/FAIL

Scale:
- item-size risk: PASS/FAIL/UNKNOWN
- hot-partition risk: PASS/FAIL/UNKNOWN
- GSI risk: PASS/FAIL/NOT_APPLICABLE
- load-test evidence: PRESENT/MISSING/NOT_APPLICABLE

Retention:
- TTL: PASS/FAIL/NOT_APPLICABLE
- TTL used only for cleanup: PASS/FAIL/NOT_APPLICABLE
- PITR: PASS/FAIL/UNKNOWN
- deletion protection: PASS/FAIL/UNKNOWN
- removal policy: PASS/FAIL/UNKNOWN

Security:
- tenant isolation: PASS/FAIL
- caller-controlled internal keys prevented: PASS/FAIL
- IAM least privilege: PASS/FAIL/UNKNOWN

CRITICAL:
- ...

HIGH:
- ...

MEDIUM:
- ...

LOW:
- ...

Failure-path tests:
- ...

Missing tests:
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

If a severity category has no findings:

```text
CRITICAL:
None.
```

Do not omit categories.

Do not invent table/index/configuration values.

Use `UNKNOWN` when they cannot be verified.

---

# 90. Acceptance criteria

Return PASS only when all applicable conditions are true:

- DynamoDB remains the authoritative workflow state
- duplicate logical HTTP request cannot create duplicate workflows
- critical writes use database-enforced conditions
- terminal state cannot be overwritten illegally
- concurrent writers cannot cause lost updates
- optimistic concurrency is used where status alone is insufficient
- required multi-item invariants use transactions
- state + event progression is crash-safe
- outbox is atomic where required
- polling uses exact-key authoritative reads
- strong consistency is used intentionally where required
- polling is bounded and jittered
- HTTP timeout does not mutate business outcome incorrectly
- large results cannot exceed item limits
- partition/index design has no obvious hot-key flaw
- TTL is cleanup, not exact scheduling
- production recovery configuration is appropriate
- tenant isolation is enforced
- relevant failure-path tests pass
- infrastructure matches application assumptions
- zero CRITICAL findings
- zero HIGH findings

Return PASS_WITH_WARNINGS only for MEDIUM/LOW findings.

Return FAIL for any CRITICAL/HIGH finding or required failing check.

Return BLOCKED when correctness cannot be established because a required
business/architecture decision is missing.

---

# 91. Final concurrency question

Before completion, answer internally:

```text
If two independent processes read or modify the same workflow at the same time,
does DynamoDB itself enforce which mutation is legal?
```

If no:

do not return PASS.

---

# 92. Final crash question

Before completion, answer internally:

```text
If the process crashes after any individual DynamoDB, S3, external API, or SQS
operation, can the next process determine durable truth and resume without:

- losing the logical operation,
- duplicating an irreversible side effect,
- corrupting terminal state,
- or returning another tenant/request's result?
```

If no or unknown:

do not return PASS.
