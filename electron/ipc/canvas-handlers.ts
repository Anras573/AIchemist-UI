import type { Database } from "better-sqlite3";
import * as CH from "../ipc-channels";
import type { Canvas, CanvasListItem } from "../../src/types/index";
import {
  createCanvas,
  deleteCanvas,
  getCanvas,
  listCanvases,
  renameCanvas,
  setCanvasAttached,
} from "../canvas/store";
import { handle } from "./handle";
import { IpcError } from "./errors";

/**
 * Canvas instance-management IPC: list a project's canvases (with attachment
 * for a given session), create/delete/rename, and toggle per-session
 * attachment. `getState`/`setState` are store-level only for now (no IPC
 * surface yet) — the host runtime that will call them lands in #222.
 */
export function registerCanvasHandlers(db: Database): void {
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
}
