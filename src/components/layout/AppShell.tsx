import { useState, useEffect, useCallback } from "react";
import { ProjectSidebar } from "@/components/layout/ProjectSidebar";
import { WorkspaceView } from "@/components/layout/WorkspaceView";
import { CommandPalette } from "@/components/layout/CommandPalette";
import { SettingsView } from "@/components/settings/SettingsView";
import { ProjectSettingsSheet } from "@/components/settings/ProjectSettingsSheet";
import { useSessionEvents } from "@/lib/hooks/useSessionEvents";
import { useProjectStore } from "@/lib/store/useProjectStore";

export function AppShell() {
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const { settingsOpen, openSettings, closeSettings, projectSettingsOpen, closeProjectSettings, activeProjectId } = useProjectStore();

  // Subscribe to all session:* events for the lifetime of the app
  useSessionEvents();

  // Cmd+, opens settings
  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && e.key === ",") {
      e.preventDefault();
      openSettings();
    }
    if (e.key === "Escape" && settingsOpen) {
      closeSettings();
    }
  }, [settingsOpen, openSettings, closeSettings]);

  useEffect(() => {
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [handleKeyDown]);

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-background text-foreground">
      <ProjectSidebar
        collapsed={sidebarCollapsed}
        onCollapsedChange={setSidebarCollapsed}
      />

      <main className="flex flex-1 overflow-hidden">
        {settingsOpen ? <SettingsView onClose={closeSettings} /> : <WorkspaceView />}
      </main>

      {projectSettingsOpen && activeProjectId && (
        <ProjectSettingsSheet
          projectId={activeProjectId}
          onClose={closeProjectSettings}
        />
      )}

      <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} />
    </div>
  );
}
