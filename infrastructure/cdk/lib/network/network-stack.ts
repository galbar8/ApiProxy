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
 * VPC with no NAT gateways, in either profile.
 *
 * The API talks only to DynamoDB, Secrets Manager, CloudWatch Logs and ECR. How it
 * reaches them is what the profile decides (D-013, D-036):
 *
 *  - `privateNetworking: true` — tasks sit in isolated subnets and reach those services
 *    through interface endpoints. No public address, no route off the VPC. This is the
 *    real posture and the only one staging and production can have.
 *  - `privateNetworking: false` — the five interface endpoints are not created and tasks
 *    sit in public subnets with a public IP, reaching the same services over the internet
 *    gateway. Five endpoints across two zones are the largest standing charge in an idle
 *    environment, so a dev box that exists to be looked at does without them. Ingress is
 *    unchanged: only the load balancer's security group may reach a task.
 *
 * Either way there is no NAT gateway, and the gateway endpoints below are free.
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
    // Port 80 is a listener in both profiles and was previously unreachable: dev serves
    // plain HTTP here (no certificate), and every other environment answers with a
    // redirect to 443. Without this rule a dev environment deploys successfully and then
    // cannot be called at all (G-003).
    this.albSecurityGroup.addIngressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(80),
      "HTTP from clients; dev serves here, other environments redirect to 443",
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
    // Egress must cover BOTH kinds of endpoint, which behave differently:
    //
    //  - Interface endpoints (ECR API, ECR Docker, Secrets Manager, Logs) are ENIs inside
    //    the VPC, so VPC-CIDR egress reaches them.
    //  - Gateway endpoints (DynamoDB, S3) do NOT rewrite the destination address. Traffic
    //    keeps the service's public IP and is matched by an AWS-managed prefix list, which
    //    is outside the VPC CIDR. A VPC-CIDR-only rule silently drops every DynamoDB call
    //    and every ECR image *layer* fetch (layers are served from S3), so tasks never
    //    reach a running state.
    //
    // The prefix list IDs are region-specific and only discoverable through a context
    // lookup, which is forbidden here (`cdk synth` must work without credentials), so the
    // rule has to be written as a wide CIDR. What that CIDR actually reaches depends on
    // the profile, and both cases are deliberate:
    //
    //  - privateNetworking: true — the subnets are PRIVATE_ISOLATED with no internet
    //    gateway and no NAT, so 0.0.0.0/0 has no route out of the VPC. The only
    //    destinations reachable are the endpoints themselves. The route table, not the
    //    security group, is what confines this traffic.
    //  - privateNetworking: false — there is no interface endpoint to reach, so this rule
    //    genuinely egresses to the internet on 443, which is how the task pulls its image
    //    and reads its secret. That is a real widening of egress and the reason the
    //    profile is refused outside dev (D-036).
    this.serviceSecurityGroup.addEgressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(443),
      props.config.privateNetworking
        ? "AWS service endpoints (gateway endpoints are outside the VPC CIDR; isolated " +
            "subnets have no route to anything else)"
        : "AWS service endpoints over the internet gateway (minimal profile: no " +
            "interface endpoints)",
    );

    // The Amazon-provided resolver lives at VPC CIDR base + 2. Without this the private
    // DNS names of the interface endpoints cannot be resolved at all, so nothing above
    // matters.
    for (const port of [ec2.Port.udp(53), ec2.Port.tcp(53)]) {
      this.serviceSecurityGroup.addEgressRule(
        ec2.Peer.ipv4(this.vpc.vpcCidrBlock),
        port,
        "VPC DNS resolver",
      );
    }

    // Interface endpoints are the standing cost of an idle environment, so `minimal`
    // does without them and routes the same calls over the internet gateway instead.
    // Gateway endpoints above are free and stay in both profiles.
    if (!props.config.privateNetworking) {
      return;
    }

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
