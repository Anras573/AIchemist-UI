// Smoke test for the canvas host bootstrap chain's BUILT output (#223's
// review, https://github.com/Anras573/AIchemist-UI/pull/234). Unlike the
// vitest suite — which imports host/loader.ts and host/sdk.ts directly as TS
// source and so never exercises the compiled `dist/main/host/*` files or the
// real registered loader hook — this script does exactly what `entry.ts`
// does: import the built loader hook's `resolve` and register it with
// `module.registerHooks()` (round 3 of review on PR #238 switched away from
// `module.register()`'s by-URL registration — see `loader-hook.ts`'s
// docstring), then import `@aichemist/canvas` by its documented named import.
//
// The actual registration + import step runs in a **separate process spawned
// under Electron's own bundled Node** (`smoke-test-canvas-sdk-harness.mjs`,
// via `ELECTRON_RUN_AS_NODE=1`), not inline under this script's own `node` —
// round 4 of review on PR #238 found a real regression (every canvas failing
// to start with a stack overflow) that only reproduced under Electron 44's
// actual Node (24.21) and was invisible under plain `node`/`bun` (this
// sandbox's system Node is 22, which doesn't have the same behavior). This
// script still orchestrates the build/file-existence checks under whatever
// `node` invoked it — only the part that actually exercises the loader hook
// needs to run under Electron's Node.
//
// Run after `bun run build` (see package.json's "smoke:canvas-sdk" script
// and the CI workflow) — `dist/main/host/loader-hook.js` and
// `dist/canvas-sdk/sdk.mjs` must exist.
import { createRequire } from "node:module";
import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const loaderHookPath = path.join(root, "dist/main/host/loader-hook.js");
const sdkPath = path.join(root, "dist/canvas-sdk/sdk.mjs");
const harnessPath = path.join(root, "scripts/smoke-test-canvas-sdk-harness.mjs");
// See loader-hook.subprocess.test.ts's comment on the same pattern: the
// `electron` package's main export is the absolute path to its platform
// binary, as a plain string.
const electronBinaryPath = createRequire(import.meta.url)("electron");

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

  // Regression check for #225's review on PR #236: `electron-vite preview`
  // (package.json's "start" script) runs a second, full `electron-vite
  // build` internally before launching Electron, which empties `dist/main`
  // — the exact thing that used to delete a `host/sdk.mjs` written inside it
  // by a step that ran only once, right after the FIRST build. Simulate that
  // second invocation directly and prove `sdk.mjs` — now built to
  // `dist/canvas-sdk/`, a sibling of `dist/main` rather than a subdirectory
  // of it — survives it untouched.
  execFileSync(path.join(root, "node_modules/.bin/electron-vite"), ["build"], {
    cwd: root,
    stdio: "inherit",
  });
  await assertExists(loaderHookPath);
  await assertExists(sdkPath);

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "canvas-sdk-smoke-"));
  try {
    const result = spawnSync(electronBinaryPath, [harnessPath, loaderHookPath, tempDir], {
      cwd: root,
      stdio: "inherit",
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    });
    if (result.error) {
      throw new Error(`Failed to spawn Electron-as-node harness: ${result.error.message}`);
    }
    if (result.status !== 0) {
      throw new Error(`Harness exited with status ${result.status} — see its output above.`);
    }
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }

  console.log(
    "[smoke:canvas-sdk] OK — @aichemist/canvas resolves and its named exports work from the built output, under Electron's own Node.",
  );
}

main().catch((err) => {
  console.error("[smoke:canvas-sdk] FAILED:", err);
  process.exitCode = 1;
});
