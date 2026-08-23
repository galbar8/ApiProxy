import { randomUUID } from "node:crypto";
import Fastify, {
  type FastifyError,
  type FastifyReply,
  type FastifyRequest,
} from "fastify";
import type { Config } from "@workflow/config";
import {
  AUTHORIZATION_HEADER,
  IDEMPOTENCY_KEY_HEADER,
  ERROR_CODES,
  idempotencyKeySchema,
  isTerminal,
  processRequestSchema,
  requestIdSchema,
  type Clock,
  type RequestId,
  type TenantId,
  type WorkflowRecord,
} from "@workflow/contracts";
import { payloadFingerprint } from "@workflow/idempotency";
import type { WorkflowRepository, WorkflowWaiter } from "@workflow/persistence";
import {
  METRICS,
  serializeError,
  withCorrelation,
  type Logger,
  type Metrics,
} from "@workflow/observability";
import type { ApiKeyStore, ResolvedCaller } from "./auth/api-key-store.js";
import { PROBLEMS, type HttpProblem } from "./errors.js";
import type { Lifecycle } from "./lifecycle.js";

declare module "fastify" {
  interface FastifyRequest {
    caller?: ResolvedCaller;
  }
}

export interface AppDependencies {
  readonly config: Config;
  readonly logger: Logger;
  readonly metrics: Metrics;
  readonly repository: WorkflowRepository;
  readonly waiter: WorkflowWaiter;
  readonly apiKeys: ApiKeyStore;
  readonly lifecycle: Lifecycle;
  readonly clock: Clock;
}

const BEARER_PREFIX = "ApiKey ";

const sendProblem = (reply: FastifyReply, problem: HttpProblem): FastifyReply =>
  reply.code(problem.status).send({
    code: problem.code,
    message: problem.message,
    ...(problem.details === undefined ? {} : { details: problem.details }),
  });

/**
 * Combines client disconnect and process shutdown into one signal. Either one ends the
 * wait; neither one touches workflow state.
 */
const waitSignal = (request: FastifyRequest, lifecycle: Lifecycle): AbortSignal => {
  const perRequest = new AbortController();
  request.raw.on("close", () => {
    if (request.raw.destroyed || !request.raw.readableEnded) {
      perRequest.abort();
    }
  });
  return AbortSignal.any([perRequest.signal, lifecycle.shutdownSignal]);
};

const terminalBody = (workflow: WorkflowRecord): Record<string, unknown> =>
  workflow.status === "COMPLETED"
    ? { requestId: workflow.requestId, status: "COMPLETED", result: workflow.result }
    : {
        requestId: workflow.requestId,
        status: "FAILED",
        error: {
          code: workflow.error?.code ?? ERROR_CODES.INTERNAL_ERROR,
          message: workflow.error?.message ?? "workflow failed",
        },
      };

export const buildApp = (deps: AppDependencies) => {
  const { config, logger, metrics, repository, waiter, apiKeys, lifecycle, clock } =
    deps;

  const app = Fastify({
    loggerInstance: logger,
    // Oversized bodies are rejected by the framework before any state is created
    // (ADR-0006). The limit is configuration, not a literal.
    bodyLimit: config.business.maxRequestPayloadBytes,
    genReqId: () => randomUUID(),
    requestTimeout: config.http.requestTimeoutMs,
    keepAliveTimeout: config.http.keepAliveTimeoutMs,
  });

  app.setErrorHandler((error: FastifyError, request, reply) => {
    const code = (error as { code?: string }).code;
    if (code === "FST_ERR_CTP_BODY_TOO_LARGE") {
      return sendProblem(
        reply,
        PROBLEMS.payloadTooLarge(config.business.maxRequestPayloadBytes),
      );
    }
    if (error.statusCode !== undefined && error.statusCode < 500) {
      return sendProblem(reply, PROBLEMS.validation(error.message));
    }
    request.log.error({ err: serializeError(error) }, "unhandled request error");
    metrics.count(METRICS.httpErrors, 1, {
      route: request.routeOptions.url ?? "unknown",
    });
    return sendProblem(reply, PROBLEMS.internal());
  });

  // ---- Health -------------------------------------------------------------
  // Liveness stays healthy while draining: the process is fine, it is just refusing new
  // work. Failing liveness during drain would make ECS kill tasks mid-request.
  app.get("/health/live", async (_request, reply) => {
    return await reply
      .code(lifecycle.isLive ? 200 : 503)
      .send({ status: lifecycle.isLive ? "live" : "stopped" });
  });

  app.get("/health/ready", async (_request, reply) => {
    const ready = lifecycle.isReady;
    return await reply
      .code(ready ? 200 : 503)
      .send({ status: ready ? "ready" : "draining", state: lifecycle.state });
  });

  // ---- Authentication -----------------------------------------------------
  app.addHook("onRequest", async (request, reply) => {
    if (!request.url.startsWith("/v1/")) return;

    // Draining stops new *work*, not reads. A status lookup creates nothing and is the
    // documented recovery path, so refusing it during drain would take the recovery
    // route away exactly when a caller is most likely to need it.
    if (!lifecycle.isAcceptingWork && request.method !== "GET") {
      await sendProblem(reply.header("retry-after", "5"), PROBLEMS.draining());
      return;
    }

    const header = request.headers[AUTHORIZATION_HEADER];
    if (typeof header !== "string" || !header.startsWith(BEARER_PREFIX)) {
      await sendProblem(reply, PROBLEMS.unauthenticated());
      return;
    }

    const presented = header.slice(BEARER_PREFIX.length).trim();
    if (presented === "") {
      await sendProblem(reply, PROBLEMS.unauthenticated());
      return;
    }

    const caller = await apiKeys.resolve(presented);
    if (caller === undefined) {
      // No detail about why: a caller learns only that the credential was not accepted.
      await sendProblem(reply, PROBLEMS.unauthenticated());
      return;
    }
    request.caller = caller;
  });

  // ---- POST /v1/process ---------------------------------------------------
  app.post("/v1/process", async (request, reply) => {
    const caller = request.caller;
    if (caller === undefined)
      return await sendProblem(reply, PROBLEMS.unauthenticated());

    const startedAt = clock.now();
    const tenantId: TenantId = caller.tenantId;

    const rawKey = request.headers[IDEMPOTENCY_KEY_HEADER];
    const parsedKey = idempotencyKeySchema.safeParse(
      typeof rawKey === "string" ? rawKey : undefined,
    );
    if (!parsedKey.success) {
      return await sendProblem(
        reply,
        PROBLEMS.validation(
          `a valid ${IDEMPOTENCY_KEY_HEADER} header is required (8-128 chars, [A-Za-z0-9._:-])`,
        ),
      );
    }

    const parsedBody = processRequestSchema.safeParse(request.body);
    if (!parsedBody.success) {
      return await sendProblem(
        reply,
        PROBLEMS.validation("request body failed validation", {
          issues: parsedBody.error.issues.map((issue) => ({
            path: issue.path.join("."),
            message: issue.message,
          })),
        }),
      );
    }

    const requestId = randomUUID() as RequestId;

    return await withCorrelation({ requestId, tenantId }, async () => {
      const now = clock.now();
      const created = await repository.createWorkflow({
        requestId,
        tenantId,
        idempotencyKey: parsedKey.data,
        payloadHash: payloadFingerprint(parsedBody.data),
        input: parsedBody.data,
        syncDeadlineAt: now + config.http.syncWaitTimeoutMs,
        businessDeadlineAt: now + config.business.deadlineMs,
      });

      if (created.outcome === "CONFLICT") {
        metrics.count(METRICS.idempotencyConflict);
        request.log.warn(
          {
            idempotencyKey: parsedKey.data,
            existingRequestId: created.existingRequestId,
          },
          "idempotency key reused with a different payload",
        );
        return await sendProblem(reply, PROBLEMS.idempotencyConflict());
      }

      const workflow = created.workflow;
      const effectiveRequestId = workflow.requestId;

      if (created.outcome === "CREATED") {
        metrics.count(METRICS.workflowStarted);
      } else {
        metrics.count(METRICS.idempotentReplay);
        // A retry of an already-finished operation recovers the durable result rather
        // than doing any work again (INV-31).
        if (isTerminal(workflow.status)) {
          metrics.duration(METRICS.httpLatency, clock.now() - startedAt, {
            route: "process",
            outcome: workflow.status,
          });
          return await reply.code(200).send(terminalBody(workflow));
        }
      }

      const result = await waiter.waitForTerminalState(
        effectiveRequestId,
        clock.now() + config.http.syncWaitTimeoutMs,
        waitSignal(request, lifecycle),
      );

      metrics.gauge(METRICS.pollAttempts, result.attempts, "Count", {
        route: "process",
      });
      metrics.duration(METRICS.httpLatency, clock.now() - startedAt, {
        route: "process",
        outcome: result.outcome,
      });

      if (result.outcome === "TERMINAL") {
        metrics.count(
          result.workflow.status === "COMPLETED"
            ? METRICS.workflowCompleted
            : METRICS.workflowFailed,
        );
        return await reply.code(200).send(terminalBody(result.workflow));
      }

      // TIMED_OUT, ABORTED and MISSING all mean the same thing to the caller: no answer
      // yet. None of them says anything about the business outcome, and none of them
      // touches workflow state (INV-51).
      metrics.count(METRICS.syncTimeouts, 1, { reason: result.outcome });
      request.log.info(
        {
          outcome: result.outcome,
          attempts: result.attempts,
          waitedMs: result.waitedMs,
        },
        "synchronous deadline reached; workflow continues",
      );

      return await reply
        .code(202)
        .header("retry-after", "1")
        .send({
          requestId: effectiveRequestId,
          status: "PROCESSING",
          pollUrl: `${config.http.publicBaseUrl}/v1/process/${effectiveRequestId}`,
          retryAfterSeconds: 1,
        });
    });
  });

  // ---- GET /v1/process/:requestId ----------------------------------------
  app.get<{ Params: { requestId: string } }>(
    "/v1/process/:requestId",
    async (request, reply) => {
      const caller = request.caller;
      if (caller === undefined)
        return await sendProblem(reply, PROBLEMS.unauthenticated());

      const parsed = requestIdSchema.safeParse(request.params.requestId);
      if (!parsed.success) {
        // Same response as a genuinely unknown id: a malformed id reveals nothing extra.
        return await sendProblem(reply, PROBLEMS.notFound());
      }

      const workflow = await repository.getWorkflowForTenant(
        parsed.data,
        caller.tenantId,
      );
      if (workflow === undefined) {
        return await sendProblem(reply, PROBLEMS.notFound());
      }

      metrics.count(METRICS.workflowRecovered, 1, { status: workflow.status });

      if (isTerminal(workflow.status)) {
        return await reply.code(200).send(terminalBody(workflow));
      }
      return await reply.code(200).send({
        requestId: workflow.requestId,
        status: "PROCESSING",
        pollUrl: `${config.http.publicBaseUrl}/v1/process/${workflow.requestId}`,
        retryAfterSeconds: 1,
      });
    },
  );

  app.addHook("onResponse", async (request, reply) => {
    metrics.count(METRICS.httpRequests, 1, {
      route: request.routeOptions.url ?? "unknown",
      status: String(reply.statusCode),
    });
  });

  return app;
};

export type AppInstance = ReturnType<typeof buildApp>;
