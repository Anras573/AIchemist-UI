/**
 * A Node ESM loader hook (registered via `node:module`'s `register()` in
 * `entry.ts`) that makes the SDK resolvable to canvas `server.mjs` modules as
 * a bare specifier — `import { defineCanvas, z } from "@aichemist/canvas"` —
 * with no install step, since it's just this host's own `sdk.ts`.
 *
 * Resolves to `dist/canvas-sdk/sdk.mjs`, built as real ESM by
 * `scripts/build-canvas-sdk-esm.mjs` (NOT `sdk.js` alongside this file —
 * this file's own CommonJS build has no output for `sdk.ts` at all; see that
 * script's header for why a CJS build can't satisfy this named import, and
 * for why the output lives outside `dist/main` — a sibling of it, not a
 * subdirectory — rather than next to this file).
 *
 * Not unit-tested: exercising a registered loader hook needs a real ESM loader
 * thread, which only exists once this runs inside an actual host process. The
 * plain resolution logic below has nothing else worth asserting on in
 * isolation — everything that matters (definition shape, SDK semantics) is
 * covered via `loader.test.ts` and `runtime.test.ts` importing `sdk.ts`/
 * `loader.ts` directly.
 */
import * as nodePath from "node:path";
import { pathToFileURL } from "node:url";

export const CANVAS_SDK_SPECIFIER = "@aichemist/canvas";

type NextResolve = (specifier: string, context: unknown) => Promise<{ url: string; shortCircuit?: boolean }>;

export async function resolve(
  specifier: string,
  context: unknown,
  nextResolve: NextResolve
): Promise<{ url: string; shortCircuit?: boolean }> {
  if (specifier === CANVAS_SDK_SPECIFIER) {
    // __dirname here is dist/main/host (this file's own compiled location) —
    // ../../canvas-sdk/sdk.mjs is dist/canvas-sdk/sdk.mjs, a sibling of
    // dist/main rather than something inside it (see build-canvas-sdk-esm.mjs
    // for why: dist/main gets emptied on every electron-vite build/dev/preview
    // invocation, dist/canvas-sdk never does).
    const sdkPath = nodePath.join(__dirname, "..", "..", "canvas-sdk", "sdk.mjs");
    return { url: pathToFileURL(sdkPath).href, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
