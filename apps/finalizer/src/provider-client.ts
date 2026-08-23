import axios, { type AxiosInstance } from "axios";
import {
  ERROR_CODES,
  NonRetryableError,
  RetryableError,
  UnknownExternalStateError,
  PROVIDER_IDEMPOTENCY_HEADER,
  providerOperationResponseSchema,
  type ProviderOperationRequest,
  type ProviderOperationResponse,
} from "@workflow/contracts";

export interface ProviderClient {
  /** Performs the operation, always under the same stable idempotency identity. */
  execute(
    externalRef: string,
    request: ProviderOperationRequest,
  ): Promise<ProviderOperationResponse>;
  /** Looks an operation up by our reference; the basis of reconciliation. */
  lookup(externalRef: string): Promise<ProviderOperationResponse | undefined>;
}

export interface HttpProviderClientOptions {
  readonly baseUrl: string;
  readonly timeoutMs: number;
  readonly axiosInstance?: AxiosInstance;
}

/**
 * Network failures are classified rather than flattened, because the classification
 * decides whether it is safe to act again.
 *
 * The distinction that matters: "the request never reached the provider" is retryable,
 * while "the request may have been executed and we lost the answer" is
 * UNKNOWN_EXTERNAL_STATE and must reconcile before doing anything else. Treating a
 * timeout as a plain retry is exactly how duplicate charges happen.
 */
const NEVER_DELIVERED = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN"]);
const AMBIGUOUS = new Set([
  "ECONNABORTED",
  "ETIMEDOUT",
  "ECONNRESET",
  "EPIPE",
  "ERR_BAD_RESPONSE",
]);

const classifyTransportError = (error: unknown, externalRef: string): never => {
  const code = axios.isAxiosError(error) ? (error.code ?? "") : "";

  if (NEVER_DELIVERED.has(code)) {
    throw new RetryableError(
      ERROR_CODES.PROVIDER_UNAVAILABLE,
      `provider unreachable (${code}); the request was never delivered`,
      { cause: error, details: { externalRef } },
    );
  }
  if (AMBIGUOUS.has(code) || code === "") {
    throw new UnknownExternalStateError(
      ERROR_CODES.PROVIDER_STATE_UNKNOWN,
      `provider outcome unknown (${code || "no code"}); the operation may have been executed`,
      { cause: error, details: { externalRef } },
    );
  }
  throw new UnknownExternalStateError(
    ERROR_CODES.PROVIDER_STATE_UNKNOWN,
    `provider call failed with ${code}`,
    { cause: error, details: { externalRef } },
  );
};

export class HttpProviderClient implements ProviderClient {
  readonly #http: AxiosInstance;

  constructor(options: HttpProviderClientOptions) {
    this.#http =
      options.axiosInstance ??
      axios.create({
        baseURL: options.baseUrl,
        timeout: options.timeoutMs,
        // Status is classified explicitly below; axios must not throw on 4xx/5xx.
        validateStatus: () => true,
        headers: { "content-type": "application/json" },
      });
  }

  async execute(
    externalRef: string,
    request: ProviderOperationRequest,
  ): Promise<ProviderOperationResponse> {
    let response;
    try {
      response = await this.#http.post("/operations", request, {
        headers: { [PROVIDER_IDEMPOTENCY_HEADER]: externalRef },
      });
    } catch (error) {
      return classifyTransportError(error, externalRef);
    }

    if (response.status === 429 || response.status >= 500) {
      throw new RetryableError(
        ERROR_CODES.PROVIDER_UNAVAILABLE,
        `provider returned ${response.status}`,
        { details: { externalRef, status: response.status } },
      );
    }
    if (response.status >= 400) {
      throw new NonRetryableError(
        ERROR_CODES.PROVIDER_REJECTED,
        `provider rejected the operation with ${response.status}`,
        { details: { externalRef, status: response.status } },
      );
    }

    const parsed = providerOperationResponseSchema.safeParse(response.data);
    if (!parsed.success) {
      // A 200 we cannot read means the operation probably happened and we cannot tell.
      throw new UnknownExternalStateError(
        ERROR_CODES.PROVIDER_STATE_UNKNOWN,
        "provider response failed schema validation",
        { details: { externalRef } },
      );
    }
    if (parsed.data.idempotencyKey !== externalRef) {
      // A response for a different operation must never become this workflow's result
      // (no cross-request result mismatch).
      throw new UnknownExternalStateError(
        ERROR_CODES.PROVIDER_STATE_UNKNOWN,
        "provider echoed a different idempotency key",
        { details: { externalRef, echoed: parsed.data.idempotencyKey } },
      );
    }
    return parsed.data;
  }

  async lookup(externalRef: string): Promise<ProviderOperationResponse | undefined> {
    let response;
    try {
      response = await this.#http.get(`/operations/${encodeURIComponent(externalRef)}`);
    } catch (error) {
      // A failed lookup is retryable: reading cannot cause a side effect.
      throw new RetryableError(
        ERROR_CODES.PROVIDER_UNAVAILABLE,
        "provider reconciliation lookup failed",
        { cause: error, details: { externalRef } },
      );
    }

    if (response.status === 404) return undefined;
    if (response.status !== 200) {
      throw new RetryableError(
        ERROR_CODES.PROVIDER_UNAVAILABLE,
        `provider lookup returned ${response.status}`,
        { details: { externalRef, status: response.status } },
      );
    }

    const parsed = providerOperationResponseSchema.safeParse(response.data);
    if (!parsed.success) {
      throw new RetryableError(
        ERROR_CODES.PROVIDER_UNAVAILABLE,
        "provider lookup response failed schema validation",
        { details: { externalRef } },
      );
    }
    return parsed.data;
  }
}
