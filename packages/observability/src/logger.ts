import pino, { type Logger as PinoLogger } from "pino";
import { getCorrelation } from "./context.js";

export type Logger = PinoLogger;

export interface LoggerOptions {
  readonly level: string;
  readonly serviceName: string;
  readonly serviceVersion: string;
  readonly environment: string;
  readonly destination?: pino.DestinationStream;
}

/**
 * Paths scrubbed before anything reaches stdout. Credentials must never be logged
 * (INV-73), and prose discipline is not a control: the redaction is structural.
 */
const REDACTED_PATHS = [
  "authorization",
  "Authorization",
  "apiKey",
  "api_key",
  "secret",
  "password",
  "token",
  "req.headers.authorization",
  "request.headers.authorization",
  "headers.authorization",
  "*.authorization",
  "*.apiKey",
  "*.secret",
  "*.token",
];

export const createLogger = (options: LoggerOptions): Logger =>
  pino(
    {
      level: options.level,
      base: {
        service: options.serviceName,
        version: options.serviceVersion,
        env: options.environment,
      },
      redact: { paths: REDACTED_PATHS, censor: "[REDACTED]" },
      timestamp: pino.stdTimeFunctions.isoTime,
      formatters: {
        level: (label) => ({ level: label }),
      },
      /** Every line inherits the ambient correlation fields. */
      mixin: () => getCorrelation(),
    },
    options.destination ?? pino.destination({ sync: false }),
  );

/**
 * Error serialisation that preserves the fields operations actually needs: the code and
 * the failure classification that decided whether a retry happened.
 */
export const serializeError = (error: unknown): Record<string, unknown> => {
  if (error instanceof Error) {
    const extra = error as Error & { code?: unknown; failureClass?: unknown };
    return {
      name: error.name,
      message: error.message,
      ...(typeof extra.code === "string" ? { errorCode: extra.code } : {}),
      ...(typeof extra.failureClass === "string"
        ? { failureClass: extra.failureClass }
        : {}),
      stack: error.stack,
    };
  }
  return { name: "UnknownError", message: String(error) };
};
