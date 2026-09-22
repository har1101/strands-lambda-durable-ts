import { randomUUID } from "node:crypto";
import { Agent, BedrockModel, tool } from "@strands-agents/sdk";
import { withDurableExecution, type DurableContext } from "@aws/durable-execution-sdk-js";
import { z } from "zod";
import { DurableModel, DurableTool } from "./durable-strands.js";
import { EventWriter } from "./events.js";

type Request = { runId: string; prompt: string; replayProbe?: boolean };

export const handler = withDurableExecution(async (request: Request, context: DurableContext) => {
  if (!request.runId || !/^[a-zA-Z0-9-]{1,80}$/.test(request.runId)) throw new Error("Invalid runId");
  if (!request.prompt || request.prompt.length > 2000) throw new Error("Invalid prompt");
  const table = process.env.EVENTS_TABLE;
  if (!table) throw new Error("EVENTS_TABLE is required");
  const events = new EventWriter(request.runId, table);
  const model = new DurableModel(
    new BedrockModel({
      region: process.env.AWS_REGION,
      modelId: process.env.BEDROCK_MODEL_ID ?? "amazon.nova-lite-v1:0",
      maxTokens: 256,
      stream: true,
    }),
    context,
    events,
    request.replayProbe === true,
  );
  const addNumbers = tool({
    name: "add_numbers",
    description: "Add two numbers accurately. Use this tool when the user asks for a sum.",
    inputSchema: z.object({ a: z.number(), b: z.number() }),
    callback: ({ a, b }) => ({ sum: a + b, calculationId: randomUUID() }),
  });
  const agent = new Agent({
    model,
    tools: [new DurableTool(addNumbers, context, events)],
    toolExecutor: "sequential",
    retryStrategy: null,
    printer: false,
    systemPrompt: "You are a concise assistant. For arithmetic, call add_numbers before answering. Answer in the user's language. Output only user-facing text; do not emit thinking tags.",
  });

  try {
    const result = await agent.invoke(request.prompt, { limits: { turns: 4 } });
    const answer = result.toString().replace(/<thinking>[\s\S]*?<\/thinking>\s*/g, "").trim();
    const output = { runId: request.runId, stopReason: result.stopReason, answer };
    await context.step("publish-done", async () => {
      await events.put({ kind: "done", result: output });
      return true;
    });
    return output;
  } catch (error) {
    // A failed attempt can replay. The event is advisory; Lambda remains the source of execution status.
    try {
      await events.put({ kind: "failed", text: error instanceof Error ? error.message : String(error) });
    } catch { /* preserve the original error */ }
    throw error;
  }
});
