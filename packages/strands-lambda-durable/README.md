# strands-lambda-durable

Run [Strands Agents](https://strandsagents.com) (TypeScript) on [AWS Lambda durable functions](https://docs.aws.amazon.com/lambda/latest/dg/durable-functions.html). Each model request and each tool use becomes its own durable step. If a Lambda invocation stops, the next one replays completed steps from the journal instead of calling the model or the tool again. The Strands agent loop stays as it is: the package wraps Strands' public `Model` and `Tool` extension points and adds a tool executor.

> Status: pre-1.0. The API may change between minor versions. Supported: `@strands-agents/sdk` >= 1.18 < 2, `@aws/durable-execution-sdk-js` >= 2.4 < 3, Node.js 22+.

## Install

```bash
npm install strands-lambda-durable @strands-agents/sdk @aws/durable-execution-sdk-js zod
# for S3 offloading of large checkpoints
npm install @aws-sdk/client-s3
```

## Quick start

```ts
import { withDurableExecution } from "@aws/durable-execution-sdk-js";
import { Agent, BedrockModel, tool } from "@strands-agents/sdk";
import { z } from "zod";
import {
  DurableModel, DurableTool, DurableToolExecutor, currentToolExecution, invokeDurably,
} from "strands-lambda-durable";

export const handler = withDurableExecution(async (event: { prompt: string }, context) => {
  // Build a fresh agent on every invocation; the durable journal, not memory, carries progress.
  const refund = tool({
    name: "issue_refund",
    description: "Refund an order. A human must approve.",
    inputSchema: z.object({ orderId: z.string(), amount: z.number() }),
    callback: async ({ orderId, amount }, toolContext) => {
      const decision = toolContext!.interrupt({ name: "approval", reason: { orderId, amount } });
      if (!(decision as { approved?: boolean })?.approved) return { status: "rejected" };
      // Stable across retries, replays and the resumed interrupt: pass it to the payment API.
      const { idempotencyKey } = currentToolExecution();
      return await payments.refund({ orderId, amount, idempotencyKey });
    },
  });

  const agent = new Agent({
    model: new DurableModel(new BedrockModel({ modelId: "us.anthropic.claude-haiku-4-5-20251001-v1:0" }), context),
    tools: [new DurableTool(refund, context)],
    toolExecutor: new DurableToolExecutor(context),
    retryStrategy: null, // retries belong to the durable steps
  });

  const result = await invokeDurably(agent, context, event.prompt, {
    // Send the callback ID to an approver. The Lambda invocation ends while it waits.
    onInterrupt: async ({ callbackId, interrupt }) => notifyApprover(callbackId, interrupt),
    interruptTimeout: { hours: 24 },
  });
  return result.toString();
});
```

The approver answers with `aws lambda send-durable-execution-callback-success --callback-id ... --result '{"approved":true}'` (or the SDK). A new invocation replays the journal and resumes the same tool use with that answer.

## API

| Export | What it does |
| --- | --- |
| `DurableModel(source, context, options?)` | One step per model request (`model-<n>`). Records the full event stream and replays it without calling the provider. Options: `events` (live `model_start`/`text` events, text coalesced every `textFlushMs`, default 100 ms), `retryStrategy` (default `modelRetryStrategy`: throttling, 5xx, and timeouts, up to 4 attempts; validation errors fail at once), `serdes`. Restores `modelState` for stateful providers. |
| `DurableTool(source, context, options?)` | One step per tool use. An exception from the tool is a business outcome: it is checkpointed as an error result for the model. `RetryableToolError` retries only that step (`toolRetryStrategy`, 3 attempts); once retries are exhausted it becomes an error result. Restores `agent.appState` changes. Options: `events`, `retryStrategy`, `serdes`. |
| `DurableToolExecutor(context, options?)` | Parallel tools with a deterministic journal. Before a turn's tools start, it opens one child context per tool use, in `toolUse` order (`tools-<turn>-<index>`); each durable tool runs in its own child context. The order in which tools start or finish does not change operation IDs. Without it, use `toolExecutor: "sequential"`: overlapping `DurableTool` steps are rejected. |
| `invokeDurably(agent, context, input, options)` | `agent.invoke` that turns every Strands interrupt (tool `interrupt()`, hook interrupts) into `context.waitForCallback`. The callback's JSON result becomes the interrupt response. `onInterrupt` runs as a durable step. |
| `durableWorkflowTool(context, config)` | A tool whose body runs in a child context and may use any durable operation: waits, callbacks, invokes, or a sub-agent built with `DurableModel` over the child context. |
| `durableMcpTools(context, mcpClient, { id })` | Lists an MCP server's tools once per execution (`mcp-tools-<id>` step) and wraps them in `DurableTool`. Later invocations of that execution keep the recorded list; new executions see the current one. |
| `createOffloadSerdes({ store, thresholdBytes?, prefix? })` | JSON serdes that stores checkpoint payloads above the threshold (default 64 KiB) in an `OffloadStore` and keeps a pointer in the journal. Pass it as `serdes` to the model, the tools, and the executor. |
| `s3OffloadStore({ client, bucket, prefix? })` (from `strands-lambda-durable/s3`) | `OffloadStore` on Amazon S3. Give the bucket a lifecycle rule longer than the durable retention period. |
| `currentToolExecution()` | Inside a durable tool: `{ idempotencyKey, attempt }`. The key is `<execution ARN>#<toolUseId>`. |
| `modelRetryStrategy`, `toolRetryStrategy`, `RetryableToolError` | Default retry policies and the retry signal. |
| `EventSink`, `DurableLiveEvent` | Receives provisional live events. A new `attempt` on `model_start` replaces that call's earlier text. |

## Guarantees and limits

- **What is replayed.** Completed model calls and tool uses are replayed from the journal, not executed again. This includes error results, interrupts, `appState` changes, and `modelState`. Binary content (`Uint8Array`) is kept. Each tool use records only the `appState` keys it set or deleted, so parallel tools do not overwrite each other's changes. Checkpoints are versioned: `schemaVersion` 3, and versions 1 and 2 are still read.
- **Not exactly-once.** A step can run again if the process stops after its side effect and before its checkpoint. Pass `idempotencyKey` to an API that deduplicates on it.
- **Determinism is your part.** Build the agent the same way on every invocation. Keep work that is not durable (hooks with I/O, clocks, random values) out of decisions, or move it into a durable tool. Tools that are not wrapped run again on every replay.
- **Live events are provisional.** They are side effects of a running step. Retried attempts emit new events with a new `attempt`. Use the journal (or your own store written in a step) as the source of truth.
- **Quotas.** Lambda allows 3,000 operations and 100 MB of checkpoint data per execution. Use `createOffloadSerdes` for large tool results. Split very long conversations into several executions, for example one execution per user message, with history kept in your own store.
- **Versions.** Invoke a published version or alias, so that a running execution keeps the code that matches its journal.

## Testing your agent

The durable SDK's `LocalDurableTestRunner` runs a handler locally. It supports suspension, callbacks, and retries. See this package's `test/` directory for a provider-independent scripted model and the scenarios covered: replay, retries, interrupts, parallel tools, MCP, offloading, and `modelState`. If a test depends on the invocation ending, use real timers (`skipTime: false`). The SDK ends an idle invocation after a 20 ms cooldown, and with skipped time a short wait can finish before that happens.

## License

MIT
