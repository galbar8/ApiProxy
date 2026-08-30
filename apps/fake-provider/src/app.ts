import Fastify from "fastify";
import { z } from "zod";
import { ProviderStore, operationRequestSchema, type FaultKind } from "./store.js";

const faultRequestSchema = z.object({
  idempotencyKey: z.string().min(1),
  faults: z.array(
    z.enum(["timeout", "server-error", "rate-limit", "decline", "succeed-then-drop"]),
  ),
});

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

export const buildProvider = (store: ProviderStore = new ProviderStore()) => {
  const app = Fastify({ logger: false });

  app.post("/operations", async (request, reply) => {
    const idempotencyKey = request.headers["idempotency-key"];
    if (typeof idempotencyKey !== "string" || idempotencyKey.length === 0) {
      return await reply
        .code(400)
        .send({ error: "idempotency-key header is required" });
    }

    const parsed = operationRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return await reply.code(422).send({ error: "invalid operation request" });
    }

    const fault: FaultKind | undefined = store.takeFault(idempotencyKey);

    if (fault === "timeout") {
      // Hang long enough that the caller's timeout fires. The operation is deliberately
      // NOT performed, so a naive "timeout means it happened" assumption is also wrong.
      await sleep(2_500);
      return await reply.code(200).send({ late: true });
    }
    if (fault === "server-error") {
      return await reply.code(503).send({ error: "provider unavailable" });
    }
    if (fault === "rate-limit") {
      return await reply.code(429).send({ error: "slow down" });
    }

    if (fault === "succeed-then-drop") {
      // The operation IS performed, and then the response is lost. This is the failure
      // that makes naive retries duplicate business operations.
      store.upsert(idempotencyKey, parsed.data);
      request.raw.destroy();
      return await Promise.resolve(reply);
    }

    const operation = store.upsert(
      idempotencyKey,
      fault === "decline" ? { ...parsed.data, riskBand: "HIGH" } : parsed.data,
    );
    return await reply.code(200).send(operation);
  });

  /** Reconciliation endpoint: look an operation up by the reference we generated. */
  app.get<{ Params: { reference: string } }>(
    "/operations/:reference",
    async (request, reply) => {
      const operation = store.findByReference(request.params.reference);
      if (operation === undefined) {
        return await reply.code(404).send({ error: "not found" });
      }
      return await reply.code(200).send(operation);
    },
  );

  // ---- Test-only controls -------------------------------------------------
  app.post("/_test/faults", async (request, reply) => {
    const parsed = faultRequestSchema.safeParse(request.body);
    if (!parsed.success) return await reply.code(400).send({ error: "bad fault spec" });
    store.queueFault(parsed.data.idempotencyKey, parsed.data.faults);
    return await reply.code(204).send();
  });

  app.post("/_test/reset", async (_request, reply) => {
    store.reset();
    return await reply.code(204).send();
  });

  app.get("/_test/operations/count", async (_request, reply) => {
    return await reply.code(200).send({ count: store.size });
  });

  app.get(
    "/health",
    async (_request, reply) => await reply.code(200).send({ ok: true }),
  );

  return { app, store };
};
