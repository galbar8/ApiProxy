import { Duration, Stack, type StackProps } from "aws-cdk-lib";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import * as actions from "aws-cdk-lib/aws-cloudwatch-actions";
import * as sns from "aws-cdk-lib/aws-sns";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as elbv2 from "aws-cdk-lib/aws-elasticloadbalancingv2";
import type * as lambda from "aws-cdk-lib/aws-lambda";
import type * as sqs from "aws-cdk-lib/aws-sqs";
import type { Construct } from "constructs";
import { METRIC_NAMESPACE } from "@workflow/observability";
import type { EnvironmentConfig } from "../environment.js";

export interface MonitoringStackProps extends StackProps {
  readonly config: EnvironmentConfig;
  readonly table: dynamodb.Table;
  readonly queues: readonly { name: string; queue: sqs.Queue; dlq: sqs.Queue }[];
  readonly functions: readonly { name: string; fn: lambda.IFunction }[];
  readonly loadBalancer: elbv2.ApplicationLoadBalancer;
  readonly targetGroup: elbv2.ApplicationTargetGroup;
  readonly streamDlq: sqs.Queue;
}

/**
 * Alarms for the conditions that mean the system is failing in a way nobody would
 * otherwise notice.
 *
 * A DLQ with no alarm is not a failure mechanism, it is a place messages go to be
 * forgotten; the same is true of a stalled outbox or a stuck queue. Each alarm here
 * corresponds to a failure mode the design deliberately tolerates but must surface.
 */
export class MonitoringStack extends Stack {
  readonly alarmTopic: sns.Topic;

  constructor(scope: Construct, id: string, props: MonitoringStackProps) {
    super(scope, id, props);
    const { config } = props;

    this.alarmTopic = new sns.Topic(this, "AlarmTopic", {
      displayName: `${config.envName} workflow service alarms`,
    });

    const alarm = (
      id_: string,
      metric: cloudwatch.IMetric,
      threshold: number,
      description: string,
      evaluationPeriods = 1,
      comparison = cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
    ): cloudwatch.Alarm => {
      const created = new cloudwatch.Alarm(this, id_, {
        metric,
        threshold,
        evaluationPeriods,
        comparisonOperator: comparison,
        alarmDescription: description,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      });
      created.addAlarmAction(new actions.SnsAction(this.alarmTopic));
      return created;
    };

    // ---- Dead letters: a message that stopped moving ------------------------
    for (const entry of props.queues) {
      alarm(
        `${entry.name}DlqNotEmpty`,
        entry.dlq.metricApproximateNumberOfMessagesVisible({
          period: Duration.minutes(1),
          statistic: "Maximum",
        }),
        0,
        `${entry.name} DLQ contains messages; a workflow step is stuck and needs redrive`,
      );

      // Queue age, not depth: depth is normal under load, age means nothing is draining.
      alarm(
        `${entry.name}Backlog`,
        entry.queue.metricApproximateAgeOfOldestMessage({
          period: Duration.minutes(1),
          statistic: "Maximum",
        }),
        300,
        `${entry.name} oldest message is older than 5 minutes; processing is not keeping up`,
        2,
      );
    }

    alarm(
      "OutboxStreamDlqNotEmpty",
      props.streamDlq.metricApproximateNumberOfMessagesVisible({
        period: Duration.minutes(1),
        statistic: "Maximum",
      }),
      0,
      "The outbox publisher failed a stream batch; events may be unpublished",
    );

    // ---- Compute ------------------------------------------------------------
    for (const entry of props.functions) {
      alarm(
        `${entry.name}Errors`,
        entry.fn.metricErrors({ period: Duration.minutes(5), statistic: "Sum" }),
        5,
        `${entry.name} is erroring repeatedly`,
      );
      alarm(
        `${entry.name}Throttles`,
        entry.fn.metricThrottles({ period: Duration.minutes(5), statistic: "Sum" }),
        0,
        `${entry.name} is being throttled; concurrency is insufficient`,
      );
    }

    // ---- Data ---------------------------------------------------------------
    alarm(
      "DynamoThrottles",
      new cloudwatch.MathExpression({
        expression: "readThrottles + writeThrottles",
        usingMetrics: {
          readThrottles: props.table.metric("ReadThrottleEvents", {
            statistic: "Sum",
          }),
          writeThrottles: props.table.metric("WriteThrottleEvents", {
            statistic: "Sum",
          }),
        },
        period: Duration.minutes(5),
      }),
      0,
      "DynamoDB is throttling; the synchronous polling path is degrading",
    );

    alarm(
      "DynamoSystemErrors",
      props.table.metricSystemErrorsForOperations({
        operations: [
          dynamodb.Operation.GET_ITEM,
          dynamodb.Operation.UPDATE_ITEM,
          dynamodb.Operation.TRANSACT_WRITE_ITEMS,
        ],
        period: Duration.minutes(5),
      }),
      5,
      "DynamoDB is returning system errors",
    );

    // ---- Edge ---------------------------------------------------------------
    alarm(
      "Alb5xx",
      // Load-balancer-generated 5xx: the service failed to answer at all.
      props.loadBalancer.metrics.httpCodeElb(elbv2.HttpCodeElb.ELB_5XX_COUNT, {
        period: Duration.minutes(5),
        statistic: "Sum",
      }),
      10,
      "The load balancer is returning 5xx; tasks may be unhealthy or timing out",
    );

    alarm(
      "UnhealthyTargets",
      props.targetGroup.metrics.unhealthyHostCount({
        period: Duration.minutes(1),
        statistic: "Maximum",
      }),
      0,
      "API tasks are failing their readiness check",
      3,
    );

    // ---- Business -----------------------------------------------------------
    // Reliability is not only infrastructure health: a rising workflow failure rate or a
    // stalled outbox is invisible to every metric above.
    alarm(
      "WorkflowFailureRate",
      new cloudwatch.Metric({
        namespace: METRIC_NAMESPACE,
        metricName: "WorkflowFailed",
        period: Duration.minutes(5),
        statistic: "Sum",
      }),
      20,
      "Workflows are failing at an abnormal rate",
      2,
    );

    alarm(
      "StaleOutboxEvents",
      new cloudwatch.Metric({
        namespace: METRIC_NAMESPACE,
        metricName: "OutboxStale",
        period: Duration.minutes(5),
        statistic: "Maximum",
      }),
      0,
      "Outbox events were committed but not published; the stream path may be broken",
      2,
    );

    alarm(
      "ProviderUnknownState",
      new cloudwatch.Metric({
        namespace: METRIC_NAMESPACE,
        metricName: "ProviderUnknownState",
        period: Duration.minutes(5),
        statistic: "Sum",
      }),
      5,
      "Repeated ambiguous provider outcomes; reconciliation load is rising",
    );

    alarm(
      "SyncTimeouts",
      new cloudwatch.Metric({
        namespace: METRIC_NAMESPACE,
        metricName: "SyncTimeouts",
        period: Duration.minutes(5),
        statistic: "Sum",
      }),
      100,
      "Many requests are exceeding the synchronous deadline; callers are seeing 202s",
      2,
    );
  }
}
