import { useState, useEffect, useCallback, useMemo } from "react";
import {
  Loader2,
  Plus,
  Trash2,
  AlertCircle,
  Check,
  RefreshCw,
  CheckCircle2,
  XCircle,
  AlertTriangle,
} from "lucide-react";
import { useIpc } from "@/lib/ipc";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { WithTooltip } from "@/components/ui/with-tooltip";
import type { McpServerInfo } from "@/types";

// ── Types (mirror electron/mcp/config.ts) ─────────────────────────────────────

type McpScope = "claude-local" | "claude-project" | "claude-user" | "copilot-global" | "aichemist-global";

interface McpServerEntry {
  type?: "stdio" | "http" | "sse";
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  [key: string]: unknown;
}

type McpServersMap = Record<string, McpServerEntry>;

// ── Scope metadata ────────────────────────────────────────────────────────────

const SCOPES: Array<{
  id: McpScope;
  label: string;
  sublabel: string;
  needsProject: boolean;
}> = [
  { id: "aichemist-global", label: "AIchemist", sublabel: "AIchemist · ~/.aichemist/mcp.json — injected per-session into both Claude and Copilot", needsProject: false },
  { id: "claude-local",     label: "Local",     sublabel: "Claude · per-project, private (~/.claude.json)", needsProject: true },
  { id: "claude-project",   label: "Project",   sublabel: "Claude · shared .mcp.json (committed to repo)",  needsProject: true },
  { id: "claude-user",      label: "User",      sublabel: "Claude · global for all projects",               needsProject: false },
  { id: "copilot-global",   label: "Copilot",   sublabel: "Copilot · ~/.copilot/mcp-config.json",           needsProject: false },
];

// Live health probes (mcpProbeManaged) only cover the AIchemist-managed scope —
// those are the servers AIchemist actually spawns and injects per-session.
const PROBED_SCOPE: McpScope = "aichemist-global";

// ── Props ─────────────────────────────────────────────────────────────────────

interface McpServersSectionProps {
  /** Used for the project-scoped tabs. When empty, those tabs are disabled. */
  projectPath: string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function emptyEntry(): McpServerEntry {
  return { type: "stdio", command: "", args: [] };
}

/** Prettify map → JSON string for the raw editor. */
function stringify(servers: McpServersMap): string {
  return JSON.stringify({ mcpServers: servers }, null, 2);
}

/** Parse raw JSON input, accepting either `{ mcpServers: {...} }` or just `{...}`. */
function parseRaw(raw: string): { ok: true; servers: McpServersMap } | { ok: false; error: string } {
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && "mcpServers" in parsed) {
      const m = (parsed as { mcpServers: unknown }).mcpServers;
      if (m && typeof m === "object") return { ok: true, servers: m as McpServersMap };
    }
    if (parsed && typeof parsed === "object") return { ok: true, servers: parsed as McpServersMap };
    return { ok: false, error: "Expected a JSON object" };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

// ── Per-row health badge (AIchemist scope only) ───────────────────────────────

function HealthBadge({ health }: { health: McpServerInfo | undefined }) {
  if (!health || health.connected === null) {
    return null;
  }
  if (health.connected) {
    const toolCount = health.tools?.length ?? 0;
    return (
      <span className="flex items-center gap-1 text-[11px] text-emerald-600">
        <CheckCircle2 className="h-3.5 w-3.5" />
        Connected
        {toolCount > 0 && (
          <span className="text-muted-foreground">
            · {toolCount} tool{toolCount === 1 ? "" : "s"}
          </span>
        )}
      </span>
    );
  }
  return (
    <WithTooltip label={health.error ?? "Failed to connect"}>
      <span className="flex items-center gap-1 text-[11px] text-destructive">
        <XCircle className="h-3.5 w-3.5" />
        Not connected
      </span>
    </WithTooltip>
  );
}

// ── Server card (form mode) ───────────────────────────────────────────────────

function ServerEditor({
  name,
  entry,
  health,
  onChangeName,
  onChange,
  onDelete,
  nameError,
}: {
  name: string;
  entry: McpServerEntry;
  health?: McpServerInfo;
  onChangeName: (v: string) => void;
  onChange: (e: McpServerEntry) => void;
  onDelete: () => void;
  nameError?: string;
}) {
  const transport = entry.type ?? (entry.url ? "http" : "stdio");
  const isHttp = transport === "http" || transport === "sse";

  const setField = <K extends keyof McpServerEntry>(k: K, v: McpServerEntry[K]) =>
    onChange({ ...entry, [k]: v });

  return (
    <div className="border rounded-md p-3 space-y-2.5 bg-card">
      <div className="flex items-start gap-2">
        <div className="flex-1 space-y-1">
          <div className="flex items-center justify-between gap-2">
            <label className="text-xs font-medium">Name</label>
            <HealthBadge health={health} />
          </div>
          <Input
            value={name}
            onChange={(e) => onChangeName(e.target.value)}
            placeholder="my-server"
            className="font-mono text-sm"
          />
          {nameError && (
            <p className="text-[11px] text-destructive flex items-center gap-1">
              <AlertCircle className="h-3 w-3" /> {nameError}
            </p>
          )}
          {health?.connected === false && health.error && (
            <p className="text-[11px] text-destructive flex items-start gap-1 font-mono break-words">
              <AlertTriangle className="h-3 w-3 shrink-0 mt-0.5" /> {health.error}
            </p>
          )}
        </div>
        <WithTooltip label="Remove server">
          <Button variant="ghost" size="icon" onClick={onDelete} aria-label="Remove server">
            <Trash2 className="h-4 w-4 text-destructive" />
          </Button>
        </WithTooltip>
      </div>

      <div className="grid grid-cols-[100px_1fr] gap-2 items-center">
        <label className="text-xs font-medium">Transport</label>
        <select
          value={transport}
          onChange={(e) => setField("type", e.target.value as McpServerEntry["type"])}
          className="flex h-8 rounded-md border border-input bg-transparent px-2 text-sm"
        >
          <option value="stdio">stdio</option>
          <option value="http">http</option>
          <option value="sse">sse</option>
        </select>
      </div>

      {!isHttp && (
        <>
          <div className="space-y-1">
            <label className="text-xs font-medium">Command</label>
            <Input
              value={entry.command ?? ""}
              onChange={(e) => setField("command", e.target.value)}
              placeholder="npx"
              className="font-mono text-sm"
            />
          </div>
          <div className="space-y-1">
            <label className="text-xs font-medium">Args (one per line)</label>
            <Textarea
              value={(entry.args ?? []).join("\n")}
              onChange={(e) => setField("args", e.target.value.split("\n").filter((l) => l.length > 0))}
              placeholder="-y&#10;@scope/package"
              className="font-mono text-xs min-h-[64px]"
            />
          </div>
        </>
      )}

      {isHttp && (
        <div className="space-y-1">
          <label className="text-xs font-medium">URL</label>
          <Input
            value={entry.url ?? ""}
            onChange={(e) => setField("url", e.target.value)}
            placeholder="https://example.com/mcp"
            className="font-mono text-sm"
          />
        </div>
      )}

      <div className="space-y-1">
        <label className="text-xs font-medium">
          {isHttp ? "Headers" : "Env"} (KEY=value, one per line)
        </label>
        <Textarea
          value={Object.entries((isHttp ? entry.headers : entry.env) ?? {})
            .map(([k, v]) => `${k}=${v}`)
            .join("\n")}
          onChange={(e) => {
            const map: Record<string, string> = {};
            for (const line of e.target.value.split("\n")) {
              const idx = line.indexOf("=");
              if (idx > 0) map[line.slice(0, idx).trim()] = line.slice(idx + 1);
            }
            setField(isHttp ? "headers" : "env", Object.keys(map).length ? map : undefined);
          }}
          placeholder={isHttp ? "Authorization=Bearer xxx" : "API_KEY=xxx"}
          className="font-mono text-xs min-h-[48px]"
        />
      </div>
    </div>
  );
}

// ── The section ───────────────────────────────────────────────────────────────

export function McpServersSection({ projectPath }: McpServersSectionProps) {
  const ipc = useIpc();
  const [scope, setScope] = useState<McpScope>("aichemist-global");
  const [servers, setServers] = useState<McpServersMap | null>(null);
  const [draftNames, setDraftNames] = useState<string[]>([]);
  const [mode, setMode] = useState<"form" | "json">("form");
  const [rawJson, setRawJson] = useState("");
  const [rawError, setRawError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  // Live health for the AIchemist-managed scope, keyed by server name.
  const [health, setHealth] = useState<Map<string, McpServerInfo>>(new Map());
  const [probing, setProbing] = useState(false);

  const needsProject = SCOPES.find((s) => s.id === scope)?.needsProject ?? false;
  const missingProject = needsProject && !projectPath;
  const isProbedScope = scope === PROBED_SCOPE;

  const load = useCallback(async () => {
    if (missingProject) {
      setServers({});
      setDraftNames([]);
      setRawJson(stringify({}));
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const result = await ipc.mcpReadConfig({ scope, projectPath: projectPath || undefined });
      setServers(result);
      setDraftNames(Object.keys(result));
      setRawJson(stringify(result));
      setRawError(null);
    } catch (e) {
      setError(String(e));
      setServers({});
    } finally {
      setLoading(false);
    }
  }, [ipc, scope, projectPath, missingProject]);

  // Probe the managed servers and index the live health by name. Fail-safe — a
  // probe error never blocks editing, it just leaves the rows without a badge.
  const refreshHealth = useCallback(async () => {
    setProbing(true);
    try {
      const probed = await ipc.mcpProbeManaged();
      const next = new Map<string, McpServerInfo>();
      for (const s of probed) {
        if (s.source === "aichemist") next.set(s.name, s);
      }
      setHealth(next);
    } catch (e) {
      console.error("[McpServersSection] health probe failed", e);
    } finally {
      setProbing(false);
    }
  }, [ipc]);

  useEffect(() => {
    setSaved(false);
    load();
  }, [scope, projectPath, load]);

  // Fetch live health when viewing the probed (AIchemist) scope.
  useEffect(() => {
    if (isProbedScope) void refreshHealth();
    else setHealth(new Map());
  }, [isProbedScope, refreshHealth]);

  // ── Form mode mutations ───────────────────────────────────────────────────
  const entries = useMemo(() => {
    if (!servers) return [];
    return draftNames.map((n, i) => ({ name: n, entry: servers[n] ?? emptyEntry(), index: i }));
  }, [servers, draftNames]);

  const duplicateNames = useMemo(() => {
    const counts = new Map<string, number>();
    for (const n of draftNames) counts.set(n, (counts.get(n) ?? 0) + 1);
    return new Set([...counts.entries()].filter(([, c]) => c > 1).map(([n]) => n));
  }, [draftNames]);

  const updateEntry = (index: number, entry: McpServerEntry) => {
    const name = draftNames[index];
    setServers((prev) => ({ ...(prev ?? {}), [name]: entry }));
  };

  const renameEntry = (index: number, newName: string) => {
    const oldName = draftNames[index];
    const next = [...draftNames];
    next[index] = newName;
    setDraftNames(next);
    setServers((prev) => {
      const out = { ...(prev ?? {}) };
      const entry = out[oldName] ?? emptyEntry();
      delete out[oldName];
      out[newName] = entry;
      return out;
    });
  };

  const addEntry = () => {
    let base = "new-server";
    let i = 1;
    while (draftNames.includes(base)) base = `new-server-${++i}`;
    setDraftNames([...draftNames, base]);
    setServers((prev) => ({ ...(prev ?? {}), [base]: emptyEntry() }));
  };

  const deleteEntry = (index: number) => {
    const name = draftNames[index];
    setDraftNames(draftNames.filter((_, i) => i !== index));
    setServers((prev) => {
      if (!prev) return prev;
      const out = { ...prev };
      delete out[name];
      return out;
    });
  };

  // ── Save ──────────────────────────────────────────────────────────────────
  const save = async () => {
    setSaving(true);
    setError(null);

    let toWrite: McpServersMap;
    if (mode === "json") {
      const res = parseRaw(rawJson);
      if (!res.ok) { setRawError(res.error); setSaving(false); return; }
      toWrite = res.servers;
    } else {
      if (duplicateNames.size > 0) {
        setError(`Duplicate server names: ${[...duplicateNames].join(", ")}`);
        setSaving(false);
        return;
      }
      if (draftNames.some((n) => !n.trim())) {
        setError("Every server must have a name");
        setSaving(false);
        return;
      }
      toWrite = servers ?? {};
    }

    try {
      await ipc.mcpWriteConfig({ scope, servers: toWrite, projectPath: projectPath || undefined });
      setServers(toWrite);
      setDraftNames(Object.keys(toWrite));
      setRawJson(stringify(toWrite));
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
      // Re-probe so the per-row health reflects the just-saved config.
      if (isProbedScope) void refreshHealth();
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  };

  // ── Mode switch (sync state into the other view) ──────────────────────────
  const switchMode = (next: "form" | "json") => {
    if (next === mode) return;
    if (next === "json") {
      setRawJson(stringify(servers ?? {}));
      setRawError(null);
    } else {
      const res = parseRaw(rawJson);
      if (!res.ok) { setRawError(res.error); return; }
      setServers(res.servers);
      setDraftNames(Object.keys(res.servers));
      setRawError(null);
    }
    setMode(next);
  };

  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <p className="text-sm text-muted-foreground">
          Configure MCP servers. AIchemist-managed servers
          (<code className="font-mono text-xs">~/.aichemist/mcp.json</code>) are injected
          per-session into both Claude and Copilot, with a live health check per row.
          Per-session enable/disable stays in the MCP panel.
        </p>
      </div>

      {/* Scope tabs */}
      <div className="flex border-b gap-1">
        {SCOPES.map((s) => {
          const disabled = s.needsProject && !projectPath;
          return (
            <WithTooltip
              key={s.id}
              label={s.sublabel + (disabled ? " — requires an active project" : "")}
            >
              <button
                onClick={() => !disabled && setScope(s.id)}
                disabled={disabled}
                className={cn(
                  "px-3 py-2 text-sm font-medium border-b-2 -mb-px transition-colors",
                  scope === s.id
                    ? "border-primary text-foreground"
                    : "border-transparent text-muted-foreground hover:text-foreground",
                  disabled && "opacity-40 cursor-not-allowed",
                )}
              >
                {s.label}
              </button>
            </WithTooltip>
          );
        })}
        <div className="ml-auto flex items-center gap-1 pb-1">
          {isProbedScope && (
            <WithTooltip label="Re-probe server health">
              <Button
                variant="ghost"
                size="icon"
                onClick={() => void refreshHealth()}
                disabled={probing}
                aria-label="Refresh health"
              >
                <RefreshCw className={cn("h-4 w-4", probing && "animate-spin")} />
              </Button>
            </WithTooltip>
          )}
          <Button
            variant={mode === "form" ? "secondary" : "ghost"}
            size="sm"
            onClick={() => switchMode("form")}
          >
            Form
          </Button>
          <Button
            variant={mode === "json" ? "secondary" : "ghost"}
            size="sm"
            onClick={() => switchMode("json")}
          >
            JSON
          </Button>
        </div>
      </div>

      <p className="text-xs text-muted-foreground -mt-2">
        {SCOPES.find((s) => s.id === scope)?.sublabel}
      </p>

      {/* Body */}
      <div className="min-h-[160px]">
        {missingProject && (
          <div className="p-4 text-sm text-muted-foreground">
            This scope requires an active project. Select a project first.
          </div>
        )}
        {loading && !missingProject && (
          <div className="flex items-center justify-center h-32 gap-2 text-muted-foreground text-sm">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading…
          </div>
        )}
        {!loading && !missingProject && mode === "form" && servers !== null && (
          <div className="space-y-3 pr-1">
            {entries.length === 0 && (
              <div className="text-sm text-muted-foreground py-8 text-center">
                No servers configured in this scope.
              </div>
            )}
            {entries.map(({ name, entry, index }) => (
              <ServerEditor
                key={index}
                name={name}
                entry={entry}
                health={isProbedScope ? health.get(name) : undefined}
                onChangeName={(v) => renameEntry(index, v)}
                onChange={(e) => updateEntry(index, e)}
                onDelete={() => deleteEntry(index)}
                nameError={duplicateNames.has(name) ? "Duplicate name" : undefined}
              />
            ))}
            <Button variant="outline" size="sm" onClick={addEntry} className="w-full">
              <Plus className="h-4 w-4 mr-1" /> Add server
            </Button>
          </div>
        )}
        {!loading && !missingProject && mode === "json" && (
          <div className="space-y-2">
            <Textarea
              value={rawJson}
              onChange={(e) => { setRawJson(e.target.value); setRawError(null); }}
              spellCheck={false}
              className="font-mono text-xs min-h-[380px]"
            />
            {rawError && (
              <p className="text-xs text-destructive flex items-center gap-1">
                <AlertCircle className="h-3 w-3" /> {rawError}
              </p>
            )}
          </div>
        )}
      </div>

      {/* Footer: save + status */}
      <div className="flex items-center gap-2 border-t border-border pt-3">
        {error && (
          <span className="text-xs text-destructive flex items-center gap-1 mr-auto">
            <AlertCircle className="h-3 w-3" /> {error}
          </span>
        )}
        {saved && (
          <span className="text-xs text-emerald-600 flex items-center gap-1 mr-auto">
            <Check className="h-3 w-3" /> Saved
          </span>
        )}
        <Button onClick={save} disabled={saving || missingProject} className="ml-auto">
          {saving ? "Saving…" : "Save"}
        </Button>
      </div>
    </div>
  );
}
