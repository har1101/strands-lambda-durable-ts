// One chat run: a Strands agent on a Lambda durable function. Every model call and tool use is a durable step;
// a refund waits for human approval on a durable callback without holding compute.
import { createHash } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
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

export type WorkerRequest = {
  userId: string;
  conversationId: string;
  runId: string;
  /** Messages with seq <= baseSeq are the history; this run's messages are stored after it. */
  baseSeq: number;
  text: string;
  /** Smoke test: suspend for 2 s after the first model call so the rest of the run replays in a new invocation. */
  replayProbe?: boolean;
};

const SYSTEM_PROMPT = [
  "あなたはオンラインストアのサポートアシスタントです。ユーザーと同じ言語で、簡潔に答えてください。",
  "注文の確認には lookup_order を使います。複数の注文など互いに独立した照会は、1回の応答でまとめて並列に呼び出してください。",
  "返金には必ず issue_refund を呼び出してください。担当者の承認後に実行されます。結果の status と refundId を伝えてください。",
  "計算には add_numbers を使ってください。",
  "ユーザー向けの本文だけを出力し、<thinking> などの内部タグは出力しないでください。",
].join("\n");

type Order = {
  status: string;
  amount: number;
  currency: string;
  orderedAt: string;
  items: { name: string; quantity: number; price: number }[];
};

/** Fake order data; stands in for a real order API. */
const ORDERS: Record<string, Order> = {
  "A-1001": {
    status: "delivered", amount: 12800, currency: "JPY", orderedAt: "2026-08-02",
    items: [{ name: "ワイヤレスイヤホン", quantity: 1, price: 9800 }, { name: "充電ケーブル", quantity: 2, price: 1500 }],
  },
  "B-2002": {
    status: "shipped", amount: 4500, currency: "JPY", orderedAt: "2026-09-15",
    items: [{ name: "ステンレスボトル", quantity: 1, price: 4500 }],
  },
  "C-3003": {
    status: "processing", amount: 23600, currency: "JPY", orderedAt: "2026-09-21",
    items: [{ name: "デスクライト", quantity: 1, price: 18600 }, { name: "電球", quantity: 2, price: 2500 }],
  },
};

const addNumbers = tool({
  name: "add_numbers",
  description: "2つの数値を正確に足し算します。合計を答えるときに使います。",
  inputSchema: z.object({ a: z.number(), b: z.number() }),
  callback: ({ a, b }) => ({ sum: a + b }),
});

const lookupOrder = tool({
  name: "lookup_order",
  description: "注文ID (例: A-1001) から注文のステータス、金額、商品を取得します。",
  inputSchema: z.object({ orderId: z.string().describe("注文ID。例: A-1001") }),
  callback: async ({ orderId }) => {
    await sleep(500); // latency of a real order API; makes parallel tool execution visible
    const order = ORDERS[orderId.trim().toUpperCase()];
    return order ? { found: true, orderId, ...order } : { found: false, orderId };
  },
});

// Human approval: the tool raises a Strands interrupt; invokeDurably suspends on a durable callback until
// someone answers, then resumes this tool use with the answer ({ approved: boolean }).
const issueRefund = tool({
  name: "issue_refund",
  description: "注文の返金を実行します。すべての返金は担当者の承認が必要です。呼び出して結果を報告してください。",
  inputSchema: z.object({ orderId: z.string(), amount: z.number().positive().describe("返金額 (円)") }),
  callback: ({ orderId, amount }, toolContext) => {
    const decision = toolContext!.interrupt({ name: "approval", reason: { action: "issue_refund", orderId, amount } });
    const approved = typeof decision === "object" && decision !== null && "approved" in decision && decision.approved === true;
    if (!approved) return { status: "rejected", orderId };
    // A real payment API would receive this key, so a retried or replayed call cannot refund twice.
    const { idempotencyKey } = currentToolExecution();
    const refundId = `rf-${createHash("sha256").update(idempotencyKey).digest("hex").slice(0, 12)}`;
    return { status: "issued", orderId, amount, refundId };
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

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function validate(request: WorkerRequest): void {
  if (typeof request.userId !== "string" || !/^[A-Za-z0-9-]{1,50}$/.test(request.userId)) throw new Error("Invalid userId");
  if (typeof request.conversationId !== "string" || !UUID.test(request.conversationId)) throw new Error("Invalid conversationId");
  if (typeof request.runId !== "string" || !UUID.test(request.runId)) throw new Error("Invalid runId");
  if (!Number.isInteger(request.baseSeq) || request.baseSeq < 0) throw new Error("Invalid baseSeq");
  if (typeof request.text !== "string" || request.text.length < 1 || request.text.length > 4000) throw new Error("Invalid text");
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
