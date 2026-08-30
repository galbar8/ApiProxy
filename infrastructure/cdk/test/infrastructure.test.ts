import { describe, expect, it } from "vitest";
import { App } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import {
  applyProfile,
  environments,
  healthCheckDetectionWindow,
  requiredVisibilityTimeout,
  type DeploymentProfile,
  type EnvironmentName,
} from "../lib/environment.js";
import { NetworkStack } from "../lib/network/network-stack.js";
import { EcrStack } from "../lib/ecr/ecr-stack.js";
import { DataStack } from "../lib/data/data-stack.js";
import { MessagingStack } from "../lib/messaging/messaging-stack.js";
import { WorkersStack } from "../lib/workers/workers-stack.js";
import { ApiStack } from "../lib/api/api-stack.js";
import { MonitoringStack } from "../lib/monitoring/monitoring-stack.js";

/**
 * These tests assert the values the *application* depends on.
 *
 * Nothing here checks that CDK produced CloudFormation. Each assertion corresponds to an
 * assumption the running code makes — a timeout ordering, a delivery guarantee, a
 * recovery setting — so infrastructure cannot drift away from the code that relies on it.
 */
const TEST_CERT = "arn:aws:acm:us-east-1:111122223333:certificate/test";
const TEST_ENV = { account: "111122223333", region: "us-east-1" };

interface BuildOptions {
  readonly withCertificate?: boolean;
  readonly imageTag?: string;
  readonly alarmEmails?: readonly string[];
  readonly providerBaseUrl?: string;
  readonly profile?: DeploymentProfile;
}

const buildStacks = (envName: EnvironmentName, options: BuildOptions = {}) => {
  // Defaulting to `standard` keeps every assertion below describing the real posture; the
  // minimal profile is asserted separately, additively, further down.
  const config = applyProfile(environments[envName], options.profile ?? "standard");
  const withCertificate = options.withCertificate ?? true;
  // Defaults are what a correct production invocation supplies; individual tests override
  // one at a time to prove the guard for that value.
  const imageTag = options.imageTag ?? "1a2b3c4d5e6f7890";
  const alarmEmails = options.alarmEmails ?? ["oncall@example.com"];
  const app = new App();
  const stackProps = { config, env: TEST_ENV };
  const network = new NetworkStack(app, "Net", {
    ...stackProps,
    availabilityZones: ["us-east-1a", "us-east-1b", "us-east-1c"],
  });
  const data = new DataStack(app, "Data", stackProps);
  const ecr = new EcrStack(app, "Ecr", stackProps);
  const messaging = new MessagingStack(app, "Msg", stackProps);
  const workers = new WorkersStack(app, "Workers", {
    ...stackProps,
    table: data.table,
    startQueue: messaging.startQueue,
    stepQueue: messaging.stepQueue,
    providerBaseUrl: options.providerBaseUrl ?? "https://provider.example.com",
  });
  const api = new ApiStack(app, "Api", {
    ...stackProps,
    vpc: network.vpc,
    albSecurityGroup: network.albSecurityGroup,
    serviceSecurityGroup: network.serviceSecurityGroup,
    table: data.table,
    repository: ecr.repository,
    imageTag,
    ...(withCertificate ? { certificateArn: TEST_CERT } : {}),
  });
  const monitoring = new MonitoringStack(app, "Mon", {
    ...stackProps,
    table: data.table,
    queues: [
      { name: "Start", queue: messaging.startQueue, dlq: messaging.startDlq },
      { name: "Step", queue: messaging.stepQueue, dlq: messaging.stepDlq },
    ],
    functions: [
      { name: "WorkerA", fn: workers.workerA },
      { name: "Finalizer", fn: workers.finalizer },
    ],
    loadBalancer: api.loadBalancer,
    targetGroup: api.targetGroup,
    service: api.service,
    streamDlq: workers.streamDlq,
    alarmEmails,
  });
  return {
    config,
    templates: {
      network: Template.fromStack(network),
      data: Template.fromStack(data),
      ecr: Template.fromStack(ecr),
      messaging: Template.fromStack(messaging),
      workers: Template.fromStack(workers),
      api: Template.fromStack(api),
      monitoring: Template.fromStack(monitoring),
    },
  };
};

describe("timeout ladder", () => {
  it.each(["dev", "staging", "production"] as const)(
    "is strictly increasing in %s",
    (envName) => {
      const config = environments[envName];
      expect(config.syncWaitTimeoutMs).toBeLessThan(config.requestTimeoutMs);
      expect(config.requestTimeoutMs).toBeLessThan(
        config.albIdleTimeout.toMilliseconds(),
      );
      expect(config.albIdleTimeout.toMilliseconds()).toBeLessThan(
        config.keepAliveTimeoutMs,
      );
      expect(config.clientRecommendedTimeoutMs).toBeGreaterThan(
        config.albIdleTimeout.toMilliseconds(),
      );
    },
  );

  it("gives ECS long enough to stop a task that is still draining", () => {
    for (const config of Object.values(environments)) {
      expect(config.stopTimeout.toMilliseconds()).toBeGreaterThan(
        config.shutdownDrainMs,
      );
      expect(config.shutdownDrainMs).toBeGreaterThanOrEqual(config.requestTimeoutMs);
    }
  });

  it("deregisters a target no faster than a request can finish", () => {
    for (const config of Object.values(environments)) {
      expect(config.deregistrationDelay.toMilliseconds()).toBeGreaterThanOrEqual(
        config.syncWaitTimeoutMs,
      );
    }
  });
});

describe("queues", () => {
  const { templates, config } = buildStacks("production");

  it("sets a visibility timeout that covers the full Lambda retry window", () => {
    const expected = requiredVisibilityTimeout(
      config.lambdaTimeout,
      config.batchingWindow,
    ).toSeconds();
    expect(expected).toBe(185);

    templates.messaging.hasResourceProperties("AWS::SQS::Queue", {
      VisibilityTimeout: expected,
      RedrivePolicy: Match.objectLike({ maxReceiveCount: config.maxReceiveCount }),
    });
  });

  it("never lets the visibility timeout fall below the Lambda timeout", () => {
    expect(
      requiredVisibilityTimeout(
        config.lambdaTimeout,
        config.batchingWindow,
      ).toSeconds(),
    ).toBeGreaterThanOrEqual(config.lambdaTimeout.toSeconds());
  });

  it("gives every processing queue a DLQ", () => {
    // Two work queues, two DLQs.
    templates.messaging.resourceCountIs("AWS::SQS::Queue", 4);
    const queues = templates.messaging.findResources("AWS::SQS::Queue");
    const withRedrive = Object.values(queues).filter(
      (queue) =>
        (queue["Properties"] as { RedrivePolicy?: unknown }).RedrivePolicy !==
        undefined,
    );
    expect(withRedrive).toHaveLength(2);
  });

  it("encrypts queues and requires TLS", () => {
    const queues = templates.messaging.findResources("AWS::SQS::Queue");
    for (const queue of Object.values(queues)) {
      expect(
        (queue["Properties"] as { SqsManagedSseEnabled?: boolean })
          .SqsManagedSseEnabled,
      ).toBe(true);
    }
    templates.messaging.resourceCountIs("AWS::SQS::QueuePolicy", 4);
  });
});

describe("event source mappings", () => {
  const { templates, config } = buildStacks("production");

  it("reports partial batch failures on every source", () => {
    const mappings = templates.workers.findResources("AWS::Lambda::EventSourceMapping");
    expect(Object.keys(mappings).length).toBe(3);
    for (const mapping of Object.values(mappings)) {
      expect(
        (mapping["Properties"] as { FunctionResponseTypes?: string[] })
          .FunctionResponseTypes,
      ).toEqual(["ReportBatchItemFailures"]);
    }
  });

  it("applies backpressure with a concurrency ceiling on the queue consumers", () => {
    templates.workers.hasResourceProperties("AWS::Lambda::EventSourceMapping", {
      ScalingConfig: { MaximumConcurrency: config.esmMaxConcurrency },
    });
  });

  it("gives the stream consumer a failure destination so a poison record is not lost", () => {
    templates.workers.hasResourceProperties("AWS::Lambda::EventSourceMapping", {
      DestinationConfig: Match.objectLike({ OnFailure: Match.anyValue() }),
      BisectBatchOnFunctionError: true,
    });
  });
});

describe("dynamodb table", () => {
  it("streams both images, which the outbox publisher depends on", () => {
    const { templates } = buildStacks("production");
    templates.data.hasResourceProperties("AWS::DynamoDB::Table", {
      StreamSpecification: { StreamViewType: "NEW_AND_OLD_IMAGES" },
    });
  });

  it("expires items through the attribute the code writes", () => {
    const { templates } = buildStacks("production");
    templates.data.hasResourceProperties("AWS::DynamoDB::Table", {
      TimeToLiveSpecification: { AttributeName: "expiresAt", Enabled: true },
    });
  });

  it("projects the two sparse indexes as the repository expects", () => {
    const { templates } = buildStacks("production");
    templates.data.hasResourceProperties("AWS::DynamoDB::Table", {
      GlobalSecondaryIndexes: Match.arrayWith([
        Match.objectLike({
          IndexName: "gsi1-pending-outbox",
          Projection: { ProjectionType: "ALL" },
        }),
        Match.objectLike({
          IndexName: "gsi2-processing-workflows",
          Projection: { ProjectionType: "KEYS_ONLY" },
        }),
      ]),
    });
  });

  it("protects production data and allows a dev table to be thrown away", () => {
    const production = buildStacks("production").templates.data;
    production.hasResourceProperties("AWS::DynamoDB::Table", {
      PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true },
      DeletionProtectionEnabled: true,
      SSESpecification: { SSEEnabled: true },
    });
    production.hasResource("AWS::DynamoDB::Table", {
      DeletionPolicy: "Retain",
      UpdateReplacePolicy: "Retain",
    });

    buildStacks("dev").templates.data.hasResource("AWS::DynamoDB::Table", {
      DeletionPolicy: "Delete",
    });
  });
});

describe("api service", () => {
  const { templates, config } = buildStacks("production");

  it("configures the ALB idle timeout deliberately rather than taking the default", () => {
    templates.api.hasResourceProperties("AWS::ElasticLoadBalancingV2::LoadBalancer", {
      LoadBalancerAttributes: Match.arrayWith([
        {
          Key: "idle_timeout.timeout_seconds",
          Value: String(config.albIdleTimeout.toSeconds()),
        },
      ]),
    });
  });

  it("drains targets slowly enough for an in-flight request to finish", () => {
    templates.api.hasResourceProperties("AWS::ElasticLoadBalancingV2::TargetGroup", {
      TargetGroupAttributes: Match.arrayWith([
        {
          Key: "deregistration_delay.timeout_seconds",
          Value: String(config.deregistrationDelay.toSeconds()),
        },
      ]),
      HealthCheckPath: "/health/ready",
    });
  });

  it("terminates TLS and redirects plaintext, so bearer credentials never travel in clear", () => {
    templates.api.hasResourceProperties("AWS::ElasticLoadBalancingV2::Listener", {
      Protocol: "HTTPS",
      Port: 443,
    });
    templates.api.hasResourceProperties("AWS::ElasticLoadBalancingV2::Listener", {
      Port: 80,
      DefaultActions: Match.arrayWith([
        Match.objectLike({
          Type: "redirect",
          RedirectConfig: Match.objectLike({ Protocol: "HTTPS" }),
        }),
      ]),
    });
  });

  it("refuses to build production without a certificate", () => {
    expect(() => buildStacks("production", { withCertificate: false })).toThrow(
      /certificateArn/,
    );
  });

  it("runs redundantly across availability zones in production", () => {
    templates.api.hasResourceProperties("AWS::ECS::Service", {
      DesiredCount: config.desiredCount,
      DeploymentConfiguration: Match.objectLike({
        DeploymentCircuitBreaker: { Enable: true, Rollback: true },
      }),
    });
    expect(config.desiredCount).toBeGreaterThanOrEqual(config.maxAzs);
  });

  it("gives the container long enough to drain before SIGKILL", () => {
    templates.api.hasResourceProperties("AWS::ECS::TaskDefinition", {
      ContainerDefinitions: Match.arrayWith([
        Match.objectLike({ StopTimeout: config.stopTimeout.toSeconds() }),
      ]),
    });
  });

  it("passes the application the same timeout ladder the ALB is configured with", () => {
    templates.api.hasResourceProperties("AWS::ECS::TaskDefinition", {
      ContainerDefinitions: Match.arrayWith([
        Match.objectLike({
          Environment: Match.arrayWith([
            { Name: "SYNC_WAIT_TIMEOUT_MS", Value: String(config.syncWaitTimeoutMs) },
            {
              Name: "ALB_IDLE_TIMEOUT_MS",
              Value: String(config.albIdleTimeout.toMilliseconds()),
            },
            {
              Name: "HTTP_KEEP_ALIVE_TIMEOUT_MS",
              Value: String(config.keepAliveTimeoutMs),
            },
          ]),
        }),
      ]),
    });
  });

  it("puts a WAF in front of the public endpoint", () => {
    templates.api.resourceCountIs("AWS::WAFv2::WebACL", 1);
    templates.api.resourceCountIs("AWS::WAFv2::WebACLAssociation", 1);
  });

  it("always rate-limits per IP, because a synchronous API holds capacity per request", () => {
    templates.api.hasResourceProperties("AWS::WAFv2::WebACL", {
      Rules: Match.arrayWith([
        Match.objectLike({
          Name: "RateLimitPerIp",
          Action: { Block: {} },
          Statement: Match.objectLike({
            RateBasedStatement: Match.objectLike({
              Limit: config.wafRateLimitPerIp,
              AggregateKeyType: "IP",
            }),
          }),
        }),
      ]),
    });
  });

  it("blocks on managed rules in production and only counts in dev", () => {
    templates.api.hasResourceProperties("AWS::WAFv2::WebACL", {
      Rules: Match.arrayWith([
        Match.objectLike({
          Name: "AWSManagedRulesCommonRuleSet",
          OverrideAction: { None: {} },
        }),
      ]),
    });

    buildStacks("dev").templates.api.hasResourceProperties("AWS::WAFv2::WebACL", {
      Rules: Match.arrayWith([
        Match.objectLike({
          Name: "AWSManagedRulesCommonRuleSet",
          OverrideAction: { Count: {} },
        }),
      ]),
    });
  });

  it("does not let WAF body-size rules reject payloads the API accepts by contract", () => {
    templates.api.hasResourceProperties("AWS::WAFv2::WebACL", {
      Rules: Match.arrayWith([
        Match.objectLike({
          Name: "AWSManagedRulesCommonRuleSet",
          Statement: Match.objectLike({
            ManagedRuleGroupStatement: Match.objectLike({
              RuleActionOverrides: Match.arrayWith([
                Match.objectLike({ Name: "SizeRestrictions_BODY" }),
              ]),
            }),
          }),
        }),
      ]),
    });
  });

  it("autoscales rather than running at a fixed size", () => {
    templates.api.hasResourceProperties("AWS::ApplicationAutoScaling::ScalableTarget", {
      MinCapacity: config.minCapacity,
      MaxCapacity: config.maxCapacity,
    });
  });
});

describe("least privilege", () => {
  const { templates } = buildStacks("production");

  const statementsOf = (
    template: Template,
  ): { Action?: unknown; Resource?: unknown }[] => {
    const policies = template.findResources("AWS::IAM::Policy");
    return Object.values(policies).flatMap(
      (policy) =>
        (
          policy["Properties"] as {
            PolicyDocument: { Statement: { Action?: unknown; Resource?: unknown }[] };
          }
        ).PolicyDocument.Statement,
    );
  };

  it("grants the api no SQS permissions at all, because it never publishes", () => {
    const actions = JSON.stringify(statementsOf(templates.api));
    expect(actions).not.toContain("sqs:SendMessage");
    expect(actions).not.toContain("sqs:ReceiveMessage");
  });

  it("never grants a bare wildcard resource on the workflow path", () => {
    // `dynamodb:ListStreams` is the one action AWS does not allow to be
    // resource-scoped; the stream consumer needs it and nothing else is exempt.
    const wildcardAllowed = new Set(["dynamodb:ListStreams"]);

    for (const template of [templates.api, templates.workers]) {
      for (const statement of statementsOf(template)) {
        const resource = JSON.stringify(statement.Resource ?? "");
        const actions = [statement.Action ?? ""].flat().map(String);
        const touchesWorkflow = actions.some(
          (action) => action.startsWith("dynamodb:") || action.startsWith("sqs:"),
        );
        if (!touchesWorkflow) continue;
        if (actions.every((action) => wildcardAllowed.has(action))) continue;
        expect(resource).not.toBe('"*"');
      }
    }
  });

  it("does not grant dynamodb:DeleteItem or Scan to any worker", () => {
    const actions = JSON.stringify(statementsOf(templates.workers));
    expect(actions).not.toContain("dynamodb:DeleteItem");
    expect(actions).not.toContain("dynamodb:Scan");
  });
});

describe("network", () => {
  it("runs without NAT gateways and reaches AWS services through endpoints", () => {
    const { templates } = buildStacks("production");
    templates.network.resourceCountIs("AWS::EC2::NatGateway", 0);
    templates.network.resourceCountIs("AWS::EC2::VPCEndpoint", 7);
  });

  it("spreads production across three availability zones", () => {
    const { templates, config } = buildStacks("production");
    expect(config.maxAzs).toBe(3);
    // One public and one private subnet per AZ.
    templates.network.resourceCountIs("AWS::EC2::Subnet", config.maxAzs * 2);
  });

  it("refuses to build production without enough availability zones", () => {
    const config = environments.production;
    const app = new App();
    expect(
      () =>
        new NetworkStack(app, "Net", {
          config,
          env: TEST_ENV,
          availabilityZones: ["us-east-1a", "us-east-1b"],
        }),
    ).toThrow(/requires 3 availability zones/);
  });

  it("refuses an environment-agnostic production stack, which would halve redundancy", () => {
    expect(
      () => new NetworkStack(new App(), "Net", { config: environments.production }),
    ).toThrow(/availability zones/);
  });
});

describe("egress", () => {
  const { templates } = buildStacks("production");

  /**
   * The failure this test exists for: a security group whose only egress rule is the VPC
   * CIDR looks correct and is fatal. Gateway endpoints (DynamoDB, S3) keep the service's
   * public address and are matched by an AWS-managed prefix list, so a CIDR-scoped rule
   * drops every DynamoDB call and every ECR image layer — and the task never starts.
   * Asserting that the endpoints exist, as the network test below does, cannot catch this.
   */
  it("lets tasks reach gateway endpoints, which are outside the VPC CIDR", () => {
    templates.network.hasResourceProperties("AWS::EC2::SecurityGroup", {
      GroupDescription: Match.stringLikeRegexp("API tasks"),
      SecurityGroupEgress: Match.arrayWith([
        Match.objectLike({ CidrIp: "0.0.0.0/0", FromPort: 443, ToPort: 443 }),
      ]),
    });
  });

  it("lets tasks resolve the private DNS names the endpoints depend on", () => {
    templates.network.hasResourceProperties("AWS::EC2::SecurityGroup", {
      GroupDescription: Match.stringLikeRegexp("API tasks"),
      SecurityGroupEgress: Match.arrayWith([
        Match.objectLike({ IpProtocol: "udp", FromPort: 53, ToPort: 53 }),
      ]),
    });
  });

  it("keeps the tasks unreachable from anywhere but the load balancer", () => {
    templates.network.hasResourceProperties("AWS::EC2::SecurityGroup", {
      GroupDescription: Match.stringLikeRegexp("API tasks"),
      SecurityGroupIngress: Match.absent(),
    });
    templates.api.hasResourceProperties("AWS::ECS::Service", {
      NetworkConfiguration: Match.objectLike({
        AwsvpcConfiguration: Match.objectLike({ AssignPublicIp: "DISABLED" }),
      }),
    });
  });
});

describe("image provenance", () => {
  it("refuses a mutable production image tag, which would make rollback meaningless", () => {
    for (const tag of ["latest", "main", "stable"]) {
      expect(() => buildStacks("production", { imageTag: tag })).toThrow(
        /immutable imageTag/,
      );
    }
  });

  it("accepts a digest or a version as an immutable reference", () => {
    expect(() =>
      buildStacks("production", { imageTag: `sha256:${"a".repeat(64)}` }),
    ).not.toThrow();
    expect(() => buildStacks("production", { imageTag: "v1.4.2" })).not.toThrow();
  });

  it("does not let a production tag be repointed after the fact", () => {
    const { templates } = buildStacks("production");
    templates.ecr.hasResourceProperties("AWS::ECR::Repository", {
      ImageTagMutability: "IMMUTABLE",
    });
  });

  it("leaves dev free to overwrite tags", () => {
    const { templates } = buildStacks("dev", { imageTag: "latest" });
    templates.ecr.hasResourceProperties("AWS::ECR::Repository", {
      ImageTagMutability: "MUTABLE",
    });
  });

  it("refuses a placeholder provider endpoint in production", () => {
    expect(() =>
      buildStacks("production", { providerBaseUrl: "https://provider.invalid" }),
    ).toThrow(/placeholder/);
    expect(() =>
      buildStacks("production", { providerBaseUrl: "http://provider.example.com" }),
    ).toThrow(/https/);
  });
});

describe("alarm delivery", () => {
  /**
   * Alarms are only a failure mechanism if a human receives them. A topic with no
   * subscription turns every alarm in the monitoring stack into a metric nobody reads,
   * which is precisely the outcome the DLQ alarms exist to prevent.
   */
  it("subscribes someone to the alarm topic", () => {
    const { templates } = buildStacks("production", {
      alarmEmails: ["oncall@example.com", "sre@example.com"],
    });
    templates.monitoring.resourceCountIs("AWS::SNS::Subscription", 2);
    templates.monitoring.hasResourceProperties("AWS::SNS::Subscription", {
      Protocol: "email",
      Endpoint: "oncall@example.com",
    });
  });

  it("refuses to build production with no alarm subscriber at all", () => {
    expect(() => buildStacks("production", { alarmEmails: [] })).toThrow(
      /alarm subscriber/,
    );
  });

  it("points every alarm at that topic", () => {
    const { templates } = buildStacks("production");
    const alarms = templates.monitoring.findResources(
      "AWS::CloudWatch::Alarm",
    ) as Record<string, { Properties: { AlarmActions?: unknown[] } }>;
    expect(Object.keys(alarms).length).toBeGreaterThan(0);
    for (const [name, alarm] of Object.entries(alarms)) {
      expect(alarm.Properties.AlarmActions, `${name} notifies nobody`).toHaveLength(1);
    }
  });
});

describe("alarms cover the failures that matter", () => {
  const { templates, config } = buildStacks("production");

  /**
   * `SyncTimeouts` is emitted with a `reason` dimension. CloudWatch treats each dimension
   * set as a separate metric, so an alarm with no dimensions only ever sees data because
   * the metrics writer publishes the aggregate series too. If that ever stops, this alarm
   * sits in INSUFFICIENT_DATA and NOT_BREACHING keeps it silent — the single most
   * important business alarm, permanently off.
   */
  it("alarms on the aggregate sync-deadline metric, which must therefore be emitted", () => {
    templates.monitoring.hasResourceProperties("AWS::CloudWatch::Alarm", {
      MetricName: "SyncTimeouts",
      Namespace: "WorkflowService",
      Dimensions: Match.absent(),
    });
  });

  it("notices a total loss of capacity, which the unhealthy-host metric cannot show", () => {
    templates.monitoring.hasResourceProperties("AWS::CloudWatch::Alarm", {
      MetricName: "HealthyHostCount",
      ComparisonOperator: "LessThanThreshold",
      Threshold: config.minCapacity,
      // With every target gone the metric stops arriving; missing data IS the outage.
      TreatMissingData: "breaching",
    });
  });

  it("separates application 5xx from load-balancer 5xx", () => {
    templates.monitoring.hasResourceProperties("AWS::CloudWatch::Alarm", {
      MetricName: "HTTPCode_Target_5XX_Count",
    });
    templates.monitoring.hasResourceProperties("AWS::CloudWatch::Alarm", {
      MetricName: "HTTPCode_ELB_5XX_Count",
    });
  });

  it("alarms when responses escape the synchronous budget", () => {
    templates.monitoring.hasResourceProperties("AWS::CloudWatch::Alarm", {
      MetricName: "TargetResponseTime",
      Threshold: config.syncWaitTimeoutMs / 1000,
    });
  });

  it("watches task saturation and lambda duration, not just errors", () => {
    templates.monitoring.hasResourceProperties("AWS::CloudWatch::Alarm", {
      MetricName: "CPUUtilization",
      Namespace: "AWS/ECS",
    });
    templates.monitoring.hasResourceProperties("AWS::CloudWatch::Alarm", {
      MetricName: "MemoryUtilization",
      Namespace: "AWS/ECS",
    });
    templates.monitoring.hasResourceProperties("AWS::CloudWatch::Alarm", {
      MetricName: "Duration",
      Namespace: "AWS/Lambda",
      Threshold: config.lambdaTimeout.toMilliseconds() * 0.8,
    });
  });
});

describe("deployment safety", () => {
  const { templates } = buildStacks("production");

  it("rolls back a deployment that starts, then serves errors", () => {
    templates.api.hasResourceProperties("AWS::ECS::Service", {
      DeploymentConfiguration: Match.objectLike({
        DeploymentCircuitBreaker: { Enable: true, Rollback: true },
        Alarms: Match.objectLike({ Enable: true, Rollback: true }),
      }),
    });
  });

  it("keeps at least the current capacity serving during a rollout", () => {
    templates.api.hasResourceProperties("AWS::ECS::Service", {
      DeploymentConfiguration: Match.objectLike({
        MinimumHealthyPercent: 100,
        MaximumPercent: 200,
      }),
    });
  });

  /** An automatic rollback is an incident that happened, not one that was avoided. */
  it("makes a failed deployment visible instead of silently reverting it", () => {
    templates.monitoring.hasResourceProperties("AWS::Events::Rule", {
      EventPattern: Match.objectLike({
        source: ["aws.ecs"],
        "detail-type": ["ECS Deployment State Change"],
      }),
      Targets: Match.arrayWith([Match.objectLike({ Arn: Match.anyValue() })]),
    });
  });
});

describe("drain window", () => {
  it("keeps serving until the load balancer has certainly stopped routing", () => {
    for (const config of Object.values(environments)) {
      // The application flips readiness, then waits. If it stops waiting before the ALB
      // has observed enough failed checks, requests arriving in the gap hit a closed
      // listener and become ALB 5xx.
      expect(config.shutdownReadinessDelayMs).toBeGreaterThan(
        healthCheckDetectionWindow(config).toMilliseconds(),
      );
      // And the whole sequence has to fit inside the SIGKILL deadline.
      expect(config.stopTimeout.toMilliseconds()).toBeGreaterThan(
        config.shutdownReadinessDelayMs + config.shutdownDrainMs,
      );
    }
  });

  it("checks liveness at the container level, where ECS actually looks", () => {
    const { templates } = buildStacks("production");
    templates.api.hasResourceProperties("AWS::ECS::TaskDefinition", {
      ContainerDefinitions: Match.arrayWith([
        Match.objectLike({
          HealthCheck: Match.objectLike({
            Command: Match.arrayWith([Match.stringLikeRegexp("health/live")]),
          }),
        }),
      ]),
    });
  });
});

describe("capacity", () => {
  const { templates, config } = buildStacks("production");

  /**
   * CPU and memory both under-report this service: a task holding 200 open 20-second waits
   * is nearly idle on each. Request count per target is the only available metric that
   * tracks the resource that actually runs out.
   */
  it("scales on held connections rather than on CPU alone", () => {
    templates.api.hasResourceProperties("AWS::ApplicationAutoScaling::ScalingPolicy", {
      TargetTrackingScalingPolicyConfiguration: Match.objectLike({
        TargetValue: config.requestsPerTargetPerMinute,
        PredefinedMetricSpecification: Match.objectLike({
          PredefinedMetricType: "ALBRequestCountPerTarget",
        }),
      }),
    });
  });

  it("never scales in faster than a task can finish and deregister", () => {
    const policies = templates.api.findResources(
      "AWS::ApplicationAutoScaling::ScalingPolicy",
    ) as Record<
      string,
      {
        Properties: {
          TargetTrackingScalingPolicyConfiguration: { ScaleInCooldown: number };
        };
      }
    >;
    for (const [name, policy] of Object.entries(policies)) {
      const cooldown =
        policy.Properties.TargetTrackingScalingPolicyConfiguration.ScaleInCooldown;
      expect(cooldown * 1000, `${name} scales in too fast`).toBeGreaterThan(
        config.requestTimeoutMs + config.deregistrationDelay.toMilliseconds(),
      );
    }
  });

  it("protects the production front door the way it protects the data", () => {
    templates.api.hasResourceProperties("AWS::ElasticLoadBalancingV2::LoadBalancer", {
      LoadBalancerAttributes: Match.arrayWith([
        { Key: "deletion_protection.enabled", Value: "true" },
      ]),
    });
  });
});

describe("reachability gaps that only a real deployment would expose", () => {
  const { templates } = buildStacks("production");

  /**
   * ECS does not inject `AWS_REGION` into a container the way Lambda does, and
   * `packages/config` defaults it to `us-east-1`. A task deployed anywhere else would
   * therefore point its DynamoDB and Secrets Manager clients at a region holding neither
   * the table nor the secret — and every request would fail (G-001).
   */
  it("tells the API container which region it is running in", () => {
    templates.api.hasResourceProperties("AWS::ECS::TaskDefinition", {
      ContainerDefinitions: Match.arrayWith([
        Match.objectLike({
          Environment: Match.arrayWith([
            Match.objectLike({ Name: "AWS_REGION", Value: TEST_ENV.region }),
          ]),
        }),
      ]),
    });
  });

  /**
   * `PUBLIC_BASE_URL` builds the `pollUrl` returned with every 202. The application
   * default is `http://localhost:8080`, so an unset value hands each timed-out B2B caller
   * a recovery URL pointing at its own machine (G-002).
   */
  it("gives the API container a public origin that is not localhost", () => {
    const task = Object.values(
      templates.api.findResources("AWS::ECS::TaskDefinition"),
    )[0] as {
      Properties: {
        ContainerDefinitions: { Environment: { Name: string; Value: unknown }[] }[];
      };
    };
    const entry = task.Properties.ContainerDefinitions[0]?.Environment.find(
      (variable) => variable.Name === "PUBLIC_BASE_URL",
    );
    expect(entry).toBeDefined();
    expect(JSON.stringify(entry?.Value)).toContain("DNSName");
    expect(JSON.stringify(entry?.Value)).not.toContain("localhost");
  });

  it("prefers an explicitly supplied origin over the load balancer's own name", () => {
    const app = new App();
    const config = environments.production;
    const stackProps = { config, env: TEST_ENV };
    const network = new NetworkStack(app, "Net", {
      ...stackProps,
      availabilityZones: ["us-east-1a", "us-east-1b", "us-east-1c"],
    });
    const data = new DataStack(app, "Data", stackProps);
    const ecr = new EcrStack(app, "Ecr", stackProps);
    const api = new ApiStack(app, "Api", {
      ...stackProps,
      vpc: network.vpc,
      albSecurityGroup: network.albSecurityGroup,
      serviceSecurityGroup: network.serviceSecurityGroup,
      table: data.table,
      repository: ecr.repository,
      imageTag: "1a2b3c4d5e6f7890",
      certificateArn: TEST_CERT,
      publicBaseUrl: "https://api.example.com",
    });
    Template.fromStack(api).hasResourceProperties("AWS::ECS::TaskDefinition", {
      ContainerDefinitions: Match.arrayWith([
        Match.objectLike({
          Environment: Match.arrayWith([
            Match.objectLike({
              Name: "PUBLIC_BASE_URL",
              Value: "https://api.example.com",
            }),
          ]),
        }),
      ]),
    });
  });

  /**
   * Port 80 carries a listener in every environment — dev serves on it, the others
   * redirect from it — and the security group previously admitted 443 only, so a dev
   * environment deployed successfully and could not be called at all (G-003).
   */
  it("admits traffic on both listener ports", () => {
    for (const port of [80, 443]) {
      templates.network.hasResourceProperties("AWS::EC2::SecurityGroup", {
        GroupDescription: Match.stringLikeRegexp(
          "Ingress for the public load balancer",
        ),
        SecurityGroupIngress: Match.arrayWith([
          Match.objectLike({ CidrIp: "0.0.0.0/0", FromPort: port, ToPort: port }),
        ]),
      });
    }
  });

  /**
   * The repository and the service that pulls from it must not be created by the same
   * deployment: on a first deploy there is then nowhere to push an image before the
   * service tries to run one (G-004).
   */
  it("creates the image repository outside the stack that consumes it", () => {
    templates.ecr.resourceCountIs("AWS::ECR::Repository", 1);
    templates.api.resourceCountIs("AWS::ECR::Repository", 0);
  });

  it("lets a throwaway environment actually be thrown away", () => {
    // A repository still holding images blocks its own deletion, which turns "delete the
    // dev environment" into a manual hunt through the console.
    buildStacks("dev").templates.ecr.hasResourceProperties("AWS::ECR::Repository", {
      EmptyOnDelete: true,
    });
    // Never where the policy is RETAIN: production images outlive the stack on purpose.
    buildStacks("production").templates.ecr.hasResourceProperties(
      "AWS::ECR::Repository",
      {
        EmptyOnDelete: Match.absent(),
      },
    );
  });
});

describe("deployment profiles", () => {
  const interfaceEndpointsOf = (template: Template): number =>
    Object.keys(
      template.findResources("AWS::EC2::VPCEndpoint", {
        Properties: { VpcEndpointType: "Interface" },
      }),
    ).length;

  /**
   * The guard this whole feature depends on. `minimal` gives up the web ACL, the private
   * network path and the container metrics; an environment carrying real traffic may not
   * lose any of them because a flag was passed on a command line.
   */
  it("refuses to strip a real environment down to the minimal profile", () => {
    for (const envName of ["staging", "production"] as const) {
      expect(() => buildStacks(envName, { profile: "minimal" })).toThrow(
        /only available for dev/,
      );
    }
  });

  it("leaves the standard profile as the default, including for dev", () => {
    const { templates } = buildStacks("dev");
    templates.api.resourceCountIs("AWS::WAFv2::WebACL", 1);
    expect(interfaceEndpointsOf(templates.network)).toBe(5);
    templates.api.hasResourceProperties("AWS::ECS::Cluster", {
      ClusterSettings: [{ Name: "containerInsights", Value: "enabled" }],
    });
  });

  describe("minimal", () => {
    const { templates } = buildStacks("dev", { profile: "minimal" });

    it("deploys no web ACL at all, not merely a permissive one", () => {
      templates.api.resourceCountIs("AWS::WAFv2::WebACL", 0);
      templates.api.resourceCountIs("AWS::WAFv2::WebACLAssociation", 0);
    });

    it("drops the interface endpoints and keeps the free gateway ones", () => {
      // The five interface endpoints are the largest standing charge in an idle
      // environment. The gateway endpoints cost nothing and keep DynamoDB and the ECR
      // image layers off any public path, so they stay in both profiles.
      expect(interfaceEndpointsOf(templates.network)).toBe(0);
      expect(
        Object.keys(
          templates.network.findResources("AWS::EC2::VPCEndpoint", {
            Properties: { VpcEndpointType: "Gateway" },
          }),
        ),
      ).toHaveLength(2);
    });

    /**
     * The two halves must agree. An isolated subnet has no route to ECR once the
     * interface endpoints are gone, so a task left there would never pull its image —
     * this asserts the placement moved with them.
     */
    it("places tasks where they can still reach ECR without those endpoints", () => {
      templates.api.hasResourceProperties("AWS::ECS::Service", {
        NetworkConfiguration: Match.objectLike({
          AwsvpcConfiguration: Match.objectLike({ AssignPublicIp: "ENABLED" }),
        }),
      });
    });

    it("still refuses every route into a task except the load balancer", () => {
      // A public IP is not an open door: ingress is unchanged, and this is the assertion
      // that keeps it that way.
      templates.network.hasResourceProperties("AWS::EC2::SecurityGroup", {
        GroupDescription: Match.stringLikeRegexp("API tasks"),
        SecurityGroupIngress: Match.absent(),
      });
    });

    it("turns container insights off", () => {
      templates.api.hasResourceProperties("AWS::ECS::Cluster", {
        ClusterSettings: [{ Name: "containerInsights", Value: "disabled" }],
      });
    });

    it("keeps every queue, DLQ and alarm, which are not the expensive part", () => {
      // Cost is not a reason to run a queue without a DLQ alarm (INV-45): the whole
      // monitoring stack is a rounding error next to the endpoints above.
      const { templates: minimal } = buildStacks("dev", { profile: "minimal" });
      expect(
        Object.keys(minimal.monitoring.findResources("AWS::CloudWatch::Alarm")).length,
      ).toBe(
        Object.keys(
          buildStacks("dev").templates.monitoring.findResources(
            "AWS::CloudWatch::Alarm",
          ),
        ).length,
      );
    });
  });
});
