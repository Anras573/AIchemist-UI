import { useState, useEffect, useCallback, lazy, Suspense } from "react";
import { useShallow } from "zustand/react/shallow";
import { ProjectSidebar } from "@/components/layout/ProjectSidebar";
import { WorkspaceView } from "@/components/layout/WorkspaceView";
import { CommandPalette } from "@/components/layout/CommandPalette";
import { useSessionEvents } from "@/lib/hooks/useSessionEvents";
import { useProjectStore } from "@/lib/store/useProjectStore";
import { TitleBar } from "@/components/layout/TitleBar";
import { Spinner } from "@/components/ui/spinner";

// Deferred to their own chunks — neither is mounted at first paint (both are
// gated behind a store flag), and the settings hub in particular pulls in a
// large tree of section components most launches never open.
const SettingsView = lazy(() =>
  import("@/components/settings/SettingsView").then((m) => ({ default: m.SettingsView }))
);
const WorkflowsView = lazy(() =>
  import("@/components/workflows/WorkflowsView").then((m) => ({ default: m.WorkflowsView }))
);

function MainViewFallback() {
  return (
    <div className="flex flex-1 items-center justify-center">
      <Spinner />
    </div>
  );
}

export function AppShell() {
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const { settingsOpen, openSettings, closeSettings, workflowsOpen, closeWorkflows } = useProjectStore(
    useShallow((s) => ({
      settingsOpen: s.settingsOpen,
      openSettings: s.openSettings,
      closeSettings: s.closeSettings,
      workflowsOpen: s.workflowsOpen,
      closeWorkflows: s.closeWorkflows,
    }))
  );

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
    <div className="flex flex-col h-screen w-screen overflow-hidden bg-background text-foreground">
      <TitleBar />

      <div className="flex flex-1 overflow-hidden">
        <ProjectSidebar
          collapsed={sidebarCollapsed}
          onCollapsedChange={setSidebarCollapsed}
        />

        <main className="flex flex-1 overflow-hidden">
          {settingsOpen ? (
            <Suspense fallback={<MainViewFallback />}>
              <SettingsView onClose={closeSettings} />
            </Suspense>
          ) : workflowsOpen ? (
            <Suspense fallback={<MainViewFallback />}>
              <WorkflowsView onClose={closeWorkflows} />
            </Suspense>
          ) : (
            <WorkspaceView />
          )}
        </main>
      </div>

      <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} />
    </div>
  );
}
