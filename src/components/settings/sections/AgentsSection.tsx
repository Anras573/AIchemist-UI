import { useState, useCallback } from "react";
import { AlertCircle, Eye, Loader2, Pencil, Plus } from "lucide-react";
import { useIpc } from "@/lib/ipc";
import { useIpcQuery } from "@/lib/hooks/useIpcQuery";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { WithTooltip } from "@/components/ui/with-tooltip";
import { AgentEditorModal } from "@/components/session/AgentEditorModal";
import type { AgentInfo, Provider } from "@/types";

// ── Source badge ────────────────────────────────────────────────────────────────

const SOURCE_LABEL: Record<string, { label: string; className: string }> = {
  sdk: { label: "built-in", className: "text-emerald-500" },
  project: { label: "project", className: "text-blue-500" },
  global: { label: "global", className: "text-purple-500" },
  plugin: { label: "plugin", className: "text-amber-500" },
};

function AgentSourceBadge({ source, plugin }: { source?: string; plugin?: string }) {
  if (!source) return null;
  const meta = SOURCE_LABEL[source];
  if (!meta) return null;
  const label =
    source === "plugin" && plugin
      ? plugin.includes("@")
        ? plugin.slice(0, plugin.lastIndexOf("@"))
        : plugin
      : meta.label;
  const title = source === "plugin" && plugin ? plugin : undefined;
  return (
    <span
      className={cn("text-[10px] font-medium shrink-0 truncate max-w-[160px]", meta.className)}
      title={title}
    >
      {label}
    </span>
  );
}

// ── Props ─────────────────────────────────────────────────────────────────────

interface AgentsSectionProps {
  /** Resolved provider — active session's, falling back to the app default. */
  provider: Provider | null;
  /** Active project path. May be empty when the hub is opened standalone. */
  projectPath: string;
}

// ── Section ───────────────────────────────────────────────────────────────────

export function AgentsSection({ provider, projectPath }: AgentsSectionProps) {
  const ipc = useIpc();

  // Agents are file-based and only Copilot uses a distinct discovery path; every
  // other provider (Claude / Ollama / OpenAI-compatible / Codex) reads the
  // Claude agent files, mirroring AgentPickerButton. Collapse the resolved
  // provider to the file provider that owns those files.
  const fileProvider: "anthropic" | "copilot" = provider === "copilot" ? "copilot" : "anthropic";

  const agentsKey = `hub-agents:${projectPath}:${fileProvider}`;
  const { data, error, refetch } = useIpcQuery<AgentInfo[]>(agentsKey, () =>
    fileProvider === "copilot"
      ? ipc.getCopilotAgents(projectPath)
      : ipc.getClaudeAgents(projectPath),
  );
  const agents = data ?? null;

  // Modal state — undefined closed, null "new", AgentInfo "edit/view".
  const [editingAgent, setEditingAgent] = useState<AgentInfo | null | undefined>(undefined);
  const [viewingAgent, setViewingAgent] = useState<AgentInfo | undefined>(undefined);
  const editorOpen = editingAgent !== undefined;

  const handleSaved = useCallback(() => {
    void refetch();
  }, [refetch]);

  return (
    <div className="space-y-3">
      <div className="space-y-2">
        {error ? (
          <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2.5 text-xs text-destructive">
            <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
            {String(error)}
          </div>
        ) : agents === null ? (
          <div className="flex items-center gap-2 px-2 py-6 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading agents…
          </div>
        ) : agents.length === 0 ? (
          <div className="px-2 py-6 text-sm text-muted-foreground">
            No agents found. Create one with the button below.
          </div>
        ) : (
          agents.map((agent) => {
            const canEdit = agent.editable !== false && !!agent.path;
            return (
              <div
                key={`${agent.source ?? ""}:${agent.name}`}
                className="flex items-start gap-2 rounded-md border border-border bg-card px-3 py-2.5"
              >
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium truncate">{agent.name}</span>
                    <AgentSourceBadge source={agent.source} plugin={agent.plugin} />
                    {agent.model && (
                      <span className="shrink-0 rounded px-1 py-0 text-[10px] font-medium bg-muted text-muted-foreground leading-4">
                        {agent.model}
                      </span>
                    )}
                  </div>
                  {agent.description && (
                    <p className="text-xs text-muted-foreground mt-0.5 line-clamp-2 leading-relaxed">
                      {agent.description}
                    </p>
                  )}
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  <WithTooltip label="View agent">
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7"
                      onClick={() => setViewingAgent(agent)}
                      aria-label="View agent"
                    >
                      <Eye className="h-3.5 w-3.5 text-muted-foreground" />
                    </Button>
                  </WithTooltip>
                  {canEdit && (
                    <WithTooltip label="Edit agent">
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7"
                        onClick={() => setEditingAgent(agent)}
                        aria-label="Edit agent"
                      >
                        <Pencil className="h-3.5 w-3.5 text-muted-foreground" />
                      </Button>
                    </WithTooltip>
                  )}
                </div>
              </div>
            );
          })
        )}
      </div>

      <Button
        variant="outline"
        size="sm"
        className="w-full gap-1.5"
        onClick={() => setEditingAgent(null)}
      >
        <Plus className="h-4 w-4" />
        New Agent
      </Button>

      {editorOpen && (
        <AgentEditorModal
          agent={editingAgent ?? null}
          provider={fileProvider}
          projectPath={projectPath}
          open={editorOpen}
          onClose={() => setEditingAgent(undefined)}
          onSaved={handleSaved}
        />
      )}

      {viewingAgent && (
        <AgentEditorModal
          agent={viewingAgent}
          provider={fileProvider}
          projectPath={projectPath}
          open={true}
          onClose={() => setViewingAgent(undefined)}
          onSaved={() => setViewingAgent(undefined)}
          readOnly
        />
      )}
    </div>
  );
}
