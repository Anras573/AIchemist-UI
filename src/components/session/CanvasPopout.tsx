import { useEffect } from "react";
import { useIpc, onSessionEvent, IPC_CHANNELS } from "@/lib/ipc";
import { useCanvasStore } from "@/lib/store/useCanvasStore";
import { CanvasFrame } from "./CanvasFrame";
import type { CanvasEvent } from "@/types";

/**
 * Root of a pop-out canvas window (#248): just a `CanvasFrame` — same
 * sandboxed `aichemist-canvas://` iframe as the panel — fed by its own
 * `useCanvasStore` instance (each window has its own renderer process state).
 * Subscribes to the `CANVAS_EVENT` pushes main broadcasts to every window and
 * counts as an open view of the instance (`CANVAS_OPEN`/`CANVAS_CLOSE`) so the
 * host isn't idle-stopped while only the pop-out is open.
 */
export function CanvasPopout({ canvasId, definition }: { canvasId: string; definition: string }) {
  const ipc = useIpc();
  const state = useCanvasStore((s) => s.stateByCanvas[canvasId]);
  const revision = useCanvasStore((s) => s.revisionByCanvas[canvasId]);
  const message = useCanvasStore((s) => s.lastMessageByCanvas[canvasId]);
  const reloadNonce = useCanvasStore((s) => s.reloadNonceByCanvas[canvasId]);

  useEffect(() => {
    const store = useCanvasStore.getState();
    const unsub = onSessionEvent<CanvasEvent>(IPC_CHANNELS.CANVAS_EVENT, (e) => {
      if (e.canvasId !== canvasId) return;
      switch (e.kind) {
        case "state":
          store.setCanvasState(canvasId, e.state, e.revision ?? 0);
          break;
        case "message":
          store.pushCanvasMessage(canvasId, e.message);
          break;
        case "reload":
          store.bumpCanvasReload(canvasId);
          break;
        case "status":
          if (e.status) store.setCanvasStatus(canvasId, e.status);
          break;
      }
    });

    let cancelled = false;
    ipc
      .canvasOpen(canvasId)
      .then((res) => {
        if (cancelled) return;
        store.setCanvasState(canvasId, res.state, res.revision);
        if (res.status !== "unknown") store.setCanvasStatus(canvasId, res.status);
      })
      .catch((err) => console.error(`[canvas] CANVAS_OPEN failed for pop-out ${canvasId}:`, err));

    return () => {
      cancelled = true;
      unsub();
      void ipc.canvasClose(canvasId).catch(() => {});
    };
  }, [canvasId, ipc]);

  // Nothing to render until CANVAS_OPEN hydrates state (a null state is valid, so key off revision).
  if (revision === undefined) return <div className="h-screen bg-background" />;

  return (
    <div className="h-screen w-screen">
      <CanvasFrame
        canvasId={canvasId}
        definition={definition}
        state={state}
        revision={revision}
        message={message}
        reloadNonce={reloadNonce}
      />
    </div>
  );
}
