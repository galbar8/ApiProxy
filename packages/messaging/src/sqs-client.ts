import { SQSClient } from "@aws-sdk/client-sqs";

export interface SqsClientOptions {
  readonly region: string;
  /** Set only when APP_ENV=local, to reach ElasticMQ. */
  readonly endpoint?: string | undefined;
  readonly maxAttempts?: number;
}

export const createSqsClient = (options: SqsClientOptions): SQSClient =>
  new SQSClient({
    region: options.region,
    maxAttempts: options.maxAttempts ?? 3,
    ...(options.endpoint === undefined
      ? {}
      : {
          endpoint: options.endpoint,
          credentials: { accessKeyId: "local", secretAccessKey: "local" },
        }),
  });
