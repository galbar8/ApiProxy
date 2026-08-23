import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WorkflowRepository, type CreateWorkflowInput } from "@workflow/persistence";
import { payloadFingerprint } from "@workflow/idempotency";
import { systemClock, type StepId } from "@workflow/contracts";
import {
  anIdempotencyKey,
  anOperation,
  aRequestId,
  aTenantId,
  createLocalDocumentClient,
  createLocalDynamoClient,
  dropTable,
  ensureTable,
  putRawItem,
  uniqueTableName,
} from "@workflow/testing";

const tableName = uniqueTableName("persistence");
let dynamo: ReturnType<typeof createLocalDynamoClient>;
let repository: WorkflowRepository;

const tenantId = aTenantId();

const creationInput = (
  overrides: Partial<CreateWorkflowInput> = {},
): CreateWorkflowInput => {
  const input = overrides.input ?? anOperation();
  return {
    requestId: aRequestId(),
    tenantId,
    idempotencyKey: anIdempotencyKey(),
    payloadHash: payloadFingerprint(input),
    input,
    syncDeadlineAt: Date.now() + 20_000,
    businessDeadlineAt: Date.now() + 300_000,
    ...overrides,
  };
};

beforeAll(async () => {
  dynamo = createLocalDynamoClient();
  await ensureTable(dynamo, tableName);
  repository = new WorkflowRepository({
    client: createLocalDocumentClient(dynamo),
    tableName,
    clock: systemClock,
    workflowTtlDays: 90,
    outboxTtlDays: 7,
  });
});

afterAll(async () => {
  await dropTable(dynamo, tableName);
});

describe("workflow creation", () => {
  it("creates the workflow, the idempotency mapping and the first outbox event atomically", async () => {
    const input = creationInput();
    const created = await repository.createWorkflow(input);

    expect(created.outcome).toBe("CREATED");
    const workflow = await repository.getWorkflow(input.requestId);
    expect(workflow?.status).toBe("PROCESSING");
    expect(workflow?.stateVersion).toBe(0);

    // The publication that must follow the state change exists already (INV-43).
    const pending = await repository.listPendingOutbox(-1, 50);
    expect(pending.some((event) => event.requestId === input.requestId)).toBe(true);
  });

  it("returns the existing workflow for a duplicate request rather than starting a second one", async () => {
    const first = creationInput();
    await repository.createWorkflow(first);

    const retry = await repository.createWorkflow({
      ...first,
      requestId: aRequestId(), // a retry generates a fresh candidate id
    });

    expect(retry.outcome).toBe("EXISTING");
    expect(retry).toMatchObject({ workflow: { requestId: first.requestId } });
  });

  it("rejects the same idempotency key with a materially different payload", async () => {
    const first = creationInput();
    await repository.createWorkflow(first);

    const changed = anOperation({ amount: { currencyCode: "USD", minorUnits: 9_999 } });
    const conflicting = await repository.createWorkflow({
      ...first,
      requestId: aRequestId(),
      input: changed,
      payloadHash: payloadFingerprint(changed),
    });

    expect(conflicting.outcome).toBe("CONFLICT");
    if (conflicting.outcome !== "CONFLICT") throw new Error("unreachable");
    expect(conflicting.existingRequestId).toBe(first.requestId);
  });

  it("creates exactly one workflow when identical requests race", async () => {
    const shared = creationInput();
    const attempts = Array.from({ length: 8 }, () => ({
      ...shared,
      requestId: aRequestId(),
    }));

    const results = await Promise.all(
      attempts.map(async (attempt) => await repository.createWorkflow(attempt)),
    );

    const created = results.filter((result) => result.outcome === "CREATED");
    const existing = results.filter((result) => result.outcome === "EXISTING");
    expect(created).toHaveLength(1);
    expect(existing).toHaveLength(7);

    const winner = created[0];
    if (winner?.outcome !== "CREATED") throw new Error("unreachable");
    for (const result of existing) {
      expect(result.workflow.requestId).toBe(winner.workflow.requestId);
    }
  });

  it("does not leave a mapping behind when the same key is reused for a different tenant", async () => {
    const input = creationInput();
    await repository.createWorkflow(input);

    const otherTenant = await repository.createWorkflow({
      ...input,
      requestId: aRequestId(),
      tenantId: aTenantId("other-corp"),
    });

    // Idempotency is scoped to the tenant, so this is a genuinely new operation (INV-02).
    expect(otherTenant.outcome).toBe("CREATED");
  });
});

describe("tenant isolation", () => {
  it("hides a workflow from a tenant that does not own it", async () => {
    const input = creationInput();
    await repository.createWorkflow(input);

    expect(
      await repository.getWorkflowForTenant(input.requestId, tenantId),
    ).toBeDefined();
    expect(
      await repository.getWorkflowForTenant(input.requestId, aTenantId("intruder")),
    ).toBeUndefined();
  });

  it("returns undefined for an unknown requestId, indistinguishable from a mismatch", async () => {
    expect(
      await repository.getWorkflowForTenant(aRequestId(), tenantId),
    ).toBeUndefined();
  });
});

describe("terminal transitions", () => {
  const finalize: StepId = "FINALIZE";

  it("applies the first terminal write and refuses the second", async () => {
    const input = creationInput();
    await repository.createWorkflow(input);

    const completed = await repository.completeIfProcessing({
      requestId: input.requestId,
      stepId: finalize,
      result: { providerOperationId: "op-1" },
    });
    expect(completed.outcome).toBe("APPLIED");

    const secondAttempt = await repository.failIfProcessing({
      requestId: input.requestId,
      stepId: finalize,
      error: { code: "LATE", message: "late worker", failureClass: "NON_RETRYABLE" },
    });

    expect(secondAttempt.outcome).toBe("ALREADY_TERMINAL");
    if (secondAttempt.outcome !== "ALREADY_TERMINAL") throw new Error("unreachable");
    // The winner's outcome survived (INV-21).
    expect(secondAttempt.workflow.status).toBe("COMPLETED");
  });

  it("lets exactly one writer win when COMPLETED and FAILED race", async () => {
    const input = creationInput();
    await repository.createWorkflow(input);

    const [completeResult, failResult] = await Promise.all([
      repository.completeIfProcessing({
        requestId: input.requestId,
        stepId: finalize,
        result: { providerOperationId: "op-race" },
      }),
      repository.failIfProcessing({
        requestId: input.requestId,
        stepId: finalize,
        error: { code: "RACE", message: "racing", failureClass: "NON_RETRYABLE" },
      }),
    ]);

    const outcomes = [completeResult.outcome, failResult.outcome].sort();
    expect(outcomes).toEqual(["ALREADY_TERMINAL", "APPLIED"]);

    const stored = await repository.getWorkflow(input.requestId);
    expect(stored?.status === "COMPLETED" || stored?.status === "FAILED").toBe(true);
    expect(stored?.stateVersion).toBe(1);
  });

  it("increments stateVersion exactly once for a terminal write", async () => {
    const input = creationInput();
    await repository.createWorkflow(input);
    await repository.completeIfProcessing({
      requestId: input.requestId,
      stepId: finalize,
      result: { ok: true },
    });
    const stored = await repository.getWorkflow(input.requestId);
    expect(stored?.stateVersion).toBe(1);
  });

  it("drops a completed workflow out of the in-flight index", async () => {
    const input = creationInput({ businessDeadlineAt: Date.now() - 1_000 });
    await repository.createWorkflow(input);

    const beforeTerminal = await repository.listStaleProcessing(100);
    expect(beforeTerminal.some((ref) => ref.requestId === input.requestId)).toBe(true);

    await repository.completeIfProcessing({
      requestId: input.requestId,
      stepId: finalize,
      result: { ok: true },
    });

    const afterTerminal = await repository.listStaleProcessing(100);
    expect(afterTerminal.some((ref) => ref.requestId === input.requestId)).toBe(false);
  });

  it("reports MISSING rather than inventing a workflow", async () => {
    const result = await repository.completeIfProcessing({
      requestId: aRequestId(),
      stepId: finalize,
      result: {},
    });
    expect(result.outcome).toBe("MISSING");
  });
});

describe("step progression", () => {
  it("claims a step once and reports a duplicate claim as already succeeded", async () => {
    const input = creationInput();
    await repository.createWorkflow(input);

    const first = await repository.beginStep(input.requestId, "ENRICH");
    expect(first.outcome).toBe("STARTED");

    await repository.advanceStepWithOutbox({
      requestId: input.requestId,
      tenantId,
      stepId: "ENRICH",
      stepResult: { riskBand: "LOW" },
      nextStep: "FINALIZE",
      destination: "STEP_QUEUE",
      nextPayload: {
        enrichment: {
          normalizedReference: "inv-1001",
          riskBand: "LOW",
          enrichedAt: Date.now(),
        },
      },
    });

    const duplicate = await repository.beginStep(input.requestId, "ENRICH");
    expect(duplicate.outcome).toBe("ALREADY_SUCCEEDED");
  });

  it("counts attempts so a resumed step is distinguishable from a fresh one", async () => {
    const input = creationInput();
    await repository.createWorkflow(input);

    const first = await repository.beginStep(input.requestId, "ENRICH");
    const second = await repository.beginStep(input.requestId, "ENRICH");

    expect(first.outcome).toBe("STARTED");
    expect(second.outcome).toBe("RESUMED");
    if (second.outcome !== "RESUMED") throw new Error("unreachable");
    expect(second.step.attempt).toBe(2);
  });

  it("writes the external reference before any external call could happen", async () => {
    const input = creationInput();
    await repository.createWorkflow(input);

    const claim = await repository.beginStep(
      input.requestId,
      "FINALIZE",
      "a".repeat(64),
    );
    expect(claim.outcome).toBe("STARTED");

    const stored = await repository.getStep(input.requestId, "FINALIZE");
    expect(stored?.externalRef).toBe("a".repeat(64));
  });

  it("keeps the original external reference across retries", async () => {
    const input = creationInput();
    await repository.createWorkflow(input);
    await repository.beginStep(input.requestId, "FINALIZE", "b".repeat(64));
    await repository.beginStep(input.requestId, "FINALIZE", "c".repeat(64));

    const stored = await repository.getStep(input.requestId, "FINALIZE");
    expect(stored?.externalRef).toBe("b".repeat(64));
  });

  it("advances state and queues the next event in one transaction", async () => {
    const input = creationInput();
    await repository.createWorkflow(input);
    await repository.beginStep(input.requestId, "ENRICH");

    const advanced = await repository.advanceStepWithOutbox({
      requestId: input.requestId,
      tenantId,
      stepId: "ENRICH",
      stepResult: { riskBand: "LOW" },
      nextStep: "FINALIZE",
      destination: "STEP_QUEUE",
      nextPayload: {
        enrichment: {
          normalizedReference: "inv-1001",
          riskBand: "LOW",
          enrichedAt: Date.now(),
        },
      },
    });
    expect(advanced.outcome).toBe("ADVANCED");

    const step = await repository.getStep(input.requestId, "ENRICH");
    expect(step?.status).toBe("SUCCEEDED");

    const pending = await repository.listPendingOutbox(-1, 100);
    const next = pending.find(
      (event) =>
        event.requestId === input.requestId && event.destination === "STEP_QUEUE",
    );
    expect(next).toBeDefined();
    expect(next?.message.step).toBe("FINALIZE");
  });

  it("treats a duplicate advance as already done, without a second event", async () => {
    const input = creationInput();
    await repository.createWorkflow(input);
    await repository.beginStep(input.requestId, "ENRICH");

    const params = {
      requestId: input.requestId,
      tenantId,
      stepId: "ENRICH" as StepId,
      stepResult: { riskBand: "LOW" },
      nextStep: "FINALIZE" as StepId,
      destination: "STEP_QUEUE" as const,
      nextPayload: {
        enrichment: {
          normalizedReference: "inv-1001",
          riskBand: "LOW" as const,
          enrichedAt: Date.now(),
        },
      },
    };

    await repository.advanceStepWithOutbox(params);
    const second = await repository.advanceStepWithOutbox(params);
    expect(second.outcome).toBe("ALREADY_ADVANCED");

    const pending = await repository.listPendingOutbox(-1, 100);
    const events = pending.filter(
      (event) =>
        event.requestId === input.requestId && event.destination === "STEP_QUEUE",
    );
    expect(events).toHaveLength(1);
  });

  it("refuses to advance a workflow that is already terminal", async () => {
    const input = creationInput();
    await repository.createWorkflow(input);
    await repository.completeIfProcessing({
      requestId: input.requestId,
      stepId: "FINALIZE",
      result: { ok: true },
    });

    const late = await repository.advanceStepWithOutbox({
      requestId: input.requestId,
      tenantId,
      stepId: "ENRICH",
      stepResult: {},
      nextStep: "FINALIZE",
      destination: "STEP_QUEUE",
      nextPayload: {
        enrichment: {
          normalizedReference: "x",
          riskBand: "LOW",
          enrichedAt: Date.now(),
        },
      },
    });

    expect(late.outcome).toBe("WORKFLOW_TERMINAL");
  });

  it("reports a missing workflow instead of creating orphan step state", async () => {
    const result = await repository.advanceStepWithOutbox({
      requestId: aRequestId(),
      tenantId,
      stepId: "ENRICH",
      stepResult: {},
      nextStep: "FINALIZE",
      destination: "STEP_QUEUE",
      nextPayload: {
        enrichment: {
          normalizedReference: "x",
          riskBand: "LOW",
          enrichedAt: Date.now(),
        },
      },
    });
    expect(result.outcome).toBe("WORKFLOW_MISSING");
  });
});

describe("outbox lifecycle", () => {
  it("removes a published event from the pending index but keeps the record", async () => {
    const input = creationInput();
    await repository.createWorkflow(input);

    const pending = await repository.listPendingOutbox(-1, 100);
    const event = pending.find((candidate) => candidate.requestId === input.requestId);
    expect(event).toBeDefined();
    if (event === undefined) throw new Error("unreachable");

    await repository.markOutboxPublished(input.requestId, event.eventId);

    const afterPublish = await repository.listPendingOutbox(-1, 100);
    expect(afterPublish.some((candidate) => candidate.eventId === event.eventId)).toBe(
      false,
    );

    const stored = await repository.getOutboxEvent(input.requestId, event.eventId);
    expect(stored?.publishedAt).toBeGreaterThan(0);
  });

  it("is safe to mark the same event published twice", async () => {
    const input = creationInput();
    await repository.createWorkflow(input);
    const pending = await repository.listPendingOutbox(-1, 100);
    const event = pending.find((candidate) => candidate.requestId === input.requestId);
    if (event === undefined) throw new Error("unreachable");

    await repository.markOutboxPublished(input.requestId, event.eventId);
    await expect(
      repository.markOutboxPublished(input.requestId, event.eventId),
    ).resolves.toBeUndefined();
  });

  it("does not list events that are younger than the staleness threshold", async () => {
    const input = creationInput();
    await repository.createWorkflow(input);

    const fresh = await repository.listPendingOutbox(60_000, 100);
    expect(fresh.some((event) => event.requestId === input.requestId)).toBe(false);
  });

  it("ignores a mark for an event that does not exist", async () => {
    await expect(
      repository.markOutboxPublished(aRequestId(), "f".repeat(64) as unknown as never),
    ).resolves.toBeUndefined();
  });
});

describe("read validation", () => {
  it("rejects a persisted item that does not match the schema", async () => {
    const requestId = aRequestId();
    await putRawItem(createLocalDocumentClient(dynamo), tableName, {
      pk: `REQ#${requestId}`,
      sk: "WORKFLOW",
      status: "WAT",
    });

    await expect(repository.getWorkflow(requestId)).rejects.toThrow(
      /failed validation/,
    );
  });
});
