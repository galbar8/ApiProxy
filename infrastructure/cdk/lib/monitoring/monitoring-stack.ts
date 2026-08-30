import { CfnOutput, Duration, Stack, type StackProps } from "aws-cdk-lib";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import * as actions from "aws-cdk-lib/aws-cloudwatch-actions";
import * as events from "aws-cdk-lib/aws-events";
import * as eventTargets from "aws-cdk-lib/aws-events-targets";
import * as sns from "aws-cdk-lib/aws-sns";
import * as subscriptions from "aws-cdk-lib/aws-sns-subscriptions";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as elbv2 from "aws-cdk-lib/aws-elasticloadbalancingv2";
import type * as ecs from "aws-cdk-lib/aws-ecs";
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
  readonly service: ecs.FargateService;
  readonly streamDlq: sqs.Queue;
  /**
   * Where alarms are delivered. Required outside dev: an alarm that reaches nobody is
   * not a failure mechanism, it is a record written for an audit that never happens.
   */
  readonly alarmEmails: readonly string[];
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

    if (config.isProduction && props.alarmEmails.length === 0) {
      throw new Error(
        "production requires at least one alarm subscriber (context: alarmEmails, " +
          "comma-separated); a topic with no subscription turns every alarm below into " +
          "a metric nobody reads",
      );
    }

    this.alarmTopic = new sns.Topic(this, "AlarmTopic", {
      displayName: `${config.envName} workflow service alarms`,
      enforceSSL: true,
    });
    for (const email of props.alarmEmails) {
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        throw new Error(
          `alarmEmails contains a value that is not an address: ${email}`,
        );
      }
      this.alarmTopic.addSubscription(new subscriptions.EmailSubscription(email));
    }

    const alarm = (
      id_: string,
      metric: cloudwatch.IMetric,
      threshold: number,
      description: string,
      evaluationPeriods = 1,
      comparison = cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      // Most alarms here count bad events, so absent data means nothing bad happened.
      // Alarms that watch for the *presence* of something healthy must invert this, or a
      // total outage silences them exactly when they matter.
      treatMissingData = cloudwatch.TreatMissingData.NOT_BREACHING,
    ): cloudwatch.Alarm => {
      const created = new cloudwatch.Alarm(this, id_, {
        metric,
        threshold,
        evaluationPeriods,
        comparisonOperator: comparison,
        alarmDescription: description,
        treatMissingData,
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
      // A function creeping toward its timeout is invisible in the error metric until it
      // starts failing — and a finalizer that times out mid-provider-call produces exactly
      // the UNKNOWN_EXTERNAL_STATE the design works hardest to avoid.
      alarm(
        `${entry.name}Duration`,
        entry.fn.metricDuration({ period: Duration.minutes(5), statistic: "p95" }),
        config.lambdaTimeout.toMilliseconds() * 0.8,
        `${entry.name} p95 duration is within 20% of its timeout`,
        2,
      );
    }

    // ---- ECS capacity --------------------------------------------------------
    // Autoscaling targets 60% CPU; sustained pressure well above that means scaling is
    // not keeping up, not that the target is wrong.
    alarm(
      "ApiCpuSaturation",
      props.service.metricCpuUtilization({
        period: Duration.minutes(5),
        statistic: "Average",
      }),
      85,
      "API tasks are CPU saturated; autoscaling is not keeping up",
      3,
    );
    alarm(
      "ApiMemorySaturation",
      props.service.metricMemoryUtilization({
        period: Duration.minutes(5),
        statistic: "Average",
      }),
      85,
      "API tasks are near their memory limit; a task OOM kill is imminent",
      3,
    );

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

    // The alarm above cannot detect a *total* outage: with every target deregistered,
    // UnHealthyHostCount reads zero or stops reporting altogether. Watching for the
    // presence of healthy capacity is the direct signal, and missing data must breach —
    // "the metric stopped arriving" is the outage, not the absence of one.
    alarm(
      "NoHealthyTargets",
      props.targetGroup.metrics.healthyHostCount({
        period: Duration.minutes(1),
        statistic: "Minimum",
      }),
      config.minCapacity,
      "Fewer healthy API tasks than the configured minimum; capacity is degraded or gone",
      2,
      cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
      cloudwatch.TreatMissingData.BREACHING,
    );

    // Application 5xx never appear in the ELB 5xx metric: the load balancer forwarded the
    // request successfully and the service answered badly.
    alarm(
      "Target5xx",
      props.targetGroup.metrics.httpCodeTarget(elbv2.HttpCodeTarget.TARGET_5XX_COUNT, {
        period: Duration.minutes(5),
        statistic: "Sum",
      }),
      10,
      "The API is returning 5xx to callers",
    );

    // The whole contract of this service is latency-shaped: a request either finishes
    // inside the synchronous wait or returns a deliberate 202 at it. p95 beyond that
    // ceiling means responses are escaping the budget the ladder is built around.
    alarm(
      "TargetLatency",
      props.targetGroup.metrics.targetResponseTime({
        period: Duration.minutes(5),
        statistic: "p95",
      }),
      config.syncWaitTimeoutMs / 1000,
      "p95 response time exceeds the synchronous wait budget",
      2,
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

    // The only direct signal that a workflow is stuck in PROCESSING past its business
    // deadline. The reconciler reports these and deliberately never fails them (D-029), so
    // if nobody watches this metric a stranded workflow is invisible until a customer asks.
    alarm(
      "StaleWorkflows",
      new cloudwatch.Metric({
        namespace: METRIC_NAMESPACE,
        metricName: "StaleWorkflow",
        period: Duration.minutes(5),
        statistic: "Maximum",
      }),
      0,
      "Workflows are still PROCESSING past their business deadline and are not progressing",
      2,
    );

    // Two workers reached opposite conclusions about one workflow. One of them is wrong,
    // the terminal state is immutable (INV-21), and no amount of retrying fixes it. This is
    // a correctness incident, not a capacity signal, so a single occurrence breaches.
    alarm(
      "TerminalDivergence",
      new cloudwatch.Metric({
        namespace: METRIC_NAMESPACE,
        metricName: "TerminalDivergence",
        period: Duration.minutes(5),
        statistic: "Sum",
      }),
      0,
      "Two workers reached different terminal outcomes for one workflow; investigate now",
    );

    // The API is still authenticating from a cached credential document, but revocations
    // have stopped propagating. Nothing is failing, which is exactly why it needs an alarm.
    alarm(
      "CredentialRefreshFailed",
      new cloudwatch.Metric({
        namespace: METRIC_NAMESPACE,
        metricName: "CredentialRefreshFailed",
        period: Duration.minutes(5),
        statistic: "Sum",
      }),
      0,
      "API key refreshes are failing; revoked keys will keep working until this recovers",
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

    // Emitted with a `reason` dimension at the call site. The metrics writer publishes an
    // aggregate (dimensionless) series alongside every dimensioned one precisely so this
    // alarm has something to read; without it the alarm would sit in INSUFFICIENT_DATA
    // forever and NOT_BREACHING would keep it silent.
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

    // ---- Deployment ----------------------------------------------------------
    // The circuit breaker and the rollback alarms in the API stack revert a bad rollout on
    // their own. That is worthless if it happens silently: an automatic rollback is an
    // incident that has already occurred, not an incident avoided.
    const deploymentFailures = new events.Rule(this, "DeploymentStateChange", {
      description: "ECS deployment failures and rollbacks for the API service",
      eventPattern: {
        source: ["aws.ecs"],
        detailType: ["ECS Deployment State Change"],
        detail: {
          eventName: ["SERVICE_DEPLOYMENT_FAILED"],
        },
        // Scoped to this service: another service failing to deploy is someone else's page.
        resources: [props.service.serviceArn],
      },
    });
    deploymentFailures.addTarget(
      new eventTargets.SnsTopic(this.alarmTopic, {
        message: events.RuleTargetInput.fromText(
          `${config.envName}: ECS deployment failed or was rolled back for ` +
            `${events.EventField.fromPath("$.detail.deploymentId")} — ` +
            events.EventField.fromPath("$.detail.reason"),
        ),
      }),
    );

    new CfnOutput(this, "AlarmTopicArn", { value: this.alarmTopic.topicArn });
  }
}
