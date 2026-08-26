import { useState, useCallback, useEffect, useMemo } from "react";
import { Loader2, Search, CheckCircle2, XCircle, AlertCircle, Store, Trash2 } from "lucide-react";
import { useIpc } from "@/lib/ipc";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { WithTooltip } from "@/components/ui/with-tooltip";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";

// ── Types (mirror electron/mcp/marketplace.ts) ────────────────────────────────

interface MarketplaceConfigField {
  key: string;
  label: string;
  required: boolean;
  secret?: boolean;
  placeholder?: string;
}

interface MarketplaceEntry {
  id: string;
  name: string;
  description: string;
  homepage?: string;
  tags?: string[];
  transport: "stdio" | "http" | "sse";
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  configFields?: MarketplaceConfigField[];
}

type MarketplaceListItem = MarketplaceEntry & { installed: boolean };

interface EntryProbe {
  connected: boolean;
  tools?: string[];
  error?: string;
}

interface EntryUiState {
  values: Record<string, string>;
  installing: boolean;
  error: string | null;
  probe?: EntryProbe;
}

const EMPTY_UI_STATE: EntryUiState = { values: {}, installing: false, error: null };

/**
 * Client-side preview of `{{token}}` substitution, shown so the user can see
 * what will actually run before confirming install. Display-only — the real
 * substitution happens in the main process via `buildServerEntry`.
 */
function previewSubstitute(s: string, values: Record<string, string>): string {
  return s.replace(/\{\{(\w+)\}\}/g, (_match, key: string) => {
    const v = values[key];
    return v?.trim() ? v : `{{${key}}}`;
  });
}

function commandPreview(entry: MarketplaceEntry, values: Record<string, string>): string {
  if (entry.transport !== "stdio") {
    return previewSubstitute(entry.url ?? "", values);
  }
  const parts = [entry.command, ...(entry.args ?? [])].filter((p): p is string => !!p);
  return parts.map((p) => previewSubstitute(p, values)).join(" ");
}

// ── Panel ─────────────────────────────────────────────────────────────────────

interface McpMarketplacePanelProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called after a successful install or uninstall so the caller can refresh its own view of the AIchemist scope. */
  onChanged?: () => void;
}

export function McpMarketplacePanel({ open, onOpenChange, onChanged }: McpMarketplacePanelProps) {
  const ipc = useIpc();
  const [entries, setEntries] = useState<MarketplaceListItem[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [activeTag, setActiveTag] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [uiState, setUiState] = useState<Record<string, EntryUiState>>({});

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      setEntries(await ipc.mcpMarketplaceList());
    } catch (e) {
      setLoadError(String(e));
    } finally {
      setLoading(false);
    }
  }, [ipc]);

  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  const tags = useMemo(() => {
    const set = new Set<string>();
    for (const e of entries ?? []) for (const t of e.tags ?? []) set.add(t);
    return [...set].sort();
  }, [entries]);

  const filtered = useMemo(() => {
    if (!entries) return [];
    const q = query.trim().toLowerCase();
    return entries.filter((e) => {
      if (activeTag && !(e.tags ?? []).includes(activeTag)) return false;
      if (!q) return true;
      return (
        e.name.toLowerCase().includes(q) ||
        e.description.toLowerCase().includes(q) ||
        (e.tags ?? []).some((t) => t.toLowerCase().includes(q))
      );
    });
  }, [entries, query, activeTag]);

  const getUi = useCallback((id: string) => uiState[id] ?? EMPTY_UI_STATE, [uiState]);
  const setUi = useCallback(
    (id: string, patch: Partial<EntryUiState>) =>
      setUiState((prev) => ({ ...prev, [id]: { ...(prev[id] ?? EMPTY_UI_STATE), ...patch } })),
    [],
  );

  const doInstall = async (entry: MarketplaceEntry) => {
    const values = getUi(entry.id).values;
    setUi(entry.id, { installing: true, error: null });
    try {
      const { probe } = await ipc.mcpMarketplaceInstall({ entryId: entry.id, values });
      setEntries((prev) => prev?.map((e) => (e.id === entry.id ? { ...e, installed: true } : e)) ?? prev);
      setUi(entry.id, { installing: false, probe });
      setExpandedId(null);
      onChanged?.();
    } catch (e) {
      setUi(entry.id, { installing: false, error: String(e) });
    }
  };

  const doUninstall = async (entry: MarketplaceEntry) => {
    setUi(entry.id, { installing: true, error: null });
    try {
      await ipc.mcpMarketplaceUninstall({ entryId: entry.id });
      setEntries((prev) => prev?.map((e) => (e.id === entry.id ? { ...e, installed: false } : e)) ?? prev);
      setUiState((prev) => {
        const next = { ...prev };
        delete next[entry.id];
        return next;
      });
      onChanged?.();
    } catch (e) {
      setUi(entry.id, { installing: false, error: String(e) });
    }
  };

  const handleInstallClick = (entry: MarketplaceEntry) => {
    if ((entry.configFields ?? []).length === 0) {
      void doInstall(entry);
      return;
    }
    setExpandedId(entry.id);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl max-h-[85vh] flex flex-col gap-3">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Store className="h-4 w-4" /> MCP Marketplace
          </DialogTitle>
          <DialogDescription>
            A curated set of MCP servers you can install into the AIchemist-managed scope
            (<code className="font-mono text-xs">~/.aichemist/mcp.json</code>). Installing runs the
            server's command locally — review it before confirming.
          </DialogDescription>
        </DialogHeader>

        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search servers…"
            className="pl-8"
          />
        </div>

        {tags.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {tags.map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => setActiveTag((prev) => (prev === t ? null : t))}
                aria-pressed={activeTag === t}
              >
                <Badge variant={activeTag === t ? "default" : "outline"}>{t}</Badge>
              </button>
            ))}
          </div>
        )}

        <div className="flex-1 overflow-y-auto -mx-1 px-1 space-y-2 min-h-[240px]">
          {loading && (
            <div className="flex items-center justify-center h-40 gap-2 text-muted-foreground text-sm">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading…
            </div>
          )}
          {!loading && loadError && (
            <div className="flex items-center justify-center h-40 gap-1 text-sm text-destructive">
              <AlertCircle className="h-3.5 w-3.5" /> {loadError}
            </div>
          )}
          {!loading && !loadError && filtered.length === 0 && (
            <div className="text-sm text-muted-foreground text-center py-10">
              {query || activeTag ? "No servers match your filters." : "No servers in the catalog."}
            </div>
          )}
          {!loading &&
            !loadError &&
            filtered.map((entry) => (
              <MarketplaceCard
                key={entry.id}
                entry={entry}
                expanded={expandedId === entry.id}
                ui={getUi(entry.id)}
                onInstallClick={() => handleInstallClick(entry)}
                onCancelExpand={() => setExpandedId(null)}
                onValuesChange={(values) => setUi(entry.id, { values })}
                onConfirmInstall={() => void doInstall(entry)}
                onUninstall={() => void doUninstall(entry)}
              />
            ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ── Card ──────────────────────────────────────────────────────────────────────

function MarketplaceCard({
  entry,
  expanded,
  ui,
  onInstallClick,
  onCancelExpand,
  onValuesChange,
  onConfirmInstall,
  onUninstall,
}: {
  entry: MarketplaceListItem;
  expanded: boolean;
  ui: EntryUiState;
  onInstallClick: () => void;
  onCancelExpand: () => void;
  onValuesChange: (values: Record<string, string>) => void;
  onConfirmInstall: () => void;
  onUninstall: () => void;
}) {
  const missingRequired = (entry.configFields ?? []).some(
    (field) => field.required && !ui.values[field.key]?.trim(),
  );

  return (
    <div className="border rounded-md p-3 space-y-2 bg-card">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-medium text-sm">{entry.name}</span>
            <Badge variant="outline" className="text-[10px]">
              Verified
            </Badge>
            {entry.installed && (
              <span className="flex items-center gap-1 text-[11px] text-emerald-600">
                <CheckCircle2 className="h-3 w-3" /> Installed
              </span>
            )}
          </div>
          <p className="text-xs text-muted-foreground mt-0.5">{entry.description}</p>
          {entry.tags && entry.tags.length > 0 && (
            <div className="flex flex-wrap gap-1 mt-1">
              {entry.tags.map((t) => (
                <Badge key={t} variant="secondary" className="text-[10px]">
                  {t}
                </Badge>
              ))}
            </div>
          )}
        </div>
        <div className="shrink-0">
          {entry.installed ? (
            <WithTooltip label="Remove from ~/.aichemist/mcp.json">
              <Button
                variant="ghost"
                size="icon"
                onClick={onUninstall}
                disabled={ui.installing}
                aria-label={`Uninstall ${entry.name}`}
              >
                <Trash2 className="h-4 w-4 text-destructive" />
              </Button>
            </WithTooltip>
          ) : (
            <Button size="sm" onClick={onInstallClick} disabled={ui.installing || expanded}>
              {ui.installing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Install"}
            </Button>
          )}
        </div>
      </div>

      {ui.error && (
        <p className="text-[11px] text-destructive flex items-start gap-1">
          <AlertCircle className="h-3 w-3 shrink-0 mt-0.5" /> {ui.error}
        </p>
      )}
      {ui.probe && !expanded && (ui.probe.connected ? (
        <p className="text-[11px] text-emerald-600 flex items-center gap-1">
          <CheckCircle2 className="h-3 w-3" /> Connected
          {ui.probe.tools && ui.probe.tools.length > 0 && (
            <span className="text-muted-foreground">
              · {ui.probe.tools.length} tool{ui.probe.tools.length === 1 ? "" : "s"}
            </span>
          )}
        </p>
      ) : (
        <p className="text-[11px] text-destructive flex items-start gap-1">
          <XCircle className="h-3 w-3 shrink-0 mt-0.5" /> {ui.probe.error ?? "Failed to connect"}
        </p>
      ))}

      {expanded && (
        <div className="border-t pt-2 space-y-2">
          {(entry.configFields ?? []).map((field) => {
            const inputId = `mcp-marketplace-${entry.id}-${field.key}`;
            return (
              <div key={field.key} className="space-y-1">
                <label htmlFor={inputId} className="text-xs font-medium">
                  {field.label}
                  {field.required && <span className="text-destructive"> *</span>}
                </label>
                <Input
                  id={inputId}
                  type={field.secret ? "password" : "text"}
                  value={ui.values[field.key] ?? ""}
                  onChange={(e) => onValuesChange({ ...ui.values, [field.key]: e.target.value })}
                  placeholder={field.placeholder}
                  className="font-mono text-xs"
                />
              </div>
            );
          })}
          <div className="rounded bg-muted/50 p-2 font-mono text-[11px] break-all text-muted-foreground">
            {entry.transport === "stdio" ? "$ " : "→ "}
            {commandPreview(entry, ui.values)}
          </div>
          <div className="flex items-center justify-end gap-2 pt-1">
            <Button variant="ghost" size="sm" onClick={onCancelExpand}>
              Cancel
            </Button>
            <Button size="sm" onClick={onConfirmInstall} disabled={ui.installing || missingRequired}>
              {ui.installing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Install"}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
