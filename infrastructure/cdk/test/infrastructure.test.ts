import { describe, expect, it } from "vitest";
import { App } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import {
  environments,
  requiredVisibilityTimeout,
  type EnvironmentName,
} from "../lib/environment.js";
import { NetworkStack } from "../lib/network/network-stack.js";
import { DataStack } from "../lib/data/data-stack.js";
import { MessagingStack } from "../lib/messaging/messaging-stack.js";
import { WorkersStack } from "../lib/workers/workers-stack.js";
import { ApiStack } from "../lib/api/api-stack.js";

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
}

const buildStacks = (envName: EnvironmentName, options: BuildOptions = {}) => {
  const config = environments[envName];
  const withCertificate = options.withCertificate ?? true;
  const app = new App();
  const stackProps = { config, env: TEST_ENV };
  const network = new NetworkStack(app, "Net", {
    ...stackProps,
    availabilityZones: ["us-east-1a", "us-east-1b", "us-east-1c"],
  });
  const data = new DataStack(app, "Data", stackProps);
  const messaging = new MessagingStack(app, "Msg", stackProps);
  const workers = new WorkersStack(app, "Workers", {
    ...stackProps,
    table: data.table,
    startQueue: messaging.startQueue,
    stepQueue: messaging.stepQueue,
    providerBaseUrl: "https://provider.example",
  });
  const api = new ApiStack(app, "Api", {
    ...stackProps,
    vpc: network.vpc,
    albSecurityGroup: network.albSecurityGroup,
    serviceSecurityGroup: network.serviceSecurityGroup,
    table: data.table,
    imageTag: "test",
    ...(withCertificate ? { certificateArn: TEST_CERT } : {}),
  });
  return {
    config,
    templates: {
      network: Template.fromStack(network),
      data: Template.fromStack(data),
      messaging: Template.fromStack(messaging),
      workers: Template.fromStack(workers),
      api: Template.fromStack(api),
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
