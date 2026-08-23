import { Stack, Token, type StackProps } from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import type { Construct } from "constructs";
import type { EnvironmentConfig } from "../environment.js";

export interface NetworkStackProps extends StackProps {
  readonly config: EnvironmentConfig;
  /**
   * Explicit availability zones. Supplying them keeps `cdk synth` completely offline: a
   * concrete region otherwise makes CDK call EC2 to discover AZs, which needs
   * credentials.
   */
  readonly availabilityZones?: string[];
}

/**
 * VPC with no NAT gateways.
 *
 * The API talks only to DynamoDB, Secrets Manager, CloudWatch Logs and ECR, all of which
 * are reachable through VPC endpoints. Removing NAT removes a recurring cost, a
 * throughput bottleneck and an egress path that nothing legitimately needs.
 *
 * Lambda workers are deliberately NOT attached to this VPC: they need DynamoDB, SQS and
 * the external provider, none of which require VPC placement, and attaching them would
 * force NAT back into the design purely to reach the provider.
 */
export class NetworkStack extends Stack {
  readonly vpc: ec2.Vpc;
  readonly albSecurityGroup: ec2.SecurityGroup;
  readonly serviceSecurityGroup: ec2.SecurityGroup;

  constructor(scope: Construct, id: string, props: NetworkStackProps) {
    super(scope, id, props);

    const explicitAzs = props.availabilityZones;

    // An environment-agnostic stack cannot know how many AZs a region has, so CDK
    // silently falls back to two — which would quietly halve production's redundancy.
    // Production must therefore name its zones explicitly or be synthesised against a
    // concrete account and region.
    if (
      props.config.isProduction &&
      explicitAzs === undefined &&
      Token.isUnresolved(this.region)
    ) {
      throw new Error(
        "production must name its availability zones (context: availabilityZones) or be " +
          "synthesised with a concrete account and region; an environment-agnostic stack " +
          "silently degrades to 2 availability zones",
      );
    }
    if (explicitAzs !== undefined && explicitAzs.length < props.config.maxAzs) {
      throw new Error(
        `${props.config.envName} requires ${String(props.config.maxAzs)} availability zones, ` +
          `but only ${String(explicitAzs.length)} were supplied`,
      );
    }

    this.vpc = new ec2.Vpc(this, "Vpc", {
      ...(explicitAzs === undefined
        ? { maxAzs: props.config.maxAzs }
        : { availabilityZones: explicitAzs.slice(0, props.config.maxAzs) }),
      natGateways: 0,
      subnetConfiguration: [
        { name: "public", subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 },
        {
          name: "private",
          subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
          cidrMask: 24,
        },
      ],
    });

    // Gateway endpoints are free and keep DynamoDB traffic off any public path.
    this.vpc.addGatewayEndpoint("DynamoDbEndpoint", {
      service: ec2.GatewayVpcEndpointAwsService.DYNAMODB,
    });
    // Required for ECR image layers, which are served from S3. This is a network route,
    // not an application dependency on S3 (ADR-0006 still holds).
    this.vpc.addGatewayEndpoint("S3Endpoint", {
      service: ec2.GatewayVpcEndpointAwsService.S3,
    });

    this.albSecurityGroup = new ec2.SecurityGroup(this, "AlbSecurityGroup", {
      vpc: this.vpc,
      description: "Ingress for the public load balancer",
      allowAllOutbound: false,
    });
    this.albSecurityGroup.addIngressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(443),
      "HTTPS from clients",
    );

    this.serviceSecurityGroup = new ec2.SecurityGroup(this, "ServiceSecurityGroup", {
      vpc: this.vpc,
      description: "API tasks",
      allowAllOutbound: false,
    });

    // Only the load balancer may reach the tasks, and only on the app port.
    this.serviceSecurityGroup.addIngressRule(
      this.albSecurityGroup,
      ec2.Port.tcp(8080),
      "ALB to API",
    );
    this.albSecurityGroup.addEgressRule(
      this.serviceSecurityGroup,
      ec2.Port.tcp(8080),
      "ALB to API",
    );
    // Egress to AWS service endpoints inside the VPC only.
    this.serviceSecurityGroup.addEgressRule(
      ec2.Peer.ipv4(this.vpc.vpcCidrBlock),
      ec2.Port.tcp(443),
      "AWS service endpoints",
    );

    const endpointSecurityGroup = new ec2.SecurityGroup(this, "EndpointSecurityGroup", {
      vpc: this.vpc,
      description: "Interface VPC endpoints",
      allowAllOutbound: false,
    });
    endpointSecurityGroup.addIngressRule(
      this.serviceSecurityGroup,
      ec2.Port.tcp(443),
      "Tasks to endpoints",
    );

    for (const [id_, service] of [
      ["EcrApiEndpoint", ec2.InterfaceVpcEndpointAwsService.ECR],
      ["EcrDockerEndpoint", ec2.InterfaceVpcEndpointAwsService.ECR_DOCKER],
      ["SecretsManagerEndpoint", ec2.InterfaceVpcEndpointAwsService.SECRETS_MANAGER],
      ["LogsEndpoint", ec2.InterfaceVpcEndpointAwsService.CLOUDWATCH_LOGS],
      ["MonitoringEndpoint", ec2.InterfaceVpcEndpointAwsService.CLOUDWATCH_MONITORING],
    ] as const) {
      this.vpc.addInterfaceEndpoint(id_, {
        service,
        securityGroups: [endpointSecurityGroup],
        subnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
        privateDnsEnabled: true,
      });
    }
  }
}
