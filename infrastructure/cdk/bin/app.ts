#!/usr/bin/env node
import { App, Tags } from "aws-cdk-lib";
import { environments, type EnvironmentName } from "../lib/environment.js";
import { NetworkStack } from "../lib/network/network-stack.js";
import { DataStack } from "../lib/data/data-stack.js";
import { MessagingStack } from "../lib/messaging/messaging-stack.js";
import { WorkersStack } from "../lib/workers/workers-stack.js";
import { ApiStack } from "../lib/api/api-stack.js";
import { MonitoringStack } from "../lib/monitoring/monitoring-stack.js";

const app = new App();

// Context is arbitrary input, so it is validated rather than cast into a type it may
// not actually have.
const isEnvironmentName = (value: string): value is EnvironmentName =>
  Object.hasOwn(environments, value);

const requestedEnv = String(app.node.tryGetContext("env") ?? "dev");
if (!isEnvironmentName(requestedEnv)) {
  throw new Error(
    `unknown environment "${requestedEnv}"; expected dev, staging or production`,
  );
}
const envName: EnvironmentName = requestedEnv;
const config = environments[envName];

/**
 * No account/region lookups anywhere in this app: `cdk synth` must work without
 * credentials, so every stack is environment-agnostic unless explicitly told otherwise.
 */
const env =
  process.env["CDK_DEFAULT_ACCOUNT"] === undefined
    ? undefined
    : {
        account: process.env["CDK_DEFAULT_ACCOUNT"],
        region: process.env["CDK_DEFAULT_REGION"] ?? "us-east-1",
      };

// Defaults are dev conveniences only. Production rejects each of them at synth time —
// in ApiStack for the image tag, in WorkersStack for the provider, in MonitoringStack for
// the alarm subscribers — so a forgotten `-c` never reaches a deployment.
const imageTag = (app.node.tryGetContext("imageTag") ?? "latest") as string;
const certificateArn = app.node.tryGetContext("certificateArn") as string | undefined;
const providerBaseUrl =
  (app.node.tryGetContext("providerBaseUrl") as string | undefined) ??
  "https://provider.invalid";

const splitContextList = (value: unknown): string[] =>
  typeof value === "string"
    ? value
        .split(",")
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0)
    : [];

const alarmEmails = splitContextList(app.node.tryGetContext("alarmEmails"));

// Optional: a stable public name in front of the ALB. Built from supplied attributes, not
// a hosted-zone lookup, because synth must work without credentials.
const hostedZoneId = app.node.tryGetContext("hostedZoneId") as string | undefined;
const zoneName = app.node.tryGetContext("zoneName") as string | undefined;
const recordName = app.node.tryGetContext("recordName") as string | undefined;
if (
  [hostedZoneId, zoneName, recordName].some((value) => value !== undefined) &&
  [hostedZoneId, zoneName, recordName].some((value) => value === undefined)
) {
  throw new Error(
    "hostedZoneId, zoneName and recordName must be supplied together, or not at all",
  );
}
const domain =
  hostedZoneId !== undefined && zoneName !== undefined && recordName !== undefined
    ? { hostedZoneId, zoneName, recordName }
    : undefined;

const prefix = `Workflow-${envName}`;

const availabilityZonesContext = app.node.tryGetContext("availabilityZones") as
  string | undefined;
const availabilityZones =
  availabilityZonesContext === undefined
    ? undefined
    : availabilityZonesContext.split(",").map((zone) => zone.trim());

const network = new NetworkStack(app, `${prefix}-Network`, {
  env,
  config,
  ...(availabilityZones === undefined ? {} : { availabilityZones }),
});
const data = new DataStack(app, `${prefix}-Data`, { env, config });
const messaging = new MessagingStack(app, `${prefix}-Messaging`, { env, config });

const workers = new WorkersStack(app, `${prefix}-Workers`, {
  env,
  config,
  table: data.table,
  startQueue: messaging.startQueue,
  stepQueue: messaging.stepQueue,
  providerBaseUrl,
});

const api = new ApiStack(app, `${prefix}-Api`, {
  env,
  config,
  vpc: network.vpc,
  albSecurityGroup: network.albSecurityGroup,
  serviceSecurityGroup: network.serviceSecurityGroup,
  table: data.table,
  imageTag,
  certificateArn,
  ...(domain === undefined ? {} : { domain }),
});

new MonitoringStack(app, `${prefix}-Monitoring`, {
  env,
  config,
  table: data.table,
  queues: [
    { name: "Start", queue: messaging.startQueue, dlq: messaging.startDlq },
    { name: "Step", queue: messaging.stepQueue, dlq: messaging.stepDlq },
  ],
  functions: [
    { name: "WorkerA", fn: workers.workerA },
    { name: "Finalizer", fn: workers.finalizer },
    { name: "OutboxPublisher", fn: workers.outboxPublisher },
    { name: "Reconciler", fn: workers.reconciler },
  ],
  loadBalancer: api.loadBalancer,
  targetGroup: api.targetGroup,
  service: api.service,
  streamDlq: workers.streamDlq,
  alarmEmails,
});

Tags.of(app).add("service", "workflow-service");
Tags.of(app).add("environment", envName);
