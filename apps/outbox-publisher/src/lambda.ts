import { loadConfig, requireQueueUrl, requireTableName } from "@workflow/config";
import { systemClock } from "@workflow/contracts";
import { createLogger, createMetrics } from "@workflow/observability";
import { SqsMessagePublisher, createSqsClient } from "@workflow/messaging";
import { WorkflowRepository, createDocumentClient } from "@workflow/persistence";
import { createOutboxPublisherHandler } from "./handler.js";

const config = loadConfig("publisher");
const logger = createLogger({
  level: config.logLevel,
  serviceName: `${config.serviceName}-outbox-publisher`,
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

export const handler = createOutboxPublisherHandler({
  repository,
  publisher: new SqsMessagePublisher({
    client: createSqsClient({
      region: config.region,
      endpoint: config.messaging.endpoint,
    }),
    queueUrls: {
      START_QUEUE: requireQueueUrl(config, "START_QUEUE"),
      STEP_QUEUE: requireQueueUrl(config, "STEP_QUEUE"),
    },
  }),
  logger,
  metrics: createMetrics(logger),
});
