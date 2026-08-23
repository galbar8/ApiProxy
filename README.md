# Reliable Sync-over-Async Workflow Service

A synchronous B2B HTTP API over an asynchronous AWS workflow. A caller makes one ordinary
HTTP request; underneath, the work travels through SQS and Lambda workers with DynamoDB as
the only authoritative state. If the workflow reaches a terminal state before the
synchronous deadline, the result comes back on that same request. If it does not, the
caller gets a controlled `202` and the workflow keeps running, recoverable through the
status endpoint.

```text
Axios ─► ALB ─► ECS/Fargate API ─► DynamoDB ─(stream)─► outbox publisher ─► SQS
                      ▲                                                      │
                      └──────────── bounded polling ── DynamoDB ◄─ workers ◄─┘
```

## Start here

| Document                                         | What it is                                    |
| ------------------------------------------------ | --------------------------------------------- |
| [`CLAUDE.md`](CLAUDE.md)                         | Project rules                                 |
| [`docs/architecture.md`](docs/architecture.md)   | How the system fits together and why          |
| [`docs/invariants.md`](docs/invariants.md)       | The correctness rules, each with an ID        |
| [`docs/state-machine.md`](docs/state-machine.md) | Legal states and transitions                  |
| [`docs/DESICION.md`](docs/DESICION.md)           | Accepted decisions, with ADRs in `docs/adr/`  |
| [`docs/PROGRESS.md`](docs/PROGRESS.md)           | Current state, verification results, blockers |

## Running it locally

Requires Node 22, pnpm and Docker.

```bash
pnpm install
pnpm local:up        # DynamoDB Local + ElasticMQ
pnpm test            # unit
pnpm test:integration
pnpm test:e2e
pnpm test:chaos
pnpm test:load
pnpm local:down
```

Unit tests need nothing but Node. The other suites bring the local topology up
automatically if it is not already running.

## Commands

```bash
pnpm lint         pnpm typecheck    pnpm format
pnpm test         pnpm test:integration   pnpm test:e2e
pnpm test:chaos   pnpm test:load
pnpm build        # bundles the API container entrypoint
pnpm cdk:synth    pnpm cdk:diff
```

## Configuration

Every tunable value lives in `packages/config/src/config.ts` as `configSchema`, read from
`process.env` and validated at startup. `.env.example` lists all of them.

The one to know is **`SYNC_WAIT_TIMEOUT_MS`**: how long `POST /v1/process` holds the
connection waiting for a terminal state. Set it comfortably below the timeout of whatever
is calling this service, so a controlled `202` comes back before the caller gives up.
Every other timeout takes its margin from it, and the process refuses to start if the
ladder is not strictly increasing:

```text
SYNC_WAIT_TIMEOUT_MS  <  HTTP_REQUEST_TIMEOUT_MS  <  ALB_IDLE_TIMEOUT_MS
                                                  <  HTTP_KEEP_ALIVE_TIMEOUT_MS
```

## API

| Endpoint                     | Behaviour                                                                                                |
| ---------------------------- | -------------------------------------------------------------------------------------------------------- |
| `POST /v1/process`           | `200` with the terminal result, `202` if the deadline passes first, `409` on an idempotency-key conflict |
| `GET /v1/process/:requestId` | Durable state; the recovery path after any timeout                                                       |
| `GET /health/live`           | Process liveness (stays healthy while draining)                                                          |
| `GET /health/ready`          | Readiness (unhealthy while draining)                                                                     |

Authentication is a per-tenant API key: `Authorization: ApiKey <key>` (see
[ADR-0002](docs/adr/0002-b2b-authentication-api-keys.md)). `Idempotency-Key` is required
on `POST`.

Both terminal outcomes return `200` with an explicit `status` field — a business `FAILED`
is a successful call with a negative answer, not a transport error. See
[ADR-0005](docs/adr/0005-synchronous-response-semantics.md).

## Deployment

**Nothing has been deployed.** The stacks synthesize; they have never been applied to an
AWS account.

```bash
pnpm cdk:synth                       # dev, fully offline
pnpm cdk:synth -c env=production \
  -c certificateArn=<acm-arn> \
  -c availabilityZones=us-east-1a,us-east-1b,us-east-1c
```

Before any deploy: build and push the API image to the stack's ECR repository, then pass
its tag with `-c imageTag=<tag>`, and populate the API key secret out of band. Production
refuses to synthesize without a certificate or without explicit availability zones — an
environment-agnostic stack would silently drop to two AZs.
