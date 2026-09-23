/**
 * Provisional live events emitted while a step runs. They are not part of the durable journal: a retried
 * model step emits a new `model_start` with a new `attempt`, and consumers replace that call's earlier text.
 */
export type DurableLiveEvent =
  | { kind: "model_start"; call: number; attempt: string }
  | { kind: "text"; call: number; attempt: string; text: string }
  | {
      kind: "tool";
      tool: string;
      toolUseId: string;
      status: "progress" | "success" | "error" | "interrupted";
      result?: unknown;
      text?: string;
    };

/**
 * Destination for live events (WebSocket push, pub/sub, a table, ...). A throwing sink fails its durable step;
 * whether it retries depends on that step's retry strategy (the default tool strategy does not retry ordinary
 * sink errors). Advisory sinks should catch their own errors.
 */
export interface EventSink {
  put(event: DurableLiveEvent): Promise<void>;
}
