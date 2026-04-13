import { useState, useEffect, useCallback } from "react";
import { Bot, Check, ChevronsUpDown, Eye, Loader2, Pencil, Plus } from "lucide-react";
import { useIpc } from "@/lib/ipc";
import { useSessionStore } from "@/lib/store/useSessionStore";
import { useProjectStore } from "@/lib/store/useProjectStore";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { AgentEditorModal } from "@/components/session/AgentEditorModal";
import type { AgentInfo } from "@/types";

const AGENT_SOURCE_META: Record<string, { label: string; className: string }> = {
  sdk:     { label: "built-in", className: "text-emerald-500/70" },
  project: { label: "project",  className: "text-blue-500/70" },
  global:  { label: "global",   className: "text-purple-500/70" },
  plugin:  { label: "plugin",   className: "text-amber-500/70" },
};

function AgentSourceBadge({ source, plugin }: { source?: string; plugin?: string }) {
  if (!source) return null;
  const meta = AGENT_SOURCE_META[source];
  if (!meta) return null;
  // For plugin agents, show the short name before "@" with full key as tooltip
  const label = source === "plugin" && plugin
    ? (plugin.includes("@") ? plugin.slice(0, plugin.lastIndexOf("@")) : plugin)
    : meta.label;
  const title = source === "plugin" && plugin ? plugin : undefined;
  return (
    <span className={cn("text-[9px] font-medium shrink-0 truncate max-w-[140px]", meta.className)} title={title}>
      {label}
    </span>
  );
}

/**
 * Compact dropdown placed inside the input bar for selecting a sub-agent.
 * Only renders when the active project uses the Anthropic provider.
 * Agents are loaded lazily when the dropdown is first opened.
 */
export function AgentPickerButton() {
  const ipc = useIpc();
  const { activeSessionId, sessions, sessionAgents, setSessionAgent } = useSessionStore();
  const { projects, activeProjectId } = useProjectStore();
  const activeProject = projects.find((p) => p.id === activeProjectId);

  const provider = activeProject?.config.provider;
  const projectPath = activeProject?.path ?? "";

  const [open, setOpen] = useState(false);
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [loadingAgents, setLoadingAgents] = useState(false);

  // Confirmation dialog for Copilot agent switches when context would be lost
  const [pendingAgent, setPendingAgent] = useState<string | null | undefined>(undefined);
  const confirmOpen = pendingAgent !== undefined;

  // Editor modal state
  const [editingAgent, setEditingAgent] = useState<AgentInfo | null | undefined>(undefined);
  const [viewingAgent, setViewingAgent] = useState<AgentInfo | undefined>(undefined);
  const modalOpen = editingAgent !== undefined;

  const selectedAgent = activeSessionId
    ? (sessionAgents[activeSessionId] ?? null)
    : null;

  const loadAgents = useCallback(() => {
    if (!projectPath) return;
    if (provider !== "anthropic" && provider !== "copilot") return;
    setLoadingAgents(true);
    const fetch =
      provider === "anthropic"
        ? ipc.getClaudeAgents(projectPath)
        : ipc.getCopilotAgents(projectPath);
    fetch
      .then(setAgents)
      .catch(() => {/* Silently hide agent list on error */})
      .finally(() => setLoadingAgents(false));
  }, [projectPath, provider]);

  // Lazy-load agents the first time the dropdown opens
  useEffect(() => {
    if (!open || !projectPath || agents.length > 0) return;
    if (provider !== "anthropic" && provider !== "copilot") return;
    loadAgents();
  }, [open, projectPath, provider, agents.length, loadAgents]);

  const applyAgentSelection = useCallback(
    (agentName: string | null) => {
      if (!activeSessionId) return;
      setSessionAgent(activeSessionId, agentName);
      ipc.updateSessionAgent(activeSessionId, agentName).catch(console.error);
    },
    [activeSessionId, setSessionAgent]
  );

  const handleSelect = useCallback(
    (agentName: string | null) => {
      if (!activeSessionId) return;
      setOpen(false);

      // No change — nothing to do
      if (agentName === selectedAgent) return;

      // For Copilot, warn when the session already has messages — switching
      // agents discards the SDK session, which resets conversation context.
      const hasMessages = (sessions[activeSessionId]?.messages.length ?? 0) > 0;
      if (provider === "copilot" && hasMessages) {
        setPendingAgent(agentName);
        return;
      }

      applyAgentSelection(agentName);
    },
    [activeSessionId, selectedAgent, sessions, provider, applyAgentSelection]
  );

  const handleConfirmSwitch = useCallback(() => {
    if (pendingAgent !== undefined) {
      applyAgentSelection(pendingAgent);
    }
    setPendingAgent(undefined);
  }, [pendingAgent, applyAgentSelection]);

  const handleCancelSwitch = useCallback(() => {
    setPendingAgent(undefined);
  }, []);

  const handleEdit = useCallback((agent: AgentInfo, e: React.MouseEvent) => {
    e.stopPropagation();
    setOpen(false);
    setEditingAgent(agent);
  }, []);

  const handleView = useCallback((agent: AgentInfo, e: React.MouseEvent) => {
    e.stopPropagation();
    setOpen(false);
    setViewingAgent(agent);
  }, []);

  const handleNew = useCallback(() => {
    setOpen(false);
    setEditingAgent(null);
  }, []);

  const handleModalClose = useCallback(() => setEditingAgent(undefined), []);

  const handleModalSaved = useCallback(() => {
    // Force reload by resetting the list
    setAgents([]);
    loadAgents();
  }, [loadAgents]);

  // Hidden when no provider is set
  if (!provider) return null;

  const pendingAgentLabel = pendingAgent ?? "Default";

  return (
    <>
      <DropdownMenu open={open} onOpenChange={setOpen}>
        <DropdownMenuTrigger
          className={cn(
            "flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px] transition-colors",
            "focus:outline-none focus-visible:ring-1 focus-visible:ring-ring",
            selectedAgent !== null
              ? "border border-primary/50 bg-primary/10 text-primary hover:bg-primary/15 font-medium"
              : "border border-border/60 bg-background/50 text-muted-foreground hover:text-foreground hover:bg-muted"
          )}
          title="Select agent"
        >
            <Bot className="h-3 w-3 shrink-0" />
            <span className="max-w-[100px] truncate">
              {selectedAgent ?? "Default"}
            </span>
          <ChevronsUpDown className="h-2.5 w-2.5 opacity-50 shrink-0" />
        </DropdownMenuTrigger>

        <DropdownMenuContent
          side="top"
          align="start"
          className="w-64 p-1"
          sideOffset={6}
        >
          {/* Default (no agent) */}
          <DropdownMenuItem
            className="flex items-center gap-2 text-xs cursor-pointer"
            onClick={() => handleSelect(null)}
          >
            <Bot className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
            <span className="flex-1">Default</span>
            {selectedAgent === null && (
              <Check className="h-3 w-3 text-primary shrink-0" />
            )}
          </DropdownMenuItem>

          {loadingAgents ? (
            <div className="flex items-center gap-2 px-1.5 py-2 text-xs text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin shrink-0" />
              Loading agents…
            </div>
          ) : (
            agents.map((agent) => (
              <DropdownMenuItem
                key={agent.name}
                className="flex items-center gap-2 text-xs cursor-pointer group"
                onClick={() => handleSelect(agent.name)}
              >
                <Bot className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1.5 min-w-0">
                    <span className="truncate">{agent.name}</span>
                    <AgentSourceBadge source={agent.source} plugin={agent.plugin} />
                  </div>
                  {agent.model && (
                    <div className="text-[9px] text-muted-foreground truncate">
                      {agent.model}
                    </div>
                  )}
                </div>
                {selectedAgent === agent.name && (
                  <Check className="h-3 w-3 text-primary shrink-0" />
                )}
                <button
                  className="opacity-0 group-hover:opacity-100 p-0.5 rounded hover:bg-accent transition-opacity"
                  title="View agent"
                  onClick={(e) => handleView(agent, e)}
                >
                  <Eye className="h-2.5 w-2.5 text-muted-foreground" />
                </button>
                {agent.editable !== false && agent.path && (
                  <button
                    className="opacity-0 group-hover:opacity-100 p-0.5 rounded hover:bg-accent transition-opacity"
                    title="Edit agent"
                    onClick={(e) => handleEdit(agent, e)}
                  >
                    <Pencil className="h-2.5 w-2.5 text-muted-foreground" />
                  </button>
                )}
              </DropdownMenuItem>
            ))
          )}

          {/* New agent entry — only for file-based providers */}
          {(provider === "anthropic" || provider === "copilot") && !loadingAgents && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                className="flex items-center gap-2 text-xs cursor-pointer text-muted-foreground hover:text-foreground"
                onClick={handleNew}
              >
                <Plus className="h-3.5 w-3.5 shrink-0" />
                New agent…
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      {/* Copilot agent-switch confirmation — switching resets conversation context */}
      <Dialog open={confirmOpen} onOpenChange={(o) => { if (!o) handleCancelSwitch(); }}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Switch agent?</DialogTitle>
            <DialogDescription>
              Switching to <span className="font-medium text-foreground">{pendingAgentLabel}</span> will
              reset the Copilot conversation context. Your message history will remain visible, but
              Copilot will start fresh without memory of previous messages.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2">
            <Button variant="outline" size="sm" onClick={handleCancelSwitch}>
              Keep current agent
            </Button>
            <Button variant="destructive" size="sm" onClick={handleConfirmSwitch}>
              Switch agent
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Modal rendered outside dropdown to avoid z-index issues */}
      {modalOpen && (
        <AgentEditorModal
          agent={editingAgent ?? null}
          provider={provider}
          projectPath={projectPath}
          open={modalOpen}
          onClose={handleModalClose}
          onSaved={handleModalSaved}
        />
      )}

      {viewingAgent && (
        <AgentEditorModal
          agent={viewingAgent}
          provider={provider}
          projectPath={projectPath}
          open={true}
          onClose={() => setViewingAgent(undefined)}
          onSaved={() => setViewingAgent(undefined)}
          readOnly
        />
      )}
    </>
  );
}
