import { defineConfig } from "vitest/config";
import path from "path";

const alias = { "@": path.resolve(__dirname, "./src") };

export default defineConfig({
  test: {
    projects: [
      // Renderer — React/browser code (jsdom)
      {
        test: {
          name: "renderer",
          environment: "jsdom",
          environmentOptions: { jsdom: { url: "http://localhost" } },
          setupFiles: ["src/test/setup.ts"],
          include: ["src/**/*.test.{ts,tsx}"],
        },
        resolve: { alias },
      },
      // Main process — Node.js code (electron/)
      {
        test: {
          name: "electron",
          environment: "node",
          include: ["electron/**/*.test.ts"],
        },
        resolve: { alias },
      },
    ],
  },
});
