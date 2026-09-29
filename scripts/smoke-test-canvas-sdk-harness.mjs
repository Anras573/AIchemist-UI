// The actual verification step for smoke-test-canvas-sdk.mjs, spawned as its
// own process under Electron's bundled Node (ELECTRON_RUN_AS_NODE=1) rather
// than run inline under the outer script's `node` — see that script's header
// for why (#227 review round 4: a bug in the loader hook only reproduced
// under Electron's actual Node version, and was invisible under the sandbox's
// system Node). `argv[2]` is the absolute path to the built `loader-hook.js`;
// `argv[3]` is a scratch directory to write a throwaway `server.mjs` into.
import { registerHooks } from "node:module";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

async function main() {
  const [loaderHookPath, tempDir] = process.argv.slice(2);
  if (!loaderHookPath || !tempDir) {
    throw new Error("Usage: smoke-test-canvas-sdk-harness.mjs <loaderHookPath> <tempDir>");
  }

  const { resolve, setDefinitionDirForHooks } = await import(pathToFileURL(loaderHookPath).href);
  setDefinitionDirForHooks(tempDir);
  registerHooks({ resolve });

  // The exact import shape entry.ts documents and every real canvas
  // server.mjs will use.
  const serverPath = path.join(tempDir, "server.mjs");
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
}

main().catch((err) => {
  console.error("[smoke-test-canvas-sdk-harness] FAILED:", err);
  process.exitCode = 1;
});
