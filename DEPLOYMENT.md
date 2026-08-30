# Deploying to AWS

A step-by-step guide to putting this service into a real AWS account. No prior knowledge of
this codebase is assumed. Read it once end to end before running anything — a few things
have to be decided (and a few fixed) before the first deploy.

> **Status:** this project has never been deployed. The CDK app synthesises cleanly and its
> assertions are unit-tested, but nothing here has been applied to an AWS account. Treat the
> first deploy as a dev-environment exercise, not a production launch.

---

## 1. What gets created

Six CloudFormation stacks, deployed in this order:

| Stack (`Workflow-<env>-…`) | What it creates                                                                   |
| -------------------------- | --------------------------------------------------------------------------------- |
| `Network`                  | VPC (no NAT gateways), public + isolated subnets, VPC endpoints, security groups  |
| `Data`                     | The DynamoDB workflow table (streams, TTL, 2 GSIs, PITR/deletion protection)      |
| `Messaging`                | 2 SQS queues + 2 dead-letter queues with redrive policies                         |
| `Workers`                  | 4 Lambda functions (worker-a, finalizer, outbox-publisher, reconciler) + schedule |
| `Api`                      | ECR repo, ECS Fargate service, ALB, WAF, autoscaling, API-key secret              |
| `Monitoring`               | SNS alarm topic + ~17 CloudWatch alarms                                           |

```text
client ─► WAF ─► ALB ─► ECS/Fargate API ─► DynamoDB ─(stream)─► outbox publisher ─► SQS
                          ▲                                                          │
                          └───────── bounded polling ── DynamoDB ◄─ workers ◄────────┘
```

The API writes the workflow to DynamoDB and then polls it for a terminal state on the same
HTTP request. Everything asynchronous happens behind the stream and the queues.

---

## 2. Before you start

### Tools on your machine

| Tool       | Version                     | Why                                          |
| ---------- | --------------------------- | -------------------------------------------- |
| Node.js    | 22 or newer                 | Build + CDK                                  |
| pnpm       | 11.22.0 (`corepack enable`) | Workspace package manager                    |
| Docker     | with `buildx`               | Builds the **arm64** API image               |
| AWS CLI v2 | configured credentials      | Push the image, read outputs, set the secret |

```bash
pnpm install
pnpm lint && pnpm typecheck && pnpm test    # all must pass before you deploy anything
```

### Things you must have in AWS first

1. **An AWS account and credentials** with permission to create VPC, ECS, ELB, ECR,
   DynamoDB, SQS, Lambda, WAF, Secrets Manager, SNS and CloudWatch resources.
2. **A region.** Everything lives in one region. Pick it now — it appears in every command
   below as `$REGION`.
3. **An ACM certificate in that same region**, for the domain your B2B clients will call.
   Required for `staging` and `production` (the stack refuses to synthesise without it).
   A regional ALB can only use a certificate issued in its own region.
4. **A real external provider URL** (`https://…`). The finalizer calls it. `apps/fake-provider`
   is a local test double and is **not** deployed.
5. **At least one email address for alarms.** Production refuses to synthesise without one.
6. _(Optional)_ **A Route 53 hosted zone**, if you want a stable DNS name in front of the ALB
   instead of the raw ALB hostname.

### Bootstrap CDK once per account+region

```bash
export REGION=eu-west-1                       # your region
export ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
pnpm exec cdk bootstrap aws://$ACCOUNT/$REGION
```

---

## 3. Fix these four things first

These are real gaps found while writing this guide. The first two will break a deployed
environment; the last two will waste your time on the first deploy. All four are small.

### 3.1 The API container never receives `AWS_REGION` — **required unless you deploy to `us-east-1`**

ECS does not inject `AWS_REGION` into a container (Lambda does, so the workers are fine).
The app falls back to `us-east-1` (`packages/config/src/config.ts`), so its DynamoDB and
Secrets Manager clients would talk to the wrong region and every request would fail.

Add one line to the container `environment` block in
`infrastructure/cdk/lib/api/api-stack.ts`:

```ts
environment: {
  APP_ENV: config.envName,
  AWS_REGION: Stack.of(this).region,        // ← add
  ...
}
```

### 3.2 The API container never receives `PUBLIC_BASE_URL` — **required**

When the synchronous wait expires, the `202` response hands the caller a `pollUrl` built
from `PUBLIC_BASE_URL`, which defaults to `http://localhost:8080`. Deployed as-is, every
timed-out B2B caller is told to poll their own machine.

Set it to your public URL in the same `environment` block:

```ts
PUBLIC_BASE_URL: "https://api.example.com",  // the name clients actually call
```

### 3.3 The ALB security group only allows port 443 — **required for dev**

`infrastructure/cdk/lib/network/network-stack.ts` opens **443 only**. In `dev` (no
certificate) the stack creates an HTTP listener on **port 80**, which nothing can reach —
a dev environment deploys successfully and is then unreachable. In production the
HTTP→HTTPS redirect listener on port 80 is unreachable for the same reason.

Add the matching ingress rule:

```ts
this.albSecurityGroup.addIngressRule(
  ec2.Peer.anyIpv4(),
  ec2.Port.tcp(80),
  "HTTP (redirect to HTTPS)",
);
```

### 3.4 The ECR repository lives inside the `Api` stack — **recommended**

The stack that creates the image repository is also the stack that starts the ECS service,
so on the _very first_ deploy there is nowhere to push the image to beforehand. Section 5
gives a workable procedure, but the clean fix is to move the `ecr.Repository` out of
`ApiStack` into its own small stack (or into `DataStack`) so the order becomes: deploy repo
→ push image → deploy everything else. Do this if you expect to create environments more
than once.

---

## 4. Configuration

### 4.1 Environments

Pick one with `-c env=<name>`. The differences are defined in
`infrastructure/cdk/lib/environment.ts`:

| Setting             | `dev`          | `staging`      | `production`    |
| ------------------- | -------------- | -------------- | --------------- |
| AZs                 | 2              | 2              | **3**           |
| Fargate tasks       | 1 (max 2)      | 2 (max 4)      | 3 (max 20)      |
| CPU / memory        | 512 / 1024 MiB | 512 / 1024 MiB | 1024 / 2048 MiB |
| DynamoDB PITR       | off            | on             | on              |
| Deletion protection | off            | on             | on              |
| Removal policy      | DESTROY        | RETAIN         | RETAIN          |
| Log retention       | 7 days         | 30 days        | 90 days         |
| WAF managed rules   | count only     | **block**      | **block**       |
| HTTPS               | optional       | required       | required        |

### 4.2 Context values you pass on the command line

| `-c` value                               | Required for        | Notes                                                                       |
| ---------------------------------------- | ------------------- | --------------------------------------------------------------------------- |
| `env`                                    | always              | `dev` \| `staging` \| `production` (default `dev`)                          |
| `imageTag`                               | production          | Must be immutable: a **git commit SHA** or `v1.2.3`. See the warning below. |
| `certificateArn`                         | staging, production | ACM cert ARN in the same region                                             |
| `providerBaseUrl`                        | production          | Real `https://` provider; `.invalid`/`.example` are rejected                |
| `alarmEmails`                            | production          | Comma-separated; each gets an SNS confirmation email                        |
| `availabilityZones`                      | production          | Comma-separated, at least 3 for production                                  |
| `hostedZoneId`, `zoneName`, `recordName` | optional            | All three together, or none — creates an ALB alias record                   |

> **Image tag warning.** Production sets ECR tag mutability to `IMMUTABLE` and validates the
> tag. Use a **git SHA** (`-c imageTag=$(git rev-parse HEAD)`). A `sha256:…` digest passes
> validation but is then used as a _tag_ (`repo:sha256:…`), which is not a valid image
> reference — do not use a digest here.

Full production synth (this is the command that proves your context is complete):

```bash
pnpm cdk:synth -c env=production \
  -c imageTag=$(git rev-parse HEAD) \
  -c certificateArn=arn:aws:acm:$REGION:$ACCOUNT:certificate/xxxxxxxx \
  -c providerBaseUrl=https://provider.example.com \
  -c alarmEmails=oncall@yourcompany.com \
  -c availabilityZones=${REGION}a,${REGION}b,${REGION}c
```

If any required value is missing, synth **fails with a message telling you which one**.
That is deliberate — a forgotten flag can never reach a deployment.

### 4.3 The timeout ladder (the one thing to understand)

Application timeouts are not free-floating; they are rendered into the ECS task from the
same object that configures the ALB, and startup fails if the order breaks:

```text
SYNC_WAIT_TIMEOUT_MS (20s)  <  HTTP_REQUEST_TIMEOUT_MS (22s)
                            <  ALB idle timeout (30s)
                            <  HTTP_KEEP_ALIVE_TIMEOUT_MS (35s)
```

**Tell your B2B clients to use a 35-second timeout** (`CLIENT_RECOMMENDED_TIMEOUT_MS`). The
service returns a controlled `202` at 20 seconds; a client that gives up before that turns a
recoverable workflow into a support ticket. Change these only in
`infrastructure/cdk/lib/environment.ts` — never in the app and never in the console.

---

## 5. Deploying

`$ENV` is `dev`, `staging` or `production`. Keep every `-c` flag identical across all
commands in a single deploy — they are inputs to the synth, not just to one stack.

Store them once:

```bash
export ENV=production
export CTX="-c env=$ENV \
  -c imageTag=$(git rev-parse HEAD) \
  -c certificateArn=arn:aws:acm:$REGION:$ACCOUNT:certificate/xxxxxxxx \
  -c providerBaseUrl=https://provider.example.com \
  -c alarmEmails=oncall@yourcompany.com \
  -c availabilityZones=${REGION}a,${REGION}b,${REGION}c"
```

### Step 1 — deploy everything that does not need the image

```bash
pnpm exec cdk deploy $CTX \
  Workflow-$ENV-Network Workflow-$ENV-Data Workflow-$ENV-Messaging Workflow-$ENV-Workers
```

CDK prompts for approval on IAM and security-group changes. **Read them.** Lambda code is
bundled locally with esbuild — no Docker needed for this step.

### Step 2 — deploy the API stack and push the image into it

Because of gap 3.4, the repository does not exist until this deploy starts. Run the deploy,
then push the image while CloudFormation is still working:

```bash
# terminal 1
pnpm exec cdk deploy $CTX Workflow-$ENV-Api
```

```bash
# terminal 2 — as soon as the repository appears (within a minute or so)
export REPO=$(aws ecr describe-repositories --region $REGION \
  --query "repositories[?contains(repositoryName,'apirepository')].repositoryUri | [0]" --output text)

aws ecr get-login-password --region $REGION \
  | docker login --username AWS --password-stdin $ACCOUNT.dkr.ecr.$REGION.amazonaws.com

docker buildx build --platform linux/arm64 -t $REPO:$(git rev-parse HEAD) --push .
```

The image **must be arm64** — the task definition requests it, and an x86 image is accepted
by ECR and then fails to start. The `Dockerfile` pins the runtime stage, and `buildx` handles
the cross-build from an Intel machine.

If the ECS service gives up before your push lands, the stack rolls back. Delete the failed
stack (`aws cloudformation delete-stack --stack-name Workflow-$ENV-Api`) and repeat — the
repository name is regenerated each time, so an image pushed to the old repository is lost.
Fixing gap 3.4 removes this dance permanently.

### Step 3 — deploy monitoring

```bash
pnpm exec cdk deploy $CTX Workflow-$ENV-Monitoring
```

### Step 4 — collect the outputs

```bash
aws cloudformation describe-stacks --region $REGION \
  --stack-name Workflow-$ENV-Api --query 'Stacks[0].Outputs' --output table
```

You get `AlbDnsName`, `EcrRepositoryUri` and `ApiKeySecretName`. The `Data`, `Messaging` and
`Monitoring` stacks similarly output the table name, queue URLs and the alarm topic ARN.

---

## 6. After the deploy — three things it will not work without

### 6.1 Populate the API-key secret

The stack creates an **empty** secret. Until you fill it, every request is correctly
rejected with `401`. Only SHA-256 hashes are stored — the raw key exists in exactly two
places, your client's config and the request header.

```bash
KEY=$(openssl rand -hex 32)                                   # give THIS to the tenant
HASH=$(printf '%s' "$KEY" | shasum -a 256 | cut -d' ' -f1)
SECRET=$(aws cloudformation describe-stacks --region $REGION --stack-name Workflow-$ENV-Api \
  --query "Stacks[0].Outputs[?OutputKey=='ApiKeySecretName'].OutputValue" --output text)

aws secretsmanager put-secret-value --region $REGION --secret-id "$SECRET" --secret-string "$(cat <<JSON
{"tenants":[{"tenantId":"acme","status":"active","keys":[{"kid":"acme-2026-08","hash":"$HASH"}]}]}
JSON
)"

echo "Send this key to the tenant over a secure channel, then delete it locally: $KEY"
```

Rules the document is validated against (`apps/api/src/auth/api-key-store.ts`):

- `tenantId`: 1–64 chars, `A-Z a-z 0-9 . _ -`
- `status`: `active` or `disabled` (a disabled tenant is ignored entirely)
- each key: a `kid` you choose, a 64-char lowercase hex `hash`, and an optional
  `expiresAt` (epoch ms) used while rotating a key out

**Rotation:** add the new key alongside the old one, move the tenant across, then remove the
old entry. The API caches the document for 60 seconds, so changes take up to a minute.

### 6.2 Confirm the alarm emails

Every address in `alarmEmails` gets an SNS confirmation email. **Until someone clicks it, no
alarm reaches anyone.** Check:

```bash
aws sns list-subscriptions-by-topic --region $REGION --topic-arn <AlarmTopicArn>
```

`PendingConfirmation` means your alarms are going nowhere.

### 6.3 Smoke-test the API

```bash
BASE=https://api.example.com          # or the ALB DNS name over HTTPS

curl -s $BASE/health/live
curl -s $BASE/health/ready

curl -sS -X POST $BASE/v1/process \
  -H "Authorization: ApiKey $KEY" \
  -H "Idempotency-Key: $(uuidgen)" \
  -H "Content-Type: application/json" \
  -d '{"operation":"CHARGE","amount":{"currencyCode":"USD","minorUnits":1250},"reference":"order-1"}'
```

What the responses mean:

| Response                        | Meaning                                                                         |
| ------------------------------- | ------------------------------------------------------------------------------- |
| `200` + `"status":"COMPLETED"`  | Finished inside the synchronous wait                                            |
| `200` + `"status":"FAILED"`     | Finished with a **business** failure — a successful call with a negative answer |
| `202` + `"status":"PROCESSING"` | Still running; poll `pollUrl` (`GET /v1/process/:requestId`)                    |
| `409`                           | Same `Idempotency-Key`, different payload                                       |
| `401`                           | Missing/unknown key — or the secret is still empty                              |

Send the same `Idempotency-Key` twice: the second call must return the same `requestId` and
must **not** create a second business operation.

---

## 7. Shipping a new version

Once the environment exists, a release is three commands:

```bash
TAG=$(git rev-parse HEAD)
docker buildx build --platform linux/arm64 -t $REPO:$TAG --push .
pnpm exec cdk deploy $CTX -c imageTag=$TAG Workflow-$ENV-Api
```

Always run `pnpm cdk:diff $CTX` first and read it.

**Rollback is automatic.** ECS rolls a deployment back if tasks fail to start (circuit
breaker) or if either deployment alarm fires — `<env>-api-deployment-target-5xx` or
`<env>-api-deployment-unhealthy-targets`. To roll back by hand, redeploy the previous SHA.
This only works because tags are immutable: a moving tag makes both the deploy and the
rollback meaningless.

Infrastructure changes go through `infrastructure/cdk` only. Nothing in this system is
configured by hand in the console.

---

## 8. Operating it

### What the alarms tell you

| Alarm                    | What it means                         | First action                                       |
| ------------------------ | ------------------------------------- | -------------------------------------------------- |
| DLQ has messages         | A message failed 5 times              | Inspect it, fix the cause, then redrive            |
| Outbox stalled           | Committed work is not being published | Check the outbox-publisher logs and the stream DLQ |
| Sync timeouts elevated   | Callers are getting `202` more often  | Check worker duration and provider latency         |
| Target 5xx / unhealthy   | The API itself is failing             | Check ECS task logs; a bad deploy self-reverts     |
| Lambda errors / duration | A worker is failing or slow           | Check its log group                                |

Redriving a DLQ once the cause is fixed:

```bash
aws sqs start-message-move-task --region $REGION \
  --source-arn <dlq-arn> --destination-arn <source-queue-arn>
```

Every worker is safe to run twice on the same message, which is what makes redrive safe.

### Useful facts when something looks wrong

- **DynamoDB is the only authoritative state.** Not the HTTP response, not the queue, not
  Lambda. When in doubt, read the item.
- **An HTTP timeout never fails a workflow.** A client disconnect, an ALB timeout or an ECS
  `SIGTERM` leaves the workflow untouched and still running. Recovery is
  `GET /v1/process/:requestId`.
- **Every workflow is one `requestId`**, and it appears in every log line, every message and
  every DynamoDB item. Search on it.
- **Terminal states are never overwritten**, so a late duplicate worker cannot corrupt a
  finished workflow.

---

## 9. Know before you send real traffic

These are open items recorded in `docs/PROGRESS.md`, not surprises:

1. **Nothing has ever run on AWS.** Real ALB draining, real Fargate `SIGTERM` timing, real
   DynamoDB throttling and real Streams behaviour have not been observed (R-002).
2. **The autoscaling threshold is a guess.** `requestsPerTargetPerMinute` (600 in production)
   is derived from an assumed number of concurrent held connections per task, not measured.
   Load-test before trusting it (R-003).
3. **The external provider is simulated.** Substituting a real one means re-running the
   ADR-0008 classification. A provider that supports neither idempotency keys nor
   lookup-by-reference is `UNSAFE`, and that is a blocker rather than an integration (R-005).
4. **WAF managed rules block in staging and production.** Watch the counts in dev first — a
   managed rule that rejects a legitimate B2B JSON body is worse than the traffic it stops.
5. **ALB access logs are not enabled**, and the DynamoDB Streams fan-out is not load-tested
   (R-008).
6. **`/reliability-review` has not been run by a human** (B-002), and `/aws-review` needs a
   re-run to confirm its fixes.

---

## 10. Troubleshooting

| Symptom                                    | Cause                                                                   |
| ------------------------------------------ | ----------------------------------------------------------------------- |
| Tasks never start, "image manifest" error  | The image is not arm64 — rebuild with `--platform linux/arm64`          |
| Tasks start, then die; DynamoDB calls fail | Gap 3.1 — `AWS_REGION` is not set, so the app is talking to `us-east-1` |
| Every request returns `401`                | The API-key secret is still empty (§6.1)                                |
| `202` responses point at `localhost`       | Gap 3.2 — `PUBLIC_BASE_URL` is unset                                    |
| Dev ALB times out on port 80               | Gap 3.3 — the ALB security group only allows 443                        |
| Synth fails with "production requires …"   | A missing `-c` value; the message names it                              |
| `cdk deploy` fails on the ECS service      | The image was not pushed in time — see §5 step 2                        |
| Alarms fire but nobody is paged            | The SNS email subscription was never confirmed (§6.2)                   |
| Occasional `502` from the ALB              | The timeout ladder was edited out of order — see §4.3                   |

---

## Where to read more

| Document                                       | What it covers                         |
| ---------------------------------------------- | -------------------------------------- |
| [`docs/architecture.md`](docs/architecture.md) | How the pieces fit and why             |
| [`docs/invariants.md`](docs/invariants.md)     | The correctness rules, each with an ID |
| [`docs/DESICION.md`](docs/DESICION.md)         | Accepted decisions, with ADRs          |
| [`docs/PROGRESS.md`](docs/PROGRESS.md)         | Current state, verification, blockers  |
