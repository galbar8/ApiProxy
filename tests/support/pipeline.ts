import { systemClock, type RequestId, type WorkflowRecord } from "@workflow/contracts";
import { SqsMessagePublisher } from "@workflow/messaging";
import { WorkflowRepository, createDocumentClient } from "@workflow/persistence";
import { createLogger, createMetrics } from "@workflow/observability";
import { createWorkerAHandler } from "@workflow/worker-a";
import { createFinalizerHandler, HttpProviderClient } from "@workflow/finalizer";
import { createOutboxPublisherHandler } from "@workflow/outbox-publisher";
import { createReconcilerHandler } from "@workflow/reconciler";
import { buildProvider, ProviderStore } from "@workflow/fake-provider";
import {
  LOCAL_DYNAMODB_ENDPOINT,
  LOCAL_SQS_ENDPOINT,
  LocalStreamPump,
  createLocalDynamoClient,
  createLocalSqsClient,
  dispatchOnce,
  dropTable,
  ensureTable,
  purgeQueue,
  queueUrlFor,
  uniqueTableName,
  type DispatchOptions,
} from "@workflow/testing";

const QUEUE_NAMES = {
  start: "workflow-start",
  step: "workflow-step",
  startDlq: "workflow-start-dlq",
  stepDlq: "workflow-step-dlq",
} as const;

export interface PipelineOptions {
  readonly tablePrefix?: string;
  /** Attach to a table someone else owns, e.g. one the API under test is already using. */
  readonly tableName?: string;
  readonly maxResultBytes?: number;
}

/**
 * The whole system, wired against the local topology: real handlers, real repository,
 * real SQS semantics from ElasticMQ, real streams from DynamoDB Local, and a provider
 * that can be told to misbehave.
 *
 * Nothing here is a mock of our own code. The only substitutions are the AWS endpoints
 * and the event source mappings, and the dispatcher deliberately makes delivery worse
 * than AWS would, not better.
 */
export const createLocalPipeline = async (options: PipelineOptions = {}) => {
  const ownsTable = options.tableName === undefined;
  const tableName =
    options.tableName ?? uniqueTableName(options.tablePrefix ?? "pipeline");
  const dynamo = createLocalDynamoClient();
  const streamArn = await ensureTable(dynamo, tableName);
  if (streamArn === undefined) throw new Error("table has no stream arn");

  const sqs = createLocalSqsClient();
  const queues = {
    start: await queueUrlFor(sqs, QUEUE_NAMES.start),
    step: await queueUrlFor(sqs, QUEUE_NAMES.step),
    startDlq: await queueUrlFor(sqs, QUEUE_NAMES.startDlq),
    stepDlq: await queueUrlFor(sqs, QUEUE_NAMES.stepDlq),
  };
  for (const url of Object.values(queues)) {
    await purgeQueue(sqs, url);
  }

  const providerStore = new ProviderStore();
  const { app: providerApp } = buildProvider(providerStore);
  await providerApp.listen({ host: "127.0.0.1", port: 0 });
  const address = providerApp.server.address();
  if (address === null || typeof address === "string") {
    throw new Error("provider did not bind a port");
  }
  const providerBaseUrl = `http://127.0.0.1:${String(address.port)}`;

  const logger = createLogger({
    level: process.env["TEST_LOG_LEVEL"] ?? "silent",
    serviceName: "pipeline",
    serviceVersion: "test",
    environment: "local",
  });
  const metrics = createMetrics(logger);

  const repository = new WorkflowRepository({
    client: createDocumentClient({
      region: "us-east-1",
      endpoint: LOCAL_DYNAMODB_ENDPOINT,
    }),
    tableName,
    clock: systemClock,
    workflowTtlDays: 90,
    outboxTtlDays: 7,
  });

  const publisher = new SqsMessagePublisher({
    client: sqs,
    queueUrls: { START_QUEUE: queues.start, STEP_QUEUE: queues.step },
  });

  const workerA = createWorkerAHandler({
    repository,
    logger,
    metrics,
    clock: systemClock,
  });
  const finalizer = createFinalizerHandler({
    repository,
    provider: new HttpProviderClient({
      baseUrl: providerBaseUrl,
      timeoutMs: 1_000,
    }),
    logger,
    metrics,
    clock: systemClock,
    maxResultBytes: options.maxResultBytes ?? 120 * 1024,
  });
  const outboxPublisher = createOutboxPublisherHandler({
    repository,
    publisher,
    logger,
    metrics,
  });
  const reconciler = createReconcilerHandler({
    repository,
    publisher,
    logger,
    metrics,
    outboxStaleAfterMs: -1,
    pageSize: 50,
  });

  const streamPump = new LocalStreamPump(streamArn);

  const pumpStream = async (): Promise<number> =>
    await streamPump.pump(outboxPublisher);
  const replayStream = async (): Promise<number> =>
    await streamPump.replayLast(outboxPublisher);

  const pumpStart = async (dispatch: DispatchOptions = {}) =>
    await dispatchOnce(sqs, queues.start, workerA, dispatch);
  const pumpStep = async (dispatch: DispatchOptions = {}) =>
    await dispatchOnce(sqs, queues.step, finalizer, dispatch);

  /** One full pass: publish committed events, run each queue, publish what that produced. */
  const tick = async (dispatch: DispatchOptions = {}): Promise<void> => {
    await pumpStream();
    await pumpStart(dispatch);
    await pumpStream();
    await pumpStep(dispatch);
    await pumpStream();
  };

  const runUntilTerminal = async (
    requestId: RequestId,
    maxTicks = 8,
  ): Promise<WorkflowRecord | undefined> => {
    for (let attempt = 0; attempt < maxTicks; attempt += 1) {
      await tick();
      const workflow = await repository.getWorkflow(requestId);
      if (workflow !== undefined && workflow.status !== "PROCESSING") return workflow;
    }
    return await repository.getWorkflow(requestId);
  };

  return {
    tableName,
    streamArn,
    queues,
    repository,
    publisher,
    providerStore,
    providerBaseUrl,
    handlers: { workerA, finalizer, outboxPublisher, reconciler },
    streamPump,
    sqs,
    pumpStream,
    replayStream,
    pumpStart,
    pumpStep,
    tick,
    runUntilTerminal,
    async close(): Promise<void> {
      await providerApp.close();
      // Only drop what this pipeline created; an attached table belongs to its owner.
      if (ownsTable) await dropTable(dynamo, tableName);
    },
  };
};

export type LocalPipeline = Awaited<ReturnType<typeof createLocalPipeline>>;
export const localSqsEndpoint = LOCAL_SQS_ENDPOINT;
