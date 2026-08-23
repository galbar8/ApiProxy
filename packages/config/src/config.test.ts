import { describe, expect, it } from "vitest";
import { ConfigurationError, configSchema, loadConfig } from "./config.js";

const baseEnv = {
  APP_ENV: "production",
  WORKFLOW_TABLE_NAME: "workflow",
  START_QUEUE_URL: "https://sqs.example/start",
  STEP_QUEUE_URL: "https://sqs.example/step",
  API_KEYS_SECRET_ID: "workflow/api-keys",
  PROVIDER_BASE_URL: "https://provider.example",
} satisfies NodeJS.ProcessEnv;

const issuesOf = (env: NodeJS.ProcessEnv): string[] => {
  const result = configSchema.safeParse(env);
  return result.success ? [] : result.error.issues.map((issue) => issue.message);
};

describe("configSchema defaults", () => {
  it("produces a strictly increasing timeout ladder out of the box", () => {
    const config = configSchema.parse({});
    expect(config.http.syncWaitTimeoutMs).toBeLessThan(config.http.requestTimeoutMs);
    expect(config.http.requestTimeoutMs).toBeLessThan(config.http.albIdleTimeoutMs);
    expect(config.http.albIdleTimeoutMs).toBeLessThan(config.http.keepAliveTimeoutMs);
    expect(config.http.clientRecommendedTimeoutMs).toBeGreaterThan(
      config.http.albIdleTimeoutMs,
    );
  });

  it("coerces numeric strings from the environment", () => {
    const config = configSchema.parse({ SYNC_WAIT_TIMEOUT_MS: "5000", PORT: "9090" });
    expect(config.http.syncWaitTimeoutMs).toBe(5000);
    expect(config.http.port).toBe(9090);
  });

  it("treats 'false' as false rather than as a truthy string", () => {
    expect(
      configSchema.parse({ RECONCILE_FAIL_STALE_WORKFLOWS: "false" }).reconciler
        .failStaleWorkflows,
    ).toBe(false);
    expect(
      configSchema.parse({ RECONCILE_FAIL_STALE_WORKFLOWS: "true" }).reconciler
        .failStaleWorkflows,
    ).toBe(true);
  });

  it("does not auto-fail stale workflows by default (INV-51)", () => {
    expect(configSchema.parse({}).reconciler.failStaleWorkflows).toBe(false);
  });
});

describe("timeout ladder validation", () => {
  it("rejects a synchronous wait that is not below the request budget", () => {
    const issues = issuesOf({
      SYNC_WAIT_TIMEOUT_MS: "22000",
      HTTP_REQUEST_TIMEOUT_MS: "22000",
    });
    expect(issues.join(" ")).toContain(
      "must be strictly less than HTTP_REQUEST_TIMEOUT_MS",
    );
  });

  it("rejects a request budget at or above the ALB idle timeout", () => {
    const issues = issuesOf({
      HTTP_REQUEST_TIMEOUT_MS: "30000",
      ALB_IDLE_TIMEOUT_MS: "30000",
    });
    expect(issues.join(" ")).toContain(
      "must be strictly less than ALB_IDLE_TIMEOUT_MS",
    );
  });

  it("rejects a keep-alive timeout below the ALB idle timeout, which causes 502s", () => {
    const issues = issuesOf({
      ALB_IDLE_TIMEOUT_MS: "35000",
      HTTP_KEEP_ALIVE_TIMEOUT_MS: "30000",
    });
    expect(issues.join(" ")).toContain("must exceed ALB_IDLE_TIMEOUT_MS");
  });

  it("rejects a client recommendation that gives up before the ALB would", () => {
    const issues = issuesOf({ CLIENT_RECOMMENDED_TIMEOUT_MS: "10000" });
    expect(issues.join(" ")).toContain("CLIENT_RECOMMENDED_TIMEOUT_MS");
  });

  it("rejects a drain budget shorter than a single request", () => {
    const issues = issuesOf({ SHUTDOWN_DRAIN_MS: "1000" });
    expect(issues.join(" ")).toContain("SHUTDOWN_DRAIN_MS");
  });

  it("rejects a poll delay that could consume the whole synchronous budget", () => {
    const issues = issuesOf({
      POLL_MAX_DELAY_MS: "20000",
      SYNC_WAIT_TIMEOUT_MS: "20000",
    });
    expect(issues.join(" ")).toContain("POLL_MAX_DELAY_MS");
  });

  it("rejects a business deadline shorter than the synchronous wait", () => {
    const issues = issuesOf({ BUSINESS_DEADLINE_MS: "1000" });
    expect(issues.join(" ")).toContain("BUSINESS_DEADLINE_MS");
  });

  it("rejects size caps that would breach the DynamoDB item limit", () => {
    const issues = issuesOf({
      MAX_REQUEST_PAYLOAD_BYTES: "200000",
      MAX_RESULT_BYTES: "200000",
    });
    expect(issues.join(" ")).toContain("380KB");
  });
});

describe("local-only escape hatches", () => {
  it("accepts inline keys and local endpoints when APP_ENV=local", () => {
    const config = configSchema.parse({
      APP_ENV: "local",
      API_KEYS_INLINE: "{}",
      DYNAMODB_ENDPOINT: "http://localhost:8000",
      SQS_ENDPOINT: "http://localhost:9324",
    });
    expect(config.auth.inlineKeys).toBe("{}");
  });

  it.each(["dev", "staging", "production"])(
    "refuses inline API keys when APP_ENV=%s",
    (env) => {
      expect(issuesOf({ APP_ENV: env, API_KEYS_INLINE: "{}" }).join(" ")).toContain(
        "API_KEYS_INLINE",
      );
    },
  );

  it("refuses a local DynamoDB endpoint outside local", () => {
    expect(
      issuesOf({
        APP_ENV: "production",
        DYNAMODB_ENDPOINT: "http://localhost:8000",
      }).join(" "),
    ).toContain("DYNAMODB_ENDPOINT");
  });

  it("refuses a local SQS endpoint outside local", () => {
    expect(
      issuesOf({ APP_ENV: "production", SQS_ENDPOINT: "http://localhost:9324" }).join(
        " ",
      ),
    ).toContain("SQS_ENDPOINT");
  });
});

describe("loadConfig role requirements", () => {
  it("starts the api with a table and a secret", () => {
    expect(() => loadConfig("api", baseEnv)).not.toThrow();
  });

  it("fails the api when no credential source is configured", () => {
    const { API_KEYS_SECRET_ID: _omitted, ...env } = baseEnv;
    expect(() => loadConfig("api", env)).toThrow(ConfigurationError);
  });

  it("fails rather than falling back when the table name is missing", () => {
    const { WORKFLOW_TABLE_NAME: _omitted, ...env } = baseEnv;
    expect(() => loadConfig("worker", env)).toThrow(/WORKFLOW_TABLE_NAME is required/);
  });

  it("does not require queue URLs for the api, which never publishes to SQS", () => {
    const { START_QUEUE_URL: _a, STEP_QUEUE_URL: _b, ...env } = baseEnv;
    expect(() => loadConfig("api", env)).not.toThrow();
  });

  it("requires both queue URLs for the publisher", () => {
    const { STEP_QUEUE_URL: _omitted, ...env } = baseEnv;
    expect(() => loadConfig("publisher", env)).toThrow(/STEP_QUEUE_URL is required/);
  });

  it("requires the provider base url for the worker role", () => {
    const { PROVIDER_BASE_URL: _omitted, ...env } = baseEnv;
    expect(() => loadConfig("worker", env)).toThrow(/PROVIDER_BASE_URL is required/);
  });

  it("reports every configuration problem at once", () => {
    try {
      loadConfig("api", { SYNC_WAIT_TIMEOUT_MS: "999999" });
      expect.unreachable("expected a ConfigurationError");
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigurationError);
      expect((error as ConfigurationError).issues.length).toBeGreaterThan(0);
    }
  });
});
