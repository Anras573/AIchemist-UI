import { useEffect } from "react";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AppShell } from "@/components/layout/AppShell";
import { useTheme } from "@/lib/hooks/useTheme";
import { useSessionHydration } from "@/lib/hooks/useSessionHydration";
import { onSessionEvent, IPC_CHANNELS } from "@/lib/ipc";

function App() {
  useTheme(); // keeps OS preference listener active; theme managed via localStorage + IPC
  useSessionHydration(); // loads message history from SQLite when active session changes

  // Warn in the console if the main process reports missing API keys at startup.
  // A proper toast can replace this once a toast system is added.
  useEffect(() => {
    const offConfigWarning = onSessionEvent<{ message: string; missing: string[] }>(
      IPC_CHANNELS.CONFIG_WARNING,
      ({ message, missing }) => {
        console.warn(`[AIchemist] Config warning — missing keys: ${missing.join(", ")}\n${message}`);
      }
    );

    const offWorktreeWarning = onSessionEvent<{ message: string }>(
      IPC_CHANNELS.WORKTREE_WARNING,
      ({ message }) => {
        console.warn(`[AIchemist] Worktree warning\n${message}`);
      }
    );

    return () => {
      offConfigWarning();
      offWorktreeWarning();
    };
  }, []);

  return (
    <TooltipProvider>
      <AppShell />
    </TooltipProvider>
  );
}

export default App;
