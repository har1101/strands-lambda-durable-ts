import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { withDurableExecution, type DurableContext } from "@aws/durable-execution-sdk-js";
import { LocalDurableTestRunner, WaitingOperationStatus } from "@aws/durable-execution-sdk-js-testing";
import * as z from "zod";
import {
  agent, RetryableError, tool, ToolError,
  type AgentConfig, type LiveEvent, type Message, type Model, type ModelResponse, type RunInput, type Tool,
} from "../src/index.js";

const REDACTED = new Uint8Array([0, 1, 2, 250, 255]);

type Use = { name: string; input: Record<string, unknown> };

/** Turn 1 requests `uses` (with redacted reasoning bytes); later turns answer with the tool results they saw. */
function scripted(counter: { model: number }, uses: Use[]): Model {
  return async (request, { onDelta }) => {
    counter.model++;
    const results = request.messages.flatMap(m => m.content).flatMap(b => "toolResult" in b ? [b.toolResult] : []);
    if (results.length === 0 && uses.length > 0) {
      return {
        stopReason: "tool_use",
        message: {
          role: "assistant",
          content: [
            { reasoningContent: { redactedContent: REDACTED } },
            ...uses.map((use, i) => ({ toolUse: { toolUseId: `tu-${i + 1}`, name: use.name, input: use.input as never } })),
          ],
        },
        usage: { inputTokens: 10, outputTokens: 5 },
      };
    }
    const text = JSON.stringify(results.map(r => ({ id: r.toolUseId, status: r.status, content: r.content })));
    onDelta({ type: "text", text });
    return { stopReason: "end_turn", message: { role: "assistant", content: [{ text }] }, usage: { inputTokens: 20, outputTokens: 7 } };
  };
}

type Setup = { uses?: Use[]; tools?: Tool[]; realTime?: boolean; config?: Partial<AgentConfig>; input?: Partial<RunInput> };

async function setup({ uses = [], tools = [], realTime = false, config = {}, input = {} }: Setup) {
  await LocalDurableTestRunner.setupTestEnvironment({ skipTime: !realTime });
  const counter = { model: 0, invocations: 0 };
  const events: LiveEvent[] = [];
  // Defined once, outside the handler: an agent definition carries no per-run state, so warm reuse is safe.
  const bot = agent({ model: scripted(counter, uses), tools, system: "test", ...config });
  const handler = withDurableExecution(async (_: unknown, context: DurableContext) => {
    counter.invocations++;
    const result = await bot.run(context, { prompt: "go", events: e => { events.push(e); }, ...input });
    const content = result.messages.flatMap(m => m.content);
    const reasoning = content.find(b => "reasoningContent" in b);
    const bytes = content.flatMap(b => "toolResult" in b ? b.toolResult.content : []).find(c => "json" in c && c.json && typeof c.json === "object" && "bytes" in c.json);
    return {
      text: result.text,
      stopReason: result.stopReason,
      usage: result.usage,
      messages: result.messages,
      newMessages: result.newMessages,
      redactedIsBytes: reasoning !== undefined && "reasoningContent" in reasoning && reasoning.reasoningContent.redactedContent instanceof Uint8Array,
      toolBytes: bytes && "json" in bytes && bytes.json && typeof bytes.json === "object" && "bytes" in bytes.json && (bytes.json.bytes as unknown) instanceof Uint8Array,
    };
  });
  return { counter, events, runner: new LocalDurableTestRunner({ handlerFunction: handler }) };
}

afterEach(() => LocalDurableTestRunner.teardownTestEnvironment());

test("parallel tools keep their tool use mapping and nothing completed reruns after suspension", async () => {
  const calls: string[] = [];
  const slow = tool({ name: "slow", description: "", input: z.object({}), run: async () => { calls.push("slow"); await sleep(300); return { who: "slow" }; } });
  const fast = tool({ name: "fast", description: "", input: z.object({}), run: () => { calls.push("fast"); return { who: "fast" }; } });
  // Forces the invocation to end; the rest of the run replays in a new invocation. Its binary result crosses the checkpoint.
  const pause = tool({
    name: "pause", description: "", input: z.object({}),
    workflow: async (_, ctx) => { await ctx.wait("pause", { seconds: 1 }); return { bytes: new Uint8Array([7, 8]) }; },
  });
  const { counter, events, runner } = await setup({
    uses: [{ name: "slow", input: {} }, { name: "fast", input: {} }, { name: "pause", input: {} }], tools: [slow, fast, pause], realTime: true,
  });

  const execution = await runner.run({ payload: {} });

  assert.equal(execution.getStatus(), "SUCCEEDED");
  assert.ok(counter.invocations >= 2, "the wait must end the first invocation");
  assert.equal(counter.model, 2, "model-1 is replayed from the journal");
  assert.deepEqual(calls.sort(), ["fast", "slow"], "completed tools do not rerun on replay");
  const result = execution.getResult()!;
  const seen = JSON.parse(result.text);
  assert.deepEqual(seen.slice(0, 2), [
    { id: "tu-1", status: "success", content: [{ json: { who: "slow" } }] },
    { id: "tu-2", status: "success", content: [{ json: { who: "fast" } }] },
  ]);
  assert.equal(seen[2].id, "tu-3");
  assert.equal(result.redactedIsBytes, true, "binary model output survives the checkpoint");
  assert.equal(result.toolBytes, true, "binary workflow results survive the checkpoint");
  assert.deepEqual(result.usage, { inputTokens: 30, outputTokens: 12 });
  const names = execution.getOperations().map(op => op.getName());
  // One operation per tool use, opened in tool use order before any tool body starts.
  assert.deepEqual(names.slice(0, 4), ["model-1", "tool-1-0", "tool-1-1", "tool-1-2"]);
  assert.equal(names.at(-1), "model-2");
  assert.equal(names.filter(name => name === "notify").length, 1, "only the workflow tool needs a notify step");
  assert.equal(events.filter(e => e.type === "model_start").length, 2, "live events come from live steps only");
  assert.equal(events.filter(e => e.type === "tool_end").length, 3);
});

test("a workflow tool waits for human approval on a durable callback", async () => {
  let prepared = 0;
  let callbackId: string | undefined;
  const refund = tool({
    name: "refund",
    description: "",
    input: z.object({ amount: z.number() }),
    workflow: async ({ amount }, ctx, call) => {
      await ctx.step("prepare", async () => { prepared++; return null; });
      const raw = await ctx.waitForCallback("approval", async id => { callbackId = id; }, { timeout: { minutes: 5 } });
      const { approved } = JSON.parse(raw) as { approved: boolean };
      if (!approved) return { status: "rejected" };
      return await ctx.step("issue", async () => ({ status: "issued", amount, key: call.idempotencyKey.split("#").slice(1).join("#") }));
    },
  });
  const { counter, runner } = await setup({ uses: [{ name: "refund", input: { amount: 1200 } }], tools: [refund], realTime: true });

  const running = runner.run({ payload: {} });
  const callback = runner.getOperation("approval");
  await callback.waitForData(WaitingOperationStatus.SUBMITTED);
  assert.ok(callbackId);
  await sleep(200); // let the idle invocation end, so the answer is handled by a replaying invocation
  await callback.sendCallbackSuccess(JSON.stringify({ approved: true }));
  const execution = await running;

  assert.equal(execution.getStatus(), "SUCCEEDED");
  assert.ok(counter.invocations >= 2);
  assert.equal(counter.model, 2);
  assert.equal(prepared, 1, "work before the wait is not repeated");
  assert.deepEqual(JSON.parse(execution.getResult()!.text)[0].content, [{ json: { status: "issued", amount: 1200, key: "tool-1-0#tu-1" } }]);
});

test("a callback timeout becomes an error result", async () => {
  const approval = tool({
    name: "approval", description: "", input: z.object({}),
    workflow: async (_, ctx) => await ctx.waitForCallback("approval", async () => {}, { timeout: { seconds: 1 } }),
  });
  const { runner } = await setup({ uses: [{ name: "approval", input: {} }], tools: [approval], realTime: true });

  const execution = await runner.run({ payload: {} });

  assert.equal(execution.getStatus(), "SUCCEEDED");
  const [result] = JSON.parse(execution.getResult()!.text);
  assert.equal(result.status, "error");
});

test("run tools: retryable errors retry with one idempotency key; others become error results", async () => {
  const keys: string[] = [];
  let flakyCalls = 0;
  let brokenCalls = 0;
  let validatedCalls = 0;
  const flaky = tool({
    name: "flaky", description: "", input: z.object({}),
    run: (_, call) => { flakyCalls++; keys.push(call.idempotencyKey); if (call.attempt === 1) throw new RetryableError("503"); return { attempt: call.attempt }; },
  });
  const broken = tool({ name: "broken", description: "", input: z.object({}), run: () => { brokenCalls++; throw new Error("downstream rejected"); } });
  const strict = tool({ name: "strict", description: "", input: z.object({ n: z.number() }), run: () => { validatedCalls++; return 1; } });
  const { runner } = await setup({
    uses: [{ name: "flaky", input: {} }, { name: "broken", input: {} }, { name: "strict", input: { n: "x" } }, { name: "missing", input: {} }],
    tools: [flaky, broken, strict],
  });

  const execution = await runner.run({ payload: {} });

  assert.equal(execution.getStatus(), "SUCCEEDED");
  assert.equal(flakyCalls, 2);
  assert.equal(new Set(keys).size, 1);
  assert.equal(brokenCalls, 1, "an ordinary error is not retried");
  assert.equal(validatedCalls, 0, "invalid input never reaches the tool");
  const [flakyResult, brokenResult, strictResult, missingResult] = JSON.parse(execution.getResult()!.text);
  assert.deepEqual(flakyResult.content, [{ json: { attempt: 2 } }]);
  assert.equal(brokenResult.status, "error");
  assert.match(brokenResult.content[0].text, /downstream rejected/);
  assert.equal(strictResult.status, "error");
  assert.match(strictResult.content[0].text, /Invalid input/);
  assert.match(missingResult.content[0].text, /Unknown tool: missing/);
});

test("workflow tools: ToolError is a result, a bug fails the run", async () => {
  const rejecting = tool({ name: "rejecting", description: "", input: z.object({}), workflow: async () => { throw new ToolError("no such customer"); } });
  const ok = await setup({ uses: [{ name: "rejecting", input: {} }], tools: [rejecting] });
  const handled = await ok.runner.run({ payload: {} });
  assert.equal(handled.getStatus(), "SUCCEEDED");
  assert.match(JSON.parse(handled.getResult()!.text)[0].content[0].text, /no such customer/);
  await LocalDurableTestRunner.teardownTestEnvironment();

  const buggy = tool({ name: "buggy", description: "", input: z.object({}), workflow: async () => { throw new TypeError("x is undefined"); } });
  const bad = await setup({ uses: [{ name: "buggy", input: {} }], tools: [buggy] });
  const crashed = await bad.runner.run({ payload: {} });
  assert.equal(crashed.getStatus(), "FAILED");
  assert.equal(bad.counter.model, 1, "the model never sees a result produced by a bug");
});

test("a sub-agent runs inside a workflow tool's child context; its model failure fails the run", async () => {
  const inner = { model: 0 };
  const sub = agent({ model: scripted(inner, []), system: "sub" });
  const delegate = tool({
    name: "delegate", description: "", input: z.object({ task: z.string() }),
    workflow: async ({ task }, ctx) => (await sub.run(ctx, { prompt: task, name: "sub" })).text,
  });
  const { counter, runner } = await setup({ uses: [{ name: "delegate", input: { task: "t" } }], tools: [delegate] });
  const execution = await runner.run({ payload: {} });
  assert.equal(execution.getStatus(), "SUCCEEDED");
  assert.equal(counter.model + inner.model, 3);
  const byId = new Map(execution.getOperations().map(op => [op.getId(), op.getName()]));
  const parents = execution.getOperations().map(op => `${byId.get(op.getParentId()) ?? "-"}>${op.getName()}`);
  assert.ok(parents.includes("tool-1-0>sub:model-1"), parents.join(" "));
  await LocalDurableTestRunner.teardownTestEnvironment();

  const failing = agent({ model: async () => { throw new Error("ValidationException: bad request"); }, system: "sub" });
  const delegateFailing = tool({
    name: "delegate", description: "", input: z.object({}),
    workflow: async (_, ctx) => (await failing.run(ctx, { prompt: "t", name: "sub" })).text,
  });
  const second = await setup({ uses: [{ name: "delegate", input: {} }], tools: [delegateFailing] });
  const failed = await second.runner.run({ payload: {} });
  assert.equal(failed.getStatus(), "FAILED");
  assert.equal(second.counter.model, 1);
});

test("max_turns: pending tool uses get error results without running, and the next prompt merges into that message", async () => {
  let runs = 0;
  const counted = tool({ name: "count", description: "", input: z.object({}), run: () => { runs++; return 1; } });
  const first = await setup({ uses: [{ name: "count", input: {} }], tools: [counted], config: { maxTurns: 1 } });
  const execution = await first.runner.run({ payload: {} });
  const result = execution.getResult()!;
  assert.equal(result.stopReason, "max_turns");
  assert.equal(runs, 0);
  const last = result.messages.at(-1) as Message;
  assert.equal(last.role, "user");
  assert.match(JSON.stringify(last.content), /turn limit/);
  await LocalDurableTestRunner.teardownTestEnvironment();

  const history: Message[] = result.messages;
  const second = await setup({ config: { maxTurns: 2 }, input: { messages: history, prompt: "continue" } });
  const next = (await second.runner.run({ payload: {} })).getResult()!;
  const roles = next.messages.map((m: Message) => m.role).join(",");
  assert.equal(roles, "user,assistant,user,assistant", "roles alternate");
  assert.equal(next.newMessages.length, 2, "the merged user message replaces the history's last message");
  assert.match(JSON.stringify(next.newMessages[0]), /turn limit.*continue/);
});

test("max_tokens: cut-off tool uses are dropped and empty messages are not stored", async () => {
  await LocalDurableTestRunner.setupTestEnvironment({ skipTime: true });
  const responses: ModelResponse[] = [
    { stopReason: "max_tokens", message: { role: "assistant", content: [{ text: "partial" }, { toolUse: { toolUseId: "t", name: "x", input: {} } }] } },
    { stopReason: "guardrail_intervened", message: { role: "assistant", content: [] } },
  ];
  for (const response of responses) {
    const bot = agent({ model: async () => response });
    const runner = new LocalDurableTestRunner({ handlerFunction: withDurableExecution(async (_: unknown, ctx: DurableContext) => (await bot.run(ctx, { prompt: "go" })).messages) });
    const messages = (await runner.run({ payload: {} })).getResult() as Message[];
    assert.ok(!JSON.stringify(messages).includes("toolUse"));
    assert.ok(messages.every(m => m.content.length > 0));
  }
});

test("a failing event sink neither fails nor retries the run", async () => {
  const { counter, runner } = await setup({
    uses: [{ name: "echo", input: {} }],
    tools: [tool({ name: "echo", description: "", input: z.object({}), workflow: async () => "ok" })],
    input: { events: () => { throw new Error("socket closed: timed out"); } },
  });
  const execution = await runner.run({ payload: {} });
  assert.equal(execution.getStatus(), "SUCCEEDED");
  assert.equal(counter.model, 2, "no model retry");
});

test("history messages are passed through as a snapshot", async () => {
  await LocalDurableTestRunner.setupTestEnvironment({ skipTime: true });
  const seen: Message[][] = [];
  const bot = agent({ model: async request => { seen.push(request.messages); return { stopReason: "end_turn", message: { role: "assistant", content: [{ text: "ok" }] } }; } });
  const history: Message[] = [{ role: "user", content: [{ text: "hi" }] }, { role: "assistant", content: [{ text: "hello" }] }];
  const runner = new LocalDurableTestRunner({ handlerFunction: withDurableExecution(async (_: unknown, ctx: DurableContext) => (await bot.run(ctx, { messages: history, prompt: "again" })).newMessages) });
  const execution = await runner.run({ payload: {} });
  assert.deepEqual(execution.getResult(), [{ role: "user", content: [{ text: "again" }] }, { role: "assistant", content: [{ text: "ok" }] }]);
  assert.equal(seen[0].length, 3, "later appends do not leak into an earlier request");
});
