// Builds electron/canvas/host/sdk.ts as a standalone ESM file
// (dist/canvas-sdk/sdk.mjs), run as a second build step after `electron-vite
// build` (see package.json's "build" script).
//
// Why this can't just be another electron-vite "main" lib entry (like
// host/entry.ts and host/loader-hook.ts): the whole "main" build emits
// CommonJS, and `sdk.ts` re-exports `z` from zod as a named export
// (`export { z }`). A canvas `server.mjs` imports it as
// `import { defineCanvas, z } from "@aichemist/canvas"` — Node's CJS/ESM
// interop can't see that named export through a CJS `Object.defineProperty`
// getter, so that import throws `does not provide an export named 'z'` at
// runtime (#223's review, https://github.com/Anras573/AIchemist-UI/pull/234).
// A real ESM build has no such interop step, so the named import just works.
//
// Why `dist/canvas-sdk/` and not `dist/main/host/`: electron-vite's "main"
// build (electron.vite.config.ts) empties its whole `outDir` (`dist/main`)
// on EVERY invocation — not just the first — including the internal rebuild
// `electron-vite preview` runs before launching Electron. A file written
// into `dist/main/` by this script, run as a separate step afterward, would
// survive that one invocation but get wiped by the next one that touches
// `dist/main` (e.g. `bun run build` then `bun run start` — #225's review
// caught this: https://github.com/Anras573/AIchemist-UI/pull/236). Writing
// outside `dist/main` entirely sidesteps the emptying altogether, so this
// only needs to be regenerated when `sdk.ts` itself changes, independent of
// how many times `dist/main` gets rebuilt.
//
// `loader-hook.ts` resolves the `@aichemist/canvas` specifier to this exact
// output path.
import { build } from "esbuild";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");

await build({
  entryPoints: [path.join(root, "electron/canvas/host/sdk.ts")],
  outfile: path.join(root, "dist/canvas-sdk/sdk.mjs"),
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node20",
  // zod is a runtime dependency of the packaged app already (electron-vite's
  // "main" build externalizes it the same way) — keep it a bare import
  // resolved from node_modules rather than bundling a second copy.
  external: ["zod"],
  logLevel: "info",
});
