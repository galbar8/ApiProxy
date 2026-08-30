import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { deriveExternalRef, payloadFingerprint } from "@workflow/idempotency";
import type { OperationInput, RequestId } from "@workflow/contracts";
import {
  anIdempotencyKey,
  anOperation,
  aRequestId,
  aTenantId,
  approximateDepth,
  drainQueue,
  sendRawMessage,
} from "@workflow/testing";
import { createLocalPipeline, type LocalPipeline } from "../support/pipeline.js";

let pipeline: LocalPipeline;
const tenantId = aTenantId();

const startWorkflow = async (
  input: OperationInput = anOperation(),
): Promise<RequestId> => {
  const requestId = aRequestId();
  const result = await pipeline.repository.createWorkflow({
    requestId,
    tenantId,
    idempotencyKey: anIdempotencyKey(),
    payloadHash: payloadFingerprint(input),
    input,
    syncDeadlineAt: Date.now() + 20_000,
    businessDeadlineAt: Date.now() + 300_000,
  });
  if (result.outcome !== "CREATED") throw new Error("expected a new workflow");
  return requestId;
};

const providerOperationsFor = (requestId: RequestId): number =>
  pipeline.providerStore.findByReference(deriveExternalRef(requestId, "FINALIZE")) ===
  undefined
    ? 0
    : 1;

beforeAll(async () => {
  pipeline = await createLocalPipeline({ tablePrefix: "chaos" });
});

afterAll(async () => {
  await pipeline.close();
});

describe("duplicate delivery", () => {
  it("produces one business effect when a message is delivered twice in one batch", async () => {
    const requestId = await startWorkflow();

    await pipeline.pumpStream();
    await pipeline.pumpStart({ duplicateInBatch: true });
    await pipeline.pumpStream();
    await pipeline.pumpStep({ duplicateInBatch: true });
    await pipeline.pumpStream();

    const workflow = await pipeline.repository.getWorkflow(requestId);
    expect(workflow?.status).toBe("COMPLETED");
    expect(providerOperationsFor(requestId)).toBe(1);

    // One terminal write happened, not two.
    expect(workflow?.stateVersion).toBe(1);
  });

  it("produces one business effect when a whole batch is redelivered", async () => {
    const requestId = await startWorkflow();

    await pipeline.pumpStream();
    await pipeline.pumpStart({ redeliverBatch: true });
    await pipeline.pumpStream();
    await pipeline.pumpStep({ redeliverBatch: true });
    await pipeline.pumpStream();

    const workflow = await pipeline.repository.getWorkflow(requestId);
    expect(workflow?.status).toBe("COMPLETED");
    expect(providerOperationsFor(requestId)).toBe(1);
    expect(workflow?.stateVersion).toBe(1);
  });

  it("creates exactly one next-step event however many times enrich is delivered", async () => {
    const requestId = await startWorkflow();

    await pipeline.pumpStream();
    await pipeline.pumpStart({ duplicateInBatch: true, redeliverBatch: true });

    const events = await pipeline.repository.listPendingOutbox(-1, 100);
    const stepEvents = events.filter(
      (event) => event.requestId === requestId && event.destination === "STEP_QUEUE",
    );
    expect(stepEvents).toHaveLength(1);
  });

  it("ignores a late duplicate that arrives after the workflow is terminal", async () => {
    const requestId = await startWorkflow();
    const workflow = await pipeline.runUntilTerminal(requestId);
    expect(workflow?.status).toBe("COMPLETED");
    const versionBefore = workflow?.stateVersion;

    // Replay the original enrich message long after the workflow finished.
    await sendRawMessage(
      pipeline.sqs,
      pipeline.queues.start,
      JSON.stringify({
        messageId: "a".repeat(64),
        requestId,
        tenantId,
        workflowVersion: 1,
        createdAt: Date.now(),
        step: "ENRICH",
        payload: {},
      }),
    );
    const result = await pipeline.pumpStart();

    expect(result.deleted).toBe(1);
    const after = await pipeline.repository.getWorkflow(requestId);
    expect(after?.stateVersion).toBe(versionBefore);
    expect(after?.status).toBe("COMPLETED");
  });
});

describe("out-of-order and mixed batches", () => {
  it("is unaffected by reversed delivery order on a Standard queue", async () => {
    const requests = await Promise.all([
      startWorkflow(),
      startWorkflow(),
      startWorkflow(),
    ]);

    await pipeline.pumpStream();
    await pipeline.pumpStart({ reverseOrder: true });
    await pipeline.pumpStream();
    await pipeline.pumpStep({ reverseOrder: true });
    await pipeline.pumpStream();

    for (const requestId of requests) {
      const workflow = await pipeline.repository.getWorkflow(requestId);
      expect(workflow?.status).toBe("COMPLETED");
    }
  });

  it("acknowledges good records and redelivers only the bad one", async () => {
    const good = await startWorkflow();
    await pipeline.pumpStream();

    await sendRawMessage(pipeline.sqs, pipeline.queues.start, "{ this is not json");

    const result = await pipeline.pumpStart();

    expect(result.received).toBe(2);
    expect(result.deleted).toBe(1);
    expect(result.reportedFailures).toBe(1);

    const workflow = await pipeline.repository.getWorkflow(good);
    expect((await pipeline.repository.getStep(good, "ENRICH"))?.status).toBe(
      "SUCCEEDED",
    );
    expect(workflow?.status).toBe("PROCESSING");

    await drainQueue(pipeline.sqs, pipeline.queues.start);
  });
});

describe("poison messages", () => {
  it("moves a permanently unprocessable message to the DLQ instead of looping forever", async () => {
    await sendRawMessage(
      pipeline.sqs,
      pipeline.queues.start,
      JSON.stringify({ step: "ENRICH", nonsense: true }),
    );

    // maxReceiveCount is 5 in both ElasticMQ and the CDK stack.
    for (let attempt = 0; attempt < 7; attempt += 1) {
      await pipeline.pumpStart();
    }

    const dlqBodies = await drainQueue(pipeline.sqs, pipeline.queues.startDlq);
    expect(dlqBodies.length).toBeGreaterThanOrEqual(1);
    expect(dlqBodies.some((body) => body.includes("nonsense"))).toBe(true);

    // And it is no longer circulating on the main queue.
    expect(await approximateDepth(pipeline.sqs, pipeline.queues.start)).toBe(0);
  });
});

describe("crash windows", () => {
  it("recovers when a worker crashes after processing but before acknowledging", async () => {
    const requestId = await startWorkflow();
    await pipeline.pumpStream();

    // The handler runs and commits, then the invocation dies without deleting.
    await pipeline.pumpStart({ crashAfterHandler: true });
    expect((await pipeline.repository.getStep(requestId, "ENRICH"))?.status).toBe(
      "SUCCEEDED",
    );

    // The message comes back. Re-processing must be a no-op, not a second advance.
    await pipeline.pumpStart();
    const events = await pipeline.repository.listPendingOutbox(-1, 100);
    expect(
      events.filter(
        (event) => event.requestId === requestId && event.destination === "STEP_QUEUE",
      ),
    ).toHaveLength(1);

    const workflow = await pipeline.runUntilTerminal(requestId);
    expect(workflow?.status).toBe("COMPLETED");
    expect(providerOperationsFor(requestId)).toBe(1);
  });

  it("still advances when the stream never delivers the outbox event", async () => {
    const requestId = await startWorkflow();

    // The state change committed, but the publication was lost entirely: the exact
    // failure a direct DB-then-SQS dual write cannot survive.
    await pipeline.pumpStream();
    pipeline.streamPump.dropLast();
    await pipeline.pumpStart();

    const stillPending = await pipeline.repository.listPendingOutbox(-1, 100);
    const orphan = stillPending.find((event) => event.requestId === requestId);
    expect(orphan).toBeDefined();

    // The reconciler sweeps it up and the workflow proceeds.
    const summary = await pipeline.handlers.reconciler();
    expect(summary.republished).toBeGreaterThanOrEqual(1);

    const workflow = await pipeline.runUntilTerminal(requestId);
    expect(workflow?.status).toBe("COMPLETED");
  });

  it("is unharmed by duplicate stream processing", async () => {
    const requestId = await startWorkflow();

    await pipeline.pumpStream();
    // The same stream batch is delivered again, as at-least-once stream processing allows.
    await pipeline.replayStream();

    await pipeline.pumpStart();
    await pipeline.pumpStream();
    await pipeline.replayStream();
    await pipeline.pumpStep();
    await pipeline.pumpStream();

    const workflow = await pipeline.repository.getWorkflow(requestId);
    expect(workflow?.status).toBe("COMPLETED");
    expect(providerOperationsFor(requestId)).toBe(1);
    expect(workflow?.stateVersion).toBe(1);
  });
});

describe("external side effects", () => {
  it("reconciles instead of repeating when the provider succeeded and the response was lost", async () => {
    const requestId = await startWorkflow();
    const externalRef = deriveExternalRef(requestId, "FINALIZE");
    // The provider performs the operation, then the connection dies before we see it.
    pipeline.providerStore.queueFault(externalRef, ["succeed-then-drop"]);

    await pipeline.pumpStream();
    await pipeline.pumpStart();
    await pipeline.pumpStream();

    // First attempt: ambiguous outcome, recorded durably, message retried.
    const firstAttempt = await pipeline.pumpStep();
    expect(firstAttempt.reportedFailures).toBe(1);
    const step = await pipeline.repository.getStep(requestId, "FINALIZE");
    expect(step?.status).toBe("UNKNOWN_EXTERNAL_STATE");
    expect(step?.externalRef).toBe(externalRef);

    // Second attempt: reconcile first, adopt the existing operation, do not re-execute.
    await pipeline.pumpStep();

    const workflow = await pipeline.repository.getWorkflow(requestId);
    expect(workflow?.status).toBe("COMPLETED");
    expect(providerOperationsFor(requestId)).toBe(1);
  });

  it("treats a provider timeout as unknown state rather than a plain retry", async () => {
    const requestId = await startWorkflow();
    const externalRef = deriveExternalRef(requestId, "FINALIZE");
    pipeline.providerStore.queueFault(externalRef, ["timeout"]);

    await pipeline.pumpStream();
    await pipeline.pumpStart();
    await pipeline.pumpStream();

    const attempt = await pipeline.pumpStep();
    expect(attempt.reportedFailures).toBe(1);
    expect((await pipeline.repository.getStep(requestId, "FINALIZE"))?.status).toBe(
      "UNKNOWN_EXTERNAL_STATE",
    );

    // Reconciliation finds nothing happened, so proceeding is safe.
    await pipeline.pumpStep();
    const workflow = await pipeline.repository.getWorkflow(requestId);
    expect(workflow?.status).toBe("COMPLETED");
    expect(providerOperationsFor(requestId)).toBe(1);
  });

  it("retries a transient provider outage without marking the workflow failed", async () => {
    const requestId = await startWorkflow();
    const externalRef = deriveExternalRef(requestId, "FINALIZE");
    pipeline.providerStore.queueFault(externalRef, ["server-error", "rate-limit"]);

    await pipeline.pumpStream();
    await pipeline.pumpStart();
    await pipeline.pumpStream();

    const first = await pipeline.pumpStep();
    expect(first.reportedFailures).toBe(1);
    expect((await pipeline.repository.getWorkflow(requestId))?.status).toBe(
      "PROCESSING",
    );

    const second = await pipeline.pumpStep();
    expect(second.reportedFailures).toBe(1);

    await pipeline.pumpStep();
    expect((await pipeline.repository.getWorkflow(requestId))?.status).toBe(
      "COMPLETED",
    );
  });
});
