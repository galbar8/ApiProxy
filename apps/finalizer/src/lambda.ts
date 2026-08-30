import { loadConfig, requireProviderBaseUrl, requireTableName } from "@workflow/config";
import { systemClock } from "@workflow/contracts";
import { createLogger, createMetrics } from "@workflow/observability";
import { WorkflowRepository, createDocumentClient } from "@workflow/persistence";
import { createFinalizerHandler } from "./handler.js";
import { HttpProviderClient } from "./provider-client.js";

const config = loadConfig("worker");
const logger = createLogger({
  level: config.logLevel,
  serviceName: `${config.serviceName}-finalizer`,
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

export const handler = createFinalizerHandler({
  repository,
  provider: new HttpProviderClient({
    baseUrl: requireProviderBaseUrl(config),
    timeoutMs: config.provider.timeoutMs,
  }),
  logger,
  metrics: createMetrics(logger),
  clock: systemClock,
  maxResultBytes: config.business.maxResultBytes,
});

export * from "./provider-client.js";
