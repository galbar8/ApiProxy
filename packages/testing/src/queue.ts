import {
  DeleteMessageCommand,
  SendMessageCommand,
  GetQueueUrlCommand,
  PurgeQueueCommand,
  ReceiveMessageCommand,
  SQSClient,
  ChangeMessageVisibilityCommand,
  GetQueueAttributesCommand,
} from "@aws-sdk/client-sqs";
import type { SQSEvent, SQSBatchResponse, SQSRecord } from "aws-lambda";
import { anSqsRecord } from "./sqs-fixtures.js";

export const LOCAL_SQS_ENDPOINT =
  process.env["SQS_ENDPOINT"] ?? "http://127.0.0.1:9324";

export const createLocalSqsClient = (): SQSClient =>
  new SQSClient({
    region: "us-east-1",
    endpoint: LOCAL_SQS_ENDPOINT,
    credentials: { accessKeyId: "local", secretAccessKey: "local" },
  });

export const queueUrlFor = async (
  client: SQSClient,
  queueName: string,
): Promise<string> => {
  const result = await client.send(new GetQueueUrlCommand({ QueueName: queueName }));
  if (result.QueueUrl === undefined) throw new Error(`queue ${queueName} not found`);
  return result.QueueUrl;
};

export const purgeQueue = async (
  client: SQSClient,
  queueUrl: string,
): Promise<void> => {
  await client.send(new PurgeQueueCommand({ QueueUrl: queueUrl }));
};

export const approximateDepth = async (
  client: SQSClient,
  queueUrl: string,
): Promise<number> => {
  const result = await client.send(
    new GetQueueAttributesCommand({
      QueueUrl: queueUrl,
      AttributeNames: ["ApproximateNumberOfMessages"],
    }),
  );
  return Number(result.Attributes?.ApproximateNumberOfMessages ?? "0");
};

/**
 * Adversarial delivery controls.
 *
 * These exist because an emulator that happens never to duplicate a message proves
 * nothing about duplicate handling. Duplication, reordering and crashes are injected on
 * demand so the guarantees are re-proven on every run (ADR-0009).
 */
export interface DispatchOptions {
  /** Deliver every received message twice within the same batch. */
  readonly duplicateInBatch?: boolean;
  /** Deliver the batch, then deliver it again as a separate invocation. */
  readonly redeliverBatch?: boolean;
  /** Reverse record order, to exercise out-of-order delivery on a Standard queue. */
  readonly reverseOrder?: boolean;
  /** Abandon the invocation after the handler runs, without deleting anything. */
  readonly crashAfterHandler?: boolean;
  readonly batchSize?: number;
  readonly waitTimeSeconds?: number;
}

export interface DispatchResult {
  readonly received: number;
  readonly deleted: number;
  readonly reportedFailures: number;
}

export type SqsHandler = (event: SQSEvent) => Promise<SQSBatchResponse>;

/**
 * A deliberately minimal stand-in for a Lambda event source mapping.
 *
 * It reproduces the contract that matters — batches in, `batchItemFailures` out, only
 * acknowledged records deleted, everything else redelivered — and nothing else. Real
 * visibility-timeout and redrive behaviour comes from ElasticMQ, which is configured with
 * the same `maxReceiveCount` as the CDK stack.
 */
export const dispatchOnce = async (
  client: SQSClient,
  queueUrl: string,
  handler: SqsHandler,
  options: DispatchOptions = {},
): Promise<DispatchResult> => {
  const received = await client.send(
    new ReceiveMessageCommand({
      QueueUrl: queueUrl,
      MaxNumberOfMessages: options.batchSize ?? 10,
      WaitTimeSeconds: options.waitTimeSeconds ?? 0,
      AttributeNames: ["All"],
      MessageAttributeNames: ["All"],
    }),
  );

  const messages = received.Messages ?? [];
  if (messages.length === 0) {
    return { received: 0, deleted: 0, reportedFailures: 0 };
  }

  let records: SQSRecord[] = messages.map((message) =>
    anSqsRecord(message.Body ?? "", {
      messageId: message.MessageId ?? "unknown",
      receiptHandle: message.ReceiptHandle ?? "",
      attributes: {
        ApproximateReceiveCount: message.Attributes?.ApproximateReceiveCount ?? "1",
        SentTimestamp: message.Attributes?.SentTimestamp ?? String(Date.now()),
        SenderId: "local",
        ApproximateFirstReceiveTimestamp: String(Date.now()),
      },
    }),
  );

  if (options.reverseOrder === true) records = [...records].reverse();
  if (options.duplicateInBatch === true) records = [...records, ...records];

  const invoke = async (): Promise<SQSBatchResponse> =>
    await handler({ Records: records });

  const response = await invoke();
  if (options.redeliverBatch === true) {
    await invoke();
  }

  if (options.crashAfterHandler === true) {
    // Nothing is deleted: the messages become visible again exactly as they would after
    // a Lambda timeout or a killed execution environment.
    return {
      received: messages.length,
      deleted: 0,
      reportedFailures: response.batchItemFailures.length,
    };
  }

  const failed = new Set(response.batchItemFailures.map((f) => f.itemIdentifier));
  let deleted = 0;
  for (const message of messages) {
    if (message.MessageId !== undefined && failed.has(message.MessageId)) {
      // Make the failure visible again immediately so tests do not wait out a
      // visibility timeout.
      await client.send(
        new ChangeMessageVisibilityCommand({
          QueueUrl: queueUrl,
          ReceiptHandle: message.ReceiptHandle ?? "",
          VisibilityTimeout: 0,
        }),
      );
      continue;
    }
    await client.send(
      new DeleteMessageCommand({
        QueueUrl: queueUrl,
        ReceiptHandle: message.ReceiptHandle ?? "",
      }),
    );
    deleted += 1;
  }

  return {
    received: messages.length,
    deleted,
    reportedFailures: response.batchItemFailures.length,
  };
};

/** Sends a raw body, so tests can plant a poison message the producer would never write. */
export const sendRawMessage = async (
  client: SQSClient,
  queueUrl: string,
  body: string,
): Promise<void> => {
  await client.send(new SendMessageCommand({ QueueUrl: queueUrl, MessageBody: body }));
};

/** Drains a queue for inspection, e.g. asserting what reached a DLQ. */
export const drainQueue = async (
  client: SQSClient,
  queueUrl: string,
  max = 10,
): Promise<string[]> => {
  const bodies: string[] = [];
  for (let attempt = 0; attempt < max; attempt += 1) {
    const result = await client.send(
      new ReceiveMessageCommand({
        QueueUrl: queueUrl,
        MaxNumberOfMessages: 10,
        WaitTimeSeconds: 0,
      }),
    );
    const messages = result.Messages ?? [];
    if (messages.length === 0) break;
    for (const message of messages) {
      bodies.push(message.Body ?? "");
      await client.send(
        new DeleteMessageCommand({
          QueueUrl: queueUrl,
          ReceiptHandle: message.ReceiptHandle ?? "",
        }),
      );
    }
  }
  return bodies;
};
