import { CfnOutput, Duration, Stack, type StackProps } from "aws-cdk-lib";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ecr from "aws-cdk-lib/aws-ecr";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as elbv2 from "aws-cdk-lib/aws-elasticloadbalancingv2";
import * as iam from "aws-cdk-lib/aws-iam";
import * as logs from "aws-cdk-lib/aws-logs";
import * as route53 from "aws-cdk-lib/aws-route53";
import * as targets from "aws-cdk-lib/aws-route53-targets";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import type * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import type { Construct } from "constructs";
import { healthCheckDetectionWindow, type EnvironmentConfig } from "../environment.js";
import { ApiWebAcl } from "./waf.js";

export interface ApiStackProps extends StackProps {
  readonly config: EnvironmentConfig;
  readonly vpc: ec2.Vpc;
  readonly albSecurityGroup: ec2.SecurityGroup;
  readonly serviceSecurityGroup: ec2.SecurityGroup;
  readonly table: dynamodb.Table;
  /**
   * Image tag to run. Pushed to ECR before deployment; synth never needs Docker.
   * Production must name an immutable build (a digest, a commit SHA or a version) —
   * see `assertImmutableImageReference`.
   */
  readonly imageTag: string;
  /** ACM certificate for the HTTPS listener. Required outside dev. */
  readonly certificateArn?: string;
  /** Public DNS name, created as an alias record when a hosted zone is supplied. */
  readonly domain?: {
    readonly hostedZoneId: string;
    readonly zoneName: string;
    readonly recordName: string;
  };
}

/** A digest, a git commit SHA, or a version — anything that cannot be repointed. */
const IMMUTABLE_IMAGE_REFERENCE =
  /^(sha256:[0-9a-f]{64}|[0-9a-f]{7,40}|v?\d+\.\d+\.\d+[A-Za-z0-9._-]*)$/;

/**
 * A mutable tag makes a deployment unrepeatable in both directions: pushing a new image
 * produces no CloudFormation change, so `cdk deploy` starts no rollout, and the circuit
 * breaker's rollback restores a task definition pointing at the same moving tag — which
 * is not a rollback at all.
 */
export const assertImmutableImageReference = (imageTag: string): void => {
  if (!IMMUTABLE_IMAGE_REFERENCE.test(imageTag)) {
    throw new Error(
      `production requires an immutable imageTag (a sha256: digest, a git SHA or a ` +
        `version); received "${imageTag}", which can be repointed at a different build ` +
        `and would make rollback meaningless`,
    );
  }
};

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
  /** Alarms that gate a rollout; a deployment that trips one is rolled back by ECS. */
  readonly deploymentAlarms: cloudwatch.Alarm[];

  constructor(scope: Construct, id: string, props: ApiStackProps) {
    super(scope, id, props);
    const { config, vpc } = props;

    if (config.isProduction) {
      assertImmutableImageReference(props.imageTag);
    }

    this.repository = new ecr.Repository(this, "ApiRepository", {
      imageScanOnPush: true,
      removalPolicy: config.removalPolicy,
      lifecycleRules: [{ maxImageCount: 20 }],
      // Belt and braces for the check above: even a correct-looking tag must not be
      // re-pushed to point at different bytes once production is running it.
      imageTagMutability: config.isProduction
        ? ecr.TagMutability.IMMUTABLE
        : ecr.TagMutability.MUTABLE,
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
      // Liveness only, and it must live here: ECS ignores the HEALTHCHECK instruction
      // baked into the image, so the Dockerfile's copy alone leaves a wedged-but-listening
      // process undetected. Readiness stays with the load balancer, which is the only
      // thing that should take a *draining* task out of rotation.
      healthCheck: {
        command: [
          "CMD-SHELL",
          "node -e \"fetch('http://127.0.0.1:8080/health/live')" +
            '.then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"',
        ],
        interval: Duration.seconds(15),
        timeout: Duration.seconds(3),
        retries: 3,
        startPeriod: Duration.seconds(10),
      },
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

    this.loadBalancer = new elbv2.ApplicationLoadBalancer(this, "Alb", {
      vpc,
      internetFacing: true,
      securityGroup: props.albSecurityGroup,
      // Longer than the server's request budget, shorter than the client's timeout.
      idleTimeout: config.albIdleTimeout,
      dropInvalidHeaderFields: true,
      // The table is protected; the front door must be too. Deleting the load balancer is
      // a full outage and, unlike the data, nothing about it is recoverable from a backup.
      deletionProtection: config.deletionProtection,
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
        // These four values decide the detection window the application must outlast
        // during a drain: interval x (unhealthyThreshold + 1) + timeout. The app's
        // SHUTDOWN_READINESS_DELAY_MS is set above that window, and the CDK tests assert
        // the relationship in that direction — a request arriving after the app closes
        // its listener but before the ALB has stopped routing becomes an ALB 5xx.
        interval: config.healthCheckInterval,
        timeout: config.healthCheckTimeout,
        healthyThresholdCount: config.healthyThresholdCount,
        unhealthyThresholdCount: config.unhealthyThresholdCount,
        healthyHttpCodes: "200",
      },
    });

    if (
      config.shutdownReadinessDelayMs <=
      healthCheckDetectionWindow(config).toMilliseconds()
    ) {
      throw new Error(
        `SHUTDOWN_READINESS_DELAY_MS (${String(config.shutdownReadinessDelayMs)}ms) must ` +
          `exceed the ALB health-check detection window ` +
          `(${String(healthCheckDetectionWindow(config).toMilliseconds())}ms), or the ` +
          `listener closes while the load balancer is still routing to this task`,
      );
    }

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

    const scaling = this.service.autoScaleTaskCount({
      minCapacity: config.minCapacity,
      maxCapacity: config.maxCapacity,
    });
    // Requests are held open while work completes, so the resource that runs out first is
    // concurrent connections per task, not CPU and not memory: a task saturated with
    // 20-second waits looks idle on both. `ALBRequestCountPerTarget` is the only metric
    // here that actually tracks held connections, so it is the primary policy.
    scaling.scaleOnRequestCount("RequestScaling", {
      requestsPerTarget: config.requestsPerTargetPerMinute,
      targetGroup: this.targetGroup,
      // Scaling in must not strand work: a task removed from the group still has to finish
      // its longest request and serve out its deregistration delay.
      scaleInCooldown: Duration.seconds(300),
      scaleOutCooldown: Duration.seconds(30),
    });
    // CPU remains as a secondary floor for load shapes the request count cannot see
    // (an expensive payload, a slow dependency burning CPU on retries).
    scaling.scaleOnCpuUtilization("CpuScaling", {
      targetUtilizationPercent: 60,
      scaleInCooldown: Duration.seconds(300),
      scaleOutCooldown: Duration.seconds(30),
    });

    this.webAcl = new ApiWebAcl(this, "Waf", {
      envName: config.envName,
      blockOnManagedRules: config.wafBlockOnManagedRules,
      rateLimitPerIp: config.wafRateLimitPerIp,
    });
    this.webAcl.associate("AlbAssociation", this.loadBalancer.loadBalancerArn);

    // A rollout that starts failing requests must be reverted by ECS, not by a human
    // noticing. The circuit breaker only sees tasks that fail to *start*; these alarms
    // cover the worse case — tasks that start happily and then serve errors.
    //
    // The names are static on purpose. A generated name is a CloudFormation reference to
    // the alarm resource, which makes the service depend on the alarm while the alarm
    // depends (through the target group) on the service — a deployment-time circular
    // dependency that synth only warns about.
    const deploymentAlarmNames = [
      `${config.envName}-api-deployment-target-5xx`,
      `${config.envName}-api-deployment-unhealthy-targets`,
    ] as const;

    this.deploymentAlarms = [
      new cloudwatch.Alarm(this, "DeploymentTarget5xx", {
        alarmName: deploymentAlarmNames[0],
        metric: this.targetGroup.metrics.httpCodeTarget(
          elbv2.HttpCodeTarget.TARGET_5XX_COUNT,
          { period: Duration.minutes(1), statistic: "Sum" },
        ),
        threshold: 5,
        evaluationPeriods: 2,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
        alarmDescription: "A deployment is serving application errors; roll it back",
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      }),
      new cloudwatch.Alarm(this, "DeploymentUnhealthyTargets", {
        alarmName: deploymentAlarmNames[1],
        metric: this.targetGroup.metrics.unhealthyHostCount({
          period: Duration.minutes(1),
          statistic: "Maximum",
        }),
        threshold: 0,
        evaluationPeriods: 2,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
        alarmDescription: "A deployment left targets failing readiness; roll it back",
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      }),
    ];
    // The literal names, not `alarm.alarmName` — the latter resolves to a CloudFormation
    // Ref, which is exactly the reference this indirection exists to avoid.
    this.service.enableDeploymentAlarms([...deploymentAlarmNames], {
      behavior: ecs.AlarmBehavior.ROLLBACK_ON_ALARM,
    });

    // Callers reach a stable name, not the raw ALB DNS, so the load balancer can be
    // replaced without every B2B client reconfiguring. Built from supplied attributes
    // rather than a lookup, because `cdk synth` must work without credentials.
    if (props.domain !== undefined) {
      const zone = route53.HostedZone.fromHostedZoneAttributes(this, "Zone", {
        hostedZoneId: props.domain.hostedZoneId,
        zoneName: props.domain.zoneName,
      });
      new route53.ARecord(this, "ApiAliasRecord", {
        zone,
        recordName: props.domain.recordName,
        target: route53.RecordTarget.fromAlias(
          new targets.LoadBalancerTarget(this.loadBalancer),
        ),
      });
      new CfnOutput(this, "ApiDomainName", { value: props.domain.recordName });
    }

    new CfnOutput(this, "AlbDnsName", { value: this.loadBalancer.loadBalancerDnsName });
    new CfnOutput(this, "EcrRepositoryUri", { value: this.repository.repositoryUri });
    new CfnOutput(this, "ApiKeySecretName", { value: this.apiKeySecret.secretName });
  }
}
