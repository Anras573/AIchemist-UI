import { describe, it, expect, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useTheme } from "@/lib/hooks/useTheme";

const STORAGE_KEY = "aichemist-theme";

describe("useTheme", () => {
  it("defaults to 'system' when localStorage has no value", () => {
    const { result } = renderHook(() => useTheme());
    expect(result.current.theme).toBe("system");
  });

  it("reads the saved theme from localStorage on mount", () => {
    localStorage.setItem(STORAGE_KEY, "dark");
    const { result } = renderHook(() => useTheme());
    expect(result.current.theme).toBe("dark");
  });

  it("syncs with the persisted settings value on first mount", async () => {
    vi.mocked(window.electronAPI.settingsRead).mockResolvedValue({
      AICHEMIST_THEME: "light",
    } as never);

    const { result } = renderHook(() => useTheme());

    // Wait for the async settingsRead effect
    await act(async () => {
      await Promise.resolve();
    });

    expect(result.current.theme).toBe("light");
    expect(localStorage.getItem(STORAGE_KEY)).toBe("light");
  });

  it("setTheme updates state, localStorage, and calls settingsWrite", async () => {
    const { result } = renderHook(() => useTheme());

    await act(async () => {
      await result.current.setTheme("dark");
    });

    expect(result.current.theme).toBe("dark");
    expect(localStorage.getItem(STORAGE_KEY)).toBe("dark");
    expect(window.electronAPI.settingsWrite).toHaveBeenCalledWith({
      AICHEMIST_THEME: "dark",
    });
  });

  it("rethrows and rolls back the optimistic change when the settings write fails", async () => {
    // Keep the mount-time settingsRead sync a no-op so it doesn't change theme.
    localStorage.setItem(STORAGE_KEY, "light");
    vi.mocked(window.electronAPI.settingsRead).mockResolvedValue({
      AICHEMIST_THEME: "light",
    } as never);
    vi.mocked(window.electronAPI.settingsWrite).mockRejectedValueOnce(
      new Error("disk full"),
    );
    const { result } = renderHook(() => useTheme());

    await expect(
      act(async () => {
        await result.current.setTheme("dark");
      }),
    ).rejects.toThrow("disk full");

    // The visible theme + localStorage revert to what is actually persisted.
    expect(result.current.theme).toBe("light");
    expect(localStorage.getItem(STORAGE_KEY)).toBe("light");
  });

  it("does not roll back a stale write failure over a newer theme selection", async () => {
    localStorage.setItem(STORAGE_KEY, "light");
    vi.mocked(window.electronAPI.settingsRead).mockResolvedValue({
      AICHEMIST_THEME: "light",
    } as never);
    let rejectFirst!: (e: Error) => void;
    vi.mocked(window.electronAPI.settingsWrite)
      .mockImplementationOnce(
        () => new Promise<void>((_, rej) => { rejectFirst = rej; }), // "dark" hangs, then fails
      )
      .mockResolvedValueOnce(undefined); // "system" succeeds

    const { result } = renderHook(() => useTheme());

    // First change is left pending; a second change supersedes it and succeeds.
    let pending!: Promise<void>;
    act(() => {
      pending = result.current.setTheme("dark");
    });
    await act(async () => {
      await result.current.setTheme("system");
    });
    expect(result.current.theme).toBe("system");

    // The stale "dark" write now fails — it must NOT roll back to "light".
    await act(async () => {
      rejectFirst(new Error("late fail"));
      await pending.catch(() => {});
    });
    expect(result.current.theme).toBe("system");
    expect(localStorage.getItem(STORAGE_KEY)).toBe("system");
  });

  it("applies the 'dark' class to <html> when theme is dark", async () => {
    const { result } = renderHook(() => useTheme());

    await act(async () => {
      await result.current.setTheme("dark");
    });

    expect(document.documentElement.classList.contains("dark")).toBe(true);
  });

  it("removes the 'dark' class from <html> when theme is light", async () => {
    document.documentElement.classList.add("dark");
    const { result } = renderHook(() => useTheme());

    await act(async () => {
      await result.current.setTheme("light");
    });

    expect(document.documentElement.classList.contains("dark")).toBe(false);
  });
});
