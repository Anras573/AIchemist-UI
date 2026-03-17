import { useEffect, useCallback } from "react";
import { ipc } from "@/lib/ipc";
import { useProjectStore } from "@/lib/store/useProjectStore";
import { useSessionStore } from "@/lib/store/useSessionStore";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Settings } from "lucide-react";

interface ProjectSidebarProps {
  collapsed: boolean;
  onCollapsedChange: (collapsed: boolean) => void;
}

export function ProjectSidebar({ collapsed, onCollapsedChange }: ProjectSidebarProps) {
  const { projects, activeProjectId, setProjects, setActiveProject, addProject, removeProject, openSettings } =
    useProjectStore();
  const { sessions } = useSessionStore();

  // Load project list on mount
  useEffect(() => {
    ipc.listProjects()
      .then((list) => {
        setProjects(list);
        // Restore the last active project if it still exists; otherwise fall back to first
        if (list.length > 0) {
          const stillExists = list.some((p) => p.id === activeProjectId);
          if (!stillExists) setActiveProject(list[0].id);
        }
      })
      .catch(console.error);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleAddProject = useCallback(async () => {
    const path = await ipc.openFolderDialog();
    if (!path) return;
    try {
      const project = await ipc.addProject(path);
      addProject(project);
      setActiveProject(project.id);
    } catch (err) {
      console.error("addProject failed:", err);
    }
  }, [addProject, setActiveProject]);

  const handleRemoveProject = useCallback(
    async (e: React.MouseEvent, id: string) => {
      e.stopPropagation();
      await ipc.removeProject(id).catch(console.error);
      removeProject(id);
    },
    [removeProject]
  );

  // Count running/waiting sessions per project for the badge
  function getActiveSessions(projectId: string) {
    return Object.values(sessions).filter(
      (s) =>
        s.project_id === projectId &&
        (s.status === "running" || s.status === "waiting_approval")
    ).length;
  }

  return (
    <aside
      className={cn(
        "flex flex-col h-full bg-sidebar border-r border-sidebar-border transition-all duration-200 select-none",
        collapsed ? "w-12" : "w-60"
      )}
    >
      {/* Header — drag region; traffic lights occupy ~x:[8,76] so logo starts at pl-20 */}
      <div className="drag-region flex items-center h-12 px-2 border-b border-sidebar-border flex-shrink-0">
        {!collapsed && (
          <span className="text-sm font-semibold text-sidebar-foreground flex-1 truncate pl-[72px]">
            AIchemist
          </span>
        )}
        {collapsed && <div className="flex-1" />}
        <Button
          variant="ghost"
          size="icon"
          className="no-drag-region h-8 w-8 text-sidebar-foreground/60 hover:text-sidebar-foreground"
          onClick={() => onCollapsedChange(!collapsed)}
          title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
        >
          {collapsed ? "›" : "‹"}
        </Button>
      </div>

      {/* Project list */}
      <div className="flex-1 overflow-y-auto py-2">
        {projects.length === 0 && !collapsed && (
          <p className="px-3 py-4 text-xs text-muted-foreground text-center">
            No projects yet.<br />Click "+ Add Project" to open a folder.
          </p>
        )}
        {projects.map((project) => {
          const active = project.id === activeProjectId;
          const badgeCount = getActiveSessions(project.id);

          return (
            <div key={project.id} className="group relative mx-1">
              <button
                onClick={() => setActiveProject(project.id)}
                className={cn(
                  "w-full flex items-center gap-2 px-2 py-2 rounded-md text-left transition-colors",
                  "hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
                  active && "bg-sidebar-primary text-sidebar-primary-foreground"
                )}
                title={project.path}
              >
                <span className="relative text-base flex-shrink-0">
                  📁
                  {collapsed && badgeCount > 0 && (
                    <span className="absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full bg-green-500 ring-1 ring-sidebar" />
                  )}
                </span>
                {!collapsed && (
                  <>
                    <span className="flex-1 text-sm truncate">{project.name}</span>
                    {badgeCount > 0 && (
                      <Badge variant="secondary" className="text-xs h-5 px-1.5 flex-shrink-0">
                        {badgeCount}
                      </Badge>
                    )}
                  </>
                )}
              </button>

              {/* Remove button — visible on hover when expanded */}
              {!collapsed && (
                <button
                  onClick={(e) => handleRemoveProject(e, project.id)}
                  className="absolute right-1 top-1/2 -translate-y-1/2 opacity-0 group-hover:opacity-100 text-xs text-muted-foreground hover:text-destructive transition-opacity px-1"
                  title="Remove project"
                >
                  ✕
                </button>
              )}
            </div>
          );
        })}
      </div>

      {/* Bottom: Add project + Settings */}
      {!collapsed && (
        <div className="p-2 border-t border-sidebar-border flex-shrink-0 flex flex-col gap-1">
          <Button
            variant="ghost"
            size="sm"
            className="w-full justify-start text-sidebar-foreground/60 hover:text-sidebar-foreground"
            onClick={handleAddProject}
          >
            + Add Project
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="w-full justify-start text-sidebar-foreground/60 hover:text-sidebar-foreground"
            onClick={openSettings}
          >
            <Settings className="h-3.5 w-3.5 mr-2" />
            Settings
          </Button>
        </div>
      )}
      {collapsed && (
        <div className="p-1 border-t border-sidebar-border flex-shrink-0">
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8 text-sidebar-foreground/60 hover:text-sidebar-foreground mx-auto flex"
            onClick={openSettings}
            title="Settings"
          >
            <Settings className="h-4 w-4" />
          </Button>
        </div>
      )}
    </aside>
  );
}
