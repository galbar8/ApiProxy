# ADR-0007: Timeout ladder and bounded polling strategy

- **Status:** Accepted
- **Date:** 2026-08-22
- **Invariants:** INV-53, INV-54

## Context

Four independent timeouts sit on the synchronous path: the business wait, the ECS request
budget, the ALB idle timeout and the caller's own client timeout. If any two are equal, a
race decides which fires first, and the caller gets a `502` or a connection reset instead
of the controlled `202` the design promises.

Separately, the polling loop is the only mechanism turning asynchronous completion into a
synchronous response. Done naively it becomes a DynamoDB load generator: N in-flight
requests polling every 50 ms with strongly consistent reads, all synchronised.

## Decision

### Ladder

```text
SYNC_WAIT_TIMEOUT_MS        20000   business synchronous wait      <-- the alignment knob
HTTP_REQUEST_TIMEOUT_MS     22000   ECS per-request hard stop
ALB idle timeout            30000   (CDK)
HTTP_KEEP_ALIVE_TIMEOUT_MS  35000   must exceed ALB idle
documented client timeout   35000
```

`SYNC_WAIT_TIMEOUT_MS` is the value operators tune to match the timeout of the API
calling _us_: it must be comfortably below the caller's own timeout so we return a
controlled `202` before the caller gives up. Every other value derives its safety margin
from it, and `config.ts` **validates the ordering at startup** — a ladder that is not
strictly increasing is a fatal configuration error, not a runtime surprise.

`HTTP_KEEP_ALIVE_TIMEOUT_MS` exceeding the ALB idle timeout is the documented fix for the
ALB/Node 502 race: the ALB must be the side that closes an idle keep-alive connection.

### Polling

`WorkflowWaiter` is an interface; HTTP handlers never implement polling mechanics.

- Exact-key `GetItem` on `REQ#<requestId>` / `WORKFLOW`. Never a Query, never a Scan.
- `ConsistentRead: true` — an eventually consistent read can miss a terminal write that
  already happened, which would turn a completed workflow into a `202` for no reason.
- Absolute deadline (`deadlineAt`), computed once from `SYNC_WAIT_TIMEOUT_MS`. Every
  sleep is clamped so no attempt can overrun the deadline.
- Progressive backoff: `POLL_INITIAL_DELAY_MS` (50) × `POLL_BACKOFF_FACTOR` (1.6), capped
  at `POLL_MAX_DELAY_MS` (1000).
- Jitter: ±`POLL_JITTER_RATIO` (0.2) applied to each delay, so concurrent waiters
  desynchronise instead of stampeding.
- Abortable: an `AbortSignal` from client disconnect or `SIGTERM` ends the wait
  immediately. Aborting has no effect on workflow state.
- The clock is injected, so deadline behaviour is tested deterministically instead of by
  sleeping in tests.

## Consequences

- Worst case reads per request are bounded and computable from the config, which is what
  makes the DynamoDB read-capacity model predictable.
- A first poll at 50 ms means fast workflows still return quickly; the cap at 1 s means a
  20 s wait costs roughly 25 reads, not 400.
- Because the deadline is absolute, a slow read cannot push the response past the ECS
  budget.
