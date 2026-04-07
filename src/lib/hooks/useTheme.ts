import { useState, useEffect, useCallback } from "react";
import { useIpc } from "@/lib/ipc";

export type Theme = "system" | "light" | "dark";

const STORAGE_KEY = "aichemist-theme";

function resolveIsDark(theme: Theme): boolean {
  if (theme === "dark") return true;
  if (theme === "light") return false;
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

function applyTheme(theme: Theme) {
  document.documentElement.classList.toggle("dark", resolveIsDark(theme));
}

/** Call once before React renders to avoid a light-flash on dark-mode startup. */
export function initTheme() {
  const saved = localStorage.getItem(STORAGE_KEY) as Theme | null;
  applyTheme(saved ?? "system");
}

/** Hook for reading and updating the active theme. */
export function useTheme() {
  const ipc = useIpc();
  const [theme, setThemeState] = useState<Theme>(
    () => (localStorage.getItem(STORAGE_KEY) as Theme) ?? "system"
  );

  // Keep the <html> class in sync whenever theme changes
  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  // Re-apply when the OS preference changes (only matters in "system" mode)
  useEffect(() => {
    if (theme !== "system") return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const handler = () => applyTheme("system");
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, [theme]);

  // Load from settings on first mount to stay in sync with the persisted value
  useEffect(() => {
    ipc.settingsRead()
      .then((s) => {
        const persisted = (s.AICHEMIST_THEME ?? "system") as Theme;
        if (persisted !== theme) {
          localStorage.setItem(STORAGE_KEY, persisted);
          setThemeState(persisted);
        }
      })
      .catch(() => { /* settings unavailable — keep localStorage value */ });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const setTheme = useCallback(async (next: Theme) => {
    localStorage.setItem(STORAGE_KEY, next);
    setThemeState(next);
    await ipc.settingsWrite({ AICHEMIST_THEME: next }).catch(console.error);
  }, []);

  return { theme, setTheme };
}
