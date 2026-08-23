import { describe, expect, it } from "vitest";
import { createMetrics, METRIC_NAMESPACE } from "./metrics.js";
import type { Logger } from "./logger.js";

interface EmfPayload {
  readonly _aws: {
    readonly CloudWatchMetrics: readonly {
      readonly Namespace: string;
      readonly Dimensions: readonly (readonly string[])[];
      readonly Metrics: readonly { readonly Name: string; readonly Unit: string }[];
    }[];
  };
  readonly [key: string]: unknown;
}

const recordingLogger = (): { logger: Logger; emitted: EmfPayload[] } => {
  const emitted: EmfPayload[] = [];
  const logger = {
    info: (payload: unknown) => {
      emitted.push(payload as EmfPayload);
    },
  } as unknown as Logger;
  return { logger, emitted };
};

/** Emitting nothing at all is itself a failure, so an absent record throws rather than
 *  silently satisfying a lenient assertion. */
const onlyRecord = (emitted: readonly EmfPayload[]): EmfPayload => {
  const [payload] = emitted;
  if (payload === undefined) throw new Error("no metric was emitted");
  return payload;
};

const directiveFor = (payload: EmfPayload) => {
  const [directive] = payload._aws.CloudWatchMetrics;
  if (directive === undefined) throw new Error("no metric directive was emitted");
  return directive;
};

const dimensionSetsFor = (payload: EmfPayload): readonly (readonly string[])[] =>
  directiveFor(payload).Dimensions;

describe("EMF dimension sets", () => {
  /**
   * The failure this guards against is silent and total: CloudWatch treats every dimension
   * set as its own metric, so `SyncTimeouts{reason=deadline}` and `SyncTimeouts` are
   * different series. An alarm written against the undimensioned name never receives a
   * datapoint if only the dimensioned set is published — it stays in INSUFFICIENT_DATA
   * forever, and `treatMissingData: NOT_BREACHING` keeps it quiet while the thing it
   * watches is happening.
   */
  it("publishes an aggregate series alongside every dimensioned one", () => {
    const { logger, emitted } = recordingLogger();
    createMetrics(logger).count("SyncTimeouts", 1, { reason: "deadline" });

    expect(emitted).toHaveLength(1);
    expect(dimensionSetsFor(onlyRecord(emitted))).toEqual([[], ["reason"]]);
  });

  it("still publishes exactly one aggregate set when there are no dimensions", () => {
    const { logger, emitted } = recordingLogger();
    createMetrics(logger).count("WorkflowFailed");

    expect(dimensionSetsFor(onlyRecord(emitted))).toEqual([[]]);
  });

  it("carries the dimension values and the value itself in the same record", () => {
    const { logger, emitted } = recordingLogger();
    createMetrics(logger).duration("HttpLatencyMs", 1234, { route: "process" });

    const payload = onlyRecord(emitted);
    expect(payload["route"]).toBe("process");
    expect(payload["HttpLatencyMs"]).toBe(1234);
    expect(directiveFor(payload).Namespace).toBe(METRIC_NAMESPACE);
    expect(directiveFor(payload).Metrics).toEqual([
      { Name: "HttpLatencyMs", Unit: "Milliseconds" },
    ]);
  });

  it("applies the same rule to gauges, so a reconciler gauge can be alarmed on", () => {
    const { logger, emitted } = recordingLogger();
    createMetrics(logger).gauge("OutboxStale", 7, "Count", { source: "reconciler" });

    expect(dimensionSetsFor(onlyRecord(emitted))).toEqual([[], ["source"]]);
    expect(onlyRecord(emitted)["OutboxStale"]).toBe(7);
  });
});
