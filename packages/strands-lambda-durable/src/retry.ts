import { createRetryStrategy, type StepConfig } from "@aws/durable-execution-sdk-js";
import { ModelThrottledError } from "@strands-agents/sdk";

/** Durable step retry policy: `(error, attemptsMade) => { shouldRetry, delay? }`. */
export type RetryStrategy = NonNullable<StepConfig<unknown>["retryStrategy"]>;

const TRANSIENT_MODEL_ERROR = /throttl|too many requests|ServiceUnavailable|InternalServer|ModelNotReady|timed? ?out|ECONNRESET|socket hang up/i;
const modelBackoff = createRetryStrategy({ maxAttempts: 4, initialDelay: { seconds: 2 }, maxDelay: { seconds: 30 } });

/** Transient model failures: throttling, service-side 5xx, and dropped connections. Validation errors fail at once. */
export const modelRetryStrategy: RetryStrategy = (error, attempts) =>
  error instanceof ModelThrottledError || TRANSIENT_MODEL_ERROR.test(`${error.name} ${error.message}`)
    ? modelBackoff(error, attempts)
    : { shouldRetry: false };

/**
 * Throw from a tool to request an infrastructure retry of that tool's step.
 * Any other exception is a business result: it is checkpointed as an error tool result and shown to the model.
 */
export class RetryableToolError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "RetryableToolError";
  }
}

const toolBackoff = createRetryStrategy({ maxAttempts: 3, initialDelay: { seconds: 2 }, maxDelay: { seconds: 30 } });

/** Retries only {@link RetryableToolError}; up to 3 attempts with exponential backoff. */
export const toolRetryStrategy: RetryStrategy = (error, attempts) =>
  error instanceof RetryableToolError ? toolBackoff(error, attempts) : { shouldRetry: false };
