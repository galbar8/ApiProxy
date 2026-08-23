import { spawn, type ChildProcess } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import type { RequestId } from "@workflow/contracts";
import { systemClock } from "@workflow/contracts";
import { WorkflowRepository, createDocumentClient } from "@workflow/persistence";
import {
  LOCAL_DYNAMODB_ENDPOINT,
  anOperation,
  createLocalDynamoClient,
  dropTable,
  ensureTable,
  uniqueTableName,
} from "@workflow/testing";

/**
 * These scenarios need a real socket and a real process: `inject()` cannot sever a
 * connection mid-request, and nothing but an actual SIGTERM proves the drain sequence.
 */
const API_KEY = "e2e-live-key-01234567890";
const tableName = uniqueTableName("http-lifecycle");
const port = 8181;
const baseUrl = `http://127.0.0.1:${String(port)}`;

const keyDocument = JSON.stringify({
  tenants: [
    {
      tenantId: "acme",
      status: "active",
      keys: [
        { kid: "k1", hash: createHash("sha256").update(API_KEY, "utf8").digest("hex") },
      ],
    },
  ],
});

let dynamo: ReturnType<typeof createLocalDynamoClient>;
let repository: WorkflowRepository;
let server: ChildProcess | undefined;

const waitForReady = async (deadlineMs = 30_000): Promise<void> => {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/health/ready`);
      if (response.status === 200) return;
    } catch {
      // not listening yet
    }
    await systemClock.sleep(200);
  }
  throw new Error("api did not become ready");
};

const startServer = (): ChildProcess =>
  spawn("node_modules/.bin/tsx", ["apps/api/src/server.ts"], {
    env: {
      ...process.env,
      APP_ENV: "local",
      LOG_LEVEL: "fatal",
      PORT: String(port),
      PUBLIC_BASE_URL: baseUrl,
      WORKFLOW_TABLE_NAME: tableName,
      DYNAMODB_ENDPOINT: LOCAL_DYNAMODB_ENDPOINT,
      API_KEYS_INLINE: keyDocument,
      // Long enough that a request is definitely still waiting when we interfere.
      SYNC_WAIT_TIMEOUT_MS: "15000",
      HTTP_REQUEST_TIMEOUT_MS: "20000",
      ALB_IDLE_TIMEOUT_MS: "25000",
      HTTP_KEEP_ALIVE_TIMEOUT_MS: "30000",
      HTTP_HEADERS_TIMEOUT_MS: "35000",
      CLIENT_RECOMMENDED_TIMEOUT_MS: "40000",
      SHUTDOWN_DRAIN_MS: "20000",
      SHUTDOWN_READINESS_DELAY_MS: "200",
    },
    stdio: "ignore",
  });

const post = async (idempotencyKey: string, signal?: AbortSignal): Promise<Response> =>
  await fetch(`${baseUrl}/v1/process`, {
    method: "POST",
    headers: {
      authorization: `ApiKey ${API_KEY}`,
      "idempotency-key": idempotencyKey,
      "content-type": "application/json",
    },
    body: JSON.stringify(anOperation()),
    ...(signal === undefined ? {} : { signal }),
  });

beforeAll(async () => {
  dynamo = createLocalDynamoClient();
  await ensureTable(dynamo, tableName);
  repository = new WorkflowRepository({
    client: createDocumentClient({
      region: "us-east-1",
      endpoint: LOCAL_DYNAMODB_ENDPOINT,
    }),
    tableName,
    clock: systemClock,
    workflowTtlDays: 90,
    outboxTtlDays: 7,
  });
  server = startServer();
  await waitForReady();
});

afterAll(async () => {
  server?.kill("SIGKILL");
  await dropTable(dynamo, tableName);
});

describe("client disconnect", () => {
  it("leaves the workflow running when the caller hangs up mid-wait", async () => {
    const idempotencyKey = `idem-${Date.now()}-disconnect`;
    const controller = new AbortController();

    const pending = post(idempotencyKey, controller.signal);
    await systemClock.sleep(400);
    controller.abort();

    await expect(pending).rejects.toThrow();

    // The workflow is unaffected: a second request with the same key recovers it, still
    // PROCESSING, with no state change caused by the disconnect (INV-51).
    const recovery = await post(idempotencyKey);
    expect(recovery.status).toBe(202);
    const body = (await recovery.json()) as { requestId: string; status: string };
    expect(body.status).toBe("PROCESSING");

    const workflow = await repository.getWorkflow(body.requestId as RequestId);
    expect(workflow?.status).toBe("PROCESSING");
    expect(workflow?.stateVersion).toBe(0);
  });

  it("still serves other callers after a disconnect", async () => {
    const controller = new AbortController();
    const abandoned = post(`idem-${Date.now()}-abandoned`, controller.signal);
    await systemClock.sleep(200);
    controller.abort();
    await expect(abandoned).rejects.toThrow();

    const healthy = await fetch(`${baseUrl}/health/ready`);
    expect(healthy.status).toBe(200);
  });
});

describe("SIGTERM", () => {
  it("drains cleanly, answers in-flight requests, and leaves workflows recoverable", async () => {
    const idempotencyKey = `idem-${Date.now()}-sigterm`;

    // A request is in flight, waiting on the synchronous deadline.
    const inFlight = post(idempotencyKey);
    await systemClock.sleep(500);

    const exited = new Promise<number | null>((resolve) => {
      server?.once("exit", (code) => {
        resolve(code);
      });
    });
    server?.kill("SIGTERM");

    // The in-flight request is answered rather than severed.
    const response = await inFlight;
    expect(response.status).toBe(202);
    const body = (await response.json()) as { requestId: string; status: string };
    expect(body.status).toBe("PROCESSING");

    const exitCode = await exited;
    expect(exitCode).toBe(0);

    // Terminating the task said nothing about the business operation (INV-12, INV-51).
    const workflow = await repository.getWorkflow(body.requestId as RequestId);
    expect(workflow?.status).toBe("PROCESSING");
    expect(workflow?.stateVersion).toBe(0);

    // And the work is still queued: the outbox event committed with the workflow.
    const pendingOutbox = await repository.listPendingOutbox(-1, 100);
    expect(pendingOutbox.some((event) => event.requestId === body.requestId)).toBe(
      true,
    );

    server = undefined;
  });
});
