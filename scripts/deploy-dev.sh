#!/usr/bin/env bash
#
# First deploy of the workflow service into a dev environment.
#
# Everything this script does, you can do by hand — DEPLOYMENT.md shows the same commands.
# It exists so a first deploy is one command instead of nine, and so the things that are
# easy to get wrong (region, image architecture, deploy order) are not left to chance.
#
# It never deploys without asking. Read what it prints.
set -euo pipefail

PROFILE="${PROFILE:-minimal}"
ENV_NAME="dev"

die() { printf '\n\033[31mError:\033[0m %s\n\n' "$1" >&2; exit 1; }
step() { printf '\n\033[1m==> %s\033[0m\n' "$1"; }

# ---------------------------------------------------------------- preflight

step "Checking the tools this needs"
for tool in node pnpm docker aws git; do
  command -v "$tool" >/dev/null 2>&1 || die "\`$tool\` is not installed. See DEPLOYMENT.md section 5."
done
docker buildx version >/dev/null 2>&1 || die "Docker is installed but \`docker buildx\` is not available. Update Docker Desktop."
docker info >/dev/null 2>&1 || die "Docker is installed but not running. Start Docker Desktop and try again."
echo "  node, pnpm, docker (with buildx), aws, git — all present"

step "Checking your AWS credentials"
ACCOUNT="$(aws sts get-caller-identity --query Account --output text 2>/dev/null)" \
  || die "The AWS CLI cannot reach your account. Run \`aws configure\` first (DEPLOYMENT.md section 4)."
IDENTITY="$(aws sts get-caller-identity --query Arn --output text)"
REGION="${AWS_REGION:-$(aws configure get region || true)}"
[ -n "$REGION" ] || die "No AWS region is set. Run \`aws configure\` and give it one, e.g. eu-west-1."

case "$PROFILE" in
  minimal|standard) ;;
  *) die "PROFILE must be 'minimal' or 'standard'; got '$PROFILE'." ;;
esac

IMAGE_TAG="$(git rev-parse HEAD)"

# ---------------------------------------------------------------- consent

cat <<INFO

  ------------------------------------------------------------------
  About to create real, billable AWS resources.
  ------------------------------------------------------------------

  AWS account   $ACCOUNT
  Identity      $IDENTITY
  Region        $REGION
  Environment   $ENV_NAME
  Profile       $PROFILE
  Image tag     ${IMAGE_TAG:0:12}

  This creates 7 CloudFormation stacks: a network, an image repository,
  a DynamoDB table, two queues with dead-letter queues, four Lambda
  functions, a load balancer with one Fargate task, and alarms.

INFO

if [ "$PROFILE" = "minimal" ]; then
  cat <<'INFO'
  Rough cost while idle: about USD 35 per month, mostly the load
  balancer and the one Fargate task. No WAF, no interface VPC
  endpoints, no container insights.

  The minimal profile is for looking at the service, not for running
  it. It cannot be selected for staging or production.
INFO
else
  cat <<'INFO'
  Rough cost while idle: about USD 125 per month. The five interface
  VPC endpoints are the largest part of that; a web ACL and container
  insights account for most of the rest.
INFO
fi

cat <<'INFO'

  These are estimates, not quotes. Check AWS pricing for your region.
  `scripts/destroy-dev.sh` removes everything this creates.

INFO

printf 'Type "deploy" to continue, anything else to stop: '
read -r CONFIRM
[ "$CONFIRM" = "deploy" ] || die "Nothing was deployed."

CTX=(-c "env=$ENV_NAME" -c "profile=$PROFILE" -c "imageTag=$IMAGE_TAG")

# ---------------------------------------------------------------- deploy

step "Preparing the region for CDK (bootstrap; harmless if already done)"
pnpm exec cdk bootstrap "aws://$ACCOUNT/$REGION"

step "1/4 — Creating the image repository"
# It gets its own stack so an image exists before the service that pulls it.
pnpm exec cdk deploy "${CTX[@]}" "Workflow-$ENV_NAME-Ecr"

REPO="$(aws cloudformation describe-stacks --region "$REGION" \
  --stack-name "Workflow-$ENV_NAME-Ecr" \
  --query "Stacks[0].Outputs[?OutputKey=='RepositoryUri'].OutputValue" --output text)"
[ -n "$REPO" ] && [ "$REPO" != "None" ] || die "Could not read the repository URI from the Ecr stack."

step "2/4 — Building and pushing the API image (arm64)"
# The task definition asks for arm64. An x86 image is accepted by ECR and then fails to
# start with an unhelpful manifest error, so the platform is pinned here.
aws ecr get-login-password --region "$REGION" \
  | docker login --username AWS --password-stdin "${REPO%%/*}"
docker buildx build --platform linux/arm64 -t "$REPO:$IMAGE_TAG" --push .

step "3/4 — Creating the data, queues and workers"
pnpm exec cdk deploy "${CTX[@]}" \
  "Workflow-$ENV_NAME-Network" \
  "Workflow-$ENV_NAME-Data" \
  "Workflow-$ENV_NAME-Messaging" \
  "Workflow-$ENV_NAME-Workers"

step "4/4 — Creating the API and its alarms"
pnpm exec cdk deploy "${CTX[@]}" "Workflow-$ENV_NAME-Api" "Workflow-$ENV_NAME-Monitoring"

# ---------------------------------------------------------------- next steps

BASE_URL="$(aws cloudformation describe-stacks --region "$REGION" \
  --stack-name "Workflow-$ENV_NAME-Api" \
  --query "Stacks[0].Outputs[?OutputKey=='PublicBaseUrl'].OutputValue" --output text)"
SECRET="$(aws cloudformation describe-stacks --region "$REGION" \
  --stack-name "Workflow-$ENV_NAME-Api" \
  --query "Stacks[0].Outputs[?OutputKey=='ApiKeySecretName'].OutputValue" --output text)"

cat <<INFO

  ------------------------------------------------------------------
  Deployed.
  ------------------------------------------------------------------

  Your API      $BASE_URL
  Key store     $SECRET

  It will reject every request with 401 until you put a key in that
  secret. DEPLOYMENT.md section 9 is a copy-paste block that does it.

  When you are finished:  ./scripts/destroy-dev.sh

INFO
