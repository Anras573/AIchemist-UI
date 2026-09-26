import { create } from "zustand";
import type { CanvasHostStatus } from "@/types";

export interface CanvasLogEntry {
  level: "log" | "warn" | "error";
  args: unknown[];
  at: number;
}

/** A single relayed `ui.message` from a host, tagged with a monotonic `seq` so
 *  `CanvasFrame` can tell two back-to-back messages with identical content
 *  apart (a plain reference/content diff wouldn't). */
export interface CanvasRelayedMessage {
  message: unknown;
  seq: number;
}

/** Debug-drawer log cap per canvas — oldest entries drop once exceeded. */
const MAX_LOG_ENTRIES = 200;

/**
 * Renderer state for the Canvas panel (#224). Populated entirely from
 * `CANVAS_EVENT` pushes (routed in `useSessionEvents`) and the `CANVAS_OPEN` /
 * `CANVAS_CLOSE` / `CANVAS_RESTART` IPC calls `CanvasPanel` makes directly —
 * nothing here is persisted; the canvas instance and its state live in
 * SQLite (the source of truth), this is just a live cache/mirror for the
 * open panel.
 */
interface CanvasStore {
  /** Last known `ctx.state` per canvas id. */
  stateByCanvas: Record<string, unknown>;
  /** Last known state revision per canvas id. */
  revisionByCanvas: Record<string, number>;
  /** Last known host status per canvas id. Absent until the first CANVAS_OPEN/CANVAS_EVENT. */
  statusByCanvas: Record<string, CanvasHostStatus>;
  /** Most recent `ui.message` relayed from each canvas's host, if any. */
  lastMessageByCanvas: Record<string, CanvasRelayedMessage | undefined>;
  /** Debug-drawer log lines per canvas, oldest first, capped at MAX_LOG_ENTRIES. */
  logsByCanvas: Record<string, CanvasLogEntry[]>;

  setCanvasState: (canvasId: string, state: unknown, revision: number) => void;
  setCanvasStatus: (canvasId: string, status: CanvasHostStatus) => void;
  pushCanvasMessage: (canvasId: string, message: unknown) => void;
  pushCanvasLog: (canvasId: string, level: CanvasLogEntry["level"], args: unknown[]) => void;
  clearCanvasLogs: (canvasId: string) => void;
}

export const useCanvasStore = create<CanvasStore>((set) => ({
  stateByCanvas: {},
  revisionByCanvas: {},
  statusByCanvas: {},
  lastMessageByCanvas: {},
  logsByCanvas: {},

  setCanvasState: (canvasId, state, revision) =>
    set((s) => {
      // Ignore a stale write — e.g. CANVAS_OPEN's slow `await
      // hostManager.start()` letting a CANVAS_EVENT push for a newer
      // revision land first, then its own (older) response arriving after
      // and clobbering it. Never observed in practice (both currently
      // arrive in order), but the guard is nearly free (found in review on
      // PR #235).
      const prevRevision = s.revisionByCanvas[canvasId];
      if (prevRevision !== undefined && revision < prevRevision) return s;
      return {
        stateByCanvas: { ...s.stateByCanvas, [canvasId]: state },
        revisionByCanvas: { ...s.revisionByCanvas, [canvasId]: revision },
      };
    }),

  setCanvasStatus: (canvasId, status) =>
    set((s) => ({ statusByCanvas: { ...s.statusByCanvas, [canvasId]: status } })),

  pushCanvasMessage: (canvasId, message) =>
    set((s) => {
      const prevSeq = s.lastMessageByCanvas[canvasId]?.seq ?? 0;
      return {
        lastMessageByCanvas: { ...s.lastMessageByCanvas, [canvasId]: { message, seq: prevSeq + 1 } },
      };
    }),

  pushCanvasLog: (canvasId, level, args) =>
    set((s) => {
      const existing = s.logsByCanvas[canvasId] ?? [];
      const next = [...existing, { level, args, at: Date.now() }].slice(-MAX_LOG_ENTRIES);
      return { logsByCanvas: { ...s.logsByCanvas, [canvasId]: next } };
    }),

  clearCanvasLogs: (canvasId) =>
    set((s) => {
      const logsByCanvas = { ...s.logsByCanvas };
      delete logsByCanvas[canvasId];
      return { logsByCanvas };
    }),
}));
