import type { DurableContext, Duration } from "@aws/durable-execution-sdk-js";
import {
  InterruptResponseContent,
  type AgentResult, type InvokeArgs, type InvokeOptions, type JSONValue,
} from "@strands-agents/sdk";

export type PendingInterrupt = { callbackId: string; interrupt: { id: string; name: string; reason?: JSONValue } };

export type InvokeDurablyOptions = {
  invokeOptions?: InvokeOptions;
  /** Publishes the callback ID to whoever answers the interrupt. Runs as a durable step; keep it idempotent. */
  onInterrupt: (pending: PendingInterrupt) => Promise<void>;
  /** How long to wait for each answer. Expiry fails the execution with a callback timeout. */
  interruptTimeout?: Duration;
  /** Upper bound on interrupt-and-resume rounds. Default 10. */
  maxInterruptRounds?: number;
};

/**
 * `agent.invoke` that maps Strands interrupts to Lambda durable callbacks. The invocation suspends without
 * compute cost while waiting; the callback result (JSON) becomes the interrupt response.
 */
export async function invokeDurably(
  agent: { invoke(args: InvokeArgs, options?: InvokeOptions): Promise<AgentResult> },
  context: DurableContext,
  input: InvokeArgs,
  options: InvokeDurablyOptions,
): Promise<AgentResult> {
  let result = await agent.invoke(input, options.invokeOptions);
  const maxRounds = options.maxInterruptRounds ?? 10;
  for (let round = 1; result.stopReason === "interrupt"; round++) {
    if (round > maxRounds) throw new Error(`Agent was interrupted more than ${maxRounds} times`);
    const responses: InterruptResponseContent[] = [];
    for (const interrupt of result.interrupts ?? []) {
      const { id, name, reason } = interrupt.toJSON();
      const raw = await context.waitForCallback(
        `interrupt-${id}`,
        callbackId => options.onInterrupt({ callbackId, interrupt: { id, name, ...(reason !== undefined && { reason }) } }),
        options.interruptTimeout ? { timeout: options.interruptTimeout } : undefined,
      );
      responses.push(new InterruptResponseContent({ interruptId: id, response: parseCallbackResult(raw) }));
    }
    result = await agent.invoke(responses, options.invokeOptions);
  }
  return result;
}

function parseCallbackResult(raw: string | undefined): JSONValue {
  if (raw === undefined || raw === "") return null;
  try {
    return JSON.parse(raw) as JSONValue;
  } catch {
    return raw;
  }
}
