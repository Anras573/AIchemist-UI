import { useEffect, useState, useCallback } from "react";
import { useProjectStore } from "@/lib/store/useProjectStore";
import { useSessionStore } from "@/lib/store/useSessionStore";
import { ipc } from "@/lib/ipc";
import type { AgentInfo } from "@/types";
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
import {
  Bot,
  CheckCircle2,
  ChevronRight,
  Plus,
  Settings,
  Shield,
  Trash2,
} from "lucide-react";

interface CommandPaletteProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

type Page = "root" | "agent";

export function CommandPalette({ open, onOpenChange }: CommandPaletteProps) {
  const { projects, setActiveProject, activeProjectId, openSettings } = useProjectStore();
  const {
    sessions,
    setActiveSession,
    addSession,
    removeSession,
    activeSessionId,
    setSessionAgent,
    sessionAgents,
  } = useSessionStore();

  const [page, setPage] = useState<Page>("root");
  const [search, setSearch] = useState("");
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [loadingAgents, setLoadingAgents] = useState(false);
  const [approvalMode, setApprovalMode] = useState<"all" | "none" | "custom" | null>(null);

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

  // Reset sub-page state when palette closes
  useEffect(() => {
    if (!open) {
      setPage("root");
      setSearch("");
    }
  }, [open]);

  // Load current approval mode whenever the palette opens with an active project
  useEffect(() => {
    if (open && activeProjectId) {
      ipc.getProjectConfig(activeProjectId)
        .then((config) => setApprovalMode(config.approval_mode))
        .catch(() => {});
    }
  }, [open, activeProjectId]);

  function close() {
    onOpenChange(false);
  }

  function selectProject(id: string) {
    setActiveProject(id);
    close();
  }

  function selectSession(sessionId: string, projectId: string) {
    setActiveProject(projectId);
    setActiveSession(sessionId);
    close();
  }

  async function handleNewSession() {
    if (!activeProjectId) return;
    try {
      const session = await ipc.createSession(activeProjectId);
      addSession(session);
      setActiveSession(session.id);
    } catch (err) {
      console.error("Failed to create session", err);
    }
    close();
  }

  async function handleDeleteSession() {
    if (!activeSessionId) return;
    try {
      await ipc.deleteSession(activeSessionId);
      removeSession(activeSessionId); // store auto-clears activeSessionId
    } catch (err) {
      console.error("Failed to delete session", err);
    }
    close();
  }

  async function handleToggleApprovalMode() {
    if (!activeProjectId) return;
    try {
      const config = await ipc.getProjectConfig(activeProjectId);
      const newMode = config.approval_mode === "none" ? "all" : "none";
      await ipc.saveProjectConfig(activeProjectId, { ...config, approval_mode: newMode });
      setApprovalMode(newMode);
    } catch (err) {
      console.error("Failed to toggle approval mode", err);
    }
    close();
  }

  const loadAgents = useCallback(() => {
    const project = projects.find((p) => p.id === activeProjectId);
    if (!project) return;
    setLoadingAgents(true);
    // Load from both providers and merge, deduplicating by name
    Promise.allSettled([
      ipc.getClaudeAgents(project.path),
      ipc.getCopilotAgents(project.path),
    ]).then((results) => {
      const merged: AgentInfo[] = [];
      const seen = new Set<string>();
      for (const result of results) {
        if (result.status === "fulfilled") {
          for (const agent of result.value) {
            if (!seen.has(agent.name)) {
              seen.add(agent.name);
              merged.push(agent);
            }
          }
        }
      }
      setAgents(merged);
    }).finally(() => setLoadingAgents(false));
  }, [activeProjectId, projects]);

  function handleOpenAgentPage() {
    setPage("agent");
    setSearch("");
    if (agents.length === 0) loadAgents();
  }

  async function handleSelectAgent(agentName: string | null) {
    if (!activeSessionId) return;
    setSessionAgent(activeSessionId, agentName);
    await ipc.updateSessionAgent(activeSessionId, agentName).catch(console.error);
    close();
  }

  const allSessions = Object.values(sessions).sort((a, b) =>
    b.created_at.localeCompare(a.created_at)
  );

  const currentAgent = activeSessionId ? (sessionAgents[activeSessionId] ?? null) : null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="overflow-hidden p-0 shadow-lg max-w-lg">
        <Command>
          <CommandInput
            placeholder={
              page === "agent"
                ? "Search agents… (Backspace to go back)"
                : "Type a command or search…"
            }
            value={search}
            onValueChange={setSearch}
            onKeyDown={(e) => {
              if (e.key === "Backspace" && search === "" && page !== "root") {
                setPage("root");
              }
            }}
          />
          <CommandList>
            <CommandEmpty>
              {loadingAgents ? "Loading agents…" : "No results found."}
            </CommandEmpty>

            {/* ── Root page ── */}
            {page === "root" && (
              <>
                <CommandGroup heading="Actions">
                  {activeProjectId && (
                    <CommandItem
                      value="new session create"
                      onSelect={handleNewSession}
                    >
                      <Plus className="mr-2 h-4 w-4" />
                      New Session
                    </CommandItem>
                  )}

                  {activeSessionId && (
                    <CommandItem
                      value="switch agent select bot"
                      onSelect={handleOpenAgentPage}
                    >
                      <Bot className="mr-2 h-4 w-4" />
                      <span className="flex-1">Switch Agent</span>
                      {currentAgent && (
                        <span className="ml-2 text-xs text-muted-foreground">
                          {currentAgent}
                        </span>
                      )}
                      <ChevronRight className="ml-1 h-3 w-3 text-muted-foreground" />
                    </CommandItem>
                  )}

                  {activeProjectId && (
                    <CommandItem
                      value="toggle approval mode tools require all none"
                      onSelect={handleToggleApprovalMode}
                    >
                      <Shield className="mr-2 h-4 w-4" />
                      <span className="flex-1">Toggle Approval Mode</span>
                      {approvalMode !== null && (
                        <span className={`ml-2 text-xs font-medium ${approvalMode === "none" ? "text-muted-foreground" : "text-green-500"}`}>
                          {approvalMode === "none" ? "off" : approvalMode === "all" ? "on" : "custom"}
                        </span>
                      )}
                    </CommandItem>
                  )}

                  <CommandItem
                    value="open settings preferences"
                    onSelect={() => { openSettings(); close(); }}
                  >
                    <Settings className="mr-2 h-4 w-4" />
                    Open Settings
                  </CommandItem>

                  {activeSessionId && (
                    <CommandItem
                      value="delete session remove"
                      onSelect={handleDeleteSession}
                      className="text-destructive data-[selected=true]:text-destructive"
                    >
                      <Trash2 className="mr-2 h-4 w-4" />
                      Delete Current Session
                    </CommandItem>
                  )}
                </CommandGroup>

                {projects.length > 0 && (
                  <>
                    <CommandSeparator />
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
                  </>
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
              </>
            )}

            {/* ── Agent sub-page ── */}
            {page === "agent" && !loadingAgents && (
              <CommandGroup heading="Switch Agent">
                <CommandItem
                  value="default no agent none"
                  onSelect={() => handleSelectAgent(null)}
                >
                  <Bot className="mr-2 h-4 w-4" />
                  <span className="flex-1">Default (no agent)</span>
                  {!currentAgent && (
                    <CheckCircle2 className="ml-2 h-4 w-4 text-muted-foreground" />
                  )}
                </CommandItem>
                {agents.map((agent) => (
                  <CommandItem
                    key={agent.name}
                    value={`agent:${agent.name} ${agent.description ?? ""}`}
                    onSelect={() => handleSelectAgent(agent.name)}
                  >
                    <Bot className="mr-2 h-4 w-4" />
                    <span className="flex-1">{agent.name}</span>
                    {agent.description && (
                      <span className="ml-2 text-xs text-muted-foreground truncate max-w-48">
                        {agent.description}
                      </span>
                    )}
                    {currentAgent === agent.name && (
                      <CheckCircle2 className="ml-2 h-4 w-4 text-muted-foreground" />
                    )}
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
          </CommandList>
        </Command>
      </DialogContent>
    </Dialog>
  );
}
