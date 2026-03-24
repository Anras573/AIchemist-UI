import { useState, useEffect, useCallback } from "react";
import { Bot, Check, ChevronsUpDown, Loader2 } from "lucide-react";
import { ipc } from "@/lib/ipc";
import { useSessionStore } from "@/lib/store/useSessionStore";
import { useProjectStore } from "@/lib/store/useProjectStore";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import type { AgentInfo } from "@/types";

/**
 * Compact dropdown placed inside the input bar for selecting a sub-agent.
 * Only renders when the active project uses the Anthropic provider.
 * Agents are loaded lazily when the dropdown is first opened.
 */
export function AgentPickerButton() {
  const { activeSessionId, sessionAgents, setSessionAgent } = useSessionStore();
  const { projects, activeProjectId } = useProjectStore();
  const activeProject = projects.find((p) => p.id === activeProjectId);

  const provider = activeProject?.config.provider;
  const projectPath = activeProject?.path ?? "";

  const [open, setOpen] = useState(false);
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [loadingAgents, setLoadingAgents] = useState(false);

  const selectedAgent = activeSessionId
    ? (sessionAgents[activeSessionId] ?? null)
    : null;

  // Lazy-load agents the first time the dropdown opens
  useEffect(() => {
    if (!open || !projectPath || agents.length > 0) return;
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
  }, [open, projectPath, provider, agents.length]);

  const handleSelect = useCallback(
    (agentName: string | null) => {
      if (!activeSessionId) return;
      setOpen(false);
      setSessionAgent(activeSessionId, agentName);
    },
    [activeSessionId, setSessionAgent]
  );

  // Hidden when no provider is set
  if (!provider) return null;

  return (
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
              className="flex items-center gap-2 text-xs cursor-pointer"
              onClick={() => handleSelect(agent.name)}
            >
              <Bot className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
              <div className="flex-1 min-w-0">
                <div className="truncate">{agent.name}</div>
                {agent.model && (
                  <div className="text-[9px] text-muted-foreground truncate">
                    {agent.model}
                  </div>
                )}
              </div>
              {selectedAgent === agent.name && (
                <Check className="h-3 w-3 text-primary shrink-0" />
              )}
            </DropdownMenuItem>
          ))
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
