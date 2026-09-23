import { randomUUID } from "node:crypto";
import type { DurableContext, Serdes } from "@aws/durable-execution-sdk-js";
import {
  Model,
  type BaseModelConfig, type JSONValue, type Message, type ModelStreamEvent, type StreamOptions,
} from "@strands-agents/sdk";
import { checked, decode, encode, SCHEMA_VERSION } from "./codec.js";
import type { EventSink } from "./events.js";
import { modelRetryStrategy, type RetryStrategy } from "./retry.js";

type ModelRecord = {
  schemaVersion: 1 | 2;
  events: ModelStreamEvent[];
  /** `options.modelState` after the call, for stateful providers (for example a server-side conversation ID). */
  modelState?: Record<string, JSONValue>;
};

export type DurableModelOptions = {
  /** Receives provisional `model_start` and coalesced `text` events while the model streams. */
  events?: EventSink;
  /** Minimum interval between live text events. Deltas received in between are joined. Default 100 ms. */
  textFlushMs?: number;
  /** Step retry policy for a model call. Default {@link modelRetryStrategy}. */
  retryStrategy?: RetryStrategy;
  /** Checkpoint serialization, for example `createOffloadSerdes` for large histories. */
  serdes?: Serdes<any>;
};

/**
 * Wraps a Strands model so that each model request is one durable step. The step records the complete stream;
 * a replay yields the recorded events to the Strands loop without calling the provider again.
 */
export class DurableModel extends Model<BaseModelConfig> {
  private calls = 0;
  private readonly options: DurableModelOptions;

  constructor(private readonly source: Model, private readonly context: DurableContext, options: DurableModelOptions = {}) {
    super();
    this.options = options;
  }

  override get stateful(): boolean { return this.source.stateful; }
  updateConfig(config: BaseModelConfig): void { this.source.updateConfig(config); }
  getConfig(): BaseModelConfig { return this.source.getConfig(); }
  override countTokens(messages: Message[], options?: StreamOptions): Promise<number> {
    return this.source.countTokens(messages, options);
  }

  async *stream(messages: Message[], options?: StreamOptions): AsyncIterable<ModelStreamEvent> {
    const call = ++this.calls;
    const { events, textFlushMs = 100, retryStrategy = modelRetryStrategy, serdes } = this.options;
    const record = checked(await this.context.step(`model-${call}`, async (): Promise<ModelRecord> => {
      const attempt = randomUUID();
      await events?.put({ kind: "model_start", call, attempt });
      const captured: ModelStreamEvent[] = [];
      // The first delta is emitted at once; later deltas are coalesced to bound the number of live events.
      let pending = "";
      let lastFlush = 0;
      const flush = async () => {
        if (!pending) return;
        const text = pending;
        pending = "";
        lastFlush = Date.now();
        await events?.put({ kind: "text", call, attempt, text });
      };
      for await (const event of this.source.stream(messages, options)) {
        const data = encode(event);
        captured.push(data);
        if (events && data.type === "modelContentBlockDeltaEvent" && data.delta.type === "textDelta") {
          pending += data.delta.text;
          if (Date.now() - lastFlush >= textFlushMs) await flush();
        }
      }
      await flush();
      return {
        schemaVersion: SCHEMA_VERSION,
        events: captured,
        ...(this.source.stateful && options?.modelState && { modelState: encode(options.modelState.getAll()) }),
      };
    }, { retryStrategy, ...(serdes && { serdes }) }));

    if (record.modelState && options?.modelState) {
      const state = options.modelState;
      state.clear();
      for (const [key, value] of Object.entries(decode(record.modelState))) state.set(key, value);
    }
    for (const event of decode(record.events)) yield event;
  }
}
