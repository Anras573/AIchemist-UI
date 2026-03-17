import { TooltipProvider } from "@/components/ui/tooltip";
import { AppShell } from "@/components/layout/AppShell";
import { useTheme } from "@/lib/hooks/useTheme";

function App() {
  useTheme(); // keeps OS preference listener active; theme managed via localStorage + IPC
  return (
    <TooltipProvider>
      <AppShell />
    </TooltipProvider>
  );
}

export default App;
