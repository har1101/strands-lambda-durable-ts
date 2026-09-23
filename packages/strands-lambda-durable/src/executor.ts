import type { DurableContext, Serdes } from "@aws/durable-execution-sdk-js";
import { ConcurrentToolExecutor } from "@strands-agents/sdk";
import { coordinators, TurnCoordinator } from "./scope.js";

type ExecuteArgs = Parameters<ConcurrentToolExecutor["execute"]>;

export type DurableToolExecutorOptions = {
  /** Serialization for the per-tool-use child context results, for example `createOffloadSerdes`. */
  serdes?: Serdes<any>;
};

/**
 * Runs a model turn's tool uses in parallel with a deterministic durable journal.
 *
 * Before any tool starts, one child context per tool use is opened in `toolUse` order (`tools-<turn>-<index>`).
 * `DurableTool` and `durableWorkflowTool` claim their tool use's child context, so completion order does not
 * affect operation IDs. Pass one instance per Agent: `new Agent({ toolExecutor: new DurableToolExecutor(context) })`.
 * Tools that are not durable run as usual, outside the journal.
 */
export class DurableToolExecutor extends ConcurrentToolExecutor {
  private turns = 0;

  constructor(private readonly context: DurableContext, private readonly options: DurableToolExecutorOptions = {}) {
    super();
  }

  override async *execute(...[options, input]: ExecuteArgs): ReturnType<ConcurrentToolExecutor["execute"]> {
    const pending = input.toolUseBlocks
      .map(block => block.toolUseId)
      .filter(toolUseId => !input.completedToolResults?.has(toolUseId));
    const coordinator = new TurnCoordinator(this.context, ++this.turns, pending, this.options.serdes);
    coordinators.set(options.agent, coordinator);
    try {
      yield* super.execute(options, input);
    } finally {
      coordinators.delete(options.agent);
      await coordinator.finish();
    }
  }
}
