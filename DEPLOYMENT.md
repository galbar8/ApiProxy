# Deploying this service to AWS

This guide assumes you have never used AWS. Every term is explained the first time it
appears, every command is copy-pasteable, and nothing asks you to edit source code.

Read sections 1–3 before running anything. They are short, and section 2 is about money.

> **Status:** this project has never been deployed. The infrastructure code builds and is
> covered by tests, but nothing here has been applied to a real AWS account. Treat your
> first deploy as an experiment in a `dev` environment, not a production launch.

---

## 1. What this is

A B2B HTTP API that looks synchronous to the caller and is asynchronous underneath. A
client posts a request; the service starts a workflow, waits up to 20 seconds, and either
returns the finished result on that same request or replies "still working, ask me again
here".

```text
        your client
             │  HTTPS
             ▼
        load balancer ──► API container ──► database ──► queues ──► workers
                              ▲                                        │
                              └───────── polls for the result ─────────┘
```

Deploying it creates **seven groups of resources**:

| Group        | What it is, in plain terms                                  |
| ------------ | ----------------------------------------------------------- |
| `Network`    | A private network for the API to run inside                 |
| `Ecr`        | A place to store the API's container image                  |
| `Data`       | The database holding every workflow (DynamoDB)              |
| `Messaging`  | Queues that hand work to the background workers             |
| `Workers`    | Four small background programs (Lambda functions)           |
| `Api`        | The public entry point: a load balancer and the running API |
| `Monitoring` | Alarms that email you when something breaks                 |

---

## 2. What it costs, and how to delete it

**AWS bills by the hour for some of this, whether or not anyone calls your API.** A load
balancer costs money sitting idle. This is the single most important thing to understand
before you start.

There are two **profiles** — two answers to "how much of the optional stuff do I want":

|                           | `minimal`      | `standard`                 |
| ------------------------- | -------------- | -------------------------- |
| Rough idle cost           | **~$35/month** | **~$125/month**            |
| Firewall (WAF)            | no             | yes                        |
| Private network endpoints | no             | yes (~$73/mo of the total) |
| Container metrics         | no             | yes                        |
| Everything else           | identical      | identical                  |
| Can be used for           | `dev` only     | any environment            |

These are **estimates for a quiet `us-east-1` environment, not quotes.** Check
[AWS pricing](https://calculator.aws) for your region. Real traffic costs more.

Use `minimal` to see the service working. It is refused for `staging` and `production` —
the command will stop with an error rather than deploy a weaker environment.

**To delete everything and stop the charges:**

```bash
./scripts/destroy-dev.sh
```

Do this the moment you are done experimenting. Section 12 covers what it leaves behind.

---

## 3. AWS words you will see

You do not need to understand these deeply. You need to recognise them.

| Word                | What it means here                                                                            |
| ------------------- | --------------------------------------------------------------------------------------------- |
| **Region**          | A physical location, e.g. `eu-west-1` (Ireland). Everything here lives in one.                |
| **IAM**             | Who is allowed to do what. Your login is an IAM identity.                                     |
| **VPC**             | A private network inside AWS. The API runs in one.                                            |
| **ALB**             | Application Load Balancer — the public front door. Has a URL, forwards to the API.            |
| **ECS / Fargate**   | Runs your container. Fargate means you never manage a server.                                 |
| **ECR**             | A private Docker registry. You push the API image here; ECS pulls it.                         |
| **DynamoDB**        | The database. The only place workflow state truly lives.                                      |
| **SQS**             | A queue. A worker reads a message, does the work, deletes the message.                        |
| **DLQ**             | Dead-letter queue: where a message goes after failing five times.                             |
| **Lambda**          | Runs a small program on demand. The four workers are Lambdas.                                 |
| **WAF**             | A firewall in front of the load balancer. Rate-limits by IP.                                  |
| **Secrets Manager** | Where the API keys live. Not in the code, not in the config.                                  |
| **SNS**             | Sends the alarm emails.                                                                       |
| **ACM**             | Issues HTTPS certificates. Free.                                                              |
| **Route 53**        | DNS. Optional — you can use the load balancer's own ugly URL.                                 |
| **CloudFormation**  | AWS's own "build exactly these resources" engine. A **stack** is one deployment of one group. |
| **CDK**             | What this project is written in. It generates CloudFormation for you.                         |
| **Bootstrap**       | A one-time setup CDK needs in each region before its first deploy.                            |

---

## 4. Step 0 — get an AWS account and prove your terminal can reach it

1. **Create an account** at [aws.amazon.com](https://aws.amazon.com). It needs a credit
   card. Turn on MFA on the root user when it offers.
2. **Do not use the root user for anything else.** Create a second identity to work with:
   IAM Identity Center is the current recommendation, or an IAM user with the
   `AdministratorAccess` policy if you want the shortest path for an experiment.
3. **Set a billing alert** — Billing → Budgets → create a zero-spend or $50 budget. Ten
   minutes now, no surprises later.
4. **Pick a region and write it down.** Somewhere near you: `us-east-1` (Virginia),
   `eu-west-1` (Ireland), `eu-central-1` (Frankfurt), `ap-southeast-1` (Singapore).

Then, in your terminal:

```bash
aws configure
```

It asks four things: your access key ID, your secret access key (both from the IAM
console, under your user's Security credentials), your region from step 4, and output
format — type `json`.

Prove it worked:

```bash
aws sts get-caller-identity
```

You should see your account number and your identity's ARN. **If this command fails,
nothing later in this guide will work.** Fix it before continuing.

---

## 5. Step 1 — install four tools

| Tool           | Version                               | How to check            |
| -------------- | ------------------------------------- | ----------------------- |
| Node.js        | 22 or newer                           | `node --version`        |
| pnpm           | `corepack enable` then it's automatic | `pnpm --version`        |
| Docker Desktop | any current, must include `buildx`    | `docker buildx version` |
| AWS CLI        | v2                                    | `aws --version`         |

Then, once, in the project directory:

```bash
pnpm install
pnpm lint && pnpm typecheck && pnpm test
```

All three must pass before you deploy anything. They take a couple of minutes.

---

## 6. Step 2 — deploy (the easy way)

One command, from the project directory:

```bash
./scripts/deploy-dev.sh
```

It checks your tools and credentials, prints exactly what it is about to create and
roughly what it will cost, and **waits for you to type `deploy`**. Nothing is created
before that.

It then does five things in order, which is the order that matters:

1. **Bootstrap** the region (harmless if already done).
2. Create the **image repository** — before anything that needs an image.
3. **Build and push** the API image, forced to `arm64`.
4. Create the **network, database, queues and workers**.
5. Create the **API and alarms**.

It finishes by printing your API's URL and the name of the secret you need to fill in
next (section 9).

To use the fuller `standard` profile instead:

```bash
PROFILE=standard ./scripts/deploy-dev.sh
```

---

## 7. Step 2, the manual way

Same thing, by hand. Use this if the script fails, or if you want to see what it does.

```bash
export REGION=$(aws configure get region)
export ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
export ENV=dev
export TAG=$(git rev-parse HEAD)
export CTX="-c env=$ENV -c profile=minimal -c imageTag=$TAG"

# Once per account+region, ever:
pnpm exec cdk bootstrap aws://$ACCOUNT/$REGION

# 1. The image repository, on its own, first.
pnpm exec cdk deploy $CTX Workflow-$ENV-Ecr

# 2. Push an image into it.
export REPO=$(aws cloudformation describe-stacks --region $REGION \
  --stack-name Workflow-$ENV-Ecr \
  --query "Stacks[0].Outputs[?OutputKey=='RepositoryUri'].OutputValue" --output text)

aws ecr get-login-password --region $REGION \
  | docker login --username AWS --password-stdin ${REPO%%/*}

docker buildx build --platform linux/arm64 -t $REPO:$TAG --push .

# 3. Everything that does not need the image.
pnpm exec cdk deploy $CTX \
  Workflow-$ENV-Network Workflow-$ENV-Data Workflow-$ENV-Messaging Workflow-$ENV-Workers

# 4. The API and its alarms.
pnpm exec cdk deploy $CTX Workflow-$ENV-Api Workflow-$ENV-Monitoring
```

CDK will pause and ask you to approve changes that affect permissions or firewall rules.
**Read them.** Typing `y` is how resources get created.

> **The image must be `arm64`.** The task asks for it. An `x86` image uploads happily and
> then fails to start with an unhelpful "image manifest" error. `--platform linux/arm64`
> handles the cross-build from an Intel machine.

---

## 8. Step 3 — the settings you can pass

Everything is a `-c name=value` flag on the `cdk` command.

| Flag                                     | Needed for          | What it is                                                          |
| ---------------------------------------- | ------------------- | ------------------------------------------------------------------- |
| `env`                                    | always              | `dev`, `staging` or `production`. Default `dev`.                    |
| `profile`                                | optional            | `minimal` or `standard`. Default `standard`. `minimal` is dev-only. |
| `imageTag`                               | production          | Must be a git commit SHA or `v1.2.3` — see the warning below.       |
| `certificateArn`                         | staging, production | An ACM certificate, in the same region.                             |
| `providerBaseUrl`                        | production          | The real external provider. Placeholder domains are rejected.       |
| `alarmEmails`                            | production          | Comma-separated. Each gets a confirmation email.                    |
| `availabilityZones`                      | production          | Comma-separated, at least three.                                    |
| `publicBaseUrl`                          | optional            | Override the public origin if something sits in front of the ALB.   |
| `hostedZoneId`, `zoneName`, `recordName` | optional            | All three or none. Creates a DNS record for the ALB.                |

**If you forget a required one, the command stops and names it.** That is deliberate — a
forgotten flag can never reach a deployment.

> **Image tags.** In production, tags are immutable and validated: use a git SHA
> (`-c imageTag=$(git rev-parse HEAD)`). A moving tag like `latest` makes both deploys and
> rollbacks meaningless — pushing new bytes changes nothing CloudFormation can see, and
> "roll back" restores a task pointing at the same moving tag. Do not pass a `sha256:…`
> digest here; it passes validation and is then used as a tag, which is not a valid image
> reference.

### Environment differences

| Setting                 | `dev`          | `staging`      | `production`    |
| ----------------------- | -------------- | -------------- | --------------- |
| Availability zones      | 2              | 2              | **3**           |
| Fargate tasks           | 1 (max 2)      | 2 (max 4)      | 3 (max 20)      |
| CPU / memory            | 512 / 1024 MiB | 512 / 1024 MiB | 1024 / 2048 MiB |
| Database backups (PITR) | off            | on             | on              |
| Deletion protection     | off            | on             | on              |
| On stack delete         | destroyed      | **retained**   | **retained**    |
| Log retention           | 7 days         | 30 days        | 90 days         |
| Firewall managed rules  | count only     | **block**      | **block**       |
| HTTPS                   | optional       | required       | required        |
| `minimal` profile       | allowed        | refused        | refused         |

---

## 9. Step 4 — give yourself an API key

**The service returns `401` to everything until you do this.** The stack creates an empty
key store on purpose; keys are not in the code and not in the infrastructure.

Only a SHA-256 hash is stored. The real key exists in exactly two places: your client's
config, and the request header.

```bash
ENV=dev
REGION=$(aws configure get region)

KEY=$(openssl rand -hex 32)                                   # this is what you send
HASH=$(printf '%s' "$KEY" | shasum -a 256 | cut -d' ' -f1)
SECRET=$(aws cloudformation describe-stacks --region $REGION \
  --stack-name Workflow-$ENV-Api \
  --query "Stacks[0].Outputs[?OutputKey=='ApiKeySecretName'].OutputValue" --output text)

aws secretsmanager put-secret-value --region $REGION --secret-id "$SECRET" \
  --secret-string "$(cat <<JSON
{"tenants":[{"tenantId":"acme","status":"active","keys":[{"kid":"acme-2026-08","hash":"$HASH"}]}]}
JSON
)"

echo "Your API key (save it now, it is not recoverable): $KEY"
```

The document's rules, enforced at runtime:

- `tenantId` — 1–64 characters, `A-Z a-z 0-9 . _ -`
- `status` — `active` or `disabled`; a disabled tenant is ignored entirely
- each key — a `kid` you choose, a 64-character lowercase hex `hash`, and an optional
  `expiresAt` (epoch milliseconds) used while rotating a key out

**Rotating a key:** add the new one alongside the old, move the client across, then remove
the old entry. The API caches the document for 60 seconds, so allow a minute.

---

## 10. Step 5 — call it

```bash
ENV=dev
REGION=$(aws configure get region)
BASE=$(aws cloudformation describe-stacks --region $REGION \
  --stack-name Workflow-$ENV-Api \
  --query "Stacks[0].Outputs[?OutputKey=='PublicBaseUrl'].OutputValue" --output text)

curl -s $BASE/health/live      # {"status":"live"}  — the container is running
curl -s $BASE/health/ready     # {"status":"ready"} — the load balancer uses this one

curl -sS -X POST $BASE/v1/process \
  -H "Authorization: ApiKey $KEY" \
  -H "Idempotency-Key: $(uuidgen)" \
  -H "Content-Type: application/json" \
  -d '{"operation":"CHARGE","amount":{"currencyCode":"USD","minorUnits":1250},"reference":"order-1"}'
```

What you get back:

| Response                        | What it means                            | What to do                                    |
| ------------------------------- | ---------------------------------------- | --------------------------------------------- |
| `200` + `"status":"COMPLETED"`  | Finished inside the 20-second wait       | Nothing. Done.                                |
| `200` + `"status":"FAILED"`     | Finished, business answer was "no"       | Read `error`. This is a success, technically. |
| `202` + `"status":"PROCESSING"` | Still running                            | `GET` the `pollUrl` in the body               |
| `409`                           | Same `Idempotency-Key`, different body   | Fix the client — it is reusing a key          |
| `401`                           | Bad key, or the key store is still empty | Section 9                                     |

**Try sending the same `Idempotency-Key` twice.** You must get the same `requestId` back,
and no second charge is created. That property is the point of the whole design.

---

## 11. Understanding the 20 seconds

This is the one design detail worth understanding, because getting it wrong turns a
recoverable workflow into a support ticket.

```text
20s  the service gives up waiting and returns 202
22s  the API abandons the request internally
30s  the load balancer would drop an idle connection
35s  what your client's timeout should be
```

Each is larger than the one before, deliberately. **Tell your clients to use a
35-second timeout.** A client that gives up at 10 seconds turns a workflow that was going
to succeed into an error it has to handle.

Change these in `infrastructure/cdk/lib/environment.ts` only — never in the app, never in
the AWS console. The service refuses to start if the order is broken.

---

## 12. Deleting everything

```bash
./scripts/destroy-dev.sh
```

It asks you to type `destroy dev` first. **The dev database has no backups, so there is no
undo.**

What remains afterwards, deliberately:

- **The CDK bootstrap stack** (`CDKToolkit`) — shared by every CDK project in the region,
  costs a few cents a month. Leave it unless you are finished with CDK entirely.

What does _not_ apply to `staging` and `production`: their databases are set to **retain**,
so deleting the stack leaves the table behind on purpose. Deleting real data is a manual,
deliberate act.

Check nothing unexpected is still running:

```bash
aws cloudformation list-stacks --region $REGION \
  --stack-status-filter CREATE_COMPLETE UPDATE_COMPLETE \
  --query "StackSummaries[].StackName" --output table
```

---

## 13. Going to production

Everything above still applies. What changes:

1. **You need an HTTPS certificate.** Request one in ACM **in the same region as the load
   balancer**, for the domain your clients will call. `staging` and `production` refuse to
   build without one.
2. **You need three availability zones**, named explicitly:
   `-c availabilityZones=${REGION}a,${REGION}b,${REGION}c`.
3. **You need a real provider URL.** `apps/fake-provider` is a local test double and is
   never deployed.
4. **You need at least one alarm email.** Production refuses to build without one — and
   **the address must click the confirmation email SNS sends**, or every alarm goes
   nowhere. Check with:
   ```bash
   aws sns list-subscriptions-by-topic --region $REGION --topic-arn <AlarmTopicArn>
   ```
   `PendingConfirmation` means your alarms are silent.
5. **You need an immutable image tag** — a git SHA.
6. **The `minimal` profile is not available.** It will refuse.

```bash
pnpm exec cdk deploy -c env=production \
  -c imageTag=$(git rev-parse HEAD) \
  -c certificateArn=arn:aws:acm:$REGION:$ACCOUNT:certificate/xxxxxxxx \
  -c providerBaseUrl=https://provider.example.com \
  -c alarmEmails=oncall@yourcompany.com \
  -c availabilityZones=${REGION}a,${REGION}b,${REGION}c \
  --all
```

Run `pnpm exec cdk diff` with the same flags first, and read it.

---

## 14. Shipping a new version

```bash
TAG=$(git rev-parse HEAD)
docker buildx build --platform linux/arm64 -t $REPO:$TAG --push .
pnpm exec cdk deploy $CTX -c imageTag=$TAG Workflow-$ENV-Api
```

**Rollback is automatic.** ECS reverts a deployment if the new tasks fail to start, or if
either deployment alarm fires (`<env>-api-deployment-target-5xx`,
`<env>-api-deployment-unhealthy-targets`). To roll back by hand, redeploy the previous
SHA. This only works because tags are immutable.

Infrastructure changes go through `infrastructure/cdk` only. Nothing here is configured by
hand in the console — a console change is silently undone by the next deploy.

---

## 15. Running it

### What each alarm is telling you

| Alarm                    | What happened                         | First thing to check                          |
| ------------------------ | ------------------------------------- | --------------------------------------------- |
| DLQ has messages         | A message failed five times           | Read the message, fix the cause, then redrive |
| Outbox stalled           | Committed work is not being published | Outbox-publisher logs, and the stream DLQ     |
| Sync timeouts elevated   | Callers are getting `202` more often  | Worker duration, provider latency             |
| Target 5xx / unhealthy   | The API itself is failing             | ECS task logs; a bad deploy reverts itself    |
| Lambda errors / duration | A worker is failing or slow           | That function's log group                     |

Putting dead-lettered messages back once the cause is fixed:

```bash
aws sqs start-message-move-task --region $REGION \
  --source-arn <dlq-arn> --destination-arn <source-queue-arn>
```

That is safe because every worker is designed to survive running twice on the same
message.

### Four facts that resolve most confusion

- **DynamoDB is the only real state.** Not the HTTP response, not the queue, not Lambda.
  When in doubt, read the item.
- **An HTTP timeout never fails a workflow.** A dropped client, a load balancer timeout,
  a container being replaced — the workflow keeps running. Recover with
  `GET /v1/process/:requestId`.
- **Every workflow is one `requestId`**, and it appears in every log line, message and
  database item. Search on it.
- **A finished workflow is never overwritten**, so a late duplicate worker cannot corrupt
  a result that already came back.

---

## 16. When something goes wrong

| Symptom                                                      | Cause                                         | Fix                                     |
| ------------------------------------------------------------ | --------------------------------------------- | --------------------------------------- |
| `aws sts get-caller-identity` fails                          | Credentials not configured                    | `aws configure`, section 4              |
| Tasks never start, "image manifest" error                    | Image is not arm64                            | Rebuild with `--platform linux/arm64`   |
| Every request returns `401`                                  | The key store is empty                        | Section 9                               |
| `cdk deploy` fails on the API stack                          | No image was pushed first                     | Deploy `-Ecr`, push, then retry         |
| Synth fails with "production requires …"                     | A missing `-c` flag                           | The message names it                    |
| Synth fails with "profile=minimal is only available for dev" | `minimal` on a real environment               | Use `standard`, or use `dev`            |
| The API URL times out                                        | Wrong scheme — dev serves `http`, not `https` | Use the `PublicBaseUrl` output verbatim |
| Alarms fire but nobody is emailed                            | The SNS subscription was never confirmed      | Section 13, item 4                      |
| Occasional `502` from the load balancer                      | Timeout ladder edited out of order            | Section 11                              |
| `cdk destroy` leaves the repository behind                   | Only happens on RETAIN environments           | Expected; delete deliberately           |

---

## 17. Before you send real traffic

Open items, recorded in `docs/PROGRESS.md`. None is a surprise:

1. **Nothing has ever run on AWS.** Real load balancer draining, real container shutdown
   timing, real DynamoDB throttling and real stream behaviour have not been observed
   (R-002).
2. **The autoscaling threshold is a guess** — derived, not measured. Load-test before
   trusting it (R-003).
3. **The external provider is simulated.** Substituting a real one means redoing the
   ADR-0008 safety classification first. A provider supporting neither idempotency keys
   nor lookup-by-reference is unsafe, and that is a blocker, not an integration (R-005).
4. **Watch the firewall's managed-rule counts in dev** before trusting blocking mode
   elsewhere. A rule that rejects a legitimate B2B JSON body is worse than the traffic it
   stops.
5. **Load balancer access logs are off**, and stream fan-out is not load-tested (R-008).
6. **Both review passes need re-running by a human** to confirm their fixes (B-002).

---

## Where to read more

| Document                                       | What it covers                               |
| ---------------------------------------------- | -------------------------------------------- |
| [`docs/architecture.md`](docs/architecture.md) | How the pieces fit, and why                  |
| [`docs/invariants.md`](docs/invariants.md)     | The correctness rules, each with an ID       |
| [`docs/DESICION.md`](docs/DESICION.md)         | Every accepted decision, with its reasoning  |
| [`docs/PROGRESS.md`](docs/PROGRESS.md)         | Current state, verification, blockers        |
| [`docs/API.md`](docs/API.md)                   | The HTTP contract, for the people calling it |
