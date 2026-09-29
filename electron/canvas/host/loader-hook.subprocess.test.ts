import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as os from "node:os";
import * as nodePath from "node:path";
import { buildSync } from "esbuild";
import { describe, expect, it } from "vitest";

/**
 * `module.registerHooks()` (round 3 of review on PR #238 — see
 * `loader-hook.ts`'s docstring) has process-wide, unregisterable side
 * effects: once called, every subsequent `require`/`import` in that process
 * goes through it, with no documented way to undo the registration. Calling
 * it inside the shared vitest worker would corrupt every other test's module
 * loading that runs afterward in the same worker. So the handful of behaviors
 * that only manifest through Node's *real* require/import machinery — the
 * `createRequire()` / `process.getBuiltinModule("module").createRequire()`
 * escape attempts actually being blocked, a planted
 * `<project>/node_modules/zod` actually being ignored in favor of the app's
 * own copy, and (round 4) the whole thing not recursing itself into a stack
 * overflow — are exercised here by spawning a throwaway subprocess per
 * scenario, each running a small harness script that registers the hook for
 * real and reports what happened as JSON on stdout.
 *
 * **Runs under Electron's own bundled `node`, not system `node`/`bun`**
 * (`ELECTRON_RUN_AS_NODE=1` against the `electron` binary this repo already
 * depends on) — round 4 of review found a real regression (every canvas
 * failing to start with `RangeError: Maximum call stack size exceeded`) that
 * only reproduced under Electron 44's actual Node (24.21) and was invisible
 * under this sandbox's system Node (22): `registerHooks()`'s hook chain also
 * intercepts `require.resolve()` calls made *from inside* a hook on Node 24,
 * which system Node 22 apparently doesn't. The previous version of this test
 * spawned plain `node`/`bun` and so passed despite the bug — "the test
 * runtime differs from the host runtime" is exactly the gap the reviewer
 * called out, and it's the second canvas bug in a row caused by it. Probed
 * once at suite load (spawning the Electron binary itself, not assuming it
 * works) and the whole suite skips — rather than failing — if that binary
 * can't run `registerHooks()` for some reason, since that's an environment
 * gap, not a code regression.
 *
 * The harness imports a real, esbuild-bundled copy of `loader-hook.ts` (not
 * the raw `.ts` source, since running it under Electron's Node can't rely on
 * type-stripping either) so it's exercising the actual shipped logic, not a
 * reimplementation of it.
 *
 * `loader-hook.test.ts` covers everything else (the SDK/zod short-circuits,
 * the import-scope check against a fake `nextResolve`) in-process, since none
 * of that requires an actual hook registration.
 */

const LOADER_HOOK_PATH = nodePath.join(__dirname, "loader-hook.ts");

/**
 * The `electron` package's main export is (unusually) just the absolute path
 * to its platform binary as a plain string — not the `Electron.CrossProcessExports`
 * namespace its own `.d.ts` declares for the *runtime* API surface, which
 * only exists inside a real Electron process. `createRequire` sidesteps that
 * mismatched ambient type rather than fighting it with an import.
 */
const ELECTRON_BINARY_PATH = createRequire(__filename)("electron") as unknown as string;

/** Runs `node` code via Electron's bundled Node, exactly as `entry.ts` runs at app runtime — see this file's module docstring for why that distinction matters. */
function spawnElectronAsNode(args: string[], opts: { timeout?: number; env?: NodeJS.ProcessEnv } = {}) {
  return spawnSync(ELECTRON_BINARY_PATH, args, {
    encoding: "utf8",
    timeout: opts.timeout ?? 15_000,
    env: { ...process.env, ...opts.env, ELECTRON_RUN_AS_NODE: "1" },
  });
}

function registerHooksSupported(): boolean {
  const probe = spawnElectronAsNode(["-e", "console.log(typeof require('node:module').registerHooks)"]);
  return probe.status === 0 && probe.stdout.trim() === "function";
}

const REGISTER_HOOKS_SUPPORTED = registerHooksSupported();

/**
 * Bundles `loader-hook.ts` (and its `import-scope.ts` dependency) into a
 * single, dependency-free file a plain `node` invocation can run directly.
 * Compiled as **CommonJS**, matching how `electron-vite`'s real "main" build
 * actually compiles it (see `electron.vite.config.ts`) — `loader-hook.ts`
 * relies on `__filename` (via `createRequire(__filename)`, to pin `zod` to
 * the app's own copy) and `__dirname` (to locate the SDK build output), both
 * of which are CJS-only globals; an ESM bundle would leave them undefined.
 * Written out with a `.cjs` extension so Node parses it as CommonJS
 * regardless of the temp directory's own module-type inference, and imported
 * from the (ESM) harness the same way `entry.ts`'s real build output is
 * imported — a named import through Node's CJS/ESM interop.
 */
function bundleLoaderHook(): string {
  const result = buildSync({
    entryPoints: [LOADER_HOOK_PATH],
    bundle: true,
    platform: "node",
    format: "cjs",
    write: false,
    target: "node22",
  });
  return result.outputFiles[0].text;
}

interface HarnessResult {
  ok: boolean;
  detail: string;
}

/**
 * The repo's own `node_modules` — passed to the harness subprocess via
 * `NODE_PATH` (below) rather than by placing the harness's support files
 * inside the repo tree. `createRequire(__filename).resolve("zod")` in the
 * bundled loader hook is anchored at *its own* file location, which in this
 * test is a throwaway temp directory unrelated to the repo, so without this
 * it would fail to resolve `zod` at all (there's no real dependency tree
 * above a bare OS temp dir) rather than correctly finding the app's copy.
 * `NODE_PATH` is consulted by Node's CJS resolver as a fallback search path,
 * which is exactly the case `createRequire(...).resolve()` exercises here —
 * this reproduces "resolves to the app's own copy" without needing to write
 * temp fixtures into the actual repository.
 */
const REPO_NODE_MODULES = nodePath.join(process.cwd(), "node_modules");

function runHarness(projectDir: string, defDir: string, scenario: string): HarnessResult {
  // Nested dist/main/host/ + a sibling dist/canvas-sdk/, mirroring the real
  // build layout (electron.vite.config.ts) — loader-hook.ts locates the SDK
  // build via a path relative to its own __dirname, so the sdk-import
  // regression scenario below needs that same relative shape to mean
  // anything. Harmless for every other scenario, which doesn't touch the SDK.
  const supportDir = nodePath.join(projectDir, "__support__");
  const hostDir = nodePath.join(supportDir, "dist", "main", "host");
  const sdkDir = nodePath.join(supportDir, "dist", "canvas-sdk");
  fs.mkdirSync(hostDir, { recursive: true });
  fs.mkdirSync(sdkDir, { recursive: true });

  const compiledHookPath = nodePath.join(hostDir, "loader-hook.compiled.cjs");
  fs.writeFileSync(compiledHookPath, bundleLoaderHook());
  // A minimal stand-in for the real dist/canvas-sdk/sdk.mjs — re-exports the
  // app's real `zod` (via NODE_PATH, same as the rest of this harness) so the
  // sdk-import scenario exercises the actual "zod resolved twice" shape
  // (once for the SDK's own import, once for the canvas's) without needing
  // the real sdk.ts build step.
  fs.writeFileSync(
    nodePath.join(sdkDir, "sdk.mjs"),
    `import { z } from "zod";\nexport { z };\nexport function defineCanvas(def) { return def; }\n`
  );

  const harnessPath = nodePath.join(supportDir, "harness.mjs");
  fs.writeFileSync(
    harnessPath,
    `
import { registerHooks } from "node:module";
import { resolve, setDefinitionDirForHooks } from ${JSON.stringify(compiledHookPath)};

setDefinitionDirForHooks(${JSON.stringify(defDir)});
registerHooks({ resolve });

const scenario = ${JSON.stringify(scenario)};
const defDir = ${JSON.stringify(defDir)};

function report(ok, detail) {
  console.log(JSON.stringify({ ok, detail }));
}

async function main() {
  if (scenario === "require-outside-blocked") {
    const { createRequire } = await import("node:module");
    const req = createRequire(import.meta.url);
    try {
      req(defDir + "/../outside/evil.cjs");
      report(false, "require() of an outside absolute path did not throw");
    } catch (err) {
      report(true, String(err && err.message));
    }
    return;
  }

  if (scenario === "create-require-import-meta-outside-blocked") {
    const { createRequire } = await import("node:module");
    const req = createRequire(import.meta.url);
    try {
      req(defDir + "/../outside/evil.cjs");
      report(false, "createRequire(import.meta.url)(...) of an outside path did not throw");
    } catch (err) {
      report(true, String(err && err.message));
    }
    return;
  }

  if (scenario === "process-get-builtin-module-create-require-outside-blocked") {
    const req = process.getBuiltinModule("module").createRequire(import.meta.url);
    try {
      req(defDir + "/../outside/evil.cjs");
      report(false, "process.getBuiltinModule('module').createRequire(...) of an outside path did not throw");
    } catch (err) {
      report(true, String(err && err.message));
    }
    return;
  }

  if (scenario === "require-inside-allowed") {
    const { createRequire } = await import("node:module");
    const req = createRequire(import.meta.url);
    try {
      const mod = req(defDir + "/inside.cjs");
      report(mod && mod.marker === "INSIDE", "require()'d inside module: " + JSON.stringify(mod));
    } catch (err) {
      report(false, "require() of an inside path unexpectedly threw: " + String(err && err.message));
    }
    return;
  }

  if (scenario === "planted-zod-ignored") {
    // Requires a helper module that itself sits INSIDE the definition
    // folder, directly alongside the planted node_modules/zod — the actual
    // shape of the vulnerability (a canvas's own server.mjs, or a module it
    // imports, doing "import { z } from 'zod'" or "require('zod')"). Node's
    // normal upward node_modules search from there would hit the planted
    // fake before ever reaching the app's own copy; the fix must return the
    // app's copy regardless of who's asking.
    const { createRequire } = await import("node:module");
    const req = createRequire(import.meta.url);
    const mod = req(defDir + "/zod-consumer.cjs");
    report(mod && mod.PLANTED !== true, "require('zod') result keys: " + JSON.stringify(Object.keys(mod || {})));
    return;
  }

  if (scenario === "sdk-import-no-recursion") {
    // #227 review round 4: importing the real @aichemist/canvas SDK (which
    // itself imports zod) used to overflow the call stack under Electron's
    // Node — resolving "zod" from *inside* the hook re-entered the hook,
    // forever. This is the actual shape of every real canvas's server.mjs,
    // so it's the most direct regression test for that bug.
    const mod = await import(defDir + "/server.mjs");
    const definition = mod.default;
    const ok = typeof definition === "object" && definition !== null && typeof definition.tools?.ping?.handler === "function";
    let result;
    if (ok) result = definition.tools.ping.handler({}, undefined);
    report(ok && result === "pong", "server.mjs default export: " + JSON.stringify(definition));
    return;
  }

  report(false, "unknown scenario: " + scenario);
}

main().catch((err) => {
  report(false, "harness threw: " + String((err && err.stack) || err));
});
`
  );

  const result = spawnElectronAsNode([harnessPath], { env: { NODE_PATH: REPO_NODE_MODULES } });
  if (result.error) {
    throw new Error(`Failed to spawn Electron-as-node harness: ${result.error.message}`);
  }
  const lastLine = result.stdout.trim().split("\n").filter(Boolean).pop();
  if (!lastLine) {
    throw new Error(`Harness produced no output.\nstdout: ${result.stdout}\nstderr: ${result.stderr}`);
  }
  try {
    return JSON.parse(lastLine) as HarnessResult;
  } catch {
    throw new Error(`Harness output was not valid JSON: ${lastLine}\nstderr: ${result.stderr}`);
  }
}

function setupProject(): { projectDir: string; defDir: string; cleanup: () => void } {
  const projectDir = fs.mkdtempSync(nodePath.join(os.tmpdir(), "loader-hook-subproc-"));
  const defDir = nodePath.join(projectDir, "canvas");
  fs.mkdirSync(defDir, { recursive: true });
  fs.writeFileSync(nodePath.join(defDir, "inside.cjs"), 'module.exports = { marker: "INSIDE" };\n');

  const outsideDir = nodePath.join(projectDir, "outside");
  fs.mkdirSync(outsideDir, { recursive: true });
  fs.writeFileSync(nodePath.join(outsideDir, "evil.cjs"), 'module.exports = { marker: "EVIL" };\n');

  // For the "sdk-import-no-recursion" scenario — the exact shape of a real
  // canvas's server.mjs.
  fs.writeFileSync(
    nodePath.join(defDir, "server.mjs"),
    `import { defineCanvas, z } from "@aichemist/canvas";
export default defineCanvas({
  tools: {
    ping: { description: "ping", input: z.object({}), handler: () => "pong" },
  },
});
`
  );

  return {
    projectDir,
    defDir,
    cleanup: () => fs.rmSync(projectDir, { recursive: true, force: true }),
  };
}

describe.skipIf(!REGISTER_HOOKS_SUPPORTED)(
  "loader-hook — registerHooks() confinement (real subprocess under Electron's Node, #227 review rounds 3-4)",
  () => {
    if (!REGISTER_HOOKS_SUPPORTED) {
      // eslint-disable-next-line no-console
      console.warn(
        "[loader-hook.subprocess.test.ts] Skipped: couldn't run module.registerHooks() via the local " +
          "`electron` package's bundled Node (ELECTRON_RUN_AS_NODE). This is an environment gap, not a code regression."
      );
    }

    it("blocks a require() escape to an absolute path outside the definition folder", () => {
      const { projectDir, defDir, cleanup } = setupProject();
      try {
        const result = runHarness(projectDir, defDir, "require-outside-blocked");
        expect(result.ok).toBe(true);
      } finally {
        cleanup();
      }
    });

    it("blocks createRequire(import.meta.url)(...) escaping to an outside absolute path", () => {
      const { projectDir, defDir, cleanup } = setupProject();
      try {
        const result = runHarness(projectDir, defDir, "create-require-import-meta-outside-blocked");
        expect(result.ok).toBe(true);
      } finally {
        cleanup();
      }
    });

    it("blocks process.getBuiltinModule('module').createRequire(...) escaping to an outside absolute path", () => {
      const { projectDir, defDir, cleanup } = setupProject();
      try {
        const result = runHarness(projectDir, defDir, "process-get-builtin-module-create-require-outside-blocked");
        expect(result.ok).toBe(true);
      } finally {
        cleanup();
      }
    });

    it("still allows require() of a module inside the definition folder", () => {
      const { projectDir, defDir, cleanup } = setupProject();
      try {
        const result = runHarness(projectDir, defDir, "require-inside-allowed");
        expect(result.ok).toBe(true);
      } finally {
        cleanup();
      }
    });

    it("ignores a project-planted node_modules/zod and resolves the app's own copy instead", () => {
      const { projectDir, defDir, cleanup } = setupProject();
      try {
        const plantedDir = nodePath.join(defDir, "node_modules", "zod");
        fs.mkdirSync(plantedDir, { recursive: true });
        fs.writeFileSync(
          nodePath.join(plantedDir, "package.json"),
          JSON.stringify({ name: "zod", version: "0.0.0", main: "index.js" })
        );
        fs.writeFileSync(nodePath.join(plantedDir, "index.js"), "module.exports = { PLANTED: true };\n");
        fs.writeFileSync(nodePath.join(defDir, "zod-consumer.cjs"), "module.exports = require('zod');\n");

        const result = runHarness(projectDir, defDir, "planted-zod-ignored");
        expect(result.ok).toBe(true);
      } finally {
        cleanup();
      }
    });

    // #227 review round 4's actual regression: this exact import shape (a
    // real canvas's server.mjs importing @aichemist/canvas, which imports
    // zod) crashed every canvas under Electron's Node with a stack overflow.
    it("does not recurse into a stack overflow when a canvas imports the real SDK (which imports zod)", () => {
      const { projectDir, defDir, cleanup } = setupProject();
      try {
        const result = runHarness(projectDir, defDir, "sdk-import-no-recursion");
        expect(result.ok).toBe(true);
      } finally {
        cleanup();
      }
    });
  }
);
