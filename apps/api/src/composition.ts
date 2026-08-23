import { loadConfig, type Config } from "@workflow/config";
import { systemClock, type Clock } from "@workflow/contracts";
import { createLogger, createMetrics } from "@workflow/observability";
import {
  DynamoWorkflowWaiter,
  WorkflowRepository,
  createDocumentClient,
} from "@workflow/persistence";
import {
  InlineApiKeyStore,
  SecretsApiKeyStore,
  createSecretsManagerClient,
  type ApiKeyStore,
} from "./auth/api-key-store.js";
import { Lifecycle } from "./lifecycle.js";
import { buildApp, type AppDependencies } from "./app.js";

/**
 * The composition root. Everything the API needs is constructed here from validated
 * configuration, so handlers receive collaborators rather than reaching for globals, and
 * tests can substitute a clock or a key store without touching business code.
 */
export const buildDependencies = (
  config: Config,
  clock: Clock = systemClock,
): AppDependencies => {
  const logger = createLogger({
    level: config.logLevel,
    serviceName: config.serviceName,
    serviceVersion: config.serviceVersion,
    environment: config.env,
  });

  const documentClient = createDocumentClient({
    region: config.region,
    endpoint: config.persistence.endpoint,
  });

  if (config.persistence.tableName === undefined) {
    throw new Error("WORKFLOW_TABLE_NAME is required");
  }

  const repository = new WorkflowRepository({
    client: documentClient,
    tableName: config.persistence.tableName,
    clock,
    workflowTtlDays: config.business.workflowTtlDays,
    outboxTtlDays: config.business.outboxTtlDays,
  });

  const { inlineKeys, secretId } = config.auth;
  let apiKeys: ApiKeyStore;
  if (inlineKeys !== undefined) {
    apiKeys = new InlineApiKeyStore(inlineKeys, clock);
  } else if (secretId !== undefined) {
    apiKeys = new SecretsApiKeyStore({
      secretId,
      client: createSecretsManagerClient({ region: config.region }),
      clock,
      cacheTtlMs: config.auth.cacheTtlMs,
      negativeCacheMs: config.auth.negativeCacheMs,
    });
  } else {
    // loadConfig already enforces this; failing here too means a hand-built Config
    // cannot quietly produce a store that authenticates nobody.
    throw new Error("API_KEYS_SECRET_ID or API_KEYS_INLINE is required");
  }

  return {
    config,
    logger,
    metrics: createMetrics(logger),
    repository,
    waiter: new DynamoWorkflowWaiter({
      repository,
      clock,
      polling: config.polling,
    }),
    apiKeys,
    lifecycle: new Lifecycle(),
    clock,
  };
};

export const buildApiFromEnv = (env: NodeJS.ProcessEnv = process.env) => {
  const config = loadConfig("api", env);
  const dependencies = buildDependencies(config);
  return { app: buildApp(dependencies), dependencies };
};
