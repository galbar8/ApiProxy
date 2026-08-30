import {
  DeleteCommand,
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
  type DynamoDBDocumentClient,
} from "@aws-sdk/lib-dynamodb";
import {
  CURRENT_WORKFLOW_VERSION,
  ERROR_CODES,
  NonRetryableError,
  RetryableError,
  type Clock,
  type EventId,
  type IdempotencyKey,
  type OutboxDestination,
  type OutboxEvent,
  type RequestId,
  type StepId,
  type StepRecord,
  type StepStatus,
  type TenantId,
  type WorkflowError,
  type WorkflowMessage,
  type WorkflowRecord,
} from "@workflow/contracts";
import { deriveEventId } from "@workflow/idempotency";
import {
  classifyDynamoError,
  conditionFailedAt,
  isConditionalCheckFailed,
  readTransactionOutcome,
} from "./errors.js";
import {
  ITEM_TYPES,
  decodeIdempotency,
  decodeOutbox,
  decodeStep,
  decodeWorkflow,
  ttlSecondsFromNow,
} from "./items.js";
import {
  GSI1_NAME,
  GSI2_NAME,
  chronoBoundary,
  idempotencyKeyItem,
  outboxKey,
  pendingOutboxIndexKeys,
  pendingOutboxShardKeys,
  processingIndexKeys,
  processingShardKeys,
  stepKey,
  workflowKey,
} from "./keys.js";

export interface WorkflowRepositoryOptions {
  readonly client: DynamoDBDocumentClient;
  readonly tableName: string;
  readonly clock: Clock;
  readonly workflowTtlDays: number;
  readonly outboxTtlDays: number;
}

export interface CreateWorkflowInput {
  readonly requestId: RequestId;
  readonly tenantId: TenantId;
  readonly idempotencyKey: IdempotencyKey;
  readonly payloadHash: string;
  readonly input: unknown;
  readonly syncDeadlineAt: number;
  readonly businessDeadlineAt: number;
}

export type CreateWorkflowResult =
  | { readonly outcome: "CREATED"; readonly workflow: WorkflowRecord }
  | { readonly outcome: "EXISTING"; readonly workflow: WorkflowRecord }
  | {
      readonly outcome: "CONFLICT";
      readonly existingRequestId: RequestId;
      readonly existingPayloadHash: string;
    };

export type TerminalWriteResult =
  | { readonly outcome: "APPLIED"; readonly workflow: WorkflowRecord }
  | { readonly outcome: "ALREADY_TERMINAL"; readonly workflow: WorkflowRecord }
  | { readonly outcome: "MISSING" };

export type AdvanceStepResult =
  | { readonly outcome: "ADVANCED" }
  | { readonly outcome: "ALREADY_ADVANCED" }
  | { readonly outcome: "WORKFLOW_TERMINAL" }
  | { readonly outcome: "WORKFLOW_MISSING" };

export interface StaleWorkflowRef {
  readonly requestId: RequestId;
  readonly deadlineAt: number;
}

export type BeginStepResult =
  | { readonly outcome: "STARTED"; readonly step: StepRecord }
  | {
      readonly outcome: "RESUMED";
      readonly step: StepRecord;
      readonly previous: StepStatus;
    }
  | { readonly outcome: "ALREADY_SUCCEEDED"; readonly step: StepRecord };

/**
 * The only way workflow state is read or written.
 *
 * Every method is a named business transition. There is deliberately no `patch` and no
 * `update(requestId, attributes)`: a generic writer makes bypassing the state machine a
 * one-liner, and the state machine is the product (INV-22).
 */
export class WorkflowRepository {
  readonly #client: DynamoDBDocumentClient;
  readonly #table: string;
  readonly #clock: Clock;
  readonly #workflowTtlDays: number;
  readonly #outboxTtlDays: number;

  constructor(options: WorkflowRepositoryOptions) {
    this.#client = options.client;
    this.#table = options.tableName;
    this.#clock = options.clock;
    this.#workflowTtlDays = options.workflowTtlDays;
    this.#outboxTtlDays = options.outboxTtlDays;
  }

  // ---------------------------------------------------------------------------
  // Creation
  // ---------------------------------------------------------------------------

  /**
   * Creates the workflow, its idempotency mapping and the first outbox event as one
   * atomic fact (INV-33, INV-43).
   *
   * Neither "mapping without workflow" nor "workflow that nothing will ever publish" is
   * a reachable state, which is what makes a client retry safe and a crashed API task
   * harmless.
   */
  async createWorkflow(input: CreateWorkflowInput): Promise<CreateWorkflowResult> {
    const now = this.#clock.now();
    const expiresAt = ttlSecondsFromNow(now, this.#workflowTtlDays);
    const eventId = deriveEventId(input.requestId, "ENRICH", CURRENT_WORKFLOW_VERSION);

    const workflow = {
      ...workflowKey(input.requestId),
      itemType: ITEM_TYPES.workflow,
      requestId: input.requestId,
      tenantId: input.tenantId,
      idempotencyKey: input.idempotencyKey,
      status: "PROCESSING" as const,
      workflowVersion: CURRENT_WORKFLOW_VERSION,
      stateVersion: 0,
      payloadHash: input.payloadHash,
      input: input.input,
      createdAt: now,
      updatedAt: now,
      syncDeadlineAt: input.syncDeadlineAt,
      businessDeadlineAt: input.businessDeadlineAt,
      expiresAt,
      ...processingIndexKeys(input.requestId, input.businessDeadlineAt),
    };

    const message: WorkflowMessage = {
      messageId: eventId as EventId,
      requestId: input.requestId,
      tenantId: input.tenantId,
      workflowVersion: CURRENT_WORKFLOW_VERSION,
      createdAt: now,
      step: "ENRICH",
      payload: {},
    };

    const outbox = {
      ...outboxKey(input.requestId, eventId),
      itemType: ITEM_TYPES.outbox,
      eventId,
      requestId: input.requestId,
      destination: "START_QUEUE" satisfies OutboxDestination,
      message,
      createdAt: now,
      expiresAt: ttlSecondsFromNow(now, this.#outboxTtlDays),
      ...pendingOutboxIndexKeys(input.requestId, eventId, now),
    };

    const idempotency = {
      ...idempotencyKeyItem(input.tenantId, input.idempotencyKey),
      itemType: ITEM_TYPES.idempotency,
      tenantId: input.tenantId,
      idempotencyKey: input.idempotencyKey,
      requestId: input.requestId,
      payloadHash: input.payloadHash,
      createdAt: now,
      // Deliberately the same TTL as the workflow: a mapping must never outlive the
      // workflow it points at, or a late retry would resolve to a vanished record.
      expiresAt,
    };

    try {
      await this.#client.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Put: {
                TableName: this.#table,
                Item: idempotency,
                ConditionExpression: "attribute_not_exists(pk)",
              },
            },
            {
              Put: {
                TableName: this.#table,
                Item: workflow,
                ConditionExpression: "attribute_not_exists(pk)",
              },
            },
            {
              Put: {
                TableName: this.#table,
                Item: outbox,
                ConditionExpression: "attribute_not_exists(sk)",
              },
            },
          ],
        }),
      );
      return { outcome: "CREATED", workflow: decodeWorkflow(workflow) };
    } catch (error) {
      // Position 0 is the idempotency mapping: a failure there means this logical
      // operation already exists. Any other cancellation is a real fault.
      if (!conditionFailedAt(error, 0)) {
        throw classifyDynamoError(error);
      }
      return await this.#resolveExistingWorkflow(input);
    }
  }

  async #resolveExistingWorkflow(
    input: CreateWorkflowInput,
  ): Promise<CreateWorkflowResult> {
    const existing = await this.#client.send(
      new GetCommand({
        TableName: this.#table,
        Key: idempotencyKeyItem(input.tenantId, input.idempotencyKey),
        ConsistentRead: true,
      }),
    );

    if (existing.Item === undefined) {
      // The mapping existed a moment ago and is gone now: a TTL deletion racing a retry.
      // Retryable rather than an error, because a fresh attempt will simply create it.
      throw new RetryableError(
        ERROR_CODES.STATE_CONFLICT,
        "idempotency mapping disappeared between conflict and read",
      );
    }

    const mapping = decodeIdempotency(existing.Item);

    if (mapping.payloadHash !== input.payloadHash) {
      return {
        outcome: "CONFLICT",
        existingRequestId: mapping.requestId as RequestId,
        existingPayloadHash: mapping.payloadHash,
      };
    }

    const workflow = await this.getWorkflow(mapping.requestId as RequestId);
    if (workflow === undefined) {
      throw new RetryableError(
        ERROR_CODES.WORKFLOW_MISSING,
        `idempotency mapping points at missing workflow ${mapping.requestId}`,
      );
    }
    return { outcome: "EXISTING", workflow };
  }

  // ---------------------------------------------------------------------------
  // Reads
  // ---------------------------------------------------------------------------

  /**
   * Exact-key, strongly consistent read of the authoritative item. Strong consistency is
   * required: an eventually consistent read can miss a terminal write that has already
   * happened, turning a completed workflow into a needless 202 (INV-53).
   */
  async getWorkflow(requestId: RequestId): Promise<WorkflowRecord | undefined> {
    try {
      const result = await this.#client.send(
        new GetCommand({
          TableName: this.#table,
          Key: workflowKey(requestId),
          ConsistentRead: true,
        }),
      );
      return result.Item === undefined ? undefined : decodeWorkflow(result.Item);
    } catch (error) {
      throw classifyDynamoError(error);
    }
  }

  /**
   * The only read exposed to HTTP handlers. Ownership is verified here so a handler
   * cannot forget to, and a mismatch is indistinguishable from a missing workflow, so
   * `requestId` cannot be used to probe for existence (INV-71, INV-72).
   */
  async getWorkflowForTenant(
    requestId: RequestId,
    tenantId: TenantId,
  ): Promise<WorkflowRecord | undefined> {
    const workflow = await this.getWorkflow(requestId);
    if (workflow === undefined) return undefined;
    return workflow.tenantId === tenantId ? workflow : undefined;
  }

  async getStep(requestId: RequestId, stepId: StepId): Promise<StepRecord | undefined> {
    try {
      const result = await this.#client.send(
        new GetCommand({
          TableName: this.#table,
          Key: stepKey(requestId, stepId),
          ConsistentRead: true,
        }),
      );
      return result.Item === undefined ? undefined : decodeStep(result.Item);
    } catch (error) {
      throw classifyDynamoError(error);
    }
  }

  async getOutboxEvent(
    requestId: RequestId,
    eventId: EventId,
  ): Promise<OutboxEvent | undefined> {
    try {
      const result = await this.#client.send(
        new GetCommand({
          TableName: this.#table,
          Key: outboxKey(requestId, eventId),
          ConsistentRead: true,
        }),
      );
      return result.Item === undefined ? undefined : decodeOutbox(result.Item);
    } catch (error) {
      throw classifyDynamoError(error);
    }
  }

  // ---------------------------------------------------------------------------
  // Step progression
  // ---------------------------------------------------------------------------

  /**
   * Claims a step for this attempt. A duplicate delivery of an already-succeeded step
   * returns ALREADY_SUCCEEDED and does no work, which is where worker idempotency
   * actually lives (INV-34).
   *
   * `externalRef` is written on first claim, before any external call, so a retry after
   * an ambiguous outcome reuses the same provider identity (INV-63).
   */
  async beginStep(
    requestId: RequestId,
    stepId: StepId,
    externalRef?: string,
  ): Promise<BeginStepResult> {
    const now = this.#clock.now();
    try {
      const result = await this.#client.send(
        new UpdateCommand({
          TableName: this.#table,
          Key: stepKey(requestId, stepId),
          UpdateExpression:
            "SET itemType = :itemType, requestId = :requestId, stepId = :stepId, " +
            "#status = :inProgress, updatedAt = :now, " +
            "createdAt = if_not_exists(createdAt, :now), " +
            "expiresAt = if_not_exists(expiresAt, :expiresAt)" +
            (externalRef === undefined
              ? ""
              : ", externalRef = if_not_exists(externalRef, :externalRef)") +
            " ADD attempt :one",
          ConditionExpression: "attribute_not_exists(sk) OR #status <> :succeeded",
          ExpressionAttributeNames: { "#status": "status" },
          ExpressionAttributeValues: {
            ":itemType": ITEM_TYPES.step,
            ":requestId": requestId,
            ":stepId": stepId,
            ":inProgress": "IN_PROGRESS",
            ":succeeded": "SUCCEEDED",
            ":now": now,
            ":one": 1,
            ":expiresAt": ttlSecondsFromNow(now, this.#workflowTtlDays),
            ...(externalRef === undefined ? {} : { ":externalRef": externalRef }),
          },
          // ALL_OLD, not ALL_NEW. This update sets `status` to IN_PROGRESS, so ALL_NEW
          // reports IN_PROGRESS as the "previous" status on every single claim and the
          // UNKNOWN_EXTERNAL_STATE marker written by a prior ambiguous attempt can never
          // be observed. Reconciliation does not depend on it — the finalizer reconciles
          // on any RESUMED claim, which is strictly stronger — but a marker that cannot be
          // read is not evidence of anything, and INV-62 names it as the mechanism.
          ReturnValues: "ALL_OLD",
        }),
      );

      // Both branches rebuild the post-update item from values that are fully known here,
      // then run it through `decodeStep`. That brands the ids and, more usefully, makes a
      // mistake in this reconstruction fail loudly instead of flowing on as a plausible
      // but wrong StepRecord.

      // Nothing existed before: this claim created the item.
      if (result.Attributes === undefined) {
        return {
          outcome: "STARTED",
          step: decodeStep({
            requestId,
            stepId,
            status: "IN_PROGRESS",
            attempt: 1,
            createdAt: now,
            updatedAt: now,
            expiresAt: ttlSecondsFromNow(now, this.#workflowTtlDays),
            ...(externalRef === undefined ? {} : { externalRef }),
          }),
        };
      }

      // The item existed, so this is a resumption: the prior status is the one thing
      // ALL_NEW could never report, and it is exactly what INV-62 cares about.
      const priorStep = decodeStep(result.Attributes);
      const step: StepRecord = decodeStep({
        ...priorStep,
        status: "IN_PROGRESS",
        attempt: priorStep.attempt + 1,
        updatedAt: now,
        // `externalRef` is written with `if_not_exists`, so an existing one wins.
        ...(externalRef === undefined || priorStep.externalRef !== undefined
          ? {}
          : { externalRef }),
      });
      return { outcome: "RESUMED", step, previous: priorStep.status };
    } catch (error) {
      if (!isConditionalCheckFailed(error)) {
        throw classifyDynamoError(error);
      }
      const step = await this.getStep(requestId, stepId);
      if (step === undefined) {
        throw new RetryableError(
          ERROR_CODES.STATE_CONFLICT,
          "step claim failed but no step record exists",
        );
      }
      return { outcome: "ALREADY_SUCCEEDED", step };
    }
  }

  /** Records an ambiguous external outcome so the next attempt reconciles (INV-62). */
  async markStepUnknownExternalState(
    requestId: RequestId,
    stepId: StepId,
  ): Promise<void> {
    try {
      await this.#client.send(
        new UpdateCommand({
          TableName: this.#table,
          Key: stepKey(requestId, stepId),
          UpdateExpression: "SET #status = :unknown, updatedAt = :now",
          ConditionExpression: "attribute_exists(sk) AND #status <> :succeeded",
          ExpressionAttributeNames: { "#status": "status" },
          ExpressionAttributeValues: {
            ":unknown": "UNKNOWN_EXTERNAL_STATE",
            ":succeeded": "SUCCEEDED",
            ":now": this.#clock.now(),
          },
        }),
      );
    } catch (error) {
      // Losing this race means the step already succeeded, which needs no marking.
      if (isConditionalCheckFailed(error)) return;
      throw classifyDynamoError(error);
    }
  }

  /**
   * Commits step completion and the next step's outbox event in one transaction. This is
   * the crash window the outbox exists to close: after this returns, publication is
   * guaranteed to happen eventually even if this process dies immediately (INV-43).
   */
  async advanceStepWithOutbox(params: {
    readonly requestId: RequestId;
    readonly tenantId: TenantId;
    readonly stepId: StepId;
    readonly stepResult: unknown;
    readonly nextStep: StepId;
    readonly destination: OutboxDestination;
    readonly nextPayload: WorkflowMessage["payload"];
  }): Promise<AdvanceStepResult> {
    const now = this.#clock.now();
    const eventId = deriveEventId(
      params.requestId,
      params.nextStep,
      CURRENT_WORKFLOW_VERSION,
    );

    const message = {
      messageId: eventId,
      requestId: params.requestId,
      tenantId: params.tenantId,
      workflowVersion: CURRENT_WORKFLOW_VERSION,
      createdAt: now,
      step: params.nextStep,
      payload: params.nextPayload,
    };

    try {
      await this.#client.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              // The workflow must still be in flight. A late duplicate arriving after
              // finalisation must not resurrect the pipeline (INV-21).
              ConditionCheck: {
                TableName: this.#table,
                Key: workflowKey(params.requestId),
                ConditionExpression: "attribute_exists(pk) AND #status = :processing",
                ExpressionAttributeNames: { "#status": "status" },
                ExpressionAttributeValues: { ":processing": "PROCESSING" },
              },
            },
            {
              Update: {
                TableName: this.#table,
                Key: stepKey(params.requestId, params.stepId),
                UpdateExpression:
                  "SET #status = :succeeded, updatedAt = :now, externalResult = :result",
                ConditionExpression: "#status <> :succeeded",
                ExpressionAttributeNames: { "#status": "status" },
                ExpressionAttributeValues: {
                  ":succeeded": "SUCCEEDED",
                  ":now": now,
                  ":result": params.stepResult,
                },
              },
            },
            {
              Put: {
                TableName: this.#table,
                Item: {
                  ...outboxKey(params.requestId, eventId),
                  itemType: ITEM_TYPES.outbox,
                  eventId,
                  requestId: params.requestId,
                  destination: params.destination,
                  message,
                  createdAt: now,
                  expiresAt: ttlSecondsFromNow(now, this.#outboxTtlDays),
                  ...pendingOutboxIndexKeys(params.requestId, eventId, now),
                },
                ConditionExpression: "attribute_not_exists(sk)",
              },
            },
          ],
        }),
      );
      return { outcome: "ADVANCED" };
    } catch (error) {
      const outcome = readTransactionOutcome(error);
      if (!outcome.cancelled) {
        throw classifyDynamoError(error);
      }
      if (outcome.reasons[0] === "ConditionalCheckFailed") {
        const workflow = await this.getWorkflow(params.requestId);
        return workflow === undefined
          ? { outcome: "WORKFLOW_MISSING" }
          : { outcome: "WORKFLOW_TERMINAL" };
      }
      if (
        outcome.reasons[1] === "ConditionalCheckFailed" ||
        outcome.reasons[2] === "ConditionalCheckFailed"
      ) {
        // The step already succeeded, or the event already exists: a duplicate delivery
        // arrived. Both are the same fact — this work is already done.
        return { outcome: "ALREADY_ADVANCED" };
      }
      throw classifyDynamoError(error);
    }
  }

  // ---------------------------------------------------------------------------
  // Terminal transitions
  // ---------------------------------------------------------------------------

  async completeIfProcessing(params: {
    readonly requestId: RequestId;
    readonly stepId: StepId;
    readonly result: unknown;
  }): Promise<TerminalWriteResult> {
    return await this.#writeTerminal({
      requestId: params.requestId,
      stepId: params.stepId,
      status: "COMPLETED",
      result: params.result,
    });
  }

  async failIfProcessing(params: {
    readonly requestId: RequestId;
    readonly stepId: StepId;
    readonly error: WorkflowError;
  }): Promise<TerminalWriteResult> {
    return await this.#writeTerminal({
      requestId: params.requestId,
      stepId: params.stepId,
      status: "FAILED",
      error: params.error,
    });
  }

  /**
   * The single write that makes a workflow terminal.
   *
   * The condition — not a preceding read — is what enforces terminal immutability. Two
   * workers racing to finish the same workflow both issue this update; DynamoDB picks
   * one, and the loser is told so rather than overwriting the winner (INV-21, INV-22).
   */
  async #writeTerminal(params: {
    readonly requestId: RequestId;
    readonly stepId: StepId;
    readonly status: "COMPLETED" | "FAILED";
    readonly result?: unknown;
    readonly error?: WorkflowError;
  }): Promise<TerminalWriteResult> {
    const now = this.#clock.now();
    const setResult = params.status === "COMPLETED" ? ", #result = :result" : "";
    const setError = params.status === "FAILED" ? ", #error = :error" : "";

    try {
      await this.#client.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Update: {
                TableName: this.#table,
                Key: workflowKey(params.requestId),
                UpdateExpression:
                  `SET #status = :status, updatedAt = :now, stateVersion = stateVersion + :one${setResult}${setError} ` +
                  "REMOVE gsi2pk, gsi2sk",
                ConditionExpression: "attribute_exists(pk) AND #status = :processing",
                ExpressionAttributeNames: {
                  "#status": "status",
                  ...(params.status === "COMPLETED" ? { "#result": "result" } : {}),
                  ...(params.status === "FAILED" ? { "#error": "error" } : {}),
                },
                ExpressionAttributeValues: {
                  ":status": params.status,
                  ":processing": "PROCESSING",
                  ":now": now,
                  ":one": 1,
                  ...(params.status === "COMPLETED"
                    ? { ":result": params.result }
                    : {}),
                  ...(params.status === "FAILED" ? { ":error": params.error } : {}),
                },
              },
            },
            {
              // A step can be failed before it was ever claimed: a stored input that
              // fails validation is rejected before `beginStep` runs. `UpdateItem`
              // upserts, so the identifying fields are backfilled here — without them the
              // created item would fail `stepRecordSchema` on every later read. They are
              // `if_not_exists` writes, so a real claim's `createdAt`, `attempt` and TTL
              // survive untouched. A `ConditionExpression` is deliberately absent: this
              // item shares a transaction with the workflow's terminal write, and failing
              // it would strand the workflow in PROCESSING rather than protect anything.
              Update: {
                TableName: this.#table,
                Key: stepKey(params.requestId, params.stepId),
                UpdateExpression:
                  "SET #status = :stepStatus, updatedAt = :now, " +
                  "itemType = :itemType, requestId = :requestId, stepId = :stepId, " +
                  "createdAt = if_not_exists(createdAt, :now), " +
                  "attempt = if_not_exists(attempt, :zero), " +
                  "expiresAt = if_not_exists(expiresAt, :expiresAt)",
                ExpressionAttributeNames: { "#status": "status" },
                ExpressionAttributeValues: {
                  ":stepStatus": params.status === "COMPLETED" ? "SUCCEEDED" : "FAILED",
                  ":now": now,
                  ":itemType": ITEM_TYPES.step,
                  ":requestId": params.requestId,
                  ":stepId": params.stepId,
                  ":zero": 0,
                  ":expiresAt": ttlSecondsFromNow(now, this.#workflowTtlDays),
                },
              },
            },
          ],
        }),
      );

      const workflow = await this.getWorkflow(params.requestId);
      if (workflow === undefined) {
        throw new RetryableError(
          ERROR_CODES.WORKFLOW_MISSING,
          "workflow vanished immediately after a terminal write",
        );
      }
      return { outcome: "APPLIED", workflow };
    } catch (error) {
      if (!conditionFailedAt(error, 0)) {
        throw classifyDynamoError(error);
      }
      const workflow = await this.getWorkflow(params.requestId);
      if (workflow === undefined) {
        return { outcome: "MISSING" };
      }
      return { outcome: "ALREADY_TERMINAL", workflow };
    }
  }

  // ---------------------------------------------------------------------------
  // Outbox
  // ---------------------------------------------------------------------------

  /**
   * Marks an event published and drops it out of the sparse pending index.
   *
   * This is a progress marker, not the duplicate protection: publication is at-least-once
   * and consumers deduplicate on requestId + stepId (ADR-0004).
   */
  async markOutboxPublished(requestId: RequestId, eventId: EventId): Promise<void> {
    try {
      await this.#client.send(
        new UpdateCommand({
          TableName: this.#table,
          Key: outboxKey(requestId, eventId),
          UpdateExpression: "SET publishedAt = :now REMOVE gsi1pk, gsi1sk",
          ConditionExpression: "attribute_exists(sk)",
          ExpressionAttributeValues: { ":now": this.#clock.now() },
        }),
      );
    } catch (error) {
      if (isConditionalCheckFailed(error)) return;
      throw classifyDynamoError(error);
    }
  }

  /**
   * Outbox events still unpublished after `staleAfterMs`. Queries every shard of the
   * sparse index; in a healthy system this returns nothing.
   */
  async listPendingOutbox(staleAfterMs: number, limit: number): Promise<OutboxEvent[]> {
    const boundary = chronoBoundary(this.#clock.now() - staleAfterMs);
    const events: OutboxEvent[] = [];

    for (const shard of pendingOutboxShardKeys()) {
      if (events.length >= limit) break;
      try {
        const result = await this.#client.send(
          new QueryCommand({
            TableName: this.#table,
            IndexName: GSI1_NAME,
            KeyConditionExpression: "gsi1pk = :shard AND gsi1sk < :boundary",
            ExpressionAttributeValues: { ":shard": shard, ":boundary": boundary },
            Limit: limit - events.length,
          }),
        );
        for (const item of result.Items ?? []) {
          events.push(decodeOutbox(item));
        }
      } catch (error) {
        throw classifyDynamoError(error);
      }
    }
    return events;
  }

  /**
   * Workflows still PROCESSING past their business deadline. Reporting only by default:
   * a passed deadline is not evidence of failure (INV-51).
   *
   * GSI2 is KEYS_ONLY on purpose. Projecting the full workflow would duplicate every
   * request payload into the index, doubling write cost and storage for a query that
   * should return nothing in a healthy system.
   */
  async listStaleProcessing(limit: number): Promise<StaleWorkflowRef[]> {
    const boundary = chronoBoundary(this.#clock.now());
    const refs: StaleWorkflowRef[] = [];

    for (const shard of processingShardKeys()) {
      if (refs.length >= limit) break;
      try {
        const result = await this.#client.send(
          new QueryCommand({
            TableName: this.#table,
            IndexName: GSI2_NAME,
            KeyConditionExpression: "gsi2pk = :shard AND gsi2sk < :boundary",
            ExpressionAttributeValues: { ":shard": shard, ":boundary": boundary },
            Limit: limit - refs.length,
          }),
        );
        for (const item of result.Items ?? []) {
          const ref = toStaleRef(item);
          if (ref !== undefined) refs.push(ref);
        }
      } catch (error) {
        throw classifyDynamoError(error);
      }
    }
    return refs;
  }

  /** Test-support only: never called by application code. */
  async deleteForTest(pk: string, sk: string): Promise<void> {
    await this.#client.send(
      new DeleteCommand({ TableName: this.#table, Key: { pk, sk } }),
    );
  }
}

/** GSI2 is KEYS_ONLY, so a stale entry is reconstructed from its key attributes. */
const toStaleRef = (item: Record<string, unknown>): StaleWorkflowRef | undefined => {
  const pk = item["pk"];
  const gsi2sk = item["gsi2sk"];
  if (typeof pk !== "string" || typeof gsi2sk !== "string") return undefined;
  const requestId = pk.startsWith("REQ#") ? pk.slice("REQ#".length) : undefined;
  const deadlineAt = Number.parseInt(gsi2sk.split("#")[0] ?? "", 10);
  if (requestId === undefined || !Number.isFinite(deadlineAt)) return undefined;
  return { requestId: requestId as RequestId, deadlineAt };
};

export const assertNonRetryable = (message: string): never => {
  throw new NonRetryableError(ERROR_CODES.INTERNAL_ERROR, message);
};
