import { CfnOutput, RemovalPolicy, Stack, type StackProps } from "aws-cdk-lib";
import * as ecr from "aws-cdk-lib/aws-ecr";
import type { Construct } from "constructs";
import type { EnvironmentConfig } from "../environment.js";

export interface EcrStackProps extends StackProps {
  readonly config: EnvironmentConfig;
}

/**
 * The image repository, alone in its own stack.
 *
 * It used to live in `ApiStack`, which is also the stack that starts the service that
 * pulls from it. On a first deploy there was therefore nowhere to push an image to before
 * the service tried to run one, and each rolled-back attempt generated a fresh repository
 * name, so an image pushed to the previous one was lost. Deploying the repository on its
 * own makes the order obvious and repeatable: create it, push an image, then deploy
 * everything else (G-004, D-037).
 */
export class EcrStack extends Stack {
  readonly repository: ecr.Repository;

  constructor(scope: Construct, id: string, props: EcrStackProps) {
    super(scope, id, props);
    const { config } = props;

    this.repository = new ecr.Repository(this, "ApiRepository", {
      imageScanOnPush: true,
      removalPolicy: config.removalPolicy,
      lifecycleRules: [{ maxImageCount: 20 }],
      // An environment that is meant to be deletable must actually delete. A repository
      // still holding images refuses to go, which turns "throw the dev environment away"
      // into a manual hunt through the console — the exact thing a first-time user is
      // least equipped to do. Never for an environment whose policy is RETAIN.
      ...(config.removalPolicy === RemovalPolicy.DESTROY
        ? { emptyOnDelete: true }
        : {}),
      // Belt and braces for the tag check in `ApiStack`: even a correct-looking tag must
      // not be re-pushed to point at different bytes once production is running it.
      imageTagMutability: config.isProduction
        ? ecr.TagMutability.IMMUTABLE
        : ecr.TagMutability.MUTABLE,
    });

    // Both are readable before the API stack exists, which is the point of the split.
    new CfnOutput(this, "RepositoryUri", { value: this.repository.repositoryUri });
    new CfnOutput(this, "RepositoryName", { value: this.repository.repositoryName });
  }
}
