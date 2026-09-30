import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, ChevronUp, Loader2, Plus, RefreshCw, Trash2 } from "lucide-react";
import { useIpc } from "@/lib/ipc";
import { useIpcQuery } from "@/lib/hooks/useIpcQuery";
import { useProjectStore } from "@/lib/store/useProjectStore";
import { useSessionStore } from "@/lib/store/useSessionStore";
import { useCanvasStore } from "@/lib/store/useCanvasStore";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { CanvasFrame } from "./CanvasFrame";
import { CanvasTrustPrompt } from "./CanvasTrustPrompt";
import type {
  CanvasDefinitionEntry,
  CanvasDiscoveryResult,
  CanvasHostStatus,
  CanvasListItem,
  CanvasTrustStatus,
} from "@/types";

const STATUS_STYLES: Record<CanvasHostStatus, string> = {
  starting: "bg-blue-500/15 text-blue-600 dark:text-blue-400",
  running: "bg-green-500/15 text-green-600 dark:text-green-400",
  stopped: "bg-muted text-muted-foreground",
  crashed: "bg-amber-500/15 text-amber-600 dark:text-amber-400",
  errored: "bg-destructive/15 text-destructive",
  // #227: a respawn (dev-reload/crash) the manager itself refused because
  // the project-tier definition is no longer trusted — distinct from
  // "stopped" so this isn't mistaken for an idle-timeout, and distinct from
  // "crashed"/"errored" since nothing actually crashed.
  untrusted: "bg-amber-500/15 text-amber-600 dark:text-amber-400",
};

const STATUS_LABELS: Record<CanvasHostStatus, string> = {
  starting: "Starting…",
  running: "Running",
  stopped: "Stopped",
  crashed: "Crashed",
  errored: "Error",
  untrusted: "Untrusted",
};

/**
 * Discovery can list two entries sharing the same `id` (e.g. a project's
 * `.agents/canvases/kanban/` alongside the built-in `kanban` — the project
 * one never suppresses a runnable one, see `discoverCanvasDefinitions`), so
 * `id` alone isn't a safe `<option>` key/value: React would warn on the
 * duplicate key, and a controlled `<select>` would resolve the value to
 * whichever option matches first regardless of which one was actually
 * clicked (found in review on #237). `tier` is always distinct for two
 * same-`id` entries, so pairing them is enough to disambiguate.
 */
function definitionKey(d: CanvasDefinitionEntry): string {
  return `${d.tier}:${d.id}`;
}

function StatusBadge({ status }: { status: CanvasHostStatus | undefined }) {
  if (!status) return null;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium shrink-0",
        STATUS_STYLES[status]
      )}
    >
      {status === "starting" && <Loader2 className="h-2.5 w-2.5 animate-spin" />}
      {STATUS_LABELS[status]}
    </span>
  );
}

/**
 * The Canvas tab (#224): an instance picker for the active project, a "New
 * canvas…" create form, an attach toggle for the active session, the host's
 * live status, a debug log drawer, and the `CanvasFrame` itself.
 *
 * Panel lifecycle: opening (selecting) a canvas calls `CANVAS_OPEN` (starts
 * its host if needed, hydrates `useCanvasStore` from the returned state —
 * "hydrates via CANVAS_OPEN when opened" per the design doc, since a
 * headless/no-window run drops `CANVAS_EVENT` pushes entirely); switching
 * away or unmounting calls `CANVAS_CLOSE` (lets the host idle-stop, never
 * stops it directly — a running turn keeps it alive regardless).
 */
export function CanvasPanel() {
  const ipc = useIpc();
  const activeProjectId = useProjectStore((s) => s.activeProjectId);
  const activeSessionId = useSessionStore((s) => s.activeSessionId);

  const stateByCanvas = useCanvasStore((s) => s.stateByCanvas);
  const revisionByCanvas = useCanvasStore((s) => s.revisionByCanvas);
  const statusByCanvas = useCanvasStore((s) => s.statusByCanvas);
  const lastMessageByCanvas = useCanvasStore((s) => s.lastMessageByCanvas);
  const logsByCanvas = useCanvasStore((s) => s.logsByCanvas);
  const reloadNonceByCanvas = useCanvasStore((s) => s.reloadNonceByCanvas);
  const listNonce = useCanvasStore((s) => s.listNonce);
  const setCanvasState = useCanvasStore((s) => s.setCanvasState);
  const setCanvasStatus = useCanvasStore((s) => s.setCanvasStatus);
  const clearCanvasLogs = useCanvasStore((s) => s.clearCanvasLogs);
  const focusedCanvasId = useCanvasStore((s) => s.focusedCanvasId);
  const clearCanvasFocus = useCanvasStore((s) => s.clearCanvasFocus);

  const [selectedCanvasId, setSelectedCanvasId] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [createTitle, setCreateTitle] = useState("");
  const [createDefinition, setCreateDefinition] = useState("");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [showLogs, setShowLogs] = useState(false);
  const [restarting, setRestarting] = useState(false);

  const listKey = activeProjectId ? `canvas-list:${activeProjectId}:${activeSessionId ?? ""}` : null;
  const { data: canvases, refetch } = useIpcQuery<CanvasListItem[]>(
    listKey,
    () => (activeProjectId ? ipc.canvasList({ projectId: activeProjectId, sessionId: activeSessionId ?? undefined }) : Promise.resolve([])),
    { ttl: 5_000 }
  );

  // The agent created + attached an instance (#229): refresh the picker.
  const lastListNonce = useRef(listNonce);
  useEffect(() => {
    if (lastListNonce.current === listNonce) return;
    lastListNonce.current = listNonce;
    void refetch();
  }, [listNonce, refetch]);

  // Discovered across all three tiers (project/global/built-in, #226) — this
  // is what lets "New canvas…" offer a picker instead of a free-text
  // definition name. Manifest errors are surfaced in the Settings hub's
  // Canvases section, not here.
  const definitionsKey = `canvas-definitions:${activeProjectId ?? ""}`;
  const { data: discovery, refetch: refetchDefinitions } = useIpcQuery<CanvasDiscoveryResult>(
    definitionsKey,
    () => ipc.canvasListDefinitions({ projectId: activeProjectId ?? undefined }),
    { ttl: 60_000 }
  );
  const definitions: CanvasDefinitionEntry[] | undefined = discovery?.definitions;

  // Trust status (#227) for the selected instance's definition — null once
  // loaded means "not a project-tier definition" (or its manifest doesn't
  // validate), so no prompt is needed; the global/built-in tiers are always
  // trusted. Re-fetched (not just cache-expired) right after a successful
  // grant, via `refetchTrust` in `handleTrusted` below.
  const trustKey =
    activeProjectId && selectedCanvasId
      ? `canvas-trust:${activeProjectId}:${selectedCanvasId}`
      : null;
  const selectedDefinition = canvases?.find((c) => c.id === selectedCanvasId)?.definition;
  const { data: trustStatus, refetch: refetchTrust } = useIpcQuery<CanvasTrustStatus | null>(
    trustKey,
    () =>
      activeProjectId && selectedDefinition
        ? ipc.canvasTrustStatus({ projectId: activeProjectId, definition: selectedDefinition })
        : Promise.resolve(null),
    { ttl: 10_000 }
  );

  useEffect(() => {
    if (createDefinition || !definitions?.length) return;
    const firstRunnable = definitions.find((d) => d.tier !== "project") ?? definitions[0];
    setCreateDefinition(definitionKey(firstRunnable));
  }, [definitions, createDefinition]);

  // Reset the selection when the project changes; default to the first
  // canvas once the list loads if nothing is selected yet.
  useEffect(() => {
    setSelectedCanvasId(null);
  }, [activeProjectId]);

  // An agent tool call targeted a canvas (#245): adopt it. If it isn't in the
  // list yet (just created), leave the request pending — this re-runs when the
  // `list`-triggered refetch lands.
  useEffect(() => {
    if (!focusedCanvasId || !canvases) return;
    if (!canvases.some((c) => c.id === focusedCanvasId)) return;
    setSelectedCanvasId(focusedCanvasId);
    clearCanvasFocus();
  }, [focusedCanvasId, canvases, clearCanvasFocus]);

  useEffect(() => {
    if (selectedCanvasId !== null) return;
    const first = canvases?.[0];
    if (first) setSelectedCanvasId(first.id);
  }, [canvases, selectedCanvasId]);

  const selected = useMemo(
    () => canvases?.find((c) => c.id === selectedCanvasId) ?? null,
    [canvases, selectedCanvasId]
  );

  // A definition deleted from disk while an instance still exists (#226) —
  // `definitions` not having loaded yet is treated as "not missing" so this
  // never flashes true before discovery resolves.
  const definitionMissing =
    !!selected && definitions !== undefined && !definitions.some((d) => d.id === selected.definition);

  // Panel lifecycle: open the selected canvas's host, hydrate the store from
  // the response, and close it again on switch/unmount. Skipped entirely
  // when the definition is missing — there's no host to start, and the
  // "Definition missing" state below is all the panel shows.
  useEffect(() => {
    if (!selectedCanvasId || definitionMissing) return;
    let cancelled = false;
    ipc
      .canvasOpen(selectedCanvasId)
      .then((res) => {
        if (cancelled) return;
        setCanvasState(selectedCanvasId, res.state, res.revision);
        if (res.status !== "unknown") setCanvasStatus(selectedCanvasId, res.status);
      })
      .catch((err) => console.error(`[canvas] CANVAS_OPEN failed for ${selectedCanvasId}:`, err));
    return () => {
      cancelled = true;
      void ipc.canvasClose(selectedCanvasId).catch(() => {});
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedCanvasId, definitionMissing]);

  async function handleCreate() {
    const selectedDefinition = definitions?.find((d) => definitionKey(d) === createDefinition);
    if (!activeProjectId || !createTitle.trim() || !selectedDefinition) return;
    setCreating(true);
    setCreateError(null);
    try {
      const created = await ipc.canvasCreate({
        projectId: activeProjectId,
        definition: selectedDefinition.id,
        title: createTitle.trim(),
      });
      setCreateTitle("");
      setCreateDefinition("");
      setShowCreate(false);
      await refetch();
      setSelectedCanvasId(created.id);
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : String(err));
    } finally {
      setCreating(false);
    }
  }

  async function handleDelete(canvasId: string) {
    await ipc.canvasDelete(canvasId);
    if (selectedCanvasId === canvasId) setSelectedCanvasId(null);
    await refetch();
  }

  async function handleAttachToggle(canvasId: string, attached: boolean) {
    if (!activeSessionId) return;
    await ipc.canvasAttach(activeSessionId, canvasId, attached);
    await refetch();
  }

  async function handleRestart() {
    if (!selectedCanvasId) return;
    setRestarting(true);
    try {
      const res = await ipc.canvasRestart(selectedCanvasId);
      setCanvasState(selectedCanvasId, res.state, res.revision);
      if (res.status !== "unknown") setCanvasStatus(selectedCanvasId, res.status);
    } catch (err) {
      console.error(`[canvas] restart failed for ${selectedCanvasId}:`, err);
    } finally {
      setRestarting(false);
    }
  }

  /**
   * Fired by `CanvasTrustPrompt` right after a successful `CANVAS_TRUST_GRANT`
   * — refetches trust status (so the banner disappears) and re-runs
   * `CANVAS_OPEN` to actually start the host now that it's trusted (the
   * lifecycle effect above only re-runs on `selectedCanvasId`/
   * `definitionMissing` changes, neither of which trust granting touches).
   */
  async function handleTrusted() {
    await refetchTrust();
    if (!selectedCanvasId) return;
    try {
      const res = await ipc.canvasOpen(selectedCanvasId);
      setCanvasState(selectedCanvasId, res.state, res.revision);
      if (res.status !== "unknown") setCanvasStatus(selectedCanvasId, res.status);
    } catch (err) {
      console.error(`[canvas] CANVAS_OPEN after trust failed for ${selectedCanvasId}:`, err);
    }
  }

  const status = selectedCanvasId ? statusByCanvas[selectedCanvasId] : undefined;
  const canRestart = status === "crashed" || status === "errored" || status === "stopped" || status === "untrusted";
  const logs = selectedCanvasId ? logsByCanvas[selectedCanvasId] ?? [] : [];

  if (!activeProjectId) {
    return (
      <div className="h-full flex items-center justify-center text-muted-foreground text-sm">
        No project open
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/* Toolbar */}
      <div className="flex flex-col gap-2 px-2 py-2 border-b shrink-0">
        <div className="flex items-center gap-1.5">
          <select
            value={selectedCanvasId ?? ""}
            onChange={(e) => setSelectedCanvasId(e.target.value || null)}
            className="flex-1 h-8 rounded-md border border-input bg-transparent px-2 text-sm min-w-0"
            aria-label="Canvas instance"
          >
            {!canvases?.length && <option value="">No canvases</option>}
            {canvases?.map((c) => (
              <option key={c.id} value={c.id}>
                {c.title} {c.attached ? "(attached)" : ""}
              </option>
            ))}
          </select>
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label="New canvas"
            onClick={() => {
              // Definitions are cached for 60 s, but the agent may have just
              // written a new one (#229) — re-discover whenever the form opens.
              if (!showCreate) void refetchDefinitions();
              setShowCreate((v) => !v);
            }}
          >
            <Plus className="h-3.5 w-3.5" />
          </Button>
          {selected && (
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label="Delete canvas"
              onClick={() => void handleDelete(selected.id)}
            >
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          )}
        </div>

        {showCreate && (
          <div className="flex flex-col gap-1.5 rounded-md border p-2">
            <Input
              value={createTitle}
              onChange={(e) => setCreateTitle(e.target.value)}
              placeholder="Title (e.g. Release board)"
              className="h-7 text-xs"
            />
            <select
              value={createDefinition}
              onChange={(e) => setCreateDefinition(e.target.value)}
              className="h-7 rounded-md border border-input bg-transparent px-2 text-xs"
              aria-label="Canvas definition"
            >
              {!definitions?.length && <option value="">No definitions available</option>}
              {definitions?.map((d) => (
                <option
                  key={definitionKey(d)}
                  value={definitionKey(d)}
                  title={
                    d.tier === "project"
                      ? "Project canvases need to be trusted on first open"
                      : d.manifest.description
                  }
                >
                  {d.manifest.name} ({d.tier}
                  {d.tier === "project" ? " — needs trust" : ""})
                </option>
              ))}
            </select>
            {createError && <p className="text-[11px] text-destructive">{createError}</p>}
            <div className="flex justify-end gap-1.5">
              <Button size="xs" variant="ghost" onClick={() => setShowCreate(false)}>
                Cancel
              </Button>
              <Button
                size="xs"
                onClick={() => void handleCreate()}
                disabled={creating || !createTitle.trim() || !createDefinition.trim()}
              >
                {creating ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
                Create
              </Button>
            </div>
          </div>
        )}

        {selected && (
          <div className="flex items-center gap-1.5 flex-wrap">
            <StatusBadge status={status} />
            {activeSessionId && (
              <label className="flex items-center gap-1 text-[11px] text-muted-foreground">
                <input
                  type="checkbox"
                  checked={selected.attached}
                  onChange={(e) => void handleAttachToggle(selected.id, e.target.checked)}
                />
                Attached to this session
              </label>
            )}
            <div className="flex-1" />
            {canRestart && <RestartButton onRestart={() => void handleRestart()} restarting={restarting} />}
            <Button
              size="xs"
              variant="ghost"
              onClick={() => setShowLogs((v) => !v)}
              aria-expanded={showLogs}
            >
              Logs ({logs.length})
              {showLogs ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
            </Button>
          </div>
        )}

        {showLogs && selected && (
          <div className="max-h-32 overflow-y-auto rounded-md border bg-muted/30 p-1.5 font-mono text-[10px] flex flex-col gap-0.5">
            {logs.length === 0 ? (
              <span className="text-muted-foreground">No log output yet.</span>
            ) : (
              logs.map((entry, i) => (
                <div
                  key={i}
                  className={cn(
                    entry.level === "error" && "text-destructive",
                    entry.level === "warn" && "text-amber-600 dark:text-amber-400"
                  )}
                >
                  {entry.args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ")}
                </div>
              ))
            )}
            {logs.length > 0 && (
              <button
                onClick={() => clearCanvasLogs(selected.id)}
                className="self-end text-muted-foreground hover:text-foreground mt-1"
              >
                Clear
              </button>
            )}
          </div>
        )}
      </div>

      {/* Content */}
      <div className="flex-1 overflow-hidden flex flex-col">
        {!selected ? (
          <div className="h-full flex items-center justify-center text-muted-foreground text-sm p-4 text-center">
            No canvases yet. Use <Plus className="inline h-3 w-3" /> to create one.
          </div>
        ) : definitionMissing ? (
          <div className="h-full flex flex-col items-center justify-center gap-3 text-sm p-4 text-center">
            <div>
              <p className="font-medium">Definition missing</p>
              <p className="text-muted-foreground mt-1 max-w-xs">
                The <code className="text-xs">{selected.definition}</code> canvas definition was not found on
                disk (project, global, or built-in). Its data still exists, but it can no longer run.
              </p>
            </div>
            <Button size="sm" variant="destructive" onClick={() => void handleDelete(selected.id)} className="gap-1.5">
              <Trash2 className="h-3.5 w-3.5" />
              Delete this instance
            </Button>
          </div>
        ) : (
          <>
            {/* #227: the UI still renders below (read-only, no tools —
                CANVAS_OPEN never starts a host for an untrusted project
                definition) so the user can see what they're agreeing to run. */}
            {trustStatus && !trustStatus.trusted && (
              <CanvasTrustPrompt
                projectId={activeProjectId}
                status={trustStatus}
                onTrusted={() => void handleTrusted()}
                onStale={() => void refetchTrust()}
              />
            )}
            <div className="flex-1 overflow-hidden">
              <CanvasFrame
                canvasId={selected.id}
                definition={selected.definition}
                state={stateByCanvas[selected.id] ?? selected.state}
                revision={revisionByCanvas[selected.id] ?? selected.revision}
                message={lastMessageByCanvas[selected.id]}
                reloadNonce={reloadNonceByCanvas[selected.id]}
              />
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function RestartButton({ onRestart, restarting }: { onRestart: () => void; restarting: boolean }) {
  return (
    <Button size="xs" variant="outline" onClick={onRestart} disabled={restarting}>
      {restarting ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
      Restart
    </Button>
  );
}
