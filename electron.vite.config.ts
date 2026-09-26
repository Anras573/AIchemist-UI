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
        // `loader-hook.ts` and `sdk.ts` must ALSO be separate entries, not
        // just modules `entry.ts` bundles in: `entry.ts` registers
        // `host/loader-hook.js` with Node's `module.register()` by file URL
        // (a loader hook runs as its own module in a separate loader thread,
        // so it can't be inlined into `entry.js`'s bundle), and that hook in
        // turn resolves `@aichemist/canvas` to `host/sdk.js` by file URL for
        // an arbitrary canvas `server.mjs` to import at runtime — a file path
        // only exists to resolve if `sdk.ts` was built standalone.
        entry: {
          main: path.resolve(__dirname, "electron/main.ts"),
          "host/entry": path.resolve(__dirname, "electron/canvas/host/entry.ts"),
          "host/loader-hook": path.resolve(__dirname, "electron/canvas/host/loader-hook.ts"),
          "host/sdk": path.resolve(__dirname, "electron/canvas/host/sdk.ts"),
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
