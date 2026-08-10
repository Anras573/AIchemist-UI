import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";

const mathPlugin = { rehypePlugin: "math-rehype", remarkPlugin: "math-remark" };
const mermaidPlugin = { component: "mermaid-component" };

vi.mock("@streamdown/math", () => ({ math: mathPlugin }));
vi.mock("@streamdown/mermaid", () => ({ mermaid: mermaidPlugin }));

describe("useStreamdownPlugins", () => {
  // Each test re-imports the module fresh so the shared heavyPluginsPromise
  // cache doesn't leak resolved state across tests.
  beforeEach(() => {
    vi.resetModules();
  });

  it("starts with only the eager cjk/code plugins, before math/mermaid resolve", async () => {
    const { useStreamdownPlugins } = await import("./streamdown-plugins");
    const { result } = renderHook(() => useStreamdownPlugins());

    expect(result.current.cjk).toBeDefined();
    expect(result.current.code).toBeDefined();
    expect(result.current.math).toBeUndefined();
    expect(result.current.mermaid).toBeUndefined();

    // Let the pending dynamic import settle so it doesn't leak into the next test.
    await waitFor(() => expect(result.current.math).toBeDefined());
  });

  it("merges in math and mermaid once the dynamic import resolves", async () => {
    const { useStreamdownPlugins } = await import("./streamdown-plugins");
    const { result } = renderHook(() => useStreamdownPlugins());

    await waitFor(() => {
      expect(result.current.math).toBe(mathPlugin);
      expect(result.current.mermaid).toBe(mermaidPlugin);
    });
    // The eager plugins are still present alongside the newly-loaded ones.
    expect(result.current.cjk).toBeDefined();
    expect(result.current.code).toBeDefined();
  });

  it("resolves the same heavy plugins for multiple concurrent consumers", async () => {
    const { useStreamdownPlugins } = await import("./streamdown-plugins");
    const a = renderHook(() => useStreamdownPlugins());
    const b = renderHook(() => useStreamdownPlugins());

    await waitFor(() => {
      expect(a.result.current.math).toBe(mathPlugin);
      expect(b.result.current.math).toBe(mathPlugin);
    });
  });
});
