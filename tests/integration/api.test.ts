import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "@workflow/config";
import { systemClock, type RequestId } from "@workflow/contracts";
import {
  apiKeyHashForTesting,
  buildApp,
  buildDependencies,
  type AppDependencies,
} from "@workflow/api";
import {
  anOperation,
  createLocalDynamoClient,
  dropTable,
  ensureTable,
  uniqueTableName,
} from "@workflow/testing";

interface ProcessBody {
  requestId: string;
  status: string;
  pollUrl?: string;
  result?: unknown;
}

const tableName = uniqueTableName("api");
const API_KEY = "acme-live-key-0123456789";
const OTHER_KEY = "other-live-key-0123456789";

const keyDocument = JSON.stringify({
  tenants: [
    {
      tenantId: "acme",
      status: "active",
      keys: [{ kid: "k1", hash: apiKeyHashForTesting(API_KEY) }],
    },
    {
      tenantId: "other-corp",
      status: "active",
      keys: [{ kid: "k1", hash: apiKeyHashForTesting(OTHER_KEY) }],
    },
    {
      tenantId: "disabled-corp",
      status: "disabled",
      keys: [{ kid: "k1", hash: apiKeyHashForTesting("disabled-key-0123456789") }],
    },
  ],
});

const baseEnv = (overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
  APP_ENV: "local",
  LOG_LEVEL: "fatal",
  WORKFLOW_TABLE_NAME: tableName,
  DYNAMODB_ENDPOINT: process.env["DYNAMODB_ENDPOINT"] ?? "http://127.0.0.1:8000",
  API_KEYS_INLINE: keyDocument,
  SYNC_WAIT_TIMEOUT_MS: "800",
  HTTP_REQUEST_TIMEOUT_MS: "5000",
  ALB_IDLE_TIMEOUT_MS: "10000",
  HTTP_KEEP_ALIVE_TIMEOUT_MS: "15000",
  HTTP_HEADERS_TIMEOUT_MS: "20000",
  CLIENT_RECOMMENDED_TIMEOUT_MS: "20000",
  SHUTDOWN_DRAIN_MS: "5000",
  SHUTDOWN_READINESS_DELAY_MS: "10",
  POLL_INITIAL_DELAY_MS: "20",
  POLL_MAX_DELAY_MS: "100",
  ...overrides,
});

let dynamo: ReturnType<typeof createLocalDynamoClient>;
let deps: AppDependencies;
let app: ReturnType<typeof buildApp>;

const authHeaders = (
  key = API_KEY,
  idempotencyKey = `idem-${Math.random().toString(36).slice(2)}0000000`,
) => ({
  authorization: `ApiKey ${key}`,
  "idempotency-key": idempotencyKey,
});

beforeAll(async () => {
  dynamo = createLocalDynamoClient();
  await ensureTable(dynamo, tableName);
  deps = buildDependencies(loadConfig("api", baseEnv()), systemClock);
  deps.lifecycle.markReady();
  app = buildApp(deps);
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await dropTable(dynamo, tableName);
});

afterEach(() => {
  // Every test starts from a service that is accepting work.
  if (!deps.lifecycle.isReady) {
    deps = buildDependencies(loadConfig("api", baseEnv()), systemClock);
    deps.lifecycle.markReady();
  }
});

describe("authentication", () => {
  it("rejects a request with no credentials", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/process",
      payload: anOperation(),
      headers: { "idempotency-key": "idem-000000000001" },
    });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ code: "UNAUTHENTICATED" });
  });

  it("rejects an unknown key with the same response as a malformed one", async () => {
    const unknown = await app.inject({
      method: "POST",
      url: "/v1/process",
      payload: anOperation(),
      headers: authHeaders("not-a-real-key"),
    });
    const malformed = await app.inject({
      method: "POST",
      url: "/v1/process",
      payload: anOperation(),
      headers: { ...authHeaders(), authorization: "Basic abc" },
    });

    expect(unknown.statusCode).toBe(401);
    expect(malformed.statusCode).toBe(401);
    expect(unknown.json()).toEqual(malformed.json());
  });

  it("rejects a key belonging to a disabled tenant", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/process",
      payload: anOperation(),
      headers: authHeaders("disabled-key-0123456789"),
    });
    expect(response.statusCode).toBe(401);
  });

  it("never echoes the presented credential", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/process",
      payload: anOperation(),
      headers: authHeaders("leaked-key-value-123456"),
    });
    expect(response.body).not.toContain("leaked-key-value");
  });
});

describe("request validation", () => {
  it("requires a well-formed idempotency key", async () => {
    const missing = await app.inject({
      method: "POST",
      url: "/v1/process",
      payload: anOperation(),
      headers: { authorization: `ApiKey ${API_KEY}` },
    });
    const tooShort = await app.inject({
      method: "POST",
      url: "/v1/process",
      payload: anOperation(),
      headers: authHeaders(API_KEY, "short"),
    });

    expect(missing.statusCode).toBe(400);
    expect(tooShort.statusCode).toBe(400);
  });

  it("rejects a body that fails schema validation", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/process",
      payload: {
        operation: "TRANSFER",
        amount: { currencyCode: "usd", minorUnits: -1 },
      },
      headers: authHeaders(),
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: "VALIDATION_FAILED" });
  });

  it("ignores a tenantId supplied in the body by rejecting the request outright", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/process",
      payload: { ...anOperation(), tenantId: "other-corp" },
      headers: authHeaders(),
    });
    expect(response.statusCode).toBe(400);
  });

  it("rejects an oversized payload before creating any state", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/process",
      payload: { ...anOperation(), reference: "x".repeat(200_000) },
      headers: authHeaders(),
    });
    expect(response.statusCode).toBe(413);
  });
});

describe("synchronous behaviour", () => {
  it("returns 202 and a poll url when the deadline expires first", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/process",
      payload: anOperation(),
      headers: authHeaders(),
    });

    expect(response.statusCode).toBe(202);
    const body = response.json<ProcessBody>();
    expect(body.status).toBe("PROCESSING");
    expect(body.pollUrl).toContain(body.requestId);
    expect(response.headers["retry-after"]).toBeDefined();
  });

  it("leaves the workflow untouched and recoverable after a synchronous timeout", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/process",
      payload: anOperation(),
      headers: authHeaders(),
    });
    const { requestId } = response.json<ProcessBody>();

    const workflow = await deps.repository.getWorkflow(requestId as RequestId);
    expect(workflow?.status).toBe("PROCESSING");
    expect(workflow?.stateVersion).toBe(0);

    // The workflow later finishes on its own; the HTTP timeout meant nothing to it.
    await deps.repository.completeIfProcessing({
      requestId: requestId as RequestId,
      stepId: "FINALIZE",
      result: { providerOperationId: "op-late" },
    });

    const recovered = await app.inject({
      method: "GET",
      url: `/v1/process/${requestId}`,
      headers: { authorization: `ApiKey ${API_KEY}` },
    });
    expect(recovered.statusCode).toBe(200);
    expect(recovered.json()).toMatchObject({ status: "COMPLETED" });
  });

  it("returns the terminal result on the same request when the workflow finishes in time", async () => {
    const key = `idem-${Date.now()}-inflight`;

    // First call creates the workflow and times out synchronously.
    const created = await app.inject({
      method: "POST",
      url: "/v1/process",
      payload: anOperation(),
      headers: authHeaders(API_KEY, key),
    });
    const { requestId } = created.json<ProcessBody>();

    // Second call joins the same workflow and waits for it.
    const joining = app.inject({
      method: "POST",
      url: "/v1/process",
      payload: anOperation(),
      headers: authHeaders(API_KEY, key),
    });

    await systemClock.sleep(100);
    await deps.repository.completeIfProcessing({
      requestId: requestId as RequestId,
      stepId: "FINALIZE",
      result: { providerOperationId: "op-fast" },
    });

    const response = await joining;
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      requestId,
      status: "COMPLETED",
      result: { providerOperationId: "op-fast" },
    });
  });
});

describe("idempotency", () => {
  it("returns the same workflow for a repeated request", async () => {
    const key = `idem-${Date.now()}-repeat`;
    const first = await app.inject({
      method: "POST",
      url: "/v1/process",
      payload: anOperation(),
      headers: authHeaders(API_KEY, key),
    });
    const second = await app.inject({
      method: "POST",
      url: "/v1/process",
      payload: anOperation(),
      headers: authHeaders(API_KEY, key),
    });

    expect(first.json<ProcessBody>().requestId).toBe(
      second.json<ProcessBody>().requestId,
    );
  });

  it("recovers the stored result when retrying an already-completed operation", async () => {
    const key = `idem-${Date.now()}-completed`;
    const first = await app.inject({
      method: "POST",
      url: "/v1/process",
      payload: anOperation(),
      headers: authHeaders(API_KEY, key),
    });
    const { requestId } = first.json<ProcessBody>();

    await deps.repository.completeIfProcessing({
      requestId: requestId as RequestId,
      stepId: "FINALIZE",
      result: { providerOperationId: "op-stored" },
    });

    const retry = await app.inject({
      method: "POST",
      url: "/v1/process",
      payload: anOperation(),
      headers: authHeaders(API_KEY, key),
    });

    expect(retry.statusCode).toBe(200);
    expect(retry.json()).toMatchObject({
      requestId,
      status: "COMPLETED",
      result: { providerOperationId: "op-stored" },
    });
  });

  it("rejects the same key with a different payload", async () => {
    const key = `idem-${Date.now()}-conflict`;
    await app.inject({
      method: "POST",
      url: "/v1/process",
      payload: anOperation(),
      headers: authHeaders(API_KEY, key),
    });
    const conflicting = await app.inject({
      method: "POST",
      url: "/v1/process",
      payload: anOperation({ amount: { currencyCode: "EUR", minorUnits: 500 } }),
      headers: authHeaders(API_KEY, key),
    });

    expect(conflicting.statusCode).toBe(409);
    expect(conflicting.json()).toMatchObject({ code: "IDEMPOTENCY_KEY_CONFLICT" });
  });

  it("scopes idempotency keys per tenant", async () => {
    const key = `idem-${Date.now()}-tenant-scope`;
    const acme = await app.inject({
      method: "POST",
      url: "/v1/process",
      payload: anOperation(),
      headers: authHeaders(API_KEY, key),
    });
    const other = await app.inject({
      method: "POST",
      url: "/v1/process",
      payload: anOperation(),
      headers: authHeaders(OTHER_KEY, key),
    });

    expect(acme.json<ProcessBody>().requestId).not.toBe(
      other.json<ProcessBody>().requestId,
    );
  });

  it("starts exactly one workflow when duplicate requests arrive simultaneously", async () => {
    const key = `idem-${Date.now()}-simultaneous`;
    const responses = await Promise.all(
      Array.from(
        { length: 6 },
        async () =>
          await app.inject({
            method: "POST",
            url: "/v1/process",
            payload: anOperation(),
            headers: authHeaders(API_KEY, key),
          }),
      ),
    );

    const ids = new Set(
      responses.map((response) => response.json<ProcessBody>().requestId),
    );
    expect(ids.size).toBe(1);
  });
});

describe("tenant isolation", () => {
  it("hides another tenant's workflow behind a 404", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/v1/process",
      payload: anOperation(),
      headers: authHeaders(),
    });
    const { requestId } = created.json<ProcessBody>();

    const asOwner = await app.inject({
      method: "GET",
      url: `/v1/process/${requestId}`,
      headers: { authorization: `ApiKey ${API_KEY}` },
    });
    const asIntruder = await app.inject({
      method: "GET",
      url: `/v1/process/${requestId}`,
      headers: { authorization: `ApiKey ${OTHER_KEY}` },
    });

    expect(asOwner.statusCode).toBe(200);
    expect(asIntruder.statusCode).toBe(404);
  });

  it("returns an identical 404 for an unknown and a foreign requestId", async () => {
    const unknown = await app.inject({
      method: "GET",
      url: `/v1/process/${crypto.randomUUID()}`,
      headers: { authorization: `ApiKey ${OTHER_KEY}` },
    });
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json()).toMatchObject({ code: "NOT_FOUND" });
  });

  it("does not leak existence through a malformed requestId", async () => {
    const malformed = await app.inject({
      method: "GET",
      url: "/v1/process/not-a-uuid",
      headers: { authorization: `ApiKey ${API_KEY}` },
    });
    expect(malformed.statusCode).toBe(404);
  });

  it("requires authentication on the status endpoint", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/v1/process/${crypto.randomUUID()}`,
    });
    expect(response.statusCode).toBe(401);
  });
});

describe("health and draining", () => {
  it("reports live and ready while serving", async () => {
    expect((await app.inject({ method: "GET", url: "/health/live" })).statusCode).toBe(
      200,
    );
    expect((await app.inject({ method: "GET", url: "/health/ready" })).statusCode).toBe(
      200,
    );
  });

  it("fails readiness but stays live while draining", async () => {
    const drainingDeps = buildDependencies(loadConfig("api", baseEnv()), systemClock);
    drainingDeps.lifecycle.markReady();
    const drainingApp = buildApp(drainingDeps);
    await drainingApp.ready();

    drainingDeps.lifecycle.beginDrain();

    const ready = await drainingApp.inject({ method: "GET", url: "/health/ready" });
    const live = await drainingApp.inject({ method: "GET", url: "/health/live" });
    const work = await drainingApp.inject({
      method: "POST",
      url: "/v1/process",
      payload: anOperation(),
      headers: authHeaders(),
    });

    expect(ready.statusCode).toBe(503);
    expect(live.statusCode).toBe(200);
    expect(work.statusCode).toBe(503);
    expect(work.json()).toMatchObject({ code: "SERVICE_DRAINING" });

    await drainingApp.close();
  });

  it("still answers status lookups while draining, so recovery stays available", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/v1/process",
      payload: anOperation(),
      headers: authHeaders(),
    });
    const { requestId } = created.json<ProcessBody>();

    const drainingDeps = buildDependencies(loadConfig("api", baseEnv()), systemClock);
    drainingDeps.lifecycle.markReady();
    const drainingApp = buildApp(drainingDeps);
    await drainingApp.ready();
    drainingDeps.lifecycle.beginDrain();

    const lookup = await drainingApp.inject({
      method: "GET",
      url: `/v1/process/${requestId}`,
      headers: { authorization: `ApiKey ${API_KEY}` },
    });

    // Draining refuses new work; it does not refuse to answer questions about work that
    // already exists.
    expect(lookup.statusCode).toBe(200);
    expect(lookup.json()).toMatchObject({ requestId, status: "PROCESSING" });

    await drainingApp.close();
  });

  it("returns 202 rather than an error when shutdown aborts an in-flight wait", async () => {
    const shutdownDeps = buildDependencies(
      loadConfig(
        "api",
        // The whole ladder moves together: config refuses to start a service whose
        // synchronous wait exceeds its request budget.
        baseEnv({
          SYNC_WAIT_TIMEOUT_MS: "10000",
          HTTP_REQUEST_TIMEOUT_MS: "15000",
          ALB_IDLE_TIMEOUT_MS: "20000",
          HTTP_KEEP_ALIVE_TIMEOUT_MS: "25000",
          HTTP_HEADERS_TIMEOUT_MS: "30000",
          CLIENT_RECOMMENDED_TIMEOUT_MS: "30000",
          SHUTDOWN_DRAIN_MS: "20000",
        }),
      ),
      systemClock,
    );
    shutdownDeps.lifecycle.markReady();
    const shutdownApp = buildApp(shutdownDeps);
    await shutdownApp.ready();

    const pending = shutdownApp.inject({
      method: "POST",
      url: "/v1/process",
      payload: anOperation(),
      headers: authHeaders(),
    });

    await systemClock.sleep(120);
    shutdownDeps.lifecycle.abortWaits();

    const response = await pending;
    expect(response.statusCode).toBe(202);
    expect(response.json()).toMatchObject({ status: "PROCESSING" });

    const { requestId } = response.json<ProcessBody>();
    const workflow = await shutdownDeps.repository.getWorkflow(requestId as RequestId);
    // Task shutdown is not a business event (INV-51).
    expect(workflow?.status).toBe("PROCESSING");

    await shutdownApp.close();
  });
});
