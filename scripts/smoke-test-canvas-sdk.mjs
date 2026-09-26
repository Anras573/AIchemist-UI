// Smoke test for the canvas host bootstrap chain's BUILT output (#223's
// review, https://github.com/Anras573/AIchemist-UI/pull/234). Unlike the
// vitest suite — which imports host/loader.ts and host/sdk.ts directly as TS
// source and so never exercises the compiled `dist/main/host/*` files or the
// real registered loader hook — this script does exactly what a real canvas
// `server.mjs` does: register the built loader hook, then import
// `@aichemist/canvas` by its documented named import.
//
// Run after `bun run build` (see package.json's "smoke:canvas-sdk" script
// and the CI workflow) — `dist/main/host/{loader-hook.js,sdk.mjs}` must exist.
import { register } from "node:module";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const loaderHookPath = path.join(root, "dist/main/host/loader-hook.js");
const sdkPath = path.join(root, "dist/main/host/sdk.mjs");

async function assertExists(filePath) {
  try {
    await fs.access(filePath);
  } catch {
    throw new Error(`Expected built file at ${filePath} — did \`bun run build\` run first?`);
  }
}

async function main() {
  await assertExists(loaderHookPath);
  await assertExists(sdkPath);

  register(pathToFileURL(loaderHookPath).href);

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "canvas-sdk-smoke-"));
  const serverPath = path.join(tempDir, "server.mjs");
  try {
    // The exact import shape entry.ts documents and every real canvas
    // server.mjs will use.
    await fs.writeFile(
      serverPath,
      `import { defineCanvas, z } from "@aichemist/canvas";
export default defineCanvas({
  tools: {
    ping: {
      description: "ping",
      input: z.object({}),
      handler: () => "pong",
    },
  },
});
`,
    );

    const mod = await import(pathToFileURL(serverPath).href);
    const definition = mod.default;
    if (typeof definition !== "object" || definition === null) {
      throw new Error("server.mjs did not default-export an object from defineCanvas()");
    }
    const result = definition.tools?.ping?.handler?.({}, /* ctx */ undefined);
    if (result !== "pong") {
      throw new Error(`Expected the ping tool's handler to return "pong", got ${JSON.stringify(result)}`);
    }
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }

  console.log("[smoke:canvas-sdk] OK — @aichemist/canvas resolves and its named exports work from the built output.");
}

main().catch((err) => {
  console.error("[smoke:canvas-sdk] FAILED:", err);
  process.exitCode = 1;
});
