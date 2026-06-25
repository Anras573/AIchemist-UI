import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useAutosave } from "./useAutosave";

describe("useAutosave", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    // Drop any undo-window / debounce timer still armed so it can't leak into
    // the next test and make failures order-dependent.
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("debounces text commits into a single save with the latest value", async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    const { result } = renderHook(() => useAutosave(save, { debounceMs: 500 }));

    act(() => {
      result.current.commit("a");
      result.current.commit("ab");
      result.current.commit("abc");
    });

    // Nothing fires until the debounce window elapses.
    expect(save).not.toHaveBeenCalled();

    await act(async () => {
      vi.advanceTimersByTime(500);
    });

    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith("abc");
    expect(result.current.status).toBe("saved");
  });

  it("saves immediately when commit is marked immediate (toggles)", async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    const { result } = renderHook(() => useAutosave(save, { debounceMs: 500 }));

    await act(async () => {
      result.current.commit(true, { immediate: true });
    });

    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith(true);
    expect(result.current.status).toBe("saved");
  });

  it("opens an undo window and restores the previous value", async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    const { result } = renderHook(() =>
      useAutosave(save, { debounceMs: 0, undoMs: 5000, initialValue: "before" }),
    );

    await act(async () => {
      result.current.commit("after");
    });

    expect(save).toHaveBeenLastCalledWith("after");
    expect(result.current.canUndo).toBe(true);

    await act(async () => {
      result.current.undo();
    });

    // Undo re-persists the value that was in effect before the change.
    expect(save).toHaveBeenLastCalledWith("before");
    expect(result.current.canUndo).toBe(false);
  });

  it("closes the undo window and returns to idle after undoMs", async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    const { result } = renderHook(() =>
      useAutosave(save, { debounceMs: 0, undoMs: 5000, initialValue: "x" }),
    );

    await act(async () => {
      result.current.commit("y");
    });
    expect(result.current.canUndo).toBe(true);
    expect(result.current.status).toBe("saved");

    await act(async () => {
      vi.advanceTimersByTime(5000);
    });

    expect(result.current.canUndo).toBe(false);
    expect(result.current.status).toBe("idle");

    // Undo after the window has closed is a no-op.
    await act(async () => {
      result.current.undo();
    });
    expect(save).toHaveBeenCalledTimes(1);
  });

  it("surfaces a save failure as error status", async () => {
    const save = vi.fn().mockRejectedValue(new Error("disk full"));
    const { result } = renderHook(() => useAutosave(save, { debounceMs: 0 }));

    await act(async () => {
      result.current.commit("oops");
    });

    expect(result.current.status).toBe("error");
    expect(result.current.error).toBeInstanceOf(Error);
    expect(result.current.error?.message).toBe("disk full");
    expect(result.current.canUndo).toBe(false);
  });

  it("ignores a stale save that resolves after a newer commit", async () => {
    let resolveFirst!: () => void;
    const save = vi
      .fn()
      .mockImplementationOnce(() => new Promise<void>((r) => { resolveFirst = r; })) // "b" hangs
      .mockImplementation(() => Promise.resolve()); // "c" and the undo resolve immediately

    const { result } = renderHook(() =>
      useAutosave(save, { debounceMs: 0, undoMs: 5000, initialValue: "a" }),
    );

    // First commit stays pending; a second commit supersedes it and resolves.
    act(() => {
      result.current.commit("b", { immediate: true });
    });
    await act(async () => {
      result.current.commit("c", { immediate: true });
    });
    expect(result.current.status).toBe("saved");
    expect(result.current.canUndo).toBe(true);

    // The stale "b" save resolves late — it must not clobber baseline or status.
    await act(async () => {
      resolveFirst();
      await Promise.resolve();
    });
    expect(result.current.status).toBe("saved");

    // Undo restores the value from before the latest edit batch ("a"), proving
    // the late "b" completion did not overwrite the baseline.
    await act(async () => {
      result.current.undo();
    });
    expect(save).toHaveBeenLastCalledWith("a");
  });

  it("does not offer undo when the committed value equals the baseline", async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    const { result } = renderHook(() =>
      useAutosave(save, { debounceMs: 0, initialValue: "same" }),
    );

    await act(async () => {
      result.current.commit("same");
    });

    expect(save).toHaveBeenCalledWith("same");
    expect(result.current.canUndo).toBe(false);
  });

  it("clears a prior undo window when a later no-op save does not qualify", async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    const { result } = renderHook(() =>
      useAutosave(save, { debounceMs: 0, undoMs: 5000, initialValue: "a" }),
    );

    // First change opens an undo window back to "a".
    await act(async () => {
      result.current.commit("b");
    });
    expect(result.current.canUndo).toBe(true);

    // Re-saving the current baseline doesn't qualify for a new undo target; the
    // stale "a" window must be cleared rather than leak into this saved state.
    await act(async () => {
      result.current.commit("b");
    });
    expect(result.current.canUndo).toBe(false);
  });
});
