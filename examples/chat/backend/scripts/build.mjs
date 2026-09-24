// Bundles the Lambda handlers: the worker -> dist/worker/index.mjs, src/api.ts -> dist/api/index.mjs.
// WORKER_ENGINE picks the worker: strands (default, src/worker.ts) or minamo (src/worker-minamo.ts).
// Everything is bundled, including the AWS SDK and the agent libraries.
import { rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
await rm(join(root, "dist"), { recursive: true, force: true });

const WORKERS = { strands: "worker.ts", minamo: "worker-minamo.ts" };
const engine = process.env.WORKER_ENGINE || "strands";
if (!Object.hasOwn(WORKERS, engine)) throw new Error(`Unknown WORKER_ENGINE: ${engine} (strands | minamo)`);

const common = {
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  // Some bundled CommonJS dependencies call require() for Node built-ins. The alias avoids clashing with bundled
  // ES modules that import createRequire themselves.
  banner: { js: "import { createRequire as __bannerCreateRequire } from 'node:module'; const require = __bannerCreateRequire(import.meta.url);" },
  logLevel: "info",
};

await Promise.all([["worker", WORKERS[engine]], ["api", "api.ts"]].map(([name, entry]) => build({
  ...common,
  entryPoints: [join(root, "src", entry)],
  outfile: join(root, "dist", name, "index.mjs"),
})));
