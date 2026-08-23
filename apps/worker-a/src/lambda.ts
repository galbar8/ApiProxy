import { loadConfig, requireTableName } from "@workflow/config";
import { systemClock } from "@workflow/contracts";
import { createLogger, createMetrics } from "@workflow/observability";
import { WorkflowRepository, createDocumentClient } from "@workflow/persistence";
import { createWorkerAHandler } from "./handler.js";

/**
 * Built once per execution environment, not per invocation: clients and connection pools
 * are reused across warm invocations, and a misconfigured function fails on cold start
 * rather than on its first message.
 */
const config = loadConfig("worker");
const logger = createLogger({
  level: config.logLevel,
  serviceName: `${config.serviceName}-worker-a`,
  serviceVersion: config.serviceVersion,
  environment: config.env,
});

const repository = new WorkflowRepository({
  client: createDocumentClient({
    region: config.region,
    endpoint: config.persistence.endpoint,
  }),
  tableName: requireTableName(config),
  clock: systemClock,
  workflowTtlDays: config.business.workflowTtlDays,
  outboxTtlDays: config.business.outboxTtlDays,
});

export const handler = createWorkerAHandler({
  repository,
  logger,
  metrics: createMetrics(logger),
  clock: systemClock,
});

export * from "./enrich.js";
