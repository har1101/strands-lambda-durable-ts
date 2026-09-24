// Bundle size and import time of minimal handlers: node measure.mjs (after npm install).
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { gzipSync } from "node:zlib";
import { build } from "esbuild";

const entries = {
  strands: `
import { withDurableExecution } from "@aws/durable-execution-sdk-js";
import { Agent, BedrockModel, tool } from "@strands-agents/sdk";
import { DurableModel, DurableTool, DurableToolExecutor, invokeDurably } from "strands-lambda-durable-functions";
import { z } from "zod";
export const handler = withDurableExecution(async (e, ctx) => {
  const t = tool({ name: "a", description: "a", inputSchema: z.object({ a: z.number() }), callback: ({ a }) => a });
  const agent = new Agent({ model: new DurableModel(new BedrockModel({}), ctx), tools: [new DurableTool(t, ctx)], toolExecutor: new DurableToolExecutor(ctx), retryStrategy: null });
  return (await invokeDurably(agent, ctx, e.text, { onInterrupt: async () => {} })).stopReason;
});`,
  "durable-sdk-only": `
import { withDurableExecution } from "@aws/durable-execution-sdk-js";
export const handler = withDurableExecution(async (e, ctx) => ctx.step("x", async () => 1));`,
  "spike-json-schema": `
import { withDurableExecution } from "@aws/durable-execution-sdk-js";
import { agent, tool } from "../src/index.ts";
import { bedrock } from "../src/bedrock.ts";
const t = tool({ name: "a", description: "a", input: { type: "object", properties: { a: { type: "number" } } }, run: i => i });
const bot = agent({ model: bedrock({ modelId: "m" }), tools: [t] });
export const handler = withDurableExecution(async (e, ctx) => (await bot.run(ctx, { prompt: e.text })).text);`,
  "spike-zod": `
import { withDurableExecution } from "@aws/durable-execution-sdk-js";
import * as z from "zod";
import { agent, tool } from "../src/index.ts";
import { bedrock } from "../src/bedrock.ts";
const t = tool({ name: "a", description: "a", input: z.object({ a: z.number() }), run: i => i });
const bot = agent({ model: bedrock({ modelId: "m" }), tools: [t] });
export const handler = withDurableExecution(async (e, ctx) => (await bot.run(ctx, { prompt: e.text })).text);`,
  "spike-core-only": `export * from "../src/index.ts";`,
};

const banner = "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);";
await rm("out", { recursive: true, force: true });
await mkdir("out");
const kib = bytes => `${(bytes / 1024).toFixed(1)} KiB`;
const rows = [];
for (const [name, source] of Object.entries(entries)) {
  await writeFile(`out/${name}.entry.mjs`, source);
  for (const external of [false, true]) {
    const outfile = `out/${name}${external ? ".external" : ""}.mjs`;
    await build({
      entryPoints: [`out/${name}.entry.mjs`], outfile, bundle: true, minify: true, platform: "node", format: "esm",
      target: "node22", banner: { js: banner }, logLevel: "error", absWorkingDir: process.cwd(),
      nodePaths: [`${process.cwd()}/node_modules`], resolveExtensions: [".ts", ".mjs", ".js"],
      ...(external && { external: ["@aws-sdk/*", "@smithy/*"] }),
    });
    const code = await readFile(outfile);
    const times = [];
    for (let i = 0; i < 7; i++) {
      times.push(Number(execFileSync("node", ["--input-type=module", "-e",
        `const t = performance.now(); await import(${JSON.stringify(`${process.cwd()}/${outfile}`)}); console.log(performance.now() - t);`]).toString()));
    }
    times.sort((a, b) => a - b);
    rows.push({ handler: name, awsSdk: external ? "external" : "bundled", minified: kib(code.length), gzip: kib(gzipSync(code).length), importMs: times[3].toFixed(1) });
  }
}
console.table(rows);
