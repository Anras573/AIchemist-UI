import { useEffect, useState, useCallback, useMemo } from "react";
import { RefreshCw, Server, CheckCircle2, XCircle, MinusCircle, Loader2, Settings, ChevronRight, AlertTriangle } from "lucide-react";
import { cn } from "@/lib/utils";
import { useIpc } from "@/lib/ipc";
import { useProjectStore } from "@/lib/store/useProjectStore";
import { useSessionStore } from "@/lib/store/useSessionStore";
import { useActiveSessionProvider } from "@/lib/hooks/useActiveSessionProvider";
import { WithTooltip } from "@/components/ui/with-tooltip";
import { McpConfigEditorDialog } from "./McpConfigEditorDialog";
import type { McpServerInfo } from "@/types";

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Returns a short label for the server name, stripping the "plugin:org:" prefix. */
function displayName(name: string): string {
  // plugin:context7:context7 → context7
  const parts = name.split(":");
  return parts.at(-1) ?? name;
}

/** Returns the prefix segment of a plugin server name (e.g. "plugin:context7"). */
function pluginPrefix(name: string): string | undefined {
  if (!name.startsWith("plugin:")) return undefined;
  const parts = name.split(":");
  return parts.slice(0, -1).join(":");
}

// ── ServerCard ────────────────────────────────────────────────────────────────

function StatusIcon({ connected, disabled }: { connected: boolean | null; disabled?: boolean }) {
  if (disabled) {
    return <MinusCircle className="h-4 w-4 text-muted-foreground/50" />;
  }
  if (connected === null) {
    return <MinusCircle className="h-4 w-4 text-muted-foreground" />;
  }
  return connected
    ? <CheckCircle2 className="h-4 w-4 text-emerald-500" />
    : <XCircle className="h-4 w-4 text-destructive" />;
}

function ServerCard({
  server,
  disabled,
  canToggle,
  onToggle,
}: {
  server: McpServerInfo;
  disabled: boolean;
  canToggle: boolean;
  onToggle: () => void;
}) {
  const prefix = pluginPrefix(server.name);
  const [expanded, setExpanded] = useState(false);
  const hasTools = (server.tools?.length ?? 0) > 0;
  const hasError = server.connected === false && !!server.error;
  const isExpandable = hasTools || hasError;

  return (
    <div className="border-b last:border-b-0 hover:bg-muted/30 transition-colors">
      <div className="flex items-start gap-2.5 px-3 py-2.5">
        {isExpandable ? (
          <button
            onClick={() => setExpanded((v) => !v)}
            className="shrink-0 mt-0.5 text-muted-foreground hover:text-foreground"
            aria-label={expanded ? "Collapse" : "Expand"}
            aria-expanded={expanded}
          >
            <ChevronRight className={cn("h-3.5 w-3.5 transition-transform", expanded && "rotate-90")} />
          </button>
        ) : (
          <div className="shrink-0 mt-0.5 w-3.5" />
        )}
        <div className="shrink-0 mt-0.5">
          <StatusIcon connected={server.connected} disabled={disabled} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className={cn("text-xs font-medium truncate", disabled && "line-through text-muted-foreground")}>
              {displayName(server.name)}
            </span>
            {server.transport && (
              <span className="text-[10px] px-1 py-0 rounded bg-muted text-muted-foreground font-mono shrink-0">
                {server.transport}
              </span>
            )}
            {(server.source === "claude" || server.source === "both") && (
              <span className="text-[10px] px-1 py-0 rounded shrink-0 bg-orange-500/10 text-orange-500">
                Claude
              </span>
            )}
            {(server.source === "copilot" || server.source === "both") && (
              <span className="text-[10px] px-1 py-0 rounded shrink-0 bg-blue-500/10 text-blue-500">
                Copilot
              </span>
            )}
            {server.source === "aichemist" && (
              <span className="text-[10px] px-1 py-0 rounded shrink-0 bg-violet-500/10 text-violet-500">
                AIchemist
              </span>
            )}
            {hasTools && (
              <span className="text-[10px] text-muted-foreground shrink-0">
                {server.tools!.length} tool{server.tools!.length === 1 ? "" : "s"}
              </span>
            )}
            {prefix && (
              <span className="text-[10px] text-muted-foreground truncate">{prefix}</span>
            )}
          </div>
          <p className="text-[11px] text-muted-foreground font-mono truncate mt-0.5" title={server.command}>
            {server.command}
          </p>
        </div>
        {canToggle && (
          <WithTooltip label={disabled ? "Enable for this session" : "Disable for this session"}>
            <button
              onClick={onToggle}
              role="switch"
              aria-checked={!disabled}
              aria-label={disabled ? "Enable for this session" : "Disable for this session"}
              className={cn(
                "shrink-0 relative inline-flex h-4 w-7 items-center rounded-full transition-colors",
                disabled ? "bg-muted" : "bg-emerald-500/70",
              )}
            >
              <span
                className={cn(
                  "inline-block h-3 w-3 transform rounded-full bg-background shadow-sm transition-transform",
                  disabled ? "translate-x-0.5" : "translate-x-3.5",
                )}
              />
            </button>
          </WithTooltip>
        )}
      </div>
      {expanded && (
        <div className="pl-10 pr-3 pb-2.5 -mt-1">
          {hasError && (
            <div className="flex items-start gap-1.5 text-[11px] text-destructive font-mono break-words">
              <AlertTriangle className="h-3 w-3 shrink-0 mt-0.5" />
              <span>{server.error}</span>
            </div>
          )}
          {hasTools && (
            <div className="flex flex-wrap gap-1 mt-1">
              {server.tools!.map((t) => (
                <span key={t} className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-muted text-muted-foreground">
                  {t}
                </span>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── McpServersPanel ───────────────────────────────────────────────────────────

export function McpServersPanel() {
  const ipc = useIpc();
  const { projects, activeProjectId } = useProjectStore();
  const activeProject = projects.find((p) => p.id === activeProjectId);
  const projectPath = activeProject?.path ?? "";
  const provider = useActiveSessionProvider();
  const activeSessionId = useSessionStore((s) => s.activeSessionId);
  const sessionDisabledMcp = useSessionStore((s) => s.sessionDisabledMcp);
  const setSessionDisabledMcp = useSessionStore((s) => s.setSessionDisabledMcp);
  const disabledSet = useMemo(
    () => new Set(activeSessionId ? sessionDisabledMcp[activeSessionId] ?? [] : []),
    [activeSessionId, sessionDisabledMcp],
  );

  const [servers, setServers] = useState<McpServerInfo[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);

  // `force=true` bypasses the 30s probe cache and re-spawns each managed server.
  // Used by the manual refresh button so users can re-test after editing config.
  const load = useCallback(async (force = false) => {
    setLoading(true);
    setError(null);
    try {
      const result = force ? await ipc.mcpProbeManaged() : await ipc.listMcpServers();
      setServers(result);
    } catch (e) {
      setError(String(e));
      setServers([]);
    } finally {
      setLoading(false);
    }
  }, [ipc]);

  useEffect(() => { load(); }, [load]);

  const handleToggle = useCallback(async (name: string) => {
    if (!activeSessionId) return;
    const current = sessionDisabledMcp[activeSessionId] ?? [];
    const isDisabled = current.includes(name);
    const next = isDisabled ? current.filter((n) => n !== name) : [...current, name];
    setSessionDisabledMcp(activeSessionId, next);
    try {
      const persisted = await ipc.updateSessionDisabledMcp(activeSessionId, next);
      // Reconcile with what the backend actually stored (defensive parse may
      // have dropped invalid entries).
      setSessionDisabledMcp(activeSessionId, persisted);
    } catch (e) {
      console.error("Failed to toggle MCP server:", e);
      // Roll back on failure.
      setSessionDisabledMcp(activeSessionId, current);
    }
  }, [activeSessionId, sessionDisabledMcp, setSessionDisabledMcp, ipc]);

  // Filter to only servers configured for the active session's provider.
  // 'both' rows show in both. AIchemist-managed rows are injected into both
  // Claude and Copilot SDK sessions, so they show under either provider lock.
  // With no provider lock, show everything.
  const visibleServers = useMemo(() => {
    if (!servers) return null;
    if (!provider) return servers;
    const providerKey = provider === "anthropic" ? "claude" : "copilot";
    return servers.filter(
      (s) => s.source === providerKey || s.source === "both" || s.source === "aichemist",
    );
  }, [servers, provider]);

  const connected = visibleServers?.filter((s) => s.connected === true) ?? [];
  const failed = visibleServers?.filter((s) => s.connected === false) ?? [];
  const unknown = visibleServers?.filter((s) => s.connected === null) ?? [];

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Toolbar */}
      <div className="flex items-center justify-between px-3 py-1.5 border-b shrink-0">
        {visibleServers !== null && !loading && (
          <span className="text-[11px] text-muted-foreground">
            {connected.length} connected · {failed.length} failed
            {unknown.length > 0 && ` · ${unknown.length} configured`}
          </span>
        )}
        {(visibleServers === null || loading) && (
          <span className="text-[11px] text-muted-foreground">Loading…</span>
        )}
        <WithTooltip label="Edit MCP config">
          <button
            onClick={() => setEditorOpen(true)}
            className="flex items-center justify-center h-6 w-6 rounded-sm text-muted-foreground hover:text-foreground hover:bg-muted transition-colors ml-auto"
            aria-label="Edit MCP config"
          >
            <Settings className="h-3.5 w-3.5" />
          </button>
        </WithTooltip>
        <WithTooltip label="Refresh (re-probe)">
          <button
            onClick={() => load(true)}
            disabled={loading}
            className={cn(
              "flex items-center justify-center h-6 w-6 rounded-sm text-muted-foreground hover:text-foreground hover:bg-muted transition-colors",
              loading && "opacity-50 cursor-not-allowed"
            )}
            aria-label="Refresh"
          >
            <RefreshCw className={cn("h-3.5 w-3.5", loading && "animate-spin")} />
          </button>
        </WithTooltip>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto">
        {loading && visibleServers === null && (
          <div className="flex items-center justify-center h-full gap-2 text-muted-foreground text-xs">
            <Loader2 className="h-4 w-4 animate-spin" />
            Checking MCP servers…
          </div>
        )}
        {error && (
          <div className="p-3 text-xs text-destructive">{error}</div>
        )}
        {!loading && visibleServers !== null && visibleServers.length === 0 && (
          <div className="flex flex-col items-center justify-center h-full gap-2 text-muted-foreground text-xs px-3 text-center">
            <Server className="h-8 w-8 opacity-30" />
            <span>
              No MCP servers configured for{" "}
              {provider === "copilot" ? "Copilot" : provider === "anthropic" ? "Claude" : "this session"}
            </span>
            {provider === "anthropic" && (
              <span className="text-[11px]">Configure servers via <code className="font-mono">claude mcp add</code></span>
            )}
          </div>
        )}
        {visibleServers && visibleServers.length > 0 && (
          <div className="divide-y-0">
            {visibleServers.map((s) => (
              <ServerCard
                key={`${s.source}:${s.name}`}
                server={s}
                disabled={s.source === "aichemist" && disabledSet.has(s.name)}
                canToggle={s.source === "aichemist" && activeSessionId !== null}
                onToggle={() => handleToggle(s.name)}
              />
            ))}
          </div>
        )}
      </div>

      <McpConfigEditorDialog
        open={editorOpen}
        onClose={() => setEditorOpen(false)}
        projectPath={projectPath}
        onSaved={() => load(true)}
      />
    </div>
  );
}
