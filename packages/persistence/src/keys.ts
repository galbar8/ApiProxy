import type { EventId, RequestId, TenantId, IdempotencyKey } from "@workflow/contracts";
import type { StepId } from "@workflow/contracts";

/**
 * Every key in the table is built here. Caller-supplied strings reach a key only after
 * schema validation has constrained their charset, and the `#` separator is excluded from
 * every validated charset, so no input can forge a key boundary (INV-74).
 */
export const TABLE_KEYS = { partition: "pk", sort: "sk" } as const;

export const GSI1_NAME = "gsi1-pending-outbox";
export const GSI2_NAME = "gsi2-processing-workflows";

/**
 * Both sparse indexes would otherwise concentrate every write on a single partition key,
 * which is a throughput ceiling rather than a correctness problem — but a ceiling that
 * arrives exactly when the system is busiest. Sharding spreads them; the reconciler
 * queries every shard.
 */
export const PENDING_SHARDS = 10;

const shardOf = (value: string): number => {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) % PENDING_SHARDS;
  }
  return hash;
};

/** Zero-padded so lexical order on the sort key equals chronological order. */
const chronoPrefix = (epochMillis: number): string =>
  String(epochMillis).padStart(13, "0");

export const workflowKey = (requestId: RequestId | string) => ({
  pk: `REQ#${requestId}`,
  sk: "WORKFLOW",
});

export const idempotencyKeyItem = (
  tenantId: TenantId | string,
  idempotencyKey: IdempotencyKey | string,
) => ({
  pk: `IDEM#${tenantId}#${idempotencyKey}`,
  sk: "IDEM",
});

export const stepKey = (requestId: RequestId | string, stepId: StepId) => ({
  pk: `REQ#${requestId}`,
  sk: `STEP#${stepId}`,
});

export const outboxKey = (
  requestId: RequestId | string,
  eventId: EventId | string,
) => ({
  pk: `REQ#${requestId}`,
  sk: `OUTBOX#${eventId}`,
});

export const pendingOutboxIndexKeys = (
  requestId: string,
  eventId: string,
  createdAt: number,
) => ({
  gsi1pk: `OUTBOX_PENDING#${String(shardOf(requestId))}`,
  gsi1sk: `${chronoPrefix(createdAt)}#${eventId}`,
});

export const processingIndexKeys = (requestId: string, deadlineAt: number) => ({
  gsi2pk: `WF_PROCESSING#${String(shardOf(requestId))}`,
  gsi2sk: `${chronoPrefix(deadlineAt)}#${requestId}`,
});

export const pendingOutboxShardKeys = (): string[] =>
  Array.from(
    { length: PENDING_SHARDS },
    (_, index) => `OUTBOX_PENDING#${String(index)}`,
  );

export const processingShardKeys = (): string[] =>
  Array.from(
    { length: PENDING_SHARDS },
    (_, index) => `WF_PROCESSING#${String(index)}`,
  );

export const chronoBoundary = chronoPrefix;

/**
 * The physical table shape, declared once. The CDK stack builds the table from these
 * values and the test harness builds its local table from them too, so a local test
 * cannot pass against a shape production does not have.
 */
export const TABLE_DEFINITION = {
  partitionKey: "pk",
  sortKey: "sk",
  ttlAttribute: "expiresAt",
  streamViewType: "NEW_AND_OLD_IMAGES",
  indexes: [
    {
      name: GSI1_NAME,
      partitionKey: "gsi1pk",
      sortKey: "gsi1sk",
      /** Outbox events are small, so projecting them avoids a read per publish. */
      projection: "ALL",
    },
    {
      name: GSI2_NAME,
      partitionKey: "gsi2pk",
      sortKey: "gsi2sk",
      /** Keys only: projecting workflows would duplicate every request payload. */
      projection: "KEYS_ONLY",
    },
  ],
} as const;
