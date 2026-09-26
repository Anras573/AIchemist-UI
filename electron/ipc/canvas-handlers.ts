import type { Database } from "better-sqlite3";
import * as CH from "../ipc-channels";
import type { Canvas, CanvasHostStatus, CanvasListItem } from "../../src/types/index";
import {
  createCanvas,
  deleteCanvas,
  getCanvas,
  listCanvases,
  renameCanvas,
  setCanvasAttached,
} from "../canvas/store";
import { resolveCanvasServerPath } from "../canvas/definitions";
import type { CanvasHostStatus as HostManagerStatus, StartCanvasHostOptions } from "../canvas/host-manager";
import { listProjects } from "../projects";
import { handle } from "./handle";
import { IpcError } from "./errors";

/** The subset of `CanvasHostManager` these handlers depend on (test seam, mirrors `CanvasMcpEndpoint`'s). */
export interface CanvasHostManagerLike {
  start(canvasId: string, opts: StartCanvasHostOptions): Promise<void>;
  restart(canvasId: string, opts: StartCanvasHostOptions): Promise<void>;
  setPanelOpen(canvasId: string, open: boolean): void;
  sendUiMessage(canvasId: string, message: unknown): void;
  getStatus(canvasId: string): HostManagerStatus | undefined;
}

/**
 * Resolves what a host needs to start for a canvas instance: its owning
 * project (canvases are project-scoped, so `canvas.project_id` always
 * resolves one directly — no session lookup needed, unlike the MCP
 * endpoint's `ensureHostRunning`, which starts a host mid-turn and so must
 * resolve a specific session's workspace) and its `server.mjs` path. Null
 * when either is unavailable — the caller treats that as "canvas
 * unavailable" rather than throwing, matching `resolveCanvasServerPath`'s own
 * contract.
 */
function resolveStartOptions(db: Database, canvas: Canvas): StartCanvasHostOptions | null {
  const project = listProjects(db).find((p) => p.id === canvas.project_id);
  if (!project) return null;
  const serverPath = resolveCanvasServerPath(canvas.definition);
  if (!serverPath) return null;
  return { serverPath, projectId: project.id, projectPath: project.path };
}

/**
 * Canvas instance-management IPC: list a project's canvases (with attachment
 * for a given session), create/delete/rename, per-session attachment
 * toggle, and the panel lifecycle (#224) — open/close (start the host /
 * allow it to idle-stop), relay a UI message to `onUiMessage`, and manual
 * restart.
 */
export function registerCanvasHandlers(db: Database, hostManager: CanvasHostManagerLike): void {
  handle(
    CH.CANVAS_LIST,
    (_event, args: { projectId: string; sessionId?: string }): CanvasListItem[] =>
      listCanvases(db, args.projectId, args.sessionId)
  );

  handle(
    CH.CANVAS_CREATE,
    (
      _event,
      args: { projectId: string; definition: string; title: string; initialState?: unknown }
    ): Canvas =>
      createCanvas(db, {
        projectId: args.projectId,
        definition: args.definition,
        title: args.title,
        initialState: args.initialState,
      })
  );

  handle(CH.CANVAS_DELETE, (_event, args: { canvasId: string }): { ok: boolean } => {
    deleteCanvas(db, args.canvasId);
    return { ok: true };
  });

  handle(CH.CANVAS_RENAME, (_event, args: { canvasId: string; title: string }): Canvas => {
    const updated = renameCanvas(db, args.canvasId, args.title);
    if (!updated) throw new IpcError("not_found", `Canvas not found: ${args.canvasId}`);
    return updated;
  });

  handle(
    CH.CANVAS_ATTACH,
    (_event, args: { sessionId: string; canvasId: string; attached: boolean }): { attached: boolean } => {
      if (!getCanvas(db, args.canvasId)) {
        throw new IpcError("not_found", `Canvas not found: ${args.canvasId}`);
      }
      setCanvasAttached(db, args.sessionId, args.canvasId, args.attached);
      return { attached: args.attached };
    }
  );

  handle(
    CH.CANVAS_OPEN,
    async (
      _event,
      args: { canvasId: string }
    ): Promise<{ state: unknown; revision: number; status: CanvasHostStatus | "unknown" }> => {
      const canvas = getCanvas(db, args.canvasId);
      if (!canvas) throw new IpcError("not_found", `Canvas not found: ${args.canvasId}`);

      const startOpts = resolveStartOptions(db, canvas);
      if (startOpts) {
        try {
          await hostManager.start(args.canvasId, startOpts);
        } catch (err) {
          // A start failure already drove the host to "crashed"/"errored" and
          // pushed that via the manager's onStatusChanged hook (-> CANVAS_EVENT).
          // Per the design doc's error handling ("host fails to start / crashes
          // -> backoff restart, then error state with logs and Restart"), that
          // is surfaced through the panel's status, not by failing this call —
          // the panel should still open and show the last persisted state.
          console.error(`[canvas-handlers] failed to start host for ${args.canvasId}:`, err);
        }
      }
      hostManager.setPanelOpen(args.canvasId, true);

      const latest = getCanvas(db, args.canvasId) ?? canvas;
      return {
        state: latest.state,
        revision: latest.revision,
        status: hostManager.getStatus(args.canvasId) ?? "unknown",
      };
    }
  );

  handle(
    CH.CANVAS_CLOSE,
    (_event, args: { canvasId: string }): { state: unknown; revision: number } => {
      // Marks the panel closed so the host's idle-stop timer can eventually
      // stop it — never stops it directly, so a turn still running against
      // this canvas (setTurnActive) keeps it alive regardless of the panel.
      hostManager.setPanelOpen(args.canvasId, false);
      const canvas = getCanvas(db, args.canvasId);
      return { state: canvas?.state ?? null, revision: canvas?.revision ?? 0 };
    }
  );

  handle(
    CH.CANVAS_UI_MESSAGE,
    (_event, args: { canvasId: string; message: unknown }): { ok: boolean } => {
      // No-ops (via the manager) if the host isn't running — the UI is
      // expected to only be visible/interactive once CANVAS_OPEN resolved.
      hostManager.sendUiMessage(args.canvasId, args.message);
      return { ok: true };
    }
  );

  handle(
    CH.CANVAS_RESTART,
    async (
      _event,
      args: { canvasId: string }
    ): Promise<{ state: unknown; revision: number; status: CanvasHostStatus | "unknown" }> => {
      const canvas = getCanvas(db, args.canvasId);
      if (!canvas) throw new IpcError("not_found", `Canvas not found: ${args.canvasId}`);

      const startOpts = resolveStartOptions(db, canvas);
      if (!startOpts) {
        throw new IpcError("unavailable", `Canvas definition unavailable: ${canvas.definition}`);
      }
      await hostManager.restart(args.canvasId, startOpts);

      const latest = getCanvas(db, args.canvasId) ?? canvas;
      return {
        state: latest.state,
        revision: latest.revision,
        status: hostManager.getStatus(args.canvasId) ?? "unknown",
      };
    }
  );
}
