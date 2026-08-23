import { Duration, RemovalPolicy } from "aws-cdk-lib";

export type EnvironmentName = "dev" | "staging" | "production";

/**
 * One source of truth for every value the application and the infrastructure must agree
 * on. The API task's environment variables are rendered from this object, so a timeout
 * cannot be changed in the stack without changing what the service actually runs with.
 */
export interface EnvironmentConfig {
  readonly envName: EnvironmentName;
  readonly isProduction: boolean;

  // ---- Networking / compute ----
  readonly maxAzs: number;
  readonly desiredCount: number;
  readonly minCapacity: number;
  readonly maxCapacity: number;
  readonly cpu: number;
  readonly memoryMiB: number;

  // ---- The timeout ladder (must stay strictly increasing) ----
  readonly syncWaitTimeoutMs: number;
  readonly requestTimeoutMs: number;
  readonly albIdleTimeout: Duration;
  readonly keepAliveTimeoutMs: number;
  readonly headersTimeoutMs: number;
  readonly clientRecommendedTimeoutMs: number;
  readonly shutdownDrainMs: number;
  readonly shutdownReadinessDelayMs: number;

  /** Must cover the longest request so a draining task is not cut off mid-response. */
  readonly deregistrationDelay: Duration;
  /** Must exceed the drain budget, or ECS SIGKILLs a task that is still finishing work. */
  readonly stopTimeout: Duration;

  // ---- Target group health checking ----
  // These decide how long the ALB takes to notice a task has failed readiness, which is
  // the window the application must stay up for during a drain.
  readonly healthCheckInterval: Duration;
  readonly healthCheckTimeout: Duration;
  readonly healthyThresholdCount: number;
  readonly unhealthyThresholdCount: number;

  /**
   * Scale-out trigger, in ALB requests per target per minute. This service holds a
   * connection open for the whole synchronous wait, so held connections — not CPU — are
   * the resource that runs out first.
   */
  readonly requestsPerTargetPerMinute: number;

  // ---- Messaging / workers ----
  readonly lambdaTimeout: Duration;
  readonly batchingWindow: Duration;
  readonly batchSize: number;
  readonly esmMaxConcurrency: number;
  readonly reservedConcurrency: number;
  readonly maxReceiveCount: number;

  // ---- Data protection ----
  readonly pointInTimeRecovery: boolean;
  readonly deletionProtection: boolean;
  readonly removalPolicy: RemovalPolicy;
  readonly logRetentionDays: number;

  // ---- Edge protection ----
  readonly wafBlockOnManagedRules: boolean;
  readonly wafRateLimitPerIp: number;

  // ---- Business ----
  readonly businessDeadlineMs: number;
  readonly workflowTtlDays: number;
  readonly outboxTtlDays: number;
  readonly outboxStaleAfterMs: number;
  readonly reconcileScheduleMinutes: number;
}

/**
 * SQS visibility timeout must cover the function's full retry behaviour:
 * `6 x lambdaTimeout + batchingWindow` (AWS guidance). Computing it instead of hardcoding
 * it means the two can never drift apart when a timeout is tuned.
 */
export const requiredVisibilityTimeout = (
  lambdaTimeout: Duration,
  batchingWindow: Duration,
): Duration =>
  Duration.seconds(6 * lambdaTimeout.toSeconds() + batchingWindow.toSeconds());

/**
 * Worst case time between a task failing readiness and the ALB taking it out of rotation:
 * the check that is already in flight, then `unhealthyThresholdCount` further checks, plus
 * one check timeout. The application must keep serving for at least this long after it
 * flips readiness, or requests arriving in the gap hit a closed listener and become
 * ALB 5xx.
 */
export const healthCheckDetectionWindow = (config: {
  readonly healthCheckInterval: Duration;
  readonly healthCheckTimeout: Duration;
  readonly unhealthyThresholdCount: number;
}): Duration =>
  Duration.seconds(
    config.healthCheckInterval.toSeconds() * (config.unhealthyThresholdCount + 1) +
      config.healthCheckTimeout.toSeconds(),
  );

const base = {
  syncWaitTimeoutMs: 20_000,
  requestTimeoutMs: 22_000,
  albIdleTimeout: Duration.seconds(30),
  keepAliveTimeoutMs: 35_000,
  headersTimeoutMs: 40_000,
  clientRecommendedTimeoutMs: 35_000,
  shutdownDrainMs: 25_000,
  // Must exceed healthCheckDetectionWindow (5s x 3 + 3s = 18s) so the ALB has certainly
  // stopped routing before the listener closes; asserted in the CDK tests. The
  // application default in packages/config stays lower because a local process has no
  // load balancer to wait for.
  shutdownReadinessDelayMs: 20_000,
  deregistrationDelay: Duration.seconds(30),
  stopTimeout: Duration.seconds(60),
  // 5s x 3 + 3s = an 18s worst-case detection window, kept short so the drain that has
  // to cover it stays inside stopTimeout.
  healthCheckInterval: Duration.seconds(5),
  healthCheckTimeout: Duration.seconds(3),
  healthyThresholdCount: 2,
  unhealthyThresholdCount: 2,
  lambdaTimeout: Duration.seconds(30),
  batchingWindow: Duration.seconds(5),
  batchSize: 5,
  businessDeadlineMs: 300_000,
  workflowTtlDays: 90,
  outboxTtlDays: 7,
  outboxStaleAfterMs: 60_000,
  reconcileScheduleMinutes: 5,
} as const;

export const environments: Record<EnvironmentName, EnvironmentConfig> = {
  dev: {
    ...base,
    envName: "dev",
    isProduction: false,
    maxAzs: 2,
    desiredCount: 1,
    minCapacity: 1,
    maxCapacity: 2,
    cpu: 512,
    memoryMiB: 1024,
    // Provisional: a task holding ~100 concurrent 20s waits sustains ~300 requests per
    // minute. Derived, not measured — R-003 must replace it with a load-tested value.
    requestsPerTargetPerMinute: 300,
    esmMaxConcurrency: 2,
    reservedConcurrency: 5,
    maxReceiveCount: 5,
    pointInTimeRecovery: false,
    deletionProtection: false,
    removalPolicy: RemovalPolicy.DESTROY,
    logRetentionDays: 7,
    // Count only: dev is where a false positive should be discovered.
    wafBlockOnManagedRules: false,
    wafRateLimitPerIp: 10_000,
  },
  staging: {
    ...base,
    envName: "staging",
    isProduction: false,
    maxAzs: 2,
    desiredCount: 2,
    minCapacity: 2,
    maxCapacity: 4,
    cpu: 512,
    memoryMiB: 1024,
    // Provisional: a task holding ~100 concurrent 20s waits sustains ~300 requests per
    // minute. Derived, not measured — R-003 must replace it with a load-tested value.
    requestsPerTargetPerMinute: 300,
    esmMaxConcurrency: 5,
    reservedConcurrency: 10,
    maxReceiveCount: 5,
    // Staging holds real-shaped data and is the rehearsal for production recovery.
    pointInTimeRecovery: true,
    deletionProtection: true,
    removalPolicy: RemovalPolicy.RETAIN,
    logRetentionDays: 30,
    // Staging rehearses production, blocking included.
    wafBlockOnManagedRules: true,
    wafRateLimitPerIp: 5_000,
  },
  production: {
    ...base,
    envName: "production",
    isProduction: true,
    // Three AZs so losing one leaves the service with genuine redundancy, not a single
    // remaining task.
    maxAzs: 3,
    desiredCount: 3,
    minCapacity: 3,
    maxCapacity: 20,
    cpu: 1024,
    memoryMiB: 2048,
    // Provisional: a task holding ~200 concurrent 20s waits sustains ~600 requests per
    // minute. Derived, not measured — R-003 must replace it with a load-tested value.
    requestsPerTargetPerMinute: 600,
    esmMaxConcurrency: 10,
    reservedConcurrency: 40,
    maxReceiveCount: 5,
    pointInTimeRecovery: true,
    deletionProtection: true,
    removalPolicy: RemovalPolicy.RETAIN,
    logRetentionDays: 90,
    wafBlockOnManagedRules: true,
    wafRateLimitPerIp: 5_000,
  },
};
