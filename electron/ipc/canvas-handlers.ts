import type { Database } from "better-sqlite3";
import * as CH from "../ipc-channels";
import type {
  Canvas,
  CanvasDiscoveryResult,
  CanvasHostStatus,
  CanvasListItem,
  CanvasTrustGrantResult,
  CanvasTrustStatus,
} from "../../src/types/index";
import {
  createCanvas,
  deleteCanvas,
  getCanvas,
  listCanvases,
  renameCanvas,
  setCanvasAttached,
} from "../canvas/store";
import { discoverCanvasDefinitions } from "../canvas/discovery";
import type { CanvasHostStatus as HostManagerStatus, StartCanvasHostOptions } from "../canvas/host-manager";
import {
  CanvasTrustError,
  getProjectCanvasTrustStatus,
  installCanvasDependencies,
  resolveTrustedCanvasServerPath,
  revokeProjectCanvasTrust,
  trustProjectCanvas,
} from "../canvas/trust";
import { resolveProjectDefinitionDir } from "../canvas/definitions";
import { listProjects } from "../projects";
import { handle } from "./handle";
import { IpcError } from "./errors";

/** The subset of `CanvasHostManager` these handlers depend on (test seam, mirrors `CanvasMcpEndpoint`'s). */
export interface CanvasHostManagerLike {
  start(canvasId: string, opts: StartCanvasHostOptions): Promise<void>;
  restart(canvasId: string, opts: StartCanvasHostOptions): Promise<void>;
  stop(canvasId: string): Promise<void>;
  setPanelOpen(canvasId: string, open: boolean): void;
  sendUiMessage(canvasId: string, message: unknown): void;
  getStatus(canvasId: string): HostManagerStatus | undefined;
}

function findProject(db: Database, projectId: string) {
  return listProjects(db).find((p) => p.id === projectId);
}

/**
 * Resolves what a host needs to start for a canvas instance: its owning
 * project (canvases are project-scoped, so `canvas.project_id` always
 * resolves one directly — no session lookup needed, unlike the MCP
 * endpoint's `ensureHostRunning`, which starts a host mid-turn and so must
 * resolve a specific session's workspace) and its `server.mjs` path,
 * trust-gated (#227) via `resolveTrustedCanvasServerPath`. Null when either
 * is unavailable — the caller treats that as "canvas unavailable" rather than
 * throwing, matching that resolver's own contract (which itself matches
 * `resolveCanvasServerPath`'s for global/built-in).
 */
function resolveStartOptions(db: Database, canvas: Canvas): StartCanvasHostOptions | null {
  const project = findProject(db, canvas.project_id);
  if (!project) return null;
  const serverPath = resolveTrustedCanvasServerPath(db, canvas, project.path);
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
    CH.CANVAS_LIST_DEFINITIONS,
    (_event, args: { projectId?: string }): CanvasDiscoveryResult => {
      const projectPath = args.projectId
        ? listProjects(db).find((p) => p.id === args.projectId)?.path
        : undefined;
      return discoverCanvasDefinitions(projectPath);
    }
  );

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

  // ── Trust (#227) ────────────────────────────────────────────────────────────

  handle(
    CH.CANVAS_TRUST_STATUS,
    (_event, args: { projectId: string; definition: string }): CanvasTrustStatus | null => {
      const project = findProject(db, args.projectId);
      if (!project) throw new IpcError("not_found", `Project not found: ${args.projectId}`);
      return getProjectCanvasTrustStatus(db, args.projectId, project.path, args.definition);
    }
  );

  handle(
    CH.CANVAS_TRUST_GRANT,
    async (_event, args: { projectId: string; definition: string }): Promise<CanvasTrustGrantResult> => {
      const project = findProject(db, args.projectId);
      if (!project) throw new IpcError("not_found", `Project not found: ${args.projectId}`);

      let trust;
      try {
        trust = trustProjectCanvas(db, args.projectId, project.path, args.definition);
      } catch (err) {
        if (err instanceof CanvasTrustError) throw new IpcError("not_found", err.message);
        throw err;
      }

      // Dependencies (if any) install only now, after consent is recorded —
      // never before, and never for a definition that turns out not to
      // resolve (trustProjectCanvas would have thrown above).
      const dir = resolveProjectDefinitionDir(project.path, args.definition);
      const install = dir ? await installCanvasDependencies(dir) : { ok: true, output: "" };
      return { trust, install };
    }
  );

  handle(
    CH.CANVAS_TRUST_REVOKE,
    async (_event, args: { projectId: string; definition: string }): Promise<{ ok: boolean }> => {
      revokeProjectCanvasTrust(db, args.projectId, args.definition);
      // Revoking trust must stop any host already running against the
      // now-untrusted content — a running host isn't retroactively killed by
      // anything else (the next CANVAS_OPEN/tool call would simply refuse to
      // *start* a new one, but wouldn't touch one already up).
      const instances = listCanvases(db, args.projectId).filter((c) => c.definition === args.definition);
      await Promise.all(instances.map((c) => hostManager.stop(c.id)));
      return { ok: true };
    }
  );
}
