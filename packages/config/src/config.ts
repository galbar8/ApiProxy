import { z } from "zod";

/**
 * Every tunable value in the service is declared here and nowhere else.
 *
 * Two rules make this file load-bearing rather than decorative:
 *
 *  1. Business logic never reads `process.env` and never hardcodes a timeout. If a value
 *     can vary between local, dev, staging and production, it is an entry in
 *     `configSchema`.
 *  2. Configuration is validated at startup, including the *relationships* between
 *     values. A timeout ladder that is not strictly increasing is a fatal startup error,
 *     not a 502 discovered under load.
 *
 * `SYNC_WAIT_TIMEOUT_MS` is the alignment knob. It is how long the API is willing to hold
 * a request open waiting for the workflow to reach a terminal state, and it must sit
 * comfortably below the timeout of whatever is calling us, so that we return a controlled
 * `202` before the caller gives up. Every other timeout derives its margin from it.
 */

const ENVIRONMENTS = ["local", "dev", "staging", "production"] as const;
export type Environment = (typeof ENVIRONMENTS)[number];

export const ROLES = ["api", "worker", "publisher", "reconciler"] as const;
export type Role = (typeof ROLES)[number];

const millis = (defaultValue: number) =>
  z.coerce.number().int().positive().max(3_600_000).default(defaultValue);

const bytes = (defaultValue: number) =>
  z.coerce.number().int().positive().max(400_000).default(defaultValue);

const nonEmpty = z.string().trim().min(1);

/**
 * The raw environment contract. Names here are exactly the environment variable names,
 * so grepping for a variable finds its definition, its default and its constraints.
 */
export const configSchema = z
  .object({
    // ---- Runtime identity -------------------------------------------------
    APP_ENV: z.enum(ENVIRONMENTS).default("local"),
    SERVICE_NAME: nonEmpty.default("workflow-service"),
    SERVICE_VERSION: nonEmpty.default("0.0.0-dev"),
    AWS_REGION: nonEmpty.default("us-east-1"),
    LOG_LEVEL: z
      .enum(["fatal", "error", "warn", "info", "debug", "trace"])
      .default("info"),

    // ---- HTTP server ------------------------------------------------------
    PORT: z.coerce.number().int().min(1).max(65_535).default(8080),
    HOST: nonEmpty.default("0.0.0.0"),
    /** Public base URL used to build the `pollUrl` returned with a `202`. */
    PUBLIC_BASE_URL: nonEmpty.default("http://localhost:8080"),

    // ---- The timeout ladder (docs/adr/0007) -------------------------------
    /**
     * How long POST /v1/process waits for a terminal state before returning `202`.
     * Set this below the timeout of the API calling us. This is the primary knob.
     */
    SYNC_WAIT_TIMEOUT_MS: millis(20_000),
    /** Server-side hard stop for a single request. Must exceed the synchronous wait. */
    HTTP_REQUEST_TIMEOUT_MS: millis(22_000),
    /** Mirrors the ALB idle timeout configured in CDK; validated against it here. */
    ALB_IDLE_TIMEOUT_MS: millis(30_000),
    /**
     * Node's keep-alive timeout. Must exceed the ALB idle timeout so the ALB is always
     * the side that closes an idle connection; the reverse ordering produces sporadic
     * 502s under load.
     */
    HTTP_KEEP_ALIVE_TIMEOUT_MS: millis(35_000),
    HTTP_HEADERS_TIMEOUT_MS: millis(40_000),
    /** Documented for callers and echoed in `Retry-After` guidance. */
    CLIENT_RECOMMENDED_TIMEOUT_MS: millis(35_000),
    /** Drain budget after SIGTERM: long enough for an in-flight request to finish. */
    SHUTDOWN_DRAIN_MS: millis(25_000),
    /** Delay between failing readiness and refusing new work, so the ALB deregisters. */
    SHUTDOWN_READINESS_DELAY_MS: millis(5_000),

    // ---- Polling (docs/adr/0007) ------------------------------------------
    POLL_INITIAL_DELAY_MS: millis(50),
    POLL_MAX_DELAY_MS: millis(1_000),
    POLL_BACKOFF_FACTOR: z.coerce.number().min(1).max(10).default(1.6),
    POLL_JITTER_RATIO: z.coerce.number().min(0).max(1).default(0.2),

    // ---- Business ---------------------------------------------------------
    /** How long the workflow itself may take. Independent of any HTTP deadline. */
    BUSINESS_DEADLINE_MS: millis(300_000),
    MAX_REQUEST_PAYLOAD_BYTES: bytes(120 * 1024),
    MAX_RESULT_BYTES: bytes(120 * 1024),
    WORKFLOW_TTL_DAYS: z.coerce.number().int().min(1).max(3_650).default(90),
    OUTBOX_TTL_DAYS: z.coerce.number().int().min(1).max(365).default(7),

    // ---- Persistence ------------------------------------------------------
    WORKFLOW_TABLE_NAME: nonEmpty.optional(),
    /** Local only: points the SDK at DynamoDB Local. Rejected outside `local`. */
    DYNAMODB_ENDPOINT: nonEmpty.optional(),

    // ---- Messaging --------------------------------------------------------
    START_QUEUE_URL: nonEmpty.optional(),
    STEP_QUEUE_URL: nonEmpty.optional(),
    /** Local only: points the SDK at ElasticMQ. Rejected outside `local`. */
    SQS_ENDPOINT: nonEmpty.optional(),

    // ---- Authentication (docs/adr/0002) -----------------------------------
    API_KEYS_SECRET_ID: nonEmpty.optional(),
    AUTH_CACHE_TTL_MS: millis(60_000),
    /** Cooldown after a failed lookup, so an invalid-key flood cannot flood Secrets Manager. */
    AUTH_NEGATIVE_CACHE_MS: millis(5_000),
    /**
     * Local/test only: an inline tenant key document, so tests need no AWS. Presenting
     * this outside `local` is a fatal configuration error, never a silent fallback.
     */
    API_KEYS_INLINE: z.string().optional(),

    // ---- External provider (docs/adr/0008) --------------------------------
    PROVIDER_BASE_URL: nonEmpty.optional(),
    PROVIDER_TIMEOUT_MS: millis(5_000),
    PROVIDER_CONNECT_TIMEOUT_MS: millis(2_000),

    // ---- Reconciler -------------------------------------------------------
    /** An outbox event unpublished for longer than this is republished. */
    OUTBOX_STALE_AFTER_MS: millis(60_000),
    RECONCILE_PAGE_SIZE: z.coerce.number().int().min(1).max(1_000).default(50),
    // There is deliberately no switch here for failing stale workflows. A deadline that
    // passed is not a business outcome, and no configuration may turn it into one
    // (INV-51, D-029). The reconciler reports and alarms; it never judges.
  })
  .transform((env) => ({
    env: env.APP_ENV,
    serviceName: env.SERVICE_NAME,
    serviceVersion: env.SERVICE_VERSION,
    region: env.AWS_REGION,
    logLevel: env.LOG_LEVEL,

    http: {
      port: env.PORT,
      host: env.HOST,
      publicBaseUrl: env.PUBLIC_BASE_URL.replace(/\/+$/, ""),
      syncWaitTimeoutMs: env.SYNC_WAIT_TIMEOUT_MS,
      requestTimeoutMs: env.HTTP_REQUEST_TIMEOUT_MS,
      albIdleTimeoutMs: env.ALB_IDLE_TIMEOUT_MS,
      keepAliveTimeoutMs: env.HTTP_KEEP_ALIVE_TIMEOUT_MS,
      headersTimeoutMs: env.HTTP_HEADERS_TIMEOUT_MS,
      clientRecommendedTimeoutMs: env.CLIENT_RECOMMENDED_TIMEOUT_MS,
      shutdownDrainMs: env.SHUTDOWN_DRAIN_MS,
      shutdownReadinessDelayMs: env.SHUTDOWN_READINESS_DELAY_MS,
    },

    polling: {
      initialDelayMs: env.POLL_INITIAL_DELAY_MS,
      maxDelayMs: env.POLL_MAX_DELAY_MS,
      backoffFactor: env.POLL_BACKOFF_FACTOR,
      jitterRatio: env.POLL_JITTER_RATIO,
    },

    business: {
      deadlineMs: env.BUSINESS_DEADLINE_MS,
      maxRequestPayloadBytes: env.MAX_REQUEST_PAYLOAD_BYTES,
      maxResultBytes: env.MAX_RESULT_BYTES,
      workflowTtlDays: env.WORKFLOW_TTL_DAYS,
      outboxTtlDays: env.OUTBOX_TTL_DAYS,
    },

    persistence: {
      tableName: env.WORKFLOW_TABLE_NAME,
      endpoint: env.DYNAMODB_ENDPOINT,
    },

    messaging: {
      startQueueUrl: env.START_QUEUE_URL,
      stepQueueUrl: env.STEP_QUEUE_URL,
      endpoint: env.SQS_ENDPOINT,
    },

    auth: {
      secretId: env.API_KEYS_SECRET_ID,
      cacheTtlMs: env.AUTH_CACHE_TTL_MS,
      negativeCacheMs: env.AUTH_NEGATIVE_CACHE_MS,
      inlineKeys: env.API_KEYS_INLINE,
    },

    provider: {
      baseUrl: env.PROVIDER_BASE_URL,
      timeoutMs: env.PROVIDER_TIMEOUT_MS,
      connectTimeoutMs: env.PROVIDER_CONNECT_TIMEOUT_MS,
    },

    reconciler: {
      outboxStaleAfterMs: env.OUTBOX_STALE_AFTER_MS,
      pageSize: env.RECONCILE_PAGE_SIZE,
    },
  }))
  .superRefine((config, ctx) => {
    const fail = (message: string, path: string): void => {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message, path: [path] });
    };

    // The ladder must be strictly increasing. Equal values are a race, not a margin.
    const { http, polling, business } = config;

    if (http.syncWaitTimeoutMs >= http.requestTimeoutMs) {
      fail(
        `SYNC_WAIT_TIMEOUT_MS (${http.syncWaitTimeoutMs}) must be strictly less than HTTP_REQUEST_TIMEOUT_MS (${http.requestTimeoutMs}), otherwise the server aborts the request before the waiter can return a controlled 202`,
        "SYNC_WAIT_TIMEOUT_MS",
      );
    }
    if (http.requestTimeoutMs >= http.albIdleTimeoutMs) {
      fail(
        `HTTP_REQUEST_TIMEOUT_MS (${http.requestTimeoutMs}) must be strictly less than ALB_IDLE_TIMEOUT_MS (${http.albIdleTimeoutMs}), otherwise the ALB returns 504 instead of our response`,
        "HTTP_REQUEST_TIMEOUT_MS",
      );
    }
    if (http.albIdleTimeoutMs >= http.keepAliveTimeoutMs) {
      fail(
        `HTTP_KEEP_ALIVE_TIMEOUT_MS (${http.keepAliveTimeoutMs}) must exceed ALB_IDLE_TIMEOUT_MS (${http.albIdleTimeoutMs}) so the ALB is always the side that closes an idle connection; the reverse ordering causes sporadic 502s`,
        "HTTP_KEEP_ALIVE_TIMEOUT_MS",
      );
    }
    if (http.headersTimeoutMs < http.keepAliveTimeoutMs) {
      fail(
        `HTTP_HEADERS_TIMEOUT_MS (${http.headersTimeoutMs}) must be at least HTTP_KEEP_ALIVE_TIMEOUT_MS (${http.keepAliveTimeoutMs})`,
        "HTTP_HEADERS_TIMEOUT_MS",
      );
    }
    if (http.clientRecommendedTimeoutMs <= http.albIdleTimeoutMs) {
      fail(
        `CLIENT_RECOMMENDED_TIMEOUT_MS (${http.clientRecommendedTimeoutMs}) must exceed ALB_IDLE_TIMEOUT_MS (${http.albIdleTimeoutMs}); callers must not give up before the ALB would`,
        "CLIENT_RECOMMENDED_TIMEOUT_MS",
      );
    }
    if (http.shutdownDrainMs < http.requestTimeoutMs) {
      fail(
        `SHUTDOWN_DRAIN_MS (${http.shutdownDrainMs}) must be at least HTTP_REQUEST_TIMEOUT_MS (${http.requestTimeoutMs}) so an in-flight request can finish during drain`,
        "SHUTDOWN_DRAIN_MS",
      );
    }
    if (http.shutdownReadinessDelayMs >= http.shutdownDrainMs) {
      fail(
        `SHUTDOWN_READINESS_DELAY_MS (${http.shutdownReadinessDelayMs}) must be less than SHUTDOWN_DRAIN_MS (${http.shutdownDrainMs})`,
        "SHUTDOWN_READINESS_DELAY_MS",
      );
    }

    if (polling.initialDelayMs > polling.maxDelayMs) {
      fail(
        `POLL_INITIAL_DELAY_MS (${polling.initialDelayMs}) must not exceed POLL_MAX_DELAY_MS (${polling.maxDelayMs})`,
        "POLL_INITIAL_DELAY_MS",
      );
    }
    if (polling.maxDelayMs >= http.syncWaitTimeoutMs) {
      fail(
        `POLL_MAX_DELAY_MS (${polling.maxDelayMs}) must be less than SYNC_WAIT_TIMEOUT_MS (${http.syncWaitTimeoutMs}); a single sleep must never consume the whole budget`,
        "POLL_MAX_DELAY_MS",
      );
    }

    if (business.deadlineMs < http.syncWaitTimeoutMs) {
      fail(
        `BUSINESS_DEADLINE_MS (${business.deadlineMs}) must be at least SYNC_WAIT_TIMEOUT_MS (${http.syncWaitTimeoutMs}); the workflow must be allowed to outlive the HTTP wait`,
        "BUSINESS_DEADLINE_MS",
      );
    }
    if (business.maxResultBytes + business.maxRequestPayloadBytes > 380 * 1024) {
      fail(
        "MAX_REQUEST_PAYLOAD_BYTES + MAX_RESULT_BYTES must stay under 380KB to leave headroom below the 400KB DynamoDB item limit (ADR-0006)",
        "MAX_RESULT_BYTES",
      );
    }

    // Local-only escape hatches must never be active in a deployed environment.
    if (config.env !== "local") {
      if (config.auth.inlineKeys !== undefined) {
        fail(
          "API_KEYS_INLINE is a local-only test affordance and must not be set outside APP_ENV=local; use API_KEYS_SECRET_ID",
          "API_KEYS_INLINE",
        );
      }
      if (config.persistence.endpoint !== undefined) {
        fail(
          "DYNAMODB_ENDPOINT must not be set outside APP_ENV=local",
          "DYNAMODB_ENDPOINT",
        );
      }
      if (config.messaging.endpoint !== undefined) {
        fail("SQS_ENDPOINT must not be set outside APP_ENV=local", "SQS_ENDPOINT");
      }
    }
  });

export type Config = z.infer<typeof configSchema>;

/**
 * What each deployable must have before it is allowed to start. Requirements differ:
 * notably the API never publishes to SQS (the outbox does), so it needs no queue URL and
 * its task role needs no SQS permission at all.
 */
type Requirement =
  | "WORKFLOW_TABLE_NAME"
  | "START_QUEUE_URL"
  | "STEP_QUEUE_URL"
  | "PROVIDER_BASE_URL"
  | "API_KEYS_SECRET_ID_OR_INLINE";

const REQUIRED_BY_ROLE: Record<Role, readonly Requirement[]> = {
  api: ["WORKFLOW_TABLE_NAME", "API_KEYS_SECRET_ID_OR_INLINE"],
  worker: ["WORKFLOW_TABLE_NAME", "PROVIDER_BASE_URL"],
  publisher: ["WORKFLOW_TABLE_NAME", "START_QUEUE_URL", "STEP_QUEUE_URL"],
  reconciler: ["WORKFLOW_TABLE_NAME", "START_QUEUE_URL", "STEP_QUEUE_URL"],
};

export class ConfigurationError extends Error {
  readonly issues: readonly string[];
  constructor(issues: readonly string[]) {
    super(`Invalid configuration:\n  - ${issues.join("\n  - ")}`);
    this.name = "ConfigurationError";
    this.issues = issues;
  }
}

const missingForRole = (role: Role, config: Config): string[] => {
  const issues: string[] = [];
  for (const requirement of REQUIRED_BY_ROLE[role]) {
    switch (requirement) {
      case "WORKFLOW_TABLE_NAME":
        if (config.persistence.tableName === undefined) {
          issues.push("WORKFLOW_TABLE_NAME is required");
        }
        break;
      case "START_QUEUE_URL":
        if (config.messaging.startQueueUrl === undefined) {
          issues.push("START_QUEUE_URL is required");
        }
        break;
      case "STEP_QUEUE_URL":
        if (config.messaging.stepQueueUrl === undefined) {
          issues.push("STEP_QUEUE_URL is required");
        }
        break;
      case "PROVIDER_BASE_URL":
        if (config.provider.baseUrl === undefined) {
          issues.push("PROVIDER_BASE_URL is required");
        }
        break;
      case "API_KEYS_SECRET_ID_OR_INLINE":
        if (
          config.auth.secretId === undefined &&
          config.auth.inlineKeys === undefined
        ) {
          issues.push(
            "API_KEYS_SECRET_ID is required (API_KEYS_INLINE is accepted only when APP_ENV=local)",
          );
        }
        break;
    }
  }
  return issues;
};

/**
 * Parse and validate configuration for one deployable. Throws on any problem: a process
 * that cannot be configured correctly must not start and silently fall back to an unsafe
 * default.
 */
export const loadConfig = (
  role: Role,
  env: NodeJS.ProcessEnv = process.env,
): Config => {
  const parsed = configSchema.safeParse(env);
  if (!parsed.success) {
    throw new ConfigurationError(
      parsed.error.issues.map(
        (issue) => `${issue.path.join(".") || "(config)"}: ${issue.message}`,
      ),
    );
  }

  const issues = missingForRole(role, parsed.data);
  if (issues.length > 0) {
    throw new ConfigurationError(issues.map((issue) => `${role}: ${issue}`));
  }
  return parsed.data;
};

/** Narrowed accessors so call sites do not repeat undefined checks after startup. */
export const requireTableName = (config: Config): string => {
  if (config.persistence.tableName === undefined) {
    throw new ConfigurationError(["WORKFLOW_TABLE_NAME is required"]);
  }
  return config.persistence.tableName;
};

export const requireQueueUrl = (
  config: Config,
  destination: "START_QUEUE" | "STEP_QUEUE",
): string => {
  const url =
    destination === "START_QUEUE"
      ? config.messaging.startQueueUrl
      : config.messaging.stepQueueUrl;
  if (url === undefined) {
    throw new ConfigurationError([`${destination} URL is required`]);
  }
  return url;
};

export const requireProviderBaseUrl = (config: Config): string => {
  if (config.provider.baseUrl === undefined) {
    throw new ConfigurationError(["PROVIDER_BASE_URL is required"]);
  }
  return config.provider.baseUrl;
};
