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
  terminalConflict: "TerminalConflict",
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
} as const;
