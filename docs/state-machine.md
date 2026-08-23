# Workflow State Machine

## States

| State        | Terminal | Meaning                                                              |
| ------------ | -------- | -------------------------------------------------------------------- |
| `PROCESSING` | no       | Workflow durably created; asynchronous work is in flight or pending. |
| `COMPLETED`  | yes      | Business operation succeeded. `result` is present.                   |
| `FAILED`     | yes      | Business operation failed deterministically. `errorCode` is present. |

## Legal transitions

```text
                 (create, conditional on attribute_not_exists)
                                   |
                                   v
                            +--------------+
                            |  PROCESSING  |
                            +--------------+
                              |          |
      completeIfProcessing    |          |   failIfProcessing
   (cond: status = PROCESSING)|          | (cond: status = PROCESSING)
                              v          v
                     +-------------+  +----------+
                     | COMPLETED   |  |  FAILED  |
                     +-------------+  +----------+
                          (terminal)     (terminal)
```

Every other transition is illegal, including `COMPLETED -> FAILED`,
`COMPLETED -> PROCESSING`, `FAILED -> COMPLETED`, `FAILED -> PROCESSING` and any
terminal-to-same-terminal rewrite with different content.

## Enforcement

Terminal writes are `UpdateItem` calls carrying:

```text
ConditionExpression: attribute_exists(pk) AND #status = :processing AND stateVersion = :expected
```

A `ConditionalCheckFailedException` is **not** an error path in the usual sense. It is
the expected outcome of a duplicate or late worker and is handled as follows:

1. Re-read the item with a strongly consistent read.
2. If it is already terminal and the terminal content matches this worker's intent,
   treat the operation as successfully idempotent and return success.
3. If it is already terminal with different content, log a `terminal_conflict` event,
   emit a metric, keep the existing terminal state and return success so the message is
   deleted rather than looping forever. The existing state wins (INV-21).
4. If it is still `PROCESSING` the condition failed on `stateVersion`; retry the read
   and re-evaluate, bounded by the attempt budget.

## Step state

Step progress lives in separate `STEP#<stepId>` items and is not part of the workflow
status. Step records exist so a duplicated worker invocation can recognise its own prior
work (INV-34). Step state never overrides workflow terminal state.

```text
STEP: PENDING -> IN_PROGRESS -> SUCCEEDED
                            \-> FAILED
                            \-> UNKNOWN_EXTERNAL_STATE  (requires reconciliation)
```

`UNKNOWN_EXTERNAL_STATE` is deliberately not a workflow state. It is a step-level fact
that forces the next attempt to reconcile before acting (INV-62).

## What does not change state

The following never cause a transition:

- synchronous HTTP deadline expiry
- client disconnect / `ECONNRESET`
- ALB idle timeout
- ECS `SIGTERM` or forced task termination
- SQS visibility timeout expiry
- Lambda timeout

Those are transport and compute events, not business outcomes (INV-50, INV-51).
