import { createHash } from "node:crypto";
import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from "@aws-sdk/client-secrets-manager";
import { z } from "zod";
import {
  ERROR_CODES,
  NonRetryableError,
  type Clock,
  type TenantId,
} from "@workflow/contracts";

/**
 * The credential document (ADR-0002).
 *
 * Only SHA-256 hashes are stored. Raw key material exists in exactly two places: the
 * caller's configuration and the request header — never in this document, never in
 * DynamoDB, never in a log line.
 */
export const apiKeyDocumentSchema = z.object({
  tenants: z
    .array(
      z.object({
        tenantId: z
          .string()
          .min(1)
          .max(64)
          .regex(/^[A-Za-z0-9._-]+$/),
        status: z.enum(["active", "disabled"]),
        keys: z
          .array(
            z.object({
              kid: z.string().min(1).max(64),
              hash: z.string().regex(/^[0-9a-f]{64}$/),
              /** Present while a key is being rotated out. */
              expiresAt: z.number().int().positive().optional(),
            }),
          )
          .min(1),
      }),
    )
    .max(10_000),
});
export type ApiKeyDocument = z.infer<typeof apiKeyDocumentSchema>;

export interface ResolvedCaller {
  readonly tenantId: TenantId;
  readonly kid: string;
}

export interface ApiKeyStore {
  resolve(presentedKey: string): Promise<ResolvedCaller | undefined>;
}

const hashKey = (key: string): string =>
  createHash("sha256").update(key, "utf8").digest("hex");

export interface SecretsApiKeyStoreOptions {
  readonly secretId: string;
  readonly client: SecretsManagerClient;
  readonly clock: Clock;
  readonly cacheTtlMs: number;
  readonly negativeCacheMs: number;
  /**
   * Called when a refresh fails but a previously loaded document is still usable, so the
   * store keeps serving. The caller decides how loudly to say so.
   */
  readonly onStaleServed?: (error: unknown) => void;
}

/**
 * Resolves a presented API key to a tenant, caching the credential document.
 *
 * Lookup is by hash through a map rather than by scanning every tenant. That is O(1) and
 * still safe: an attacker would need a preimage of the SHA-256 to exploit the map, and
 * the final comparison is constant-time regardless.
 *
 * Revocation latency equals the cache TTL. A cache miss triggers at most one refresh per
 * `negativeCacheMs`, so a flood of invalid keys cannot turn into a flood of Secrets
 * Manager calls.
 *
 * A refresh that fails is not an outage. Once a document has loaded successfully, the
 * cached index keeps answering and the next attempt is deferred by `negativeCacheMs`;
 * otherwise a transient Secrets Manager blip would 500 every request *and* have each of
 * them retry, turning a dependency wobble into a self-inflicted retry storm. The cost is
 * stated plainly: while refreshes are failing, revocations stop propagating, which is why
 * `onStaleServed` exists. A store that has never loaded a document has nothing to serve
 * and still throws.
 */
export class SecretsApiKeyStore implements ApiKeyStore {
  readonly #options: SecretsApiKeyStoreOptions;
  #index = new Map<string, ResolvedCaller>();
  #loadedAt = 0;
  #loadedEver = false;
  #lastMissRefreshAt = 0;
  #nextRefreshAllowedAt = 0;
  #inFlight: Promise<void> | undefined;

  constructor(options: SecretsApiKeyStoreOptions) {
    this.#options = options;
  }

  async resolve(presentedKey: string): Promise<ResolvedCaller | undefined> {
    const now = this.#options.clock.now();
    if (now - this.#loadedAt >= this.#options.cacheTtlMs) {
      await this.#refreshOrServeStale(now);
    }

    const digest = hashKey(presentedKey);
    const hit = this.#lookup(digest);
    if (hit !== undefined) return hit;

    // A miss may mean a key was added since the last refresh. Refresh at most once per
    // cooldown so invalid keys cannot amplify into Secrets Manager load.
    if (now - this.#lastMissRefreshAt >= this.#options.negativeCacheMs) {
      this.#lastMissRefreshAt = now;
      await this.#refreshOrServeStale(now);
      return this.#lookup(digest);
    }
    return undefined;
  }

  /**
   * Refreshes unless a recent failure put attempts in cooldown. Rethrows only when there
   * is no cached document to fall back to — an API that cannot authenticate anyone should
   * fail loudly rather than reject every caller as unauthorized.
   */
  async #refreshOrServeStale(now: number): Promise<void> {
    if (this.#loadedEver && now < this.#nextRefreshAllowedAt) return;
    try {
      await this.#refresh();
    } catch (error) {
      if (!this.#loadedEver) throw error;
      this.#nextRefreshAllowedAt = now + this.#options.negativeCacheMs;
      this.#options.onStaleServed?.(error);
    }
  }

  #lookup(digest: string): ResolvedCaller | undefined {
    // Lookup is by SHA-256 digest through a map, which is O(1) and leaks nothing useful:
    // the map is keyed by the digest, so hitting or missing it reveals only whether a
    // digest is known, and recovering a key from its digest is the hard problem. The raw
    // key is never compared against anything, so there is no secret-dependent comparison
    // here to make constant-time.
    return this.#index.get(digest);
  }

  async #refresh(): Promise<void> {
    this.#inFlight ??= this.#load().finally(() => {
      this.#inFlight = undefined;
    });
    await this.#inFlight;
  }

  async #load(): Promise<void> {
    const response = await this.#options.client.send(
      new GetSecretValueCommand({ SecretId: this.#options.secretId }),
    );
    if (response.SecretString === undefined) {
      throw new NonRetryableError(
        ERROR_CODES.INTERNAL_ERROR,
        "api key secret has no string value",
      );
    }
    // Built before either field moves, so a document that fails validation leaves the
    // previous index in place rather than blanking it.
    const rebuilt = buildIndex(response.SecretString, this.#options.clock.now());
    this.#index = rebuilt;
    this.#loadedAt = this.#options.clock.now();
    this.#loadedEver = true;
    this.#nextRefreshAllowedAt = 0;
  }
}

/** Local-only store backed by `API_KEYS_INLINE`, so tests need no AWS (ADR-0002). */
export class InlineApiKeyStore implements ApiKeyStore {
  readonly #index: Map<string, ResolvedCaller>;

  constructor(document: string, clock: Clock) {
    this.#index = buildIndex(document, clock.now());
  }

  async resolve(presentedKey: string): Promise<ResolvedCaller | undefined> {
    return await Promise.resolve(this.#index.get(hashKey(presentedKey)));
  }
}

const buildIndex = (document: string, now: number): Map<string, ResolvedCaller> => {
  let raw: unknown;
  try {
    raw = JSON.parse(document);
  } catch (error) {
    throw new NonRetryableError(
      ERROR_CODES.INTERNAL_ERROR,
      "api key document is not valid JSON",
      { cause: error },
    );
  }

  const parsed = apiKeyDocumentSchema.safeParse(raw);
  if (!parsed.success) {
    // The message deliberately omits the document contents.
    throw new NonRetryableError(
      ERROR_CODES.INTERNAL_ERROR,
      `api key document failed validation (${parsed.error.issues.length} issues)`,
    );
  }

  const index = new Map<string, ResolvedCaller>();
  for (const tenant of parsed.data.tenants) {
    if (tenant.status !== "active") continue;
    for (const key of tenant.keys) {
      if (key.expiresAt !== undefined && key.expiresAt <= now) continue;
      index.set(key.hash, {
        tenantId: tenant.tenantId as TenantId,
        kid: key.kid,
      });
    }
  }
  return index;
};

export const apiKeyHashForTesting = hashKey;

export const createSecretsManagerClient = (options: {
  region: string;
}): SecretsManagerClient => new SecretsManagerClient({ region: options.region });
