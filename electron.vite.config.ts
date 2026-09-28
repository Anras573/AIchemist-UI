import { defineConfig } from "electron-vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { visualizer } from "rollup-plugin-visualizer";
import path from "path";

// ANALYZE=true bun run build writes dist/renderer/bundle-stats.html — a
// treemap of the renderer bundle for verifying code-split wins (issue #181).
const analyze = process.env.ANALYZE === "true";

export default defineConfig({
  main: {
    build: {
      externalizeDeps: true,
      outDir: "dist/main",
      lib: {
        // Multiple entries built into the same "main" output: the app's own
        // entry point, and the canvas host bootstrap chain (#222/#223). The
        // host is a `utilityProcess.fork()` target — see
        // electron/canvas/host-manager.ts's `resolveCanvasHostEntryPath()`,
        // which expects the compiled output at `dist/main/host/entry.js`, i.e.
        // right next to `dist/main/main.js`. Before this (#223), nothing built
        // `host/*.ts`, so a packaged app had no host to spawn.
        //
        // `loader-hook.ts` stays a separate entry even after round 3 of
        // review on PR #238 switched `entry.ts` from `module.register()`'s
        // by-URL registration (which required a standalone module file to
        // point a URL at) to `module.registerHooks()`, called as a plain
        // in-process function — `entry.ts` now just imports it like any other
        // dependency (`loader.ts`/`runtime.ts`), and Rollup's shared-chunking
        // keeps that a single module instance. It remains its own entry so
        // `scripts/smoke-test-canvas-sdk.mjs` can still exercise the exact
        // BUILT `dist/main/host/loader-hook.js`, not just the TS source the
        // vitest suite imports.
        //
        // `host/sdk.ts` is deliberately NOT built here — this "main" build
        // emits CommonJS, and a CJS build of `sdk.ts` can't satisfy a canvas
        // `server.mjs`'s `import { defineCanvas, z } from "@aichemist/canvas"`
        // (Node's CJS/ESM interop can't see the named `z` re-export through a
        // CJS getter). It's built separately, as real ESM, by
        // scripts/build-canvas-sdk-esm.mjs, to `dist/canvas-sdk/sdk.mjs` — a
        // SIBLING of this build's own `outDir` (`dist/main`), not a
        // subdirectory of it: this "main" build (and `electron-vite preview`'s
        // internal rebuild before it launches Electron) empties `dist/main`
        // on every invocation, so a `host/sdk.mjs` written inside it by a
        // later step would only survive until the next thing that rebuilds
        // `dist/main` — see that script's header for the incident (#225's
        // review on PR #236) this design avoids. It's run as a step of both
        // package.json's "build" and "dev" scripts (electron-vite's watch
        // mode never re-runs it on its own, so a canvas host would otherwise
        // fail to start with "no such file ... sdk.mjs" the first time
        // `bun run dev` is used after a fresh checkout) — `loader-hook.ts`
        // resolves `@aichemist/canvas` to that output path.
        entry: {
          main: path.resolve(__dirname, "electron/main.ts"),
          "host/entry": path.resolve(__dirname, "electron/canvas/host/entry.ts"),
          "host/loader-hook": path.resolve(__dirname, "electron/canvas/host/loader-hook.ts"),
        },
      },
      rollupOptions: {
        // These ESM-only SDKs use import.meta.resolve() internally and must not
        // be bundled — keep them as native dynamic imports at runtime.
        external: [
          "@github/copilot-sdk",
          "@anthropic-ai/claude-agent-sdk",
          "ai",
          "@ai-sdk/openai-compatible",
        ],
      },
    },
  },
  preload: {
    build: {
      externalizeDeps: true,
      outDir: "dist/preload",
      rollupOptions: {
        input: path.resolve(__dirname, "electron/preload.ts"),
      },
    },
  },
  renderer: {
    root: ".",
    build: {
      outDir: "dist/renderer",
      rollupOptions: {
        input: "./index.html",
      },
    },
    plugins: [
      react(),
      tailwindcss(),
      ...(analyze
        ? [visualizer({ filename: "dist/renderer/bundle-stats.html", gzipSize: true, template: "treemap" })]
        : []),
    ],
    resolve: {
      alias: { "@": path.resolve(__dirname, "./src") },
    },
  },
});
