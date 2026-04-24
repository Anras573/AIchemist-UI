import { useState, useEffect, useCallback, useMemo } from "react";
import { Loader2, Plus, Trash2, AlertCircle, Check } from "lucide-react";
import { useIpc } from "@/lib/ipc";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { WithTooltip } from "@/components/ui/with-tooltip";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";

// ── Types (mirror electron/mcp-config.ts) ────────────────────────────────────

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
  tier: "local" | "global";
}> = [
  { id: "aichemist-global", label: "AIchemist", sublabel: "AIchemist · ~/.aichemist/mcp.json — injected per-session into both Claude and Copilot", needsProject: false, tier: "global" },
  { id: "claude-local",     label: "Local",     sublabel: "Claude · per-project, private (~/.claude.json)", needsProject: true,  tier: "local" },
  { id: "claude-project",   label: "Project",   sublabel: "Claude · shared .mcp.json (committed to repo)",  needsProject: true,  tier: "local" },
  { id: "claude-user",      label: "User",      sublabel: "Claude · global for all projects",               needsProject: false, tier: "global" },
  { id: "copilot-global",   label: "Copilot",   sublabel: "Copilot · ~/.copilot/mcp-config.json",           needsProject: false, tier: "global" },
];

// ── Props ─────────────────────────────────────────────────────────────────────

interface Props {
  open: boolean;
  onClose: () => void;
  /** Used for the project-scoped tabs. When empty, those tabs are disabled. */
  projectPath: string;
  /** Called after a successful save so the caller can refresh its list. */
  onSaved?: () => void;
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

// ── Server card (form mode) ───────────────────────────────────────────────────

function ServerEditor({
  name,
  entry,
  onChangeName,
  onChange,
  onDelete,
  nameError,
}: {
  name: string;
  entry: McpServerEntry;
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
          <label className="text-xs font-medium">Name</label>
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

// ── Main dialog ───────────────────────────────────────────────────────────────

export function McpConfigEditorDialog({ open, onClose, projectPath, onSaved }: Props) {
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

  const needsProject = SCOPES.find((s) => s.id === scope)?.needsProject ?? false;
  const missingProject = needsProject && !projectPath;

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

  useEffect(() => {
    if (!open) return;
    setSaved(false);
    load();
  }, [open, scope, projectPath, load]);

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
      onSaved?.();
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
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-4xl w-full flex flex-col max-h-[90vh]">
        <DialogHeader>
          <DialogTitle>MCP Servers</DialogTitle>
        </DialogHeader>

        {/* Scope tabs */}
        <div className="flex border-b gap-1 -mt-1">
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

        <p className="text-xs text-muted-foreground -mt-1">
          {SCOPES.find((s) => s.id === scope)?.sublabel}
        </p>

        {/* Body */}
        <div className="flex-1 overflow-y-auto min-h-[200px]">
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

        <DialogFooter className="flex items-center gap-2">
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
          <Button variant="ghost" onClick={onClose}>Close</Button>
          <Button onClick={save} disabled={saving || missingProject}>
            {saving ? "Saving…" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
