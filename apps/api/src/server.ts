import { systemClock } from "@workflow/contracts";
import { serializeError } from "@workflow/observability";
import { buildApiFromEnv } from "./composition.js";

/**
 * Process entry point.
 *
 * Configuration is validated before anything is constructed, so a misconfigured task
 * exits immediately instead of serving traffic with unsafe defaults (GOAL section 33).
 */
const main = async (): Promise<void> => {
  const { app, dependencies } = buildApiFromEnv();
  const { config, logger, lifecycle } = dependencies;

  // Node must not be the side that closes an idle keep-alive connection; the ALB must be.
  // The ordering is validated in config, and applied to the raw server here.
  app.server.keepAliveTimeout = config.http.keepAliveTimeoutMs;
  app.server.headersTimeout = config.http.headersTimeoutMs;

  await app.listen({ host: config.http.host, port: config.http.port });
  lifecycle.markReady();
  logger.info(
    {
      port: config.http.port,
      syncWaitTimeoutMs: config.http.syncWaitTimeoutMs,
      requestTimeoutMs: config.http.requestTimeoutMs,
      keepAliveTimeoutMs: config.http.keepAliveTimeoutMs,
    },
    "api ready",
  );

  let shuttingDown = false;

  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, "shutdown requested");

    // 1. Fail readiness first, so the load balancer stops sending new requests.
    lifecycle.beginDrain(logger);

    // 2. Give the ALB time to observe the failed health check and deregister. Existing
    //    connections keep working during this window.
    await systemClock.sleep(config.http.shutdownReadinessDelayMs);

    // 3. End synchronous waits deliberately: each returns a controlled 202 rather than a
    //    severed connection. The workflows themselves are untouched (INV-51).
    lifecycle.abortWaits(logger);

    // 4. Let in-flight requests finish, bounded by the drain budget.
    const drain = app.close();
    const timeout = systemClock
      .sleep(config.http.shutdownDrainMs)
      .then(() => "timeout" as const);

    const outcome = await Promise.race([drain.then(() => "drained" as const), timeout]);
    lifecycle.markStopped();
    logger.info({ outcome }, "shutdown complete");

    // Business correctness never depended on any of this succeeding: every workflow is
    // durable in DynamoDB and every pending publication is an outbox event (INV-12).
    process.exit(0);
  };

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
};

main().catch((error: unknown) => {
  process.stderr.write(
    `${JSON.stringify({ level: "fatal", msg: "api failed to start", err: serializeError(error) })}\n`,
  );
  process.exit(1);
});
