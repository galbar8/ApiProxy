import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";

export interface DynamoClientOptions {
  readonly region: string;
  /** Set only when APP_ENV=local, to reach DynamoDB Local. */
  readonly endpoint?: string | undefined;
  readonly maxAttempts?: number;
}

/**
 * SDK-level retries are deliberately modest. Layering aggressive SDK retries under SQS
 * redelivery under a polling loop multiplies load during an incident; the outer layers
 * already provide durability, so this layer only needs to absorb brief blips.
 */
export const createDocumentClient = (
  options: DynamoClientOptions,
): DynamoDBDocumentClient => {
  const client = new DynamoDBClient({
    region: options.region,
    maxAttempts: options.maxAttempts ?? 3,
    ...(options.endpoint === undefined
      ? {}
      : {
          endpoint: options.endpoint,
          credentials: { accessKeyId: "local", secretAccessKey: "local" },
        }),
  });

  return DynamoDBDocumentClient.from(client, {
    marshallOptions: {
      removeUndefinedValues: true,
      convertClassInstanceToMap: false,
    },
    unmarshallOptions: { wrapNumbers: false },
  });
};
