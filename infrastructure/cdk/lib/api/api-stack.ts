import { CfnOutput, Duration, Stack, type StackProps } from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ecr from "aws-cdk-lib/aws-ecr";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as elbv2 from "aws-cdk-lib/aws-elasticloadbalancingv2";
import * as iam from "aws-cdk-lib/aws-iam";
import * as logs from "aws-cdk-lib/aws-logs";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import type * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import type { Construct } from "constructs";
import type { EnvironmentConfig } from "../environment.js";
import { ApiWebAcl } from "./waf.js";

export interface ApiStackProps extends StackProps {
  readonly config: EnvironmentConfig;
  readonly vpc: ec2.Vpc;
  readonly albSecurityGroup: ec2.SecurityGroup;
  readonly serviceSecurityGroup: ec2.SecurityGroup;
  readonly table: dynamodb.Table;
  /** Image tag to run. Pushed to ECR before deployment; synth never needs Docker. */
  readonly imageTag: string;
  /** ACM certificate for the HTTPS listener. Required outside dev. */
  readonly certificateArn?: string;
}

/**
 * The synchronous façade: ALB in front of a Fargate service across multiple AZs.
 *
 * The timeout relationships here are the ones that decide whether a caller gets a
 * controlled `202` or a `502`, so each is set from the shared environment config rather
 * than left at an AWS default.
 */
export class ApiStack extends Stack {
  readonly service: ecs.FargateService;
  readonly loadBalancer: elbv2.ApplicationLoadBalancer;
  readonly targetGroup: elbv2.ApplicationTargetGroup;
  readonly apiKeySecret: secretsmanager.Secret;
  readonly repository: ecr.Repository;
  readonly webAcl: ApiWebAcl;

  constructor(scope: Construct, id: string, props: ApiStackProps) {
    super(scope, id, props);
    const { config, vpc } = props;

    this.repository = new ecr.Repository(this, "ApiRepository", {
      imageScanOnPush: true,
      removalPolicy: config.removalPolicy,
      lifecycleRules: [{ maxImageCount: 20 }],
    });

    // Credential store (ADR-0002). The value is populated out of band; the stack creates
    // the container, never the credentials.
    this.apiKeySecret = new secretsmanager.Secret(this, "ApiKeys", {
      description: "Per-tenant API key hashes for the B2B API",
      removalPolicy: config.removalPolicy,
    });

    const cluster = new ecs.Cluster(this, "Cluster", {
      vpc,
      containerInsightsV2: ecs.ContainerInsights.ENABLED,
    });

    const taskDefinition = new ecs.FargateTaskDefinition(this, "ApiTask", {
      cpu: config.cpu,
      memoryLimitMiB: config.memoryMiB,
      runtimePlatform: {
        cpuArchitecture: ecs.CpuArchitecture.ARM64,
        operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
      },
    });

    // The API creates workflows and reads them back. It never sends to SQS — publication
    // is the outbox publisher's job — so it is granted no SQS permissions at all.
    taskDefinition.addToTaskRolePolicy(
      new iam.PolicyStatement({
        actions: [
          "dynamodb:GetItem",
          "dynamodb:PutItem",
          "dynamodb:ConditionCheckItem",
          "dynamodb:TransactWriteItems",
        ],
        resources: [props.table.tableArn],
      }),
    );
    this.apiKeySecret.grantRead(taskDefinition.taskRole);

    const container = taskDefinition.addContainer("api", {
      image: ecs.ContainerImage.fromEcrRepository(this.repository, props.imageTag),
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: "api",
        logGroup: new logs.LogGroup(this, "ApiLogs", {
          retention: config.logRetentionDays,
          removalPolicy: config.removalPolicy,
        }),
      }),
      environment: {
        APP_ENV: config.envName,
        PORT: "8080",
        WORKFLOW_TABLE_NAME: props.table.tableName,
        API_KEYS_SECRET_ID: this.apiKeySecret.secretName,

        // The ladder, rendered from the same object the ALB below is configured from.
        SYNC_WAIT_TIMEOUT_MS: String(config.syncWaitTimeoutMs),
        HTTP_REQUEST_TIMEOUT_MS: String(config.requestTimeoutMs),
        ALB_IDLE_TIMEOUT_MS: String(config.albIdleTimeout.toMilliseconds()),
        HTTP_KEEP_ALIVE_TIMEOUT_MS: String(config.keepAliveTimeoutMs),
        HTTP_HEADERS_TIMEOUT_MS: String(config.headersTimeoutMs),
        CLIENT_RECOMMENDED_TIMEOUT_MS: String(config.clientRecommendedTimeoutMs),
        SHUTDOWN_DRAIN_MS: String(config.shutdownDrainMs),
        SHUTDOWN_READINESS_DELAY_MS: String(config.shutdownReadinessDelayMs),
        BUSINESS_DEADLINE_MS: String(config.businessDeadlineMs),
        WORKFLOW_TTL_DAYS: String(config.workflowTtlDays),
        OUTBOX_TTL_DAYS: String(config.outboxTtlDays),
      },
      // ECS sends SIGTERM and waits this long before SIGKILL. It must exceed the drain
      // budget or a task is killed while a request is still finishing.
      stopTimeout: config.stopTimeout,
      essential: true,
    });
    container.addPortMappings({ containerPort: 8080, protocol: ecs.Protocol.TCP });

    this.service = new ecs.FargateService(this, "ApiService", {
      cluster,
      taskDefinition,
      desiredCount: config.desiredCount,
      assignPublicIp: false,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      securityGroups: [props.serviceSecurityGroup],
      // Roll back automatically instead of leaving a broken revision serving traffic.
      circuitBreaker: { rollback: true },
      minHealthyPercent: 100,
      maxHealthyPercent: 200,
      healthCheckGracePeriod: Duration.seconds(30),
      enableExecuteCommand: !config.isProduction,
    });

    const scaling = this.service.autoScaleTaskCount({
      minCapacity: config.minCapacity,
      maxCapacity: config.maxCapacity,
    });
    scaling.scaleOnCpuUtilization("CpuScaling", {
      targetUtilizationPercent: 60,
      scaleInCooldown: Duration.seconds(120),
      scaleOutCooldown: Duration.seconds(30),
    });
    // Requests are held open while work completes, so concurrency per task matters more
    // than CPU: a task can be busy holding connections while barely using CPU.
    scaling.scaleOnMemoryUtilization("MemoryScaling", {
      targetUtilizationPercent: 70,
    });

    this.loadBalancer = new elbv2.ApplicationLoadBalancer(this, "Alb", {
      vpc,
      internetFacing: true,
      securityGroup: props.albSecurityGroup,
      // Longer than the server's request budget, shorter than the client's timeout.
      idleTimeout: config.albIdleTimeout,
      dropInvalidHeaderFields: true,
    });

    this.targetGroup = new elbv2.ApplicationTargetGroup(this, "ApiTargets", {
      vpc,
      port: 8080,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targetType: elbv2.TargetType.IP,
      targets: [this.service],
      // Long enough for an in-flight synchronous request to finish after the task is
      // marked unhealthy and stops receiving new work.
      deregistrationDelay: config.deregistrationDelay,
      healthCheck: {
        path: "/health/ready",
        interval: Duration.seconds(10),
        timeout: Duration.seconds(5),
        healthyThresholdCount: 2,
        // Two failed checks take a draining task out of rotation within ~20s, comfortably
        // inside the readiness delay the app waits before it stops accepting work.
        unhealthyThresholdCount: 2,
        healthyHttpCodes: "200",
      },
    });

    if (props.certificateArn === undefined) {
      if (config.isProduction) {
        throw new Error("production requires certificateArn for an HTTPS listener");
      }
      // Dev only: no certificate is available in a throwaway environment.
      this.loadBalancer.addListener("HttpListener", {
        port: 80,
        protocol: elbv2.ApplicationProtocol.HTTP,
        defaultTargetGroups: [this.targetGroup],
      });
    } else {
      this.loadBalancer.addListener("HttpsListener", {
        port: 443,
        protocol: elbv2.ApplicationProtocol.HTTPS,
        certificates: [{ certificateArn: props.certificateArn }],
        sslPolicy: elbv2.SslPolicy.TLS13_RES,
        defaultTargetGroups: [this.targetGroup],
      });
      // Bearer credentials must never travel over plaintext (ADR-0002).
      this.loadBalancer.addListener("HttpRedirect", {
        port: 80,
        protocol: elbv2.ApplicationProtocol.HTTP,
        defaultAction: elbv2.ListenerAction.redirect({
          protocol: "HTTPS",
          port: "443",
          permanent: true,
        }),
      });
    }

    this.webAcl = new ApiWebAcl(this, "Waf", {
      envName: config.envName,
      blockOnManagedRules: config.wafBlockOnManagedRules,
      rateLimitPerIp: config.wafRateLimitPerIp,
    });
    this.webAcl.associate("AlbAssociation", this.loadBalancer.loadBalancerArn);

    new CfnOutput(this, "AlbDnsName", { value: this.loadBalancer.loadBalancerDnsName });
    new CfnOutput(this, "EcrRepositoryUri", { value: this.repository.repositoryUri });
    new CfnOutput(this, "ApiKeySecretName", { value: this.apiKeySecret.secretName });
  }
}
