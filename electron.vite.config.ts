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
        // `loader-hook.ts` must ALSO be a separate entry, not just a module
        // `entry.ts` bundles in: `entry.ts` registers `host/loader-hook.js`
        // with Node's `module.register()` by file URL (a loader hook runs as
        // its own module in a separate loader thread, so it can't be inlined
        // into `entry.js`'s bundle).
        //
        // `host/sdk.ts` is deliberately NOT built here — this "main" build
        // emits CommonJS, and a CJS build of `sdk.ts` can't satisfy a canvas
        // `server.mjs`'s `import { defineCanvas, z } from "@aichemist/canvas"`
        // (Node's CJS/ESM interop can't see the named `z` re-export through a
        // CJS getter). It's built separately, as real ESM, by
        // scripts/build-canvas-sdk-esm.mjs (see package.json's "build"
        // script) — `loader-hook.ts` resolves `@aichemist/canvas` to that
        // output path.
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
