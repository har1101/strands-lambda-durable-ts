// Live check against Bedrock (us-east-1). Not a unit test. Run one case per process (a second
// setupTestEnvironment in the same process hung in the spike):
//   ONLY=plain AWS_REGION=us-east-1 npm run live
//   REPLAY=1 ONLY=thinking AWS_REGION=us-east-1 npm run live
import { withDurableExecution, type DurableContext } from "@aws/durable-execution-sdk-js";
import { LocalDurableTestRunner } from "@aws/durable-execution-sdk-js-testing";
import * as z from "zod";
import { bedrock } from "../src/bedrock.js";
import { agent, compose, tool, type LiveEvent, type Model } from "../src/index.js";

const modelId = process.env.BEDROCK_MODEL_ID ?? "us.anthropic.claude-haiku-4-5-20251001-v1:0";
const ORDERS: Record<string, { amount: number }> = { "A-1001": { amount: 1200 }, "A-1002": { amount: 3400 } };

// REPLAY=1: the lookup waits durably first, so the invocation ends and the rest of the run replays, including
// model-1's recorded message (with its reasoning signature when thinking is on) sent back to Bedrock.
const replay = process.env.REPLAY === "1";
const lookupOrder = replay
  ? tool({
    name: "lookup_order",
    description: "Look up an order by ID (for example A-1001) and return its amount in JPY.",
    input: z.object({ orderId: z.string() }),
    workflow: async ({ orderId }, ctx) => {
      await ctx.wait("lookup-latency", { seconds: 1 });
      return await ctx.step("fetch", async () => ORDERS[orderId] ?? { error: "not found" });
    },
  })
  : tool({
    name: "lookup_order",
    description: "Look up an order by ID (for example A-1001) and return its amount in JPY.",
    input: z.object({ orderId: z.string() }),
    run: ({ orderId }) => ORDERS[orderId] ?? { error: "not found" },
  });
const add = tool({
  name: "add_numbers",
  description: "Add two numbers exactly.",
  input: z.object({ a: z.number(), b: z.number() }),
  run: ({ a, b }) => ({ sum: a + b }),
});

for (const thinking of (process.env.ONLY ? [process.env.ONLY === "thinking"] : [false, true])) {
  await LocalDurableTestRunner.setupTestEnvironment({ skipTime: !replay });
  let invocations = 0;
  let providerCalls = 0;
  // Middleware runs inside the model step: counts real provider calls only.
  const counted = (next: Model): Model => (request, onDelta) => { providerCalls++; return next(request, onDelta); };
  const bot = agent({
    model: compose(bedrock({
      modelId, region: "us-east-1",
      inferenceConfig: { maxTokens: 2048 },
      ...(thinking && { additionalModelRequestFields: { thinking: { type: "enabled", budget_tokens: 1024 } } }),
    }), counted),
    tools: [lookupOrder, add],
    system: "Use the tools. Look up both orders in parallel in one turn, then add the amounts with add_numbers. Answer briefly.",
    maxTurns: 6,
  });
  const events: LiveEvent[] = [];
  const runner = new LocalDurableTestRunner({
    handlerFunction: withDurableExecution(async (_: unknown, ctx: DurableContext) => {
      invocations++;
      const result = await bot.run(ctx, { prompt: "What is the total of orders A-1001 and A-1002?", events: e => { events.push(e); } });
      return { text: result.text, stopReason: result.stopReason, usage: result.usage, blocks: result.newMessages.map(m => `${m.role}:${m.content.map(b => Object.keys(b)[0]).join(",")}`) };
    }),
  });
  const execution = await runner.run({ payload: {} });
  console.log(JSON.stringify({
    thinking,
    status: execution.getStatus(),
    error: execution.getStatus() === "SUCCEEDED" ? undefined : execution.getError(),
    result: execution.getResult(),
    operations: execution.getOperations().map(op => op.getName()),
    providerCalls,
    invocations,
    liveEvents: events.map(e => e.type).join(","),
  }, null, 2));
  await LocalDurableTestRunner.teardownTestEnvironment();
}
