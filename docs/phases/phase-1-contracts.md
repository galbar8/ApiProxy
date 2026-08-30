# Phase 1 — Contracts, configuration and observability

## Scope

- `@workflow/contracts`: domain types, zod schemas for HTTP requests/responses, the SQS message envelope, outbox events, provider responses; error taxonomy (`RETRYABLE` / `NON_RETRYABLE` / `UNKNOWN_EXTERNAL_STATE`); state and step enums.
- `@workflow/config`: a single `config.ts` exporting `configSchema` built over `process.env`, covering every tunable value, with cross-field validation of the timeout ladder.
- `@workflow/observability`: pino-based structured logger with correlation context and redaction, plus EMF metric emission.

## Out of scope

Persistence, messaging, HTTP handlers, workers.

## Acceptance criteria

- Startup config validation rejects a non-increasing timeout ladder, with a test.
- Every boundary schema round-trips in tests, including rejection cases.
- The logger provably redacts credentials; a test asserts an API key never reaches output.
- No `any`.
