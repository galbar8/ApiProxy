import { describe, expect, it } from "vitest";
import { createLogger, serializeError } from "./logger.js";
import { withCorrelation } from "./context.js";

const captureLines = (): {
  lines: string[];
  destination: { write(msg: string): void };
} => {
  const lines: string[] = [];
  return { lines, destination: { write: (msg: string) => void lines.push(msg) } };
};

const makeLogger = () => {
  const { lines, destination } = captureLines();
  const logger = createLogger({
    level: "debug",
    serviceName: "test",
    serviceVersion: "1.0.0",
    environment: "local",
    destination,
  });
  return { logger, lines };
};

describe("logger redaction", () => {
  it("never emits a raw API key from an authorization header", () => {
    const { logger, lines } = makeLogger();
    logger.info({ headers: { authorization: "ApiKey super-secret-value" } }, "inbound");
    const output = lines.join("");
    expect(output).not.toContain("super-secret-value");
    expect(output).toContain("[REDACTED]");
  });

  it.each(["apiKey", "secret", "token", "password"])(
    "redacts a top-level %s field",
    (field) => {
      const { logger, lines } = makeLogger();
      logger.info({ [field]: "leak-me" }, "test");
      expect(lines.join("")).not.toContain("leak-me");
    },
  );

  it("redacts credentials nested under a request object", () => {
    const { logger, lines } = makeLogger();
    logger.info({ req: { headers: { authorization: "ApiKey leak-me" } } }, "test");
    expect(lines.join("")).not.toContain("leak-me");
  });

  it("keeps ordinary business fields intact", () => {
    const { logger, lines } = makeLogger();
    logger.info({ requestId: "abc", status: "COMPLETED" }, "done");
    expect(lines.join("")).toContain("COMPLETED");
  });
});

describe("correlation", () => {
  it("attaches ambient correlation fields to every line", () => {
    const { logger, lines } = makeLogger();
    withCorrelation({ requestId: "req-1", tenantId: "acme", step: "ENRICH" }, () => {
      logger.info("working");
    });
    const line = JSON.parse(lines[0] ?? "{}") as Record<string, unknown>;
    expect(line["requestId"]).toBe("req-1");
    expect(line["tenantId"]).toBe("acme");
    expect(line["step"]).toBe("ENRICH");
  });

  it("does not leak correlation outside its scope", () => {
    const { logger, lines } = makeLogger();
    withCorrelation({ requestId: "req-1" }, () => {
      logger.info("inside");
    });
    logger.info("outside");
    const outside = JSON.parse(lines[1] ?? "{}") as Record<string, unknown>;
    expect(outside["requestId"]).toBeUndefined();
  });
});

describe("serializeError", () => {
  it("preserves the failure classification a retry decision depends on", () => {
    const error = Object.assign(new Error("boom"), {
      code: "PROVIDER_UNAVAILABLE",
      failureClass: "RETRYABLE",
    });
    const serialized = serializeError(error);
    expect(serialized["errorCode"]).toBe("PROVIDER_UNAVAILABLE");
    expect(serialized["failureClass"]).toBe("RETRYABLE");
  });

  it("handles a thrown non-Error without losing the message", () => {
    expect(serializeError("plain string")["message"]).toBe("plain string");
  });
});
