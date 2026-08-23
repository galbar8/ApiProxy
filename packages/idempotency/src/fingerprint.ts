import { createHash } from "node:crypto";

/**
 * Canonical JSON: object keys sorted recursively, no incidental whitespace. Two requests
 * that differ only in key order or formatting are the same logical request; two that
 * differ in a material value are not.
 */
export const canonicalize = (value: unknown): string => {
  if (value === null || value === undefined) return "null";
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(",")}]`;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entryValue]) => entryValue !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, entryValue]) => `${JSON.stringify(key)}:${canonicalize(entryValue)}`);
    return `{${entries.join(",")}}`;
  }
  if (typeof value === "number" && !Number.isFinite(value)) {
    throw new TypeError("cannot fingerprint a non-finite number");
  }
  return JSON.stringify(value);
};

const sha256Hex = (input: string): string =>
  createHash("sha256").update(input, "utf8").digest("hex");

/**
 * Fingerprint of the material business input. Volatile fields (timestamps, trace ids,
 * connection metadata) are never part of the request schema, so they cannot leak in here
 * and make two identical retries look different.
 */
export const payloadFingerprint = (payload: unknown): string =>
  sha256Hex(canonicalize(payload));

/**
 * Deterministic outbox event identity. A replay of the same state transition produces the
 * same event id rather than a new event, which is what makes outbox publication
 * duplicate-safe (INV-44).
 */
export const deriveEventId = (
  requestId: string,
  step: string,
  workflowVersion: number,
): string => sha256Hex(`${requestId}|${step}|${String(workflowVersion)}`);

/**
 * Stable external-operation reference. Derived, not random, so a retry after
 * UNKNOWN_EXTERNAL_STATE reuses the same identity at the provider (INV-63).
 */
export const deriveExternalRef = (requestId: string, stepId: string): string =>
  sha256Hex(`external|${requestId}|${stepId}`);
