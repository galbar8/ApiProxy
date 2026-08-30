import { describe, expect, it } from "vitest";
import { FakeClock } from "@workflow/testing";
import {
  SecretsApiKeyStore,
  apiKeyHashForTesting,
  type SecretsApiKeyStoreOptions,
} from "./api-key-store.js";

const KEY = "test-key-000000000000000000000000";

const documentWith = (kid: string): string =>
  JSON.stringify({
    tenants: [
      {
        tenantId: "acme",
        status: "active",
        keys: [{ kid, hash: apiKeyHashForTesting(KEY) }],
      },
    ],
  });

/**
 * A Secrets Manager stand-in the test drives directly. Only `send` is substituted, because
 * that is the entire surface the store uses; mocking more would assert on the SDK rather
 * than on our behaviour.
 */
const storeWith = (
  respond: () => string | Error,
  overrides: Partial<SecretsApiKeyStoreOptions> = {},
) => {
  const clock = new FakeClock(1_000_000);
  let calls = 0;
  const staleServed: unknown[] = [];

  const client = {
    send: async (): Promise<{ SecretString: string }> => {
      calls += 1;
      const result = respond();
      if (result instanceof Error) throw result;
      return await Promise.resolve({ SecretString: result });
    },
  } as unknown as SecretsApiKeyStoreOptions["client"];

  const store = new SecretsApiKeyStore({
    secretId: "api-keys",
    client,
    clock,
    cacheTtlMs: 60_000,
    negativeCacheMs: 5_000,
    onStaleServed: (error) => staleServed.push(error),
    ...overrides,
  });

  return { store, clock, staleServed, callCount: () => calls };
};

describe("SecretsApiKeyStore refresh failure", () => {
  it("keeps authenticating from the cached document when a refresh fails", async () => {
    let phase = 0;
    const { store, clock, staleServed } = storeWith(() => {
      phase += 1;
      return phase === 1
        ? documentWith("k1")
        : new Error("Secrets Manager is unavailable");
    });

    expect(await store.resolve(KEY)).toMatchObject({ tenantId: "acme", kid: "k1" });

    // The TTL expires and the refresh fails. A valid document is still in memory, so a
    // dependency wobble must not become a 500 for every caller.
    await clock.advance(60_001);
    expect(await store.resolve(KEY)).toMatchObject({ tenantId: "acme", kid: "k1" });
    expect(staleServed).toHaveLength(1);
  });

  it("does not retry the failed refresh on every single request", async () => {
    let phase = 0;
    const { store, clock, callCount } = storeWith(() => {
      phase += 1;
      return phase === 1 ? documentWith("k1") : new Error("still down");
    });

    await store.resolve(KEY);
    const afterFirstLoad = callCount();

    await clock.advance(60_001);
    for (let i = 0; i < 5; i += 1) await store.resolve(KEY);

    // One failed attempt, then the cooldown holds. Without it every request re-attempts
    // and a Secrets Manager blip becomes a self-inflicted retry storm.
    expect(callCount() - afterFirstLoad).toBe(1);
  });

  it("retries once the cooldown elapses and picks up the new document", async () => {
    let phase = 0;
    const { store, clock } = storeWith(() => {
      phase += 1;
      if (phase === 1) return documentWith("k1");
      if (phase === 2) return new Error("transient");
      return documentWith("k2");
    });

    await store.resolve(KEY);
    await clock.advance(60_001);
    await store.resolve(KEY); // fails; serves stale

    await clock.advance(5_001); // cooldown elapsed
    expect(await store.resolve(KEY)).toMatchObject({ kid: "k2" });
  });

  it("still throws when it has never loaded a document", async () => {
    // Nothing to fall back on. An API that cannot authenticate anybody must fail loudly
    // rather than silently reject every caller as unauthenticated.
    const { store } = storeWith(() => new Error("cold start, no secret"));
    await expect(store.resolve(KEY)).rejects.toThrow(/cold start/);
  });
});
