import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { withDurableExecution, type DurableContext } from "@aws/durable-execution-sdk-js";
import { LocalDurableTestRunner } from "@aws/durable-execution-sdk-js-testing";
import * as z from "zod";
import { agent, tool } from "../src/index.js";

afterEach(() => LocalDurableTestRunner.teardownTestEnvironment());

test("non-deterministic replay inside a tool fails the execution instead of becoming a tool result", async () => {
  await LocalDurableTestRunner.setupTestEnvironment({ skipTime: false });
  let invocations = 0;
  let modelCalls = 0;
  const drifting = tool({
    name: "drift", description: "", input: z.object({}),
    // The step name changes between invocations: replay must detect it.
    workflow: async (_, ctx) => { await ctx.step(`s-${invocations}`, async () => 1); await ctx.wait("w", { seconds: 1 }); return "ok"; },
  });
  const bot = agent({
    model: async request => {
      modelCalls++;
      const answered = request.messages.some(m => m.content.some(b => "toolResult" in b));
      return answered
        ? { stopReason: "end_turn", message: { role: "assistant", content: [{ text: "done" }] } }
        : { stopReason: "tool_use", message: { role: "assistant", content: [{ toolUse: { toolUseId: "t1", name: "drift", input: {} } }] } };
    },
    tools: [drifting],
  });
  const runner = new LocalDurableTestRunner({
    handlerFunction: withDurableExecution(async (_: unknown, ctx: DurableContext) => { invocations++; return (await bot.run(ctx, { prompt: "go" })).text; }),
  });
  const execution = await runner.run({ payload: {} });
  // The SDK detects the drift and fails the execution. Note (SDK 2.4.0): detection does not stop the invocation at
  // once; the tool finished and model-2 ran live before the failure was reported. Hence no assertion on model calls.
  assert.equal(execution.getStatus(), "FAILED");
  assert.equal(execution.getError()?.errorType, "NonDeterministicExecutionError");
  assert.ok(modelCalls >= 1);
});
