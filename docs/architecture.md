# Architecture

## Purpose

A synchronous B2B HTTP API over an asynchronous AWS workflow. If the workflow reaches a
terminal state before the synchronous deadline, the result is returned on the same HTTP
request. If it does not, the caller receives a controlled `202` and the workflow keeps
running, recoverable through the status endpoint.

## Component view

```text
Axios client
    |  POST /v1/process           (Authorization: ApiKey <key>, Idempotency-Key: <key>)
    v
Application Load Balancer         idle timeout 30s, deregistration delay 30s
    |
    v
ECS/Fargate API (Fastify, >= 2 AZ)
    |
    |  1. authenticate -> tenantId
    |  2. validate payload -> payloadHash
    |  3. TransactWriteItems:
    |       Put IDEM#<tenant>#<key>   (cond: attribute_not_exists)
    |       Put REQ#<requestId> WORKFLOW (cond: attribute_not_exists)
    |       Put REQ#<requestId> OUTBOX#<eventId>  -> destination START_QUEUE
    |  4. bounded, jittered, strongly-consistent polling until syncDeadlineAt
    v
DynamoDB WorkflowTable  (authoritative state)
    |
    |  NEW_AND_OLD_IMAGES stream
    v
outbox-publisher (Lambda)  --publishes--> SQS start-queue --> worker-a (Lambda)
                                                                  |
                                              TransactWriteItems: |
                                                STEP#enrich = SUCCEEDED
                                                OUTBOX#<eventId> -> STEP_QUEUE
                                                                  |
                           <---- stream ----  DynamoDB  <---------+
                                                  |
    outbox-publisher --publishes--> SQS step-queue --> finalizer (Lambda)
                                                          |
                                       external provider call (Idempotency-Key)
                                                          |
                                       conditional terminal write COMPLETED/FAILED
                                                          |
                                                       DynamoDB
                                                          ^
                                                          | strongly consistent GetItem
                                                    API polling loop
                                                          |
                                                     HTTP response

EventBridge (every 5 min) --> reconciler (Lambda)
    - republishes outbox events still unpublished past a threshold (sparse GSI1)
    - reports workflows still PROCESSING past their business deadline (sparse GSI2)
```

There is no direct `write DynamoDB, then send SQS` anywhere on the workflow path. Every
publication is a consequence of a committed DynamoDB transaction (INV-43).

## Why the outbox, concretely

The API could call `sqs.sendMessage` right after creating the workflow. If the task is
killed between those two calls, a `PROCESSING` workflow exists that nothing will ever
advance — a stranded workflow that only a human would notice. Writing the outbox event
inside the same transaction makes "the workflow exists" and "the work will be published"
one atomic fact. The publisher is driven by the table's own stream, so it runs even if
the ECS task that created the workflow is already gone.

Duplicate publication is expected and safe: outbox `eventId` is
`sha256(requestId|step|workflowVersion)`, so replays produce the same message identity,
and every consumer is idempotent on `requestId + stepId` (INV-34, INV-44).

## Queues and workers

| Queue         | Consumer       | Purpose                                              |
| ------------- | -------------- | ---------------------------------------------------- |
| `start-queue` | `worker-a`     | First step: validate/enrich the accepted request.    |
| `step-queue`  | `finalizer`    | External side effect, then the terminal state write. |
| `*-dlq`       | none (alarmed) | Poison messages, retained for redrive.               |

Both queues are SQS **Standard** (ADR-0003). Ordering is not relied upon: the current
step is explicit in the message envelope and in the step records, and terminal writes are
conditional, so an out-of-order or replayed message cannot corrupt state.

## Data model

Single table, `pk`/`sk`:

| Item        | pk                                 | sk                 | Notes                                                                                          |
| ----------- | ---------------------------------- | ------------------ | ---------------------------------------------------------------------------------------------- |
| Workflow    | `REQ#<requestId>`                  | `WORKFLOW`         | Authoritative status, `stateVersion`, `tenantId`, `payloadHash`, result/error, deadlines, TTL. |
| Idempotency | `IDEM#<tenantId>#<idempotencyKey>` | `IDEM`             | Maps a caller operation to one `requestId`; stores `payloadHash` for conflict detection.       |
| Step        | `REQ#<requestId>`                  | `STEP#<stepId>`    | Durable per-step dedup, attempt count, external reference.                                     |
| Outbox      | `REQ#<requestId>`                  | `OUTBOX#<eventId>` | Deterministic event identity, destination, payload, `publishedAt`.                             |

Indexes:

- `GSI1` sparse — unpublished outbox events (`gsi1pk` present only while unpublished).
- `GSI2` sparse — workflows in `PROCESSING` (`gsi2pk` removed on terminal write).

Both are sparse so they stay small: a healthy system has an almost empty GSI1 and a GSI2
proportional to genuine in-flight work, not to total history.

## Timeout ladder

```text
sync wait            20s   SYNC_WAIT_TIMEOUT_MS      the business synchronous budget
ECS request budget   22s   HTTP_REQUEST_TIMEOUT_MS   server-side hard stop
ALB idle timeout     30s   (CDK)
Node keepAliveTimeout 35s  HTTP_KEEP_ALIVE_TIMEOUT_MS  must exceed ALB idle to avoid 502
client timeout       35s   documented for callers
```

`SYNC_WAIT_TIMEOUT_MS` is the single knob that aligns this service with a caller's own
timeout. It is read from the environment and validated at startup against the other
values, so a misconfigured ladder fails the process instead of producing 502s under load.

## Trust boundaries

- Caller input: validated by schema, size-capped, never used as a DynamoDB key or queue
  target.
- Tenant identity: only from the authenticated API key (ADR-0002), never from the body.
- SQS messages: schema-validated at runtime before use, even though the producer is us.
- Environment: schema-validated at startup; missing required production config is fatal.
- Provider responses: schema-validated before being persisted as a business result.

## Deployment profiles

Two axes, deliberately independent: `-c env` decides capacity and data protection,
`-c profile` decides how much of the optional infrastructure is deployed (D-035).

|                              | `standard`                     | `minimal`                 |
| ---------------------------- | ------------------------------ | ------------------------- |
| Web ACL on the load balancer | yes                            | no                        |
| Interface VPC endpoints      | 5                              | 0                         |
| Task placement               | isolated subnets, no public IP | public subnets, public IP |
| Container insights           | on                             | off                       |
| Everything else              | —                              | identical                 |

Nothing on the correctness path moves. The state machine, conditional writes, the outbox,
every queue, every DLQ, every redrive policy and all seventeen alarms are the same in both:
cost is not a reason to run a queue whose failures nobody sees (INV-45).

What does move is the network path. Removing the interface endpoints removes the only route
an isolated subnet has to ECR, Secrets Manager and CloudWatch Logs, so the tasks move to
public subnets and reach those services over the internet gateway instead (D-036). Ingress
is unchanged in both profiles — the task security group admits the load balancer's
security group on 8080 and nothing else — but egress genuinely leaves the VPC under
`minimal`, which is why `applyProfile` refuses it for anything but `dev`.

There is no NAT gateway in either profile, and the free gateway endpoints for DynamoDB and
S3 stay in both, so DynamoDB traffic and ECR image layers never take a public path
regardless.
