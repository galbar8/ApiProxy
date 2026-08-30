import { CfnOutput, Stack, type StackProps } from "aws-cdk-lib";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import type { Construct } from "constructs";
import type { EnvironmentConfig } from "../environment.js";

export interface DataStackProps extends StackProps {
  readonly config: EnvironmentConfig;
}

/**
 * The authoritative workflow table.
 *
 * Shape mirrors `TABLE_DEFINITION` in `@workflow/persistence`, which the local test
 * harness also builds from, so a passing local test cannot be passing against a table
 * shape that production does not have.
 */
export class DataStack extends Stack {
  readonly table: dynamodb.Table;

  constructor(scope: Construct, id: string, props: DataStackProps) {
    super(scope, id, props);
    const { config } = props;

    this.table = new dynamodb.Table(this, "WorkflowTable", {
      partitionKey: { name: "pk", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "sk", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,

      // The outbox publisher is driven by this stream; it needs the new image to build
      // the message and the old image to recognise its own "mark published" update.
      stream: dynamodb.StreamViewType.NEW_AND_OLD_IMAGES,

      timeToLiveAttribute: "expiresAt",

      // Recovery posture is explicit per environment, never inherited by accident.
      pointInTimeRecoverySpecification: {
        pointInTimeRecoveryEnabled: config.pointInTimeRecovery,
      },
      deletionProtection: config.deletionProtection,
      removalPolicy: config.removalPolicy,
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
    });

    // Sparse: only unpublished outbox events carry gsi1pk, so this index stays near
    // empty in a healthy system and the reconciler's sweep is cheap.
    this.table.addGlobalSecondaryIndex({
      indexName: "gsi1-pending-outbox",
      partitionKey: { name: "gsi1pk", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "gsi1sk", type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // Keys only: projecting the workflow would duplicate every request payload into the
    // index, doubling write cost and storage for a query that should return nothing.
    this.table.addGlobalSecondaryIndex({
      indexName: "gsi2-processing-workflows",
      partitionKey: { name: "gsi2pk", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "gsi2sk", type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.KEYS_ONLY,
    });

    new CfnOutput(this, "WorkflowTableName", { value: this.table.tableName });
  }
}
