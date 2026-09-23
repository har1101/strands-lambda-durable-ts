import type { DurableContext } from "@aws/durable-execution-sdk-js";
import {
  TextBlock, Tool, ToolResultBlock,
  type McpClient, type ToolContext, type ToolStreamGenerator,
} from "@strands-agents/sdk";
import { DurableTool, type DurableToolOptions } from "./tool.js";

type RecordedSpec = { name: string; description: string; toolSpec: Tool["toolSpec"] };

export type DurableMcpToolsOptions = DurableToolOptions & {
  /** Stable name for this server within the execution; the discovery step is `mcp-tools-<id>`. */
  id: string;
};

/** Stands in for a recorded MCP tool; calls the server's live tool of the same name only when actually executed. */
class RecordedMcpTool extends Tool {
  readonly name: string;
  readonly description: string;
  readonly toolSpec: Tool["toolSpec"];

  constructor(spec: RecordedSpec, private readonly liveTools: () => Promise<Map<string, Tool>>) {
    super();
    this.name = spec.name;
    this.description = spec.description;
    this.toolSpec = spec.toolSpec;
  }

  async *stream(toolContext: ToolContext): ToolStreamGenerator {
    const live = (await this.liveTools()).get(this.name);
    if (!live) {
      return new ToolResultBlock({
        toolUseId: toolContext.toolUse.toolUseId,
        status: "error",
        content: [new TextBlock(`MCP tool ${this.name} is no longer offered by the server`)],
      });
    }
    return yield* live.stream(toolContext);
  }
}

/**
 * Lists an MCP server's tools once per execution, in a durable step, and returns them wrapped in DurableTool.
 *
 * Replays and later invocations of the same execution see the recorded tool list, even if the server's list has
 * changed since; new executions discover the current list. Each call runs in its own durable step.
 */
export async function durableMcpTools(context: DurableContext, client: McpClient, options: DurableMcpToolsOptions): Promise<Tool[]> {
  const { id, ...toolOptions } = options;
  const specs = await context.step(`mcp-tools-${id}`, async (): Promise<RecordedSpec[]> =>
    (await client.listTools()).map(tool => ({ name: tool.name, description: tool.description, toolSpec: tool.toolSpec })));
  let live: Promise<Map<string, Tool>> | undefined;
  const liveTools = () => {
    live ??= client.listTools().then(tools => new Map(tools.map(tool => [tool.name, tool] as const)));
    live.catch(() => { live = undefined; });
    return live;
  };
  return specs.map(spec => new DurableTool(new RecordedMcpTool(spec, liveTools), context, toolOptions));
}
