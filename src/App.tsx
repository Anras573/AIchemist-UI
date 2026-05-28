import { useEffect, Component, type ReactNode } from "react";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AppShell } from "@/components/layout/AppShell";
import { useTheme } from "@/lib/hooks/useTheme";
import { useSessionHydration } from "@/lib/hooks/useSessionHydration";
import { onSessionEvent, IPC_CHANNELS } from "@/lib/ipc";

class ErrorBoundary extends Component<
  { children: ReactNode },
  { error: Error | null }
> {
  state = { error: null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  render() {
    if (this.state.error) {
      return (
        <div style={{ padding: 32, color: "#f87171", fontFamily: "monospace" }}>
          <h2 style={{ marginBottom: 8 }}>Render error</h2>
          <pre style={{ whiteSpace: "pre-wrap" }}>{String(this.state.error)}</pre>
        </div>
      );
    }
    return this.props.children;
  }
}

function App() {
  useTheme(); // keeps OS preference listener active; theme managed via localStorage + IPC
  useSessionHydration(); // loads message history from SQLite when active session changes

  // Warn in the console if the main process reports missing API keys at startup.
  // A proper toast can replace this once a toast system is added.
  useEffect(() => {
    return onSessionEvent<{ message: string; missing: string[] }>(
      IPC_CHANNELS.CONFIG_WARNING,
      ({ message, missing }) => {
        console.warn(`[AIchemist] Config warning — missing keys: ${missing.join(", ")}\n${message}`);
      }
    );
  }, []);

  return (
    <TooltipProvider>
      <AppShell />
    </TooltipProvider>
  );
}

export default function Root() {
  return (
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  );
}
