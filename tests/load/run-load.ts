import { createHash } from "node:crypto";
import { loadConfig } from "@workflow/config";
import { systemClock } from "@workflow/contracts";
import { buildApp, buildDependencies } from "@workflow/api";
import {
  LOCAL_DYNAMODB_ENDPOINT,
  anOperation,
  createLocalDynamoClient,
  dropTable,
  ensureTable,
  uniqueTableName,
} from "@workflow/testing";
import { createLocalPipeline } from "../support/pipeline.js";

/**
 * A small, dependency-free load probe.
 *
 * Its purpose is not to benchmark AWS — it cannot, running against local emulators. It
 * measures the shape that matters: how latency and the synchronous-timeout rate move as
 * concurrency rises, so the timeout ladder can be tuned against evidence rather than
 * intuition. Absolute numbers here are not predictions about production.
 */
const REQUESTS = Number(process.env["LOAD_REQUESTS"] ?? 200);
const CONCURRENCY = Number(process.env["LOAD_CONCURRENCY"] ?? 20);
const API_KEY = "load-test-key-0123456789";

const percentile = (sorted: number[], p: number): number =>
  sorted.length === 0
    ? 0
    : (sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] ?? 0);

const main = async (): Promise<void> => {
  const tableName = uniqueTableName("load");
  const dynamo = createLocalDynamoClient();
  await ensureTable(dynamo, tableName);

  const keyDocument = JSON.stringify({
    tenants: [
      {
        tenantId: "acme",
        status: "active",
        keys: [
          {
            kid: "k1",
            hash: createHash("sha256").update(API_KEY, "utf8").digest("hex"),
          },
        ],
      },
    ],
  });

  const config = loadConfig("api", {
    APP_ENV: "local",
    LOG_LEVEL: "fatal",
    WORKFLOW_TABLE_NAME: tableName,
    DYNAMODB_ENDPOINT: LOCAL_DYNAMODB_ENDPOINT,
    API_KEYS_INLINE: keyDocument,
    SYNC_WAIT_TIMEOUT_MS: process.env["LOAD_SYNC_WAIT_MS"] ?? "3000",
    HTTP_REQUEST_TIMEOUT_MS: "8000",
    ALB_IDLE_TIMEOUT_MS: "12000",
    HTTP_KEEP_ALIVE_TIMEOUT_MS: "15000",
    HTTP_HEADERS_TIMEOUT_MS: "20000",
    CLIENT_RECOMMENDED_TIMEOUT_MS: "20000",
    SHUTDOWN_DRAIN_MS: "10000",
  });

  const dependencies = buildDependencies(config, systemClock);
  dependencies.lifecycle.markReady();
  const app = buildApp(dependencies);
  await app.ready();

  // A pipeline over the same table so workflows actually complete while requests wait.
  const pipeline = await createLocalPipeline({ tableName });

  // A holder rather than a bare `let`, so the flag is visibly shared with the loop.
  const control = { stop: false };
  const workers = (async (): Promise<void> => {
    while (!control.stop) {
      await pipeline.tick();
      await systemClock.sleep(20);
    }
  })();

  const latencies: number[] = [];
  const outcomes = new Map<number, number>();
  let cursor = 0;

  const runner = async (): Promise<void> => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= REQUESTS) return;

      const startedAt = Date.now();
      const response = await app.inject({
        method: "POST",
        url: "/v1/process",
        payload: anOperation({ reference: `load-${String(index)}` }),
        headers: {
          authorization: `ApiKey ${API_KEY}`,
          "idempotency-key": `idem-load-${String(index)}-${String(startedAt)}`,
        },
      });
      latencies.push(Date.now() - startedAt);
      outcomes.set(response.statusCode, (outcomes.get(response.statusCode) ?? 0) + 1);
    }
  };

  const startedAt = Date.now();
  await Promise.all(Array.from({ length: CONCURRENCY }, runner));
  const elapsedMs = Date.now() - startedAt;

  control.stop = true;
  await workers;

  const sorted = [...latencies].sort((left, right) => left - right);
  const timeouts = outcomes.get(202) ?? 0;

  process.stdout.write(
    `${JSON.stringify(
      {
        requests: REQUESTS,
        concurrency: CONCURRENCY,
        elapsedMs,
        throughputPerSecond: Number(((REQUESTS / elapsedMs) * 1000).toFixed(1)),
        latencyMs: {
          p50: percentile(sorted, 50),
          p95: percentile(sorted, 95),
          p99: percentile(sorted, 99),
          max: sorted.at(-1) ?? 0,
        },
        statusCodes: Object.fromEntries(outcomes),
        syncTimeoutRate: Number((timeouts / REQUESTS).toFixed(3)),
        note: "local emulators; measures shape and regressions, not AWS capacity",
      },
      null,
      2,
    )}\n`,
  );

  await app.close();
  await pipeline.close();
  await dropTable(dynamo, tableName);

  // A synchronous façade whose requests all time out is not working, whatever the
  // latency numbers say.
  if (timeouts / REQUESTS > 0.5) {
    process.stderr.write(
      "more than half of requests exceeded the synchronous deadline\n",
    );
    process.exit(1);
  }
};

await main();
