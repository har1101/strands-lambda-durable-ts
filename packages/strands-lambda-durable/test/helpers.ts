import { afterEach } from "node:test";
import { withDurableExecution, type DurableContext, type Serdes } from "@aws/durable-execution-sdk-js";
import { LocalDurableTestRunner } from "@aws/durable-execution-sdk-js-testing";
import {
  Agent, Model, ReasoningBlock, tool, ToolResultBlock,
  type BaseModelConfig, type JSONValue, type Message, type ModelStreamEvent, type StreamOptions, type Tool,
  type ToolContext,
} from "@strands-agents/sdk";
import { z } from "zod";
import {
  DurableModel, DurableTool, DurableToolExecutor, invokeDurably,
  type DurableLiveEvent, type DurableModelOptions, type EventSink,
} from "../src/index.js";

export const REDACTED = new Uint8Array([0, 1, 2, 250, 255]);

type ToolUse = { name: string; input: JSONValue };

export type Script = {
  /** Tool uses requested in the first turn. Default: add_numbers(7, 8). Empty: answer directly. */
  toolUses?: ToolUse[];
  redactedReasoning?: boolean;
  answer?: string;
  /** Behave as a stateful provider: store a response ID in modelState and report it in the answer. */
  stateful?: boolean;
  /** Thrown by the first N provider calls, in order. */
  failures?: Error[];
};

export type Counter = { model: number; tool: number; invocations: number; seenToolNames: string[][] };

/**
 * Provider-independent model. It requests `toolUses` once, then answers with the tool result statuses
 * (`tool status success,error`) or `answer`.
 */
export class ScriptedModel extends Model<BaseModelConfig> {
  constructor(private readonly counter: Counter, private readonly script: Script) { super(); }
  override get stateful(): boolean { return this.script.stateful === true; }
  updateConfig(): void {}
  getConfig(): BaseModelConfig { return {}; }

  async *stream(messages: Message[], options?: StreamOptions): AsyncIterable<ModelStreamEvent> {
    this.counter.model++;
    const failure = this.script.failures?.shift();
    if (failure) throw failure;
    this.counter.seenToolNames.push((options?.toolSpecs ?? []).map(spec => spec.name));
    const results = messages.flatMap(m => m.content).filter((b): b is ToolResultBlock => b.type === "toolResultBlock");
    const toolUses = this.script.toolUses ?? [{ name: "add_numbers", input: { a: 7, b: 8 } }];
    yield { type: "modelMessageStartEvent", role: "assistant" };
    if (toolUses.length > 0 && results.length === 0) {
      if (this.script.stateful) options?.modelState?.set("responseId", "r1");
      if (this.script.redactedReasoning) {
        yield { type: "modelContentBlockStartEvent" };
        yield { type: "modelContentBlockDeltaEvent", delta: { type: "reasoningContentDelta", redactedContent: REDACTED } };
        yield { type: "modelContentBlockStopEvent" };
      }
      for (const [index, use] of toolUses.entries()) {
        yield { type: "modelContentBlockStartEvent", start: { type: "toolUseStart", name: use.name, toolUseId: `tooluse-${index + 1}` } };
        yield { type: "modelContentBlockDeltaEvent", delta: { type: "toolUseInputDelta", input: JSON.stringify(use.input) } };
        yield { type: "modelContentBlockStopEvent" };
      }
      yield { type: "modelMessageStopEvent", stopReason: "toolUse" };
      return;
    }
    const answer = this.script.stateful
      ? `state ${String(options?.modelState?.get("responseId"))}`
      : results.length > 0 ? `tool status ${results.map(r => r.status).join(",")}` : this.script.answer ?? "done";
    yield { type: "modelContentBlockStartEvent" };
    const parts = answer.startsWith("tool status ") ? ["tool ", "status ", answer.slice("tool status ".length)] : [answer];
    for (const text of parts) yield { type: "modelContentBlockDeltaEvent", delta: { type: "textDelta", text } };
    yield { type: "modelContentBlockStopEvent" };
    yield { type: "modelMessageStopEvent", stopReason: "endTurn" };
  }
}

/** Test probe: after the Nth model call's step completes, suspend with a durable wait before continuing. */
class PausingModel extends DurableModel {
  private count = 0;
  constructor(source: Model, private readonly pauseContext: DurableContext, private readonly pauseAt: number | undefined, options: DurableModelOptions) {
    super(source, pauseContext, options);
  }

  override async *stream(messages: Message[], options?: StreamOptions): AsyncIterable<ModelStreamEvent> {
    const iterator = super.stream(messages, options)[Symbol.asyncIterator]();
    let next = await iterator.next(); // the model step has completed once the first event is available
    if (++this.count === this.pauseAt) await this.pauseContext.wait("replay-after-model", { seconds: 2 });
    while (!next.done) {
      yield next.value;
      next = await iterator.next();
    }
  }
}

export class MemorySink implements EventSink {
  readonly events: (DurableLiveEvent | { kind: "approval"; [key: string]: unknown })[] = [];
  async put(event: DurableLiveEvent): Promise<void> { this.events.push(event); }
}

export type Setup = { context: DurableContext; sink: MemorySink; counter: Counter };

export type Scenario = {
  pauseAfterModelCall?: number;
  textFlushMs?: number;
  script?: Script;
  /** `durable` uses DurableToolExecutor (parallel). Default `sequential`. */
  executor?: "sequential" | "durable";
  serdes?: Serdes<any>;
  /** Tools given to the agent. Default: add_numbers wrapped in DurableTool. */
  tools?: (setup: Setup) => Tool[] | Promise<Tool[]>;
  /** add_numbers body. Default returns the sum. */
  add?: (input: { a: number; b: number }, context: ToolContext | undefined) => unknown;
  /** Runs at the start of every invocation, before the agent is built. */
  onInvocation?: (invocation: number) => void | Promise<void>;
  /**
   * Use real timers. Required when a test depends on suspension: the SDK ends an invocation only after a 20 ms
   * idle cooldown, and with skipped time a wait can complete first, so the handler never replays.
   */
  realTime?: boolean;
};

export async function harness(scenario: Scenario) {
  await LocalDurableTestRunner.setupTestEnvironment({ skipTime: !scenario.realTime });
  const counter: Counter = { model: 0, tool: 0, invocations: 0, seenToolNames: [] };
  const sink = new MemorySink();
  const script = scenario.script ?? {};
  const handler = withDurableExecution(async (_input: unknown, context: DurableContext) => {
    counter.invocations++;
    await scenario.onInvocation?.(counter.invocations);
    const addNumbers = tool({
      name: "add_numbers",
      description: "Add two numbers.",
      inputSchema: z.object({ a: z.number(), b: z.number() }),
      callback: (input, toolContext) => {
        counter.tool++;
        return (scenario.add ?? (({ a, b }) => ({ sum: a + b })))(input, toolContext) as JSONValue;
      },
    });
    const { serdes } = scenario;
    const agent = new Agent({
      // One script object for all invocations: `failures` is a queue shared across retries and replays.
      model: new PausingModel(new ScriptedModel(counter, script), context, scenario.pauseAfterModelCall, {
        events: sink,
        textFlushMs: scenario.textFlushMs,
        serdes,
      }),
      tools: await (scenario.tools?.({ context, sink, counter }) ?? [new DurableTool(addNumbers, context, { events: sink, serdes })]),
      toolExecutor: scenario.executor === "durable" ? new DurableToolExecutor(context, { serdes }) : "sequential",
      retryStrategy: null,
      printer: false,
    });
    const result = await invokeDurably(agent, context, "add 7 and 8", {
      invokeOptions: { limits: { turns: 4 } },
      onInterrupt: async pending => { sink.events.push({ kind: "approval", ...pending }); },
    });
    const content = agent.messages.flatMap(m => m.content);
    const toolResults = content
      .filter((b): b is ToolResultBlock => b.type === "toolResultBlock")
      .map(b => ({ toolUseId: b.toolUseId, status: b.status, content: JSON.parse(JSON.stringify(b.content)) }));
    const reasoning = content.find((b): b is ReasoningBlock => b.type === "reasoningBlock");
    return {
      answer: result.toString(),
      stopReason: result.stopReason,
      toolResults,
      appState: agent.appState.getAll(),
      redactedIsBytes: reasoning?.redactedContent instanceof Uint8Array,
      redacted: reasoning?.redactedContent ? [...reasoning.redactedContent] : undefined,
    };
  });
  return { counter, sink, runner: new LocalDurableTestRunner({ handlerFunction: handler }) };
}

/** Maps each operation name to its parent operation's name. */
export function parentNames(operations: { getId(): string | undefined; getParentId(): string | undefined; getName(): string | undefined }[]) {
  const byId = new Map(operations.map(op => [op.getId(), op.getName()]));
  return Object.fromEntries(operations.map(op => [op.getName() ?? "", byId.get(op.getParentId()) ?? null]));
}

afterEach(() => LocalDurableTestRunner.teardownTestEnvironment());
