import { useEffect, useState, useCallback } from "react";
import { RefreshCw, Server, CheckCircle2, XCircle, MinusCircle, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { useIpc } from "@/lib/ipc";
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

function StatusIcon({ connected }: { connected: boolean | null }) {
  if (connected === null) {
    return <MinusCircle className="h-4 w-4 text-muted-foreground" />;
  }
  return connected
    ? <CheckCircle2 className="h-4 w-4 text-emerald-500" />
    : <XCircle className="h-4 w-4 text-destructive" />;
}

function ServerCard({ server }: { server: McpServerInfo }) {
  const prefix = pluginPrefix(server.name);

  return (
    <div className="flex items-start gap-2.5 px-3 py-2.5 border-b last:border-b-0 hover:bg-muted/30 transition-colors">
      <div className="shrink-0 mt-0.5">
        <StatusIcon connected={server.connected} />
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5 flex-wrap">
          <span className="text-xs font-medium truncate">{displayName(server.name)}</span>
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
          {prefix && (
            <span className="text-[10px] text-muted-foreground truncate">{prefix}</span>
          )}
        </div>
        <p className="text-[11px] text-muted-foreground font-mono truncate mt-0.5" title={server.command}>
          {server.command}
        </p>
      </div>
    </div>
  );
}

// ── McpServersPanel ───────────────────────────────────────────────────────────

export function McpServersPanel() {
  const ipc = useIpc();
  const [servers, setServers] = useState<McpServerInfo[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await ipc.listMcpServers();
      setServers(result);
    } catch (e) {
      setError(String(e));
      setServers([]);
    } finally {
      setLoading(false);
    }
  }, [ipc]);

  useEffect(() => { load(); }, [load]);

  const connected = servers?.filter((s) => s.connected === true) ?? [];
  const failed = servers?.filter((s) => s.connected === false) ?? [];
  const unknown = servers?.filter((s) => s.connected === null) ?? [];

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Toolbar */}
      <div className="flex items-center justify-between px-3 py-1.5 border-b shrink-0">
        {servers !== null && !loading && (
          <span className="text-[11px] text-muted-foreground">
            {connected.length} connected · {failed.length} failed
            {unknown.length > 0 && ` · ${unknown.length} configured`}
          </span>
        )}
        {(servers === null || loading) && (
          <span className="text-[11px] text-muted-foreground">Loading…</span>
        )}
        <button
          onClick={load}
          disabled={loading}
          className={cn(
            "flex items-center justify-center h-6 w-6 rounded-sm text-muted-foreground hover:text-foreground hover:bg-muted transition-colors ml-auto",
            loading && "opacity-50 cursor-not-allowed"
          )}
          title="Refresh"
        >
          <RefreshCw className={cn("h-3.5 w-3.5", loading && "animate-spin")} />
        </button>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto">
        {loading && servers === null && (
          <div className="flex items-center justify-center h-full gap-2 text-muted-foreground text-xs">
            <Loader2 className="h-4 w-4 animate-spin" />
            Checking MCP servers…
          </div>
        )}
        {error && (
          <div className="p-3 text-xs text-destructive">{error}</div>
        )}
        {!loading && servers !== null && servers.length === 0 && (
          <div className="flex flex-col items-center justify-center h-full gap-2 text-muted-foreground text-xs">
            <Server className="h-8 w-8 opacity-30" />
            <span>No MCP servers found</span>
            <span className="text-[11px]">Configure servers via <code className="font-mono">claude mcp add</code></span>
          </div>
        )}
        {servers && servers.length > 0 && (
          <div className="divide-y-0">
            {servers.map((s) => (
              <ServerCard key={`${s.source}:${s.name}`} server={s} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
