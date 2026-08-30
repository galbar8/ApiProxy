import path from "node:path";
import { fileURLToPath } from "node:url";
import { Duration, Stack, type StackProps } from "aws-cdk-lib";
import type * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as events from "aws-cdk-lib/aws-events";
import * as targets from "aws-cdk-lib/aws-events-targets";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import * as logs from "aws-cdk-lib/aws-logs";
import type * as sqs from "aws-cdk-lib/aws-sqs";
import {
  SqsEventSource,
  DynamoEventSource,
  SqsDlq,
} from "aws-cdk-lib/aws-lambda-event-sources";
import * as sqsLib from "aws-cdk-lib/aws-sqs";
import type { Construct } from "constructs";
import type { EnvironmentConfig } from "../environment.js";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../..",
);

export interface WorkersStackProps extends StackProps {
  readonly config: EnvironmentConfig;
  readonly table: dynamodb.Table;
  readonly startQueue: sqs.Queue;
  readonly stepQueue: sqs.Queue;
  /**
   * External provider endpoint. Production must name a real HTTPS host: the placeholder
   * would point every finalizer at a name that does not resolve.
   */
  readonly providerBaseUrl: string;
}

/**
 * A defaulted provider URL fails loudly rather than corrupting state — every call errors,
 * the DLQ fills and the alarms fire — but it is the same class of "forgot the context
 * value" mistake that `certificateArn` already refuses to allow, and there is no reason to
 * discover it after a deployment instead of during synth.
 */
export const assertUsableProviderUrl = (providerBaseUrl: string): void => {
  let parsed: URL;
  try {
    parsed = new URL(providerBaseUrl);
  } catch {
    throw new Error(`providerBaseUrl is not a URL: ${providerBaseUrl}`);
  }
  if (parsed.protocol !== "https:") {
    throw new Error(
      `production requires an https providerBaseUrl; received ${providerBaseUrl}`,
    );
  }
  if (parsed.hostname.endsWith(".invalid") || parsed.hostname.endsWith(".example")) {
    throw new Error(
      `providerBaseUrl is still the placeholder (${providerBaseUrl}); pass the real ` +
        "provider endpoint with -c providerBaseUrl=",
    );
  }
};

/**
 * The asynchronous half of the system.
 *
 * Workers are deliberately not VPC-attached: they need DynamoDB, SQS and the external
 * provider, none of which requires VPC placement, and attaching them would force NAT
 * gateways back into the design purely to reach the provider.
 */
export class WorkersStack extends Stack {
  readonly workerA: NodejsFunction;
  readonly finalizer: NodejsFunction;
  readonly outboxPublisher: NodejsFunction;
  readonly reconciler: NodejsFunction;
  readonly streamDlq: sqsLib.Queue;

  constructor(scope: Construct, id: string, props: WorkersStackProps) {
    super(scope, id, props);
    const { config, table, startQueue, stepQueue } = props;

    if (config.isProduction) {
      assertUsableProviderUrl(props.providerBaseUrl);
    }

    const commonEnvironment = {
      APP_ENV: config.envName,
      WORKFLOW_TABLE_NAME: table.tableName,
      BUSINESS_DEADLINE_MS: String(config.businessDeadlineMs),
      WORKFLOW_TTL_DAYS: String(config.workflowTtlDays),
      OUTBOX_TTL_DAYS: String(config.outboxTtlDays),
      // The SDK keeps TCP connections warm between invocations.
      AWS_NODEJS_CONNECTION_REUSE_ENABLED: "1",
    };

    const makeFunction = (
      name: string,
      entryApp: string,
      environment: Record<string, string>,
    ): NodejsFunction => {
      // An explicit log group rather than the `logRetention` property, which provisions a
      // custom-resource Lambda with broad log permissions just to set a retention value.
      const logGroup = new logs.LogGroup(this, `${name}Logs`, {
        retention: config.logRetentionDays,
        removalPolicy: config.removalPolicy,
      });

      return new NodejsFunction(this, name, {
        entry: path.join(repoRoot, "apps", entryApp, "src", "lambda.ts"),
        handler: "handler",
        runtime: lambda.Runtime.NODEJS_22_X,
        architecture: lambda.Architecture.ARM_64,
        timeout: config.lambdaTimeout,
        memorySize: 512,
        // A ceiling per function, so one busy queue cannot consume the whole account's
        // concurrency and starve the others.
        reservedConcurrentExecutions: config.reservedConcurrency,
        environment: { ...commonEnvironment, ...environment },
        logGroup,
        bundling: { minify: false, sourceMap: true },
      });
    };

    this.workerA = makeFunction("WorkerA", "worker-a", {});
    this.finalizer = makeFunction("Finalizer", "finalizer", {
      PROVIDER_BASE_URL: props.providerBaseUrl,
    });
    this.outboxPublisher = makeFunction("OutboxPublisher", "outbox-publisher", {
      START_QUEUE_URL: startQueue.queueUrl,
      STEP_QUEUE_URL: stepQueue.queueUrl,
    });
    this.reconciler = makeFunction("Reconciler", "reconciler", {
      START_QUEUE_URL: startQueue.queueUrl,
      STEP_QUEUE_URL: stepQueue.queueUrl,
      OUTBOX_STALE_AFTER_MS: String(config.outboxStaleAfterMs),
      // The reconciler reports stale workflows and never judges them. There is no
      // environment variable that changes this, because failing a workflow for missing a
      // deadline would assert a business outcome nobody observed (INV-51, D-029).
    });

    // ---- IAM: enumerated actions, table-scoped resources ---------------------
    const tableItemActions = [
      "dynamodb:GetItem",
      "dynamodb:PutItem",
      "dynamodb:UpdateItem",
      "dynamodb:ConditionCheckItem",
      "dynamodb:TransactWriteItems",
      "dynamodb:TransactGetItems",
    ];

    for (const fn of [this.workerA, this.finalizer]) {
      fn.addToRolePolicy(
        new iam.PolicyStatement({
          actions: tableItemActions,
          resources: [table.tableArn],
        }),
      );
    }

    this.outboxPublisher.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["dynamodb:GetItem", "dynamodb:UpdateItem"],
        resources: [table.tableArn],
      }),
    );

    this.reconciler.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["dynamodb:GetItem", "dynamodb:UpdateItem", "dynamodb:Query"],
        resources: [table.tableArn, `${table.tableArn}/index/*`],
      }),
    );

    // Only the publisher and the reconciler may send messages. The API and the workers
    // never publish directly: publication is always a consequence of a committed
    // transaction (INV-43), and IAM enforces that rather than trusting convention.
    for (const fn of [this.outboxPublisher, this.reconciler]) {
      for (const queue of [startQueue, stepQueue]) {
        queue.grantSendMessages(fn);
      }
    }

    startQueue.grantConsumeMessages(this.workerA);
    stepQueue.grantConsumeMessages(this.finalizer);

    // ---- Event source mappings ----------------------------------------------
    this.workerA.addEventSource(
      new SqsEventSource(startQueue, {
        batchSize: config.batchSize,
        maxBatchingWindow: config.batchingWindow,
        // Independent records: a failure must not force successful records in the same
        // batch to be reprocessed.
        reportBatchItemFailures: true,
        maxConcurrency: config.esmMaxConcurrency,
      }),
    );

    this.finalizer.addEventSource(
      new SqsEventSource(stepQueue, {
        batchSize: config.batchSize,
        maxBatchingWindow: config.batchingWindow,
        reportBatchItemFailures: true,
        // The tighter ceiling here is backpressure on the external provider.
        maxConcurrency: config.esmMaxConcurrency,
      }),
    );

    // A poison stream record must not block its shard indefinitely. After the retries
    // below it is sent here, where an alarm makes it visible rather than lost.
    this.streamDlq = new sqsLib.Queue(this, "OutboxStreamDlq", {
      retentionPeriod: Duration.days(14),
      enforceSSL: true,
      encryption: sqsLib.QueueEncryption.SQS_MANAGED,
    });

    this.outboxPublisher.addEventSource(
      new DynamoEventSource(table, {
        startingPosition: lambda.StartingPosition.TRIM_HORIZON,
        batchSize: 10,
        maxBatchingWindow: Duration.seconds(1),
        retryAttempts: 5,
        bisectBatchOnError: true,
        reportBatchItemFailures: true,
        onFailure: new SqsDlq(this.streamDlq),
      }),
    );

    // The safety net under the stream: republishes anything committed but unpublished.
    new events.Rule(this, "ReconcileSchedule", {
      schedule: events.Schedule.rate(Duration.minutes(config.reconcileScheduleMinutes)),
      targets: [new targets.LambdaFunction(this.reconciler)],
    });
  }
}
