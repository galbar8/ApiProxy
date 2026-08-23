import { CfnOutput, Duration, Stack, type StackProps } from "aws-cdk-lib";
import * as sqs from "aws-cdk-lib/aws-sqs";
import type { Construct } from "constructs";
import { requiredVisibilityTimeout, type EnvironmentConfig } from "../environment.js";

export interface MessagingStackProps extends StackProps {
  readonly config: EnvironmentConfig;
}

/**
 * Work queues and their dead-letter queues.
 *
 * Visibility timeout is computed from the Lambda timeout and batching window rather than
 * written as a number, so tuning one cannot silently break the other and cause a message
 * to be redelivered while it is still being processed.
 */
export class MessagingStack extends Stack {
  readonly startQueue: sqs.Queue;
  readonly stepQueue: sqs.Queue;
  readonly startDlq: sqs.Queue;
  readonly stepDlq: sqs.Queue;

  constructor(scope: Construct, id: string, props: MessagingStackProps) {
    super(scope, id, props);
    const { config } = props;

    const visibilityTimeout = requiredVisibilityTimeout(
      config.lambdaTimeout,
      config.batchingWindow,
    );

    const makeQueue = (name: string): { queue: sqs.Queue; dlq: sqs.Queue } => {
      const dlq = new sqs.Queue(this, `${name}Dlq`, {
        // Long retention: a poison message is an incident to investigate and redrive,
        // not something to lose over a weekend.
        retentionPeriod: Duration.days(14),
        enforceSSL: true,
        encryption: sqs.QueueEncryption.SQS_MANAGED,
      });

      const queue = new sqs.Queue(this, name, {
        visibilityTimeout,
        retentionPeriod: Duration.days(4),
        enforceSSL: true,
        encryption: sqs.QueueEncryption.SQS_MANAGED,
        deadLetterQueue: {
          queue: dlq,
          // After this many receives the message stops circulating and becomes visible
          // to operators instead of burning capacity forever (INV-45).
          maxReceiveCount: config.maxReceiveCount,
        },
      });

      return { queue, dlq };
    };

    const start = makeQueue("WorkflowStartQueue");
    const step = makeQueue("WorkflowStepQueue");

    this.startQueue = start.queue;
    this.startDlq = start.dlq;
    this.stepQueue = step.queue;
    this.stepDlq = step.dlq;

    new CfnOutput(this, "StartQueueUrl", { value: this.startQueue.queueUrl });
    new CfnOutput(this, "StepQueueUrl", { value: this.stepQueue.queueUrl });
  }
}
