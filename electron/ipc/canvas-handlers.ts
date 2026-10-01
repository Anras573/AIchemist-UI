import * as fs from "node:fs";
import * as nodePath from "node:path";
import type { Database } from "better-sqlite3";
import * as CH from "../ipc-channels";
import type {
  Canvas,
  CanvasDiscoveryResult,
  CanvasHostStatus,
  CanvasListItem,
  CanvasSecretStatus,
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
  computeCanvasContentHash,
  getProjectCanvasTrustStatus,
  hasSymlinksInDefinition,
  installCanvasDependencies,
  resolveTrustedCanvasServerPath,
  revokeProjectCanvasTrust,
  trustProjectCanvas,
} from "../canvas/trust";
import {
  clearCanvasSecret,
  getCanvasSecretStatus,
  resolveCanvasSecretEnv,
  resolveCanvasSecretScope,
  setCanvasSecret,
} from "../canvas/secrets";
import { resolveProjectDefinitionDir } from "../canvas/definitions";
import { listProjects } from "../projects";
import { CanvasViewerTracker } from "../canvas/viewers";
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

/** The subset of `CanvasPopoutManager` these handlers depend on (#248). */
export interface CanvasPopoutLike {
  open(canvasId: string, meta: { title: string; definition: string }): void;
  close(canvasId: string): void;
}

/** Stable id for the calling window; tests invoke handlers with a bare `{}` event. */
function senderId(event: unknown): number {
  return (event as { sender?: { id?: number } } | undefined)?.sender?.id ?? 0;
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
 *
 * Also attaches `resolveServerPath` — a closure `CanvasHostManager` calls
 * again before every respawn it triggers on its own (a dev-reload restart, a
 * crash auto-restart), not just this initial one. Without it, the manager
 * would keep reusing today's already-resolved `serverPath` forever, so a
 * project-tier canvas whose trust was revoked (or whose content changed)
 * after this call would still get respawned with code nobody re-approved
 * (#227 review on PR #238) — the one-time check here only ever covers the
 * moment `CANVAS_OPEN`/`CANVAS_RESTART` happened to run.
 */
function resolveStartOptions(db: Database, canvas: Canvas): StartCanvasHostOptions | null {
  const project = findProject(db, canvas.project_id);
  if (!project) return null;
  const serverPath = resolveTrustedCanvasServerPath(db, canvas, project.path);
  if (!serverPath) return null;
  return {
    serverPath,
    projectId: project.id,
    projectPath: project.path,
    resolveServerPath: () => resolveTrustedCanvasServerPath(db, canvas, project.path),
    resolveEnv: () => resolveCanvasSecretEnv(project.id, project.path, canvas.definition),
  };
}

/**
 * Canvas instance-management IPC: list a project's canvases (with attachment
 * for a given session), create/delete/rename, per-session attachment
 * toggle, and the panel lifecycle (#224) — open/close (start the host /
 * allow it to idle-stop), relay a UI message to `onUiMessage`, and manual
 * restart.
 */
export function registerCanvasHandlers(
  db: Database,
  hostManager: CanvasHostManagerLike,
  deps: { popouts?: CanvasPopoutLike; viewers?: CanvasViewerTracker } = {}
): void {
  // An instance counts as "panel open" while ANY window shows it (#248), so the
  // right-panel tab closing doesn't release a host a pop-out is still using.
  const viewers = deps.viewers ?? new CanvasViewerTracker();

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
    // An open pop-out would otherwise keep showing a canvas whose row is gone.
    deps.popouts?.close(args.canvasId);
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
      event,
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
      viewers.add(args.canvasId, senderId(event));
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
    (event, args: { canvasId: string }): { state: unknown; revision: number } => {
      // Marks the panel closed so the host's idle-stop timer can eventually
      // stop it — never stops it directly, so a turn still running against
      // this canvas (setTurnActive) keeps it alive regardless of the panel.
      // Only when this was the LAST view (panel or pop-out, #248).
      if (viewers.remove(args.canvasId, senderId(event)) === 0) {
        hostManager.setPanelOpen(args.canvasId, false);
      }
      const canvas = getCanvas(db, args.canvasId);
      return { state: canvas?.state ?? null, revision: canvas?.revision ?? 0 };
    }
  );

  handle(CH.CANVAS_POP_OUT, (_event, args: { canvasId: string }): { ok: boolean } => {
    const canvas = getCanvas(db, args.canvasId);
    if (!canvas) throw new IpcError("not_found", `Canvas not found: ${args.canvasId}`);
    if (!deps.popouts) throw new IpcError("unavailable", "Pop-out windows are unavailable");
    deps.popouts.open(args.canvasId, { title: canvas.title, definition: canvas.definition });
    return { ok: true };
  });

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
    async (
      _event,
      args: { projectId: string; definition: string; expectedContentHash: string }
    ): Promise<CanvasTrustGrantResult> => {
      const project = findProject(db, args.projectId);
      if (!project) throw new IpcError("not_found", `Project not found: ${args.projectId}`);

      const dir = resolveProjectDefinitionDir(project.path, args.definition);
      if (!dir) throw new IpcError("not_found", `Project canvas definition not found: ${args.definition}`);

      // TOCTOU guard (#227 review on PR #238): the renderer sends back the
      // hash it displayed in the prompt (from an earlier CANVAS_TRUST_STATUS
      // call). If the definition changed since then — someone edited it, or
      // a `git pull` landed, between the prompt rendering and the click —
      // this must refuse rather than trust whatever happens to be on disk
      // *now*, which the user never actually saw.
      if (computeCanvasContentHash(dir) !== args.expectedContentHash) {
        throw new IpcError(
          "conflict",
          "This canvas definition changed since it was reviewed. Re-open the trust prompt to review the current content before trusting it."
        );
      }

      // A symlink anywhere in the hashed scope means the hash the check above
      // just confirmed can't actually stand for "what code would run" (#227
      // review) — `computeCanvasContentHash` never follows or hashes a
      // symlink at all, so one appearing/pointing somewhere new wouldn't even
      // change the hash the TOCTOU check just compared. Refuse independently
      // of that check, same as the node_modules refusal below.
      if (hasSymlinksInDefinition(dir)) {
        throw new IpcError(
          "invalid_input",
          "This canvas contains a symlink, which isn't supported — AIchemist can't verify what code a symlink actually points to. Remove it (or replace it with a real file/folder) to trust this canvas."
        );
      }

      // A `node_modules` already sitting in the definition folder — e.g.
      // committed to the repo — resolves bare imports (`import "some-pkg"`)
      // before AIchemist's own `bun install` ever runs, and its contents
      // aren't part of the content hash at all (see computeCanvasContentHash's
      // docstring for why `node_modules` is excluded from hashing). Refuse
      // outright rather than silently trusting whatever's already there;
      // AIchemist's own install (below) is always free to populate a fresh
      // one from the hashed `package.json`/lockfile.
      if (fs.existsSync(nodePath.join(dir, "node_modules"))) {
        throw new IpcError(
          "invalid_input",
          "This canvas ships its own node_modules folder, which AIchemist won't run automatically. Remove it from the definition and let AIchemist install dependencies via bun install."
        );
      }

      // Dependencies (if any) install BEFORE trust is recorded, and the trust
      // hash is computed AFTER — the reverse of the original order. Hashing
      // first meant a repo with no lockfile got a hash the `bun install`
      // below immediately invalidated (it creates one), so the user's fresh
      // "Trust and run" click would refuse to start and force approving the
      // same content twice (#227 review). Installing is itself the action
      // the user just consented to, so running it in the still-untrusted
      // state (no host can start regardless) is safe, and hashing what's on
      // disk afterward makes the recorded trust match what will actually run.
      const install = await installCanvasDependencies(dir);

      let trust;
      try {
        trust = trustProjectCanvas(db, args.projectId, project.path, args.definition);
      } catch (err) {
        if (err instanceof CanvasTrustError) throw new IpcError("not_found", err.message);
        throw err;
      }

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

  // ── Declared secrets (#249) — values are write-only from the renderer. ──────
  function secretScopeFor(projectId: string, definition: string) {
    const project = findProject(db, projectId);
    if (!project) throw new IpcError("not_found", `Project not found: ${projectId}`);
    const resolved = resolveCanvasSecretScope(project.id, project.path, definition);
    if (!resolved) throw new IpcError("not_found", `Canvas definition not found: ${definition}`);
    return resolved;
  }

  handle(CH.CANVAS_SECRETS_STATUS, (_event, args: { projectId: string; definition: string }): CanvasSecretStatus[] => {
    const { scope, declared } = secretScopeFor(args.projectId, args.definition);
    return getCanvasSecretStatus(scope, declared);
  });

  handle(
    CH.CANVAS_SECRET_SET,
    async (_event, args: { projectId: string; definition: string; name: string; value: string }): Promise<{ ok: boolean }> => {
      const { scope, declared } = secretScopeFor(args.projectId, args.definition);
      try {
        setCanvasSecret(scope, declared, args.name, args.value);
      } catch (err) {
        throw new IpcError("invalid_input", err instanceof Error ? err.message : String(err));
      }
      return { ok: true };
    }
  );

  handle(
    CH.CANVAS_SECRET_CLEAR,
    async (_event, args: { projectId: string; definition: string; name: string }): Promise<{ ok: boolean }> => {
      const { scope } = secretScopeFor(args.projectId, args.definition);
      clearCanvasSecret(scope, args.name);
      return { ok: true };
    }
  );
}
