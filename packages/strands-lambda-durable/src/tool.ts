import { AsyncLocalStorage } from "node:async_hooks";
import { StepError, type DurableContext, type Serdes } from "@aws/durable-execution-sdk-js";
import {
  TextBlock, Tool, ToolResultBlock,
  type JSONValue, type ToolContext, type ToolResultBlockData, type ToolStreamGenerator,
} from "@strands-agents/sdk";
import { checked, decode, encode, SCHEMA_VERSION } from "./codec.js";
import type { EventSink } from "./events.js";
import { RetryableToolError, toolRetryStrategy, type RetryStrategy } from "./retry.js";
import { coordinators, toolScope } from "./scope.js";

type InterruptRecord = { name: string; reason?: JSONValue };

type ToolRecord = {
  schemaVersion: 1 | 2 | 3;
  result?: { toolResult: ToolResultBlockData };
  error?: { name: string; message: string };
  /** The tool raised a Strands interrupt; replay raises the same interrupt again. */
  interrupt?: InterruptRecord;
  /** Legacy v1/v2 whole-state snapshot. New records use per-tool changes instead. */
  appState?: Record<string, JSONValue>;
  appStateDelta?: { set: Record<string, JSONValue>; delete: string[] };
  /** The step failed permanently (retries exhausted, or a non-retryable exception escaped the tool). */
  failure?: { name: string; message: string };
};

export type DurableToolOptions = {
  /** Receives provisional `tool` events (progress, final status, interrupts). */
  events?: EventSink;
  /** Step retry policy. Default {@link toolRetryStrategy}, which retries only {@link RetryableToolError}. */
  retryStrategy?: RetryStrategy;
  /** Checkpoint serialization, for example `createOffloadSerdes` for large tool results. */
  serdes?: Serdes<any>;
};

/** Contexts with a sequential DurableTool step in flight. Operation IDs follow call order, so steps must not overlap. */
const toolInFlight = new WeakSet<DurableContext>();
type AppState = ToolContext["agent"]["appState"];
type AppStateChanges = { set: Record<string, JSONValue>; delete: Set<string> };
const appStateWrites = new AsyncLocalStorage<{ state: AppState; changes: AppStateChanges }>();
const watchedStates = new WeakSet<AppState>();

/**
 * StateStore deep-copies on set/get and exposes no mutation hook. Instrument this agent's store once;
 * async-local attribution keeps overlapping tool uses from recording each other's writes.
 */
function watchAppState(state: AppState): void {
  if (watchedStates.has(state)) return;
  watchedStates.add(state);
  const set = state.set.bind(state);
  const remove = state.delete.bind(state);
  const clear = state.clear.bind(state);
  state.set = ((key: string, value: unknown) => {
    set(key, value);
    const changes = appStateWrites.getStore();
    if (changes?.state === state) {
      changes.changes.set[key] = state.get(key)!;
      changes.changes.delete.delete(key);
    }
  }) as typeof state.set;
  state.delete = ((key: string) => {
    remove(key);
    const changes = appStateWrites.getStore();
    if (changes?.state === state) {
      delete changes.changes.set[key];
      changes.changes.delete.add(key);
    }
  }) as typeof state.delete;
  state.clear = () => {
    const changes = appStateWrites.getStore();
    const keys = changes?.state === state ? state.keys() : undefined;
    clear();
    if (keys && changes) {
      for (const key of keys) {
        delete changes.changes.set[key];
        changes.changes.delete.add(key);
      }
      for (const key of Object.keys(changes.changes.set)) {
        delete changes.changes.set[key];
        changes.changes.delete.add(key);
      }
    }
  };
}

function isInterruptError(error: unknown): error is Error & { interrupts: { name: string; reason?: JSONValue }[] } {
  return error instanceof Error && error.name === "InterruptError" && "interrupts" in error && Array.isArray(error.interrupts);
}

/**
 * Wraps a Strands tool so that each tool use is one durable step.
 *
 * With `DurableToolExecutor`, the step runs in the tool use's own child context, so tools may run in parallel.
 * With any other executor, use `toolExecutor: 'sequential'`; overlapping steps are rejected.
 */
export class DurableTool extends Tool {
  readonly name: string;
  readonly description: string;
  readonly toolSpec: Tool["toolSpec"];
  private calls = 0;

  constructor(
    private readonly source: Tool,
    private readonly context: DurableContext,
    private readonly options: DurableToolOptions = {},
  ) {
    super();
    this.name = source.name;
    this.description = source.description;
    this.toolSpec = source.toolSpec;
  }

  async *stream(toolContext: ToolContext): ToolStreamGenerator {
    const call = ++this.calls;
    const toolUseId = toolContext.toolUse.toolUseId;
    const coordinator = coordinators.get(toolContext.agent);
    let record: ToolRecord;
    if (coordinator) {
      record = checked(await coordinator.claim(toolUseId, child => this.runStep(child, `tool-${this.name}-${toolUseId}`, toolContext)) as ToolRecord);
    } else {
      if (toolInFlight.has(this.context)) {
        throw new Error("DurableTool steps cannot overlap; use DurableToolExecutor or toolExecutor: 'sequential'");
      }
      toolInFlight.add(this.context);
      try {
        record = checked(await this.runStep(this.context, `tool-${this.name}-${call}-${toolUseId}`, toolContext));
      } finally {
        toolInFlight.delete(this.context);
      }
    }

    if (record.failure) {
      const error = new Error(record.failure.message);
      error.name = record.failure.name;
      return new ToolResultBlock({ toolUseId, status: "error", content: [new TextBlock(`Tool ${this.name} failed: ${error.message}`)], error });
    }
    if (record.interrupt) {
      // Raises the same Strands interrupt (its ID is derived from toolUseId and name). The agent stops with
      // stopReason 'interrupt'; invokeDurably turns it into a durable callback.
      toolContext.interrupt(record.interrupt);
      throw new Error("Interrupt returned a response while replaying an unanswered interrupt");
    }
    if (record.appState || record.appStateDelta) {
      // Replayed writes belong to this record, not to an enclosing tool's async-local tracker.
      appStateWrites.exit(() => {
        const state = toolContext.agent.appState;
        if (record.appState) {
          // Older checkpoints stored a complete snapshot, including deletions.
          state.clear();
          for (const [key, value] of Object.entries(decode(record.appState))) state.set(key, value);
        }
        if (record.appStateDelta) {
          for (const key of record.appStateDelta.delete) state.delete(key);
          for (const [key, value] of Object.entries(decode(record.appStateDelta.set))) state.set(key, value);
        }
      });
    }
    const result = ToolResultBlock.fromJSON(decode(record.result!));
    if (record.error) {
      const error = new Error(record.error.message);
      error.name = record.error.name;
      return new ToolResultBlock({ toolUseId: result.toolUseId, status: result.status, content: result.content, error });
    }
    return result;
  }

  /** Runs the tool in one durable step of `context`. A permanent step failure becomes a `failure` record. */
  private async runStep(context: DurableContext, name: string, toolContext: ToolContext): Promise<ToolRecord> {
    const { events, retryStrategy = toolRetryStrategy, serdes } = this.options;
    const toolUseId = toolContext.toolUse.toolUseId;
    const idempotencyKey = `${context.executionContext.durableExecutionArn}#${toolUseId}`;
    const state = toolContext.agent.appState;
    // The SDK owns one shared StateStore per agent; retries share this accumulator so a successful
    // attempt still checkpoints mutations performed by earlier attempts of the same tool use.
    const changes: AppStateChanges = { set: Object.create(null), delete: new Set() };
    try {
      return await context.step(name, async (step): Promise<ToolRecord> => {
        watchAppState(state);
        const outcome = await appStateWrites.run({ state, changes },
          () => toolScope.run({ idempotencyKey, attempt: step.attempt }, () => this.runSource(toolContext)));
        if ("interrupt" in outcome) return { schemaVersion: SCHEMA_VERSION, interrupt: outcome.interrupt };
        const block = outcome.block;
        if (block.error instanceof RetryableToolError) throw block.error;
        const result = encode(block.toJSON());
        await events?.put({ kind: "tool", tool: this.name, toolUseId, status: block.status, result });
        return {
          schemaVersion: SCHEMA_VERSION,
          result,
          ...(block.error && { error: { name: block.error.name, message: block.error.message } }),
          ...((changes.delete.size || Object.keys(changes.set).length) && {
            appStateDelta: encode({ set: changes.set, delete: [...changes.delete] }),
          }),
        };
      }, { retryStrategy, ...(serdes && { serdes }) });
    } catch (error) {
      // The failure is journaled, so replay reaches this branch again and produces the same record. No live event
      // here: this line also runs on every replay.
      if (!(error instanceof StepError)) throw error;
      return { schemaVersion: SCHEMA_VERSION, failure: { name: error.name, message: error.message } };
    }
  }

  private async runSource(toolContext: ToolContext): Promise<{ block: ToolResultBlock } | { interrupt: InterruptRecord }> {
    const { events } = this.options;
    const toolUseId = toolContext.toolUse.toolUseId;
    try {
      const iterator = this.source.stream(toolContext);
      let next = await iterator.next();
      while (!next.done) {
        await events?.put({ kind: "tool", tool: this.name, toolUseId, status: "progress", text: JSON.stringify(next.value.data) });
        next = await iterator.next();
      }
      return { block: next.value };
    } catch (error) {
      if (!isInterruptError(error)) throw error;
      const [first] = error.interrupts;
      await events?.put({ kind: "tool", tool: this.name, toolUseId, status: "interrupted", result: first.reason });
      return { interrupt: { name: first.name, ...(first.reason !== undefined && { reason: first.reason }) } };
    }
  }
}
