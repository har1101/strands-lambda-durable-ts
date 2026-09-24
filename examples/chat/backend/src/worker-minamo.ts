// One chat run with minamo: a hand-written agent loop over Amazon Bedrock ConverseStream on a Lambda durable
// function. The request, storage, live events and UI are the same as worker.ts (Strands); only the agent layer
// differs. Every model call is one durable step, every tool call runs in its own scope, and a refund waits for
// human approval on a durable callback without holding compute.
import {
  BedrockRuntimeClient, ConverseStreamCommand,
  type ContentBlock, type ConverseStreamOutput, type Message, type StopReason, type Tool as BedrockTool,
} from "@aws-sdk/client-bedrock-runtime";
import { withDurableExecution, type DurableContext } from "@aws/durable-execution-sdk-js";
import { lambda } from "@minamojs/lambda-df";
import { model, runTools, type Durable, type Tool, type ToolCall, type ToolResult } from "@minamojs/minamo";
import { AppSyncPublisher, ChatChannel } from "./appsync.js";
import { completeRun, failRun, loadMessages, setPendingApproval, type ChatMessage, type PendingApproval } from "./store.js";
import {
  issueRefund, lookupOrder, requireEnv, SYSTEM_PROMPT, TOOL_DESCRIPTIONS, validate, type WorkerRequest,
} from "./worker-common.js";

const MAX_TURNS = 8;
/** The first text delta of a model call is published at once; later ones are batched per this interval. */
const TEXT_FLUSH_MS = 100;

const modelId = requireEnv("BEDROCK_MODEL_ID");
const publisher = new AppSyncPublisher(requireEnv("EVENTS_HTTP_DOMAIN"), requireEnv("AWS_REGION"));
// minamo retries the whole model step on transient errors, so the client itself does not retry.
const bedrock = new BedrockRuntimeClient({ maxAttempts: 1 });

const objectSchema = (properties: Record<string, Record<string, string | number>>) =>
  ({ json: { type: "object", properties, required: Object.keys(properties), additionalProperties: false } });

const TOOL_SPECS: BedrockTool[] = [
  {
    toolSpec: {
      name: "add_numbers",
      description: TOOL_DESCRIPTIONS.add_numbers,
      inputSchema: objectSchema({ a: { type: "number" }, b: { type: "number" } }),
    },
  },
  {
    toolSpec: {
      name: "lookup_order",
      description: TOOL_DESCRIPTIONS.lookup_order,
      inputSchema: objectSchema({ orderId: { type: "string", description: "注文ID。例: A-1001" } }),
    },
  },
  {
    toolSpec: {
      name: "issue_refund",
      description: TOOL_DESCRIPTIONS.issue_refund,
      inputSchema: objectSchema({ orderId: { type: "string" }, amount: { type: "number", exclusiveMinimum: 0, description: "返金額 (円)" } }),
    },
  },
];

// Tool inputs are model output; each tool checks its own. A thrown Error becomes an error result for the model.
function numberField(input: unknown, key: string): number {
  const value = (input as Record<string, unknown> | null | undefined)?.[key];
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${key} must be a number`);
  return value;
}

function stringField(input: unknown, key: string): string {
  const value = (input as Record<string, unknown> | null | undefined)?.[key];
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${key} must be a non-empty string`);
  return value;
}

/** The run's tools. Live events are published inside steps, so a replay does not publish them again. */
function shopTools(channel: ChatChannel, requestApproval: (pending: PendingApproval) => Promise<void>): Record<string, Tool> {
  const plain = (name: string, run: (input: unknown) => unknown): Tool => ({
    run: async (input, { call: { id: toolUseId } }) => {
      await channel.publish({ kind: "tool", tool: name, toolUseId, status: "progress" });
      try {
        const output = await run(input);
        await channel.publish({ kind: "tool", tool: name, toolUseId, status: "success", result: output });
        return output;
      } catch (error) {
        const text = error instanceof Error ? error.message : String(error);
        await channel.publish({ kind: "tool", tool: name, toolUseId, status: "error", text });
        throw error;
      }
    },
  });

  return {
    add_numbers: plain("add_numbers", input => ({ sum: numberField(input, "a") + numberField(input, "b") })),
    lookup_order: plain("lookup_order", input => lookupOrder(stringField(input, "orderId"))),
    // A workflow tool may use durable operations: it suspends on a callback until someone answers.
    issue_refund: {
      workflow: async (input, { durable, idempotencyKey, call: { id: toolUseId } }) => {
        const orderId = stringField(input, "orderId");
        const amount = numberField(input, "amount");
        if (amount <= 0) throw new Error("amount must be positive");
        const reason = { action: "issue_refund", orderId, amount };
        const answer = await durable.signal<{ approved?: unknown } | null>("approval", async callbackId => {
          await requestApproval({ callbackId, interrupt: { id: toolUseId, name: "approval", reason } });
          await channel.publish({ kind: "tool", tool: "issue_refund", toolUseId, status: "interrupted", result: reason });
        }, { timeout: { minutes: 30 } }); // below DurableConfig.ExecutionTimeout in template.yaml
        return durable.step("complete", async () => {
          const output = answer?.approved === true ? issueRefund(orderId, amount, idempotencyKey) : { status: "rejected", orderId };
          await channel.publish({ kind: "tool", tool: "issue_refund", toolUseId, status: "success", result: output });
          return output;
        });
      },
    },
  };
}

/**
 * One Bedrock ConverseStream call, mirrored to the browser. Runs inside the model step, so a replay publishes
 * nothing, and every retried attempt starts over with a new `attempt` ID that replaces the earlier text.
 */
async function* converse(messages: Message[], channel: ChatChannel, call: number): AsyncIterable<ConverseStreamOutput> {
  const attempt = crypto.randomUUID();
  // Live events are chained, not awaited: they stay in order and the stream never waits for AppSync.
  let published = channel.publish({ kind: "model_start", call, attempt });
  let pending = "";
  let lastFlush = 0;
  const flush = () => {
    if (!pending) return;
    const text = pending;
    pending = "";
    lastFlush = Date.now();
    published = published.then(() => channel.publish({ kind: "text", call, attempt, text }));
  };

  const response = await bedrock.send(new ConverseStreamCommand({
    modelId,
    system: [{ text: SYSTEM_PROMPT }],
    messages,
    toolConfig: { tools: TOOL_SPECS },
    inferenceConfig: { maxTokens: 2048 },
  }));
  if (!response.stream) throw new Error("Bedrock returned no stream");
  for await (const event of response.stream) {
    const text = event.contentBlockDelta?.delta?.text;
    if (text) {
      pending += text;
      if (Date.now() - lastFlush >= TEXT_FLUSH_MS) flush();
    }
    yield event;
  }
  flush();
  await published;
}

/** Rebuilds the assistant message from the recorded stream events. */
function assemble(events: ConverseStreamOutput[]): { message: Message; stopReason?: StopReason } {
  const blocks = new Map<number, { text: string; toolUse?: { toolUseId: string; name: string; input: string } }>();
  const block = (index = 0) => blocks.get(index) ?? blocks.set(index, { text: "" }).get(index)!;
  let stopReason: StopReason | undefined;
  for (const event of events) {
    const start = event.contentBlockStart?.start?.toolUse;
    if (start) block(event.contentBlockStart!.contentBlockIndex).toolUse = { toolUseId: start.toolUseId!, name: start.name!, input: "" };
    const delta = event.contentBlockDelta;
    if (delta?.delta?.text) block(delta.contentBlockIndex).text += delta.delta.text;
    if (delta?.delta?.toolUse?.input) block(delta.contentBlockIndex).toolUse!.input += delta.delta.toolUse.input;
    if (event.messageStop) stopReason = event.messageStop.stopReason;
  }
  const content = [...blocks.entries()].sort(([a], [b]) => a - b).flatMap(([, value]): ContentBlock[] => {
    if (value.toolUse) {
      const { toolUseId, name, input } = value.toolUse;
      return [{ toolUse: { toolUseId, name, input: JSON.parse(input || "{}") } }];
    }
    return value.text ? [{ text: value.text }] : []; // Bedrock rejects blank text blocks in the next request
  });
  return { message: { role: "assistant", content }, stopReason };
}

function toolResultMessage(results: ToolResult[]): Message {
  return {
    role: "user",
    content: results.map(result => ({
      toolResult: {
        toolUseId: result.id,
        status: result.status === "ok" ? "success" : "error",
        content: [{ text: result.status === "ok" ? JSON.stringify(result.output) : result.error }],
      },
    })),
  };
}

type Loop = {
  channel: ChatChannel;
  tools: Record<string, Tool>;
  /** Runs once after the first model call; the smoke test's replay probe. */
  afterFirstModelCall?: () => Promise<void>;
};

/** The agent loop. Code outside steps runs again on every replay and must make the same calls in the same order. */
async function agent(durable: Durable, messages: Message[], { channel, tools, afterFirstModelCall }: Loop): Promise<StopReason | undefined> {
  for (let turn = 1; turn <= MAX_TURNS; turn++) {
    // One model call is one step. A replay returns the recorded events and does not call Bedrock.
    const events = await model(durable, `model-${turn}`, () => converse(messages, channel, turn));
    if (turn === 1) await afterFirstModelCall?.();
    const { message, stopReason } = assemble(events);
    messages.push(message);
    const calls: ToolCall[] = (message.content ?? []).flatMap(block => block.toolUse
      ? [{ id: block.toolUse.toolUseId!, name: block.toolUse.name!, input: block.toolUse.input }]
      : []);
    if (calls.length === 0) return stopReason;
    // Tool calls run concurrently, each in its own scope named `tools-<turn>:<toolUseId>`.
    messages.push(toolResultMessage(await runTools(durable, `tools-${turn}`, calls, tools)));
  }
  throw new Error(`No final answer after ${MAX_TURNS} turns`);
}

export const handler = withDurableExecution(async (request: WorkerRequest, context: DurableContext) => {
  validate(request);
  const { userId, conversationId, runId, baseSeq, text } = request;
  const channel = new ChatChannel(publisher, userId, conversationId, runId);
  const durable = lambda(context);
  try {
    // Outside any step on purpose: every invocation rebuilds the same history, because this run writes only
    // seqs above baseSeq and no other run can start while it is active.
    const history: Message[] = (await loadMessages(conversationId, baseSeq))
      .map(message => ({ role: message.role, content: message.content as ContentBlock[] }));

    await durable.step("publish-started", () => channel.publish({ kind: "run_started" }));

    const messages: Message[] = [...history, { role: "user", content: [{ text }] }];
    const stopReason = await agent(durable, messages, {
      channel,
      // Runs inside the callback's submitter step: plain calls only, and safe to repeat.
      tools: shopTools(channel, async pending => {
        if (!await setPendingApproval(userId, conversationId, runId, pending)) {
          console.warn(JSON.stringify({ message: "Run is no longer active; approval not recorded", runId }));
        }
        await channel.publish({ kind: "approval", ...pending });
      }),
      // Smoke test: suspend for 2 s; the next invocation replays model-1 from its checkpoint.
      afterFirstModelCall: request.replayProbe === true ? () => context.wait("replay-after-model", { seconds: 2 }) : undefined,
    });

    const saved = await durable.step("save-conversation", () => completeRun({
      userId, conversationId, runId, baseSeq, text,
      messages: messages.slice(history.length).map(({ role, content }) => ({ role: role as ChatMessage["role"], content: content ?? [] })),
    }));
    await durable.step("publish-done", () => channel.publish({ kind: "done" }));
    return { runId, stopReason, ...saved };
  } catch (error) {
    // Only real failures land here: suspension (waits, callbacks) never settles the handler's promise.
    const message = error instanceof Error ? error.message : String(error);
    try {
      await failRun(userId, conversationId, runId, message);
    } catch (storeError) {
      console.error(JSON.stringify({ message: "Could not mark the run failed", runId, error: String(storeError) }));
    }
    await channel.publish({ kind: "failed", error: message });
    throw error;
  }
});
