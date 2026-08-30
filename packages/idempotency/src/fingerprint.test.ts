import { describe, expect, it } from "vitest";
import {
  canonicalize,
  deriveEventId,
  deriveExternalRef,
  payloadFingerprint,
} from "./fingerprint.js";

describe("payloadFingerprint", () => {
  it("is stable across key ordering", () => {
    const a = { operation: "CHARGE", amount: { currencyCode: "USD", minorUnits: 100 } };
    const b = { amount: { minorUnits: 100, currencyCode: "USD" }, operation: "CHARGE" };
    expect(payloadFingerprint(a)).toBe(payloadFingerprint(b));
  });

  it("changes when a material value changes", () => {
    const base = { amount: { currencyCode: "USD", minorUnits: 100 } };
    const changed = { amount: { currencyCode: "USD", minorUnits: 101 } };
    expect(payloadFingerprint(base)).not.toBe(payloadFingerprint(changed));
  });

  it("distinguishes a currency change, not only an amount change", () => {
    expect(
      payloadFingerprint({ amount: { currencyCode: "USD", minorUnits: 100 } }),
    ).not.toBe(
      payloadFingerprint({ amount: { currencyCode: "EUR", minorUnits: 100 } }),
    );
  });

  it("distinguishes a missing field from a null field", () => {
    expect(payloadFingerprint({ a: 1 })).not.toBe(
      payloadFingerprint({ a: 1, b: null }),
    );
  });

  it("ignores undefined properties, which JSON would drop anyway", () => {
    expect(payloadFingerprint({ a: 1, b: undefined })).toBe(
      payloadFingerprint({ a: 1 }),
    );
  });

  it("preserves array order, which is material", () => {
    expect(payloadFingerprint({ items: [1, 2] })).not.toBe(
      payloadFingerprint({ items: [2, 1] }),
    );
  });

  it('does not confuse the string "1" with the number 1', () => {
    expect(payloadFingerprint({ a: 1 })).not.toBe(payloadFingerprint({ a: "1" }));
  });

  it("produces a 64-character hex digest", () => {
    expect(payloadFingerprint({ a: 1 })).toMatch(/^[0-9a-f]{64}$/);
  });

  it("refuses to fingerprint a non-finite number rather than hashing null", () => {
    expect(() => canonicalize({ a: Number.NaN })).toThrow(TypeError);
  });
});

describe("deterministic identities", () => {
  it("derives the same event id for the same transition", () => {
    expect(deriveEventId("req-1", "ENRICH", 1)).toBe(
      deriveEventId("req-1", "ENRICH", 1),
    );
  });

  it("derives different event ids per step and per workflow version", () => {
    expect(deriveEventId("req-1", "ENRICH", 1)).not.toBe(
      deriveEventId("req-1", "FINALIZE", 1),
    );
    expect(deriveEventId("req-1", "ENRICH", 1)).not.toBe(
      deriveEventId("req-1", "ENRICH", 2),
    );
  });

  it("derives a stable external reference per request and step", () => {
    expect(deriveExternalRef("req-1", "FINALIZE")).toBe(
      deriveExternalRef("req-1", "FINALIZE"),
    );
    expect(deriveExternalRef("req-1", "FINALIZE")).not.toBe(
      deriveExternalRef("req-2", "FINALIZE"),
    );
  });

  it("keeps the external reference distinct from the event id for the same step", () => {
    expect(deriveExternalRef("req-1", "FINALIZE")).not.toBe(
      deriveEventId("req-1", "FINALIZE", 1),
    );
  });
});
