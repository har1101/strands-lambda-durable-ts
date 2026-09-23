import type { DurableContext } from "@aws/durable-execution-sdk-js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { WaitingOperationStatus } from "@aws/durable-execution-sdk-js-testing";
import { Agent, StateStore, tool, ToolResultBlock, type ToolContext } from "@strands-agents/sdk";
import { z } from "zod";
import { currentToolExecution, DurableModel, DurableTool, durableWorkflowTool, RetryableToolError } from "../src/index.js";
import { harness, ScriptedModel, REDACTED } from "./helpers.js";

test("a checkpointed model call is replayed, not re-invoked, after suspension", async () => {
  const { counter, runner } = await harness({ realTime: true, pauseAfterModelCall: 1 });
  const execution = await runner.run({ payload: {} });

  assert.equal(execution.getStatus(), "SUCCEEDED");
  assert.equal(counter.invocations, 2, "the wait must end the first invocation");
  assert.equal(counter.model, 2, "model-1 must come from the journal on the second invocation");
  assert.equal(counter.tool, 1);
  assert.deepEqual(execution.getOperations().map(op => op.getName()),
    ["model-1", "replay-after-model", "tool-add_numbers-1-tooluse-1", "model-2"]);
  const output = execution.getResult()!;
  assert.equal(output.stopReason, "endTurn");
  assert.equal(output.answer, "tool status success");
  assert.match(JSON.stringify(output.toolResults), /"sum":15/);
});

test("a business tool error is checkpointed once and restored without rerunning the tool", async () => {
  const { counter, runner } = await harness({
    realTime: true, pauseAfterModelCall: 2,
    add: () => { throw new Error("downstream rejected"); },
  });
  const execution = await runner.run({ payload: {} });

  assert.equal(execution.getStatus(), "SUCCEEDED");
  assert.equal(counter.invocations, 2);
  assert.equal(counter.model, 2, "both model calls are replayed from the journal");
  assert.equal(counter.tool, 1, "a non-retryable error is not retried, and replay does not rerun the tool");
  const output = execution.getResult()!;
  assert.equal(output.answer, "tool status error");
  assert.match(JSON.stringify(output.toolResults[0].content), /downstream rejected/);
});

test("RetryableToolError retries only the tool step and keeps one idempotency key", async () => {
  const keys: string[] = [];
  const { counter, runner } = await harness({
    add: ({ a, b }) => {
      const { idempotencyKey, attempt } = currentToolExecution();
      keys.push(idempotencyKey);
      if (attempt === 1) throw new RetryableToolError("503 from downstream");
      return { sum: a + b, attempt };
    },
  });
  const execution = await runner.run({ payload: {} });

  assert.equal(execution.getStatus(), "SUCCEEDED");
  assert.equal(counter.tool, 2, "one failed attempt, one successful retry");
  assert.equal(counter.model, 2, "a tool retry does not repeat the model call");
  assert.equal(new Set(keys).size, 1);
  assert.match(keys[0], /#tooluse-1$/);
  assert.match(JSON.stringify(execution.getResult()!.toolResults), /"attempt":2/);
});

test("an exhausted RetryableToolError becomes an error result instead of failing the execution", async () => {
  const { counter, runner } = await harness({
    realTime: true, pauseAfterModelCall: 2,
    add: () => { throw new RetryableToolError("still unavailable"); },
  });
  const execution = await runner.run({ payload: {} });

  assert.equal(execution.getStatus(), "SUCCEEDED");
  assert.equal(counter.tool, 3, "three attempts, and none on replay");
  const output = execution.getResult()!;
  assert.equal(output.answer, "tool status error");
  assert.match(JSON.stringify(output.toolResults[0].content), /still unavailable/);
});

for (const executor of ["sequential", "durable"] as const) {
  test(`a Strands interrupt suspends on a durable callback and resumes the tool (${executor} executor)`, async () => {
    const keys: string[] = [];
    const { counter, sink, runner } = await harness({
      realTime: true,
      executor,
      add: ({ a, b }, toolContext) => {
        keys.push(currentToolExecution().idempotencyKey);
        const answer = toolContext!.interrupt({ name: "approval", reason: { action: "add", a, b } });
        return { sum: a + b, approvedBy: answer };
      },
    });
    const running = runner.run({ payload: {} });
    const callback = runner.getOperation("interrupt-tool:tooluse-1:approval");
    await callback.waitForData(WaitingOperationStatus.SUBMITTED);
    const approval = sink.events.find(e => e.kind === "approval")!;
    assert.deepEqual(approval.interrupt, { id: "tool:tooluse-1:approval", name: "approval", reason: { action: "add", a: 7, b: 8 } });
    // Real delay on purpose: the SDK ends an idle invocation after a 20 ms cooldown on the real clock, and there is
    // no hook to await it. Answering earlier would let the same invocation continue, and nothing would be replayed.
    await new Promise(resolve => setTimeout(resolve, 200));
    await callback.sendCallbackSuccess(JSON.stringify("alice"));
    const execution = await running;

    assert.equal(execution.getStatus(), "SUCCEEDED");
    assert.ok(counter.invocations >= 2, "waiting for the callback ends the first invocation");
    assert.equal(counter.model, 2, "the model call before the interrupt is not repeated");
    const names = execution.getOperations().map(op => op.getName() ?? "");
    const expected = executor === "sequential"
      ? ["model-1", "tool-add_numbers-1-tooluse-1", "tool-add_numbers-2-tooluse-1", "model-2"]
      : ["model-1", "tools-1-0", "tool-add_numbers-tooluse-1", "tools-2-0", "tool-add_numbers-tooluse-1", "model-2"];
    assert.deepEqual(names.filter(name => /^(model|tools?)-/.test(name)), expected);
    assert.equal(new Set(keys).size, 1, "the interrupted and resumed runs share an idempotency key");
    const output = execution.getResult()!;
    assert.equal(output.answer, "tool status success");
    assert.match(JSON.stringify(output.toolResults), /"approvedBy":"alice"/);
  });
}

test("appState written by a tool is restored when the tool step is replayed", async () => {
  const { counter, runner } = await harness({
    realTime: true, pauseAfterModelCall: 2,
    add: ({ a, b }, toolContext) => {
      toolContext!.agent.appState.set("cleared", true);
      toolContext!.agent.appState.clear();
      toolContext!.agent.appState.set("discarded", true);
      toolContext!.agent.appState.delete("discarded");
      toolContext!.agent.appState.set("lastSum", a + b);
      return { sum: a + b };
    },
  });
  const execution = await runner.run({ payload: {} });

  assert.equal(execution.getStatus(), "SUCCEEDED");
  assert.equal(counter.invocations, 2);
  assert.equal(counter.tool, 1);
  assert.deepEqual(execution.getResult()!.appState, { lastSum: 15 }, "the final invocation only replayed the tool");
});

test("legacy v1/v2 tool appState snapshots still restore their whole state", async () => {
  const result = new ToolResultBlock({ toolUseId: "old-use", status: "success", content: [] });
  const source = tool({
    name: "old_tool",
    description: "A tool already checkpointed by an earlier version.",
    inputSchema: z.object({}),
    callback: () => { throw new Error("a legacy checkpoint must not rerun its tool"); },
  });
  for (const schemaVersion of [1, 2]) {
    const state = new StateStore({ obsolete: true });
    const context = {
      executionContext: { durableExecutionArn: "legacy-execution" },
      step: async () => ({ schemaVersion, result: result.toJSON(), appState: { restored: schemaVersion } }),
    } as unknown as DurableContext;
    const toolContext = { toolUse: { toolUseId: "old-use" }, agent: { appState: state } } as unknown as ToolContext;
    const restored = await new DurableTool(source, context).stream(toolContext).next();
    assert.ok(restored.done);
    assert.equal(restored.value.status, "success");
    assert.deepEqual(state.getAll(), { restored: schemaVersion });
  }
});

test("binary model content survives the checkpoint", async () => {
  const { runner } = await harness({ realTime: true, pauseAfterModelCall: 1, script: { redactedReasoning: true } });
  const execution = await runner.run({ payload: {} });

  assert.equal(execution.getStatus(), "SUCCEEDED");
  const output = execution.getResult()!;
  assert.equal(output.redactedIsBytes, true);
  assert.deepEqual(output.redacted, [...REDACTED]);
});

test("a workflow tool runs a sub-agent with its own durable steps in a child context", async () => {
  const child = { model: 0, tool: 0, invocations: 0, seenToolNames: [] };
  const { counter, runner } = await harness({
    realTime: true, pauseAfterModelCall: 2,
    script: { toolUses: [{ name: "ask_specialist", input: { question: "7+8?" } }] },
    tools: ({ context, sink }) => [durableWorkflowTool(context, {
      name: "ask_specialist",
      description: "Ask a specialist agent.",
      inputSchema: z.object({ question: z.string() }),
      run: async ({ question }, childContext) => {
        const specialist = new Agent({
          model: new DurableModel(new ScriptedModel(child, { toolUses: [], answer: "fifteen" }), childContext, { events: sink }),
          printer: false,
          retryStrategy: null,
        });
        await childContext.wait("specialist-pause", { seconds: 1 });
        return { answer: (await specialist.invoke(question)).toString() };
      },
    })],
  });
  const execution = await runner.run({ payload: {} });

  assert.equal(execution.getStatus(), "SUCCEEDED");
  assert.ok(counter.invocations >= 3, "both the child wait and the probe wait suspend");
  assert.equal(counter.model, 2);
  assert.equal(child.model, 1, "the sub-agent's model call is journaled in the child context");
  const output = execution.getResult()!;
  assert.equal(output.answer, "tool status success");
  assert.match(JSON.stringify(output.toolResults), /fifteen/);
});

test("live text deltas are coalesced, and only the first delta is emitted immediately", async () => {
  const { sink, runner } = await harness({ textFlushMs: 60_000 });
  const execution = await runner.run({ payload: {} });

  assert.equal(execution.getStatus(), "SUCCEEDED");
  const text = sink.events.filter(e => e.kind === "text");
  assert.deepEqual(text.map(e => e.text), ["tool ", "status success"]);
  const starts = sink.events.filter(e => e.kind === "model_start");
  assert.deepEqual(text.map(e => e.attempt), [starts[1].attempt, starts[1].attempt]);
});
