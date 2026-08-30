import type { Logger } from "./logger.js";

/**
 * CloudWatch Embedded Metric Format. Metrics ride the existing log stream, so no extra
 * service, no extra dependency and no synchronous PutMetricData on the request path.
 */
export type MetricUnit = "Count" | "Milliseconds" | "Bytes" | "Percent";

export type MetricDimensions = Readonly<Record<string, string>>;

export const METRIC_NAMESPACE = "WorkflowService";

export interface Metrics {
  count(name: string, value?: number, dimensions?: MetricDimensions): void;
  duration(name: string, milliseconds: number, dimensions?: MetricDimensions): void;
  gauge(
    name: string,
    value: number,
    unit: MetricUnit,
    dimensions?: MetricDimensions,
  ): void;
}

export const createMetrics = (
  logger: Logger,
  namespace = METRIC_NAMESPACE,
): Metrics => {
  const emit = (
    name: string,
    value: number,
    unit: MetricUnit,
    dimensions: MetricDimensions,
  ): void => {
    const dimensionNames = Object.keys(dimensions);
    // Always publish the aggregate series, then the dimensioned breakdown.
    //
    // CloudWatch treats each dimension set as a distinct metric: `SyncTimeouts{reason=X}`
    // and `SyncTimeouts` are not the same series, and an alarm on the latter never sees a
    // datapoint if only the former is emitted. Publishing both sets means an alarm can be
    // written against the metric as a whole while the breakdown stays available for
    // diagnosis — and no call site has to remember which of the two an alarm depends on.
    const dimensionSets = dimensionNames.length > 0 ? [[], dimensionNames] : [[]];
    logger.info(
      {
        _aws: {
          Timestamp: Date.now(),
          CloudWatchMetrics: [
            {
              Namespace: namespace,
              Dimensions: dimensionSets,
              Metrics: [{ Name: name, Unit: unit }],
            },
          ],
        },
        ...dimensions,
        [name]: value,
        metric: name,
      },
      "metric",
    );
  };

  return {
    count: (name, value = 1, dimensions = {}) => {
      emit(name, value, "Count", dimensions);
    },
    duration: (name, milliseconds, dimensions = {}) => {
      emit(name, milliseconds, "Milliseconds", dimensions);
    },
    gauge: (name, value, unit, dimensions = {}) => {
      emit(name, value, unit, dimensions);
    },
  };
};

/** Metric names used across the service, in one place so dashboards cannot drift. */
export const METRICS = {
  httpRequests: "HttpRequests",
  httpErrors: "HttpErrors",
  httpLatency: "HttpLatencyMs",
  syncTimeouts: "SyncTimeouts",
  workflowStarted: "WorkflowStarted",
  workflowCompleted: "WorkflowCompleted",
  workflowFailed: "WorkflowFailed",
  workflowRecovered: "WorkflowRecovered",
  idempotentReplay: "IdempotentReplay",
  idempotencyConflict: "IdempotencyConflict",
  pollAttempts: "PollAttempts",
  pollDuration: "PollDurationMs",
  conditionalCheckFailed: "ConditionalCheckFailed",
  /** A terminal write lost a race to the *same* conclusion. Benign duplicate delivery. */
  terminalConflict: "TerminalConflict",
  /**
   * A terminal write lost a race to a *different* conclusion. Never benign: two workers
   * reached opposite outcomes for one workflow, so one of them is wrong.
   */
  terminalDivergence: "TerminalDivergence",
  duplicateMessage: "DuplicateMessage",
  messageProcessed: "MessageProcessed",
  messageFailed: "MessageFailed",
  outboxPublished: "OutboxPublished",
  outboxRepublished: "OutboxRepublished",
  outboxStale: "OutboxStale",
  staleWorkflow: "StaleWorkflow",
  providerCall: "ProviderCall",
  providerUnknownState: "ProviderUnknownState",
  providerReconciled: "ProviderReconciled",
  /**
   * A credential refresh failed and the cached document was served instead. The API is
   * still authenticating, but revocations have stopped propagating.
   */
  credentialRefreshFailed: "CredentialRefreshFailed",
  /** A request exhausted the server-side request budget before the ALB would give up. */
  requestBudgetExceeded: "RequestBudgetExceeded",
} as const;
