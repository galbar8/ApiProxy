import { SendMessageCommand, type SQSClient } from "@aws-sdk/client-sqs";
import {
  ERROR_CODES,
  NonRetryableError,
  RetryableError,
  type OutboxDestination,
  type WorkflowMessage,
} from "@workflow/contracts";

export interface MessagePublisher {
  publish(destination: OutboxDestination, message: WorkflowMessage): Promise<void>;
}

/**
 * Partial on purpose: a role that only publishes to one queue is configured with only
 * that queue's URL, and asking for a destination it was not given is a startup-level
 * mistake worth failing loudly on.
 */
export type QueueUrls = Readonly<Partial<Record<OutboxDestination, string>>>;

/**
 * Publishes an outbox event to its queue.
 *
 * The destination is a logical name; the URL is resolved here from configuration. Queue
 * URLs therefore never travel inside data, so no stored or replayed message can redirect
 * work to a queue of an attacker's choosing (INV-74).
 */
export class SqsMessagePublisher implements MessagePublisher {
  readonly #client: SQSClient;
  readonly #queueUrls: QueueUrls;

  constructor(options: { client: SQSClient; queueUrls: QueueUrls }) {
    this.#client = options.client;
    this.#queueUrls = options.queueUrls;
  }

  async publish(
    destination: OutboxDestination,
    message: WorkflowMessage,
  ): Promise<void> {
    const queueUrl = this.#queueUrls[destination];
    if (queueUrl === undefined || queueUrl === "") {
      throw new NonRetryableError(
        ERROR_CODES.INTERNAL_ERROR,
        `no queue URL configured for destination ${destination}`,
      );
    }

    try {
      await this.#client.send(
        new SendMessageCommand({
          QueueUrl: queueUrl,
          MessageBody: JSON.stringify(message),
          MessageAttributes: {
            // Correlation on the transport itself, so a message can be traced without
            // parsing its body (INV-04).
            requestId: { DataType: "String", StringValue: message.requestId },
            step: { DataType: "String", StringValue: message.step },
            eventId: { DataType: "String", StringValue: message.messageId },
          },
        }),
      );
    } catch (error) {
      // Publication failures are transient by nature; the outbox event stays pending and
      // the reconciler will retry it even if this process dies here.
      throw new RetryableError(
        ERROR_CODES.INTERNAL_ERROR,
        `failed to publish ${message.step} for ${message.requestId}`,
        { cause: error },
      );
    }
  }
}
