import { describe, expect, it } from "vitest";
import axios from "axios";
import { HttpProviderClient } from "./provider-client.js";

const ref = "a".repeat(64);
const request = {
  operation: "CHARGE" as const,
  amount: { currencyCode: "USD", minorUnits: 100 },
  reference: "CHARGE:INV-1",
  riskBand: "LOW" as const,
};

interface StubResponse {
  status: number;
  data: unknown;
}

/**
 * Substitutes the transport, not our client: the adapter is axios's own extension point,
 * so request building, header handling and status classification all still run for real.
 */
const clientWith = (
  respond: (config: {
    url: string | undefined;
    headers: unknown;
  }) => StubResponse | Error,
): { client: HttpProviderClient; lastHeaders: () => unknown } => {
  let seenHeaders: unknown;
  const instance = axios.create({
    baseURL: "http://provider.test",
    timeout: 1_000,
    validateStatus: () => true,
    adapter: async (config) => {
      seenHeaders = config.headers;
      const result = respond({ url: config.url, headers: config.headers });
      if (result instanceof Error) throw result;
      return await Promise.resolve({
        data: result.data,
        status: result.status,
        statusText: "",
        headers: {},
        config,
      });
    },
  });
  return {
    client: new HttpProviderClient({
      baseUrl: "http://provider.test",
      timeoutMs: 1_000,
      axiosInstance: instance,
    }),
    lastHeaders: () => seenHeaders,
  };
};

const transportError = (code: string): Error =>
  Object.assign(new axios.AxiosError("boom", code), { code, isAxiosError: true });

const classOf = async (promise: Promise<unknown>): Promise<string> => {
  try {
    await promise;
    return "NO_ERROR";
  } catch (error) {
    return (error as { failureClass?: string }).failureClass ?? "UNCLASSIFIED";
  }
};

describe("provider failure classification", () => {
  it("treats a refused connection as retryable, since nothing was delivered", async () => {
    const { client } = clientWith(() => transportError("ECONNREFUSED"));
    expect(await classOf(client.execute(ref, request))).toBe("RETRYABLE");
  });

  it.each(["ECONNABORTED", "ETIMEDOUT", "ECONNRESET", "EPIPE"])(
    "treats %s as unknown external state, never as a plain retry",
    async (code) => {
      const { client } = clientWith(() => transportError(code));
      expect(await classOf(client.execute(ref, request))).toBe(
        "UNKNOWN_EXTERNAL_STATE",
      );
    },
  );

  it("treats 429 and 5xx as retryable", async () => {
    for (const status of [429, 500, 502, 503]) {
      const { client } = clientWith(() => ({ status, data: {} }));
      expect(await classOf(client.execute(ref, request))).toBe("RETRYABLE");
    }
  });

  it("treats a 4xx rejection as non-retryable", async () => {
    for (const status of [400, 409, 422]) {
      const { client } = clientWith(() => ({ status, data: {} }));
      expect(await classOf(client.execute(ref, request))).toBe("NON_RETRYABLE");
    }
  });

  it("treats an unreadable 200 as unknown state, because the operation probably happened", async () => {
    const { client } = clientWith(() => ({ status: 200, data: { unexpected: true } }));
    expect(await classOf(client.execute(ref, request))).toBe("UNKNOWN_EXTERNAL_STATE");
  });

  it("refuses a response echoing a different idempotency key", async () => {
    const { client } = clientWith(() => ({
      status: 200,
      data: {
        operationId: "op-1",
        idempotencyKey: "b".repeat(64),
        status: "SETTLED",
        amount: request.amount,
        processedAt: Date.now(),
      },
    }));
    expect(await classOf(client.execute(ref, request))).toBe("UNKNOWN_EXTERNAL_STATE");
  });

  it("accepts a well-formed settled response", async () => {
    const { client } = clientWith(() => ({
      status: 200,
      data: {
        operationId: "op-1",
        idempotencyKey: ref,
        status: "SETTLED",
        amount: request.amount,
        processedAt: Date.now(),
      },
    }));
    const response = await client.execute(ref, request);
    expect(response.status).toBe("SETTLED");
  });

  it("sends the external reference as the idempotency key", async () => {
    const { client, lastHeaders } = clientWith(() => {
      return {
        status: 200,
        data: {
          operationId: "op-1",
          idempotencyKey: ref,
          status: "SETTLED",
          amount: request.amount,
          processedAt: Date.now(),
        },
      };
    });
    await client.execute(ref, request);
    expect(JSON.stringify(lastHeaders())).toContain(ref);
  });
});

describe("reconciliation lookup", () => {
  it("returns undefined when the provider has never seen the reference", async () => {
    const { client } = clientWith(() => ({ status: 404, data: {} }));
    expect(await client.lookup(ref)).toBeUndefined();
  });

  it("returns the stored operation when the provider already performed it", async () => {
    const { client } = clientWith(() => ({
      status: 200,
      data: {
        operationId: "op-9",
        idempotencyKey: ref,
        status: "SETTLED",
        amount: request.amount,
        processedAt: Date.now(),
      },
    }));
    expect((await client.lookup(ref))?.operationId).toBe("op-9");
  });

  it("classifies a failed lookup as retryable, because reading cannot cause a side effect", async () => {
    const { client } = clientWith(() => transportError("ECONNRESET"));
    expect(await classOf(client.lookup(ref))).toBe("RETRYABLE");
  });
});
