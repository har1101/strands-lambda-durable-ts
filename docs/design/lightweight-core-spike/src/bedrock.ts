// Spike: Bedrock Converse model adapter. Messages already use the Converse shape, so this is a pass-through
// plus stream assembly.
import { BedrockRuntimeClient, ConverseStreamCommand, type ConverseStreamCommandInput } from "@aws-sdk/client-bedrock-runtime";
import type { ContentBlock, JSONValue, Model } from "./index.js";

export type BedrockOptions = {
  modelId: string;
  client?: BedrockRuntimeClient;
  region?: string;
  inferenceConfig?: ConverseStreamCommandInput["inferenceConfig"];
  additionalModelRequestFields?: ConverseStreamCommandInput["additionalModelRequestFields"];
};

type Partial =
  | { kind: "text"; text: string }
  | { kind: "tool"; toolUseId: string; name: string; json: string }
  | { kind: "reasoning"; text: string; signature?: string; redacted?: Uint8Array };

export function bedrock(options: BedrockOptions): Model {
  const client = options.client ?? new BedrockRuntimeClient(options.region ? { region: options.region } : {});
  return async (request, { onDelta }) => {
    const response = await client.send(new ConverseStreamCommand({
      modelId: options.modelId,
      // Structurally identical to Converse; the SDK's generated union types cannot be unified with ours.
      messages: request.messages as ConverseStreamCommandInput["messages"],
      ...(request.system !== undefined && { system: typeof request.system === "string" ? [{ text: request.system }] : request.system }),
      ...(request.tools.length > 0 && {
        toolConfig: { tools: request.tools.map(t => ({ toolSpec: { name: t.name, description: t.description, inputSchema: { json: t.inputSchema as never } } })) },
      }),
      ...(options.inferenceConfig && { inferenceConfig: options.inferenceConfig }),
      ...(options.additionalModelRequestFields && { additionalModelRequestFields: options.additionalModelRequestFields }),
    }));
    const blocks: Partial[] = [];
    let stopReason: string | undefined;
    let usage: { inputTokens: number; outputTokens: number; totalTokens?: number } | undefined;
    for await (const event of response.stream ?? []) {
      if (event.contentBlockStart?.start?.toolUse) {
        const { toolUseId = "", name = "" } = event.contentBlockStart.start.toolUse;
        blocks[event.contentBlockStart.contentBlockIndex ?? blocks.length] = { kind: "tool", toolUseId, name, json: "" };
      } else if (event.contentBlockDelta?.delta) {
        const index = event.contentBlockDelta.contentBlockIndex ?? 0;
        const delta = event.contentBlockDelta.delta;
        if (delta.text !== undefined) {
          const block = blocks[index] ??= { kind: "text", text: "" };
          if (block.kind === "text") block.text += delta.text;
          onDelta({ type: "text", text: delta.text });
        } else if (delta.toolUse?.input !== undefined) {
          const block = blocks[index];
          if (block?.kind === "tool") block.json += delta.toolUse.input;
        } else if (delta.reasoningContent) {
          const block = blocks[index] ??= { kind: "reasoning", text: "" };
          if (block.kind !== "reasoning") continue;
          if (delta.reasoningContent.text !== undefined) {
            block.text += delta.reasoningContent.text;
            onDelta({ type: "reasoning", text: delta.reasoningContent.text });
          }
          if (delta.reasoningContent.signature !== undefined) block.signature = delta.reasoningContent.signature;
          if (delta.reasoningContent.redactedContent !== undefined) block.redacted = delta.reasoningContent.redactedContent;
        }
      } else if (event.messageStop) {
        stopReason = event.messageStop.stopReason ?? "end_turn";
      } else if (event.metadata?.usage) {
        const { inputTokens = 0, outputTokens = 0, totalTokens } = event.metadata.usage;
        usage = { inputTokens, outputTokens, ...(totalTokens !== undefined && { totalTokens }) };
      }
    }
    // A stream that ends without messageStop was cut off. Retryable ("stream ended").
    if (stopReason === undefined) throw new Error("Bedrock stream ended without messageStop");
    const content = blocks.filter(Boolean).flatMap((block): ContentBlock[] => {
      switch (block.kind) {
        case "text": return [{ text: block.text }];
        case "tool": {
          // Input cut off by max_tokens is not valid JSON; the core drops tool uses of non-tool_use responses anyway.
          let input: JSONValue;
          try {
            input = block.json ? JSON.parse(block.json) : {};
          } catch {
            if (stopReason === "tool_use") throw new Error(`Bedrock returned invalid tool input for ${block.name}`);
            return [];
          }
          return [{ toolUse: { toolUseId: block.toolUseId, name: block.name, input } }];
        }
        case "reasoning": return [{
          reasoningContent: block.redacted
            ? { redactedContent: block.redacted }
            : { reasoningText: { text: block.text, ...(block.signature !== undefined && { signature: block.signature }) } },
        }];
      }
    });
    return { message: { role: "assistant", content }, stopReason, ...(usage && { usage }) };
  };
}
