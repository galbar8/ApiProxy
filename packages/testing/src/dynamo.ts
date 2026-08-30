import {
  CreateTableCommand,
  DeleteTableCommand,
  DescribeTableCommand,
  DynamoDBClient,
  ResourceInUseException,
  ResourceNotFoundException,
  type CreateTableCommandInput,
} from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb";
import { TABLE_DEFINITION } from "@workflow/persistence";

export const LOCAL_DYNAMODB_ENDPOINT =
  process.env["DYNAMODB_ENDPOINT"] ?? "http://127.0.0.1:8000";

export const createLocalDynamoClient = (): DynamoDBClient =>
  new DynamoDBClient({
    region: "us-east-1",
    endpoint: LOCAL_DYNAMODB_ENDPOINT,
    credentials: { accessKeyId: "local", secretAccessKey: "local" },
  });

export const createLocalDocumentClient = (
  client: DynamoDBClient = createLocalDynamoClient(),
): DynamoDBDocumentClient =>
  DynamoDBDocumentClient.from(client, {
    marshallOptions: { removeUndefinedValues: true },
    unmarshallOptions: { wrapNumbers: false },
  });

/**
 * Builds the local table from the same TABLE_DEFINITION the CDK stack uses, so a test
 * cannot pass against a table shape production does not have.
 */
export const tableInput = (tableName: string): CreateTableCommandInput => ({
  TableName: tableName,
  BillingMode: "PAY_PER_REQUEST",
  AttributeDefinitions: [
    { AttributeName: "pk", AttributeType: "S" },
    { AttributeName: "sk", AttributeType: "S" },
    { AttributeName: "gsi1pk", AttributeType: "S" },
    { AttributeName: "gsi1sk", AttributeType: "S" },
    { AttributeName: "gsi2pk", AttributeType: "S" },
    { AttributeName: "gsi2sk", AttributeType: "S" },
  ],
  KeySchema: [
    { AttributeName: "pk", KeyType: "HASH" },
    { AttributeName: "sk", KeyType: "RANGE" },
  ],
  GlobalSecondaryIndexes: TABLE_DEFINITION.indexes.map((index) => ({
    IndexName: index.name,
    KeySchema: [
      { AttributeName: index.partitionKey, KeyType: "HASH" as const },
      { AttributeName: index.sortKey, KeyType: "RANGE" as const },
    ],
    Projection: { ProjectionType: index.projection },
  })),
  StreamSpecification: {
    StreamEnabled: true,
    StreamViewType: TABLE_DEFINITION.streamViewType,
  },
});

export const ensureTable = async (
  client: DynamoDBClient,
  tableName: string,
): Promise<string | undefined> => {
  try {
    await client.send(new CreateTableCommand(tableInput(tableName)));
  } catch (error) {
    if (!(error instanceof ResourceInUseException)) throw error;
  }
  const described = await client.send(
    new DescribeTableCommand({ TableName: tableName }),
  );
  return described.Table?.LatestStreamArn;
};

export const dropTable = async (
  client: DynamoDBClient,
  tableName: string,
): Promise<void> => {
  try {
    await client.send(new DeleteTableCommand({ TableName: tableName }));
  } catch (error) {
    if (!(error instanceof ResourceNotFoundException)) throw error;
  }
};

/** A fresh table per test file keeps suites independent without cross-test cleanup. */
export const uniqueTableName = (prefix: string): string =>
  `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

/**
 * Writes an item bypassing the repository, so tests can plant the malformed or legacy
 * records that read-time validation is supposed to reject.
 */
export const putRawItem = async (
  client: DynamoDBDocumentClient,
  tableName: string,
  item: Record<string, unknown>,
): Promise<void> => {
  await client.send(new PutCommand({ TableName: tableName, Item: item }));
};
