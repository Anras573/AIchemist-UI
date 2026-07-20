import { defineConfig } from "electron-vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";

export default defineConfig({
  main: {
    build: {
      externalizeDeps: true,
      outDir: "dist/main",
      lib: {
        entry: path.resolve(__dirname, "electron/main.ts"),
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
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: { "@": path.resolve(__dirname, "./src") },
    },
  },
});
