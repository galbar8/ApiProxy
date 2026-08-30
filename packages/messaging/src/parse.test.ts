import { describe, expect, it } from "vitest";
import { parseWorkflowMessage } from "./parse.js";

const validMessage = {
  messageId: "a".repeat(64),
  requestId: "3f2504e0-4f89-41d3-9a0c-0305e82c3301",
  tenantId: "acme",
  workflowVersion: 1,
  createdAt: 1_700_000_000_000,
  step: "ENRICH",
  payload: {},
};

describe("parseWorkflowMessage", () => {
  it("parses a well-formed message", () => {
    expect(parseWorkflowMessage(JSON.stringify(validMessage)).requestId).toBe(
      validMessage.requestId,
    );
  });

  it("classifies malformed JSON as non-retryable, not as a transient failure", () => {
    try {
      parseWorkflowMessage("{not json");
      expect.unreachable("expected a throw");
    } catch (error) {
      expect((error as { failureClass: string }).failureClass).toBe("NON_RETRYABLE");
    }
  });

  it("rejects a message missing required correlation fields", () => {
    const { requestId: _omitted, ...broken } = validMessage;
    expect(() => parseWorkflowMessage(JSON.stringify(broken))).toThrow(
      /schema validation/,
    );
  });

  it("rejects an unknown step instead of guessing", () => {
    expect(() =>
      parseWorkflowMessage(
        JSON.stringify({ ...validMessage, step: "DELETE_EVERYTHING" }),
      ),
    ).toThrow(/schema validation/);
  });

  it("rejects extra fields smuggled into a payload", () => {
    expect(() =>
      parseWorkflowMessage(
        JSON.stringify({ ...validMessage, payload: { queueUrl: "http://evil" } }),
      ),
    ).toThrow(/schema validation/);
  });

  it("rejects a JSON array, which would otherwise parse", () => {
    expect(() => parseWorkflowMessage("[]")).toThrow(/schema validation/);
  });
});
