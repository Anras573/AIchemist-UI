/**
 * Confines what a canvas host process can load, registered via `node:module`'s
 * **synchronous** `registerHooks()` in `entry.ts` — not the async `register()`
 * this file used before round 3 of review on PR #238. Three jobs:
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
 * 2. Pins `"zod"` to the app's own copy, resolved from **this file's own
 *    location** via `createRequire` rather than delegated to `nextResolve()`
 *    (round 3 finding): `nextResolve()` resolves relative to the *importer*
 *    (the canvas's `server.mjs`), so Node's normal upward `node_modules`
 *    search from there can land on a project-controlled, unhashed
 *    `<project>/node_modules/zod` — reproduced: a planted one loaded and ran,
 *    even though the approved code just looks like an innocuous `import
 *    "zod"`. Anchoring the lookup at `dist/main/host/` (this file's own
 *    compiled location, walking up into the *app's* `node_modules`) instead
 *    makes it exactly as safe as the SDK case above, which never delegates to
 *    the importer either. **The actual resolution happens once, at module
 *    load** (`RESOLVED_ZOD`, computed before `entry.ts` ever calls
 *    `registerHooks()`) — round 4 of review found that resolving `"zod"`
 *    *inside* the `resolve()` hook recurses infinitely under Node 24
 *    (Electron 44's bundled runtime): `registerHooks()` there also
 *    intercepts `require.resolve()` itself, so a resolve call made from
 *    within the hook re-enters the hook, forever. Reproduced with the real
 *    compiled `entry.js` in a real Electron `utilityProcess` — every canvas
 *    failed to start with `RangeError: Maximum call stack size exceeded`.
 *    System Node 22 doesn't reproduce this, which is why the previous
 *    version looked fine under `smoke:canvas-sdk` and the subprocess test
 *    (both ran under system `node`) — see `RESOLVED_ZOD`'s own docstring for
 *    the full account, and `loader-hook.subprocess.test.ts` for why those
 *    tests now spawn Electron's own `node` (via `ELECTRON_RUN_AS_NODE`)
 *    instead.
 * 3. Confines every other import (and, since `registerHooks()` — unlike the
 *    old `register()` — intercepts CommonJS `require()` too, every require)
 *    to the same scope the content hash covers (#227 review round 2) — see
 *    `import-scope.ts`'s docstring. `setDefinitionDirForHooks()` receives the
 *    definition folder from `entry.ts`, which (since `registerHooks()` runs
 *    hooks in the *same* thread/realm as the code calling it, unlike
 *    `register()`'s dedicated loader thread) can just call it directly — no
 *    more `initialize()`/`data`-option indirection needed. `resolve()` lets
 *    Node do its normal resolution first (so this never has to reimplement
 *    Node's own specifier/exports-map/CJS algorithm), then checks the
 *    *result*.
 *
 * Round 3 also found `register()`'s async hooks — which run in a dedicated
 * loader thread — never apply to `require()` at all (reproduced: a canvas
 * reaching CommonJS via `createRequire()`, or even
 * `process.getBuiltinModule("module").createRequire(...)`, loaded arbitrary
 * files with zero checks). `registerHooks()` is Node's synchronous,
 * same-thread alternative specifically built to cover both `import` and
 * `require` with one hook chain — available since Node 22.15, well within
 * Electron 44's bundled Node (24.21).
 *
 * Unlike the old `register()`-based version, this file *can* be exercised
 * outside a full host process — `registerHooks()` has process-wide,
 * unregisterable side effects, so it must never run inside the shared vitest
 * worker (it would corrupt every other test's module loading in the same
 * process), but it's plain synchronous Node code, so
 * `loader-hook.subprocess.test.ts` spawns a throwaway subprocess per test to
 * call it for real — under Electron's own bundled `node` (via
 * `ELECTRON_RUN_AS_NODE=1`), not system `node`/`bun`, since round 4 of review
 * found a recursion bug that only reproduced under Electron's actual Node
 * version (24) and not the sandbox's system Node (22). The import-scope
 * *decision* itself still lives in the pure `import-scope.ts`, with its own
 * in-process unit tests, same reasoning as before.
 *
 * **Scope note (round 4 of review):** everything in this file guards against
 * the module graph *silently* changing after the user trusted it — an
 * innocuous-looking `import "zod"` or `require("some-pkg")` quietly loading
 * code that was never hashed or reviewed. It cannot and does not stop
 * approved code from deliberately working around it — e.g. a `server.mjs`
 * that calls `module.registerHooks()` itself (hooks chain, so a later
 * registration can still see resolutions this one already rewrote, but
 * nothing stops one from being *added*) or that `eval`s a string it read
 * from a file or a network response. That class of risk is accepted as
 * inherent to running a canvas's server code at all, the same as running any
 * local script — the trust prompt is consent to run the code, not a sandbox
 * against everything it could choose to do.
 */
import { createRequire, type ResolveFnOutput, type ResolveHookContext, type ResolveHookSync } from "node:module";
import * as nodePath from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isImportAllowed, isPathWithin } from "./import-scope";

export const CANVAS_SDK_SPECIFIER = "@aichemist/canvas";
const ZOD_SPECIFIER = "zod";

/**
 * Anchored at *this file's own* compiled location (`dist/main/host/` in a
 * packaged/dev build) — walking up from here reaches the app's own
 * `node_modules`, never a canvas's project directory. Used only for the
 * `"zod"` pin above; never exposed for resolving anything importer-relative.
 */
const requireFromHere = createRequire(__filename);

/**
 * `dist/canvas-sdk/` — a sibling of this file's own `dist/main/host/`. The
 * whole directory (not just `sdk.mjs`) is treated as a trusted root below,
 * in case the SDK build ever splits into more than one file.
 */
const CANVAS_SDK_DIR = nodePath.join(__dirname, "..", "..", "canvas-sdk");

interface ResolvedZod {
  /** `zod`'s real entry file, as a `file://` URL, ready to hand straight back from the hook. */
  entryUrl: string;
  /** The real `zod` package's own directory — see `isTrustedAppRoot`'s use below. */
  packageDir: string;
}

/**
 * Resolves `zod`'s entry file and package directory via `requireFromHere`,
 * **once, at module load** — i.e. while this file is still being imported by
 * `entry.ts`, strictly before it calls `registerHooks()`. This timing is not
 * cosmetic: round 4 of review on PR #238 found that resolving `zod` from
 * *inside* the `resolve()` hook (as this used to) recurses infinitely under
 * Node 24 (Electron 44's bundled runtime) — `registerHooks()` there also
 * intercepts `require.resolve()` itself, so `requireFromHere.resolve("zod")`
 * called from within `resolve()` re-enters `resolve("zod")`, which calls
 * `requireFromHere.resolve("zod")` again, forever, until `RangeError: Maximum
 * call stack size exceeded` — reproduced with the real compiled `entry.js` in
 * a real Electron `utilityProcess`: every canvas failed to start. System Node
 * 22 doesn't reproduce this (hooks apparently don't loop back onto
 * `require.resolve` there), which is why the version under system `node`
 * previously looked fine. Resolving here means the hook itself only ever
 * returns this precomputed value — no resolution call happens while hooks are
 * active, so there's nothing left to recurse through.
 *
 * `null` if `zod` can't be resolved for some reason — fails open to
 * delegating `"zod"` to `nextResolve()` in the hook below (the pre-pin
 * behavior) rather than crashing every canvas outright; this should not
 * happen in a real build, since `zod` is a direct dependency.
 */
const RESOLVED_ZOD: ResolvedZod | null = (() => {
  try {
    const packageJsonPath = requireFromHere.resolve(`${ZOD_SPECIFIER}/package.json`);
    const entryPath = requireFromHere.resolve(ZOD_SPECIFIER);
    return { entryUrl: pathToFileURL(entryPath).href, packageDir: nodePath.dirname(packageJsonPath) };
  } catch {
    return null;
  }
})();

// Re-exported so callers (and tests) can reference Node's own hook types by
// the same names `registerHooks({ resolve })` expects, instead of hand-rolled
// equivalents — a hand-rolled `context` type with a `[key: string]: unknown`
// index signature isn't assignable to `ResolveHookSync`'s real
// `ResolveHookContext` (no index signature), so `entry.ts`'s
// `registerHooks({ resolve: ... })` call wouldn't typecheck against one.
export type HookResolveContext = ResolveHookContext;
export type HookResolveResult = ResolveFnOutput;
export type NextResolve = (specifier: string, context?: Partial<HookResolveContext>) => HookResolveResult;

let definitionDir: string | null = null;

/**
 * Sets the running canvas's definition folder for `resolve()`'s confinement
 * check. Called directly by `entry.ts` before `registerHooks()` — no
 * `register()`-style `data`/`initialize()` indirection needed now that hooks
 * run in the same thread as the caller. Exported (rather than folded into a
 * single `createResolveHook(dir)` factory) so a test can flip it and call
 * `resolve()` directly without going through `registerHooks()` at all, for
 * the cases that don't need a real loader/require pipeline.
 */
export function setDefinitionDirForHooks(dir: string | null): void {
  definitionDir = dir;
}

/**
 * The synchronous `resolve` hook passed to `registerHooks({ resolve })`.
 * Node calls this for both `import` and `require()` resolution. Typed
 * directly against Node's own `ResolveHookSync` so `entry.ts`'s
 * `registerHooks({ resolve })` call is checked against the real hook
 * signature, not just this module's own aliases of it.
 */
export const resolve: ResolveHookSync = (specifier, context, nextResolve) => {
  if (specifier === CANVAS_SDK_SPECIFIER) {
    // __dirname here is dist/main/host (this file's own compiled location) —
    // ../../canvas-sdk/sdk.mjs is dist/canvas-sdk/sdk.mjs, a sibling of
    // dist/main rather than something inside it (see build-canvas-sdk-esm.mjs
    // for why: dist/main gets emptied on every electron-vite build/dev/preview
    // invocation, dist/canvas-sdk never does).
    const sdkPath = nodePath.join(__dirname, "..", "..", "canvas-sdk", "sdk.mjs");
    return { url: pathToFileURL(sdkPath).href, shortCircuit: true };
  }

  if (specifier === ZOD_SPECIFIER) {
    // Precomputed at module load (see RESOLVED_ZOD's docstring) — resolving
    // here instead, while the hook is active, is what caused the infinite
    // recursion under Node 24. A null RESOLVED_ZOD (zod unresolvable at
    // startup, which shouldn't happen in a real build) falls open to
    // nextResolve() rather than hard-failing every canvas.
    if (RESOLVED_ZOD) return { url: RESOLVED_ZOD.entryUrl, shortCircuit: true };
    return nextResolve(specifier, context);
  }

  const result = nextResolve(specifier, context);

  // A `node:` builtin (or anything else that doesn't resolve to a local
  // file — there isn't really another case in practice) has no "outside the
  // definition folder" to escape to, so only a `file:` result needs checking.
  if (definitionDir && result.url.startsWith("file://")) {
    const resolvedPath = fileURLToPath(result.url);
    const inDefinitionScope = isImportAllowed(resolvedPath, definitionDir);
    // The pinned `"zod"`/`"@aichemist/canvas"` specifiers above only cover
    // their own entry-point file. Once inside either package's own module
    // graph, its *internal* relative imports — e.g. zod's `index.js`
    // requiring its own `./v4/classic/external.cjs` — resolve to paths under
    // that package's directory, which is neither the entry-point file itself
    // nor inside the canvas's definition folder. Without this, a real,
    // legitimately-pinned dependency would break the moment it's split across
    // more than one file (discovered when this test suite's own "resolves to
    // the app's own zod" case exercised zod's real multi-file layout).
    const inTrustedAppRoot =
      isPathWithin(resolvedPath, CANVAS_SDK_DIR) ||
      (RESOLVED_ZOD !== null && isPathWithin(resolvedPath, RESOLVED_ZOD.packageDir));
    if (!inDefinitionScope && !inTrustedAppRoot) {
      throw new Error(
        `Canvas import "${specifier}" resolved to "${resolvedPath}", outside its definition folder ` +
          `(or its "ui/" subfolder) — refusing to load code that was never part of what got trusted.`
      );
    }
  }

  return result;
};
