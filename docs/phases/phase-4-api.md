# Phase 4 — ECS API service

## Scope

- Fastify app: `POST /v1/process`, `GET /v1/process/:requestId`, `GET /health/live`, `GET /health/ready`.
- API-key authentication against Secrets Manager with a TTL cache and constant-time comparison.
- Request validation, size caps, idempotency handling, workflow creation, waiter wiring.
- Graceful shutdown: `SIGTERM` marks unready, stops accepting new work, aborts waits, drains in-flight requests, exits.
- Startup configuration validation and structured correlated logs.

## Out of scope

Workers, infrastructure.

## Acceptance criteria

- Tests prove: auth failure modes, tenant isolation (`404` on mismatch), idempotency-key conflict (`409`), oversized payload (`413`), synchronous timeout (`202` with workflow untouched), readiness flips to unhealthy on `SIGTERM`, in-flight requests complete during drain.
