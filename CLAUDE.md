# CLAUDE.md

# Project: Reliable Sync-over-Async Workflow Service

## Mission

Build a production-grade synchronous B2B HTTP API over an asynchronous AWS workflow:

```text
Axios -> ALB -> ECS/Fargate API -> SQS -> Lambda workers -> DynamoDB
                              ^                         |
                              |---- bounded polling ----|
```

If the workflow reaches a terminal state before the synchronous deadline, return the result on the same HTTP request.

Priority: correctness > idempotency > recoverability > observability > scalability > operational simplicity.

## Technology

- Node.js + TypeScript strict mode
- pnpm monorepo
- AWS CDK v2 in TypeScript
- ECS/Fargate + Application Load Balancer
- SQS + Lambda
- DynamoDB
- CloudWatch
- IAM / Secrets Manager / ACM / WAF where required
- Axios for B2B HTTP calls

Do not introduce S3 unless a future accepted architecture decision explicitly requires it.

## Core Invariants

- Every workflow has one immutable `requestId`; every externally retriable logical operation has an `idempotencyKey`.
- The same logical client retry MUST NOT create a duplicate business operation.
- `requestId` MUST propagate through DynamoDB, SQS, logs, traces, and final results.
- DynamoDB is the only authoritative workflow state.
- ECS memory, Promises, HTTP connections, Lambda invocations, and SQS message existence are never authoritative business state.
- SQS/Lambda processing is at-least-once; every worker MUST tolerate duplicate processing.
- Critical DynamoDB transitions MUST use conditional writes or transactions.
- Terminal state MUST NOT be overwritten by late or duplicate workers.
- HTTP timeout/client disconnect MUST NOT automatically mark the business workflow failed.
- External side effects MUST be idempotent, protected by a stable idempotency key, or deterministically reconcilable.
- If an external side effect is neither idempotent nor reconcilable, STOP and classify it as unsafe.
- State change + required future message publication MUST be crash-safe; use the approved transactional-outbox pattern where direct dual-write can strand the workflow.
- Never claim exactly-once business execution because AWS provides FIFO, deduplication, retries, or transactions.

## Workflow State

Default state machine:

```text
PROCESSING -> COMPLETED
PROCESSING -> FAILED
```

`COMPLETED` and `FAILED` are terminal unless an accepted decision changes the model.

Do not use read-check-write in application memory for concurrency control. Enforce expected state/version in DynamoDB.

## HTTP Waiting and Timeouts

HTTP lifecycle and workflow lifecycle are separate.

Use deliberate margins:

```text
business synchronous wait
  < API/server connection budget
  < ALB connection budget
  < recommended client timeout
```

DynamoDB polling MUST be exact-key based, bounded, deadline-aware, configurable, backoff-based, jittered, and strongly consistent when reading the authoritative base-table item for terminal-state visibility.

Do not poll forever or use table scans for synchronization.

## Idempotency and External APIs

Before adding a side effect, classify it:

```text
NATURALLY_IDEMPOTENT | IDEMPOTENCY_PROTECTED | RECONCILABLE | UNSAFE
```

Always model:

```text
remote success -> response lost/local crash -> success not persisted -> retry
```

A retry MUST reuse the same provider idempotency identity or reconcile the remote operation before repeating it.

## AWS Rules

- Production processing queues require DLQ, redrive policy, alarm, and recovery path unless an accepted decision says otherwise.
- Lambda/SQS consumers use partial batch failure reporting where applicable.
- Queue visibility timeout, Lambda timeout, batching, concurrency, and downstream quotas MUST be intentionally aligned.
- Production ECS runs redundantly across multiple AZs.
- ECS handles `SIGTERM`, becomes unready while draining, and stops accepting new requests.
- Business correctness MUST survive forced ECS termination.
- Production authoritative DynamoDB tables require deliberate PITR, deletion-protection, encryption, and removal-policy settings.
- IAM uses least privilege.
- Production infrastructure is managed in CDK; do not depend on undocumented console configuration.
- Critical production failures require observable alarms.

Use project skills for detailed procedures: `reliability-review`, `sqs-worker`, `dynamodb-state`, `aws-review`.

## Security

- Never commit or log secrets, tokens, credentials, or private keys.
- Do not trust tenant identity, workflow status, queue routing, or internal resource identifiers from request payloads.
- `requestId` is correlation, not authorization; workflow/result access MUST verify authenticated tenant ownership.
- Do not invent production authentication; record the accepted B2B authentication decision first.
- Use `.claude/settings.json` permissions/hooks for controls that require enforcement rather than relying only on prose.

## Code Rules

- Use TypeScript strict mode; avoid `any` unless unavoidable and justified.
- Validate HTTP, SQS, environment, persistence, and external-API boundaries at runtime.
- Prefer small testable modules and explicit domain interfaces.
- Do not create generic persistence APIs that bypass workflow invariants.
- Do not add dependencies or AWS services without a concrete need.
- Infrastructure changes belong in AWS CDK v2.

## Persistent Project Memory

Claude MUST read these before significant development work:

- `docs/PROGRESS.md` — actual implementation status, blockers, known issues, and next work.
- `docs/DESICION.md` — accepted/superseded architecture and engineering decisions.

Update `docs/PROGRESS.md` after meaningful implementation, phase, blocker, reliability, test, or deployment-state changes. It MUST reflect repository reality; never mark work complete unless implementation exists and required checks pass.

Update `docs/DESICION.md` when making/changing significant decisions about architecture, AWS services, DynamoDB modeling, state transitions, idempotency, SQS Standard/FIFO, retries, timeouts, polling, outbox behavior, external integrations, authentication, security, deployment, or scaling.

Do not silently rewrite decision history. Mark the previous decision `Superseded` and record the new decision.

## Documentation Responsibilities

```text
CLAUDE.md               always-relevant project rules
docs/invariants.md      detailed correctness invariants
docs/architecture.md    current architecture
docs/state-machine.md   legal workflow states/transitions
docs/DESICION.md        important decisions and rationale
docs/PROGRESS.md        current state, blockers, next work
docs/phases/*           phase scope and acceptance criteria
docs/adr/*              detailed ADRs when needed
.claude/rules/*         topic/path-specific persistent rules
.claude/skills/*        repeatable task-specific workflows/reviews
```

Avoid duplicating long instructions across documents.

## Development Workflow

For every significant task:

1. Read `CLAUDE.md`, `docs/PROGRESS.md`, and `docs/DESICION.md`.
2. Read relevant invariants, architecture, state-machine, ADR, phase, and path-specific rules.
3. Inspect the existing implementation before changing it.
4. Identify affected invariants and existing decisions.
5. Implement only the requested phase/scope.
6. Add/update failure-path tests where relevant.
7. Run relevant formatting, lint, typecheck, tests, and CDK checks.
8. Inspect the final diff.
9. Update `docs/PROGRESS.md` when project state changed.
10. Update `docs/DESICION.md` when an important decision changed.
11. Report unresolved risks and blockers.

Do not opportunistically implement later phases.

If requested work conflicts with a core invariant, STOP, explain the conflict, and propose the required architecture decision.

Never hide failing tests or weaken reliability guarantees just to make a task pass.

## Commands

Use only commands that actually exist in `package.json`.

```bash
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

Update this section if repository scripts differ.

## Completion Gate

Before marking significant work complete, verify:

- implementation matches project invariants
- relevant tests/checks pass
- `docs/PROGRESS.md` reflects reality
- `docs/DESICION.md` reflects important decision changes
- no unresolved CRITICAL/HIGH reliability issue is hidden
- AWS/CDK assumptions match application behavior
- known risks and blockers are reported

A task is not complete merely because the code compiles.
