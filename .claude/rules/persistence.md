# Rules: packages/persistence

Applies to `packages/persistence/**`.

- Every method is domain-specific. Never add `patch`, `update(requestId, attrs)` or any
  generic writer that can set `status` (INV-22).
- Every write that changes workflow status carries a `ConditionExpression`. A write
  without one is a bug, not a shortcut.
- Terminal writes additionally check `stateVersion`. A `ConditionalCheckFailedException`
  is an expected outcome, handled per `docs/state-machine.md`, never swallowed silently
  and never converted into a generic 500.
- State change + required future publication go in one `TransactWriteItems` with the
  outbox event. Never `await update(...)` then `await send(...)` (INV-43).
- Reads used by the synchronous waiter are exact-key `GetItem` with `ConsistentRead: true`.
  No `Query` and no `Scan` on the synchronous path (INV-53).
- Items are validated on read. A record from an older schema must fail loudly or be
  migrated explicitly, never coerced with `as`.
- Keys are constructed only by the key module. A caller-supplied string never becomes a
  key fragment without validation (INV-74).
