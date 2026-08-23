import { describe, expect, it } from "vitest";
import { anOperation } from "@workflow/testing";
import {
  assertSupportedCurrency,
  enrich,
  normalizeReference,
  parseWorkflowInput,
  riskBandFor,
} from "./enrich.js";

describe("enrichment determinism", () => {
  it("produces an identical result for a duplicate delivery", () => {
    const input = anOperation();
    expect(enrich(input, 1_000)).toEqual(enrich(input, 1_000));
  });

  it("bands risk by amount, with stable boundaries", () => {
    expect(
      riskBandFor(anOperation({ amount: { currencyCode: "USD", minorUnits: 99_999 } })),
    ).toBe("LOW");
    expect(
      riskBandFor(
        anOperation({ amount: { currencyCode: "USD", minorUnits: 100_000 } }),
      ),
    ).toBe("MEDIUM");
    expect(
      riskBandFor(
        anOperation({ amount: { currencyCode: "USD", minorUnits: 499_999 } }),
      ),
    ).toBe("MEDIUM");
    expect(
      riskBandFor(
        anOperation({ amount: { currencyCode: "USD", minorUnits: 500_000 } }),
      ),
    ).toBe("HIGH");
  });

  it("normalizes a reference without exceeding the provider's limit", () => {
    const long = anOperation({ reference: "x".repeat(64) });
    expect(normalizeReference(long).length).toBeLessThanOrEqual(80);
  });
});

describe("input validation at the persistence boundary", () => {
  it("accepts a stored input that still matches the schema", () => {
    expect(parseWorkflowInput(anOperation()).operation).toBe("CHARGE");
  });

  it("rejects stored input that no longer validates, rather than coercing it", () => {
    expect(() => parseWorkflowInput({ operation: "CHARGE" })).toThrow(
      /failed validation/,
    );
  });

  it("classifies invalid stored input as non-retryable", () => {
    try {
      parseWorkflowInput(null);
      expect.unreachable("expected a throw");
    } catch (error) {
      expect((error as { failureClass: string }).failureClass).toBe("NON_RETRYABLE");
    }
  });
});

describe("currency support", () => {
  it("accepts a supported currency", () => {
    expect(() => {
      assertSupportedCurrency(anOperation());
    }).not.toThrow();
  });

  it("rejects an unsupported currency as a permanent business failure", () => {
    try {
      assertSupportedCurrency(
        anOperation({ amount: { currencyCode: "JPY", minorUnits: 1 } }),
      );
      expect.unreachable("expected a throw");
    } catch (error) {
      expect((error as { code: string }).code).toBe("UNSUPPORTED_CURRENCY");
      expect((error as { failureClass: string }).failureClass).toBe("NON_RETRYABLE");
    }
  });
});
