import { CfnOutput } from "aws-cdk-lib";
import * as wafv2 from "aws-cdk-lib/aws-wafv2";
import { Construct } from "constructs";

export interface ApiWebAclProps {
  readonly envName: string;
  /**
   * Managed rules in blocking mode. Kept in count mode in dev so a false positive is
   * observed rather than suffered: managed rule sets can reject legitimate JSON bodies,
   * and a B2B API rejecting a real caller is worse than the traffic it would have
   * blocked. Move an environment to blocking only after watching its counts.
   */
  readonly blockOnManagedRules: boolean;
  /** Requests per 5-minute window per source IP before that IP is blocked. */
  readonly rateLimitPerIp: number;
}

/**
 * WAF in front of the public API.
 *
 * The rate-based rule is the part that matters most here: the API holds connections open
 * for the synchronous wait, so a flood of requests consumes task capacity for far longer
 * than a normal endpoint would, and per-IP rate limiting is the cheapest defence that
 * does not touch the request path.
 */
export class ApiWebAcl extends Construct {
  readonly webAcl: wafv2.CfnWebACL;

  constructor(scope: Construct, id: string, props: ApiWebAclProps) {
    super(scope, id);

    this.webAcl = new wafv2.CfnWebACL(this, "WebAcl", {
      scope: "REGIONAL",
      defaultAction: { allow: {} },
      visibilityConfig: {
        cloudWatchMetricsEnabled: true,
        metricName: `workflow-api-${props.envName}`,
        sampledRequestsEnabled: true,
      },
      rules: [
        {
          name: "RateLimitPerIp",
          priority: 0,
          statement: {
            rateBasedStatement: {
              limit: props.rateLimitPerIp,
              aggregateKeyType: "IP",
            },
          },
          // Always blocking: unlike content inspection, a rate limit cannot mistake a
          // valid payload for an attack.
          action: { block: {} },
          visibilityConfig: {
            cloudWatchMetricsEnabled: true,
            metricName: "RateLimitPerIp",
            sampledRequestsEnabled: true,
          },
        },
        {
          name: "AWSManagedRulesAmazonIpReputationList",
          priority: 1,
          statement: {
            managedRuleGroupStatement: {
              vendorName: "AWS",
              name: "AWSManagedRulesAmazonIpReputationList",
            },
          },
          overrideAction: props.blockOnManagedRules ? { none: {} } : { count: {} },
          visibilityConfig: {
            cloudWatchMetricsEnabled: true,
            metricName: "IpReputation",
            sampledRequestsEnabled: true,
          },
        },
        {
          name: "AWSManagedRulesKnownBadInputsRuleSet",
          priority: 2,
          statement: {
            managedRuleGroupStatement: {
              vendorName: "AWS",
              name: "AWSManagedRulesKnownBadInputsRuleSet",
            },
          },
          overrideAction: props.blockOnManagedRules ? { none: {} } : { count: {} },
          visibilityConfig: {
            cloudWatchMetricsEnabled: true,
            metricName: "KnownBadInputs",
            sampledRequestsEnabled: true,
          },
        },
        {
          name: "AWSManagedRulesCommonRuleSet",
          priority: 3,
          statement: {
            managedRuleGroupStatement: {
              vendorName: "AWS",
              name: "AWSManagedRulesCommonRuleSet",
              // Body-size inspection would reject payloads the API accepts by contract;
              // size limits are enforced by the service itself (ADR-0006).
              ruleActionOverrides: [
                {
                  name: "SizeRestrictions_BODY",
                  actionToUse: { count: {} },
                },
              ],
            },
          },
          overrideAction: props.blockOnManagedRules ? { none: {} } : { count: {} },
          visibilityConfig: {
            cloudWatchMetricsEnabled: true,
            metricName: "CommonRuleSet",
            sampledRequestsEnabled: true,
          },
        },
      ],
    });

    new CfnOutput(this, "WebAclArn", { value: this.webAcl.attrArn });
  }

  /** Associates the ACL with a regional resource, i.e. the application load balancer. */
  associate(id: string, resourceArn: string): void {
    new wafv2.CfnWebACLAssociation(this, id, {
      resourceArn,
      webAclArn: this.webAcl.attrArn,
    });
  }
}
