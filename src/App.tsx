import { TooltipProvider } from "@/components/ui/tooltip";
import { AppShell } from "@/components/layout/AppShell";
import { useTheme } from "@/lib/hooks/useTheme";
import { useSessionHydration } from "@/lib/hooks/useSessionHydration";

function App() {
  useTheme(); // keeps OS preference listener active; theme managed via localStorage + IPC
  useSessionHydration(); // loads message history from SQLite when active session changes
  return (
    <TooltipProvider>
      <AppShell />
    </TooltipProvider>
  );
}

export default App;
