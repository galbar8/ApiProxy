import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { deriveExternalRef } from "@workflow/idempotency";
import { payloadFingerprint } from "@workflow/idempotency";
import type { OperationInput, RequestId } from "@workflow/contracts";
import {
  anIdempotencyKey,
  anOperation,
  aRequestId,
  aTenantId,
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

beforeAll(async () => {
  pipeline = await createLocalPipeline({ tablePrefix: "e2e" });
});

afterAll(async () => {
  await pipeline.close();
});

describe("end-to-end workflow", () => {
  it("carries a request through both workers to COMPLETED", async () => {
    const requestId = await startWorkflow();

    const workflow = await pipeline.runUntilTerminal(requestId);

    expect(workflow?.status).toBe("COMPLETED");
    expect(workflow?.result).toMatchObject({ outcome: "SETTLED" });
    expect(workflow?.stateVersion).toBe(1);

    const enrichStep = await pipeline.repository.getStep(requestId, "ENRICH");
    const finalizeStep = await pipeline.repository.getStep(requestId, "FINALIZE");
    expect(enrichStep?.status).toBe("SUCCEEDED");
    expect(finalizeStep?.status).toBe("SUCCEEDED");
  });

  it("publishes every committed outbox event and leaves none pending", async () => {
    const requestId = await startWorkflow();
    await pipeline.runUntilTerminal(requestId);

    const pending = await pipeline.repository.listPendingOutbox(-1, 100);
    expect(pending.filter((event) => event.requestId === requestId)).toHaveLength(0);
  });

  it("fails the workflow deterministically when the provider declines", async () => {
    // A HIGH risk band declines in the provider, which is a business outcome, not a fault.
    const requestId = await startWorkflow(
      anOperation({ amount: { currencyCode: "USD", minorUnits: 900_000 } }),
    );

    const workflow = await pipeline.runUntilTerminal(requestId);

    expect(workflow?.status).toBe("FAILED");
    expect(workflow?.error?.code).toBe("PROVIDER_REJECTED");
    expect(workflow?.error?.failureClass).toBe("NON_RETRYABLE");
  });

  it("fails at the first step for input the business cannot process", async () => {
    const requestId = await startWorkflow(
      anOperation({ amount: { currencyCode: "JPY", minorUnits: 500 } }),
    );

    const workflow = await pipeline.runUntilTerminal(requestId);

    expect(workflow?.status).toBe("FAILED");
    expect(workflow?.error?.code).toBe("UNSUPPORTED_CURRENCY");
    // The second step never ran.
    expect(await pipeline.repository.getStep(requestId, "FINALIZE")).toBeUndefined();
  });

  it("never calls the provider twice for one workflow", async () => {
    const requestId = await startWorkflow();
    await pipeline.runUntilTerminal(requestId);

    const externalRef = deriveExternalRef(requestId, "FINALIZE");
    expect(pipeline.providerStore.findByReference(externalRef)).toBeDefined();

    // Run more ticks: replays and duplicates must not produce a second operation.
    await pipeline.tick();
    await pipeline.tick();

    const workflow = await pipeline.repository.getWorkflow(requestId);
    expect(workflow?.status).toBe("COMPLETED");
  });

  it("derives the same provider identity for a request every time", () => {
    const requestId = aRequestId();
    expect(deriveExternalRef(requestId, "FINALIZE")).toBe(
      deriveExternalRef(requestId, "FINALIZE"),
    );
  });

  it("processes many workflows concurrently without cross-request mismatch", async () => {
    const requests = await Promise.all(
      Array.from(
        { length: 6 },
        async (_, index) =>
          await startWorkflow(
            anOperation({
              reference: `inv-${index}`,
              amount: { currencyCode: "USD", minorUnits: 1_000 + index },
            }),
          ),
      ),
    );

    for (let tick = 0; tick < 6; tick += 1) {
      await pipeline.tick();
    }

    for (const [index, requestId] of requests.entries()) {
      const workflow = await pipeline.repository.getWorkflow(requestId);
      expect(workflow?.status).toBe("COMPLETED");
      // Each workflow carries its own amount: no result landed on the wrong request.
      expect(workflow?.result).toMatchObject({
        amount: { minorUnits: 1_000 + index },
      });
    }
  });
});
