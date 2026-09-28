/**
 * A Node ESM loader hook (registered via `node:module`'s `register()` in
 * `entry.ts`) with two jobs:
 *
 * 1. Makes the SDK resolvable to canvas `server.mjs` modules as a bare
 *    specifier — `import { defineCanvas, z } from "@aichemist/canvas"` —
 *    with no install step, since it's just this host's own `sdk.ts`.
 *    Resolves to `dist/canvas-sdk/sdk.mjs`, built as real ESM by
 *    `scripts/build-canvas-sdk-esm.mjs` (NOT `sdk.js` alongside this file —
 *    this file's own CommonJS build has no output for `sdk.ts` at all; see
 *    that script's header for why a CJS build can't satisfy this named
 *    import, and for why the output lives outside `dist/main` — a sibling of
 *    it, not a subdirectory — rather than next to this file).
 * 2. Confines every other import a canvas's code resolves to the same scope
 *    its content hash covers (#227 review on PR #238) — see
 *    `import-scope.ts`'s docstring for the full rationale and the two
 *    concrete escapes this closes (`ui/`, and the app's own `node_modules`).
 *    `initialize()` receives the definition folder from `entry.ts` via
 *    `register()`'s `data` option; `resolve()` lets Node do its normal
 *    resolution first (so this never has to reimplement Node's own
 *    specifier/exports-map algorithm), then checks the *result*.
 *
 * Not unit-tested itself: exercising a registered loader hook needs a real
 * ESM loader thread, which only exists once this runs inside an actual host
 * process. The actual decision logic for (2) lives in the pure, synchronous
 * `import-scope.ts` instead, specifically so it can be tested without one —
 * this file is thin wiring on top of it, plus the SDK special case, which has
 * nothing else worth asserting on in isolation. Everything else that matters
 * (definition shape, SDK semantics) is covered via `loader.test.ts` and
 * `runtime.test.ts` importing `sdk.ts`/`loader.ts` directly.
 */
import * as nodePath from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isImportAllowed } from "./import-scope";

export const CANVAS_SDK_SPECIFIER = "@aichemist/canvas";

/**
 * Bare specifiers resolved as Node normally would, bypassing the
 * definition-folder confinement below — these come from the app's own,
 * fully-trusted `node_modules`, not the canvas's, so there's nothing to
 * confine: `@aichemist/canvas` is the SDK itself (see case 1 above), and
 * `zod` is what its re-exported `z` is built on, which canvas code
 * legitimately imports directly for schemas too.
 */
const TRUSTED_BARE_SPECIFIERS = new Set<string>([CANVAS_SDK_SPECIFIER, "zod"]);

type NextResolve = (specifier: string, context: unknown) => Promise<{ url: string; shortCircuit?: boolean }>;

interface LoaderHookData {
  /** Absolute path to the running canvas's definition folder (`dirname(serverPath)`), or omitted/null to disable confinement. */
  definitionDir?: string | null;
}

let definitionDir: string | null = null;

/** Node calls this once, synchronously, when the hook is registered — see `register()`'s `data` option in `entry.ts`. */
export function initialize(data: LoaderHookData | undefined): void {
  definitionDir = data?.definitionDir ?? null;
}

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

  const result = await nextResolve(specifier, context);

  // A `node:` builtin (or anything else that doesn't resolve to a local
  // file — there isn't really another case in practice) has no "outside the
  // definition folder" to escape to, so only a `file:` result needs checking.
  if (definitionDir && !TRUSTED_BARE_SPECIFIERS.has(specifier) && result.url.startsWith("file://")) {
    const resolvedPath = fileURLToPath(result.url);
    if (!isImportAllowed(resolvedPath, definitionDir)) {
      throw new Error(
        `Canvas import "${specifier}" resolved to "${resolvedPath}", outside its definition folder ` +
          `(or its "ui/" subfolder) — refusing to load code that was never part of what got trusted.`
      );
    }
  }

  return result;
}
