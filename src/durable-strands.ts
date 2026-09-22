import { randomUUID } from "node:crypto";
import type { DurableContext } from "@aws/durable-execution-sdk-js";
import {
  Model, Tool, ToolResultBlock,
  type BaseModelConfig, type Message, type ModelStreamEvent,
  type StreamOptions, type ToolContext, type ToolStreamGenerator,
} from "@strands-agents/sdk";
import { EventWriter } from "./events.js";

type ModelRecord = { schemaVersion: 1; events: ModelStreamEvent[] };
type ToolRecord = { schemaVersion: 1; result: ReturnType<ToolResultBlock["toJSON"]>; error?: { name: string; message: string } };

function checked<T extends { schemaVersion: number }>(value: T): T {
  if (value.schemaVersion !== 1) throw new Error(`Unsupported checkpoint schema: ${value.schemaVersion}`);
  return value;
}

function jsonCopy<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** One Strands model request is one durable step. Live deltas are provisional until completion. */
export class DurableModel extends Model<BaseModelConfig> {
  private calls = 0;
  constructor(
    private readonly source: Model,
    private readonly context: DurableContext,
    private readonly events: EventWriter,
    private readonly pauseAfterFirstModel = false,
  ) {
    super();
    if (source.stateful) throw new Error("Stateful model providers are not supported by this MVP");
  }

  updateConfig(config: BaseModelConfig): void { this.source.updateConfig(config); }
  getConfig(): BaseModelConfig { return this.source.getConfig(); }
  override countTokens(messages: Message[], options?: StreamOptions): Promise<number> {
    return this.source.countTokens(messages, options);
  }

  async *stream(messages: Message[], options?: StreamOptions): AsyncIterable<ModelStreamEvent> {
    const call = ++this.calls;
    const record = checked(await this.context.step(`model-${call}`, async (): Promise<ModelRecord> => {
      const attempt = randomUUID();
      await this.events.put({ kind: "model_start", call, attempt });
      const captured: ModelStreamEvent[] = [];
      for await (const event of this.source.stream(messages, options)) {
        const data = jsonCopy(event);
        captured.push(data);
        if (data.type === "modelContentBlockDeltaEvent" && data.delta.type === "textDelta") {
          await this.events.put({ kind: "text", call, attempt, text: data.delta.text });
        }
      }
      return { schemaVersion: 1, events: captured };
    }));
    if (call === 1 && this.pauseAfterFirstModel) {
      await this.context.wait("replay-after-model", { seconds: 2 });
    }
    for (const event of record.events) yield event;
  }
}

/** Each tool use gets its own checkpoint. A new wrapper and agent are built for each invocation. */
export class DurableTool extends Tool {
  readonly name: string;
  readonly description: string;
  readonly toolSpec: Tool["toolSpec"];
  private calls = 0;

  constructor(private readonly source: Tool, private readonly context: DurableContext, private readonly events: EventWriter) {
    super();
    this.name = source.name;
    this.description = source.description;
    this.toolSpec = source.toolSpec;
  }

  async *stream(toolContext: ToolContext): ToolStreamGenerator {
    const call = ++this.calls;
    const toolUseId = toolContext.toolUse.toolUseId;
    const record = checked(await this.context.step(`tool-${this.name}-${call}-${toolUseId}`, async (): Promise<ToolRecord> => {
      const iterator = this.source.stream(toolContext);
      let next = await iterator.next();
      while (!next.done) {
        await this.events.put({ kind: "tool", tool: this.name, status: "progress", text: JSON.stringify(next.value.data) });
        next = await iterator.next();
      }
      const result = next.value;
      await this.events.put({ kind: "tool", tool: this.name, status: result.status, result: result.toJSON() });
      return {
        schemaVersion: 1,
        result: result.toJSON(),
        ...(result.error && { error: { name: result.error.name, message: result.error.message } }),
      };
    }));
    const result = ToolResultBlock.fromJSON(record.result);
    if (record.error) {
      const error = new Error(record.error.message);
      error.name = record.error.name;
      return new ToolResultBlock({ toolUseId: result.toolUseId, status: result.status, content: result.content, error });
    }
    return result;
  }
}
