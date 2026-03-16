import { useEffect } from "react";
import { useProjectStore } from "@/lib/store/useProjectStore";
import { useSessionStore } from "@/lib/store/useSessionStore";
import {
  Dialog,
  DialogContent,
} from "@/components/ui/dialog";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/components/ui/command";
import { StatusDot } from "@/components/session/StatusDot";

interface CommandPaletteProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function CommandPalette({ open, onOpenChange }: CommandPaletteProps) {
  const { projects, setActiveProject } = useProjectStore();
  const { sessions, setActiveSession } = useSessionStore();

  // Register Cmd+K globally
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        onOpenChange(true);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onOpenChange]);

  function selectProject(id: string) {
    setActiveProject(id);
    onOpenChange(false);
  }

  function selectSession(sessionId: string, projectId: string) {
    setActiveProject(projectId);
    setActiveSession(sessionId);
    onOpenChange(false);
  }

  const allSessions = Object.values(sessions).sort((a, b) =>
    b.created_at.localeCompare(a.created_at)
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="overflow-hidden p-0 shadow-lg max-w-lg">
        <Command>
          <CommandInput placeholder="Search projects and sessions…" />
          <CommandList>
            <CommandEmpty>No results found.</CommandEmpty>

            {projects.length > 0 && (
              <CommandGroup heading="Projects">
                {projects.map((project) => (
                  <CommandItem
                    key={project.id}
                    value={`project:${project.name} ${project.path}`}
                    onSelect={() => selectProject(project.id)}
                  >
                    <span className="mr-2">📁</span>
                    <span className="flex-1 truncate">{project.name}</span>
                    <span className="ml-2 text-xs text-muted-foreground truncate max-w-48">
                      {project.path}
                    </span>
                  </CommandItem>
                ))}
              </CommandGroup>
            )}

            {allSessions.length > 0 && (
              <>
                <CommandSeparator />
                <CommandGroup heading="Sessions">
                  {allSessions.map((session) => {
                    const project = projects.find(
                      (p) => p.id === session.project_id
                    );
                    return (
                      <CommandItem
                        key={session.id}
                        value={`session:${session.title} ${project?.name ?? ""}`}
                        onSelect={() =>
                          selectSession(session.id, session.project_id)
                        }
                      >
                        <StatusDot status={session.status} className="mr-2" />
                        <span className="flex-1 truncate">{session.title}</span>
                        {project && (
                          <span className="ml-2 text-xs text-muted-foreground truncate max-w-32">
                            {project.name}
                          </span>
                        )}
                      </CommandItem>
                    );
                  })}
                </CommandGroup>
              </>
            )}
          </CommandList>
        </Command>
      </DialogContent>
    </Dialog>
  );
}
