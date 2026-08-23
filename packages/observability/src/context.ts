import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Correlation fields carried across await boundaries so every log line inside a request
 * or a message invocation is attributable without threading a logger through every
 * signature (INV-04, INV-80).
 */
export interface CorrelationContext {
  readonly requestId?: string;
  readonly tenantId?: string;
  readonly messageId?: string;
  readonly step?: string;
  readonly workflowVersion?: number;
  readonly attempt?: number;
}

const storage = new AsyncLocalStorage<CorrelationContext>();

export const getCorrelation = (): CorrelationContext => storage.getStore() ?? {};

export const withCorrelation = <T>(context: CorrelationContext, fn: () => T): T =>
  storage.run({ ...getCorrelation(), ...context }, fn);
