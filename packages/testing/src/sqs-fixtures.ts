import type { SQSEvent, SQSRecord } from "aws-lambda";

/** Minimal but faithful SQS record shape, so handlers are exercised as Lambda calls them. */
export const anSqsRecord = (
  body: unknown,
  overrides: Partial<SQSRecord> = {},
): SQSRecord => ({
  messageId: `msg-${Math.random().toString(36).slice(2, 10)}`,
  receiptHandle: "receipt",
  body: typeof body === "string" ? body : JSON.stringify(body),
  attributes: {
    ApproximateReceiveCount: "1",
    SentTimestamp: String(Date.now()),
    SenderId: "sender",
    ApproximateFirstReceiveTimestamp: String(Date.now()),
  },
  messageAttributes: {},
  md5OfBody: "",
  eventSource: "aws:sqs",
  eventSourceARN: "arn:aws:sqs:us-east-1:000000000000:workflow-start",
  awsRegion: "us-east-1",
  ...overrides,
});

export const anSqsEvent = (records: SQSRecord[]): SQSEvent => ({ Records: records });

/** Collects log output and metric emissions without touching stdout. */
export const silentObservability = () => {
  const logs: unknown[] = [];
  const metrics: { name: string; value: number; dimensions: unknown }[] = [];
  const noop = (): void => undefined;
  const logger = {
    info: (payload: unknown) => void logs.push(payload),
    warn: (payload: unknown) => void logs.push(payload),
    error: (payload: unknown) => void logs.push(payload),
    debug: noop,
    trace: noop,
    fatal: noop,
    child: () => logger,
  };
  return {
    logs,
    metricEvents: metrics,
    logger: logger as never,
    metrics: {
      count: (name: string, value = 1, dimensions: unknown = {}) =>
        void metrics.push({ name, value, dimensions }),
      duration: (name: string, value: number, dimensions: unknown = {}) =>
        void metrics.push({ name, value, dimensions }),
      gauge: (name: string, value: number, _unit: string, dimensions: unknown = {}) =>
        void metrics.push({ name, value, dimensions }),
    } as never,
  };
};
