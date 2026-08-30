# Using the API

A guide for whoever is calling this service. Two endpoints, one authentication scheme, and
one idea you have to understand: **a request can come back "still running", and that is a
normal answer, not an error.**

---

## 1. The idea in one paragraph

You `POST` one operation. Behind the scenes the work is queued and processed
asynchronously, but the API holds your connection open for up to **20 seconds** waiting for
it to finish. If it finishes in time you get the result on that same request (`200`). If it
does not, you get `202` with a `pollUrl`, the work keeps running, and you fetch the answer
later. Nothing is lost, cancelled or failed because your HTTP call ended.

```text
POST /v1/process ──► 200 COMPLETED   the operation finished; here is the result
                 ├─► 200 FAILED      the operation finished; the answer is "no"
                 └─► 202 PROCESSING  no answer yet; poll pollUrl
```

---

## 2. Basics

|                  |                                                            |
| ---------------- | ---------------------------------------------------------- |
| Base URL         | `https://api.example.com` (whatever your tenant was given) |
| Transport        | HTTPS only. Credentials must never travel over plaintext   |
| Content type     | `application/json`                                         |
| Authentication   | `Authorization: ApiKey <your-key>`                         |
| Max request body | 120 KB (`122880` bytes) — larger gets `413`                |
| Client timeout   | **Use 35 seconds.** The service answers within ~20         |

Your API key identifies your tenant. You never send a tenant id — a `tenantId` in the body
is rejected outright, not ignored. You can only ever read your own workflows.

---

## 3. `POST /v1/process` — start an operation

### Headers

| Header            | Required | Notes                                                     |
| ----------------- | -------- | --------------------------------------------------------- |
| `Authorization`   | yes      | `ApiKey <your-key>`                                       |
| `Idempotency-Key` | yes      | 8–128 chars, `A-Z a-z 0-9 . _ : -`. See §6 — this matters |
| `Content-Type`    | yes      | `application/json`                                        |

### Body

| Field                 | Type                | Rules                                                         |
| --------------------- | ------------------- | ------------------------------------------------------------- |
| `operation`           | string              | `CHARGE` or `REFUND`                                          |
| `amount.currencyCode` | string              | ISO 4217, uppercase. Supported: `USD`, `EUR`, `GBP`, `ILS`    |
| `amount.minorUnits`   | integer             | Minor units (cents/agorot). `> 0`, `<= 1000000000`. No floats |
| `reference`           | string              | Your own reference, 1–64 chars. Correlation only              |
| `metadata`            | object _(optional)_ | Up to 10 entries; keys ≤64 chars, values ≤256 chars           |

Nothing else is accepted. Unknown fields — including `tenantId`, `requestId` or `status` —
make the whole request fail with `400`.

```json
{
  "operation": "CHARGE",
  "amount": { "currencyCode": "USD", "minorUnits": 1250 },
  "reference": "order-8842",
  "metadata": { "channel": "web", "campaign": "spring" }
}
```

`minorUnits: 1250` means **$12.50**. Amounts are integers in minor units so that money never
touches a floating-point number.

### Example

```bash
curl -sS -X POST https://api.example.com/v1/process \
  -H "Authorization: ApiKey $API_KEY" \
  -H "Idempotency-Key: order-8842-attempt-1" \
  -H "Content-Type: application/json" \
  -d '{
        "operation": "CHARGE",
        "amount": { "currencyCode": "USD", "minorUnits": 1250 },
        "reference": "order-8842"
      }'
```

---

## 4. The three answers

### `200` — finished, succeeded

```json
{
  "requestId": "6f1a0b1e-6a5f-4c0e-9a2f-6d5b0f0c1234",
  "status": "COMPLETED",
  "result": {
    "providerOperationId": "prov_01J8ZK3M4Q",
    "outcome": "SETTLED",
    "amount": { "currencyCode": "USD", "minorUnits": 1250 },
    "riskBand": "LOW",
    "completedAt": 1756000000000
  }
}
```

### `200` — finished, the answer is "no"

```json
{
  "requestId": "6f1a0b1e-6a5f-4c0e-9a2f-6d5b0f0c1234",
  "status": "FAILED",
  "error": { "code": "PROVIDER_REJECTED", "message": "insufficient funds" }
}
```

**This is still HTTP `200`, on purpose.** The call worked; the business answer is negative.
A declined charge is not a transport error, so it must not be retried like one. Branch on
`status`, never on the status code alone.

### `202` — no answer yet

```json
{
  "requestId": "6f1a0b1e-6a5f-4c0e-9a2f-6d5b0f0c1234",
  "status": "PROCESSING",
  "pollUrl": "https://api.example.com/v1/process/6f1a0b1e-6a5f-4c0e-9a2f-6d5b0f0c1234",
  "retryAfterSeconds": 1
}
```

Also sent as a `Retry-After: 1` header. The operation **is still running**. Poll `pollUrl`
until it turns terminal. Do not re-`POST`, and above all do not re-`POST` with a fresh
idempotency key — that starts a second, real operation.

---

## 5. `GET /v1/process/:requestId` — check on it

The recovery path. Use it after a `202`, after a timeout, after a dropped connection, after
a crash on your side — any time you do not know the outcome.

```bash
curl -sS https://api.example.com/v1/process/6f1a0b1e-6a5f-4c0e-9a2f-6d5b0f0c1234 \
  -H "Authorization: ApiKey $API_KEY"
```

Always `200` while the workflow exists and belongs to you, with the same three bodies as
above (`COMPLETED`, `FAILED`, or `PROCESSING` with a `pollUrl`).

`404` means _not yours or not there_ — a workflow belonging to another tenant, an unknown
id and a malformed id all return the identical `404`, so a `requestId` cannot be used to
probe for other people's data.

This endpoint keeps answering while a server instance is shutting down, because that is
exactly when you are most likely to need it.

---

## 6. Idempotency — the part to get right

Every `POST` carries an `Idempotency-Key` you choose. It is scoped to your tenant, and it
decides what a retry means:

| You send                     | You get                                                            |
| ---------------------------- | ------------------------------------------------------------------ |
| Same key, **same** body      | The **same** `requestId` and the same outcome. No second operation |
| Same key, **different** body | `409 IDEMPOTENCY_KEY_CONFLICT` — nothing is created                |
| **New** key, same body       | A **brand new operation**. The customer is charged twice           |

So:

- **Derive the key from your own business object**, not from the attempt. `order-8842` is a
  good key; `uuid()` generated inside your retry loop is a bug that charges twice.
- **Reuse the same key for every retry** of the same logical operation — including retries
  after a network error, a timeout, or a crash where you never saw the response.
- A retry that arrives while the first is still running does not start a second one; it
  waits for the same workflow and returns the same `requestId`.
- A retry after it finished returns the stored result immediately.

The safe rule: **the same intent always carries the same key, forever.**

---

## 7. Errors

Every error has the same shape:

```json
{
  "code": "VALIDATION_FAILED",
  "message": "request body failed validation",
  "details": {
    "issues": [{ "path": "amount.minorUnits", "message": "Expected number" }]
  }
}
```

| Status | `code`                     | Meaning                                           | What to do                                  |
| ------ | -------------------------- | ------------------------------------------------- | ------------------------------------------- |
| `400`  | `VALIDATION_FAILED`        | Bad body or bad `Idempotency-Key` format          | Fix the request. Do not retry unchanged     |
| `401`  | `UNAUTHENTICATED`          | Missing/unknown/disabled key                      | Check the key. The message never says which |
| `404`  | `NOT_FOUND`                | Unknown workflow, or not yours                    | Check the `requestId`                       |
| `409`  | `IDEMPOTENCY_KEY_CONFLICT` | Key reused with a different payload               | Use a new key, or resend the original body  |
| `413`  | `PAYLOAD_TOO_LARGE`        | Body over 120 KB                                  | Shrink the request                          |
| `500`  | `INTERNAL_ERROR`           | Unexpected failure                                | Retry with the **same** key                 |
| `503`  | `SERVICE_DRAINING`         | That instance is shutting down (`Retry-After: 5`) | Retry with the **same** key                 |

Business failures arrive as `200` + `"status": "FAILED"`, with these codes:

| `error.code`             | Meaning                                                       |
| ------------------------ | ------------------------------------------------------------- |
| `PROVIDER_REJECTED`      | The provider declined it — a real business "no". Do not retry |
| `UNSUPPORTED_CURRENCY`   | Currency outside `USD`/`EUR`/`GBP`/`ILS`                      |
| `WORKFLOW_INPUT_INVALID` | The stored input failed validation                            |
| `RESULT_TOO_LARGE`       | The result exceeded the size limit                            |

---

## 8. A complete client

Axios, TypeScript. This is the shape a correct B2B caller has: one stable key, a client
timeout above the server's wait, retries that reuse the key, and polling on `202`.

```ts
import axios, { AxiosError } from "axios";

const client = axios.create({
  baseURL: "https://api.example.com",
  timeout: 35_000, // above the server's ~20s wait, so 202 arrives before we give up
  headers: {
    Authorization: `ApiKey ${process.env.API_KEY}`,
    "Content-Type": "application/json",
  },
  validateStatus: (s) => s < 500, // handle 4xx ourselves; let 5xx throw
});

type Terminal =
  | { requestId: string; status: "COMPLETED"; result: Record<string, unknown> }
  | { requestId: string; status: "FAILED"; error: { code: string; message: string } };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Poll until terminal or until we run out of patience. */
async function poll(requestId: string, deadline: number): Promise<Terminal> {
  let delay = 500;
  while (Date.now() < deadline) {
    await sleep(delay);
    delay = Math.min(delay * 1.5, 5_000); // back off, and jitter in production
    const { data } = await client.get(`/v1/process/${requestId}`);
    if (data.status !== "PROCESSING") return data as Terminal;
  }
  throw new Error(`workflow ${requestId} still processing; recover it later`);
}

export async function charge(orderId: string, minorUnits: number): Promise<Terminal> {
  const idempotencyKey = `order-${orderId}`; // stable: derived from the order, not the attempt
  const body = {
    operation: "CHARGE",
    amount: { currencyCode: "USD", minorUnits },
    reference: orderId,
  };
  const deadline = Date.now() + 5 * 60_000; // the business deadline, not the HTTP one

  for (let attempt = 1; ; attempt++) {
    try {
      const res = await client.post("/v1/process", body, {
        headers: { "Idempotency-Key": idempotencyKey }, // SAME key on every attempt
      });

      if (res.status === 202) return await poll(res.data.requestId, deadline);
      if (res.status === 200) return res.data as Terminal;

      // 400/401/409/413: our fault. Retrying unchanged cannot help.
      throw new Error(`${res.data.code}: ${res.data.message}`);
    } catch (err) {
      const e = err as AxiosError;
      const retryable =
        e.code === "ECONNABORTED" ||
        e.code === "ECONNRESET" ||
        (e.response?.status ?? 0) >= 500;
      if (!retryable || attempt >= 4 || Date.now() > deadline) throw err;
      await sleep(Math.min(1_000 * 2 ** attempt, 8_000));
      // loop: same key, so this is the same operation, never a second one
    }
  }
}
```

Then branch on the business answer, not on the transport:

```ts
const outcome = await charge("8842", 1250);
if (outcome.status === "COMPLETED") {
  markPaid(outcome.result.providerOperationId as string);
} else {
  markDeclined(outcome.error.code, outcome.error.message); // a real "no", not a retry
}
```

---

## 9. Client checklist

- [ ] Client timeout is **35 s** — long enough to receive the `202`.
- [ ] `Idempotency-Key` is derived from your business object and **never regenerated on retry**.
- [ ] `202` is handled as "poll me", not as an error.
- [ ] `200` + `"status":"FAILED"` is handled as a business decision, not a transport failure.
- [ ] Every retry after a timeout, disconnect or `5xx` reuses the same key.
- [ ] You store the `requestId` before doing anything else with the response — it is how you
      recover an unknown outcome.
- [ ] You never re-`POST` with a new key just to "check" — that starts a second operation.
- [ ] Polling backs off (0.5 s → 5 s) instead of hammering `pollUrl`.

---

## 10. Reference: how the work is classified

Useful when reading a result:

| `riskBand` | Amount in minor units |
| ---------- | --------------------- |
| `LOW`      | under 100 000         |
| `MEDIUM`   | 100 000 – 499 999     |
| `HIGH`     | 500 000 and above     |

`result.outcome` is `SETTLED` on a completed workflow. A provider decline does not appear as
a result — it becomes `status: "FAILED"` with `PROVIDER_REJECTED`.

---

## 11. Health endpoints (operators, not clients)

| Endpoint        | Meaning                                                           |
| --------------- | ----------------------------------------------------------------- |
| `/health/live`  | The process is alive. Stays `200` while draining                  |
| `/health/ready` | Ready for traffic. Returns `503` while draining — used by the ALB |

Neither requires authentication; neither tells you anything about a workflow.

---

## Where to read more

| Document                                                                                   | What it covers                    |
| ------------------------------------------------------------------------------------------ | --------------------------------- |
| [`adr/0005-synchronous-response-semantics.md`](adr/0005-synchronous-response-semantics.md) | Why `FAILED` is a `200`           |
| [`adr/0002-b2b-authentication-api-keys.md`](adr/0002-b2b-authentication-api-keys.md)       | The authentication decision       |
| [`adr/0007-timeout-ladder-and-polling.md`](adr/0007-timeout-ladder-and-polling.md)         | Where the 20 s and 35 s come from |
| [`state-machine.md`](state-machine.md)                                                     | Legal states and transitions      |
| [`../DEPLOYMENT.md`](../DEPLOYMENT.md)                                                     | Deploying the service to AWS      |
