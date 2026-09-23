import { test } from "node:test";
import assert from "node:assert/strict";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpClient, Tool, tool, type ToolContext, type ToolStreamGenerator } from "@strands-agents/sdk";
import { z } from "zod";
import { createOffloadSerdes, DurableTool, durableMcpTools, type EventSink, type OffloadStore } from "../src/index.js";
import { harness, parentNames } from "./helpers.js";

/** Delays the start of a wrapped tool, so tool uses claim their durable slots out of `toolUse` order. */
class LateStartTool extends Tool {
  readonly name: string;
  readonly description: string;
  readonly toolSpec: Tool["toolSpec"];
  constructor(private readonly inner: Tool, private readonly started: Promise<void>) {
    super();
    this.name = inner.name;
    this.description = inner.description;
    this.toolSpec = inner.toolSpec;
  }
  async *stream(toolContext: ToolContext): ToolStreamGenerator {
    await this.started;
    return yield* this.inner.stream(toolContext);
  }
}

/** Resolves only when the wrapped durable tool has applied its step result to appState. */
class CompletionTool extends Tool {
  readonly name: string;
  readonly description: string;
  readonly toolSpec: Tool["toolSpec"];
  constructor(private readonly inner: Tool, private readonly completed: () => void) {
    super();
    this.name = inner.name;
    this.description = inner.description;
    this.toolSpec = inner.toolSpec;
  }
  async *stream(toolContext: ToolContext): ToolStreamGenerator {
    try {
      return yield* this.inner.stream(toolContext);
    } finally {
      this.completed();
    }
  }
}

test("parallel tool uses keep a toolUse-ordered journal when they start and finish out of order", async () => {
  const runs: string[] = [];
  const { promise: secondFinished, resolve: releaseFirst } = Promise.withResolvers<void>();
  const { counter, runner } = await harness({
    realTime: true,
    pauseAfterModelCall: 2,
    executor: "durable",
    script: { toolUses: [{ name: "lookup", input: { id: "A" } }, { name: "lookup_fast", input: { id: "B" } }] },
    tools: ({ context, sink }) => {
      const lookup = (name: string) => tool({
        name,
        description: "Look up an order.",
        inputSchema: z.object({ id: z.string() }),
        callback: ({ id }) => {
          runs.push(name);
          if (name === "lookup_fast") releaseFirst();
          return { id, via: name };
        },
      });
      // The first tool use starts only after the second finished: claim and completion order are both reversed.
      return [
        new LateStartTool(new DurableTool(lookup("lookup"), context, { events: sink }), secondFinished),
        new DurableTool(lookup("lookup_fast"), context, { events: sink }),
      ];
    },
  });
  const execution = await runner.run({ payload: {} });

  assert.equal(execution.getStatus(), "SUCCEEDED");
  assert.equal(counter.invocations, 2);
  assert.deepEqual(runs, ["lookup_fast", "lookup"], "each tool ran once, second tool use first");
  const parents = parentNames(execution.getOperations());
  assert.equal(parents["tool-lookup-tooluse-1"], "tools-1-0", "slot follows toolUse order, not start order");
  assert.equal(parents["tool-lookup_fast-tooluse-2"], "tools-1-1");
  const output = execution.getResult()!;
  assert.equal(output.answer, "tool status success,success");
  assert.deepEqual(output.toolResults.map((r: { toolUseId: string; content: unknown }) => [r.toolUseId, JSON.stringify(r.content)]), [
    ["tooluse-1", JSON.stringify([{ json: { id: "A", via: "lookup" } }])],
    ["tooluse-2", JSON.stringify([{ json: { id: "B", via: "lookup_fast" } }])],
  ]);
});

test("parallel tool uses retain only their own appState writes, live and on replay", async () => {
  const { promise: secondCaptured, resolve: captureSecond } = Promise.withResolvers<void>();
  const { promise: firstCompleted, resolve: completeFirst } = Promise.withResolvers<void>();
  let liveState: ToolContext["agent"]["appState"] | undefined;
  const runs: string[] = [];
  const { counter, runner } = await harness({
    realTime: true,
    pauseAfterModelCall: 2,
    executor: "durable",
    script: { toolUses: [{ name: "first", input: {} }, { name: "second", input: {} }] },
    onInvocation: invocation => {
      if (invocation === 2) assert.deepEqual(liveState!.getAll(), { first: "first", second: "second" },
        "the late completion of the second tool must not replace the first tool's write");
    },
    tools: ({ context, sink }) => {
      const secondEvents: EventSink = {
        async put(event) {
          await sink.put(event);
          if (event.kind === "tool" && event.tool === "second" && event.status === "success") {
            captureSecond(); // The second tool's old snapshot has already been taken.
            await firstCompleted;
          }
        },
      };
      const makeTool = (name: string) => tool({
        name,
        description: `Write ${name}.`,
        inputSchema: z.object({}),
        callback: async (_, toolContext) => {
          if (name === "first") await secondCaptured;
          liveState ??= toolContext!.agent.appState;
          toolContext!.agent.appState.set(name, name);
          runs.push(name);
          return { name };
        },
      });
      return [
        new CompletionTool(new DurableTool(makeTool("first"), context, { events: sink }), completeFirst),
        new DurableTool(makeTool("second"), context, { events: secondEvents }),
      ];
    },
  });
  const execution = await runner.run({ payload: {} });

  assert.equal(execution.getStatus(), "SUCCEEDED");
  assert.equal(counter.invocations, 2);
  assert.deepEqual(runs, ["second", "first"], "neither tool reruns on replay");
  assert.deepEqual(execution.getResult()!.appState, { first: "first", second: "second" });
});

test("an MCP tool list is recorded once; later invocations of the same execution keep it", async () => {
  const server = new McpServer({ name: "orders", version: "1.0.0" });
  let serverCalls = 0;
  server.registerTool("echo", { description: "Echo text", inputSchema: { text: z.string() } }, async ({ text }) => {
    serverCalls++;
    return { content: [{ type: "text", text: `echo:${text}` }] };
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new McpClient({ transport: clientTransport });
  await client.connect();

  const { counter, runner } = await harness({
    realTime: true,
    pauseAfterModelCall: 1,
    script: { toolUses: [{ name: "echo", input: { text: "hi" } }] },
    // The server gains a tool before the second invocation, after the first one recorded the list.
    onInvocation: invocation => {
      if (invocation === 2) {
        server.registerTool("shout", { description: "Shout text", inputSchema: { text: z.string() } },
          async ({ text }) => ({ content: [{ type: "text", text: text.toUpperCase() }] }));
      }
    },
    tools: ({ context, sink }) => durableMcpTools(context, client, { id: "orders", events: sink }),
  });
  const execution = await runner.run({ payload: {} });

  assert.equal(execution.getStatus(), "SUCCEEDED");
  assert.equal(counter.invocations, 2);
  assert.deepEqual(counter.seenToolNames, [["echo"], ["echo"]], "model-2 runs after the server changed but sees the recorded list");
  assert.equal(serverCalls, 1);
  assert.match(JSON.stringify(execution.getResult()!.toolResults), /echo:hi/);
  assert.deepEqual((await client.listTools()).map(t => t.name).sort(), ["echo", "shout"], "a new execution would see the new tool");
  await client.disconnect();
});

test("large checkpoints are offloaded and restored on replay", async () => {
  const objects = new Map<string, string>();
  const store: OffloadStore = {
    async put(key, body) { objects.set(key, body); },
    async get(key) {
      const body = objects.get(key);
      if (body === undefined) throw new Error(`missing ${key}`);
      return body;
    },
  };
  const blob = "x".repeat(200_000);
  const { counter, runner } = await harness({
    realTime: true,
    pauseAfterModelCall: 2,
    serdes: createOffloadSerdes({ store, thresholdBytes: 1024, prefix: "checkpoints/" }),
    add: () => ({ blob }),
  });
  const execution = await runner.run({ payload: {} });

  assert.equal(execution.getStatus(), "SUCCEEDED");
  assert.equal(counter.tool, 1);
  assert.ok([...objects.keys()].every(key => key.startsWith("checkpoints/")));
  assert.ok([...objects.values()].some(body => body.includes(blob)), "the tool record is in the store");
  const step = execution.getOperations().find(op => op.getName() === "tool-add_numbers-1-tooluse-1")!;
  assert.ok((step.getOperationData()?.StepDetails?.Result?.length ?? Infinity) < 1024, "the journal keeps only a pointer");
  assert.equal(execution.getResult()!.toolResults[0].content[0].json.blob.length, blob.length, "replay restored the full result");
});

test("a stateful provider's modelState is restored when its call is replayed", async () => {
  const { counter, runner } = await harness({ realTime: true, pauseAfterModelCall: 1, script: { stateful: true } });
  const execution = await runner.run({ payload: {} });

  assert.equal(execution.getStatus(), "SUCCEEDED");
  assert.equal(counter.invocations, 2);
  assert.equal(counter.model, 2);
  assert.equal(execution.getResult()!.answer, "state r1", "model-2 ran after replaying model-1 and saw its state");
});

test("a throttled model call is retried in its own step", async () => {
  const { counter, runner } = await harness({ script: { failures: [new Error("ThrottlingException: Rate exceeded")] } });
  const execution = await runner.run({ payload: {} });

  assert.equal(execution.getStatus(), "SUCCEEDED");
  assert.equal(counter.model, 3, "one throttled attempt, then model-1 and model-2");
  const step = execution.getOperations().find(op => op.getName() === "model-1")!;
  assert.equal(step.getStepDetails()?.attempt, 2);
});

test("a model validation error is not retried", async () => {
  const { counter, runner } = await harness({ script: { failures: [new Error("ValidationException: messages: too long")] } });
  const execution = await runner.run({ payload: {} });

  assert.equal(execution.getStatus(), "FAILED");
  assert.equal(counter.model, 1);
  assert.match(JSON.stringify(execution.getError()), /ValidationException/);
});
