// One chat run: a Strands agent on a Lambda durable function. Every model call and tool use is a durable step;
// a refund waits for human approval on a durable callback without holding compute.
import { S3Client } from "@aws-sdk/client-s3";
import { withDurableExecution, type DurableContext } from "@aws/durable-execution-sdk-js";
import {
  Agent, BedrockModel, NullConversationManager, tool,
  type Message, type MessageData, type Model, type ModelStreamEvent, type StreamOptions,
} from "@strands-agents/sdk";
import {
  createOffloadSerdes, currentToolExecution, DurableModel, DurableTool, DurableToolExecutor, invokeDurably,
  type DurableModelOptions,
} from "strands-lambda-durable-functions";
import { s3OffloadStore } from "strands-lambda-durable-functions/s3";
import { z } from "zod";
import { AppSyncPublisher, ChatChannel } from "./appsync.js";
import { completeRun, failRun, loadMessages, setPendingApproval } from "./store.js";
import {
  issueRefund as refund, lookupOrder as findOrder, requireEnv, SYSTEM_PROMPT, TOOL_DESCRIPTIONS, validate,
  type WorkerRequest,
} from "./worker-common.js";

const addNumbers = tool({
  name: "add_numbers",
  description: TOOL_DESCRIPTIONS.add_numbers,
  inputSchema: z.object({ a: z.number(), b: z.number() }),
  callback: ({ a, b }) => ({ sum: a + b }),
});

const lookupOrder = tool({
  name: "lookup_order",
  description: TOOL_DESCRIPTIONS.lookup_order,
  inputSchema: z.object({ orderId: z.string().describe("注文ID。例: A-1001") }),
  callback: ({ orderId }) => findOrder(orderId),
});

// Human approval: the tool raises a Strands interrupt; invokeDurably suspends on a durable callback until
// someone answers, then resumes this tool use with the answer ({ approved: boolean }).
const issueRefund = tool({
  name: "issue_refund",
  description: TOOL_DESCRIPTIONS.issue_refund,
  inputSchema: z.object({ orderId: z.string(), amount: z.number().positive().describe("返金額 (円)") }),
  callback: ({ orderId, amount }, toolContext) => {
    const decision = toolContext!.interrupt({ name: "approval", reason: { action: "issue_refund", orderId, amount } });
    const approved = typeof decision === "object" && decision !== null && "approved" in decision && decision.approved === true;
    if (!approved) return { status: "rejected", orderId };
    return refund(orderId, amount, currentToolExecution().idempotencyKey);
  },
});

/**
 * Smoke-test probe: after the first model call's step completes, suspends on a 2-second durable wait. The next
 * invocation replays the model step from its checkpoint instead of calling Bedrock again.
 */
class ReplayProbeModel extends DurableModel {
  private waited = false;

  constructor(source: Model, private readonly probeContext: DurableContext, options: DurableModelOptions) {
    super(source, probeContext, options);
  }

  override async *stream(messages: Message[], options?: StreamOptions): AsyncIterable<ModelStreamEvent> {
    const events = super.stream(messages, options)[Symbol.asyncIterator]();
    // DurableModel completes (or replays) the model step before it yields the first event.
    let next = await events.next();
    if (!this.waited) {
      this.waited = true;
      await this.probeContext.wait("replay-after-model", { seconds: 2 });
    }
    for (; !next.done; next = await events.next()) yield next.value;
  }
}

const region = requireEnv("AWS_REGION");
const modelId = requireEnv("BEDROCK_MODEL_ID");
const s3 = new S3Client({});
const serdes = createOffloadSerdes({ store: s3OffloadStore({ client: s3, bucket: requireEnv("OFFLOAD_BUCKET"), prefix: "checkpoints/" }) });
const publisher = new AppSyncPublisher(requireEnv("EVENTS_HTTP_DOMAIN"), region);

export const handler = withDurableExecution(async (request: WorkerRequest, context: DurableContext) => {
  validate(request);
  const { userId, conversationId, runId, baseSeq, text } = request;
  const channel = new ChatChannel(publisher, userId, conversationId, runId);
  try {
    // Outside any step on purpose: every invocation rebuilds the same history, because this run writes only
    // seqs above baseSeq and no other run can start while it is active.
    const history: MessageData[] = (await loadMessages(conversationId, baseSeq))
      .map(message => ({ role: message.role, content: message.content as MessageData["content"] }));

    await context.step("publish-started", async () => {
      await channel.publish({ kind: "run_started" });
      return true;
    });

    // A fresh model, tool wrappers and agent per invocation: their call counters must start from zero on replay.
    const live = { events: channel, serdes };
    const bedrock = new BedrockModel({ region, modelId, maxTokens: 2048, stream: true });
    const agent = new Agent({
      model: request.replayProbe === true ? new ReplayProbeModel(bedrock, context, live) : new DurableModel(bedrock, context, live),
      tools: [addNumbers, lookupOrder, issueRefund].map(source => new DurableTool(source, context, live)),
      toolExecutor: new DurableToolExecutor(context, { serdes }),
      messages: history,
      // The run's new messages are agent.messages.slice(history.length), so history must not be trimmed.
      conversationManager: new NullConversationManager(),
      retryStrategy: null,
      printer: false,
      systemPrompt: SYSTEM_PROMPT,
    });

    const result = await invokeDurably(agent, context, text, {
      invokeOptions: { limits: { turns: 8 } },
      // Runs inside the callback's submitter step: plain calls only, and safe to repeat.
      onInterrupt: async pending => {
        if (!await setPendingApproval(userId, conversationId, runId, pending)) {
          console.warn(JSON.stringify({ message: "Run is no longer active; approval not recorded", runId }));
        }
        await channel.publish({ kind: "approval", ...pending });
      },
      interruptTimeout: { minutes: 30 }, // below DurableConfig.ExecutionTimeout in template.yaml
    });

    const saved = await context.step("save-conversation", () => completeRun({
      userId, conversationId, runId, baseSeq, text,
      messages: agent.messages.slice(history.length).map(message => {
        const { role, content } = message.toJSON();
        return { role, content };
      }),
    }));
    await context.step("publish-done", async () => {
      await channel.publish({ kind: "done" });
      return true;
    });
    return { runId, stopReason: result.stopReason, ...saved };
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
