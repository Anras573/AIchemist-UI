import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useThrottledValue } from "./useThrottledValue";

describe("useThrottledValue", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("returns the initial value immediately", () => {
    const { result } = renderHook(() => useThrottledValue("a", 100));
    expect(result.current).toBe("a");
  });

  it("keeps making progress while the source changes faster than the interval", () => {
    const { result, rerender } = renderHook(({ v }) => useThrottledValue(v, 100), {
      initialProps: { v: "x" },
    });
    // 40 updates, 16 ms apart (~640 ms) — a deferred value could starve here.
    for (let i = 1; i <= 40; i++) {
      rerender({ v: `x${i}` });
      act(() => {
        vi.advanceTimersByTime(16);
      });
    }
    expect(result.current).not.toBe("x");
    expect(result.current.startsWith("x")).toBe(true);
    act(() => {
      vi.advanceTimersByTime(100);
    });
    expect(result.current).toBe("x40");
  });

  it("limits updates to roughly one per interval", () => {
    let renders = 0;
    const { rerender } = renderHook(({ v }) => {
      renders++;
      return useThrottledValue(v, 100);
    }, { initialProps: { v: "a" } });
    const before = renders;
    for (let i = 0; i < 20; i++) {
      rerender({ v: `a${i}` });
      act(() => {
        vi.advanceTimersByTime(16);
      });
    }
    // 20 source updates → 20 of our own rerenders + only a few throttled commits.
    expect(renders - before).toBeLessThan(20 + 6);
  });

  it("passes an empty value through immediately", () => {
    const { result, rerender } = renderHook(({ v }) => useThrottledValue(v, 100), {
      initialProps: { v: "text" },
    });
    rerender({ v: "" });
    expect(result.current).toBe("");
  });
});
