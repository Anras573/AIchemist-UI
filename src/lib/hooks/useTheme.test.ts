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
