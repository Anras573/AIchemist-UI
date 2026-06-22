import { useEffect, useCallback, useState, useMemo } from "react";
import { Bot, CalendarClock, ChevronDown, ChevronRight, Hash, Link, Plus, Settings, Settings2 } from "lucide-react";
import { useIpc } from "@/lib/ipc";
import { useProjectStore } from "@/lib/store/useProjectStore";
import { useSessionStore } from "@/lib/store/useSessionStore";
import { useProviderProbes } from "@/lib/hooks/useProviderProbes";
import { PROVIDERS, PROVIDER_SHORT_LABELS, getProviderLogo } from "@/lib/providers";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { WithTooltip } from "@/components/ui/with-tooltip";
import { StatusDot } from "@/components/session/StatusDot";
import { ModelSelectorLogo } from "@/components/ai-elements/model-selector";
import { ProviderMenuItem } from "@/components/session/ProviderMenuItem";
import { SessionDeleteDialog } from "@/components/session/SessionDeleteDialog";
import { NewSessionWithIssueDialog } from "@/components/session/NewSessionWithIssueDialog";
import type { Project, Session, Provider } from "@/types";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu";

interface ProjectSidebarProps {
  collapsed: boolean;
  onCollapsedChange: (collapsed: boolean) => void;
}

export function ProjectSidebar({ collapsed, onCollapsedChange }: ProjectSidebarProps) {
  const ipc = useIpc();
  const { projects, activeProjectId, setProjects, setActiveProject, addProject, removeProject, openSettings, openProjectSettings, openWorkflows } =
    useProjectStore();
  const mergeSessions = useSessionStore((s) => s.mergeSessions);

  const [expandedProjects, setExpandedProjects] = useState<Set<string>>(new Set());

  // Load all projects and their sessions on mount
  useEffect(() => {
    ipc.listProjects()
      .then(async (list) => {
        setProjects(list);
        if (list.length > 0) {
          const stillExists = list.some((p) => p.id === activeProjectId);
          if (!stillExists) setActiveProject(list[0].id);
        }
        setExpandedProjects(new Set(list.map((p) => p.id)));
        const allSessions = await Promise.all(
          list.map((p) => ipc.listSessions(p.id).catch((err) => { console.error(`listSessions failed for project ${p.id}:`, err); return [] as Session[]; }))
        );
        mergeSessions(allSessions.flat());
        // Restore active session or pick the first for the active project.
        // Read activeProjectId from the store here (not the closure) to avoid
        // using a value that may have changed while the async fetches were in flight.
        const { activeSessionId, sessions, setActiveSession } = useSessionStore.getState();
        const currentActiveProjectId = useProjectStore.getState().activeProjectId;
        const effectiveProjectId = list.some((p) => p.id === currentActiveProjectId)
          ? currentActiveProjectId
          : list[0]?.id ?? null;
        const sessionBelongs = activeSessionId
          ? (sessions[activeSessionId]?.project_id === effectiveProjectId)
          : false;
        if (!sessionBelongs && effectiveProjectId) {
          const first = allSessions
            .flat()
            .filter((s) => s.project_id === effectiveProjectId)
            .sort((a, b) => a.created_at.localeCompare(b.created_at))[0];
          setActiveSession(first?.id ?? null);
        }
      })
      .catch(console.error);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // When the active project changes (e.g. via collapsed sidebar click), sync active session
  useEffect(() => {
    if (!activeProjectId) return;
    const { activeSessionId, sessions, setActiveSession } = useSessionStore.getState();
    const belongs = activeSessionId
      ? sessions[activeSessionId]?.project_id === activeProjectId
      : false;
    if (!belongs) {
      const first = Object.values(sessions)
        .filter((s) => s.project_id === activeProjectId)
        .sort((a, b) => a.created_at.localeCompare(b.created_at))[0];
      setActiveSession(first?.id ?? null);
    }
  }, [activeProjectId]);

  const handleAddProject = useCallback(async () => {
    const path = await ipc.openFolderDialog();
    if (!path) return;
    try {
      const project = await ipc.addProject(path);
      addProject(project);
      setActiveProject(project.id);
      setExpandedProjects((prev) => new Set([...prev, project.id]));
      const list = await ipc.listSessions(project.id);
      mergeSessions(list);
      // The useEffect([activeProjectId]) sync already ran (before sessions
      // loaded) and set activeSessionId to null. Explicitly pick the first
      // session so it doesn't stay null if the project has existing sessions.
      const first = [...list].sort((a, b) => a.created_at.localeCompare(b.created_at))[0];
      if (first) useSessionStore.getState().setActiveSession(first.id);
    } catch (err) {
      console.error("addProject failed:", err);
    }
  }, [ipc, addProject, setActiveProject, mergeSessions]);

  const handleRemoveProject = useCallback(
    async (e: React.MouseEvent, id: string) => {
      e.stopPropagation();
      try {
        await ipc.removeProject(id);
      } catch (err) {
        console.error("removeProject failed:", err);
        return;
      }
      // Clear the project's sessions from the store so orphaned entries
      // don't remain visible or selectable (e.g. in the command palette).
      const { sessions, removeSession } = useSessionStore.getState();
      Object.values(sessions)
        .filter((s) => s.project_id === id)
        .forEach((s) => removeSession(s.id));
      removeProject(id);
      setExpandedProjects((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    },
    [ipc, removeProject]
  );

  const handleToggleExpand = useCallback((projectId: string) => {
    setExpandedProjects((prev) => {
      const next = new Set(prev);
      if (next.has(projectId)) next.delete(projectId);
      else next.add(projectId);
      return next;
    });
  }, []);

  const handleExpand = useCallback((projectId: string) => {
    setExpandedProjects((prev) => new Set([...prev, projectId]));
  }, []);

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
            Projects
          </span>
        )}
        {collapsed && <div className="flex-1" />}
        <WithTooltip label={collapsed ? "Expand sidebar" : "Collapse sidebar"} side="right">
          <Button
            variant="ghost"
            size="icon"
            className="no-drag-region h-8 w-8 text-sidebar-foreground/60 hover:text-sidebar-foreground"
            onClick={() => onCollapsedChange(!collapsed)}
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          >
            {collapsed ? "›" : "‹"}
          </Button>
        </WithTooltip>
      </div>

      {/* Project list with nested sessions */}
      <div className="flex-1 overflow-y-auto py-2">
        {projects.length === 0 && !collapsed && (
          <p className="px-3 py-4 text-xs text-muted-foreground text-center">
            No projects yet.<br />Click "+ Add Project" to open a folder.
          </p>
        )}
        {projects.map((project) => (
          <ProjectSessionGroup
            key={project.id}
            project={project}
            collapsed={collapsed}
            expanded={expandedProjects.has(project.id)}
            onToggleExpand={() => handleToggleExpand(project.id)}
            onExpand={() => handleExpand(project.id)}
            onExpandSidebar={() => onCollapsedChange(false)}
            onRemoveProject={(e) => handleRemoveProject(e, project.id)}
            onOpenProjectSettings={openProjectSettings}
            onSetActiveProject={setActiveProject}
          />
        ))}
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
            onClick={openWorkflows}
          >
            <CalendarClock className="h-3.5 w-3.5 mr-2" />
            Workflows
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
        <div className="p-1 border-t border-sidebar-border flex-shrink-0 flex flex-col gap-1">
          <WithTooltip label="Workflows" side="right">
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8 text-sidebar-foreground/60 hover:text-sidebar-foreground mx-auto flex"
              onClick={openWorkflows}
              aria-label="Workflows"
            >
              <CalendarClock className="h-4 w-4" />
            </Button>
          </WithTooltip>
          <WithTooltip label="Settings" side="right">
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8 text-sidebar-foreground/60 hover:text-sidebar-foreground mx-auto flex"
              onClick={openSettings}
              aria-label="Settings"
            >
              <Settings className="h-4 w-4" />
            </Button>
          </WithTooltip>
        </div>
      )}
    </aside>
  );
}

interface ProjectSessionGroupProps {
  project: Project;
  collapsed: boolean;
  expanded: boolean;
  onToggleExpand: () => void;
  onExpand: () => void;
  onExpandSidebar: () => void;
  onRemoveProject: (e: React.MouseEvent) => void;
  onOpenProjectSettings: () => void;
  onSetActiveProject: (id: string) => void;
}

function ProjectSessionGroup({
  project,
  collapsed,
  expanded,
  onToggleExpand,
  onExpand,
  onExpandSidebar,
  onRemoveProject,
  onOpenProjectSettings,
  onSetActiveProject,
}: ProjectSessionGroupProps) {
  const ipc = useIpc();
  const activeProjectId = useProjectStore((s) => s.activeProjectId);
  const sessions = useSessionStore((s) => s.sessions);
  const activeSessionId = useSessionStore((s) => s.activeSessionId);
  const sessionAgents = useSessionStore((s) => s.sessionAgents);
  const addSession = useSessionStore((s) => s.addSession);
  const removeSession = useSessionStore((s) => s.removeSession);
  const setActiveSession = useSessionStore((s) => s.setActiveSession);

  const isActiveProject = project.id === activeProjectId;
  const defaultProvider = project.config.provider ?? null;
  const projectSessions = useMemo(
    () =>
      Object.values(sessions)
        .filter((s) => s.project_id === project.id)
        .sort((a, b) => a.created_at.localeCompare(b.created_at)),
    [sessions, project.id]
  );

  const [deleteDialogSession, setDeleteDialogSession] = useState<Session | null>(null);
  const [issueDialogOpen, setIssueDialogOpen] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  useEffect(() => {
    setCreateError(null);
  }, [project.id]);

  const handleNewSession = useCallback(
    async (providerOverride?: Provider, issueNumber?: number) => {
      setCreateError(null);
      try {
        const session = await ipc.createSession(project.id, providerOverride, issueNumber);
        addSession(session);
        onSetActiveProject(project.id);
        setActiveSession(session.id);
        onExpand();
      } catch (err) {
        setCreateError(err instanceof Error ? err.message : "Failed to create session");
      }
    },
    [ipc, project.id, addSession, setActiveSession, onSetActiveProject, onExpand]
  );

  const handleSessionClick = useCallback(
    (sessionId: string) => {
      onSetActiveProject(project.id);
      setActiveSession(sessionId);
    },
    [project.id, onSetActiveProject, setActiveSession]
  );

  const confirmDeleteSession = useCallback(
    async (cleanupWorktree: boolean) => {
      if (!deleteDialogSession) return;
      const wasActive = useSessionStore.getState().activeSessionId === deleteDialogSession.id;
      await ipc.deleteSession(deleteDialogSession.id, { cleanupWorktree });
      removeSession(deleteDialogSession.id);
      if (wasActive) {
        const next = Object.values(useSessionStore.getState().sessions)
          .filter((s) => s.project_id === project.id)
          .sort((a, b) => a.created_at.localeCompare(b.created_at))[0];
        setActiveSession(next?.id ?? null);
      }
      setDeleteDialogSession(null);
    },
    [deleteDialogSession, ipc, removeSession, project.id, setActiveSession]
  );

  const hasActiveSession = projectSessions.some(
    (s) => s.status === "running" || s.status === "waiting_approval"
  );

  // Fix 1: clicking a project row always sets it as active, then toggles expand (expanded)
  // or expands the sidebar (collapsed).
  const handleProjectClick = collapsed
    ? () => { onSetActiveProject(project.id); onExpandSidebar(); }
    : () => { onSetActiveProject(project.id); onToggleExpand(); };

  return (
    <div className="mb-0.5">
      {/* Project row */}
      <div className="group relative mx-1">
        <WithTooltip label={project.path} side="right">
          <button
            onClick={handleProjectClick}
            className={cn(
              "w-full flex items-center gap-1.5 px-2 py-1.5 rounded-md text-left transition-colors",
              "hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
              isActiveProject && !collapsed && "font-medium text-sidebar-foreground"
            )}
            aria-label={project.name}
          >
            {!collapsed && (
              expanded
                ? <ChevronDown className="size-3 text-muted-foreground flex-shrink-0" />
                : <ChevronRight className="size-3 text-muted-foreground flex-shrink-0" />
            )}
            <span className="relative text-base flex-shrink-0">
              📁
              {collapsed && hasActiveSession && (
                <span className="absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full bg-green-500 ring-1 ring-sidebar" />
              )}
            </span>
            {!collapsed && (
              <span className="flex-1 text-sm truncate">{project.name}</span>
            )}
          </button>
        </WithTooltip>

        {/* Hover actions — only when expanded */}
        {!collapsed && (
          // Fix 3: group-focus-within so actions appear when keyboard-focused too
          <div className="absolute right-1 top-1/2 -translate-y-1/2 flex items-center gap-0.5 opacity-0 pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto group-focus-within:opacity-100 group-focus-within:pointer-events-auto transition-opacity">
            {isActiveProject && (
              <WithTooltip label="Project settings">
                <button
                  onClick={(e) => { e.stopPropagation(); onOpenProjectSettings(); }}
                  className="text-muted-foreground hover:text-foreground p-0.5 rounded"
                  aria-label="Project settings"
                >
                  <Settings2 className="w-3.5 h-3.5" />
                </button>
              </WithTooltip>
            )}

            <WithTooltip label={defaultProvider ? `New session (${defaultProvider})` : "New session"}>
              <button
                onClick={(e) => { e.stopPropagation(); void handleNewSession(); }}
                className="text-muted-foreground hover:text-foreground p-0.5 rounded"
                aria-label="New session"
              >
                <Plus className="size-3.5" />
              </button>
            </WithTooltip>

            <ProviderDropdown
              projectId={project.id}
              defaultProvider={defaultProvider}
              onNewSession={(provider) => void handleNewSession(provider)}
              onIssueDialog={() => setIssueDialogOpen(true)}
            />

            <WithTooltip label="Remove project">
              <button
                onClick={onRemoveProject}
                className="text-xs text-muted-foreground hover:text-destructive transition-colors px-0.5 rounded"
                aria-label="Remove project"
              >
                ✕
              </button>
            </WithTooltip>
          </div>
        )}
      </div>

      {/* Session rows */}
      {!collapsed && expanded && (
        <div className="pb-1">
          {projectSessions.length === 0 && (
            <p className="pl-8 pr-2 py-1 text-xs text-muted-foreground italic">No sessions</p>
          )}
          {projectSessions.map((session) => (
            <SessionRow
              key={session.id}
              session={session}
              isActive={session.id === activeSessionId}
              sessionAgent={sessionAgents[session.id] ?? null}
              onClick={() => handleSessionClick(session.id)}
              onDelete={(e) => { e.stopPropagation(); setDeleteDialogSession(session); }}
            />
          ))}
          {createError && (
            <p className="pl-8 pr-2 py-0.5 text-xs text-destructive">{createError}</p>
          )}
        </div>
      )}

      <SessionDeleteDialog
        open={deleteDialogSession !== null}
        session={deleteDialogSession}
        projectPath={project.path}
        onOpenChange={(open) => !open && setDeleteDialogSession(null)}
        onConfirm={confirmDeleteSession}
      />
      {issueDialogOpen && (
        <IssueDialogWithProbes
          projectId={project.id}
          projectPath={project.path}
          defaultProvider={defaultProvider}
          onOpenChange={setIssueDialogOpen}
          onCreate={(providerOverride, issueNumber) => void handleNewSession(providerOverride, issueNumber)}
        />
      )}
    </div>
  );
}

// Mounts useProviderProbes only while the issue dialog is open so probes are
// fetched lazily (same pattern as LazyProviderMenuItems for the dropdown).
function IssueDialogWithProbes({
  projectId,
  projectPath,
  defaultProvider,
  onOpenChange,
  onCreate,
}: {
  projectId: string;
  projectPath: string;
  defaultProvider: Provider | null;
  onOpenChange: (open: boolean) => void;
  onCreate: (providerOverride: Provider, issueNumber?: number) => void;
}) {
  const { probes } = useProviderProbes(projectId);
  return (
    <NewSessionWithIssueDialog
      open={true}
      onOpenChange={onOpenChange}
      projectPath={projectPath}
      defaultProvider={defaultProvider}
      probes={probes}
      onCreate={onCreate}
    />
  );
}

// Controlled dropdown: LazyProviderMenuItems (and its useProviderProbes call) mounts
// while the menu is open and unmounts when it closes, keeping probe IPC calls deferred.
function ProviderDropdown({
  projectId,
  defaultProvider,
  onNewSession,
  onIssueDialog,
}: {
  projectId: string;
  defaultProvider: Provider | null;
  onNewSession: (provider: Provider) => void;
  onIssueDialog: () => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <WithTooltip label="New session with specific provider">
        <DropdownMenuTrigger
          className="h-5 px-0.5 flex items-center text-muted-foreground hover:text-foreground hover:bg-accent rounded border-none bg-transparent cursor-pointer"
          aria-label="New session with specific provider"
          onClick={(e) => e.stopPropagation()}
        >
          <ChevronDown className="size-3" />
        </DropdownMenuTrigger>
      </WithTooltip>
      <DropdownMenuContent align="end">
        {open && (
          <LazyProviderMenuItems
            projectId={projectId}
            defaultProvider={defaultProvider}
            onNewSession={onNewSession}
            onIssueDialog={onIssueDialog}
          />
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// Mounts useProviderProbes only while the dropdown is open.
function LazyProviderMenuItems({
  projectId,
  defaultProvider,
  onNewSession,
  onIssueDialog,
}: {
  projectId: string;
  defaultProvider: Provider | null;
  onNewSession: (provider: Provider) => void;
  onIssueDialog: () => void;
}) {
  const { probes } = useProviderProbes(projectId);
  return (
    <>
      {PROVIDERS.map((p) => (
        <ProviderMenuItem
          key={p}
          probe={probes?.[p]}
          onSelect={() => onNewSession(p)}
          isDefault={defaultProvider === p}
          label={`New ${PROVIDER_SHORT_LABELS[p]} session`}
          icon={<ModelSelectorLogo provider={getProviderLogo(p)} className="size-3.5" />}
        />
      ))}
      <DropdownMenuItem onClick={onIssueDialog}>
        <Link className="size-3.5" />
        <span>New session linked to issue…</span>
      </DropdownMenuItem>
    </>
  );
}

interface SessionRowProps {
  session: Session;
  isActive: boolean;
  sessionAgent: string | null;
  onClick: () => void;
  onDelete: (e: React.MouseEvent) => void;
}

function SessionRow({ session, isActive, sessionAgent, onClick, onDelete }: SessionRowProps) {
  return (
    // Fix 3: group-focus-within reveals the delete button on keyboard focus too
    <div className="group relative mx-1">
      <button
        onClick={onClick}
        className={cn(
          "w-full flex items-center gap-1.5 pl-6 pr-7 py-1 rounded-md text-left text-xs transition-colors",
          "hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
          isActive
            ? "bg-sidebar-primary text-sidebar-primary-foreground"
            : "text-muted-foreground"
        )}
      >
        <StatusDot status={session.status} />
        <span className="flex-1 truncate">{session.title}</span>
        {sessionAgent && (
          <span className="flex items-center gap-0.5 px-1 py-0.5 rounded text-[9px] bg-muted/60 border border-border/50 flex-shrink-0">
            <Bot className="size-2 shrink-0" />
            <span className="max-w-[40px] truncate">{sessionAgent}</span>
          </span>
        )}
        {session.github_issue_number != null && (
          <span className="flex items-center gap-0.5 px-1 py-0.5 rounded text-[9px] bg-muted/60 border border-border/50 flex-shrink-0">
            <Hash className="size-2 shrink-0" />
            {session.github_issue_number}
          </span>
        )}
      </button>
      <WithTooltip label="Delete session">
        <button
          onClick={onDelete}
          className="absolute right-1 top-1/2 -translate-y-1/2 opacity-0 pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto group-focus-within:opacity-100 group-focus-within:pointer-events-auto text-muted-foreground hover:text-destructive transition-opacity text-sm leading-none"
          aria-label="Delete session"
        >
          ×
        </button>
      </WithTooltip>
    </div>
  );
}
