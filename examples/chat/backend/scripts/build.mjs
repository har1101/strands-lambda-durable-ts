// Bundles the Lambda handlers: src/worker.ts -> dist/worker/index.mjs, src/api.ts -> dist/api/index.mjs.
// Everything is bundled, including the AWS SDK and strands-lambda-durable (resolved through its package
// exports to packages/strands-lambda-durable/dist, so build the library first).
import { rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
await rm(join(root, "dist"), { recursive: true, force: true });

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

await Promise.all(["worker", "api"].map(name => build({
  ...common,
  entryPoints: [join(root, "src", `${name}.ts`)],
  outfile: join(root, "dist", name, "index.mjs"),
})));
