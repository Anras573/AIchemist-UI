import { useEffect, useMemo, useState } from "react";
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
import type { CanvasHostStatus, CanvasListItem } from "@/types";

const STATUS_STYLES: Record<CanvasHostStatus, string> = {
  starting: "bg-blue-500/15 text-blue-600 dark:text-blue-400",
  running: "bg-green-500/15 text-green-600 dark:text-green-400",
  stopped: "bg-muted text-muted-foreground",
  crashed: "bg-amber-500/15 text-amber-600 dark:text-amber-400",
  errored: "bg-destructive/15 text-destructive",
};

const STATUS_LABELS: Record<CanvasHostStatus, string> = {
  starting: "Starting…",
  running: "Running",
  stopped: "Stopped",
  crashed: "Crashed",
  errored: "Error",
};

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
  const setCanvasState = useCanvasStore((s) => s.setCanvasState);
  const setCanvasStatus = useCanvasStore((s) => s.setCanvasStatus);
  const clearCanvasLogs = useCanvasStore((s) => s.clearCanvasLogs);

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

  // Reset the selection when the project changes; default to the first
  // canvas once the list loads if nothing is selected yet.
  useEffect(() => {
    setSelectedCanvasId(null);
  }, [activeProjectId]);

  useEffect(() => {
    if (selectedCanvasId !== null) return;
    const first = canvases?.[0];
    if (first) setSelectedCanvasId(first.id);
  }, [canvases, selectedCanvasId]);

  const selected = useMemo(
    () => canvases?.find((c) => c.id === selectedCanvasId) ?? null,
    [canvases, selectedCanvasId]
  );

  // Panel lifecycle: open the selected canvas's host, hydrate the store from
  // the response, and close it again on switch/unmount.
  useEffect(() => {
    if (!selectedCanvasId) return;
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
  }, [selectedCanvasId]);

  async function handleCreate() {
    if (!activeProjectId || !createTitle.trim() || !createDefinition.trim()) return;
    setCreating(true);
    setCreateError(null);
    try {
      const created = await ipc.canvasCreate({
        projectId: activeProjectId,
        definition: createDefinition.trim(),
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

  const status = selectedCanvasId ? statusByCanvas[selectedCanvasId] : undefined;
  const canRestart = status === "crashed" || status === "errored" || status === "stopped";
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
            onClick={() => setShowCreate((v) => !v)}
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
            <Input
              value={createDefinition}
              onChange={(e) => setCreateDefinition(e.target.value)}
              placeholder="Definition name (e.g. kanban)"
              className="h-7 text-xs font-mono"
            />
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
      <div className="flex-1 overflow-hidden">
        {!selected ? (
          <div className="h-full flex items-center justify-center text-muted-foreground text-sm p-4 text-center">
            No canvases yet. Use <Plus className="inline h-3 w-3" /> to create one.
          </div>
        ) : (
          <CanvasFrame
            canvasId={selected.id}
            definition={selected.definition}
            state={stateByCanvas[selected.id] ?? selected.state}
            revision={revisionByCanvas[selected.id] ?? selected.revision}
            message={lastMessageByCanvas[selected.id]}
          />
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
