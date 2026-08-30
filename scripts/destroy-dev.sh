#!/usr/bin/env bash
#
# Removes everything scripts/deploy-dev.sh created, so a dev environment cannot quietly
# keep billing after you have stopped looking at it.
#
# Only ever run this against dev. Staging and production tables are RETAIN by design and
# will survive their stacks; that is deliberate and is not what this script is for.
set -euo pipefail

ENV_NAME="dev"
PROFILE="${PROFILE:-minimal}"

die() { printf '\n\033[31mError:\033[0m %s\n\n' "$1" >&2; exit 1; }

command -v aws >/dev/null 2>&1 || die "The AWS CLI is not installed."
ACCOUNT="$(aws sts get-caller-identity --query Account --output text 2>/dev/null)" \
  || die "The AWS CLI cannot reach your account. Run \`aws configure\` first."
REGION="${AWS_REGION:-$(aws configure get region || true)}"
[ -n "$REGION" ] || die "No AWS region is set."

cat <<INFO

  ------------------------------------------------------------------
  About to DELETE the dev environment and everything in it.
  ------------------------------------------------------------------

  AWS account   $ACCOUNT
  Region        $REGION
  Environment   $ENV_NAME

  This destroys the DynamoDB table and every workflow in it. The dev
  table has no point-in-time recovery, so there is no undo.

INFO

printf 'Type "destroy dev" to continue, anything else to stop: '
read -r CONFIRM
[ "$CONFIRM" = "destroy dev" ] || die "Nothing was deleted."

# Reverse of the creation order: consumers before the things they reference.
pnpm exec cdk destroy -c "env=$ENV_NAME" -c "profile=$PROFILE" \
  "Workflow-$ENV_NAME-Monitoring" \
  "Workflow-$ENV_NAME-Api" \
  "Workflow-$ENV_NAME-Workers" \
  "Workflow-$ENV_NAME-Messaging" \
  "Workflow-$ENV_NAME-Data" \
  "Workflow-$ENV_NAME-Ecr" \
  "Workflow-$ENV_NAME-Network"

cat <<'INFO'

  Deleted. The dev table, its log groups and the image repository all
  had a DESTROY policy, so they went with their stacks.

  One thing is left behind on purpose: the CDK bootstrap stack
  (CDKToolkit). It is shared by every CDK project in this region and
  costs a few cents a month for the S3 bucket it holds. Leave it
  unless you are finished with CDK in this region entirely.

INFO
