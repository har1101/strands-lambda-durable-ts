// Spike: framework-free durable agent loop for Lambda durable functions.
// No runtime imports: the durable SDK is referenced for types only. Correctness still depends on SDK behavior
// (operation IDs are assigned when an operation is called; unrecoverable errors halt instead of throwing).
import type { DurableContext, StepConfig } from "@aws/durable-execution-sdk-js";

// ---------- Messages (a structural subset of Bedrock Converse) ----------

export type JSONValue = null | boolean | number | string | JSONValue[] | { [key: string]: JSONValue };

type Image = { image: { format: string; source: { bytes: Uint8Array } } };
export type ToolResultContent = { text: string } | { json: JSONValue } | Image;
export type ContentBlock =
  | { text: string }
  | Image
  | { reasoningContent: { reasoningText?: { text: string; signature?: string }; redactedContent?: Uint8Array } }
  | { toolUse: { toolUseId: string; name: string; input: JSONValue } }
  | { toolResult: { toolUseId: string; content: ToolResultContent[]; status?: "success" | "error" } }
  | { cachePoint: { type: "default" } };
export type Message = { role: "user" | "assistant"; content: ContentBlock[] };
export type SystemBlock = { text: string } | { cachePoint: { type: "default" } };
export type StopReason = "end_turn" | "tool_use" | "max_tokens" | "stop_sequence" | "guardrail_intervened" | "content_filtered" | "model_context_window_exceeded" | (string & {});
export type Usage = { inputTokens: number; outputTokens: number; totalTokens?: number };

// ---------- Model: a function ----------

export type ToolSpec = { name: string; description: string; inputSchema: Record<string, unknown> };
export type ModelRequest = { system?: string | SystemBlock[]; messages: Message[]; tools: ToolSpec[] };
export type ModelResponse = { message: Message; stopReason: StopReason; usage?: Usage };
export type Delta = { type: "text"; text: string } | { type: "reasoning"; text: string };
export type ModelCallOptions = {
  /** Provisional stream output. Only the resolved response is journaled. */
  onDelta: (delta: Delta) => void;
  /** Step attempt, starting at 1. */
  attempt: number;
};
/** A model is a function. */
export type Model = (request: ModelRequest, options: ModelCallOptions) => Promise<ModelResponse>;
/**
 * `(next) => (request, options) => next(request, options)`. Runs inside the model step: it may do I/O, must not use
 * durable operations, and runs at least once per attempt (never again once the step has completed).
 */
export type ModelMiddleware = (next: Model) => Model;

/** Composes middleware around a model, outermost first. */
export const compose = (model: Model, ...middleware: ModelMiddleware[]): Model => middleware.reduceRight((next, wrap) => wrap(next), model);

// ---------- Live events (provisional, best effort, never replayed) ----------

export type LiveEvent =
  | { type: "model_start"; turn: number; attempt: string }
  | { type: "text"; turn: number; attempt: string; text: string }
  | { type: "tool_end"; turn: number; toolUseId: string; name: string; status: "success" | "error" };
export type EventSink = (event: LiveEvent) => void | Promise<void>;
type Emit = (event: LiveEvent) => Promise<void>;

/** Sink failures are logged and dropped: a live event must never fail or retry a durable step. */
function bestEffort(sink: EventSink | undefined): Emit | undefined {
  if (!sink) return undefined;
  return async event => {
    try {
      await sink(event);
    } catch (error) {
      console.warn(JSON.stringify({ message: "live event dropped", type: event.type, error: String(error) }));
    }
  };
}

// ---------- Errors and retry ----------

/** Throw from a tool to show `message` to the model as an error result. */
export class ToolError extends Error {
  override name = "ToolError";
}
/** Throw from a `run` tool to retry its step. Exhausted retries become an error result. */
export class RetryableError extends Error {
  override name = "RetryableError";
}
/** A model call failed permanently. Always fails the run, also inside a workflow tool (a sub-agent). */
export class ModelError extends Error {
  override name = "ModelError";
}

export type RetryStrategy = NonNullable<StepConfig<unknown>["retryStrategy"]>;

/** Full-jitter exponential backoff. `maxAttempts` includes the first attempt. */
export const backoff = (maxAttempts: number, initialSeconds: number, maxSeconds: number, retryable: (error: Error) => boolean): RetryStrategy =>
  (error, attempts) => attempts < maxAttempts && retryable(error)
    ? { shouldRetry: true, delay: { seconds: Math.max(1, Math.round(Math.random() * Math.min(maxSeconds, initialSeconds * 2 ** (attempts - 1)))) } }
    : { shouldRetry: false };

const TRANSIENT = /throttl|too many requests|serviceunavailable|internalserver|modelnotready|modelstreamerror|timed? ?out|econnreset|socket hang up|stream ended/i;
/** Throttling, 5xx, and dropped connections: up to 4 attempts. Validation errors fail at once. */
export const modelRetry = backoff(4, 2, 30, error => {
  const metadata = "$metadata" in error ? error.$metadata : undefined;
  const status = metadata && typeof metadata === "object" && "httpStatusCode" in metadata ? metadata.httpStatusCode : undefined;
  return status === 429 || (typeof status === "number" && status >= 500) || TRANSIENT.test(`${error.name} ${error.message}`);
});
/** {@link RetryableError} only: up to 3 attempts. */
export const toolRetry = backoff(3, 2, 30, error => error instanceof RetryableError || error.name === "RetryableError");

/** SDK termination (non-determinism, checkpoint or serdes failure). Never converted into a result. */
const isUnrecoverable = (error: unknown) => error instanceof Error && "isUnrecoverable" in error && error.isUnrecoverable === true;
const messageOf = (error: unknown) =>
  !(error instanceof Error) ? String(error) : error.cause instanceof Error ? error.cause.message : error.message;

// ---------- Codec ----------

const BYTES = "$bytes";
/** JSON-safe deep copy; `Uint8Array` becomes `{ $bytes: base64 }`. */
export const encode = <T>(value: T): T => JSON.parse(JSON.stringify(value, function (this: Record<string, unknown>, key, current) {
  const original = this[key];
  if (!(original instanceof Uint8Array)) return current;
  let binary = "";
  for (let i = 0; i < original.length; i += 0x8000) binary += String.fromCharCode(...original.subarray(i, i + 0x8000));
  return { [BYTES]: btoa(binary) };
}));
export const decode = <T>(value: T): T => JSON.parse(JSON.stringify(value), (_key, current) =>
  current && typeof current === "object" && typeof current[BYTES] === "string" && Object.keys(current).length === 1
    ? Uint8Array.from(atob(current[BYTES]), c => c.charCodeAt(0))
    : current);

// ---------- Tools ----------

/** Subset of Standard JSON Schema (+ optional Standard Schema validation). Zod 4.2+, ArkType, Valibot (via adapter). */
type StandardSchema<O> = {
  "~standard": {
    types?: { input: unknown; output: O };
    jsonSchema?: { input(options: { target: string }): Record<string, unknown> };
    validate?(value: unknown): { value: unknown; issues?: undefined } | { issues: readonly { message: string }[] } | Promise<unknown>;
  };
};
/** What the tool body receives: the schema's output (after transforms and defaults), or JSON for plain JSON Schema. */
type Infer<S> = S extends StandardSchema<infer O> ? O : JSONValue;

export type ToolCall = { toolUseId: string; idempotencyKey: string };
type ToolBase<S> = { name: string; description: string; input: S };
export type ToolDef<S> = ToolBase<S> & (
  /** One durable step. Plain I/O only; no durable operations inside. */
  | { run: (input: Infer<S>, call: ToolCall & { attempt: number }) => unknown; retry?: RetryStrategy; workflow?: never }
  /**
   * A child context: may use steps, waits, callbacks, invokes, or run a sub-agent. Journaled durable failures
   * (a failed step, a callback timeout) and {@link ToolError} become error results; any other exception fails the run.
   */
  | { workflow: (input: Infer<S>, context: DurableContext, call: ToolCall) => Promise<unknown>; run?: never; retry?: never }
);
type ToolOutcome = { status: "success" | "error"; content: ToolResultContent[] };
type ToolUse = { toolUseId: string; name: string; input: JSONValue };
type OpenArgs = { context: DurableContext; name: string; use: ToolUse; emit: Emit | undefined; turn: number; formatError: (error: unknown) => string };
export type Tool = {
  name: string;
  spec: ToolSpec;
  /** Opens this tool use's single durable operation synchronously (before any await), then runs it. */
  open: (args: OpenArgs) => Promise<ToolOutcome>;
};

const toContent = (value: unknown): ToolResultContent[] =>
  typeof value === "string" ? [{ text: value }]
  : value && typeof value === "object" && !Array.isArray(value) ? [{ json: value as JSONValue }]
  : [{ text: JSON.stringify(value ?? null) }];
const failed = (message: string): ToolOutcome => ({ status: "error", content: [{ text: message }] });

export function tool<S extends StandardSchema<unknown> | Record<string, unknown>>(def: ToolDef<S>): Tool {
  const standard = "~standard" in def.input ? (def.input as StandardSchema<unknown>)["~standard"] : undefined;
  if (standard && !standard.jsonSchema) throw new Error(`Tool ${def.name}: the input schema does not implement Standard JSON Schema`);
  // Converted once, at definition time, so an unsupported schema fails at startup rather than mid-run.
  const spec: ToolSpec = { name: def.name, description: def.description, inputSchema: standard ? standard.jsonSchema!.input({ target: "draft-07" }) : def.input };

  /** Validation must be pure: it runs outside a step for workflow tools. */
  async function validated(raw: JSONValue): Promise<{ input: Infer<S> } | { error: string }> {
    const checked = standard?.validate ? await standard.validate(raw) as { value?: unknown; issues?: readonly { message: string }[] } : { value: raw };
    if (checked.issues) return { error: `Invalid input: ${checked.issues.map(issue => issue.message).join("; ")}` };
    // Validated by the schema above (or typed as JSON when the schema is plain JSON Schema).
    const input = checked.value as Infer<S>;
    return { input };
  }

  return {
    name: def.name,
    spec,
    async open({ context, name, use, emit, turn, formatError }) {
      const call = { toolUseId: use.toolUseId, idempotencyKey: `${context.executionContext.durableExecutionArn}#${name}#${use.toolUseId}` };
      const end = (outcome: ToolOutcome) => emit?.({ type: "tool_end", turn, toolUseId: use.toolUseId, name: def.name, status: outcome.status });
      if (def.run) {
        const run = def.run;
        const step = context.step(name, async ({ attempt }): Promise<ToolOutcome> => {
          const checked = await validated(use.input);
          const outcome = "error" in checked ? failed(checked.error) : { status: "success" as const, content: toContent(await run(checked.input, { ...call, attempt })) };
          await end(outcome);
          return encode(outcome);
        }, { retryStrategy: def.retry ?? toolRetry });
        try {
          return decode(await step);
        } catch (error) {
          if (isUnrecoverable(error)) throw error;
          // A failed step is journaled; replay throws the same error and produces the same result.
          return failed(formatError(error));
        }
      }
      const workflow = def.workflow!;
      const child = context.runInChildContext(name, async child => {
        let outcome: ToolOutcome;
        try {
          const checked = await validated(use.input);
          outcome = "error" in checked ? failed(checked.error) : { status: "success", content: toContent(await workflow(checked.input, child, call)) };
        } catch (error) {
          const journaled = error instanceof Error && "errorType" in error && typeof error.errorType === "string" && error.errorType !== "ChildContextError";
          if (isUnrecoverable(error) || !(error instanceof ToolError || journaled)) throw error;
          outcome = failed(formatError(error));
        }
        // A step, so only the live run emits it. Skipped without a sink.
        if (emit) await child.step("notify", async () => { await end(outcome); return null; });
        return encode(outcome);
      });
      return decode(await child);
    },
  };
}

// ---------- Agent ----------

export type AgentConfig = {
  model: Model;
  system?: string | SystemBlock[];
  tools?: Tool[];
  /** Model calls per run. Default 16. */
  maxTurns?: number;
  /** Minimum interval between live text events. Default 100 ms. */
  textFlushMs?: number;
  /** Text shown to the model for a failed tool use. Default: the error message. Keep secrets out of it. */
  formatToolError?: (error: unknown, tool: string) => string;
};
export type RunInput = {
  /**
   * History before this run. Must be identical on every invocation of the execution: record it in a step (or
   * pass it in the payload) instead of re-reading a store that other runs may change.
   */
  messages?: Message[];
  prompt?: string | ContentBlock[];
  events?: EventSink;
  /** Operation name prefix. Readability and replay name checks only; IDs come from call order. */
  name?: string;
};
export type RunResult = {
  /** The whole conversation. */
  messages: Message[];
  /**
   * Messages added by this run. When the history ended with a user message (only after a `max_turns` stop), the
   * prompt is merged into it, and the first new message replaces the history's last message.
   */
  newMessages: Message[];
  stopReason: StopReason | "max_turns";
  usage: Usage;
  text: string;
};

type ModelRecord = { v: 1; response: ModelResponse };

/**
 * An agent is an immutable definition; `run` holds all per-run state. Define it once at module scope.
 *
 * Operations per turn: step `model-<turn>`, then one operation per tool use, `tool-<turn>-<index>` (a step for `run`
 * tools, a child context for `workflow` tools), all opened in tool use order before any tool body runs.
 *
 * The conversation always stays valid Converse: roles alternate, every toolUse has a toolResult, and no message
 * is empty. `newMessages` can be appended to the history as is.
 */
export function agent(config: AgentConfig) {
  const tools = new Map((config.tools ?? []).map(t => [t.name, t]));
  const specs = [...tools.values()].map(t => t.spec);
  const maxTurns = config.maxTurns ?? 16;
  const formatError = (name: string) => (error: unknown) => config.formatToolError?.(error, name) ?? `Tool ${name} failed: ${messageOf(error)}`;
  return {
    async run(context: DurableContext, input: RunInput): Promise<RunResult> {
      const prefix = input.name ? `${input.name}:` : "";
      const emit = bestEffort(input.events);
      const history = input.messages ?? [];
      const messages: Message[] = [...history];
      if (input.prompt !== undefined) {
        const content = typeof input.prompt === "string" ? [{ text: input.prompt }] : input.prompt;
        const last = messages.at(-1);
        // A history that ends with a user message (for example tool results after max_turns) gets the prompt appended.
        if (last?.role === "user") messages[messages.length - 1] = { role: "user", content: [...last.content, ...content] };
        else messages.push({ role: "user", content });
      }
      const firstNew = Math.min(history.length, messages.length - (input.prompt === undefined ? 0 : 1));
      const usage: Usage = { inputTokens: 0, outputTokens: 0 };
      let stopReason: RunResult["stopReason"] = "max_turns";
      for (let turn = 1; turn <= maxTurns; turn++) {
        // A snapshot: the loop keeps appending to `messages`, and a model or middleware may hold on to the request.
        const request: ModelRequest = { ...(config.system !== undefined && { system: config.system }), messages: [...messages], tools: specs };
        let record: ModelRecord;
        try {
          record = await context.step(`${prefix}model-${turn}`, attempt => callModel(config, request, turn, attempt.attempt, emit), { retryStrategy: modelRetry });
        } catch (error) {
          if (isUnrecoverable(error)) throw error;
          throw new ModelError(`Model call ${turn} failed: ${messageOf(error)}`, { cause: error });
        }
        if (record.v !== 1) throw new Error(`Unsupported model record version ${record.v}`);
        const response = decode(record.response);
        usage.inputTokens += response.usage?.inputTokens ?? 0;
        usage.outputTokens += response.usage?.outputTokens ?? 0;
        stopReason = response.stopReason;
        const uses = response.message.content.flatMap(block => "toolUse" in block ? [block.toolUse] : []);
        if (stopReason !== "tool_use" || uses.length === 0) {
          // Tool uses cut off by max_tokens (or the like) would have no results; drop them. Never push an empty message.
          const content = response.message.content.filter(block => !("toolUse" in block));
          if (content.length > 0) messages.push({ role: "assistant", content });
          break;
        }
        messages.push(response.message);
        if (turn === maxTurns) {
          messages.push({ role: "user", content: uses.map(use => ({ toolResult: { toolUseId: use.toolUseId, ...failed("Not run: the agent reached its turn limit.") } })) });
          stopReason = "max_turns";
          break;
        }
        // Each open() starts its durable operation before its first await, so IDs follow tool use order.
        const outcomes = await Promise.all(uses.map((use, index) => {
          const found = tools.get(use.name);
          if (!found) return failed(`Unknown tool: ${use.name}`);
          return found.open({ context, name: `${prefix}tool-${turn}-${index}`, use, emit, turn, formatError: formatError(use.name) });
        }));
        messages.push({ role: "user", content: outcomes.map((outcome, index) => ({ toolResult: { toolUseId: uses[index].toolUseId, ...outcome } })) });
      }
      const last = messages.at(-1);
      const text = last?.role === "assistant" ? last.content.flatMap(block => "text" in block ? [block.text] : []).join("") : "";
      return { messages, newMessages: messages.slice(firstNew), stopReason, usage, text };
    },
  };
}

async function callModel(config: AgentConfig, request: ModelRequest, turn: number, attemptNumber: number, emit: Emit | undefined): Promise<ModelRecord> {
  const attempt = crypto.randomUUID();
  await emit?.({ type: "model_start", turn, attempt });
  const flushMs = config.textFlushMs ?? 100;
  let pending = "";
  let last = 0;
  let sending = Promise.resolve();
  const flush = () => {
    if (!pending || !emit) return;
    const text = pending;
    pending = "";
    last = Date.now();
    // `emit` never rejects, so the chain cannot leave an unhandled rejection behind.
    sending = sending.then(() => emit({ type: "text", turn, attempt, text }));
  };
  try {
    const response = await config.model(request, {
      attempt: attemptNumber,
      onDelta: delta => {
        if (delta.type !== "text" || !emit) return;
        pending += delta.text;
        if (Date.now() - last >= flushMs) flush();
      },
    });
    flush();
    return { v: 1, response: encode(response) };
  } finally {
    await sending;
  }
}
