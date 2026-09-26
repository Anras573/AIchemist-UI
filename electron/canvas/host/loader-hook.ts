/**
 * A Node ESM loader hook (registered via `node:module`'s `register()` in
 * `entry.ts`) that makes the SDK resolvable to canvas `server.mjs` modules as
 * a bare specifier — `import { defineCanvas, z } from "@aichemist/canvas"` —
 * with no install step, since it's just this host's own `sdk.ts`.
 *
 * Resolves to `sdk.mjs`, built as real ESM by
 * `scripts/build-canvas-sdk-esm.mjs` (NOT `sdk.js` alongside this file —
 * this file's own CommonJS build has no output for `sdk.ts` at all; see that
 * script's header for why a CJS build can't satisfy this named import).
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
    return { url: pathToFileURL(nodePath.join(__dirname, "sdk.mjs")).href, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
