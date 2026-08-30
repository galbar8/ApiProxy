import {
  DynamoDBStreamsClient,
  DescribeStreamCommand,
  GetRecordsCommand,
  GetShardIteratorCommand,
} from "@aws-sdk/client-dynamodb-streams";
import type {
  DynamoDBBatchResponse,
  DynamoDBRecord,
  DynamoDBStreamEvent,
} from "aws-lambda";
import { LOCAL_DYNAMODB_ENDPOINT } from "./dynamo.js";

export const createLocalStreamsClient = (): DynamoDBStreamsClient =>
  new DynamoDBStreamsClient({
    region: "us-east-1",
    endpoint: LOCAL_DYNAMODB_ENDPOINT,
    credentials: { accessKeyId: "local", secretAccessKey: "local" },
  });

export type StreamHandler = (
  event: DynamoDBStreamEvent,
) => Promise<DynamoDBBatchResponse>;

/**
 * Stands in for a DynamoDB Streams event source mapping.
 *
 * Iterators are kept between calls so a test can drain the stream incrementally, and
 * `replayLast` re-delivers the previous batch to prove that duplicate stream processing
 * is safe (INV-44).
 */
export class LocalStreamPump {
  readonly #client: DynamoDBStreamsClient;
  readonly #streamArn: string;
  #iterators = new Map<string, string>();
  #lastBatch: DynamoDBRecord[] = [];
  #initialized = false;

  constructor(
    streamArn: string,
    client: DynamoDBStreamsClient = createLocalStreamsClient(),
  ) {
    this.#streamArn = streamArn;
    this.#client = client;
  }

  async #ensureIterators(): Promise<void> {
    if (this.#initialized) return;
    const described = await this.#client.send(
      new DescribeStreamCommand({ StreamArn: this.#streamArn }),
    );
    for (const shard of described.StreamDescription?.Shards ?? []) {
      if (shard.ShardId === undefined) continue;
      const iterator = await this.#client.send(
        new GetShardIteratorCommand({
          StreamArn: this.#streamArn,
          ShardId: shard.ShardId,
          ShardIteratorType: "TRIM_HORIZON",
        }),
      );
      if (iterator.ShardIterator !== undefined) {
        this.#iterators.set(shard.ShardId, iterator.ShardIterator);
      }
    }
    this.#initialized = true;
  }

  /** Reads whatever is available and invokes the handler once per shard batch. */
  async pump(handler: StreamHandler): Promise<number> {
    await this.#ensureIterators();
    let delivered = 0;

    for (const [shardId, iterator] of [...this.#iterators.entries()]) {
      const result = await this.#client.send(
        new GetRecordsCommand({ ShardIterator: iterator, Limit: 100 }),
      );
      if (result.NextShardIterator !== undefined) {
        this.#iterators.set(shardId, result.NextShardIterator);
      } else {
        this.#iterators.delete(shardId);
      }

      const records = (result.Records ?? []) as unknown as DynamoDBRecord[];
      if (records.length === 0) continue;

      this.#lastBatch = records;
      await handler({ Records: records });
      delivered += records.length;
    }
    return delivered;
  }

  /** Re-delivers the previous batch: duplicate stream processing must be a no-op. */
  async replayLast(handler: StreamHandler): Promise<number> {
    if (this.#lastBatch.length === 0) return 0;
    await handler({ Records: this.#lastBatch });
    return this.#lastBatch.length;
  }

  /** Discards the previous batch without delivering it, simulating a lost stream record. */
  dropLast(): number {
    const size = this.#lastBatch.length;
    this.#lastBatch = [];
    return size;
  }
}
