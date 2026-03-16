import { useState } from "react";
import { ProjectSidebar } from "@/components/layout/ProjectSidebar";
import { WorkspaceView } from "@/components/layout/WorkspaceView";
import { CommandPalette } from "@/components/layout/CommandPalette";
import { useSessionEvents } from "@/lib/hooks/useSessionEvents";

export function AppShell() {
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);

  // Subscribe to all session:* events from Rust for the lifetime of the app
  useSessionEvents();

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-background text-foreground">
      <ProjectSidebar
        collapsed={sidebarCollapsed}
        onCollapsedChange={setSidebarCollapsed}
      />

      <main className="flex flex-1 overflow-hidden">
        <WorkspaceView />
      </main>

      <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} />
    </div>
  );
}
